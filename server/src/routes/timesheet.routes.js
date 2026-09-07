import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';
import { notifyEmployee } from '../utils/notify.js';
import { sendEmail } from '../utils/channels.js';
import { weekStartOf } from './ideas.routes.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '21' (Timesheet), now scoped to task tracking only
// (hour-logging + approval moved to Project & Resource Management, module '20' — see
// projects.routes.js). A Senior Team Lead/Team Lead/Assistant Manager also passes: the read
// routes below fetch-then-filter via scope, so admitting them here only ever narrows to their
// assigned departments/teams.
const isHR = (role) => canModuleAdmin(role, '21') || isScopedRole(role);
// Unrestricted (company-wide) task-assignment stays reserved for real HR-tier roles.
const canAssignOthersTasks = (role) => canModuleAdmin(role, '21') && !isScopedRole(role);
// STL/TL specifically (not Assistant Manager) may also assign — and view — tasks for employees
// within their own assigned department(s)/team(s): a Senior Team Lead's department-level scope
// naturally covers every TL and employee in it, while a Team Lead's team-level scope covers only
// their own team's members — exactly what isEmployeeInScope already enforces everywhere else.
const STL_TL_ROLES = ['stl', 'tl'];
const canAssignWithinScope = (role) => STL_TL_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const employeeById = (id) => db.prepare('SELECT department, team_id FROM employees WHERE id = ?').get(id);

// ---------- My Tasks (project task management) ----------
const TASK_STATUSES = ['Not Started', 'In Progress', 'Completed', 'On Hold'];

const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);

function withTaskDetails(rows) {
  return rows.map((t) => {
    const assignee = t.assigned_to_employee_id ? db.prepare('SELECT name, user_id, team_id FROM employees WHERE id = ?').get(t.assigned_to_employee_id) : null;
    const assignedByOther = t.created_by && (!assignee || assignee.user_id !== t.created_by);
    return {
      ...t,
      assigned_to_name: assignee?.name || null,
      assigned_to_team_name: teamNameOf(assignee?.team_id),
      created_by_name: assignedByOther ? db.prepare('SELECT name FROM users WHERE id = ?').get(t.created_by)?.name : null,
      depends_on_name: t.depends_on_task_id ? db.prepare('SELECT task_name FROM project_tasks WHERE id = ?').get(t.depends_on_task_id)?.task_name : null
    };
  });
}

// Daily/Weekly/Monthly view filter for My Tasks and Task Reports — bounds are inclusive
// YYYY-MM-DD strings, compared directly against a task's start_date. 'weekly' reuses the exact
// same Monday-of-week boundary Knowledge Transfer uses, so "this week" means the same thing in
// both modules. Returns null for an unrecognized/absent range (no filtering — the "All" view).
function rangeBounds(range) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (range === 'daily') return { start: today, end: today };
  if (range === 'weekly') {
    const start = weekStartOf();
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start, end: end.toISOString().slice(0, 10) };
  }
  if (range === 'monthly') {
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
      end: new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)
    };
  }
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// An explicit calendar date (or date range) from a date-picker, alongside the Daily/Weekly/
// Monthly presets above — a specific "show me the 14th" or "show me the 10th to the 20th" that
// the presets can't express. Takes priority over `range` whenever either bound is given; a single
// date with no matching other bound is treated as a one-day range. Same inclusive-YYYY-MM-DD
// comparison against start_date as rangeBounds, so the two filters can never disagree on what
// "in range" means.
function resolveTaskDateBounds(query) {
  const from = DATE_RE.test(query.from || '') ? query.from : null;
  const to = DATE_RE.test(query.to || '') ? query.to : null;
  if (from || to) return { start: from || to, end: to || from };
  return rangeBounds(query.range);
}

// Overdue-task reminder sweep — lazy, no-background-scheduler idiom (same as Performance's
// sendPendingAssessmentReminders): runs at the top of every My Tasks / Task Reports read, and
// only actually notifies once per cooldown window per task (via last_reminded_at) so loading the
// page repeatedly doesn't spam the same reminder. Notifies both the assignee (in-app + email) and
// their manager (in-app + email, best-effort name match on reporting_manager — same pattern used
// for the "timesheet entry submitted" manager notice in projects.routes.js).
const OVERDUE_REMINDER_COOLDOWN_HOURS = 24;
function sendOverdueTaskReminders() {
  const overdue = db.prepare(`
    SELECT * FROM project_tasks
    WHERE end_date IS NOT NULL AND end_date < date('now') AND status != 'Completed'
      AND (last_reminded_at IS NULL OR last_reminded_at <= datetime('now', ?))
  `).all(`-${OVERDUE_REMINDER_COOLDOWN_HOURS} hours`);

  overdue.forEach((t) => {
    const assignee = t.assigned_to_employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(t.assigned_to_employee_id) : null;
    if (assignee) {
      notifyEmployee(assignee.id, 'Task overdue', `"${t.task_name}" was due ${t.end_date} and is still ${t.status} — please update its status.`);
      if (assignee.email) {
        sendEmail(
          assignee.email,
          `Overdue task: ${t.task_name}`,
          `Hi ${assignee.name},\n\nYour task "${t.task_name}" was due on ${t.end_date} and is still marked "${t.status}".\n\nPlease update its status in the Timesheet module as soon as possible.`
        ).catch(() => {});
      }
      if (assignee.reporting_manager?.trim()) {
        const manager = db.prepare('SELECT * FROM employees WHERE name = ?').get(assignee.reporting_manager.trim());
        if (manager) {
          notifyEmployee(manager.id, 'Team task overdue', `${assignee.name}'s task "${t.task_name}" was due ${t.end_date} and is still ${t.status}.`);
          if (manager.email) {
            sendEmail(
              manager.email,
              `Overdue task for ${assignee.name}: ${t.task_name}`,
              `Hi ${manager.name},\n\n${assignee.name}'s task "${t.task_name}" was due on ${t.end_date} and is still marked "${t.status}".\n\nYou may want to follow up.`
            ).catch(() => {});
          }
        }
      }
    }
    db.prepare("UPDATE project_tasks SET last_reminded_at = datetime('now') WHERE id = ?").run(t.id);
  });
}

// Shared access check for a single task: full managers reach everything; anyone reaches a task
// assigned to them or one they personally created; a Senior Team Lead/Team Lead additionally
// reaches any task assigned to someone within their own assigned department(s)/team(s) — the
// same reach GET /tasks already grants them, so "view" and "edit/comment" stay consistent.
function canAccessTask(req, task) {
  const role = req.user.role;
  if (canAssignOthersTasks(role)) return true;
  const me = myEmployee(req.user.sub);
  if (task.assigned_to_employee_id === me?.id) return true;
  if (task.created_by === req.user.sub) return true;
  if (canAssignWithinScope(role)) {
    const scope = getSupervisorScope(me?.id);
    return isEmployeeInScope(scope, employeeById(task.assigned_to_employee_id));
  }
  return false;
}

// Data the "+ New Task" form needs: the real Organization Structure department list (not just
// whichever departments happen to have an active employee today), and (HR only) an employee
// picker. Also doubles as the source for the Department/Team filter dropdowns on My Tasks and
// Task Reports — `teams` (id + name + department) is only needed there, not by the New Task form.
router.get('/tasks/options', (req, res) => {
  const departments = db.prepare("SELECT name FROM departments ORDER BY name").all().map((d) => d.name);
  const teams = db.prepare(`
    SELECT t.id, t.name, d.name AS department FROM teams t JOIN departments d ON d.id = t.department_id
    WHERE t.status = 'Active' ORDER BY d.name, t.name
  `).all();
  const canAssign = canAssignOthersTasks(req.user.role);
  const canAssignScoped = canAssignWithinScope(req.user.role);
  let employees = [];
  if (canAssign) {
    employees = db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active' ORDER BY name").all();
  } else if (canAssignScoped) {
    const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
    employees = db.prepare("SELECT id, name, employee_code, department, team_id FROM employees WHERE status = 'Active' ORDER BY name")
      .all().filter((e) => isEmployeeInScope(scope, e));
  }
  res.json({ departments, teams, statuses: TASK_STATUSES, employees, isHR: canAssign || canAssignScoped });
});

// My Tasks: everything assigned to me, whoever created it (a self-made task or one a
// manager/HR assigned straight to me). A Senior Team Lead/Team Lead also sees tasks assigned to
// anyone within their own assigned department(s)/team(s), so they can track their team's work
// alongside their own — not company-wide, and not extended to Assistant Manager. Full managers/
// HR/Super Admin get every task company-wide, same as everywhere else in this app — and that
// reach must NOT depend on having an own employee record, since Super Admin is a pure
// system-administrator account with none (myEmployee(sub) is null for it); gating on `me` first
// was silently returning an empty list for Super Admin instead of the org-wide view.
router.get('/tasks', (req, res) => {
  sendOverdueTaskReminders();
  const me = myEmployee(req.user.sub);
  let rows;
  if (canAssignOthersTasks(req.user.role)) {
    rows = db.prepare("SELECT * FROM project_tasks ORDER BY (status != 'Completed') DESC, start_date DESC").all();
  } else if (!me) {
    rows = [];
  } else if (canAssignWithinScope(req.user.role)) {
    const scope = getSupervisorScope(me.id);
    rows = db.prepare("SELECT * FROM project_tasks ORDER BY (status != 'Completed') DESC, start_date DESC").all()
      .filter((t) => t.assigned_to_employee_id === me.id || isEmployeeInScope(scope, employeeById(t.assigned_to_employee_id)));
  } else {
    rows = db.prepare('SELECT * FROM project_tasks WHERE assigned_to_employee_id = ? ORDER BY (status != \'Completed\') DESC, start_date DESC').all(me.id);
  }

  // Department/Team/Range filters — Super Admin and every HR-tier/scoped role can slice My Tasks
  // by department or team, and by Daily/Weekly/Monthly, on top of whatever scope already applies
  // above. A plain employee's own list is small enough that these mostly just narrow it further.
  if (req.query.department) rows = rows.filter((t) => t.department === req.query.department);
  if (req.query.team_id) {
    const teamId = Number(req.query.team_id);
    rows = rows.filter((t) => employeeById(t.assigned_to_employee_id)?.team_id === teamId);
  }
  const range = resolveTaskDateBounds(req.query);
  if (range) rows = rows.filter((t) => t.start_date >= range.start && t.start_date <= range.end);

  res.json({ tasks: withTaskDetails(rows) });
});

router.post('/tasks', (req, res) => {
  const { department, task_name, description, sub_task_name, status, start_date, end_date, is_dependent, depends_on_task_id, assigned_to_employee_id } = req.body || {};
  if (!department?.trim()) return res.status(400).json({ error: 'Department is required' });
  if (!task_name?.trim()) return res.status(400).json({ error: 'Task name is required' });
  if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  if (!start_date) return res.status(400).json({ error: 'Task start date is required' });

  // A manager/HR ("higher authority") can assign this straight to any active employee. A
  // Senior Team Lead/Team Lead can assign it straight to any employee within their own assigned
  // department(s)/team(s) only. Anyone else can only ever create a task for themselves.
  let assigneeId;
  if (canAssignOthersTasks(req.user.role) && assigned_to_employee_id) {
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(assigned_to_employee_id)) return res.status(400).json({ error: 'Invalid assignee' });
    assigneeId = assigned_to_employee_id;
  } else if (canAssignWithinScope(req.user.role) && assigned_to_employee_id) {
    const target = employeeById(assigned_to_employee_id);
    if (!target) return res.status(400).json({ error: 'Invalid assignee' });
    const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
    if (!isEmployeeInScope(scope, target)) return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
    assigneeId = assigned_to_employee_id;
  } else {
    const me = myEmployee(req.user.sub);
    if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
    assigneeId = me.id;
  }

  const info = db.prepare(`
    INSERT INTO project_tasks (department, assigned_to_employee_id, created_by, task_name, description, sub_task_name, status, start_date, end_date, is_dependent, depends_on_task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(department.trim(), assigneeId, req.user.sub, task_name.trim(), description?.trim() || null, sub_task_name?.trim() || null,
    status, start_date, end_date || null, is_dependent ? 1 : 0, is_dependent && depends_on_task_id ? depends_on_task_id : null);

  if (assigneeId !== myEmployee(req.user.sub)?.id) {
    db.prepare('INSERT INTO notifications (title, message, target_role, employee_id) VALUES (?, ?, ?, ?)')
      .run('New task assigned', `${req.user.name || 'Your manager'} assigned you a task: "${task_name.trim()}"`, 'employee', assigneeId);
  }

  res.status(201).json({ task: withTaskDetails([db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

// Full task edit — every field, not just status. Reassigning who the task belongs to is
// deliberately NOT part of this (that's the separate "assign" action above); every other field
// (name, description, sub-task, department, dates, dependency, status) can be changed here.
router.put('/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canAccessTask(req, task)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { department, task_name, description, sub_task_name, status, start_date, end_date, is_dependent, depends_on_task_id } = req.body || {};
  if (status !== undefined && !TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  if (task_name !== undefined && !task_name?.trim()) return res.status(400).json({ error: 'Task name is required' });
  if (department !== undefined && !department?.trim()) return res.status(400).json({ error: 'Department is required' });
  const dependent = is_dependent !== undefined ? (is_dependent ? 1 : 0) : task.is_dependent;
  db.prepare(`
    UPDATE project_tasks SET
      department = COALESCE(?, department),
      task_name = COALESCE(?, task_name),
      description = ?,
      sub_task_name = ?,
      status = COALESCE(?, status),
      start_date = COALESCE(?, start_date),
      end_date = ?,
      is_dependent = ?,
      depends_on_task_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    department?.trim() || null, task_name?.trim() || null,
    description !== undefined ? (description?.trim() || null) : task.description,
    sub_task_name !== undefined ? (sub_task_name?.trim() || null) : task.sub_task_name,
    status || null, start_date || null,
    end_date !== undefined ? (end_date || null) : task.end_date,
    dependent, dependent && (depends_on_task_id ?? task.depends_on_task_id) ? (depends_on_task_id ?? task.depends_on_task_id) : null,
    task.id
  );
  res.json({ task: withTaskDetails([db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(task.id)])[0] });
});

router.get('/tasks/:id/updates', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canAccessTask(req, task)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ updates: db.prepare('SELECT * FROM project_task_updates WHERE task_id = ? ORDER BY created_at').all(task.id) });
});

router.post('/tasks/:id/updates', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canAccessTask(req, task)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { comment } = req.body || {};
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });
  db.prepare('INSERT INTO project_task_updates (task_id, author_name, comment) VALUES (?, ?, ?)').run(task.id, req.user.name || 'User', comment.trim());
  res.status(201).json({ updates: db.prepare('SELECT * FROM project_task_updates WHERE task_id = ? ORDER BY created_at').all(task.id) });
});

// Task Status Report: every employee with at least one allocated task, broken down by how many
// of their tasks are Completed / In Progress / Pending (Not Started) / On Hold — so HR/managers
// can see at a glance who's completed their allocated work vs who's still got it pending or in
// progress. Same audience and scoping as My Tasks itself (HR company-wide, STL/TL scoped).
// Supports the same Department/Team/Range (Daily/Weekly/Monthly) filters as My Tasks, applied as
// SQL WHERE clauses since this is a GROUP BY query rather than a flat row list.
router.get('/reports/task-status', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  sendOverdueTaskReminders();

  const conditions = [];
  const params = [];
  if (req.query.department) { conditions.push('t.department = ?'); params.push(req.query.department); }
  if (req.query.team_id) { conditions.push('e.team_id = ?'); params.push(Number(req.query.team_id)); }
  const range = resolveTaskDateBounds(req.query);
  if (range) { conditions.push('t.start_date >= ? AND t.start_date <= ?'); params.push(range.start, range.end); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT e.id AS employee_id, e.name AS employee_name, e.employee_code, e.department, e.team_id,
      COUNT(t.id) AS total,
      SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN t.status = 'Not Started' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN t.status = 'On Hold' THEN 1 ELSE 0 END) AS on_hold
    FROM project_tasks t JOIN employees e ON e.id = t.assigned_to_employee_id
    ${where}
    GROUP BY e.id
    ORDER BY total DESC
  `).all(...params);
  const scoped = filterToScope(rows, req.user.role, myEmployee(req.user.sub)?.id);
  const totals = scoped.reduce((acc, r) => ({
    total: acc.total + r.total, completed: acc.completed + r.completed,
    in_progress: acc.in_progress + r.in_progress, pending: acc.pending + r.pending, on_hold: acc.on_hold + r.on_hold
  }), { total: 0, completed: 0, in_progress: 0, pending: 0, on_hold: 0 });
  res.json({ rows: scoped, totals });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '21' (Timesheet). A Senior Team Lead/Team Lead/
// Assistant Manager also passes: the read routes below fetch-then-filter via filterToScope, so
// admitting them here only ever narrows to their assigned departments/teams.
// NOTE: canModuleAdmin alone isn't enough to gate the write branches below — granting these
// scoped roles the specific 'Timesheet Approval' feature-action (so they can approve entries)
// makes canModuleAdmin('<role>', '21') true too, since it only checks "any non-View action
// anywhere in the module", not per-feature. The explicit `&& !isScopedRole` keeps unrestricted
// (company-wide) task-assignment reserved for real HR-tier roles regardless of what else gets
// granted on this module.
const isHR = (role) => canModuleAdmin(role, '21') || isScopedRole(role);
const canAssignOthersTasks = (role) => canModuleAdmin(role, '21') && !isScopedRole(role);
// STL/TL specifically (not Assistant Manager) may also assign — and view — tasks for employees
// within their own assigned department(s)/team(s): a Senior Team Lead's department-level scope
// naturally covers every TL and employee in it, while a Team Lead's team-level scope covers only
// their own team's members — exactly what isEmployeeInScope already enforces everywhere else.
const STL_TL_ROLES = ['stl', 'tl'];
const canAssignWithinScope = (role) => STL_TL_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const employeeById = (id) => db.prepare('SELECT department, team_id FROM employees WHERE id = ?').get(id);

function withDetails(rows) {
  return rows.map((r) => {
    const emp = db.prepare('SELECT name, department, team_id FROM employees WHERE id = ?').get(r.employee_id);
    return {
      ...r,
      employee_name: emp?.name,
      department: emp?.department,
      team_id: emp?.team_id,
      project_name: db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id)?.name
    };
  });
}

// Employee: my own entries + the projects I'm assigned to (to populate the log-entry form).
router.get('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ entries: [], myProjects: [] });
  const entries = withDetails(db.prepare('SELECT * FROM timesheet_entries WHERE employee_id = ? ORDER BY date DESC').all(me.id));
  const myProjects = db.prepare(`
    SELECT p.id, p.name FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE pa.employee_id = ? AND p.status != 'Completed'
  `).all(me.id);
  res.json({ entries, myProjects });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { project_id, date, task_description, hours } = req.body || {};
  const h = parseFloat(hours);
  if (!project_id || !date) return res.status(400).json({ error: 'Project and date are required' });
  if (!Number.isFinite(h) || h <= 0 || h > 24) return res.status(400).json({ error: 'Hours must be between 0 and 24' });
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(project_id);
  if (!project) return res.status(400).json({ error: 'Invalid project' });
  const info = db.prepare('INSERT INTO timesheet_entries (employee_id, project_id, date, task_description, hours) VALUES (?, ?, ?, ?, ?)')
    .run(me.id, project_id, date, task_description?.trim() || null, h);
  res.status(201).json({ entry: withDetails([db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

// HR: pending queue + everything, for approval.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const entries = filterToScope(withDetails(db.prepare("SELECT * FROM timesheet_entries ORDER BY (status='Pending') DESC, date DESC").all()), req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ entries });
});

function decide(finalStatus) {
  return (req, res) => {
    // Feature-level gate: this is exactly the 'Timesheet Approval' feature.
    if (!canFeatureAction(req.user.role, '21', 'Timesheet Approval', 'Approve')) return res.status(403).json({ error: 'Insufficient permissions' });
    const entry = db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.status !== 'Pending') return res.status(400).json({ error: 'This entry has already been decided' });
    // A Senior Team Lead/Team Lead/Assistant Manager may only decide entries from employees
    // within their assigned departments/teams; every other HR-tier role stays company-wide.
    if (isScopedRole(req.user.role)) {
      const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
      const owner = db.prepare('SELECT department, team_id FROM employees WHERE id = ?').get(entry.employee_id);
      if (!isEmployeeInScope(scope, owner)) return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
    }
    db.prepare('UPDATE timesheet_entries SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, entry.id);
    res.json({ ok: true });
  };
}
router.put('/:id/approve', decide('Approved'));
router.put('/:id/reject', decide('Rejected'));

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
// whichever departments happen to have an active employee today), and (HR only) an employee picker.
router.get('/tasks/options', (req, res) => {
  const departments = db.prepare("SELECT name FROM departments ORDER BY name").all().map((d) => d.name);
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
  res.json({ departments, statuses: TASK_STATUSES, employees, isHR: canAssign || canAssignScoped });
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

// Reports: total approved hours by project, and by employee.
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const byProject = db.prepare(`
    SELECT p.name AS project_name, SUM(t.hours) AS total_hours
    FROM timesheet_entries t JOIN projects p ON p.id = t.project_id
    WHERE t.status = 'Approved' GROUP BY p.id ORDER BY total_hours DESC
  `).all();
  const byEmployeeRaw = db.prepare(`
    SELECT e.id AS employee_id, e.name AS employee_name, e.department, e.team_id, SUM(t.hours) AS total_hours
    FROM timesheet_entries t JOIN employees e ON e.id = t.employee_id
    WHERE t.status = 'Approved' GROUP BY e.id ORDER BY total_hours DESC
  `).all();
  const byEmployee = filterToScope(byEmployeeRaw, req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ byProject, byEmployee });
});

export default router;

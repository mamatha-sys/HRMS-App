import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope } from '../utils/scope.js';
import { sendEmail } from '../utils/channels.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '20' (Project & Resource Management).
const isHR = (role) => canModuleAdmin(role, '20');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function withAssignmentCount(rows) {
  return rows.map((p) => ({ ...p, assignedCount: db.prepare('SELECT COUNT(*) c FROM project_assignments WHERE project_id = ?').get(p.id).c }));
}

router.get('/', (req, res) => {
  res.json({ projects: withAssignmentCount(db.prepare("SELECT * FROM projects ORDER BY (status='Active') DESC, created_at DESC").all()) });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, description, start_date } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  if (db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name.trim())) return res.status(409).json({ error: 'A project with this name already exists' });
  const info = db.prepare('INSERT INTO projects (name, description, start_date) VALUES (?, ?, ?)').run(name.trim(), description?.trim() || null, start_date || null);
  res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid) });
});

// Resource overview: total allocation % per employee across every Active project, flagging
// anyone over 100% (double-booked) so HR can rebalance.
router.get('/reports/resource-overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT e.id, e.name, e.employee_code, e.department, COALESCE(SUM(pa.allocation_pct), 0) AS total_allocation_pct, COUNT(pa.id) AS project_count
    FROM employees e
    LEFT JOIN project_assignments pa ON pa.employee_id = e.id
    LEFT JOIN projects p ON p.id = pa.project_id AND p.status = 'Active'
    WHERE e.status = 'Active'
    GROUP BY e.id
    HAVING project_count > 0
    ORDER BY total_allocation_pct DESC
  `).all();
  res.json({ rows: rows.map((r) => ({ ...r, overAllocated: r.total_allocation_pct > 100 })) });
});

// Employee self-service: my own project assignments.
router.get('/mine/list', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ assignments: [] });
  const assignments = db.prepare(`
    SELECT pa.*, p.name AS project_name, p.status AS project_status
    FROM project_assignments pa JOIN projects p ON p.id = pa.project_id
    WHERE pa.employee_id = ? ORDER BY p.status
  `).all(me.id);
  res.json({ assignments });
});

// ---------- Timesheet: daily hours logged against a project, HR-approved ----------
// NOTE: every route in this section is registered ABOVE the generic `/:id` project routes below
// — Express matches routes in registration order, and a bare `GET /:id` would otherwise swallow
// `GET /timesheet` (treating "timesheet" as the id) before it ever reached the real handler.
// A Senior Team Lead/Team Lead/Assistant Manager also passes `timesheetHR`: the read routes
// fetch-then-filter via scope, so admitting them here only ever narrows to their assigned
// departments/teams.
const timesheetHR = (role) => canModuleAdmin(role, '20') || isScopedRole(role);

function withTimesheetDetails(rows) {
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
router.get('/timesheet', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ entries: [], myProjects: [] });
  const entries = withTimesheetDetails(db.prepare('SELECT * FROM timesheet_entries WHERE employee_id = ? ORDER BY date DESC').all(me.id));
  const myProjects = db.prepare(`
    SELECT p.id, p.name FROM project_assignments pa JOIN projects p ON p.id = pa.project_id WHERE pa.employee_id = ? AND p.status != 'Completed'
  `).all(me.id);
  res.json({ entries, myProjects });
});

router.post('/timesheet', (req, res) => {
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
  res.status(201).json({ entry: withTimesheetDetails([db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(info.lastInsertRowid)])[0] });

  // Notify the submitter's manager by email that a timesheet entry is waiting on them — best
  // effort, after responding, never blocks/fails the submission itself. `reporting_manager` is a
  // free-text name (not a real FK — see employees.routes.js), so this is a best-effort name match,
  // not a guaranteed lookup; it silently does nothing if there's no match or no email on file.
  if (me.reporting_manager?.trim()) {
    const manager = db.prepare('SELECT email FROM employees WHERE name = ?').get(me.reporting_manager.trim());
    if (manager?.email) {
      const projectName = db.prepare('SELECT name FROM projects WHERE id = ?').get(project_id)?.name || 'a project';
      sendEmail(
        manager.email,
        `Timesheet entry submitted — ${me.name}`,
        `Hi,\n\n${me.name} logged ${h} hour(s) on ${date} for ${projectName}${task_description?.trim() ? `:\n"${task_description.trim()}"` : '.'}\n\nIt's awaiting your review in Project & Resource Management.`
      ).catch(() => {});
    }
  }
});

// HR: pending queue + everything, for approval.
router.get('/timesheet/overview', (req, res) => {
  if (!timesheetHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const entries = filterToScope(withTimesheetDetails(db.prepare("SELECT * FROM timesheet_entries ORDER BY (status='Pending') DESC, date DESC").all()), req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ entries });
});

function decideTimesheet(finalStatus) {
  return (req, res) => {
    // Feature-level gate: this is exactly the 'Timesheet Approval' feature.
    if (!canFeatureAction(req.user.role, '20', 'Timesheet Approval', 'Approve')) return res.status(403).json({ error: 'Insufficient permissions' });
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
router.put('/timesheet/:id/approve', decideTimesheet('Approved'));
router.put('/timesheet/:id/reject', decideTimesheet('Rejected'));

// Reports: total approved hours by project, and by employee.
router.get('/timesheet/reports', (req, res) => {
  if (!timesheetHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
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
// ---------- End Timesheet ----------

router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const { description, status, end_date } = req.body || {};
  db.prepare('UPDATE projects SET description = COALESCE(?, description), status = COALESCE(?, status), end_date = COALESCE(?, end_date) WHERE id = ?')
    .run(description !== undefined ? description.trim() : null, ['Active', 'On Hold', 'Completed'].includes(status) ? status : null, end_date || null, req.params.id);
  res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) });
});

router.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const assignments = db.prepare(`
    SELECT pa.*, e.name, e.employee_code FROM project_assignments pa JOIN employees e ON e.id = pa.employee_id
    WHERE pa.project_id = ? ORDER BY e.name
  `).all(project.id);
  res.json({ project, assignments });
});

router.post('/:id/assign', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { employee_id, allocation_pct, role_on_project } = req.body || {};
  const pct = Math.max(1, Math.min(100, parseInt(allocation_pct, 10) || 100));
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  db.prepare(`
    INSERT INTO project_assignments (project_id, employee_id, allocation_pct, role_on_project) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, employee_id) DO UPDATE SET allocation_pct = excluded.allocation_pct, role_on_project = excluded.role_on_project
  `).run(project.id, employee_id, pct, role_on_project?.trim() || null);
  res.status(201).json({ ok: true });
});

router.delete('/:id/assign/:employeeId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND employee_id = ?').run(req.params.id, req.params.employeeId);
  res.json({ ok: true });
});

export default router;

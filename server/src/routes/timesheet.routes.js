import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function withDetails(rows) {
  return rows.map((r) => ({
    ...r,
    employee_name: db.prepare('SELECT name FROM employees WHERE id = ?').get(r.employee_id)?.name,
    project_name: db.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id)?.name
  }));
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
  const entries = withDetails(db.prepare("SELECT * FROM timesheet_entries ORDER BY (status='Pending') DESC, date DESC").all());
  res.json({ entries });
});

function decide(finalStatus) {
  return (req, res) => {
    if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const entry = db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.status !== 'Pending') return res.status(400).json({ error: 'This entry has already been decided' });
    db.prepare('UPDATE timesheet_entries SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, entry.id);
    res.json({ ok: true });
  };
}
router.put('/:id/approve', decide('Approved'));
router.put('/:id/reject', decide('Rejected'));

// ---------- My Tasks (project task management) ----------
const TASK_STATUSES = ['Not Started', 'In Progress', 'Completed', 'On Hold'];

function withTaskDetails(rows) {
  return rows.map((t) => {
    const assignedByOther = t.created_by && (!t.assigned_to_employee_id || db.prepare('SELECT user_id FROM employees WHERE id = ?').get(t.assigned_to_employee_id)?.user_id !== t.created_by);
    return {
      ...t,
      project_name: t.project_id ? db.prepare('SELECT name FROM projects WHERE id = ?').get(t.project_id)?.name : null,
      assigned_to_name: t.assigned_to_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(t.assigned_to_employee_id)?.name : null,
      created_by_name: assignedByOther ? db.prepare('SELECT name FROM users WHERE id = ?').get(t.created_by)?.name : null,
      depends_on_name: t.depends_on_task_id ? db.prepare('SELECT task_name FROM project_tasks WHERE id = ?').get(t.depends_on_task_id)?.task_name : null
    };
  });
}

// Data the "+ New Task" form needs: project list, and (HR only) an employee picker to assign to.
router.get('/tasks/options', (req, res) => {
  const projects = db.prepare("SELECT id, name FROM projects WHERE status != 'Completed' ORDER BY name").all();
  const employees = isHR(req.user.role) ? db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active' ORDER BY name").all() : [];
  res.json({ projects, statuses: TASK_STATUSES, employees, isHR: isHR(req.user.role) });
});

// My Tasks: everything assigned to me, whoever created it (a self-made task or one a
// manager/HR assigned straight to me).
router.get('/tasks', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ tasks: [] });
  const tasks = withTaskDetails(db.prepare('SELECT * FROM project_tasks WHERE assigned_to_employee_id = ? ORDER BY (status != \'Completed\') DESC, start_date DESC').all(me.id));
  res.json({ tasks });
});

router.post('/tasks', (req, res) => {
  const { project_id, task_name, description, sub_task_name, status, start_date, end_date, is_dependent, depends_on_task_id, assigned_to_employee_id } = req.body || {};
  if (!task_name?.trim()) return res.status(400).json({ error: 'Task name is required' });
  if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  if (!start_date) return res.status(400).json({ error: 'Task start date is required' });

  // A manager/HR ("higher authority") can assign this straight to any active employee; anyone
  // else can only ever create a task for themselves.
  let assigneeId;
  if (isHR(req.user.role) && assigned_to_employee_id) {
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(assigned_to_employee_id)) return res.status(400).json({ error: 'Invalid assignee' });
    assigneeId = assigned_to_employee_id;
  } else {
    const me = myEmployee(req.user.sub);
    if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
    assigneeId = me.id;
  }

  const info = db.prepare(`
    INSERT INTO project_tasks (project_id, assigned_to_employee_id, created_by, task_name, description, sub_task_name, status, start_date, end_date, is_dependent, depends_on_task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project_id || null, assigneeId, req.user.sub, task_name.trim(), description?.trim() || null, sub_task_name?.trim() || null,
    status, start_date, end_date || null, is_dependent ? 1 : 0, is_dependent && depends_on_task_id ? depends_on_task_id : null);

  if (assigneeId !== myEmployee(req.user.sub)?.id) {
    db.prepare('INSERT INTO notifications (title, message, target_role, employee_id) VALUES (?, ?, ?, ?)')
      .run('New task assigned', `${req.user.name || 'Your manager'} assigned you a task: "${task_name.trim()}"`, 'employee', assigneeId);
  }

  res.status(201).json({ task: withTaskDetails([db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

router.put('/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const me = myEmployee(req.user.sub);
  const canEdit = isHR(req.user.role) || task.assigned_to_employee_id === me?.id || task.created_by === req.user.sub;
  if (!canEdit) return res.status(403).json({ error: 'Insufficient permissions' });
  const { status, end_date } = req.body || {};
  db.prepare(`
    UPDATE project_tasks SET status = COALESCE(?, status), end_date = COALESCE(?, end_date), updated_at = datetime('now') WHERE id = ?
  `).run(TASK_STATUSES.includes(status) ? status : null, end_date || null, task.id);
  res.json({ task: withTaskDetails([db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(task.id)])[0] });
});

router.get('/tasks/:id/updates', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && task.assigned_to_employee_id !== me?.id && task.created_by !== req.user.sub) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ updates: db.prepare('SELECT * FROM project_task_updates WHERE task_id = ? ORDER BY created_at').all(task.id) });
});

router.post('/tasks/:id/updates', (req, res) => {
  const task = db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && task.assigned_to_employee_id !== me?.id && task.created_by !== req.user.sub) return res.status(403).json({ error: 'Insufficient permissions' });
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
  const byEmployee = db.prepare(`
    SELECT e.name AS employee_name, SUM(t.hours) AS total_hours
    FROM timesheet_entries t JOIN employees e ON e.id = t.employee_id
    WHERE t.status = 'Approved' GROUP BY e.id ORDER BY total_hours DESC
  `).all();
  res.json({ byProject, byEmployee });
});

export default router;

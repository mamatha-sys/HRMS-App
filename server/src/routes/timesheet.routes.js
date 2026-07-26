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

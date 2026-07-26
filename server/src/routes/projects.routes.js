import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';

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

export default router;

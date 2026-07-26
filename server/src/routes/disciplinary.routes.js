import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Sensitive HR data: only HR roles manage/see the full list; an employee may only ever see
// their own cases (read-only), never another employee's — same privacy rule as the PIP flag
// in Performance Management.
// Dynamic RBAC via Manage Roles — module '22' (Disciplinary Action Tracking).
const isHR = (role) => canModuleAdmin(role, '22');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function withEmployee(rows) {
  return rows.map((r) => ({ ...r, employee_name: db.prepare('SELECT name, employee_code FROM employees WHERE id = ?').get(r.employee_id)?.name }));
}

router.get('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ cases: withEmployee(db.prepare("SELECT * FROM disciplinary_cases ORDER BY (status='Open') DESC, created_at DESC").all()) });
});

router.get('/mine', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ cases: [] });
  res.json({ cases: db.prepare('SELECT * FROM disciplinary_cases WHERE employee_id = ? ORDER BY created_at DESC').all(me.id) });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, category, description } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  if (!['Warning', 'Suspension', 'Termination', 'Other'].includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  if (!description?.trim()) return res.status(400).json({ error: 'A description is required' });
  const info = db.prepare('INSERT INTO disciplinary_cases (employee_id, category, description, raised_by) VALUES (?, ?, ?, ?)')
    .run(employee_id, category, description.trim(), req.user.sub);
  res.status(201).json({ case: withEmployee([db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

router.get('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && c.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  const notes = db.prepare('SELECT * FROM disciplinary_case_notes WHERE case_id = ? ORDER BY created_at').all(c.id);
  res.json({ case: withEmployee([c])[0], notes });
});

router.post('/:id/notes', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const c = db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: 'Note text is required' });
  db.prepare('INSERT INTO disciplinary_case_notes (case_id, author_name, note) VALUES (?, ?, ?)').run(c.id, req.user.name || 'HR', note.trim());
  res.status(201).json({ notes: db.prepare('SELECT * FROM disciplinary_case_notes WHERE case_id = ? ORDER BY created_at').all(c.id) });
});

router.put('/:id', (req, res) => {
  // Feature-level gate: updating status/resolution is exactly the 'Case Resolution' feature.
  if (!canFeatureAction(req.user.role, '22', 'Case Resolution', 'Manage')) return res.status(403).json({ error: 'Insufficient permissions' });
  const c = db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { status, resolution_notes } = req.body || {};
  if (!['Open', 'Resolved'].includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  db.prepare("UPDATE disciplinary_cases SET status = ?, resolution_notes = ?, resolved_at = CASE WHEN ? = 'Resolved' THEN datetime('now') ELSE NULL END WHERE id = ?")
    .run(status, resolution_notes?.trim() || c.resolution_notes, status, c.id);
  res.json({ case: withEmployee([db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(c.id)])[0] });
});

export default router;

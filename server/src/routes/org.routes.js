import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/departments', (req, res) => {
  const rows = db.prepare('SELECT * FROM departments ORDER BY parent_department_id IS NOT NULL, name').all();
  res.json({ departments: rows });
});

router.post('/departments', requireRole('super_admin'), (req, res) => {
  const { name, parent_department_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db
      .prepare('INSERT INTO departments (name, parent_department_id) VALUES (?, ?)')
      .run(name, parent_department_id || null);
    res.status(201).json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'A department with this name already exists' });
  }
});

router.delete('/departments/:id', requireRole('super_admin'), (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM departments WHERE parent_department_id = ?').get(req.params.id).c;
  if (inUse > 0) return res.status(409).json({ error: 'Cannot delete a department that has sub-departments' });
  const info = db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Department not found' });
  res.status(204).send();
});

router.get('/branches', (req, res) => {
  res.json({ branches: db.prepare('SELECT * FROM branches ORDER BY name').all() });
});

router.post('/branches', requireRole('super_admin'), (req, res) => {
  const { name, location } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO branches (name, location) VALUES (?, ?)').run(name, location || null);
    res.status(201).json({ branch: db.prepare('SELECT * FROM branches WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'A branch with this name already exists' });
  }
});

router.delete('/branches/:id', requireRole('super_admin'), (req, res) => {
  const info = db.prepare('DELETE FROM branches WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Branch not found' });
  res.status(204).send();
});

export default router;

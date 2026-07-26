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

router.put('/departments/:id', requireRole('super_admin'), (req, res) => {
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!dept) return res.status(404).json({ error: 'Department not found' });
  const { name, status } = req.body || {};
  if (status && !['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    db.prepare('UPDATE departments SET name = COALESCE(?, name), status = COALESCE(?, status) WHERE id = ?')
      .run(name?.trim() || null, status || null, req.params.id);
    res.json({ department: db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id) });
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

router.put('/branches/:id', requireRole('super_admin'), (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const { name, location, status } = req.body || {};
  if (status && !['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    db.prepare('UPDATE branches SET name = COALESCE(?, name), location = COALESCE(?, location), status = COALESCE(?, status) WHERE id = ?')
      .run(name?.trim() || null, location ?? null, status || null, req.params.id);
    res.json({ branch: db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id) });
  } catch {
    res.status(409).json({ error: 'A branch with this name already exists' });
  }
});

router.delete('/branches/:id', requireRole('super_admin'), (req, res) => {
  const info = db.prepare('DELETE FROM branches WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Branch not found' });
  res.status(204).send();
});

// Teams: sub-units within a department (e.g. Education's Team-A/Team-B). Used to scope an
// STL/TL's Attendance/Leave/Approvals access to specific teams rather than the whole company —
// see server/src/utils/scope.js.
router.get('/teams', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, d.name AS department_name
    FROM teams t JOIN departments d ON d.id = t.department_id
    ORDER BY d.name, t.name
  `).all();
  res.json({ teams: rows });
});

router.post('/teams', requireRole('super_admin'), (req, res) => {
  const { name, department_id } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'A valid department_id is required' });
  try {
    const info = db.prepare('INSERT INTO teams (name, department_id) VALUES (?, ?)').run(name.trim(), department_id);
    res.status(201).json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'A team with this name already exists in this department' });
  }
});

router.put('/teams/:id', requireRole('super_admin'), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  const { name, status } = req.body || {};
  if (status && !['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    db.prepare('UPDATE teams SET name = COALESCE(?, name), status = COALESCE(?, status) WHERE id = ?')
      .run(name?.trim() || null, status || null, req.params.id);
    res.json({ team: db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id) });
  } catch {
    res.status(409).json({ error: 'A team with this name already exists in this department' });
  }
});

router.delete('/teams/:id', requireRole('super_admin'), (req, res) => {
  const info = db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Team not found' });
  res.status(204).send();
});

export default router;

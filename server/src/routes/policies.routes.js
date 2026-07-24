import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const CATEGORIES = ['business', 'rule', 'setting'];

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM policies ORDER BY category, id').all();
  res.json({ policies: rows });
});

router.post('/', requireRole('super_admin'), (req, res) => {
  const { category, name, value } = req.body || {};
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO policies (category, name, value) VALUES (?, ?, ?)').run(category, name.trim(), value ?? null);
  res.status(201).json({ policy: db.prepare('SELECT * FROM policies WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', requireRole('super_admin'), (req, res) => {
  const policy = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!policy) return res.status(404).json({ error: 'Policy not found' });
  const { name, value } = req.body || {};
  db.prepare('UPDATE policies SET name = COALESCE(?, name), value = ? WHERE id = ?')
    .run(name?.trim() || null, value ?? policy.value, req.params.id);
  res.json({ policy: db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', requireRole('super_admin'), (req, res) => {
  const info = db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Policy not found' });
  res.status(204).send();
});

export default router;

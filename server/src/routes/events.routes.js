import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE (target_role = 'all' OR target_role = ?) AND event_date >= date('now', '-1 day')
    ORDER BY event_date ASC
    LIMIT 20
  `).all(req.user.role);
  res.json({ events: rows });
});

router.post('/', requireRole('super_admin', 'manager'), (req, res) => {
  const { title, description, event_date, target_role } = req.body || {};
  if (!title || !event_date) return res.status(400).json({ error: 'title and event_date are required' });
  const role = ['all', 'super_admin', 'manager', 'employee'].includes(target_role) ? target_role : 'all';
  const info = db
    .prepare('INSERT INTO events (title, description, event_date, target_role, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(title, description || null, event_date, role, req.user.sub);
  res.status(201).json({ event: db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/:id', requireRole('super_admin', 'manager'), (req, res) => {
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Event not found' });
  res.status(204).send();
});

export default router;

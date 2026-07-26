import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

// Everyone: the company notice board, newest first with pinned posts always on top.
router.get('/', (req, res) => {
  const announcements = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC').all();
  res.json({ announcements });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, body, category, pinned } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body?.trim()) return res.status(400).json({ error: 'Body is required' });
  const cat = ['General', 'Policy', 'Event', 'Holiday'].includes(category) ? category : 'General';
  const info = db.prepare('INSERT INTO announcements (title, body, category, posted_by, pinned) VALUES (?, ?, ?, ?, ?)')
    .run(title.trim(), body.trim(), cat, req.user.name || 'HR', pinned ? 1 : 0);
  res.status(201).json({ announcement: db.prepare('SELECT * FROM announcements WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Announcement not found' });
  const { title, body, category, pinned } = req.body || {};
  db.prepare('UPDATE announcements SET title = COALESCE(?, title), body = COALESCE(?, body), category = COALESCE(?, category), pinned = ? WHERE id = ?')
    .run(title?.trim() || null, body?.trim() || null, ['General', 'Policy', 'Event', 'Holiday'].includes(category) ? category : null,
      pinned === undefined ? a.pinned : (pinned ? 1 : 0), req.params.id);
  res.json({ announcement: db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;

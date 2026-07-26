import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const employee = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(req.user.sub);
  const rows = db.prepare(`
    SELECT n.*, EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = @uid) AS is_read
    FROM notifications n
    WHERE n.employee_id = @empId
       OR (n.employee_id IS NULL AND (n.target_role = 'all' OR n.target_role = @role))
    ORDER BY n.created_at DESC
    LIMIT 30
  `).all({ uid: req.user.sub, role: req.user.role, empId: employee ? employee.id : null });
  res.json({ notifications: rows.map((r) => ({ ...r, is_read: !!r.is_read })) });
});

router.post('/', requireRole('super_admin', 'manager'), (req, res) => {
  const { title, message, target_role } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  const role = ['all', 'super_admin', 'manager', 'employee'].includes(target_role) ? target_role : 'all';
  const info = db
    .prepare('INSERT INTO notifications (title, message, target_role, created_by) VALUES (?, ?, ?, ?)')
    .run(title, message, role, req.user.sub);
  res.status(201).json({ notification: db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/:id/read', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)')
    .run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

export default router;

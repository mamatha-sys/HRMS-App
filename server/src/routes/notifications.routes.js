import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { sendNotification } from '../utils/notify.js';
import { recentDeliveries } from '../utils/channels.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

router.get('/', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE user_id = ?').get(req.user.sub);
  const rows = db.prepare(`
    SELECT n.*, EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = @uid) AS is_read
    FROM notifications n
    WHERE n.employee_id = @empId
       OR (n.employee_id IS NULL AND n.target_department IS NOT NULL AND n.target_department = @dept)
       OR (n.employee_id IS NULL AND n.target_department IS NULL AND (n.target_role = 'all' OR n.target_role = @role))
    ORDER BY n.created_at DESC
    LIMIT 30
  `).all({ uid: req.user.sub, role: req.user.role, empId: employee ? employee.id : null, dept: employee ? employee.department : null });
  res.json({ notifications: rows.map((r) => ({ ...r, is_read: !!r.is_read })) });
});

// Data the HR compose form needs: department list + employee picker.
router.get('/compose-options', requireRole(...HR_ROLES), (req, res) => {
  // Sourced from employees' actual department field (not the departments master list) — a
  // department can be "Paused" there for hiring/org-structure purposes while still having real
  // employees in it, and only departments with real people are useful to target here.
  const departments = db.prepare("SELECT DISTINCT department FROM employees WHERE status = 'Active' ORDER BY department").all().map((d) => d.department);
  const employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  res.json({ departments, employees });
});

// Log of every real Email/SMS/WhatsApp send attempt, across both Notifications and
// Announcements — the "Notification Log" view.
router.get('/deliveries', requireRole(...HR_ROLES), (req, res) => {
  res.json({ deliveries: recentDeliveries(50) });
});

router.post('/', requireRole(...HR_ROLES), async (req, res) => {
  const { title, message, target_role, target_department, employee_ids, channels } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  const role = ['all', 'super_admin', 'manager', 'employee'].includes(target_role) ? target_role : 'all';
  const chosenChannels = Array.isArray(channels) ? channels.filter((c) => ['email', 'sms', 'whatsapp'].includes(c)) : [];
  try {
    const notificationId = await sendNotification({
      title, message,
      target_role: employee_ids?.length || target_department ? null : role,
      target_department: target_department || null,
      employee_ids: Array.isArray(employee_ids) && employee_ids.length ? employee_ids : null,
      channels: chosenChannels
    });
    res.status(201).json({ notification: db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not send notification.' });
  }
});

router.post('/:id/read', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)')
    .run(req.params.id, req.user.sub);
  res.json({ ok: true });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireModule } from '../utils/rbac.js';
import { sendNotification } from '../utils/notify.js';
import { recentDeliveries } from '../utils/channels.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

// target_role on a broadcast row is one of: an exact role name, 'all' (every role, including
// plain employees), or 'staff' (every role except plain employees) — used for operational
// alerts (e.g. Helpdesk ticket activity) that HR/admin/managerial roles need to see but a
// regular employee shouldn't, since it's not about their own affairs.
router.get('/', (req, res) => {
  const employee = db.prepare('SELECT * FROM employees WHERE user_id = ?').get(req.user.sub);

  // STL/TL see department-targeted notifications for every department they supervise (not just
  // their own personal one), since a department-level (STL) or team-level (TL) grant can cover
  // departments other than the one their own employee record happens to sit in.
  if (isScopedRole(req.user.role)) {
    const scope = getSupervisorScope(employee?.id);
    const deptNames = new Set(scopeDepartmentNames(scope));
    if (employee?.department) deptNames.add(employee.department);
    const names = [...deptNames];
    const placeholders = names.map(() => '?').join(',') || 'NULL';
    // A 'staff' broadcast about a specific ticket (new ticket / auto-escalation) only reaches an
    // STL/TL if the raising employee's department falls within their assigned scope — the same
    // department-scoping the Vacancies widget already applies for this role, rather than every
    // 'staff' alert company-wide. A 'staff' broadcast with no ticket_id (nothing to attribute to
    // a department) still reaches them, same as before.
    const rows = db.prepare(`
      SELECT n.*, EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS is_read
      FROM notifications n
      WHERE (n.employee_id = ?
         OR (n.employee_id IS NULL AND n.target_department IS NOT NULL AND n.target_department IN (${placeholders}))
         OR (n.employee_id IS NULL AND n.target_department IS NULL AND n.target_role = 'all')
         OR (n.employee_id IS NULL AND n.target_department IS NULL AND n.target_role = 'staff' AND (
              n.ticket_id IS NULL
              OR EXISTS (SELECT 1 FROM tickets t JOIN employees e ON e.id = t.employee_id WHERE t.id = n.ticket_id AND e.department IN (${placeholders}))
            ))
         OR (n.employee_id IS NULL AND n.target_department IS NULL AND n.target_role = ?))
        AND (n.ticket_id IS NULL OR NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = n.ticket_id AND t.status IN ('Resolved','Closed')))
      ORDER BY n.created_at DESC
      LIMIT 30
    `).all(req.user.sub, employee ? employee.id : null, ...names, ...names, req.user.role);
    return res.json({ notifications: rows.map((r) => ({ ...r, is_read: !!r.is_read })) });
  }

  const rows = db.prepare(`
    SELECT n.*, EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = @uid) AS is_read
    FROM notifications n
    WHERE (n.employee_id = @empId
       OR (n.employee_id IS NULL AND n.target_department IS NOT NULL AND n.target_department = @dept)
       OR (n.employee_id IS NULL AND n.target_department IS NULL AND (n.target_role = 'all' OR (n.target_role = 'staff' AND @role != 'employee') OR n.target_role = @role)))
      AND (n.ticket_id IS NULL OR NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = n.ticket_id AND t.status IN ('Resolved','Closed')))
    ORDER BY n.created_at DESC
    LIMIT 30
  `).all({ uid: req.user.sub, role: req.user.role, empId: employee ? employee.id : null, dept: employee ? employee.department : null });
  res.json({ notifications: rows.map((r) => ({ ...r, is_read: !!r.is_read })) });
});

// Data the HR compose form needs: the real Organization Structure department list + employee picker.
router.get('/compose-options', requireModule('14'), (req, res) => {
  const departments = db.prepare("SELECT name FROM departments ORDER BY name").all().map((d) => d.name);
  const employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  res.json({ departments, employees });
});

// Log of every real Email/SMS/WhatsApp send attempt, across both Notifications and
// Announcements — the "Notification Log" view.
router.get('/deliveries', requireModule('14'), (req, res) => {
  res.json({ deliveries: recentDeliveries(50) });
});

router.post('/', requireModule('14'), async (req, res) => {
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

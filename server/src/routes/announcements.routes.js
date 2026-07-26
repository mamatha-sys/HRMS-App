import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { notifyAll, employeesForTarget } from '../utils/notify.js';
import { dispatchChannels, recentDeliveries } from '../utils/channels.js';
import { notifyWebhooks } from '../utils/webhooks.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

function withRecipients(rows) {
  return rows.map((a) => ({
    ...a,
    recipient_names: db.prepare(`
      SELECT e.name FROM announcement_recipients r JOIN employees e ON e.id = r.employee_id WHERE r.announcement_id = ?
    `).all(a.id).map((e) => e.name)
  }));
}

// HR/management view: every announcement, whoever it's targeted at.
router.get('/', (req, res) => {
  if (isHR(req.user.role)) {
    const announcements = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC').all();
    return res.json({ announcements: withRecipients(announcements) });
  }
  // Employee self-service: only company-wide posts, posts targeted at their own department, or
  // posts naming them individually — never another employee's or another department's notice.
  const employee = db.prepare('SELECT * FROM employees WHERE user_id = ?').get(req.user.sub);
  const announcements = db.prepare(`
    SELECT a.* FROM announcements a
    WHERE (a.target_department IS NULL AND NOT EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id))
       OR (a.target_department IS NOT NULL AND a.target_department = @dept)
       OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.employee_id = @empId)
    ORDER BY a.pinned DESC, a.created_at DESC
  `).all({ dept: employee?.department || null, empId: employee?.id || null });
  res.json({ announcements });
});

// Data the compose form needs: department list + employee picker (same shape as Notifications').
router.get('/compose-options', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const departments = db.prepare("SELECT DISTINCT department FROM employees WHERE status = 'Active' ORDER BY department").all().map((d) => d.department);
  const employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  res.json({ departments, employees });
});

router.get('/deliveries', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ deliveries: recentDeliveries(50) });
});

router.post('/', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, body, category, pinned, target_department, employee_ids, channels } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body?.trim()) return res.status(400).json({ error: 'Body is required' });
  const cat = ['General', 'Policy', 'Event', 'Holiday'].includes(category) ? category : 'General';
  const chosenChannels = Array.isArray(channels) ? channels.filter((c) => ['email', 'sms', 'whatsapp'].includes(c)) : [];
  const targetDept = target_department || null;
  const targetEmployeeIds = Array.isArray(employee_ids) ? employee_ids.filter(Boolean) : [];

  const info = db.prepare('INSERT INTO announcements (title, body, category, posted_by, pinned, target_department, channels) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title.trim(), body.trim(), cat, req.user.name || 'HR', pinned ? 1 : 0, targetDept, (chosenChannels.length ? chosenChannels : ['in_app']).join(','));
  const announcementId = info.lastInsertRowid;

  if (targetEmployeeIds.length) {
    const insertRecipient = db.prepare('INSERT OR IGNORE INTO announcement_recipients (announcement_id, employee_id) VALUES (?, ?)');
    targetEmployeeIds.forEach((empId) => insertRecipient.run(announcementId, empId));
  }

  // Meeting/company-event announcements with no narrower target also broadcast into everyone's
  // Notifications feed, not just the notice board.
  if (cat === 'Event' && !targetDept && !targetEmployeeIds.length) notifyAll(`Event: ${title.trim()}`, body.trim());

  if (chosenChannels.length) {
    const recipients = employeesForTarget({ target_department: targetDept, employee_ids: targetEmployeeIds.length ? targetEmployeeIds : null });
    await dispatchChannels({ source: 'announcement', sourceId: announcementId, employees: recipients, channels: chosenChannels, title: title.trim(), message: body.trim() });
  }
  notifyWebhooks('New Announcement', `[${cat}] ${title.trim()} — ${body.trim()}`).catch(() => {});

  res.status(201).json({ announcement: withRecipients([db.prepare('SELECT * FROM announcements WHERE id = ?').get(announcementId)])[0] });
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

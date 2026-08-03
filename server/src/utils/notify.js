import db from '../db.js';
import { dispatchChannels } from './channels.js';

// Send a notification to one specific employee (not a role broadcast) — e.g. "Your leave
// request was approved". Shows up in that employee's own Notifications feed only. Internal
// system-triggered notifications (approvals, resolutions, etc.) are always in-app only.
export function notifyEmployee(employeeId, title, message, { priority, ticketId } = {}) {
  if (!employeeId) return;
  db.prepare('INSERT INTO notifications (title, message, target_role, employee_id, priority, ticket_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, message, 'employee', employeeId, priority || null, ticketId || null);
}

// Broadcast to everyone — used for company-wide posts like meeting/event announcements.
export function notifyAll(title, message) {
  db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)').run(title, message, 'all');
}

// Resolve which real employee rows a notification/announcement should reach, for the
// department-wide and individual-employee(s) targeting options in the HR compose form.
export function employeesForTarget({ target_role, target_department, employee_ids }) {
  if (employee_ids?.length) {
    const placeholders = employee_ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM employees WHERE id IN (${placeholders})`).all(...employee_ids);
  }
  if (target_department) {
    return db.prepare('SELECT * FROM employees WHERE department = ?').all(target_department);
  }
  if (target_role && target_role !== 'all') {
    return db.prepare(`
      SELECT e.* FROM employees e JOIN users u ON u.id = e.user_id WHERE u.role = ?
    `).all(target_role);
  }
  return db.prepare('SELECT * FROM employees').all();
}

// HR compose flow: create the in-app notification row(s) for the chosen target, then fan the
// same title/message out to every requested external channel (Email/SMS/WhatsApp) for the
// resolved recipients. Individual-employee targeting fans out one in-app row per person so each
// person's own feed carries it as a personal notification; role/department/all targeting stays
// a single broadcast row (matched by target_role/target_department at read time).
export async function sendNotification({ title, message, target_role, target_department, employee_ids, channels }) {
  const recipients = employeesForTarget({ target_role, target_department, employee_ids });
  let notificationId;
  if (employee_ids?.length) {
    recipients.forEach((emp) => {
      const info = db.prepare('INSERT INTO notifications (title, message, target_role, employee_id, channels) VALUES (?, ?, ?, ?, ?)')
        .run(title, message, 'employee', emp.id, (channels || ['in_app']).join(','));
      notificationId = notificationId || info.lastInsertRowid;
    });
  } else {
    const info = db.prepare('INSERT INTO notifications (title, message, target_role, target_department, channels) VALUES (?, ?, ?, ?, ?)')
      .run(title, message, target_role || 'all', target_department || null, (channels || ['in_app']).join(','));
    notificationId = info.lastInsertRowid;
  }
  await dispatchChannels({ source: 'notification', sourceId: notificationId, employees: recipients, channels, title, message });
  return notificationId;
}

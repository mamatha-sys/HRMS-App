import db from '../db.js';

// Send a notification to one specific employee (not a role broadcast) — e.g. "Your leave
// request was approved". Shows up in that employee's own Notifications feed only.
export function notifyEmployee(employeeId, title, message) {
  if (!employeeId) return;
  db.prepare('INSERT INTO notifications (title, message, target_role, employee_id) VALUES (?, ?, ?, ?)')
    .run(title, message, 'employee', employeeId);
}

// Broadcast to everyone — used for company-wide posts like meeting/event announcements.
export function notifyAll(title, message) {
  db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)').run(title, message, 'all');
}

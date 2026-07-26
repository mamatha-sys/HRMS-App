import db from '../db.js';

// Shared by attendance.routes.js (web/mobile check-in) and the biometric device receiver
// (integrations.routes.js), so a punch from a real fingerprint/face device is subject to the
// exact same late-arrival grace period and half-day-cut rules as a manual check-in.

export const nowTime = () => new Date().toTimeString().slice(0, 5);
export const today = () => db.prepare("SELECT date('now') AS d").get().d;
// Company rule: General shift is 9:00 AM – 6:00 PM with a grace period until 9:15.
export const LATE_AFTER = '09:15';
export const METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)', 'Face Recognition'];

export function freeLateAllowance() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Free late arrivals per month'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// Recomputes half_day_flag for every late day this month for one employee, in date order,
// so the (allowance+1)-th late arrival onward is flagged for an automatic payroll deduction.
// Re-run after every check-in so corrections (e.g. HR editing a time) stay consistent.
export function recomputeLateFlags(employeeId, month) {
  const allowance = freeLateAllowance();
  const lateRows = db.prepare('SELECT id FROM attendance WHERE employee_id = ? AND date LIKE ? AND check_in_time > ? ORDER BY date')
    .all(employeeId, month + '%', LATE_AFTER);
  const update = db.prepare('UPDATE attendance SET half_day_flag = ? WHERE id = ?');
  lateRows.forEach((r, idx) => update.run(idx >= allowance ? 1 : 0, r.id));
}

export function upsertAttendanceForDate(employeeId, date, patch) {
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  if (existing) {
    const merged = { ...existing, ...patch };
    db.prepare('UPDATE attendance SET status = @status, check_in_time = @check_in_time, check_out_time = @check_out_time, method = @method, latitude = @latitude, longitude = @longitude WHERE id = @id').run(merged);
    return db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
  }
  const row = { employee_id: employeeId, date, status: 'Present', check_in_time: null, check_out_time: null, method: 'Web Check-in', latitude: null, longitude: null, ...patch };
  const info = db.prepare('INSERT INTO attendance (employee_id, date, status, check_in_time, check_out_time, method, latitude, longitude) VALUES (@employee_id, @date, @status, @check_in_time, @check_out_time, @method, @latitude, @longitude)').run(row);
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(info.lastInsertRowid);
}

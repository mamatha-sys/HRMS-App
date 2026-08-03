import db from '../db.js';
import { notifyEmployee } from './notify.js';

// Shared by attendance.routes.js (web/mobile check-in) and the biometric device receiver
// (integrations.routes.js), so a punch from a real fingerprint/face device is subject to the
// exact same late-arrival grace period and half-day-cut rules as a manual check-in.

export const nowTime = () => new Date().toTimeString().slice(0, 5);
export const today = () => db.prepare("SELECT date('now') AS d").get().d;
// Company rule: General shift is 9:00 AM – 6:00 PM with a grace period until 9:15.
export const LATE_AFTER = '09:15';
// Checking out before shift end (6:00 PM) counts as an early logout.
export const EARLY_BEFORE = '18:00';
// The only two methods an employee can pick from the check-in dropdown — both require a live
// face-verification capture before the check-in is accepted (see /check-in). 'Biometric
// (Fingerprint)' is a real method too, but it's never picked here — it's written directly by the
// hardware device receiver (biometricPunch.js) and shows up in Reports only, never as a manual
// option, since nobody "selects" a fingerprint scan from a web dropdown.
export const METHODS = ['Web Check-in', 'Mobile App'];

export function freeLateAllowance() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Free late arrivals per month'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// Super Admin can turn either check-in method off company-wide — stored as ordinary rows in the
// same `policies` table Configuration Policies already uses (category 'setting'), so no new
// table is needed. Missing row = enabled (matches freeLateAllowance's "default if missing" style).
function methodPolicyName(method) { return `${method} Enabled`; }

export function isMethodEnabled(method) {
  const row = db.prepare('SELECT value FROM policies WHERE name = ?').get(methodPolicyName(method));
  return row ? row.value !== '0' : true;
}

export function enabledMethods() {
  return METHODS.filter(isMethodEnabled);
}

export function setMethodEnabled(method, enabled) {
  if (!METHODS.includes(method)) throw new Error('Unknown check-in method');
  const name = methodPolicyName(method);
  const existing = db.prepare('SELECT id FROM policies WHERE name = ?').get(name);
  if (existing) db.prepare('UPDATE policies SET value = ? WHERE id = ?').run(enabled ? '1' : '0', existing.id);
  else db.prepare("INSERT INTO policies (category, name, value) VALUES ('setting', ?, ?)").run(name, enabled ? '1' : '0');
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

// "today"/"on <date>" — a live check-in/out is always for today, but a biometric punch can be
// mapped to an employee retroactively (see biometricPunch.js mapPunch), sometimes for an older
// date, so the message shouldn't always claim "today".
const whenPhrase = (date) => (date === today() ? 'today' : `on ${date}`);

// Fires right after a check-in is recorded — one-time, since check-in only ever happens once a
// day (the route already blocks a second one), so there's no risk of repeating this alert.
export function notifyIfLate(employeeId, attendanceRow) {
  if (attendanceRow.check_in_time && attendanceRow.check_in_time > LATE_AFTER) {
    notifyEmployee(employeeId, 'Late check-in', `You checked in late ${whenPhrase(attendanceRow.date)} at ${attendanceRow.check_in_time} (grace period ends ${LATE_AFTER}).`);
  }
}

// Same one-time-per-day guarantee as notifyIfLate — check-out only ever happens once (the route
// blocks a second one), so no repeat risk.
export function notifyIfEarlyLogout(employeeId, attendanceRow) {
  if (attendanceRow.check_out_time && attendanceRow.check_out_time < EARLY_BEFORE) {
    notifyEmployee(employeeId, 'Early logout', `You checked out early ${whenPhrase(attendanceRow.date)} at ${attendanceRow.check_out_time} (shift ends ${EARLY_BEFORE}).`);
  }
}

// Sweeps the employee's own recent attendance for two kinds of gaps — a check-in with no
// check-out, or a day marked Present with no check-in at all — and sends ONE notification per
// gap the first time it's seen (alert_sent then marks it so it never repeats). Safe to call from
// multiple places (GET /mine, check-in) since it's idempotent. Only looks at the last 14 days —
// older unresolved gaps are HR's problem via the monthly report, not something to keep nagging
// about indefinitely.
export function notifyAttendanceGaps(employeeId) {
  const cutoff = db.prepare("SELECT date('now', '-14 days') AS d").get().d;
  const gaps = db.prepare(`
    SELECT * FROM attendance
    WHERE employee_id = ? AND date >= ? AND date < ? AND alert_sent = 0
      AND ((check_in_time IS NOT NULL AND check_out_time IS NULL) OR (status = 'Present' AND check_in_time IS NULL))
  `).all(employeeId, cutoff, today());
  const markSent = db.prepare('UPDATE attendance SET alert_sent = 1 WHERE id = ?');
  gaps.forEach((g) => {
    if (g.check_in_time && !g.check_out_time) {
      notifyEmployee(employeeId, 'Missing check-out', `You checked in on ${g.date} but never checked out. Please submit a regularization request if that's correct.`);
    } else {
      notifyEmployee(employeeId, 'Missing check-in', `${g.date} is marked Present but has no check-in recorded. Please submit a regularization request if that's correct.`);
    }
    markSent.run(g.id);
  });
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

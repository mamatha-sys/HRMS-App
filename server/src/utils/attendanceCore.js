import db from '../db.js';
import { notifyEmployee } from './notify.js';

// Shared by attendance.routes.js (web/mobile check-in) and the biometric device receiver
// (integrations.routes.js), so a punch from a real fingerprint/face device is subject to the
// exact same late-arrival grace period and half-day-cut rules as a manual check-in.

// Explicitly Asia/Kolkata, not the server's own local clock — a cloud VM commonly defaults to
// UTC, which would silently shift every late-arrival/half-day/early-logout comparison below by
// whatever offset separates the server's OS timezone from IST (5:30h for UTC).
const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const nowTime = () => {
  const parts = IST_TIME_FORMAT.formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  return `${h}:${m}`;
};
export const today = () => db.prepare("SELECT date('now') AS d").get().d;

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const clamped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}
function addMinutes(hhmm, mins) { return minutesToTime(timeToMinutes(hhmm) + mins); }
function diffMinutes(fromHHMM, toHHMM) { return Math.max(0, timeToMinutes(toHHMM) - timeToMinutes(fromHHMM)); }

// Company default shift, used only when an employee has no real Shift & Roster assignment for
// the day (see effectiveShiftFor below) — 9:00 AM – 6:00 PM with a grace period until 9:15.
const DEFAULT_START = '09:00';
const LATE_GRACE_MINUTES = 15;
// Company rule: General shift is 9:00 AM – 6:00 PM with a grace period until 9:15.
export const LATE_AFTER = addMinutes(DEFAULT_START, LATE_GRACE_MINUTES);
// Checking out before shift end (6:00 PM) counts as an early logout.
export const EARLY_BEFORE = '18:00';

// The real shift in effect for this employee on this date (Shift & Roster's roster_assignments),
// falling back to the company default when there's no assignment — so late/early/overtime always
// reflect what this specific person was actually scheduled for, not one hardcoded window applied
// to everyone regardless of their real roster.
export function effectiveShiftFor(employeeId, date) {
  const assignment = db.prepare(`
    SELECT s.id AS shiftId, s.start_time AS startTime, s.end_time AS endTime
    FROM roster_assignments ra JOIN shifts s ON s.id = ra.shift_id
    WHERE ra.employee_id = ? AND ra.date = ? AND s.status = 'Active'
  `).get(employeeId, date);
  if (assignment) {
    return { shiftId: assignment.shiftId, startTime: assignment.startTime, endTime: assignment.endTime, lateAfter: addMinutes(assignment.startTime, LATE_GRACE_MINUTES) };
  }
  return { shiftId: null, startTime: DEFAULT_START, endTime: EARLY_BEFORE, lateAfter: LATE_AFTER };
}

// Derives working hours, late minutes (past the shift's own grace-adjusted start), early-logout
// minutes, and overtime minutes for one day, against whichever shift actually applied that day.
export function computeWorkStats(checkIn, checkOut, shift) {
  const late_minutes = checkIn && checkIn > shift.lateAfter ? diffMinutes(shift.lateAfter, checkIn) : 0;
  const early_logout_minutes = checkOut && checkOut < shift.endTime ? diffMinutes(checkOut, shift.endTime) : 0;
  const overtime_minutes = checkOut && checkOut > shift.endTime ? diffMinutes(shift.endTime, checkOut) : 0;
  const working_hours = checkIn && checkOut ? Math.round((diffMinutes(checkIn, checkOut) / 60) * 100) / 100 : null;
  return { working_hours, late_minutes, early_logout_minutes, overtime_minutes };
}
// Every real attendance method, in the order they're offered to an administrator. This is the
// admin-facing list — what Super Admin can enable/disable company-wide and assign per employee.
// It is NOT the employee's own check-in dropdown: 'Biometric (Fingerprint)' is deliberately
// filtered out of that (see SELF_CHECKIN_METHODS in attendance.routes.js and GET /methods),
// because nobody "selects" a fingerprint scan from a web dropdown — it's written directly by the
// hardware device receiver (biometricPunch.js). Web Check-in/Mobile App both additionally require
// a live face-verification capture before the check-in is accepted (see /check-in).
export const METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)'];

export function freeLateAllowance() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Free late arrivals per month'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// Company rule, the mirror of the late allowance: someone who came in ON TIME may leave early once
// a month without losing pay, provided they still stayed until at least 5:00 PM. Both numbers are
// ordinary `policies` rows, so Super Admin can retune them without a deploy.
export function freeEarlyLogoutAllowance() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Free early logouts per month'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

// The earliest a check-out can be and still count as an excusable early logout. Leaving before
// this is not "a bit early", it is most of an afternoon missing, and stays subject to the normal
// hours-worked rules.
export function earliestExcusableLogout() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Earliest excusable early logout'").get();
  return /^\d{2}:\d{2}$/.test(row?.value || '') ? row.value : '17:00';
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

// Per-employee narrowing of the company-enabled methods — Super Admin can restrict one specific
// employee (e.g. to Mobile App only) without affecting anyone else. Empty/no rows = this
// employee has no personal restriction, so they get every company-enabled method.
export function employeeCheckinMethods(employeeId) {
  return db.prepare('SELECT method FROM employee_checkin_methods WHERE employee_id = ?').all(employeeId).map((r) => r.method);
}

export function setEmployeeCheckinMethods(employeeId, methods) {
  const unknown = methods.find((m) => !METHODS.includes(m));
  if (unknown) throw new Error(`Unknown check-in method: ${unknown}`);
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM employee_checkin_methods WHERE employee_id = ?').run(employeeId);
    const insert = db.prepare('INSERT INTO employee_checkin_methods (employee_id, method) VALUES (?, ?)');
    list.forEach((m) => insert.run(employeeId, m));
  });
  tx(methods);
}

// The methods this specific employee may actually pick from: company-enabled methods, further
// narrowed to their personal assignment when Super Admin has set one.
export function effectiveMethodsFor(employeeId) {
  const assigned = employeeCheckinMethods(employeeId);
  const base = enabledMethods();
  return assigned.length ? base.filter((m) => assigned.includes(m)) : base;
}

// Recomputes half_day_flag for every late day this month for one employee, in date order,
// so the (allowance+1)-th late arrival onward is flagged for an automatic payroll deduction —
// resolving each day's real shift individually (see effectiveShiftFor), rather than one blanket
// company-wide threshold, and keeping working_hours/late_minutes/early_logout_minutes/
// overtime_minutes in sync on every row while it's already here. Re-run after every check-in
// (manual or biometric) so corrections (e.g. HR editing a time, a roster reassignment) stay
// consistent.
export function recomputeLateFlags(employeeId, month) {
  const allowance = freeLateAllowance();
  const earlyAllowance = freeEarlyLogoutAllowance();
  const earliestLogout = earliestExcusableLogout();
  const rows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date LIKE ? ORDER BY date').all(employeeId, month + '%');
  const update = db.prepare('UPDATE attendance SET half_day_flag = @half_day_flag, early_logout_excused = @early_logout_excused, shift_id = @shift_id, working_hours = @working_hours, late_minutes = @late_minutes, early_logout_minutes = @early_logout_minutes, overtime_minutes = @overtime_minutes WHERE id = @id');
  let lateCount = 0;
  let excusedEarlyCount = 0;
  rows.forEach((r) => {
    const shift = effectiveShiftFor(employeeId, r.date);
    const stats = computeWorkStats(r.check_in_time, r.check_out_time, shift);
    const isLate = stats.late_minutes > 0;
    if (isLate) lateCount++;
    // An early logout is excusable only when the employee also arrived on time — the concession is
    // for someone who put in their morning, not for someone who came late AND left early — and
    // only when they stayed past the earliest-excusable time. The first N such days in the month,
    // in date order, are excused; the rest fall through to the ordinary hours-worked rules.
    const leftEarly = stats.early_logout_minutes > 0;
    const qualifies = leftEarly && !isLate && r.check_out_time && r.check_out_time >= earliestLogout;
    if (qualifies) excusedEarlyCount++;
    update.run({
      id: r.id,
      shift_id: shift.shiftId,
      half_day_flag: isLate && lateCount > allowance ? 1 : 0,
      early_logout_excused: qualifies && excusedEarlyCount <= earlyAllowance ? 1 : 0,
      ...stats
    });
  });
}

// "today"/"on <date>" — a live check-in/out is always for today, but a biometric punch can be
// mapped to an employee retroactively (see biometricPunch.js mapPunch), sometimes for an older
// date, so the message shouldn't always claim "today".
const whenPhrase = (date) => (date === today() ? 'today' : `on ${date}`);

// Fires right after a check-in is recorded — one-time, since check-in only ever happens once a
// day (the route already blocks a second one), so there's no risk of repeating this alert.
// `shift` is optional so existing call sites that haven't been updated yet still work, falling
// back to the company default threshold.
export function notifyIfLate(employeeId, attendanceRow, shift) {
  const lateAfter = shift?.lateAfter ?? LATE_AFTER;
  if (attendanceRow.check_in_time && attendanceRow.check_in_time > lateAfter) {
    notifyEmployee(employeeId, 'Late check-in', `You checked in late ${whenPhrase(attendanceRow.date)} at ${attendanceRow.check_in_time} (grace period ends ${lateAfter}).`, { email: true });
  }
}

// Same one-time-per-day guarantee as notifyIfLate — check-out only ever happens once (the route
// blocks a second one), so no repeat risk.
export function notifyIfEarlyLogout(employeeId, attendanceRow, shift) {
  const endTime = shift?.endTime ?? EARLY_BEFORE;
  if (attendanceRow.check_out_time && attendanceRow.check_out_time < endTime) {
    notifyEmployee(employeeId, 'Early logout', `You checked out early ${whenPhrase(attendanceRow.date)} at ${attendanceRow.check_out_time} (shift ends ${endTime}).`, { email: true });
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
      notifyEmployee(employeeId, 'Missing check-out', `You checked in on ${g.date} but never checked out. Please submit a regularization request if that's correct.`, { email: true });
    } else {
      notifyEmployee(employeeId, 'Missing check-in', `${g.date} is marked Present but has no check-in recorded. Please submit a regularization request if that's correct.`, { email: true });
    }
    markSent.run(g.id);
  });
}

// This month's Present/Absent/Late/Half-day-cut/Missing-punch counts + attendance % for one
// employee — same formula as attendance.routes.js's own /mine and /monthly-report (present ÷
// days in month), pulled out here so Performance can report attendance alongside targets without
// duplicating the SQL. `month` defaults to the current month if omitted.
export function monthlyAttendanceSummary(employeeId, month) {
  const m = month || today().slice(0, 7);
  const daysInMonth = db.prepare("SELECT CAST(strftime('%d', date(? || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(m).d;
  const monthRows = db.prepare('SELECT status, check_in_time, half_day_flag, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(employeeId, m + '%');
  const present = monthRows.filter((r) => r.status === 'Present').length;
  return {
    month: m,
    present,
    absent: monthRows.filter((r) => r.status === 'Absent').length,
    late: monthRows.filter((r) => r.late_minutes > 0).length,
    halfDayCut: monthRows.filter((r) => r.half_day_flag).length,
    missingPunch: monthRows.filter((r) => r.status === 'Present' && !r.check_in_time).length,
    attendancePct: daysInMonth > 0 ? Math.round((present / daysInMonth) * 100) : 0
  };
}

export function upsertAttendanceForDate(employeeId, date, patch) {
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
  if (existing) {
    const merged = { ...existing, ...patch };
    db.prepare('UPDATE attendance SET status = @status, check_in_time = @check_in_time, check_out_time = @check_out_time, method = @method, latitude = @latitude, longitude = @longitude, shift_id = @shift_id, working_hours = @working_hours, late_minutes = @late_minutes, early_logout_minutes = @early_logout_minutes, overtime_minutes = @overtime_minutes WHERE id = @id').run(merged);
    return db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
  }
  const row = {
    employee_id: employeeId, date, status: 'Present', check_in_time: null, check_out_time: null, method: 'Web Check-in', latitude: null, longitude: null,
    shift_id: null, working_hours: null, late_minutes: 0, early_logout_minutes: 0, overtime_minutes: 0, ...patch
  };
  const info = db.prepare('INSERT INTO attendance (employee_id, date, status, check_in_time, check_out_time, method, latitude, longitude, shift_id, working_hours, late_minutes, early_logout_minutes, overtime_minutes) VALUES (@employee_id, @date, @status, @check_in_time, @check_out_time, @method, @latitude, @longitude, @shift_id, @working_hours, @late_minutes, @early_logout_minutes, @overtime_minutes)').run(row);
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(info.lastInsertRowid);
}

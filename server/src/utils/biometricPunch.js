import db from '../db.js';
import { upsertAttendanceForDate, recomputeLateFlags, notifyIfLate, notifyIfEarlyLogout, effectiveShiftFor, computeWorkStats } from './attendanceCore.js';

function normalizeBiometricId(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[-\s]/g, '');
}

// Exported (not just used internally) so biometricSync.js's "Sync Now" reconciliation can resolve
// a still-unmapped punch's employee the same way, without duplicating this lookup.
export function employeeForDeviceUser(deviceUserId) {
  const id = String(deviceUserId ?? '').trim();
  if (!id) return null;

  // 1) Use an explicit mapping when one already exists.
  const mapped = db
    .prepare('SELECT employee_id FROM employee_biometric_ids WHERE device_user_id = ?')
    .get(id);

  if (mapped?.employee_id) return mapped.employee_id;

  // 2) Fallback: automatically match the eSSL ID to employee_code,
  //    ignoring hyphens and spaces and treating case as equivalent.
  const normalized = normalizeBiometricId(id);
  if (!normalized) return null;

  const matches = db.prepare(`
    SELECT id, employee_code
    FROM employees
    WHERE status = 'Active'
      AND REPLACE(REPLACE(UPPER(employee_code), '-', ''), ' ', '') = ?
  `).all(normalized);

  // Only auto-map when there is exactly one unambiguous employee.
  if (matches.length !== 1) return null;

  const employeeId = matches[0].id;

  // If this device user ID is already assigned elsewhere, never overwrite it.
  const usedByOther = db
    .prepare('SELECT employee_id FROM employee_biometric_ids WHERE device_user_id = ?')
    .get(id);

  if (usedByOther?.employee_id && Number(usedByOther.employee_id) !== Number(employeeId)) {
    return null;
  }

  // If this employee already has a different mapping, keep the explicit
  // mapping rather than replacing it automatically.
  const employeeExisting = db
    .prepare('SELECT device_user_id FROM employee_biometric_ids WHERE employee_id = ?')
    .get(employeeId);

  if (employeeExisting?.device_user_id && employeeExisting.device_user_id !== id) {
    return null;
  }

  db.prepare(`
    INSERT INTO employee_biometric_ids (employee_id, device_user_id)
    VALUES (?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET
      device_user_id = excluded.device_user_id,
      mapped_at = datetime('now')
  `).run(employeeId, id);

  return employeeId;
}

function inferPunchType(statusCode) {
  if (statusCode === '0') return 'check-in';
  if (statusCode === '1') return 'check-out';
  return 'unknown';
}

function applyPunchToAttendance(employeeId, timestamp, punchType) {
  const date = timestamp.slice(0, 10);
  const time = timestamp.slice(11, 16);
  const method = 'Biometric (Fingerprint)';
  const shift = effectiveShiftFor(employeeId, date);
  if (punchType === 'check-out') {
    const existing = db.prepare('SELECT check_in_time FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
    const stats = computeWorkStats(existing?.check_in_time || null, time, shift);
    const row = upsertAttendanceForDate(employeeId, date, { check_out_time: time, method, shift_id: shift.shiftId, ...stats });
    notifyIfEarlyLogout(employeeId, row, shift);
  } else {
    // Real devices often send an ambiguous status for the first punch of the day — treat it as
    // check-in if there isn't one yet, otherwise as check-out. HR can correct a bad guess from
    // the Recent Punches screen (it never touches the raw punch log, only the derived attendance
    // row, so re-mapping/reprocessing is always safe).
    const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
    if (!existing?.check_in_time) {
      const stats = computeWorkStats(time, null, shift);
      const row = upsertAttendanceForDate(employeeId, date, { status: 'Present', check_in_time: time, method, shift_id: shift.shiftId, ...stats });
      notifyIfLate(employeeId, row, shift);
    } else if (!existing.check_out_time) {
      const stats = computeWorkStats(existing.check_in_time, time, shift);
      const row = upsertAttendanceForDate(employeeId, date, { check_out_time: time, shift_id: shift.shiftId, ...stats });
      notifyIfEarlyLogout(employeeId, row, shift);
    }
  }
  recomputeLateFlags(employeeId, date.slice(0, 7));
}

// Parses one raw ADMS/iClock attendance-log line — "<device_user_id>\t<timestamp>\t<status>\t..."
// — and applies it: the raw punch is always logged, and if the device_user_id is mapped to a
// real employee, today's attendance row is updated through the exact same upsert/late-flag
// logic as a manual web check-in, so a biometric punch is indistinguishable from one made
// through the app.
export function processPunchLine(deviceSerial, line) {
  const parts = line.split('\t').map((part) => part.trim());
  const [deviceUserId, timestamp, statusCode, verifyType] = parts;
  if (!deviceUserId || !timestamp) return null;
  const punchType = inferPunchType(statusCode);
  const employeeId = employeeForDeviceUser(deviceUserId);
  const info = db.prepare(`
    INSERT INTO biometric_punches (device_serial, device_user_id, employee_id, punch_time, punch_type, processed, raw_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(deviceSerial, deviceUserId, employeeId, timestamp, punchType, employeeId ? 1 : 0, line);
  if (employeeId) applyPunchToAttendance(employeeId, timestamp, punchType);
  return info.lastInsertRowid;
}

// HR manually maps a previously-unmapped punch to an employee, retroactively processing it.
export function mapPunch(punchId, employeeId) {
  const punch = db.prepare('SELECT * FROM biometric_punches WHERE id = ?').get(punchId);
  if (!punch) throw new Error('Punch not found');
  db.prepare('UPDATE biometric_punches SET employee_id = ?, processed = 1 WHERE id = ?').run(employeeId, punchId);
  applyPunchToAttendance(employeeId, punch.punch_time, punch.punch_type);
}

import db from '../db.js';
import { upsertAttendanceForDate, recomputeLateFlags, notifyIfLate, notifyIfEarlyLogout } from './attendanceCore.js';

function employeeForDeviceUser(deviceUserId) {
  return db.prepare('SELECT employee_id FROM employee_biometric_ids WHERE device_user_id = ?').get(deviceUserId)?.employee_id || null;
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
  if (punchType === 'check-out') {
    const row = upsertAttendanceForDate(employeeId, date, { check_out_time: time, method });
    notifyIfEarlyLogout(employeeId, row);
  } else {
    // Real devices often send an ambiguous status for the first punch of the day — treat it as
    // check-in if there isn't one yet, otherwise as check-out. HR can correct a bad guess from
    // the Recent Punches screen (it never touches the raw punch log, only the derived attendance
    // row, so re-mapping/reprocessing is always safe).
    const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date);
    if (!existing?.check_in_time) {
      const row = upsertAttendanceForDate(employeeId, date, { status: 'Present', check_in_time: time, method });
      notifyIfLate(employeeId, row);
    } else if (!existing.check_out_time) {
      const row = upsertAttendanceForDate(employeeId, date, { check_out_time: time });
      notifyIfEarlyLogout(employeeId, row);
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
  const parts = line.split('\t');
  const [deviceUserId, timestamp, statusCode] = parts;
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

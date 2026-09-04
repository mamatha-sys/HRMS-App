import db from '../db.js';
import {
  upsertAttendanceForDate,
  recomputeLateFlags,
  notifyIfLate,
  notifyIfEarlyLogout,
  effectiveShiftFor,
  computeWorkStats
} from './attendanceCore.js';

function normalizeBiometricId(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, '');
}

export function employeeForDeviceUser(deviceUserId) {
  const id = String(deviceUserId ?? '').trim();
  if (!id) return null;

  const mapped = db
    .prepare(
      'SELECT employee_id FROM employee_biometric_ids WHERE device_user_id = ?'
    )
    .get(id);

  if (mapped?.employee_id) return mapped.employee_id;

  const normalized = normalizeBiometricId(id);
  if (!normalized) return null;

  const matches = db
    .prepare(`
      SELECT id, employee_code
      FROM employees
      WHERE status='Active'
        AND REPLACE(REPLACE(UPPER(employee_code),'-',''),' ','') = ?
    `)
    .all(normalized);

  if (matches.length !== 1) return null;

  const employeeId = matches[0].id;

  const usedByOther = db
    .prepare(
      'SELECT employee_id FROM employee_biometric_ids WHERE device_user_id = ?'
    )
    .get(id);

  if (
    usedByOther?.employee_id &&
    Number(usedByOther.employee_id) !== Number(employeeId)
  ) {
    return null;
  }

  const employeeExisting = db
    .prepare(
      'SELECT device_user_id FROM employee_biometric_ids WHERE employee_id = ?'
    )
    .get(employeeId);

  if (
    employeeExisting?.device_user_id &&
    employeeExisting.device_user_id !== id
  ) {
    return null;
  }

  db.prepare(`
    INSERT INTO employee_biometric_ids (employee_id, device_user_id)
    VALUES (?,?)
    ON CONFLICT(employee_id) DO UPDATE SET
      device_user_id=excluded.device_user_id,
      mapped_at=datetime('now')
  `).run(employeeId, id);

  return employeeId;
}

function inferPunchType(statusCode) {
  const code = String(statusCode ?? '').trim();

  if (code === '0') return 'check-in';
  if (code === '1') return 'check-out';

  return 'unknown';
}

/*
 * IMPORTANT FIX
 *
 * eSSL X2008 can upload cached punches later.
 *
 * Example:
 *   Received 10:22 first
 *   Later uploads 09:58 and 09:59
 *
 * The old code sorted by punch_time and incorrectly changed attendance
 * to 09:58.
 *
 * We now rebuild attendance using the ORDER THE SERVER RECEIVED THE PUNCHES
 * (created_at, then id), which keeps the first valid received check-in.
 */
export function rebuildAttendanceFromPunches(employeeId, date) {
  const punches = db.prepare(`
    SELECT *
    FROM biometric_punches
    WHERE employee_id = ?
      AND substr(punch_time,1,10)=?
      AND punch_type IN ('check-in','check-out')
    ORDER BY datetime(created_at) ASC, id ASC
  `).all(employeeId, date);

  if (!punches.length) return null;

  const checkIns = punches.filter(p => p.punch_type === 'check-in');
  const checkOuts = punches.filter(p => p.punch_type === 'check-out');

  const firstCheckIn = checkIns.length
    ? checkIns[0].punch_time.slice(11,16)
    : null;

  const lastCheckOut = checkOuts.length
    ? checkOuts[checkOuts.length-1].punch_time.slice(11,16)
    : null;

  const shift = effectiveShiftFor(employeeId, date);

  const stats = computeWorkStats(
    firstCheckIn,
    lastCheckOut,
    shift
  );

  const row = upsertAttendanceForDate(
    employeeId,
    date,
    {
      status: firstCheckIn ? 'Present' : 'Absent',
      check_in_time: firstCheckIn,
      check_out_time: lastCheckOut,
      method: 'Biometric (Fingerprint)',
      shift_id: shift.shiftId,
      ...stats
    }
  );

  if (firstCheckIn) {
    notifyIfLate(employeeId, row, shift);
  }

  if (lastCheckOut) {
    notifyIfEarlyLogout(employeeId, row, shift);
  }

  recomputeLateFlags(employeeId, date.slice(0,7));

  return row;
}

export function processPunchLine(deviceSerial, line) {
  // X2008 sometimes sends tabs, sometimes multiple spaces.
  const parts = line.trim().split(/\s+/);

  const deviceUserId = parts[0];
  const datePart = parts[1];
  const timePart = parts[2];
  const statusCode = parts[3];

  if (!deviceUserId || !datePart || !timePart) {
    return null;
  }

  const timestamp = `${datePart} ${timePart}`;

  const punchType = inferPunchType(statusCode);
  const employeeId = employeeForDeviceUser(deviceUserId);

  const info = db.prepare(`
    INSERT INTO biometric_punches (
      device_serial,
      device_user_id,
      employee_id,
      punch_time,
      punch_type,
      processed,
      raw_line
    )
    VALUES (?,?,?,?,?,?,?)
  `).run(
    deviceSerial,
    deviceUserId,
    employeeId,
    timestamp,
    punchType,
    employeeId ? 1 : 0,
    line
  );

  if (employeeId && punchType !== 'unknown') {
    rebuildAttendanceFromPunches(
      employeeId,
      timestamp.slice(0,10)
    );
  }

  return info.lastInsertRowid;
}

export function mapPunch(punchId, employeeId) {
  const punch = db
    .prepare('SELECT * FROM biometric_punches WHERE id=?')
    .get(punchId);

  if (!punch) {
    throw new Error('Punch not found');
  }

  db.prepare(`
    UPDATE biometric_punches
    SET employee_id=?,
        processed=1
    WHERE id=?
  `).run(employeeId, punchId);

  rebuildAttendanceFromPunches(
    employeeId,
    punch.punch_time.slice(0,10)
  );
}
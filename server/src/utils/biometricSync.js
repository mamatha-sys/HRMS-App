import db from '../db.js';
import { employeeForDeviceUser, mapPunch } from './biometricPunch.js';

// Real eSSL/ADMS terminals only ever push punches to HRMS — there is no outbound pull protocol
// this app can use to fetch from the device on demand. So "Sync Now" (and the background sweep
// below) is honestly scoped to reconciliation: re-resolve any already-received punch that's still
// unmapped/unprocessed (e.g. because the employee mapping didn't exist yet when it arrived), not
// a live fetch from hardware.
export function runBiometricSync(deviceId, userId, triggerType) {
  const startedAt = new Date().toISOString();
  let scanned = 0, mapped = 0;
  try {
    const rows = deviceId
      ? db.prepare('SELECT * FROM biometric_punches WHERE device_serial = (SELECT serial_number FROM biometric_devices WHERE id = ?) AND (employee_id IS NULL OR processed = 0)').all(deviceId)
      : db.prepare('SELECT * FROM biometric_punches WHERE employee_id IS NULL OR processed = 0').all();
    scanned = rows.length;
    rows.forEach((r) => {
      const employeeId = r.employee_id || employeeForDeviceUser(r.device_user_id);
      if (employeeId) {
        mapPunch(r.id, employeeId);
        mapped++;
      }
    });
    const stillUnmapped = scanned - mapped;
    const status = stillUnmapped === 0 ? 'Success' : (mapped > 0 ? 'Partial' : (scanned > 0 ? 'Partial' : 'Success'));
    db.prepare(`
      INSERT INTO biometric_sync_log (device_id, triggered_by, trigger_type, punches_scanned, punches_mapped, punches_still_unmapped, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(deviceId || null, userId || null, triggerType || 'manual', scanned, mapped, stillUnmapped, status, startedAt);
    if (deviceId) db.prepare("UPDATE biometric_devices SET last_sync_at = datetime('now') WHERE id = ?").run(deviceId);
    else db.prepare("UPDATE biometric_devices SET last_sync_at = datetime('now')").run();
    return { scanned, mapped, stillUnmapped, status };
  } catch (err) {
    db.prepare(`
      INSERT INTO biometric_sync_log (device_id, triggered_by, trigger_type, punches_scanned, punches_mapped, punches_still_unmapped, status, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Failed', ?, ?, datetime('now'))
    `).run(deviceId || null, userId || null, triggerType || 'manual', scanned, mapped, scanned - mapped, err.message, startedAt);
    throw err;
  }
}

export function recentSyncHistory(limit = 30) {
  return db.prepare(`
    SELECT sl.*, bd.name AS device_name, u.name AS triggered_by_name
    FROM biometric_sync_log sl
    LEFT JOIN biometric_devices bd ON bd.id = sl.device_id
    LEFT JOIN users u ON u.id = sl.triggered_by
    ORDER BY sl.started_at DESC LIMIT ?
  `).all(limit);
}

export function logBiometricError(source, message, detail, deviceSerial) {
  db.prepare('INSERT INTO biometric_error_log (device_serial, source, message, detail) VALUES (?, ?, ?, ?)')
    .run(deviceSerial || null, source, message, detail || null);
}

export function recentErrorLog(limit = 30, source) {
  if (source) return db.prepare('SELECT * FROM biometric_error_log WHERE source = ? ORDER BY created_at DESC LIMIT ?').all(source, limit);
  return db.prepare('SELECT * FROM biometric_error_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Periodic reconciliation sweep across every device — the honest scope of "Automatic/Background
// Sync" for push-only hardware (see runBiometricSync's own comment). Guarded so it only ever
// starts once per server process, however many times index.js happens to call it.
let backgroundSyncStarted = false;
export function startBackgroundSync() {
  if (backgroundSyncStarted) return;
  backgroundSyncStarted = true;
  setInterval(() => {
    try { runBiometricSync(null, null, 'background'); } catch { /* logged inside runBiometricSync */ }
  }, 15 * 60 * 1000);
}

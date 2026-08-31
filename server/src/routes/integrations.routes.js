import { Router } from 'express';
import db from '../db.js';
import ExcelJS from 'exceljs';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { canModuleAdmin } from '../utils/rbac.js';
import { getSetting, getSettings, setSetting } from '../utils/integrationSettings.js';
import { notifyWebhooks, recentWebhookDeliveries } from '../utils/webhooks.js';
import { recentDeliveries, sendEmail } from '../utils/channels.js';
import { processPunchLine, mapPunch, employeeForDeviceUser } from '../utils/biometricPunch.js';
import { runBiometricSync, recentSyncHistory, logBiometricError, recentErrorLog } from '../utils/biometricSync.js';
import { logAudit, recentAuditLogs } from '../utils/auditLog.js';
import * as googleCalendar from '../utils/googleCalendar.js';
import { listJobBoards, connectJobBoard, disconnectJobBoard, addJobBoard, jobBoardKeys } from '../utils/jobBoards.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const isSuperAdmin = (role) => role === 'super_admin';
// Biometric Device Integration is its own dynamic RBAC module ('24') — device/IP/serial
// management is an infrastructure-config concern distinct from the rest of this file's
// hardcoded-HR_ROLES sub-features (channels, webhooks, calendar, etc.), so Super Admin can grant
// it independently via Manage Roles.
const isBiometricAdmin = (role) => canModuleAdmin(role, '24');
// A device hasn't been heard from (handshake or punch) in this long counts as Offline in the UI.
const DEVICE_STALE_MINUTES = 10;
function withOnlineStatus(devices) {
  return devices.map((d) => {
    const online = !!d.last_seen_at && (Date.now() - new Date(`${d.last_seen_at}Z`).getTime()) / 60000 < DEVICE_STALE_MINUTES;
    return { ...d, online };
  });
}

const KEY_FEATURES = [
  { key: 'channels', label: 'Email, SMS & WhatsApp', screen: 'channels' },
  { key: 'biometric', label: 'Biometric Device Integration (eSSL)', screen: 'biometric' },
  { key: 'webhooks', label: 'Slack & Microsoft Teams Alerts', screen: 'webhooks' },
  { key: 'calendar', label: 'Calendar Sync (Google)', screen: 'calendar' },
  { key: 'payroll-export', label: 'Payroll Bank-Transfer Export', screen: 'payroll-export' },
  { key: 'custom', label: 'Custom Integrations (Add Your Own)', screen: 'custom' },
  { key: 'branding', label: 'Company Branding (Logo & Name)', screen: 'branding' },
  { key: 'job-boards', label: 'Job Board Postings (Naukri, LinkedIn, Shine, Indeed)', screen: 'job-boards' }
];

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const deviceCount = db.prepare("SELECT COUNT(*) c FROM biometric_devices WHERE status = 'Active'").get().c;
  const customCount = db.prepare("SELECT COUNT(*) c FROM custom_integrations WHERE status = 'Active'").get().c;
  res.json({
    features: KEY_FEATURES,
    status: {
      email: !!process.env.EMAIL_SMTP_HOST,
      sms: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_SMS_FROM,
      whatsapp: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_WHATSAPP_FROM,
      biometricDevices: deviceCount,
      slack: !!getSetting('slack_webhook_url'),
      teams: !!getSetting('teams_webhook_url'),
      calendarConnected: googleCalendar.isConnected(),
      customIntegrations: customCount,
      jobBoardsConnected: listJobBoards().filter((b) => b.connected).length
    }
  });
});

// ---------- Email / SMS / WhatsApp ----------
// Credentials can come from either the DB (set via the form below, so any company running this
// app can self-configure their own provider through the UI — no server/.env access needed) or
// env vars (for existing deployments set up before this UI existed). `cfg` checks both, same
// precedence as channels.js itself.
const cfg = (dbKey, envKey) => getSetting(dbKey) || process.env[envKey];

router.get('/channels/status', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({
    email: { configured: !!cfg('email_smtp_host', 'EMAIL_SMTP_HOST') && !!cfg('email_smtp_user', 'EMAIL_SMTP_USER') && !!cfg('email_smtp_pass', 'EMAIL_SMTP_PASS') },
    sms: { configured: !!cfg('twilio_account_sid', 'TWILIO_ACCOUNT_SID') && !!cfg('twilio_sms_from', 'TWILIO_SMS_FROM') },
    whatsapp: { configured: !!cfg('twilio_account_sid', 'TWILIO_ACCOUNT_SID') && !!cfg('twilio_whatsapp_from', 'TWILIO_WHATSAPP_FROM') },
    recentDeliveries: recentDeliveries(20)
  });
});

// Field names in the DB-settings form. Secret fields are never sent back to the browser in GET —
// only whether one is currently set — so a saved password/token can't leak back out over the wire
// just by opening this screen; leaving a secret field blank on save keeps the existing value.
const CHANNEL_FIELDS = ['email_smtp_host', 'email_smtp_port', 'email_smtp_secure', 'email_smtp_user', 'email_smtp_pass', 'email_from', 'twilio_account_sid', 'twilio_auth_token', 'twilio_sms_from', 'twilio_whatsapp_from'];
const CHANNEL_SECRET_FIELDS = ['email_smtp_pass', 'twilio_auth_token'];

router.get('/channels/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const out = {};
  CHANNEL_FIELDS.forEach((f) => {
    const value = getSetting(f);
    out[f] = CHANNEL_SECRET_FIELDS.includes(f) ? '' : (value || '');
    if (CHANNEL_SECRET_FIELDS.includes(f)) out[`${f}_set`] = !!value;
  });
  res.json(out);
});

router.post('/channels/test-email', async (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  try {
    await sendEmail(req.body?.to, 'HRMS test email', 'This is a test email from your HRMS Integrations settings — if you received this, email delivery is working correctly.');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/channels/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  CHANNEL_FIELDS.forEach((f) => {
    if (req.body?.[f] === undefined) return;
    // Blank secret field = "leave the saved one alone", not "clear it" — otherwise every save
    // that doesn't re-type the password would silently wipe it out.
    if (CHANNEL_SECRET_FIELDS.includes(f) && !req.body[f]) return;
    setSetting(f, req.body[f]?.toString() ?? '');
  });
  res.json({ ok: true });
});

// ---------- Biometric Device Integration (eSSL / ADMS-iClock protocol) ----------
// Real hardware only ever pushes to HRMS (see biometricDevice.routes.js's unauthenticated
// receiver) — there is no outbound pull protocol this app can use. So "Test Connection" below is
// a plain TCP reachability check, not a protocol handshake, and "Sync Now"/background sync (see
// biometricSync.js) are reconciliation of already-received punches, never a live device fetch.
// That distinction is deliberately kept visible in the UI copy so it's never oversold.
const DEVICE_TYPES = ['Fingerprint', 'Face', 'Card', 'Fingerprint + Face'];

router.get('/biometric/devices', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ devices: withOnlineStatus(db.prepare('SELECT * FROM biometric_devices ORDER BY created_at DESC').all()) });
});

router.post('/biometric/devices', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, model, serial_number, ip_address, port, location, timezone, comm_mode, device_type, zone } = req.body || {};
  if (!name?.trim() || !serial_number?.trim()) return res.status(400).json({ error: 'Device name and serial number are required' });
  if (db.prepare('SELECT 1 FROM biometric_devices WHERE serial_number = ?').get(serial_number.trim())) {
    return res.status(400).json({ error: 'A device with this serial number is already registered' });
  }
  if (comm_mode && !['ADMS', 'HTTP', 'API'].includes(comm_mode)) return res.status(400).json({ error: 'Invalid communication mode' });
  if (device_type && !DEVICE_TYPES.includes(device_type)) return res.status(400).json({ error: 'Invalid device type' });
  const info = db.prepare(`
    INSERT INTO biometric_devices (name, vendor, serial_number, model, ip_address, port, location, timezone, comm_mode, device_type, zone)
    VALUES (?, 'eSSL', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), serial_number.trim(), model?.trim() || null, ip_address?.trim() || null, port ? Number(port) : null,
    location?.trim() || null, timezone?.trim() || 'Asia/Kolkata', comm_mode || 'ADMS', device_type || 'Fingerprint', zone?.trim() || null);
  logAudit(req.user.sub, 'device.create', 'biometric_device', info.lastInsertRowid, `Registered "${name.trim()}" (${serial_number.trim()})`);
  res.status(201).json({ device: db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(info.lastInsertRowid) });
});

// Status-only toggle (Enable/Disable) and a full field edit share this route — the body shape
// tells them apart: {status} alone vs. the full form.
router.put('/biometric/devices/:id', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const device = db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const { status, name, model, ip_address, port, location, timezone, comm_mode, device_type, zone } = req.body || {};
  if (status !== undefined && Object.keys(req.body).length === 1) {
    if (!['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'A valid status is required' });
    db.prepare('UPDATE biometric_devices SET status = ? WHERE id = ?').run(status, req.params.id);
    logAudit(req.user.sub, status === 'Active' ? 'device.enable' : 'device.disable', 'biometric_device', device.id, device.name);
    return res.json({ device: db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id) });
  }
  if (comm_mode && !['ADMS', 'HTTP', 'API'].includes(comm_mode)) return res.status(400).json({ error: 'Invalid communication mode' });
  if (device_type && !DEVICE_TYPES.includes(device_type)) return res.status(400).json({ error: 'Invalid device type' });
  db.prepare(`
    UPDATE biometric_devices SET
      name = COALESCE(?, name), model = COALESCE(?, model), ip_address = COALESCE(?, ip_address), port = COALESCE(?, port),
      location = COALESCE(?, location), timezone = COALESCE(?, timezone), comm_mode = COALESCE(?, comm_mode),
      device_type = COALESCE(?, device_type), zone = COALESCE(?, zone)
    WHERE id = ?
  `).run(name?.trim() || null, model?.trim() || null, ip_address?.trim() || null, port ? Number(port) : null,
    location?.trim() || null, timezone?.trim() || null, comm_mode || null, device_type || null, zone?.trim() || null, req.params.id);
  logAudit(req.user.sub, 'device.edit', 'biometric_device', device.id, device.name);
  res.json({ device: db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id) });
});

router.delete('/biometric/devices/:id', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const device = db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  logAudit(req.user.sub, 'device.delete', 'biometric_device', device.id, `${device.name} (${device.serial_number})`);
  db.prepare('DELETE FROM biometric_devices WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Honest scope: a plain TCP reachability check to the stored IP:port, not a protocol handshake —
// see the section-level comment above.
router.post('/biometric/devices/:id/test-connection', async (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const device = db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.ip_address || !device.port) {
    logAudit(req.user.sub, 'device.test_connection', 'biometric_device', device.id, 'No IP/port configured');
    return res.json({ reachable: false, caveat: 'No IP address/port configured for this device.' });
  }
  const net = await import('node:net');
  const reachable = await new Promise((resolve) => {
    const socket = net.createConnection({ host: device.ip_address, port: device.port, timeout: 3000 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
  logAudit(req.user.sub, 'device.test_connection', 'biometric_device', device.id, reachable ? 'Reachable' : 'Unreachable');
  res.json({ reachable, caveat: 'This only confirms the network address is reachable — it does not verify the eSSL/ADMS protocol itself, since this hardware only ever pushes data to HRMS, never accepts an inbound handshake from it.' });
});

router.post('/biometric/devices/:id/sync-now', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const device = db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  try {
    const result = runBiometricSync(device.id, req.user.sub, 'manual');
    logAudit(req.user.sub, 'device.sync_now', 'biometric_device', device.id, `Scanned ${result.scanned}, mapped ${result.mapped}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/biometric/mappings', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const mappings = db.prepare(`
    SELECT m.*, e.name AS employee_name, e.employee_code, bd.name AS device_name
    FROM employee_biometric_ids m JOIN employees e ON e.id = m.employee_id
    LEFT JOIN biometric_devices bd ON bd.id = m.device_id
    ORDER BY e.name
  `).all();
  const unmapped = db.prepare(`
    SELECT id, name, employee_code FROM employees
    WHERE id NOT IN (SELECT employee_id FROM employee_biometric_ids) AND status = 'Active'
    ORDER BY name
  `).all();
  // Distinct device_user_ids that have punched at least once but have no mapping row — the
  // mirror image of unmappedEmployees, so HR can see raw device activity waiting to be claimed.
  const unmappedBiometricUsers = db.prepare(`
    SELECT DISTINCT p.device_user_id, p.device_serial, bd.name AS device_name
    FROM biometric_punches p
    LEFT JOIN biometric_devices bd ON bd.serial_number = p.device_serial
    WHERE p.device_user_id NOT IN (SELECT device_user_id FROM employee_biometric_ids)
    ORDER BY p.device_user_id
  `).all();
  res.json({ mappings, unmappedEmployees: unmapped, unmappedBiometricUsers });
});

router.post('/biometric/mappings', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, device_user_id, device_id } = req.body || {};
  if (!employee_id || !device_user_id?.toString().trim()) return res.status(400).json({ error: 'Employee and device user ID are required' });
  if (db.prepare('SELECT 1 FROM employee_biometric_ids WHERE device_user_id = ?').get(device_user_id.toString().trim())) {
    return res.status(400).json({ error: 'That device user ID is already mapped to another employee' });
  }
  db.prepare(`
    INSERT INTO employee_biometric_ids (employee_id, device_user_id, device_id) VALUES (?, ?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET device_user_id = excluded.device_user_id, device_id = excluded.device_id, mapped_at = datetime('now')
  `).run(employee_id, device_user_id.toString().trim(), device_id || null);
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(employee_id);
  logAudit(req.user.sub, 'mapping.create', 'employee_biometric_id', employee_id, `${emp?.name || employee_id} → ${device_user_id}`);
  res.status(201).json({ ok: true });
});

router.delete('/biometric/mappings/:employeeId', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(req.params.employeeId);
  db.prepare('DELETE FROM employee_biometric_ids WHERE employee_id = ?').run(req.params.employeeId);
  logAudit(req.user.sub, 'mapping.delete', 'employee_biometric_id', req.params.employeeId, emp?.name || req.params.employeeId);
  res.json({ ok: true });
});

router.get('/biometric/punches', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const punches = db.prepare(`
    SELECT p.*, e.name AS employee_name
    FROM biometric_punches p LEFT JOIN employees e ON e.id = p.employee_id
    ORDER BY p.created_at DESC LIMIT 50
  `).all();
  res.json({ punches });
});

router.post('/biometric/punches/:id/map', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  try {
    mapPunch(req.params.id, employee_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Monitoring ----------
router.get('/biometric/sync-history', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ history: recentSyncHistory(30) });
});

router.get('/biometric/error-log', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ errors: recentErrorLog(30, req.query.source) });
});

router.get('/biometric/audit-log', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ logs: recentAuditLogs(50, { entityType: req.query.entityType }) });
});

// ---------- Export ----------
router.get('/biometric/mappings/export.csv', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT e.employee_code, e.name, m.device_user_id, bd.name AS device_name, m.mapped_at
    FROM employee_biometric_ids m JOIN employees e ON e.id = m.employee_id
    LEFT JOIN biometric_devices bd ON bd.id = m.device_id ORDER BY e.name
  `).all();
  const csv = ['code,name,device_user_id,device,mapped_at', ...rows.map((r) => `${r.employee_code},${r.name},${r.device_user_id},${r.device_name || ''},${r.mapped_at}`)].join('\n');
  logAudit(req.user.sub, 'export.mappings_csv', 'biometric', null, `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="biometric-mappings.csv"');
  res.send(csv);
});

router.get('/biometric/mappings/export.xlsx', async (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT e.employee_code, e.name, m.device_user_id, bd.name AS device_name, m.mapped_at
    FROM employee_biometric_ids m JOIN employees e ON e.id = m.employee_id
    LEFT JOIN biometric_devices bd ON bd.id = m.device_id ORDER BY e.name
  `).all();
  logAudit(req.user.sub, 'export.mappings_xlsx', 'biometric', null, `${rows.length} rows`);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Mappings');
  sheet.addRow(['code', 'name', 'device_user_id', 'device', 'mapped_at']).font = { bold: true };
  rows.forEach((r) => sheet.addRow([r.employee_code, r.name, r.device_user_id, r.device_name || '', r.mapped_at]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="biometric-mappings.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

router.get('/biometric/punches/export.csv', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT p.device_serial, p.device_user_id, e.name AS employee_name, p.punch_time, p.punch_type, p.processed
    FROM biometric_punches p LEFT JOIN employees e ON e.id = p.employee_id ORDER BY p.punch_time DESC LIMIT 1000
  `).all();
  const csv = ['device_serial,device_user_id,employee_name,punch_time,punch_type,processed', ...rows.map((r) => `${r.device_serial},${r.device_user_id},${r.employee_name || ''},${r.punch_time},${r.punch_type},${r.processed}`)].join('\n');
  logAudit(req.user.sub, 'export.punches_csv', 'biometric', null, `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="biometric-punches.csv"');
  res.send(csv);
});

router.get('/biometric/punches/export.xlsx', async (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT p.device_serial, p.device_user_id, e.name AS employee_name, p.punch_time, p.punch_type, p.processed
    FROM biometric_punches p LEFT JOIN employees e ON e.id = p.employee_id ORDER BY p.punch_time DESC LIMIT 1000
  `).all();
  logAudit(req.user.sub, 'export.punches_xlsx', 'biometric', null, `${rows.length} rows`);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Punches');
  sheet.addRow(['device_serial', 'device_user_id', 'employee_name', 'punch_time', 'punch_type', 'processed']).font = { bold: true };
  rows.forEach((r) => sheet.addRow([r.device_serial, r.device_user_id, r.employee_name || '', r.punch_time, r.punch_type, r.processed]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="biometric-punches.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Test tool: simulate a real device sending a punch, so the whole receive -> map -> attendance
// pipeline is verifiable without physical hardware on hand.
router.post('/biometric/simulate', (req, res) => {
  if (!isBiometricAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { device_serial, device_user_id, punch_type } = req.body || {};
  const device = db.prepare('SELECT * FROM biometric_devices WHERE serial_number = ?').get(device_serial);
  if (!device) return res.status(400).json({ error: 'Unknown device serial number' });
  const statusCode = punch_type === 'check-out' ? '1' : '0';
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `${device_user_id}\t${timestamp}\t${statusCode}\t1`;
  const punchId = processPunchLine(device.serial_number, line);
  if (!employeeForDeviceUser(device_user_id)) logBiometricError('simulate', `Unmapped device user "${device_user_id}"`, null, device.serial_number);
  res.status(201).json({ punch: db.prepare('SELECT * FROM biometric_punches WHERE id = ?').get(punchId) });
});

// ---------- Slack / Microsoft Teams Alerts ----------
router.get('/webhooks/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(getSettings(['slack_webhook_url', 'teams_webhook_url']));
});

router.put('/webhooks/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { slack_webhook_url, teams_webhook_url } = req.body || {};
  if (slack_webhook_url !== undefined) setSetting('slack_webhook_url', slack_webhook_url || '');
  if (teams_webhook_url !== undefined) setSetting('teams_webhook_url', teams_webhook_url || '');
  res.json({ ok: true });
});

router.post('/webhooks/test', async (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  await notifyWebhooks('Test message', `Sent from HRMS Integrations by ${req.user.name || 'Super Admin'} to confirm this webhook works.`);
  res.json({ ok: true });
});

router.get('/webhooks/log', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ deliveries: recentWebhookDeliveries(30) });
});

// ---------- Calendar Sync (Google) ----------
router.get('/calendar/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { google_client_id } = getSettings(['google_client_id']);
  res.json({
    google_client_id: google_client_id || '',
    hasSecret: !!getSetting('google_client_secret'),
    connected: googleCalendar.isConnected(),
    connectedEmail: getSetting('google_connected_email') || null
  });
});

router.put('/calendar/settings', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { google_client_id, google_client_secret } = req.body || {};
  if (google_client_id !== undefined) setSetting('google_client_id', google_client_id || '');
  if (google_client_secret) setSetting('google_client_secret', google_client_secret);
  res.json({ ok: true });
});

router.get('/calendar/connect', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  try {
    res.json({ url: googleCalendar.getAuthUrl() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Google redirects the browser here after consent — no JWT is available on this hop, so it
// isn't gated by requireAuth-style role checks; it only ever runs the OAuth code exchange.
router.get('/calendar/callback', async (req, res) => {
  try {
    const email = await googleCalendar.handleCallback(req.query.code);
    res.send(`<html><body style="font-family:sans-serif;padding:40px"><h2>Google Calendar connected (${email})</h2><p>You can close this tab and return to HRMS.</p></body></html>`);
  } catch (err) {
    res.status(400).send(`<html><body style="font-family:sans-serif;padding:40px"><h2>Could not connect Google Calendar</h2><p>${err.message}</p></body></html>`);
  }
});

// ---------- Payroll Bank-Transfer Export ----------
router.get('/payroll-export/periods', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const periods = db.prepare("SELECT DISTINCT period FROM payroll_runs WHERE status = 'Completed' ORDER BY period DESC").all().map((r) => r.period);
  res.json({ periods });
});

router.get('/payroll-export/:period', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const period = decodeURIComponent(req.params.period);
  const rows = db.prepare(`
    SELECT e.employee_code, e.name, e.bank_name, e.bank_account_number, e.ifsc_code, p.net
    FROM payslips p JOIN employees e ON e.id = p.employee_id
    WHERE p.period = ?
    ORDER BY e.name
  `).all(period);
  if (!rows.length) return res.status(404).json({ error: `No payslips found for period "${period}"` });
  const missingBank = rows.filter((r) => !r.bank_account_number || !r.ifsc_code);
  const csv = [
    'employee_code,name,bank_name,account_number,ifsc_code,amount,narration',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.bank_name || ''},${r.bank_account_number || ''},${r.ifsc_code || ''},${r.net},SALARY ${period.toUpperCase()}`)
  ].join('\n');
  res.setHeader('X-Missing-Bank-Details', String(missingBank.length));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="salary-transfer-${period.replace(/\s+/g, '-')}.csv"`);
  res.send(csv);
});

// ---------- Custom Integrations (Super Admin adds their own, beyond the 5 built-in ones) ----------
router.get('/custom', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ integrations: db.prepare('SELECT * FROM custom_integrations ORDER BY created_at DESC').all() });
});

router.post('/custom', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, description, logo, url } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (db.prepare('SELECT 1 FROM custom_integrations WHERE name = ?').get(name.trim())) {
    return res.status(409).json({ error: 'An integration with this name already exists' });
  }
  const info = db.prepare('INSERT INTO custom_integrations (name, description, logo, url, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), description?.trim() || null, logo || null, url?.trim() || null, req.user.sub);
  res.status(201).json({ integration: db.prepare('SELECT * FROM custom_integrations WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/custom/:id', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const existing = db.prepare('SELECT * FROM custom_integrations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Integration not found' });
  const { name, description, logo, url, status } = req.body || {};
  db.prepare(`
    UPDATE custom_integrations SET
      name = COALESCE(?, name), description = COALESCE(?, description),
      logo = COALESCE(?, logo), url = COALESCE(?, url),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(
    name?.trim() || null, description !== undefined ? description.trim() : null,
    logo !== undefined ? logo : null, url !== undefined ? url.trim() : null,
    ['Active', 'Paused'].includes(status) ? status : null, req.params.id
  );
  res.json({ integration: db.prepare('SELECT * FROM custom_integrations WHERE id = ?').get(req.params.id) });
});

// ---------- Job Board Postings (Naukri/LinkedIn/Shine/Indeed) ----------
// Which boards Super Admin has connected — read by anyone who can see Manage Posting
// (Recruitment's checkboxes need to know which to grey out), changed by Super Admin only.
router.get('/job-boards', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ boards: listJobBoards() });
});

// Connect (real employer API key / account ID required) or disconnect (empty credential) a board
// — same "real config, not a bare flag" pattern as Calendar Sync / Webhooks in this file.
router.put('/job-boards/:key', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!jobBoardKeys().includes(req.params.key)) return res.status(404).json({ error: 'Unknown job board' });
  try {
    const credential = (req.body?.credential || '').trim();
    if (credential) connectJobBoard(req.params.key, credential);
    else disconnectJobBoard(req.params.key);
    res.json({ boards: listJobBoards() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Super Admin can extend the catalog beyond the 4 built-ins (e.g. a regional/niche portal) —
// added boards start connected since they were added specifically to be used.
router.post('/job-boards', (req, res) => {
  if (!isSuperAdmin(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  try {
    addJobBoard(req.body?.label);
    res.status(201).json({ boards: listJobBoards() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Company Branding (logo + name) is served by branding.routes.js at /api/branding — its GET
// is intentionally public (the Login page needs it pre-auth), so the Integrations screen's
// "Company Branding" tile reads/writes that same endpoint rather than duplicating it here.

export default router;

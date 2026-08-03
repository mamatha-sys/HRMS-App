import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { getSetting, getSettings, setSetting } from '../utils/integrationSettings.js';
import { notifyWebhooks, recentWebhookDeliveries } from '../utils/webhooks.js';
import { recentDeliveries } from '../utils/channels.js';
import { processPunchLine, mapPunch } from '../utils/biometricPunch.js';
import * as googleCalendar from '../utils/googleCalendar.js';
import { listJobBoards, connectJobBoard, disconnectJobBoard, addJobBoard, jobBoardKeys } from '../utils/jobBoards.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const isSuperAdmin = (role) => role === 'super_admin';

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

// ---------- Email / SMS / WhatsApp (already live — this is a read-only status view) ----------
router.get('/channels/status', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({
    email: { configured: !!process.env.EMAIL_SMTP_HOST, envVars: ['EMAIL_SMTP_HOST', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASS', 'EMAIL_FROM'] },
    sms: { configured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_SMS_FROM, envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM'] },
    whatsapp: { configured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_WHATSAPP_FROM, envVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'] },
    recentDeliveries: recentDeliveries(20)
  });
});

// ---------- Biometric Device Integration (eSSL / ADMS-iClock protocol) ----------
router.get('/biometric/devices', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ devices: db.prepare('SELECT * FROM biometric_devices ORDER BY created_at DESC').all() });
});

router.post('/biometric/devices', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, serial_number, location } = req.body || {};
  if (!name?.trim() || !serial_number?.trim()) return res.status(400).json({ error: 'Device name and serial number are required' });
  if (db.prepare('SELECT 1 FROM biometric_devices WHERE serial_number = ?').get(serial_number.trim())) {
    return res.status(400).json({ error: 'A device with this serial number is already registered' });
  }
  const info = db.prepare("INSERT INTO biometric_devices (name, vendor, serial_number, location) VALUES (?, 'eSSL', ?, ?)")
    .run(name.trim(), serial_number.trim(), location?.trim() || null);
  res.status(201).json({ device: db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/biometric/devices/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { status } = req.body || {};
  if (!['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  db.prepare('UPDATE biometric_devices SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ device: db.prepare('SELECT * FROM biometric_devices WHERE id = ?').get(req.params.id) });
});

router.get('/biometric/mappings', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const mappings = db.prepare(`
    SELECT m.*, e.name AS employee_name, e.employee_code
    FROM employee_biometric_ids m JOIN employees e ON e.id = m.employee_id
    ORDER BY e.name
  `).all();
  const unmapped = db.prepare(`
    SELECT id, name, employee_code FROM employees
    WHERE id NOT IN (SELECT employee_id FROM employee_biometric_ids) AND status = 'Active'
    ORDER BY name
  `).all();
  res.json({ mappings, unmappedEmployees: unmapped });
});

router.post('/biometric/mappings', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, device_user_id } = req.body || {};
  if (!employee_id || !device_user_id?.toString().trim()) return res.status(400).json({ error: 'Employee and device user ID are required' });
  if (db.prepare('SELECT 1 FROM employee_biometric_ids WHERE device_user_id = ?').get(device_user_id.toString().trim())) {
    return res.status(400).json({ error: 'That device user ID is already mapped to another employee' });
  }
  db.prepare(`
    INSERT INTO employee_biometric_ids (employee_id, device_user_id) VALUES (?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET device_user_id = excluded.device_user_id, mapped_at = datetime('now')
  `).run(employee_id, device_user_id.toString().trim());
  res.status(201).json({ ok: true });
});

router.delete('/biometric/mappings/:employeeId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM employee_biometric_ids WHERE employee_id = ?').run(req.params.employeeId);
  res.json({ ok: true });
});

router.get('/biometric/punches', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const punches = db.prepare(`
    SELECT p.*, e.name AS employee_name
    FROM biometric_punches p LEFT JOIN employees e ON e.id = p.employee_id
    ORDER BY p.created_at DESC LIMIT 50
  `).all();
  res.json({ punches });
});

router.post('/biometric/punches/:id/map', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id } = req.body || {};
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  try {
    mapPunch(req.params.id, employee_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test tool: simulate a real device sending a punch, so the whole receive -> map -> attendance
// pipeline is verifiable without physical hardware on hand.
router.post('/biometric/simulate', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { device_serial, device_user_id, punch_type } = req.body || {};
  const device = db.prepare('SELECT * FROM biometric_devices WHERE serial_number = ?').get(device_serial);
  if (!device) return res.status(400).json({ error: 'Unknown device serial number' });
  const statusCode = punch_type === 'check-out' ? '1' : '0';
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `${device_user_id}\t${timestamp}\t${statusCode}\t1`;
  const punchId = processPunchLine(device.serial_number, line);
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

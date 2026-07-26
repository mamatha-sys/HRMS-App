import { Router } from 'express';
import express from 'express';
import db from '../db.js';
import { processPunchLine } from '../utils/biometricPunch.js';

// Real fingerprint/face terminals (eSSL and other ADMS/iClock-protocol-compatible hardware)
// call this endpoint directly over the network — they cannot send a JWT, so this router is
// intentionally mounted without requireAuth. The gate instead is device pre-registration: only
// a serial number already added under Integrations > Biometric Device is accepted.
const router = Router();
router.use(express.text({ type: '*/*' }));

function knownDevice(serial) {
  if (!serial) return null;
  return db.prepare("SELECT * FROM biometric_devices WHERE serial_number = ? AND status = 'Active'").get(serial);
}

function touch(deviceId) {
  db.prepare("UPDATE biometric_devices SET last_seen_at = datetime('now') WHERE id = ?").run(deviceId);
}

// Device handshake/registration ping (sent periodically by real ADMS terminals to fetch
// server-side options). We don't push remote config today, so a plain OK is enough to satisfy
// the device and stop it retrying.
router.get('/cdata', (req, res) => {
  const device = knownDevice(req.query.SN);
  if (!device) return res.status(403).type('text/plain').send('Unregistered device serial number');
  touch(device.id);
  res.type('text/plain').send('OK');
});

// Real attendance-log push: body is tab-separated lines, one punch per line —
// "<device_user_id>\t<timestamp>\t<status>\t<verify_type>\t...".
router.post('/cdata', (req, res) => {
  const device = knownDevice(req.query.SN);
  if (!device) return res.status(403).type('text/plain').send('Unregistered device serial number');
  touch(device.id);
  const body = typeof req.body === 'string' ? req.body : '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  lines.forEach((line) => processPunchLine(device.serial_number, line));
  res.type('text/plain').send(`OK:${lines.length}`);
});

export default router;

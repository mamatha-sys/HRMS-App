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
  if (!device) {
    return res.status(403)
      .type('text/plain')
      .send('Unregistered device serial number');
  }

  touch(device.id);

  // iClock/ADMS handshake. Realtime=1 asks the terminal to push
  // attendance transactions as they occur. The terminal will then
  // POST ATTLOG data back to /iclock/cdata.aspx.
  const serial = device.serial_number;
  const response = [
    `GET OPTION FROM: ${serial}`,
    'STAMP=0',
    'ATTLOGSTAMP=0',
    'OPERLOGStamp=0',
    'ATTPHOTOStamp=0',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;23:59',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'TimeZone=5.5',
    'Realtime=1',
    'Encrypt=None',
    ''
  ].join('\r\n');

  res
    .status(200)
    .set('Content-Type', 'text/plain')
    .set('Connection', 'close')
    .send(response);
});

// iClock command polling endpoint.
// The X2008 periodically asks for pending server commands.
// HRMS currently has no outbound device commands, so return OK.
router.get('/getrequest', (req, res) => {
  const device = knownDevice(req.query.SN);
  if (!device) {
    return res.status(403)
      .type('text/plain')
      .send('Unregistered device serial number');
  }

  touch(device.id);
  res
    .status(200)
    .type('text/plain')
    .send('OK');
});

// Real attendance-log push: body is tab-separated lines, one punch per line —
// "<device_user_id>\t<timestamp>\t<status>\t<verify_type>\t...".
router.post('/cdata', (req, res) => {
  const device = knownDevice(req.query.SN);
  if (!device) {
    return res.status(403)
      .type('text/plain')
      .send('Unregistered device serial number');
  }

  touch(device.id);

  // Only ATTLOG contains attendance transactions.
  // Ignore OPLOG and other iClock tables so operational logs
  // can never become employee attendance punches.
  const table = String(req.query.table || '').toUpperCase();

  if (table !== 'ATTLOG') {
    return res
      .status(200)
      .type('text/plain')
      .send('OK');
  }

  const body = typeof req.body === 'string' ? req.body : '';
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let processed = 0;

  for (const line of lines) {
    const punchId = processPunchLine(device.serial_number, line);
    if (punchId !== null) processed++;
  }

  res
    .status(200)
    .type('text/plain')
    .send(`OK:${processed}`);
});

export default router;

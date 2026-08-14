import nodemailer from 'nodemailer';
import twilio from 'twilio';
import db from '../db.js';
import { getSetting } from './integrationSettings.js';

// Real Email/SMS/WhatsApp delivery. Credentials come from the `integration_settings` table first
// (so any company running this app can self-configure their own provider through Integrations →
// Email, SMS & WhatsApp — no developer/server access needed), falling back to env vars for
// existing deployments that were set up before that UI existed. Every send attempt (success or
// failure) is logged to channel_deliveries so HR can see exactly what went out and why something
// failed (e.g. a provider simply isn't configured yet).
//
// No client caching here on purpose — settings can change at runtime via the UI, and a cached
// transport/client from before a save would silently keep using stale credentials.

function emailConfig() {
  return {
    host: getSetting('email_smtp_host') || process.env.EMAIL_SMTP_HOST,
    port: getSetting('email_smtp_port') || process.env.EMAIL_SMTP_PORT,
    secure: getSetting('email_smtp_secure') ?? process.env.EMAIL_SMTP_SECURE,
    user: getSetting('email_smtp_user') || process.env.EMAIL_SMTP_USER,
    pass: getSetting('email_smtp_pass') || process.env.EMAIL_SMTP_PASS,
    from: getSetting('email_from') || process.env.EMAIL_FROM
  };
}

function twilioConfig() {
  return {
    sid: getSetting('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID,
    token: getSetting('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN,
    smsFrom: getSetting('twilio_sms_from') || process.env.TWILIO_SMS_FROM,
    whatsappFrom: getSetting('twilio_whatsapp_from') || process.env.TWILIO_WHATSAPP_FROM
  };
}

function getMailTransport() {
  const cfg = emailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: String(cfg.secure).toLowerCase() === 'true',
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

function getTwilioClient() {
  const cfg = twilioConfig();
  if (!cfg.sid || !cfg.token) return null;
  return twilio(cfg.sid, cfg.token);
}

export async function sendEmail(to, subject, message) {
  const transport = getMailTransport();
  if (!transport) throw new Error('Email is not configured — set it up under Integrations → Email, SMS & WhatsApp');
  if (!to) throw new Error('This employee has no email on file');
  const cfg = emailConfig();
  await transport.sendMail({ from: cfg.from || cfg.user, to, subject, text: message });
}

export async function sendSms(to, title, message) {
  const client = getTwilioClient();
  if (!client) throw new Error('SMS is not configured — set it up under Integrations → Email, SMS & WhatsApp');
  const cfg = twilioConfig();
  if (!cfg.smsFrom) throw new Error('SMS sender number is not set — configure it under Integrations → Email, SMS & WhatsApp');
  if (!to) throw new Error('This employee has no phone number on file');
  await client.messages.create({ from: cfg.smsFrom, to, body: `${title}: ${message}` });
}

export async function sendWhatsapp(to, title, message) {
  const client = getTwilioClient();
  if (!client) throw new Error('WhatsApp is not configured — set it up under Integrations → Email, SMS & WhatsApp');
  const cfg = twilioConfig();
  if (!cfg.whatsappFrom) throw new Error('WhatsApp sender number is not set — configure it under Integrations → Email, SMS & WhatsApp');
  if (!to) throw new Error('This employee has no phone number on file');
  await client.messages.create({ from: `whatsapp:${cfg.whatsappFrom}`, to: `whatsapp:${to}`, body: `${title}: ${message}` });
}

const SENDERS = { email: sendEmail, sms: sendSms, whatsapp: sendWhatsapp };

function logDelivery(source, sourceId, employeeId, channel, target, title, status, error) {
  db.prepare(`
    INSERT INTO channel_deliveries (source, source_id, employee_id, channel, target, title, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, sourceId, employeeId, channel, target || null, title, status, error || null);
}

// Fan a title/message out to every requested external channel, for every given employee.
// `channels` is an array subset of ['email','sms','whatsapp'] ('in_app' is handled separately,
// via the notifications table itself). Never throws — every failure is caught and logged so one
// bad phone number or a missing provider never blocks the rest of the send.
export async function dispatchChannels({ source, sourceId, employees, channels, title, message }) {
  const wanted = (channels || []).filter((c) => SENDERS[c]);
  if (!wanted.length) return;
  for (const emp of employees) {
    for (const channel of wanted) {
      const target = channel === 'email' ? emp.email : emp.phone;
      try {
        await SENDERS[channel](target, title, message);
        logDelivery(source, sourceId, emp.id, channel, target, title, 'Sent', null);
      } catch (err) {
        logDelivery(source, sourceId, emp.id, channel, target, title, 'Failed', err.message);
      }
    }
  }
}

export function recentDeliveries(limit = 30) {
  return db.prepare(`
    SELECT cd.*, e.name AS employee_name
    FROM channel_deliveries cd LEFT JOIN employees e ON e.id = cd.employee_id
    ORDER BY cd.created_at DESC LIMIT ?
  `).all(limit);
}

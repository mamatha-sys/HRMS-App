import nodemailer from 'nodemailer';
import twilio from 'twilio';
import db from '../db.js';

// Real Email/SMS/WhatsApp delivery, driven entirely by env vars — see server/.env.example.
// Every send attempt (success or failure) is logged to channel_deliveries so HR can see exactly
// what went out, to whom, and why something failed (e.g. a provider simply isn't configured yet).

let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  const { EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER, EMAIL_SMTP_PASS } = process.env;
  if (!EMAIL_SMTP_HOST || !EMAIL_SMTP_USER || !EMAIL_SMTP_PASS) return null;
  mailTransport = nodemailer.createTransport({
    host: EMAIL_SMTP_HOST,
    port: Number(EMAIL_SMTP_PORT) || 587,
    secure: String(process.env.EMAIL_SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: EMAIL_SMTP_USER, pass: EMAIL_SMTP_PASS }
  });
  return mailTransport;
}

let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return twilioClient;
}

export async function sendEmail(to, subject, message) {
  const transport = getMailTransport();
  if (!transport) throw new Error('Email is not configured — set EMAIL_SMTP_HOST/USER/PASS in server/.env');
  if (!to) throw new Error('This employee has no email on file');
  await transport.sendMail({ from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER, to, subject, text: message });
}

export async function sendSms(to, title, message) {
  const client = getTwilioClient();
  if (!client) throw new Error('SMS is not configured — set TWILIO_ACCOUNT_SID/AUTH_TOKEN/SMS_FROM in server/.env');
  if (!process.env.TWILIO_SMS_FROM) throw new Error('TWILIO_SMS_FROM is not set in server/.env');
  if (!to) throw new Error('This employee has no phone number on file');
  await client.messages.create({ from: process.env.TWILIO_SMS_FROM, to, body: `${title}: ${message}` });
}

async function sendWhatsapp(to, title, message) {
  const client = getTwilioClient();
  if (!client) throw new Error('WhatsApp is not configured — set TWILIO_ACCOUNT_SID/AUTH_TOKEN/WHATSAPP_FROM in server/.env');
  if (!process.env.TWILIO_WHATSAPP_FROM) throw new Error('TWILIO_WHATSAPP_FROM is not set in server/.env');
  if (!to) throw new Error('This employee has no phone number on file');
  await client.messages.create({ from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`, to: `whatsapp:${to}`, body: `${title}: ${message}` });
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

import db from '../db.js';
import { getSetting } from './integrationSettings.js';

function logDelivery(target, event, message, status, error) {
  db.prepare('INSERT INTO webhook_deliveries (target, event, message, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(target, event, message, status, error || null);
}

async function postWebhook(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Webhook responded ${res.status} ${res.statusText}`);
}

// Mirrors a real HRMS event (new ticket, new announcement, etc.) into Slack and/or Microsoft
// Teams, if a webhook URL has been configured for that channel. Never throws — a bad URL or an
// unconfigured channel is logged and swallowed so it can never break the action that triggered it.
export async function notifyWebhooks(event, message) {
  const slackUrl = getSetting('slack_webhook_url');
  const teamsUrl = getSetting('teams_webhook_url');
  if (slackUrl) {
    try { await postWebhook(slackUrl, { text: `*${event}*\n${message}` }); logDelivery('slack', event, message, 'Sent', null); }
    catch (err) { logDelivery('slack', event, message, 'Failed', err.message); }
  }
  if (teamsUrl) {
    try { await postWebhook(teamsUrl, { text: `**${event}**\n\n${message}` }); logDelivery('teams', event, message, 'Sent', null); }
    catch (err) { logDelivery('teams', event, message, 'Failed', err.message); }
  }
}

export function recentWebhookDeliveries(limit = 30) {
  return db.prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?').all(limit);
}

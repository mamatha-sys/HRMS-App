import { google } from 'googleapis';
import { getSetting, getSettings, setSetting } from './integrationSettings.js';

const REDIRECT_PATH = '/api/integrations/calendar/callback';

function redirectUri() {
  // The exact URI registered in the Google Cloud OAuth client must match this. Defaults to the
  // dev server's own address; override with GOOGLE_REDIRECT_BASE in server/.env if the API is
  // reachable at a different origin (e.g. behind a tunnel/proxy).
  const base = process.env.GOOGLE_REDIRECT_BASE || `http://localhost:${process.env.PORT || 4000}`;
  return base + REDIRECT_PATH;
}

function oauthClient() {
  const { google_client_id, google_client_secret } = getSettings(['google_client_id', 'google_client_secret']);
  if (!google_client_id || !google_client_secret) return null;
  return new google.auth.OAuth2(google_client_id, google_client_secret, redirectUri());
}

export function isConfigured() {
  return !!oauthClient();
}

export function isConnected() {
  return isConfigured() && !!getSetting('google_refresh_token');
}

export function getAuthUrl() {
  const client = oauthClient();
  if (!client) throw new Error('Google Client ID/Secret are not configured yet.');
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/userinfo.email']
  });
}

export async function handleCallback(code) {
  const client = oauthClient();
  if (!client) throw new Error('Google Client ID/Secret are not configured yet.');
  const { tokens } = await client.getToken(code);
  if (tokens.refresh_token) setSetting('google_refresh_token', tokens.refresh_token);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  setSetting('google_connected_email', data.email || '');
  return data.email;
}

function authedClient() {
  const client = oauthClient();
  const refreshToken = getSetting('google_refresh_token');
  if (!client || !refreshToken) throw new Error('Google Calendar is not connected — configure and connect it from Integrations first.');
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Creates a real Google Calendar event and returns its event ID (stored so re-saving a
// training session never creates a duplicate). `startsAt` is any parseable date/time string.
export async function createCalendarEvent({ summary, description, startsAt, durationMinutes = 60 }) {
  const auth = authedClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary, description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    }
  });
  return data.id;
}

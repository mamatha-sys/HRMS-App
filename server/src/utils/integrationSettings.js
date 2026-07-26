import db from '../db.js';

export function getSetting(key) {
  return db.prepare('SELECT value FROM integration_settings WHERE key = ?').get(key)?.value ?? null;
}

export function getSettings(keys) {
  const out = {};
  keys.forEach((k) => { out[k] = getSetting(k); });
  return out;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO integration_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

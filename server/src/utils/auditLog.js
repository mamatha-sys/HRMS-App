import db from '../db.js';

// Generic audit trail — device actions, mapping changes, sync runs, and exports all log here
// (see migrateBiometricIntegration in db.js for the table). Deliberately generic, not
// biometric-only, so it's reusable later, even though only biometric routes write to it today.
export function logAudit(userId, action, entityType, entityId, detail) {
  db.prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(userId || null, action, entityType || null, entityId != null ? String(entityId) : null, detail || null);
}

export function recentAuditLogs(limit = 50, filters = {}) {
  const conditions = [];
  const params = [];
  if (filters.action) { conditions.push('action = ?'); params.push(filters.action); }
  if (filters.entityType) { conditions.push('entity_type = ?'); params.push(filters.entityType); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT al.*, u.name AS user_name
    FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    ${where}
    ORDER BY al.created_at DESC LIMIT ?
  `).all(...params, limit);
}

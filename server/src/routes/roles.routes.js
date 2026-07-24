import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin'));

export const ACTIONS = ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage'];

// Role catalog
router.get('/', (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY sort_order, id').all();
  const withCounts = roles.map((r) => ({
    ...r,
    is_system: !!r.is_system,
    userCount: db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(r.key).c
  }));
  res.json({ roles: withCounts });
});

router.post('/', (req, res) => {
  const { name, scope_description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) return res.status(400).json({ error: 'Invalid role name' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM roles').get().m;
  try {
    const info = db
      .prepare('INSERT INTO roles (key, name, scope_description, is_system, sort_order) VALUES (?, ?, ?, 0, ?)')
      .run(key, name.trim(), scope_description || null, maxOrder + 1);
    const roleId = info.lastInsertRowid;
    // New roles start with a baseline "View" grant on every feature.
    const features = db.prepare('SELECT id FROM perm_features').all();
    const grant = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)');
    features.forEach((f) => grant.run(roleId, f.id, 'View'));
    res.status(201).json({ role: db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) });
  } catch {
    res.status(409).json({ error: 'A role with this name already exists' });
  }
});

// Modules list for a role, with each module's granted-action count (for "Edit Access" screen).
router.get('/:id/modules', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });

  const modules = db.prepare('SELECT * FROM perm_modules ORDER BY sort_order, id').all();
  const result = modules.map((m) => {
    const featureCount = db.prepare('SELECT COUNT(*) AS c FROM perm_features WHERE module_id = ?').get(m.id).c;
    const grantedFeatureCount = db.prepare(`
      SELECT COUNT(DISTINCT f.id) AS c
      FROM perm_features f
      JOIN role_permissions rp ON rp.feature_id = f.id AND rp.role_id = @roleId
      WHERE f.module_id = @moduleId
    `).get({ roleId: role.id, moduleId: m.id }).c;
    return { ...m, featureCount, grantedFeatureCount };
  });

  res.json({ role: { ...role, is_system: !!role.is_system }, modules: result });
});

// Full feature-action matrix for one module + role.
router.get('/:id/modules/:moduleId', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const module_ = db.prepare('SELECT * FROM perm_modules WHERE id = ?').get(req.params.moduleId);
  if (!module_) return res.status(404).json({ error: 'Module not found' });

  const features = db.prepare('SELECT * FROM perm_features WHERE module_id = ? ORDER BY sort_order, id').all(module_.id);
  const grants = db.prepare(`
    SELECT rp.feature_id, rp.action FROM role_permissions rp
    JOIN perm_features f ON f.id = rp.feature_id
    WHERE rp.role_id = ? AND f.module_id = ?
  `).all(role.id, module_.id);

  const grantMap = {};
  grants.forEach((g) => { (grantMap[g.feature_id] = grantMap[g.feature_id] || []).push(g.action); });

  const featuresOut = features.map((f) => ({ ...f, actions: grantMap[f.id] || [] }));
  res.json({
    role: { ...role, is_system: !!role.is_system },
    module: module_,
    actions: ACTIONS,
    features: featuresOut
  });
});

// Toggle a single (feature, action) grant for a role.
router.put('/:id/permissions', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'Super Admin always has full access — its permissions cannot be edited.' });

  const { feature_id, action, granted } = req.body || {};
  if (!feature_id || !ACTIONS.includes(action)) return res.status(400).json({ error: 'feature_id and a valid action are required' });
  const feature = db.prepare('SELECT id FROM perm_features WHERE id = ?').get(feature_id);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });

  if (granted) {
    db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, feature_id, action) VALUES (?, ?, ?)').run(role.id, feature_id, action);
  } else {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND feature_id = ? AND action = ?').run(role.id, feature_id, action);
  }
  res.json({ ok: true });
});

export default router;

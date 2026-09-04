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
    paused: !!r.paused,
    userCount: db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(r.key).c
  }));
  res.json({ roles: withCounts });
});

// Persist a new workflow order (array of role ids, top-to-bottom).
// Declared before "/:id" so Express doesn't treat "reorder" as an id.
router.put('/reorder', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of role ids' });
  const update = db.prepare('UPDATE roles SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((ids) => ids.forEach((id, i) => update.run(i, id)));
  tx(order);
  res.json({ ok: true });
});

// Rename / re-scope a role (Edit), and set its leave-approval day limit (e.g. Team Lead: 2 days).
router.put('/:id', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  const { name, scope_description, max_leave_approval_days } = req.body || {};
  const nextLimit = max_leave_approval_days === undefined
    ? role.max_leave_approval_days
    : (max_leave_approval_days === null || max_leave_approval_days === '' ? null : Math.max(0, parseInt(max_leave_approval_days, 10) || 0));
  db.prepare('UPDATE roles SET name = COALESCE(?, name), scope_description = COALESCE(?, scope_description), max_leave_approval_days = ? WHERE id = ?')
    .run(name?.trim() || null, scope_description ?? null, nextLimit, req.params.id);
  res.json({ role: db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id) });
});

// Pause / resume a role in the workflow. Super Admin cannot be paused.
router.put('/:id/pause', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'The Super Admin role cannot be paused.' });
  const paused = req.body?.paused ? 1 : 0;
  db.prepare('UPDATE roles SET paused = ? WHERE id = ?').run(paused, req.params.id);
  res.json({ role: db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id) });
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
// The twelve built-in actions plus any Super Admin has added. Every place that validates or
// lists actions goes through this, so a custom action behaves exactly like a built-in one.
function allActions() {
  return [...ACTIONS, ...db.prepare('SELECT name FROM perm_custom_actions ORDER BY id').all().map((r) => r.name)];
}


// The action columns one module shows: its own configured list if it has one, otherwise every
// action. See module_visible_actions in db.js.
function actionsForModule(moduleId) {
  const rows = db.prepare('SELECT action FROM module_visible_actions WHERE module_id = ?').all(moduleId).map((r) => r.action);
  if (!rows.length) return allActions();
  // Keep the canonical ordering rather than insertion order, so columns don't shuffle.
  return allActions().filter((a) => rows.includes(a));
}

router.get('/actions', (req, res) => {
  res.json({ actions: allActions(), builtIn: ACTIONS });
});

// Add a new action name to the catalog. It becomes grantable immediately, but note it is inert
// until code checks for it — canFeatureAction() only matters where a route actually calls it.
router.post('/actions', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  // Adding an action to a module means "show this column here". An existing name (built-in like
  // Export, or one added earlier) is therefore not an error — it's attached to this module. Only
  // a name nobody has yet also gets created in the global catalogue.
  const moduleId = req.body?.module_id;
  const existing = allActions().find((a) => a.toLowerCase() === name.toLowerCase());
  const action = existing || name;
  const created = !existing;
  if (created) db.prepare('INSERT INTO perm_custom_actions (name) VALUES (?)').run(action);

  if (moduleId) {
    const module_ = db.prepare('SELECT id FROM perm_modules WHERE id = ?').get(moduleId);
    if (!module_) return res.status(404).json({ error: 'Module not found' });
    // Only modules that already restrict their columns need a row — an unrestricted module
    // shows everything anyway, and adding one row would silently narrow it to just that.
    const restricted = db.prepare('SELECT 1 FROM module_visible_actions WHERE module_id = ?').get(module_.id);
    if (restricted) {
      const already = db.prepare('SELECT 1 FROM module_visible_actions WHERE module_id = ? AND action = ?').get(module_.id, action);
      if (already && !created) return res.status(409).json({ error: `"${action}" is already shown on this module.` });
      db.prepare('INSERT OR IGNORE INTO module_visible_actions (module_id, action) VALUES (?, ?)').run(module_.id, action);
    } else if (!created) {
      return res.status(409).json({ error: `"${action}" is already shown on this module.` });
    }
    return res.status(201).json({ action, created, actions: actionsForModule(module_.id) });
  }
  res.status(201).json({ action, created, actions: allActions() });
});

// Stop showing an action on one module. Its grants for that module go too, so a hidden column
// can't leave permissions nobody can see or clear. Other modules are untouched, and the action
// itself stays in the catalogue.
router.delete('/actions/:action', (req, res) => {
  const action = decodeURIComponent(req.params.action);
  const moduleId = req.query.module_id;
  const module_ = moduleId ? db.prepare('SELECT id FROM perm_modules WHERE id = ?').get(moduleId) : null;
  if (!module_) return res.status(400).json({ error: 'module_id is required' });

  const shown = db.prepare('SELECT action FROM module_visible_actions WHERE module_id = ?').all(module_.id).map((r) => r.action);
  if (!shown.length) return res.status(400).json({ error: 'This module shows every action — there is no per-module list to remove from.' });
  if (!shown.includes(action)) return res.status(404).json({ error: `"${action}" is not shown on this module.` });
  // An empty list means "show everything" (see actionsForModule), so removing the last one would
  // flip the module wide open rather than closing it down — refuse instead of surprising anyone.
  if (shown.length === 1) return res.status(400).json({ error: 'At least one action must remain on a module.' });

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM module_visible_actions WHERE module_id = ? AND action = ?').run(module_.id, action);
    db.prepare('DELETE FROM role_permissions WHERE action = ? AND feature_id IN (SELECT id FROM perm_features WHERE module_id = ?)').run(action, module_.id);
  });
  remove();
  res.json({ action, actions: actionsForModule(module_.id) });
});

// Add a new feature row to a module's permission catalog (e.g. a new Dashboard item). Features
// belong to the module, not to one role — creating one makes it appear in every role's matrix,
// ungranted, so nobody silently gains access by its creation.
router.post('/features', (req, res) => {
  const { module_id, name } = req.body || {};
  if (!module_id || !name?.trim()) return res.status(400).json({ error: 'module_id and name are required' });
  const module_ = db.prepare('SELECT id FROM perm_modules WHERE id = ?').get(module_id);
  if (!module_) return res.status(404).json({ error: 'Module not found' });
  const clash = db.prepare('SELECT 1 FROM perm_features WHERE module_id = ? AND LOWER(name) = LOWER(?)').get(module_id, name.trim());
  if (clash) return res.status(409).json({ error: 'A feature with this name already exists in this module' });

  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM perm_features WHERE module_id = ?').get(module_id).m;
  const info = db.prepare('INSERT INTO perm_features (module_id, category, name, sort_order) VALUES (?, ?, ?, ?)')
    .run(module_id, null, name.trim(), maxSort + 1);
  res.status(201).json({ feature: db.prepare('SELECT id, name FROM perm_features WHERE id = ?').get(info.lastInsertRowid) });
});

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
    actions: actionsForModule(module_.id),
    // True when this module has its own configured column list (so actions can be removed from
    // it); false means it shows every action and there is no list to edit.
    restricted: !!db.prepare('SELECT 1 FROM module_visible_actions WHERE module_id = ?').get(module_.id),
    features: featuresOut
  });
});

// Toggle a single (feature, action) grant for a role.
router.put('/:id/permissions', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (role.is_system) return res.status(400).json({ error: 'Super Admin always has full access — its permissions cannot be edited.' });

  const { feature_id, action, granted } = req.body || {};
  if (!feature_id || !allActions().includes(action)) return res.status(400).json({ error: 'feature_id and a valid action are required' });
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

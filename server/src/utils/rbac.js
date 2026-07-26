import db from '../db.js';

// Real, dynamic RBAC backed by the perm_modules/perm_features/role_permissions tables edited
// in Manage Roles. Scope: this governs HR/admin-facing module access and specific admin
// actions only — it never gates an employee's own self-service (applying for their own leave,
// logging their own timesheet hours, raising their own ticket, etc.), which stays intrinsic to
// every authenticated employee regardless of what Super Admin configures here. That mirrors
// how the permission-matrix catalog itself is scoped (its feature list is entirely HR-facing
// concepts, never "My Leave"-style self-service).

// Super Admin always has full access — enforced here independently of role_permissions rows,
// matching roles.routes.js's own rule that Super Admin's matrix can't even be edited.
export function isSuperAdmin(roleKey) {
  return roleKey === 'super_admin';
}

function roleIdFor(roleKey) {
  return db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey)?.id || null;
}

// Does this role have ANY granted action on ANY feature in this module? Every role gets at
// least 'View' by default seed/migration, so this is deliberately a low bar — it answers "should
// this module even appear for this role" (sidebar / my-access), NOT "does this role get the
// module's HR/admin endpoints". Use canModuleAdmin() for the latter.
export function canModule(roleKey, moduleCode) {
  if (isSuperAdmin(roleKey)) return true;
  const roleId = roleIdFor(roleKey);
  if (!roleId) return false;
  const row = db.prepare(`
    SELECT 1 FROM role_permissions rp
    JOIN perm_features f ON f.id = rp.feature_id
    JOIN perm_modules m ON m.id = f.module_id
    WHERE rp.role_id = ? AND m.code = ?
    LIMIT 1
  `).get(roleId, moduleCode);
  return !!row;
}

// Does this role have any action BEYOND plain 'View' granted on any feature in this module?
// This is the real bar for a route file's isHR()-style gate: every role — including a plain
// employee — gets 'View' by default, so a mere-View check would let every employee through
// every HR/admin endpoint. Requiring a stronger action matches each module's actual default
// HR_ROLES-equivalent access (super_admin/hr_admin/manager/assistant_manager get every action;
// everyone else gets 'View' only) and lets Super Admin dynamically elevate any other role by
// granting it a real action (Approve/Manage/etc.) on a feature in Manage Roles.
export function canModuleAdmin(roleKey, moduleCode) {
  if (isSuperAdmin(roleKey)) return true;
  const roleId = roleIdFor(roleKey);
  if (!roleId) return false;
  const row = db.prepare(`
    SELECT 1 FROM role_permissions rp
    JOIN perm_features f ON f.id = rp.feature_id
    JOIN perm_modules m ON m.id = f.module_id
    WHERE rp.role_id = ? AND m.code = ? AND rp.action != 'View'
    LIMIT 1
  `).get(roleId, moduleCode);
  return !!row;
}

// Does this role have a specific action granted on a specific named feature within a module?
// Used for fine-grained gating of individual admin actions (Approve, Assign, Export, ...).
export function canFeatureAction(roleKey, moduleCode, featureName, action) {
  if (isSuperAdmin(roleKey)) return true;
  const roleId = roleIdFor(roleKey);
  if (!roleId) return false;
  const row = db.prepare(`
    SELECT 1 FROM role_permissions rp
    JOIN perm_features f ON f.id = rp.feature_id
    JOIN perm_modules m ON m.id = f.module_id
    WHERE rp.role_id = ? AND m.code = ? AND f.name = ? AND rp.action = ?
    LIMIT 1
  `).get(roleId, moduleCode, featureName, action);
  return !!row;
}

// The full permission map for a role — every module it has any access to, and for each,
// every feature + the set of granted actions. Drives the dynamic Sidebar and any page that
// wants to show/hide its own admin controls based on real permissions.
export function getRolePermissionMap(roleKey) {
  const map = {};
  if (isSuperAdmin(roleKey)) {
    const modules = db.prepare('SELECT * FROM perm_modules ORDER BY sort_order').all();
    modules.forEach((m) => {
      const features = db.prepare('SELECT name FROM perm_features WHERE module_id = ? ORDER BY sort_order').all(m.id);
      map[m.code] = { name: m.name, features: Object.fromEntries(features.map((f) => [f.name, ['View', 'Create', 'Edit', 'Delete', 'Approve', 'Reject', 'Assign', 'Import', 'Export', 'Download', 'Print', 'Manage']])) };
    });
    return map;
  }
  const roleId = roleIdFor(roleKey);
  if (!roleId) return map;
  const rows = db.prepare(`
    SELECT m.code AS module_code, m.name AS module_name, f.name AS feature_name, rp.action
    FROM role_permissions rp
    JOIN perm_features f ON f.id = rp.feature_id
    JOIN perm_modules m ON m.id = f.module_id
    WHERE rp.role_id = ?
    ORDER BY m.sort_order, f.sort_order
  `).all(roleId);
  rows.forEach((r) => {
    if (!map[r.module_code]) map[r.module_code] = { name: r.module_name, features: {} };
    if (!map[r.module_code].features[r.feature_name]) map[r.module_code].features[r.feature_name] = [];
    map[r.module_code].features[r.feature_name].push(r.action);
  });
  return map;
}

// Express middleware: gate an HR/admin route (or router) on module-level admin access.
export function requireModule(moduleCode) {
  return (req, res, next) => {
    if (!canModuleAdmin(req.user.role, moduleCode)) return res.status(403).json({ error: 'You do not have access to this module.' });
    next();
  };
}

// Express middleware: gate a specific admin action on a specific catalogued feature.
export function requireFeatureAction(moduleCode, featureName, action) {
  return (req, res, next) => {
    if (!canFeatureAction(req.user.role, moduleCode, featureName, action)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

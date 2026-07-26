import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '12' (Asset Management).
const isHR = (role) => canModuleAdmin(role, '12');
// Final approval authority — assets added by a Manager/Assistant Manager go through this
// role's sign-off before they can be assigned (the "Asset Approval" feature).
const APPROVAL_AUTHORITY = ['super_admin', 'hr_admin'];

const SCOPE_BANNER = {
  super_admin: 'Full Access — categories, allocation, transfers, maintenance, disposal, audit, org-wide. Rule: an asset cannot be assigned to more than one active employee at a time.',
  hr_admin: 'Company-wide assets — allocate, transfer, maintain and audit.',
  manager: 'Team/organization assets — request assets, view allocation, transfer requests.',
  assistant_manager: 'Team/organization assets — view allocation and request transfers.'
};

const KEY_FEATURES = [
  { key: 'inventory', label: 'Asset Inventory & Allocation', screen: 'dashboard' },
  { key: 'transfer', label: 'Asset Transfer & Return', screen: 'transfer' },
  { key: 'maintenance', label: 'Asset Maintenance & Repair', screen: 'maintenance' },
  { key: 'warranty', label: 'Warranty Management', screen: 'newAsset' },
  { key: 'disposal', label: 'Asset Disposal & History', screen: 'disposal' },
  { key: 'tracking', label: 'Barcode / QR Code Tracking', screen: 'tracking' },
  { key: 'approval', label: 'Asset Approval', screen: 'requests' },
  { key: 'reports', label: 'Asset Reports & Analytics', screen: 'reports' },
  { key: 'audit', label: 'Asset Audit', screen: 'audit' }
];
const FIELD_ACCESS = [
  { field: 'Asset Cost / Purchase Value', access: 'Editable' },
  { field: 'Assigned Employee', access: 'Editable' }
];

function withEmployee(a) {
  const emp = a.assigned_employee_id ? db.prepare('SELECT name, employee_code, status FROM employees WHERE id = ?').get(a.assigned_employee_id) : null;
  const history = db.prepare('SELECT * FROM asset_history WHERE asset_id = ? ORDER BY created_at DESC').all(a.id);
  return { ...a, assigned_employee_name: emp?.name || null, assigned_employee_code: emp?.employee_code || null, history };
}
function logHistory(assetId, action, detail) {
  db.prepare('INSERT INTO asset_history (asset_id, action, detail) VALUES (?, ?, ?)').run(assetId, action, detail || null);
}
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const assets = db.prepare("SELECT * FROM assets WHERE status != 'Disposed' ORDER BY created_at DESC").all().map(withEmployee);
  const active = assets.filter((a) => a.active);
  const assigned = active.filter((a) => a.status === 'Assigned').length;
  const inStore = active.filter((a) => a.status === 'In Store').length;

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Total Assets', value: active.length, color: 'blue' },
      { label: 'Assigned', value: assigned, color: 'green' },
      { label: 'In Store', value: inStore, color: 'gold' }
    ],
    assets,
    keyFeatures: KEY_FEATURES,
    fieldAccess: FIELD_ACCESS
  });
});

// Self-service: assets currently assigned to me, plus my own request history.
router.get('/my-assets', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ assets: [], requests: [] });
  const assets = db.prepare("SELECT * FROM assets WHERE assigned_employee_id = ? AND status != 'Disposed'").all(me.id);
  const requests = db.prepare(`
    SELECT r.*, a.name AS asset_name, a.asset_tag
    FROM asset_requests r LEFT JOIN assets a ON a.id = r.asset_id
    WHERE r.employee_id = ? ORDER BY r.created_at DESC
  `).all(me.id);
  res.json({ assets, requests });
});

// Employee raises a Return / Damage / Regularization request against one of their own assets,
// or a "New Asset" request (no asset_id yet — a category + urgency + reason instead), for
// when they don't have one at all or need an additional/replacement one.
router.post('/requests', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { asset_id, type, category, urgency, detail } = req.body || {};
  if (!['Return', 'Damage', 'Regularization', 'New Asset'].includes(type)) return res.status(400).json({ error: 'A valid request type is required' });
  const urg = ['Low', 'Medium', 'High'].includes(urgency) ? urgency : 'Medium';

  if (type === 'New Asset') {
    if (!category?.trim()) return res.status(400).json({ error: 'What kind of asset (category) is required.' });
    const info = db.prepare('INSERT INTO asset_requests (asset_id, employee_id, type, category, urgency, detail) VALUES (NULL, ?, ?, ?, ?, ?)')
      .run(me.id, type, category.trim(), urg, detail || null);
    return res.status(201).json({ request: db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(info.lastInsertRowid) });
  }

  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND assigned_employee_id = ?').get(asset_id, me.id);
  if (!asset) return res.status(400).json({ error: 'That asset is not currently assigned to you.' });
  const info = db.prepare('INSERT INTO asset_requests (asset_id, employee_id, type, urgency, detail) VALUES (?, ?, ?, ?, ?)').run(asset.id, me.id, type, urg, detail || null);
  logHistory(asset.id, `${type} requested`, `By ${me.name}${detail ? `: ${detail}` : ''}`);
  res.status(201).json({ request: db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(info.lastInsertRowid) });
});

// HR: pending (and recently decided) requests queue.
router.get('/requests', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const requests = db.prepare(`
    SELECT r.*, a.name AS asset_name, a.asset_tag, e.name AS employee_name, e.employee_code
    FROM asset_requests r LEFT JOIN assets a ON a.id = r.asset_id JOIN employees e ON e.id = r.employee_id
    ORDER BY (r.status = 'Pending') DESC, r.created_at DESC
  `).all();
  res.json({ requests });
});

router.put('/requests/:id/decide', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const request = db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided.' });
  const approve = req.body?.decision === 'approve';
  db.prepare("UPDATE asset_requests SET status = ?, decided_at = datetime('now') WHERE id = ?").run(approve ? 'Approved' : 'Rejected', req.params.id);

  // "New Asset" requests have no asset_id yet — approving just green-lights the ask; HR still
  // does the actual Assign Asset step separately once a physical unit is allocated.
  if (request.type === 'New Asset') {
    res.json({ request: db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(req.params.id) });
    return;
  }

  if (approve) {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(request.asset_id);
    if (request.type === 'Return') {
      db.prepare("UPDATE assets SET assigned_employee_id = NULL, status = 'In Store' WHERE id = ?").run(asset.id);
      logHistory(asset.id, 'Returned', `Return request approved by ${req.user.name}`);
    } else if (request.type === 'Damage') {
      db.prepare("UPDATE assets SET status = 'Under Repair', assigned_employee_id = NULL WHERE id = ?").run(asset.id);
      logHistory(asset.id, 'Sent for Repair', `Damage report approved by ${req.user.name}`);
    } else {
      logHistory(asset.id, 'Regularization approved', `By ${req.user.name}`);
    }
  } else {
    logHistory(request.asset_id, `${request.type} request rejected`, `By ${req.user.name}`);
  }
  res.json({ request: db.prepare('SELECT * FROM asset_requests WHERE id = ?').get(req.params.id) });
});

// Asset Approval: assets added by Manager/Assistant Manager start Pending Approval and
// can't be assigned until Super Admin/HR Admin approves them.
router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, category, cost, warranty_expiry } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const approvalStatus = APPROVAL_AUTHORITY.includes(req.user.role) ? 'Approved' : 'Pending Approval';
  const info = db.prepare('INSERT INTO assets (name, category, cost, warranty_expiry, approval_status) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), category || null, cost != null && cost !== '' ? Math.max(0, parseInt(cost, 10) || 0) : null, warranty_expiry || null, approvalStatus);
  db.prepare('UPDATE assets SET asset_tag = ? WHERE id = ?').run('AST-' + String(info.lastInsertRowid).padStart(4, '0'), info.lastInsertRowid);
  logHistory(info.lastInsertRowid, 'Added', approvalStatus === 'Pending Approval' ? `Requested by ${req.user.name}, awaiting approval` : `Added by ${req.user.name}`);
  res.status(201).json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/:id/decide', (req, res) => {
  if (!APPROVAL_AUTHORITY.includes(req.user.role)) return res.status(403).json({ error: 'Only Super Admin/HR Admin can approve assets.' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.approval_status !== 'Pending Approval') return res.status(400).json({ error: 'This asset has already been decided.' });
  const approve = req.body?.decision === 'approve';
  db.prepare('UPDATE assets SET approval_status = ? WHERE id = ?').run(approve ? 'Approved' : 'Rejected', req.params.id);
  logHistory(asset.id, approve ? 'Approved' : 'Rejected', `Decided by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Real edit — name/category/cost/warranty. Deliberately separate from assign/return/repair
// so "Edit" never silently changes who holds the asset.
router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const { name, category, cost, warranty_expiry } = req.body || {};
  db.prepare('UPDATE assets SET name = COALESCE(?, name), category = COALESCE(?, category), cost = ?, warranty_expiry = ? WHERE id = ?')
    .run(name?.trim() || null, category || null,
      cost === undefined ? asset.cost : (cost === '' || cost == null ? null : Math.max(0, parseInt(cost, 10) || 0)),
      warranty_expiry === undefined ? asset.warranty_expiry : (warranty_expiry || null),
      req.params.id);
  logHistory(asset.id, 'Edited', `Updated by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Pause/resume — retires an asset from the active pool without deleting its record/history.
router.put('/:id/pause', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const paused = !!req.body?.paused;
  db.prepare('UPDATE assets SET active = ? WHERE id = ?').run(paused ? 0 : 1, req.params.id);
  logHistory(asset.id, paused ? 'Paused' : 'Resumed', `By ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Company rule: an asset cannot be assigned to more than one active employee at a time — a
// currently-assigned asset must be returned first before it can be reassigned.
router.put('/:id/assign', (req, res) => {
  // Feature-level gate: this is exactly the 'Asset Allocation' feature.
  if (!canFeatureAction(req.user.role, '12', 'Asset Allocation', 'Assign')) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.approval_status !== 'Approved') return res.status(400).json({ error: 'This asset is awaiting approval and cannot be assigned yet.' });
  if (!asset.active) return res.status(400).json({ error: 'This asset is paused — resume it before assigning.' });
  if (asset.status === 'Assigned') return res.status(400).json({ error: 'This asset is already assigned — return it before reassigning.' });
  const emp = db.prepare("SELECT * FROM employees WHERE id = ? AND status = 'Active'").get(req.body?.employee_id);
  if (!emp) return res.status(400).json({ error: 'A valid, active employee_id is required' });
  db.prepare("UPDATE assets SET assigned_employee_id = ?, status = 'Assigned' WHERE id = ?").run(emp.id, req.params.id);
  logHistory(asset.id, 'Assigned', `To ${emp.name} (${emp.employee_code}) by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

router.put('/:id/return', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const fromName = asset.assigned_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(asset.assigned_employee_id)?.name : null;
  db.prepare("UPDATE assets SET assigned_employee_id = NULL, status = 'In Store' WHERE id = ?").run(req.params.id);
  logHistory(asset.id, 'Returned', `${fromName ? `From ${fromName}, ` : ''}by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Asset Transfer: directly reassign from the current holder to a different active employee
// in one step (return + assign, logged as a single transfer).
router.put('/:id/transfer', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.status !== 'Assigned') return res.status(400).json({ error: 'Only a currently-assigned asset can be transferred.' });
  const emp = db.prepare("SELECT * FROM employees WHERE id = ? AND status = 'Active'").get(req.body?.employee_id);
  if (!emp) return res.status(400).json({ error: 'A valid, active employee_id is required' });
  const fromName = db.prepare('SELECT name FROM employees WHERE id = ?').get(asset.assigned_employee_id)?.name;
  db.prepare('UPDATE assets SET assigned_employee_id = ? WHERE id = ?').run(emp.id, req.params.id);
  logHistory(asset.id, 'Transferred', `From ${fromName || 'previous holder'} to ${emp.name} (${emp.employee_code}) by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

router.put('/:id/repair', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const underRepair = req.body?.under_repair !== false;
  db.prepare('UPDATE assets SET status = ?, assigned_employee_id = CASE WHEN ? THEN NULL ELSE assigned_employee_id END WHERE id = ?')
    .run(underRepair ? 'Under Repair' : 'In Store', underRepair ? 1 : 0, req.params.id);
  logHistory(asset.id, underRepair ? 'Sent for Repair' : 'Back In Store', req.body?.note || `By ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Asset Disposal & History.
router.put('/:id/dispose', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.status === 'Assigned') return res.status(400).json({ error: 'Return the asset before disposing of it.' });
  db.prepare("UPDATE assets SET status = 'Disposed', active = 0 WHERE id = ?").run(req.params.id);
  logHistory(asset.id, 'Disposed', req.body?.reason || `By ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Asset Audit: a manual "checked, still present/in good order" log entry.
router.post('/:id/audit', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  logHistory(asset.id, 'Audited', `${req.body?.note ? req.body.note + ' — ' : ''}by ${req.user.name}`);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Asset Audit: run a full sweep across every active, non-disposed asset at once (logs each
// as "Audited" and records a summary row), plus the summary history for the dedicated screen.
router.get('/audits', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ audits: db.prepare('SELECT * FROM asset_audits ORDER BY created_at DESC').all() });
});

router.post('/audits', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const assets = db.prepare("SELECT * FROM assets WHERE active = 1 AND status != 'Disposed'").all();
  const note = req.body?.note?.trim() || null;
  assets.forEach((a) => logHistory(a.id, 'Audited', `Full audit by ${req.user.name}${note ? `: ${note}` : ''}`));
  const discrepancies = Math.max(0, parseInt(req.body?.discrepancies, 10) || 0);
  const info = db.prepare('INSERT INTO asset_audits (total, accounted_for, discrepancies, note) VALUES (?, ?, ?, ?)')
    .run(assets.length, assets.length - discrepancies, discrepancies, note);
  res.status(201).json({ audit: db.prepare('SELECT * FROM asset_audits WHERE id = ?').get(info.lastInsertRowid) });
});

// Asset Reports & Analytics.
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const assets = db.prepare('SELECT * FROM assets').all();
  const byCategory = {};
  assets.forEach((a) => {
    const key = a.category || 'Uncategorized';
    byCategory[key] = byCategory[key] || { category: key, count: 0, totalCost: 0 };
    byCategory[key].count++;
    byCategory[key].totalCost += a.cost || 0;
  });
  const byStatus = ['Assigned', 'In Store', 'Under Repair', 'Disposed'].map((s) => ({ status: s, count: assets.filter((a) => a.status === s).length }));
  const totalValue = assets.reduce((t, a) => t + (a.cost || 0), 0);
  res.json({ byCategory: Object.values(byCategory), byStatus, totalValue, totalAssets: assets.length });
});

export default router;

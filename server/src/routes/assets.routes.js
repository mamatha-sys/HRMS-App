import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

const SCOPE_BANNER = {
  super_admin: 'Full Access — categories, allocation, transfers, maintenance, disposal, audit, org-wide. Rule: an asset cannot be assigned to more than one active employee at a time.',
  hr_admin: 'Company-wide assets — allocate, transfer, maintain and audit.',
  manager: 'Team/organization assets — view allocation and request transfers.',
  assistant_manager: 'Team/organization assets — view allocation and request transfers.'
};

const KEY_FEATURES = [
  'Asset Inventory & Allocation', 'Asset Transfer & Return', 'Asset Maintenance & Repair', 'Warranty Management',
  'Asset Disposal & History', 'Barcode / QR Code Tracking', 'Asset Approval', 'Asset Reports & Analytics', 'Asset Audit'
];
const FIELD_ACCESS = [
  { field: 'Asset Cost / Purchase Value', access: 'Editable' },
  { field: 'Assigned Employee', access: 'Editable' }
];

function withEmployee(a) {
  const emp = a.assigned_employee_id ? db.prepare('SELECT name, employee_code, status FROM employees WHERE id = ?').get(a.assigned_employee_id) : null;
  return { ...a, assigned_employee_name: emp?.name || null, assigned_employee_code: emp?.employee_code || null };
}

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const assets = db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all().map(withEmployee);
  const assigned = assets.filter((a) => a.status === 'Assigned').length;
  const inStore = assets.filter((a) => a.status === 'In Store').length;

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Total Assets', value: assets.length, color: 'blue' },
      { label: 'Assigned', value: assigned, color: 'green' },
      { label: 'In Store', value: inStore, color: 'gold' }
    ],
    assets,
    keyFeatures: KEY_FEATURES,
    fieldAccess: FIELD_ACCESS
  });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, category, cost } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO assets (name, category, cost) VALUES (?, ?, ?)')
    .run(name.trim(), category || null, cost != null && cost !== '' ? Math.max(0, parseInt(cost, 10) || 0) : null);
  res.status(201).json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(info.lastInsertRowid)) });
});

router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const { name, category, cost } = req.body || {};
  db.prepare('UPDATE assets SET name = COALESCE(?, name), category = COALESCE(?, category), cost = COALESCE(?, cost) WHERE id = ?')
    .run(name?.trim() || null, category || null, cost != null && cost !== '' ? Math.max(0, parseInt(cost, 10) || 0) : null, req.params.id);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

// Company rule: an asset cannot be assigned to more than one active employee at a time — a
// currently-assigned asset must be returned first before it can be reassigned.
router.put('/:id/assign', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (asset.status === 'Assigned') return res.status(400).json({ error: 'This asset is already assigned — return it before reassigning.' });
  const emp = db.prepare("SELECT * FROM employees WHERE id = ? AND status = 'Active'").get(req.body?.employee_id);
  if (!emp) return res.status(400).json({ error: 'A valid, active employee_id is required' });
  db.prepare("UPDATE assets SET assigned_employee_id = ?, status = 'Assigned' WHERE id = ?").run(emp.id, req.params.id);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

router.put('/:id/return', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  db.prepare("UPDATE assets SET assigned_employee_id = NULL, status = 'In Store' WHERE id = ?").run(req.params.id);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

router.put('/:id/repair', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const underRepair = req.body?.under_repair !== false;
  db.prepare('UPDATE assets SET status = ?, assigned_employee_id = CASE WHEN ? THEN NULL ELSE assigned_employee_id END WHERE id = ?')
    .run(underRepair ? 'Under Repair' : 'In Store', underRepair ? 1 : 0, req.params.id);
  res.json({ asset: withEmployee(db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id)) });
});

export default router;

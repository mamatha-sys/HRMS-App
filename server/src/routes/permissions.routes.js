import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

export const CONFIGURABLE_FIELDS = [
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number',
  'date_of_birth', 'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  'education', 'experience', 'skills'
];

router.get('/', requireRole('super_admin'), (req, res) => {
  const rows = db.prepare("SELECT * FROM field_permissions WHERE role IN ('manager','employee')").all();
  res.json({ fields: CONFIGURABLE_FIELDS, permissions: rows });
});

router.put('/', requireRole('super_admin'), (req, res) => {
  const { role, field_name, access } = req.body || {};
  if (!['manager', 'employee'].includes(role)) return res.status(400).json({ error: 'role must be manager or employee' });
  if (!CONFIGURABLE_FIELDS.includes(field_name)) return res.status(400).json({ error: 'field_name is not configurable' });
  if (!['view', 'edit', 'hidden'].includes(access)) return res.status(400).json({ error: 'access must be view, edit or hidden' });

  db.prepare(`
    INSERT INTO field_permissions (role, field_name, access) VALUES (@role, @field_name, @access)
    ON CONFLICT(role, field_name) DO UPDATE SET access = excluded.access
  `).run({ role, field_name, access });

  res.json({ ok: true });
});

export default router;

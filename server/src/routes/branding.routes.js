import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { getSettings, setSetting } from '../utils/integrationSettings.js';

// Company branding (name + logo) must be readable from the Login page, before the user has a
// JWT — so GET is intentionally public. Only the update is gated to Super Admin.
const router = Router();

router.get('/', (req, res) => {
  res.json(getSettings(['company_name', 'company_logo']));
});

router.put('/', requireAuth, requireRole('super_admin'), (req, res) => {
  const { company_name, company_logo } = req.body || {};
  if (company_name !== undefined) setSetting('company_name', company_name || '');
  if (company_logo !== undefined) setSetting('company_logo', company_logo || '');
  res.json({ ok: true });
});

export default router;

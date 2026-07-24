import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

// Any authenticated user can read the dashboard config (to know what to render).
router.get('/dashboard', (req, res) => {
  const widgets = db.prepare('SELECT * FROM dashboard_config ORDER BY sort_order, widget_key').all();
  res.json({ widgets: widgets.map((w) => ({ ...w, visible: !!w.visible })) });
});

// Only super admin can customize the dashboard.
router.put('/dashboard', requireRole('super_admin'), (req, res) => {
  const { widget_key, visible } = req.body || {};
  const widget = db.prepare('SELECT * FROM dashboard_config WHERE widget_key = ?').get(widget_key);
  if (!widget) return res.status(404).json({ error: 'Unknown widget' });
  db.prepare('UPDATE dashboard_config SET visible = ? WHERE widget_key = ?').run(visible ? 1 : 0, widget_key);
  res.json({ ok: true });
});

export default router;

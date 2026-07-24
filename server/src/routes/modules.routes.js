import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const modules = db.prepare('SELECT * FROM custom_modules ORDER BY id').all();
  const features = db.prepare('SELECT * FROM custom_features ORDER BY id').all();

  // The built-in module catalog (from the permission system) so the "Add module" screen
  // also lists the previous/standard modules, not just custom ones.
  const standardModules = db.prepare('SELECT * FROM perm_modules ORDER BY sort_order, id').all().map((m) => ({
    ...m,
    features: db.prepare('SELECT id, name FROM perm_features WHERE module_id = ? ORDER BY sort_order, id').all(m.id)
  }));

  res.json({
    modules: modules.map((m) => ({ ...m, features: features.filter((f) => f.module_id === m.id) })),
    standardModules
  });
});

router.post('/', requireRole('super_admin'), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO custom_modules (name, created_by) VALUES (?, ?)').run(name, req.user.sub);
    res.status(201).json({ module: db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'A module with this name already exists' });
  }
});

router.post('/:moduleId/features', requireRole('super_admin'), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const module_ = db.prepare('SELECT * FROM custom_modules WHERE id = ?').get(req.params.moduleId);
  if (!module_) return res.status(404).json({ error: 'Module not found' });

  const info = db
    .prepare('INSERT INTO custom_features (module_id, name) VALUES (?, ?)')
    .run(req.params.moduleId, name);
  res.status(201).json({ feature: db.prepare('SELECT * FROM custom_features WHERE id = ?').get(info.lastInsertRowid) });
});

router.get('/:moduleId/features/:featureId/records', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM custom_records WHERE feature_id = ? ORDER BY id DESC')
    .all(req.params.featureId);
  res.json({ records: rows });
});

router.post('/:moduleId/features/:featureId/records', requireRole('super_admin', 'manager'), (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const feature = db.prepare('SELECT * FROM custom_features WHERE id = ?').get(req.params.featureId);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });

  const info = db
    .prepare('INSERT INTO custom_records (feature_id, title, created_by) VALUES (?, ?, ?)')
    .run(req.params.featureId, title, req.user.sub);
  res.status(201).json({ record: db.prepare('SELECT * FROM custom_records WHERE id = ?').get(info.lastInsertRowid) });
});

const STATUS_CYCLE = ['Open', 'In Progress', 'Closed'];
router.put('/:moduleId/features/:featureId/records/:recordId', requireRole('super_admin', 'manager'), (req, res) => {
  const record = db.prepare('SELECT * FROM custom_records WHERE id = ?').get(req.params.recordId);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(record.status) + 1) % STATUS_CYCLE.length];
  db.prepare('UPDATE custom_records SET status = ? WHERE id = ?').run(nextStatus, req.params.recordId);
  res.json({ record: db.prepare('SELECT * FROM custom_records WHERE id = ?').get(req.params.recordId) });
});

export default router;

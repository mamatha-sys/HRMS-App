import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '17' (Document Management).
const isHR = (role) => canModuleAdmin(role, '17');
// Its own permission-matrix feature, independent of the general upload/delete grant above — Super
// Admin can hand a role just the ability to publish/hide a document without also giving upload/delete.
const canPublish = (role) => canFeatureAction(role, '17', 'Publish / Hide from Employees', 'Manage');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const activeEmployeeCount = () => db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Active'").get().c;

// Everyone: the document library, each with the current user's own acknowledgment status.
// Non-HR viewers only ever see published documents — unpublished ones stay admin-only.
router.get('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  const canSeeUnpublished = isHR(req.user.role);
  const rows = canSeeUnpublished
    ? db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at FROM company_documents ORDER BY created_at DESC').all()
    : db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at FROM company_documents WHERE published = 1 ORDER BY created_at DESC').all();
  const documents = rows.map((d) => ({
    ...d,
    acknowledgedByMe: me ? !!db.prepare('SELECT 1 FROM document_acknowledgments WHERE document_id = ? AND employee_id = ?').get(d.id, me.id) : false,
    ackCount: db.prepare('SELECT COUNT(*) c FROM document_acknowledgments WHERE document_id = ?').get(d.id).c
  }));
  res.json({ documents, activeEmployeeCount: activeEmployeeCount() });
});

router.get('/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.published && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ document: doc });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, category, file_data_url, mandatory, published } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!file_data_url) return res.status(400).json({ error: 'A file is required' });
  const cat = ['Policy', 'Handbook', 'Form', 'Other'].includes(category) ? category : 'Policy';
  const info = db.prepare('INSERT INTO company_documents (title, category, file_data_url, mandatory, published, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title.trim(), cat, file_data_url, mandatory ? 1 : 0, published === false ? 0 : 1, req.user.name || 'HR');
  res.status(201).json({ document: db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at FROM company_documents WHERE id = ?').get(info.lastInsertRowid) });
});

// Toggle whether employees can see this document — gated by its own permission-matrix feature.
router.put('/:id/publish', (req, res) => {
  if (!canPublish(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const doc = db.prepare('SELECT id FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  db.prepare('UPDATE company_documents SET published = ? WHERE id = ?').run(req.body?.published ? 1 : 0, req.params.id);
  res.json({ document: db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at FROM company_documents WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM company_documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Employee: acknowledge having read a document (idempotent — re-acking is a no-op).
router.post('/:id/acknowledge', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const doc = db.prepare('SELECT id, published FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.published && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  try { db.prepare('INSERT INTO document_acknowledgments (document_id, employee_id) VALUES (?, ?)').run(doc.id, me.id); } catch { /* already acknowledged */ }
  res.json({ ok: true });
});

// HR: who has/hasn't acknowledged a mandatory document.
router.get('/:id/acknowledgments', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const doc = db.prepare('SELECT * FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const acknowledged = db.prepare(`
    SELECT e.name, e.employee_code, a.acknowledged_at
    FROM document_acknowledgments a JOIN employees e ON e.id = a.employee_id
    WHERE a.document_id = ? ORDER BY a.acknowledged_at
  `).all(doc.id);
  const ackIds = new Set(db.prepare('SELECT employee_id FROM document_acknowledgments WHERE document_id = ?').all(doc.id).map((r) => r.employee_id));
  const pending = db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active'").all().filter((e) => !ackIds.has(e.id));
  res.json({ document: doc, acknowledged, pending });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '17' (Document Management).
const isHR = (role) => canModuleAdmin(role, '17');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const activeEmployeeCount = () => db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Active'").get().c;

// Everyone: the document library, each with the current user's own acknowledgment status.
router.get('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  const documents = db.prepare('SELECT id, title, category, mandatory, uploaded_by, created_at FROM company_documents ORDER BY created_at DESC').all().map((d) => ({
    ...d,
    acknowledgedByMe: me ? !!db.prepare('SELECT 1 FROM document_acknowledgments WHERE document_id = ? AND employee_id = ?').get(d.id, me.id) : false,
    ackCount: db.prepare('SELECT COUNT(*) c FROM document_acknowledgments WHERE document_id = ?').get(d.id).c
  }));
  res.json({ documents, activeEmployeeCount: activeEmployeeCount() });
});

router.get('/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json({ document: doc });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, category, file_data_url, mandatory } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!file_data_url) return res.status(400).json({ error: 'A file is required' });
  const cat = ['Policy', 'Handbook', 'Form', 'Other'].includes(category) ? category : 'Policy';
  const info = db.prepare('INSERT INTO company_documents (title, category, file_data_url, mandatory, uploaded_by) VALUES (?, ?, ?, ?, ?)')
    .run(title.trim(), cat, file_data_url, mandatory ? 1 : 0, req.user.name || 'HR');
  res.status(201).json({ document: db.prepare('SELECT id, title, category, mandatory, uploaded_by, created_at FROM company_documents WHERE id = ?').get(info.lastInsertRowid) });
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
  const doc = db.prepare('SELECT id FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
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

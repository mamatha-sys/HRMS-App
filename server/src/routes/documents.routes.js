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

// Targeted the same three ways as an Announcement: everyone, one department, or a hand-picked
// set of employees. Active only — an exited employee should not appear on an audience just
// because their old department was picked, and should not sit forever in a "pending
// acknowledgment" list nobody will ever clear.
function audienceFor(doc) {
  if (doc.target_department) {
    return db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active' AND department = ?").all(doc.target_department);
  }
  const recipientIds = db.prepare('SELECT employee_id FROM document_recipients WHERE document_id = ?').all(doc.id).map((r) => r.employee_id);
  if (recipientIds.length) {
    const placeholders = recipientIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, name, employee_code FROM employees WHERE status = 'Active' AND id IN (${placeholders})`).all(...recipientIds);
  }
  return db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active'").all();
}

// Is this employee inside the document's intended audience? Everyone (no department, no
// recipients) always is; otherwise membership in the department or the recipient list.
function isInAudience(doc, employee) {
  if (!employee) return false;
  if (doc.target_department) return employee.department === doc.target_department;
  const hasRecipients = db.prepare('SELECT 1 FROM document_recipients WHERE document_id = ?').get(doc.id);
  if (hasRecipients) return !!db.prepare('SELECT 1 FROM document_recipients WHERE document_id = ? AND employee_id = ?').get(doc.id, employee.id);
  return true;
}

function targetLabel(doc, audienceCount) {
  if (doc.target_department) return `${doc.target_department} department`;
  const hasRecipients = db.prepare('SELECT 1 FROM document_recipients WHERE document_id = ?').get(doc.id);
  if (hasRecipients) return `${audienceCount} employee${audienceCount === 1 ? '' : 's'}`;
  return 'Everyone';
}

// Everyone: the document library, each with the current user's own acknowledgment status.
// Non-HR viewers only ever see published documents that are actually addressed to them —
// company-wide, their own department, or them by name.
router.get('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  const canSeeUnpublished = isHR(req.user.role);
  let rows = canSeeUnpublished
    ? db.prepare('SELECT * FROM company_documents ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM company_documents WHERE published = 1 ORDER BY created_at DESC').all();
  if (!canSeeUnpublished) rows = rows.filter((d) => isInAudience(d, me));

  const documents = rows.map((d) => {
    const audience = audienceFor(d);
    return {
      id: d.id, title: d.title, category: d.category, mandatory: d.mandatory, published: d.published,
      uploaded_by: d.uploaded_by, created_at: d.created_at, target_department: d.target_department,
      targetLabel: targetLabel(d, audience.length),
      audienceCount: audience.length,
      acknowledgedByMe: me ? !!db.prepare('SELECT 1 FROM document_acknowledgments WHERE document_id = ? AND employee_id = ?').get(d.id, me.id) : false,
      ackCount: db.prepare('SELECT COUNT(*) c FROM document_acknowledgments WHERE document_id = ?').get(d.id).c
    };
  });
  res.json({ documents });
});

// Data the upload/edit-targeting form needs — same shape as Announcements' compose-options.
router.get('/compose-options', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const departments = db.prepare('SELECT name FROM departments ORDER BY name').all().map((d) => d.name);
  const employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  res.json({ departments, employees });
});

router.get('/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.published && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!isHR(req.user.role) && !isInAudience(doc, myEmployee(req.user.sub))) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ document: doc });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, category, file_data_url, mandatory, published, target_department, employee_ids } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!file_data_url) return res.status(400).json({ error: 'A file is required' });
  const cat = ['Policy', 'Handbook', 'Form', 'Other'].includes(category) ? category : 'Policy';
  const targetDept = target_department || null;
  const targetEmployeeIds = targetDept ? [] : (Array.isArray(employee_ids) ? employee_ids : []);

  const upload = db.transaction(() => {
    const info = db.prepare('INSERT INTO company_documents (title, category, file_data_url, mandatory, published, uploaded_by, target_department) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(title.trim(), cat, file_data_url, mandatory ? 1 : 0, published === false ? 0 : 1, req.user.name || 'HR', targetDept);
    if (targetEmployeeIds.length) {
      const insertRecipient = db.prepare('INSERT OR IGNORE INTO document_recipients (document_id, employee_id) VALUES (?, ?)');
      targetEmployeeIds.forEach((id) => insertRecipient.run(info.lastInsertRowid, id));
    }
    return info.lastInsertRowid;
  });
  const id = upload();
  res.status(201).json({ document: db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at, target_department FROM company_documents WHERE id = ?').get(id) });
});

// Toggle whether employees can see this document — gated by its own permission-matrix feature.
router.put('/:id/publish', (req, res) => {
  if (!canPublish(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const doc = db.prepare('SELECT id FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  db.prepare('UPDATE company_documents SET published = ? WHERE id = ?').run(req.body?.published ? 1 : 0, req.params.id);
  res.json({ document: db.prepare('SELECT id, title, category, mandatory, published, uploaded_by, created_at, target_department FROM company_documents WHERE id = ?').get(req.params.id) });
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
  const doc = db.prepare('SELECT id, published, target_department FROM company_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.published && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!isHR(req.user.role) && !isInAudience(doc, me)) return res.status(403).json({ error: 'Insufficient permissions' });
  try { db.prepare('INSERT INTO document_acknowledgments (document_id, employee_id) VALUES (?, ?)').run(doc.id, me.id); } catch { /* already acknowledged */ }
  res.json({ ok: true });
});

// HR: who has/hasn't acknowledged a mandatory document — "pending" is scoped to the document's
// actual audience, not every active employee, so a document sent to one department doesn't list
// the other 90% of the company as still pending.
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
  const pending = audienceFor(doc).filter((e) => !ackIds.has(e.id));
  res.json({ document: doc, targetLabel: targetLabel(doc, audienceFor(doc).length), acknowledged, pending });
});

export default router;

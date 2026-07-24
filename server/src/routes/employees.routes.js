import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'photo', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  'department', 'branch', 'designation', 'date_of_joining', 'reporting_manager', 'status',
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number',
  'education', 'experience', 'skills', 'documents'
];
const REQUIRED_FIELDS = ['name', 'email', 'department', 'designation', 'date_of_joining'];

function nextEmployeeCode() {
  const rows = db.prepare('SELECT employee_code FROM employees').all();
  const maxNum = rows.reduce((max, r) => {
    const n = parseInt(String(r.employee_code).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `EMP-${String(maxNum + 1).padStart(3, '0')}`;
}

// documents is stored as a JSON string of [{ name, dataUrl }]; normalize on the way in and out.
function serializeField(field, value) {
  if (field !== 'documents') return value ?? null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value || null;
  return null;
}

function hydrate(emp) {
  let documents = [];
  if (emp.documents) { try { documents = JSON.parse(emp.documents); } catch { documents = []; } }
  return { ...emp, documents };
}

function fieldAccessForRole(role) {
  const rows = db.prepare('SELECT field_name, access FROM field_permissions WHERE role = ?').all(role);
  const map = {};
  rows.forEach((r) => { map[r.field_name] = r.access; });
  return map;
}

// Super admin sees everything; a manager sees all employees but fields marked 'hidden' in
// field_permissions are masked unless viewing their own record; an employee only sees their own record.
function maskEmployee(emp, requester) {
  const isOwnRecord = emp.user_id === requester.sub;
  if (requester.role === 'super_admin' || isOwnRecord) return { ...emp, sensitiveFieldsMasked: false };

  const access = fieldAccessForRole(requester.role);
  const hiddenFields = Object.keys(access).filter((f) => access[f] === 'hidden');
  const masked = { ...emp, sensitiveFieldsMasked: hiddenFields.length > 0 };
  hiddenFields.forEach((f) => { masked[f] = null; });
  return masked;
}

function present(emp, requester) {
  return maskEmployee(hydrate(emp), requester);
}

router.get('/', (req, res) => {
  if (req.user.role === 'employee') {
    const rows = db.prepare('SELECT * FROM employees WHERE user_id = ?').all(req.user.sub);
    return res.json({ employees: rows.map((r) => present(r, req.user)) });
  }
  const rows = db.prepare('SELECT * FROM employees ORDER BY id').all();
  res.json({ employees: rows.map((r) => present(r, req.user)) });
});

router.get('/:id', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (req.user.role === 'employee' && emp.user_id !== req.user.sub) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  res.json({ employee: present(emp, req.user) });
});

router.post('/', requireRole('super_admin', 'manager'), (req, res) => {
  const body = req.body || {};
  if (REQUIRED_FIELDS.some((f) => !body[f])) {
    return res.status(400).json({ error: 'name, email, department, designation and date_of_joining are required' });
  }

  const existing = db.prepare('SELECT id FROM employees WHERE email = ?').get(body.email);
  if (existing) return res.status(409).json({ error: 'An employee with this email already exists' });

  // Employee ID is optional — use a provided one (if unique) or auto-generate.
  let code = body.employee_code?.trim();
  if (code) {
    if (db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(code)) {
      return res.status(409).json({ error: 'This Employee ID is already in use' });
    }
  } else {
    code = nextEmployeeCode();
  }

  const values = { employee_code: code };
  EDITABLE_FIELDS.forEach((f) => { values[f] = serializeField(f, body[f]); });
  values.status = body.status === 'Inactive' ? 'Inactive' : 'Active';

  const columns = ['employee_code', ...EDITABLE_FIELDS];
  const info = db
    .prepare(`INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map((c) => '@' + c).join(', ')})`)
    .run(values);

  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ employee: present(employee, req.user) });
});

router.put('/:id', requireRole('super_admin', 'manager'), (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const updated = { ...emp };
  EDITABLE_FIELDS.forEach((f) => {
    if (req.body?.[f] !== undefined) updated[f] = serializeField(f, req.body[f]);
  });

  db.prepare(`
    UPDATE employees SET ${EDITABLE_FIELDS.map((f) => `${f} = @${f}`).join(', ')}
    WHERE id = @id
  `).run(updated);

  const result = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  res.json({ employee: present(result, req.user) });
});

router.delete('/:id', requireRole('super_admin'), (req, res) => {
  const info = db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Employee not found' });
  res.status(204).send();
});

export default router;

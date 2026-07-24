import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

// "HR" = anyone who can administer employee records / approve the onboarding workflow.
const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
function requireHR(req, res, next) {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

const ADDRESS_FIELDS = ['address_street', 'address_city', 'address_state', 'address_country', 'address_pincode'];

// Fields HR may set/change on any record.
const HR_EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'photo', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  ...ADDRESS_FIELDS,
  'department', 'branch', 'designation', 'date_of_joining', 'reporting_manager', 'status',
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number',
  'education', 'experience', 'skills', 'documents'
];

// Fields an employee may fill on their own record (no department/designation/status/joining changes).
const EMPLOYEE_EDITABLE_FIELDS = [
  'name', 'phone', 'photo', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  ...ADDRESS_FIELDS,
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number',
  'education', 'experience', 'skills', 'documents'
];

function nextEmployeeCode() {
  const rows = db.prepare('SELECT employee_code FROM employees').all();
  const maxNum = rows.reduce((max, r) => {
    const n = parseInt(String(r.employee_code).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `EMP-${String(maxNum + 1).padStart(3, '0')}`;
}

function serializeField(field, value) {
  if (field !== 'documents') return value ?? null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value || null;
  return null;
}

function hydrate(emp) {
  let documents = [];
  if (emp.documents) { try { documents = JSON.parse(emp.documents); } catch { documents = []; } }
  return { ...emp, documents, edit_requested: !!emp.edit_requested };
}

function fieldAccessForRole(role) {
  const rows = db.prepare('SELECT field_name, access FROM field_permissions WHERE role = ?').all(role);
  const map = {};
  rows.forEach((r) => { map[r.field_name] = r.access; });
  return map;
}

function maskEmployee(emp, requester) {
  const isOwnRecord = emp.user_id === requester.sub;
  if (requester.role === 'super_admin' || isOwnRecord) return { ...emp, sensitiveFieldsMasked: false };
  const access = fieldAccessForRole(requester.role);
  const hiddenFields = Object.keys(access).filter((f) => access[f] === 'hidden');
  const masked = { ...emp, sensitiveFieldsMasked: hiddenFields.length > 0 };
  hiddenFields.forEach((f) => { masked[f] = null; });
  return masked;
}

const present = (emp, requester) => maskEmployee(hydrate(emp), requester);
const getEmp = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id);

router.get('/', (req, res) => {
  if (!isHR(req.user.role)) {
    const rows = db.prepare('SELECT * FROM employees WHERE user_id = ?').all(req.user.sub);
    return res.json({ employees: rows.map((r) => present(r, req.user)) });
  }
  const rows = db.prepare('SELECT * FROM employees ORDER BY id').all();
  res.json({ employees: rows.map((r) => present(r, req.user)) });
});

// Employee-role users with no employee record yet — candidates for Stage 2 assignment. (Before /:id.)
router.get('/assignable-users', requireHR, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email FROM users
    WHERE role = 'employee' AND id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL)
    ORDER BY name
  `).all();
  res.json({ users });
});

router.get('/:id', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!isHR(req.user.role) && emp.user_id !== req.user.sub) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  res.json({ employee: present(emp, req.user) });
});

// Stage 1 — HR creates a draft with the essentials (ID + Department + Designation + Name).
router.post('/', requireHR, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.department || !body.designation) {
    return res.status(400).json({ error: 'name, department and designation are required' });
  }

  if (body.email && db.prepare('SELECT id FROM employees WHERE email = ?').get(body.email)) {
    return res.status(409).json({ error: 'An employee with this email already exists' });
  }

  let code = body.employee_code?.trim();
  if (code) {
    if (db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(code)) {
      return res.status(409).json({ error: 'This Employee ID is already in use' });
    }
  } else {
    code = nextEmployeeCode();
  }

  const values = { employee_code: code, stage: 'draft' };
  HR_EDITABLE_FIELDS.forEach((f) => { values[f] = serializeField(f, body[f]); });
  values.status = ['Active', 'On Probation', 'Exited'].includes(body.status) ? body.status : 'Active';

  const columns = ['employee_code', 'stage', ...HR_EDITABLE_FIELDS];
  const info = db
    .prepare(`INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map((c) => '@' + c).join(', ')})`)
    .run(values);

  res.status(201).json({ employee: present(getEmp(info.lastInsertRowid), req.user) });
});

// Bulk import — inserts already-onboarded (locked) records.
router.post('/bulk', requireHR, (req, res) => {
  const { rows, defaultDepartment, defaultBranch, defaultJoiningDate } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' });

  const results = { inserted: 0, skipped: 0, errors: [] };
  const insertOne = db.transaction((list) => {
    list.forEach((raw, i) => {
      const row = {
        name: raw.name?.trim(),
        email: raw.email?.trim(),
        designation: raw.designation?.trim(),
        department: (raw.department || defaultDepartment || '').trim(),
        branch: (raw.branch || defaultBranch || '').trim() || null,
        date_of_joining: (raw.date_of_joining || defaultJoiningDate || '').trim(),
        phone: raw.phone?.trim() || null,
        status: ['Active', 'On Probation', 'Exited'].includes(raw.status) ? raw.status : 'Active'
      };
      if (!row.name || !row.email || !row.department || !row.designation || !row.date_of_joining) {
        results.errors.push(`Row ${i + 1}: missing name/email/department/designation/joining date`);
        return;
      }
      if (db.prepare('SELECT id FROM employees WHERE email = ?').get(row.email)) { results.skipped++; return; }
      db.prepare(`
        INSERT INTO employees (employee_code, name, email, phone, department, branch, designation, date_of_joining, status, stage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'locked')
      `).run(nextEmployeeCode(), row.name, row.email, row.phone, row.department, row.branch, row.designation, row.date_of_joining, row.status);
      results.inserted++;
    });
  });
  insertOne(rows);
  res.json(results);
});

// Stage 2 — HR assigns a draft to an employee-role user so they can fill it in.
router.put('/:id/assign', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const { user_id } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user || user.role !== 'employee') return res.status(400).json({ error: 'Choose a valid employee-role user to assign to' });

  db.prepare('UPDATE employees SET user_id = ?, stage = ?, edit_requested = 0 WHERE id = ?').run(user_id, 'assigned', req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 3 (employee) / general edit (HR). Locked profiles cannot be edited.
router.put('/:id', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const hr = isHR(req.user.role);
  const own = emp.user_id === req.user.sub;
  if (!hr && !own) return res.status(403).json({ error: 'Insufficient permissions' });

  if (emp.stage === 'locked') {
    return res.status(403).json({ error: 'This profile is locked. An approved edit request is required before it can be changed.' });
  }
  if (!hr && emp.stage !== 'assigned') {
    return res.status(403).json({ error: 'You can only edit your profile while it is assigned to you for filling.' });
  }

  const allowed = hr ? HR_EDITABLE_FIELDS : EMPLOYEE_EDITABLE_FIELDS;
  const updated = { ...emp };
  allowed.forEach((f) => { if (req.body?.[f] !== undefined) updated[f] = serializeField(f, req.body[f]); });

  db.prepare(`UPDATE employees SET ${allowed.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run(updated);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 3 submit — employee (or HR on their behalf) sends the filled profile for review.
router.post('/:id/submit', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const own = emp.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });
  if (emp.stage !== 'assigned') return res.status(400).json({ error: 'Only an assigned profile can be submitted.' });
  db.prepare("UPDATE employees SET stage = 'submitted' WHERE id = ?").run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 4 — HR approves (locks) or rejects (back to the employee).
router.post('/:id/approve', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.stage !== 'submitted') return res.status(400).json({ error: 'Only a submitted profile can be approved.' });
  db.prepare("UPDATE employees SET stage = 'locked', edit_requested = 0 WHERE id = ?").run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

router.post('/:id/reject', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.stage !== 'submitted') return res.status(400).json({ error: 'Only a submitted profile can be rejected.' });
  db.prepare("UPDATE employees SET stage = 'assigned' WHERE id = ?").run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 5 — employee requests an edit on a locked profile.
router.post('/:id/request-edit', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.user_id !== req.user.sub && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (emp.stage !== 'locked') return res.status(400).json({ error: 'Only a locked profile needs an edit request.' });
  db.prepare('UPDATE employees SET edit_requested = 1 WHERE id = ?').run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 5 — HR approves the edit request (unlocks back to 'assigned' for re-filling).
router.post('/:id/approve-edit', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.stage !== 'locked') return res.status(400).json({ error: 'Only a locked profile can be unlocked.' });
  db.prepare("UPDATE employees SET stage = 'assigned', edit_requested = 0 WHERE id = ?").run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

router.delete('/:id', requireHR, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can delete an employee record' });
  const info = db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Employee not found' });
  res.status(204).send();
});

export default router;

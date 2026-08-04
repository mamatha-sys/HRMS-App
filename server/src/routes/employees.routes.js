import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { sendSms } from '../utils/channels.js';
import { isScopedRole, filterToScope } from '../utils/scope.js';
import { autoCompleteOnboardingTask } from '../utils/onboarding.js';
import { bottomRole, approvalChainLabel } from '../utils/chain.js';

const router = Router();
router.use(requireAuth);

// "HR" = anyone who can administer employee records / approve the onboarding workflow.
// Module-level access is real, dynamic RBAC via Manage Roles (server/src/utils/rbac.js) —
// Super Admin always passes; every other role must have been granted at least one permission
// on module '02' (Employee Management), or every HR-admin action here is hidden/blocked.
const isHR = (role) => canModuleAdmin(role, '02');
function requireHR(req, res, next) {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

const ADDRESS_FIELDS = [
  'address_type', 'address_line1', 'address_line2',
  'address_city', 'address_district', 'address_state', 'address_country', 'address_pincode'
];

// India: 10-digit mobile number, first digit 6-9 (the +91 country code is assumed/fixed in the UI).
function isValidIndianPhone(v) { return /^[6-9]\d{9}$/.test(v); }

// Fields HR may set/change on any record.
const HR_EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'photo', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  ...ADDRESS_FIELDS,
  'department', 'branch', 'team_id', 'designation', 'date_of_joining', 'reporting_manager', 'status', 'shift',
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number', 'uan_number', 'pf_number', 'esi_number',
  'employment_type', 'education', 'experience', 'skills', 'documents'
];

// Fields an employee may fill on their own record (no department/designation/status/joining changes).
const EMPLOYEE_EDITABLE_FIELDS = [
  'name', 'phone', 'photo', 'date_of_birth',
  'emergency_contact_name', 'emergency_contact_relation', 'emergency_contact_number',
  ...ADDRESS_FIELDS,
  'bank_name', 'bank_account_number', 'ifsc_code', 'aadhaar_number', 'pan_number', 'uan_number', 'pf_number', 'esi_number',
  'employment_type', 'education', 'experience', 'skills', 'documents'
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
  if (field === 'team_id') return value === '' || value == null ? null : Number(value);
  // email is UNIQUE — an empty string (unlike NULL) collides with every other blank email, so
  // treat '' the same as "not provided" instead of storing it as a real value.
  if (field === 'email') return value ? value : null;
  if (field === 'employment_type') return ['Fresher', 'Experienced'].includes(value) ? value : null;
  if (field !== 'documents') return value ?? null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return value || null;
  return null;
}

// Custom fields — Super Admin can add a new one at any time (see /custom-fields below); once
// added it's just another field on every employee's record for HR/the employee to fill in.
function activeCustomFields() { return db.prepare('SELECT * FROM employee_custom_fields WHERE active = 1 ORDER BY sort_order, id').all(); }
function customFieldValuesFor(employeeId) {
  const fields = activeCustomFields();
  const rows = db.prepare('SELECT field_id, value FROM employee_custom_field_values WHERE employee_id = ?').all(employeeId);
  const byField = {}; rows.forEach((r) => { byField[r.field_id] = r.value; });
  return fields.map((f) => ({ field_id: f.id, key: f.key, label: f.label, field_type: f.field_type, value: byField[f.id] ?? '' }));
}
function saveCustomFieldValues(employeeId, values) {
  if (!values || typeof values !== 'object') return;
  const validIds = new Set(activeCustomFields().map((f) => f.id));
  const upsert = db.prepare('INSERT INTO employee_custom_field_values (employee_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT(employee_id, field_id) DO UPDATE SET value = excluded.value');
  Object.entries(values).forEach(([fieldId, value]) => {
    const id = Number(fieldId);
    if (validIds.has(id)) upsert.run(employeeId, id, value == null ? null : String(value));
  });
}

const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
// Edit requests ride the same shared "approvals" table + hierarchy chain as Leave/
// Regularization (type: 'Profile Edit'), matched by requester name — same convention already
// used for Regularization. Gives full history (every request is its own row, never overwritten),
// a request count, and hierarchy-wise approval for free, instead of the old single mutable
// edit_requested boolean that lost all trace of a request once decided.
function editRequestsFor(employeeName) {
  return db.prepare("SELECT * FROM approvals WHERE type = 'Profile Edit' AND requester = ? ORDER BY created_at DESC").all(employeeName)
    .map((r) => ({ ...r, current_stage_name: roleNameOf(r.current_stage_role_id) }));
}

function hydrate(emp) {
  let documents = [];
  if (emp.documents) { try { documents = JSON.parse(emp.documents); } catch { documents = []; } }
  // phone_otp_code/phone_otp_expires are a one-time secret in transit to the employee's own phone
  // via SMS — never echo them back over the API to anyone (HR included) viewing this record.
  const { phone_otp_code, phone_otp_expires, ...rest } = emp;
  const editRequests = editRequestsFor(emp.name);
  return {
    ...rest, documents, phone_verified: !!emp.phone_verified, custom_fields: customFieldValuesFor(emp.id),
    edit_requests: editRequests,
    edit_request_count: editRequests.length,
    // Derived, not the raw column — a Pending row in the chain is the actual source of truth now.
    edit_requested: editRequests.some((r) => r.status === 'Pending'),
    edit_chain_label: approvalChainLabel()
  };
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

const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const present = (emp, requester) => maskEmployee(hydrate(emp), requester);
// account_active mirrors the linked login's users.active flag (null if there's no login yet) so
// the Employee list can show/toggle Pause-Reactivate without a separate trip to User Management.
const EMP_WITH_TEAM = 'SELECT e.*, t.name AS team_name, u.active AS account_active FROM employees e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN users u ON u.id = e.user_id';
const getEmp = (id) => db.prepare(`${EMP_WITH_TEAM} WHERE e.id = ?`).get(id);

router.get('/', (req, res) => {
  if (isHR(req.user.role)) {
    const rows = db.prepare(`${EMP_WITH_TEAM} ORDER BY e.id`).all();
    return res.json({ employees: rows.map((r) => present(r, req.user)) });
  }
  // A Senior Team Lead/Team Lead can browse (read-only) the employee records in their own
  // assigned departments/teams — same fetch-then-filter scoping as Attendance/Leave — without
  // being granted module '02' admin (create/bulk-import/pause/onboarding-decide stay blocked).
  if (isScopedRole(req.user.role)) {
    const rows = db.prepare(`${EMP_WITH_TEAM} ORDER BY e.id`).all();
    const scoped = filterToScope(rows, req.user.role, myEmployee(req.user.sub)?.id);
    return res.json({ employees: scoped.map((r) => present(r, req.user)) });
  }
  const rows = db.prepare(`${EMP_WITH_TEAM} WHERE e.user_id = ?`).all(req.user.sub);
  res.json({ employees: rows.map((r) => present(r, req.user)) });
});

// Custom fields catalog — declared before /:id so "custom-fields" is never swallowed as an id.
// Anyone signed in can read the catalog (needed to render their own self-service form), but only
// Super Admin may add or manage a field definition.
router.get('/custom-fields', (req, res) => {
  res.json({ fields: req.user.role === 'super_admin' ? db.prepare('SELECT * FROM employee_custom_fields ORDER BY sort_order, id').all() : activeCustomFields() });
});

const CUSTOM_FIELD_SECTIONS = ['personal', 'address', 'emergency', 'employment', 'bank', 'education'];

router.post('/custom-fields', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can add a new field.' });
  const { label, field_type, section } = req.body || {};
  if (!label?.trim()) return res.status(400).json({ error: 'A field name is required' });
  const type = ['text', 'number', 'date'].includes(field_type) ? field_type : 'text';
  const sec = CUSTOM_FIELD_SECTIONS.includes(section) ? section : 'personal';
  const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) return res.status(400).json({ error: 'Could not derive a key from that name' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM employee_custom_fields').get().m;
  try {
    const info = db.prepare('INSERT INTO employee_custom_fields (key, label, field_type, section, sort_order) VALUES (?, ?, ?, ?, ?)').run(key, label.trim(), type, sec, maxOrder + 1);
    res.status(201).json({ field: db.prepare('SELECT * FROM employee_custom_fields WHERE id = ?').get(info.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'A field with this name already exists' }); }
});

router.put('/custom-fields/:fieldId', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can manage fields.' });
  const f = db.prepare('SELECT * FROM employee_custom_fields WHERE id = ?').get(req.params.fieldId);
  if (!f) return res.status(404).json({ error: 'Field not found' });
  const { label, active, section } = req.body || {};
  if (label !== undefined && !label?.trim()) return res.status(400).json({ error: 'Label cannot be empty' });
  const sec = section !== undefined ? (CUSTOM_FIELD_SECTIONS.includes(section) ? section : f.section) : null;
  db.prepare('UPDATE employee_custom_fields SET label = COALESCE(?, label), active = COALESCE(?, active), section = COALESCE(?, section) WHERE id = ?')
    .run(label?.trim() || null, active === undefined ? null : (active ? 1 : 0), sec, req.params.fieldId);
  res.json({ field: db.prepare('SELECT * FROM employee_custom_fields WHERE id = ?').get(req.params.fieldId) });
});

// Remove a field definition entirely (not just pause it) — cascades to delete every employee's
// stored value for it (employee_custom_field_values.field_id ON DELETE CASCADE).
router.delete('/custom-fields/:fieldId', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can manage fields.' });
  const f = db.prepare('SELECT * FROM employee_custom_fields WHERE id = ?').get(req.params.fieldId);
  if (!f) return res.status(404).json({ error: 'Field not found' });
  db.prepare('DELETE FROM employee_custom_fields WHERE id = ?').run(req.params.fieldId);
  res.json({ ok: true });
});

// Built-in fields (the ones hardcoded into the employee form, not a Super-Admin-defined custom
// field) — every one can have its label renamed; all but PROTECTED_FIELD_KEYS can also be hidden
// from the form. Hiding never touches the underlying column/data, only whether the form renders
// an input for it — so nothing else that reads this data (Payroll, Attendance, Reports) breaks.
const PROTECTED_FIELD_KEYS = ['employee_code', 'name', 'email', 'department', 'designation', 'status'];
const BUILTIN_FIELDS = [
  { key: 'employee_code', label: 'Employee ID', section: 'personal' },
  { key: 'name', label: 'Full name', section: 'personal' },
  { key: 'date_of_birth', label: 'Date of birth', section: 'personal' },
  { key: 'phone', label: 'Phone', section: 'personal' },
  { key: 'email', label: 'Email', section: 'personal' },
  { key: 'photo', label: 'Employee photo', section: 'personal' },
  { key: 'address_type', label: 'Address Type', section: 'address' },
  { key: 'address_line1', label: 'Address Line 1', section: 'address' },
  { key: 'address_line2', label: 'Address Line 2', section: 'address' },
  { key: 'address_city', label: 'City / Town', section: 'address' },
  { key: 'address_district', label: 'District', section: 'address' },
  { key: 'address_state', label: 'State / Province', section: 'address' },
  { key: 'address_country', label: 'Country', section: 'address' },
  { key: 'address_pincode', label: 'Postal Code / ZIP Code', section: 'address' },
  { key: 'emergency_contact_name', label: 'Emergency contact name', section: 'emergency' },
  { key: 'emergency_contact_relation', label: 'Emergency contact relation', section: 'emergency' },
  { key: 'emergency_contact_number', label: 'Emergency contact number', section: 'emergency' },
  { key: 'department', label: 'Department', section: 'employment' },
  { key: 'branch', label: 'Branch', section: 'employment' },
  { key: 'team_id', label: 'Team', section: 'employment' },
  { key: 'designation', label: 'Role / Designation', section: 'employment' },
  { key: 'date_of_joining', label: 'Date of joining', section: 'employment' },
  { key: 'reporting_manager', label: 'Reporting manager', section: 'employment' },
  { key: 'status', label: 'Status', section: 'employment' },
  { key: 'shift', label: 'Shift', section: 'employment' },
  { key: 'bank_name', label: 'Bank name', section: 'bank' },
  { key: 'bank_account_number', label: 'Account number', section: 'bank' },
  { key: 'ifsc_code', label: 'IFSC code', section: 'bank' },
  { key: 'pan_number', label: 'PAN number', section: 'bank' },
  { key: 'aadhaar_number', label: 'Aadhaar number', section: 'bank' },
  { key: 'uan_number', label: 'UAN number', section: 'bank' },
  { key: 'pf_number', label: 'PF number', section: 'bank' },
  { key: 'esi_number', label: 'ESI number', section: 'bank' },
  { key: 'employment_type', label: 'Employment Type', section: 'education' },
  { key: 'education', label: 'Education details', section: 'education' },
  { key: 'experience', label: 'Work experience details', section: 'education' },
  { key: 'skills', label: 'Skills & certifications', section: 'education' },
  { key: 'documents', label: 'Documents', section: 'education' }
];

router.get('/field-config', (req, res) => {
  const overrides = {};
  db.prepare('SELECT * FROM employee_field_config').all().forEach((r) => { overrides[r.field_key] = r; });
  const fields = BUILTIN_FIELDS.map((f) => {
    const o = overrides[f.key];
    return {
      key: f.key,
      label: o?.label?.trim() || f.label,
      defaultLabel: f.label,
      section: f.section,
      protected: PROTECTED_FIELD_KEYS.includes(f.key),
      hidden: !!o?.hidden
    };
  });
  res.json({ fields });
});

router.put('/field-config/:fieldKey', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can manage fields.' });
  const catalogEntry = BUILTIN_FIELDS.find((f) => f.key === req.params.fieldKey);
  if (!catalogEntry) return res.status(404).json({ error: 'Field not found' });
  const { label, hidden } = req.body || {};
  if (label !== undefined && !label?.trim()) return res.status(400).json({ error: 'Label cannot be empty' });
  if (hidden === true && PROTECTED_FIELD_KEYS.includes(req.params.fieldKey)) {
    return res.status(400).json({ error: 'This field is required by other modules (Payroll, Attendance, Reports) and cannot be hidden.' });
  }
  const existing = db.prepare('SELECT * FROM employee_field_config WHERE field_key = ?').get(req.params.fieldKey);
  const nextLabel = label !== undefined ? label.trim() : (existing?.label ?? null);
  const nextHidden = hidden !== undefined ? (hidden ? 1 : 0) : (existing?.hidden ?? 0);
  db.prepare(`
    INSERT INTO employee_field_config (field_key, label, hidden) VALUES (?, ?, ?)
    ON CONFLICT(field_key) DO UPDATE SET label = excluded.label, hidden = excluded.hidden
  `).run(req.params.fieldKey, nextLabel, nextHidden);
  const o = db.prepare('SELECT * FROM employee_field_config WHERE field_key = ?').get(req.params.fieldKey);
  res.json({ field: { key: catalogEntry.key, label: o.label?.trim() || catalogEntry.label, defaultLabel: catalogEntry.label, section: catalogEntry.section, protected: PROTECTED_FIELD_KEYS.includes(catalogEntry.key), hidden: !!o.hidden } });
});

router.get('/:id', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!isHR(req.user.role) && emp.user_id !== req.user.sub) {
    const inScope = isScopedRole(req.user.role) && filterToScope([emp], req.user.role, myEmployee(req.user.sub)?.id).length > 0;
    if (!inScope) return res.status(403).json({ error: 'Insufficient permissions' });
  }
  res.json({ employee: present(emp, req.user) });
});

// Add Employee — one step: HR enters the essentials plus a login (email + password) and this
// creates BOTH the employee record and their user account together, already linked (stage
// 'assigned'). Replaces the old two-step flow (create a bare draft in Employee Management, then
// separately create a login in Role & User Management, then manually Assign them together).
router.post('/', requireHR, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.department || !body.designation) {
    return res.status(400).json({ error: 'name, department and designation are required' });
  }
  const email = body.email?.trim();
  if (!email) return res.status(400).json({ error: 'Email is required to create their login account' });
  if (!body.password || body.password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  if (db.prepare('SELECT id FROM employees WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An employee with this email already exists' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'A login account with this email already exists' });
  }
  const roleKey = db.prepare('SELECT key FROM roles WHERE name = ?').get(body.designation)?.key;
  if (!roleKey) return res.status(400).json({ error: 'Choose a valid Role to create their login account' });

  let code = body.employee_code?.trim();
  if (code) {
    if (db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(code)) {
      return res.status(409).json({ error: 'This Employee ID is already in use' });
    }
  } else {
    code = nextEmployeeCode();
  }

  const values = { employee_code: code, stage: 'assigned' };
  HR_EDITABLE_FIELDS.forEach((f) => { values[f] = serializeField(f, body[f]); });
  values.email = email;
  values.status = ['Active', 'On Probation', 'Exited'].includes(body.status) ? body.status : 'Active';

  const createBoth = db.transaction(() => {
    const userInfo = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(body.name.trim(), email, bcrypt.hashSync(body.password, 10), roleKey);
    values.user_id = userInfo.lastInsertRowid;
    const columns = ['employee_code', 'stage', 'user_id', ...HR_EDITABLE_FIELDS];
    const result = db.prepare(`INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map((c) => '@' + c).join(', ')})`).run(values);
    saveCustomFieldValues(result.lastInsertRowid, body.custom_fields);
    return result;
  });
  const info = createBoth();

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

// Stage 2 — one click: HR assigns a draft straight to that same named person's own login
// account. No picking from a list — the draft's name (e.g. "Navya A") is looked up directly
// against the matching, not-yet-linked user account.
router.put('/:id/assign', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const user = db.prepare('SELECT * FROM users WHERE LOWER(name) = LOWER(?)').get(emp.name.trim());
  if (!user) return res.status(400).json({ error: `No account named "${emp.name}" — create one in Role & User Management first.` });
  if (db.prepare('SELECT 1 FROM employees WHERE user_id = ?').get(user.id)) {
    return res.status(409).json({ error: `${emp.name}'s account is already linked to another employee record.` });
  }

  db.prepare('UPDATE employees SET user_id = ?, stage = ?, edit_requested = 0 WHERE id = ?').run(user.id, 'assigned', req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Pause = this employee has exited the company: their login is deactivated (logged out,
// can't sign back in) and their employment status is set to Exited. Reactivate is a rehire —
// status back to Active and the login restored.
router.put('/:id/account-status', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!emp.user_id) return res.status(400).json({ error: 'This employee has no login account to pause yet.' });
  if (emp.user_id === req.user.sub) return res.status(400).json({ error: 'You cannot pause your own account.' });

  const { active } = req.body || {};
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, emp.user_id);
  db.prepare('UPDATE employees SET status = ? WHERE id = ?').run(active ? 'Active' : 'Exited', req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Stage 3 (employee) / general edit. Editing someone else's record is Super Admin/HR Admin
// only — Manager and Assistant Manager can view the Employee list but not edit records here.
// A locked profile still blocks the EMPLOYEE from self-editing (that's the whole point of
// Unlock/Approve-edit) but not Super Admin/HR Admin, who can always go in directly via Edit.
router.put('/:id', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const hr = ['super_admin', 'hr_admin'].includes(req.user.role);
  const own = emp.user_id === req.user.sub;
  if (!hr && !own) return res.status(403).json({ error: 'Insufficient permissions' });

  if (emp.stage === 'locked' && !hr) {
    return res.status(403).json({ error: 'This profile is locked. An approved edit request is required before it can be changed.' });
  }
  if (!hr && emp.stage !== 'assigned') {
    return res.status(403).json({ error: 'You can only edit your profile while it is assigned to you for filling.' });
  }

  // HR resetting this person's login password directly from the edit form (an empty/omitted
  // value means "leave the password unchanged" — this is not exposing the current one).
  if (hr && req.body?.password) {
    if (req.body.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!emp.user_id) return res.status(400).json({ error: 'This employee has no login account yet — assign one first.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), emp.user_id);
  }

  if (req.body?.phone && !isValidIndianPhone(req.body.phone)) {
    return res.status(400).json({ error: 'Phone number must be a valid 10-digit Indian mobile number (starting with 6-9).' });
  }

  const allowed = hr ? HR_EDITABLE_FIELDS : EMPLOYEE_EDITABLE_FIELDS;
  const updated = { ...emp };
  allowed.forEach((f) => { if (req.body?.[f] !== undefined) updated[f] = serializeField(f, req.body[f]); });

  // Changing the phone number invalidates any earlier OTP verification of the old number.
  const phoneChanged = req.body?.phone !== undefined && req.body.phone !== emp.phone;
  if (phoneChanged) { updated.phone_verified = 0; updated.phone_otp_code = null; updated.phone_otp_expires = null; }
  const setCols = phoneChanged ? [...allowed, 'phone_verified', 'phone_otp_code', 'phone_otp_expires'] : allowed;

  db.prepare(`UPDATE employees SET ${setCols.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run(updated);
  saveCustomFieldValues(emp.id, req.body?.custom_fields);

  // Cross-module onboarding automation: if this edit just set a reporting manager (was blank
  // before) or added the first onboarding document, auto-check the matching Recruitment
  // checklist item instead of requiring HR to separately go tick it there.
  if (!emp.reporting_manager?.trim() && updated.reporting_manager?.trim()) {
    autoCompleteOnboardingTask(emp.id, 'Reporting manager assigned');
  }
  if (req.body?.documents !== undefined) {
    const hadDocs = (() => { try { return emp.documents && JSON.parse(emp.documents).length > 0; } catch { return false; } })();
    const hasDocsNow = (() => { try { return updated.documents && JSON.parse(updated.documents).length > 0; } catch { return false; } })();
    if (!hadDocs && hasDocsNow) autoCompleteOnboardingTask(emp.id, 'Documents submitted');
  }

  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Phone verification — send a 6-digit OTP by SMS to the employee's own phone number on file.
// Any HR-admin role may trigger this for someone else, or the employee for their own record.
router.post('/:id/phone/send-otp', async (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const own = emp.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!emp.phone) return res.status(400).json({ error: 'Add a phone number first.' });
  if (!isValidIndianPhone(emp.phone)) return res.status(400).json({ error: 'Phone number must be a valid 10-digit Indian mobile number.' });

  const otp = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('UPDATE employees SET phone_otp_code = ?, phone_otp_expires = ? WHERE id = ?').run(otp, expires, emp.id);

  try {
    await sendSms(`+91${emp.phone}`, 'Verify your phone number', `Your OTP is ${otp}. It expires in 10 minutes.`);
  } catch (err) {
    console.log(`[phone-otp] Could not SMS +91${emp.phone} (${err.message}). OTP: ${otp}`);
  }
  res.json({ message: 'OTP sent to the phone number on file.' });
});

router.post('/:id/phone/verify-otp', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const own = emp.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });

  const { otp } = req.body || {};
  if (!otp) return res.status(400).json({ error: 'Enter the OTP sent to the phone.' });
  if (!emp.phone_otp_code || !emp.phone_otp_expires || new Date(emp.phone_otp_expires) < new Date()) {
    return res.status(400).json({ error: 'OTP expired or not requested — send a new one.' });
  }
  if (otp !== emp.phone_otp_code) return res.status(400).json({ error: 'Incorrect OTP.' });

  db.prepare('UPDATE employees SET phone_verified = 1, phone_otp_code = NULL, phone_otp_expires = NULL WHERE id = ?').run(emp.id);
  res.json({ employee: present(getEmp(emp.id), req.user) });
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
// Raises a hierarchy-approval request (same chain mechanics as Leave/Regularization) instead of
// just flipping a boolean — requires a reason, and every request becomes its own permanent
// history row (see editRequestsFor above), so nothing is lost once it's decided.
router.post('/:id/request-edit', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.user_id !== req.user.sub && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (emp.stage !== 'locked') return res.status(400).json({ error: 'Only a locked profile needs an edit request.' });
  const reason = req.body?.reason?.trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to request an edit.' });
  if (editRequestsFor(emp.name).some((r) => r.status === 'Pending')) {
    return res.status(400).json({ error: 'You already have a pending edit request awaiting approval.' });
  }
  const stage = bottomRole();
  db.prepare('INSERT INTO approvals (type, requester, detail, current_stage_role_id) VALUES (?, ?, ?, ?)')
    .run('Profile Edit', emp.name, reason, stage ? stage.id : null);
  res.status(201).json({ employee: present(getEmp(req.params.id), req.user) });
});

// HR directly unlocking a locked profile, independent of the request-edit chain above (e.g. HR
// wants to fix something the employee never asked to change). The reasoned, hierarchy-approved
// path is POST /approvals/:id/approve on the 'Profile Edit' row itself, not this route.
router.post('/:id/approve-edit', requireHR, (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.stage !== 'locked') return res.status(400).json({ error: 'Only a locked profile can be unlocked.' });
  db.prepare("UPDATE employees SET stage = 'assigned' WHERE id = ?").run(req.params.id);
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

router.delete('/:id', requireHR, (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can delete an employee record' });
  const info = db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Employee not found' });
  res.status(204).send();
});

export default router;

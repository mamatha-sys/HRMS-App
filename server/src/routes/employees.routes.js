import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { requireAuth, requireAuthOrFileToken } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { sendSms, sendEmail } from '../utils/channels.js';
import { filterToScopeOrOwnDepartment } from '../utils/scope.js';
import { autoCompleteOnboardingTask } from '../utils/onboarding.js';
import { autoCompleteOffboardingTask } from '../utils/offboarding.js';
import { bottomRole, approvalChainLabel } from '../utils/chain.js';
import { CSV_FIELDS, DIRECT_COLUMN_KEYS } from '../utils/employeeCsvFields.js';
import { verifyDocumentFields } from '../utils/documentVerify.js';
import { monthlyAttendanceSummary } from '../utils/attendanceCore.js';
import { applyCtcSplit } from './payroll.routes.js';

const router = Router();

// A photo/document value is either a real data URL (uploaded through the app) or a plain http(s)
// link (came in via Excel bulk import's "photo/document link" columns — see POST /bulk). Serving
// both through the same URL shape means an Excel export's hyperlink always looks the same
// regardless of which kind the underlying employee has.
function serveDataUrlOrRedirect(res, value, { download } = {}) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(value || '');
  if (!m) return res.redirect(value); // plain external link — send the browser straight there
  res.setHeader('Content-Type', m[1]);
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${download.replace(/"/g, '')}"`);
  res.send(Buffer.from(m[2], 'base64'));
}

// Registered before requireAuth below so these can work as a plain clickable link opened
// straight from an exported Excel file — see GET /reports/employees.xlsx, which builds
// hyperlinks pointing here with a short file-access token as ?token= (not the exporting user's
// full session token — that made the URL long enough that Excel's Windows hyperlink handler
// silently fails to open it). A file-token request is already authorized by construction; a
// normal session-token request (the in-app photo/document viewers) still gets the usual
// HR-or-own-record check.
router.get('/:id/photo', requireAuthOrFileToken('photo'), (req, res) => {
  const emp = db.prepare('SELECT id, photo, user_id FROM employees WHERE id = ?').get(req.params.id);
  if (!emp?.photo) return res.status(404).json({ error: 'No photo on file for this employee.' });
  if (!req.fileTokenAuthorized && !canModuleAdmin(req.user.role, '02') && emp.user_id !== req.user.sub) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  serveDataUrlOrRedirect(res, emp.photo);
});

router.get('/:id/documents/:index', requireAuthOrFileToken('doc', 'index'), (req, res) => {
  const emp = db.prepare('SELECT id, documents, user_id FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!req.fileTokenAuthorized && !canModuleAdmin(req.user.role, '02') && emp.user_id !== req.user.sub) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  let docs = [];
  try { docs = emp.documents ? JSON.parse(emp.documents) : []; } catch { docs = []; }
  const doc = docs[Number(req.params.index)];
  if (!doc?.dataUrl) return res.status(404).json({ error: 'Document not found' });
  serveDataUrlOrRedirect(res, doc.dataUrl, { download: doc.name || 'document' });
});

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

// Senior Team Lead/Team Lead are always scoped to their own assigned department(s)/team(s) for
// Employee Management — even if granted a write action elsewhere in Manage Roles, they never get
// unrestricted company-wide visibility here. Assistant Manager is deliberately NOT in this list:
// unlike STL/TL, Assistant Manager is meant to see all departments' employee data once granted
// real access (matching Manager/HR Admin), so it's gated purely by isHR() below like they are.
const STL_TL_ROLES = ['stl', 'tl'];

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
  'department', 'branch', 'team_id', 'designation', 'date_of_joining', 'reporting_manager', 'status', 'shift', 'ctc',
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

// Designation is drawn from the same roles catalog that decides real RBAC permissions (see
// systemRoles in the client) — POST / (create) already requires a matching role and creates the
// login with it, but PUT /:id (edit) and /:id/transfer only ever touched employees.designation,
// never the linked users.role, so someone's shown Role/Designation could silently drift away from
// what they can actually do (e.g. promoted to "Team Lead (TL)" on their profile while their login
// stayed on Employee-tier access). Call this everywhere designation can change after creation, so
// the two can never drift apart again — safe to call even when the designation didn't actually
// change, since re-applying the same, already-correct role is a no-op.
function syncUserRoleToDesignation(userId, designation) {
  if (!userId || !designation) return;
  const roleKey = db.prepare('SELECT key FROM roles WHERE name = ?').get(designation)?.key;
  if (roleKey) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(roleKey, userId);
}

function serializeField(field, value) {
  if (field === 'team_id') return value === '' || value == null ? null : Number(value);
  // email is UNIQUE — an empty string (unlike NULL) collides with every other blank email, so
  // treat '' the same as "not provided" instead of storing it as a real value.
  if (field === 'email') return value ? value : null;
  if (field === 'employment_type') return ['Fresher', 'Experienced'].includes(value) ? value : null;
  if (field === 'ctc') return value ? Math.max(0, parseInt(value, 10) || 0) : null; // INTEGER column, annual CTC
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

// Dated department/designation/team change history — newest first, so "current" is transfers[0]
// and the profile can show "transferred on <date>" next to the designation.
function transfersFor(employeeId) {
  return db.prepare('SELECT * FROM employee_transfers WHERE employee_id = ? ORDER BY transfer_date DESC, created_at DESC').all(employeeId);
}

// Fields that meaningfully indicate a profile is actually filled in — deliberately not every
// column (e.g. skips optional ones like education/experience/skills) so 100% represents "the
// stuff that actually matters for onboarding/payroll/compliance", not "every field touched".
const PROFILE_COMPLETION_FIELDS = [
  'phone', 'email', 'date_of_birth', 'photo',
  'address_line1', 'address_city', 'address_state', 'address_pincode',
  'emergency_contact_name', 'emergency_contact_number',
  'bank_name', 'bank_account_number', 'ifsc_code', 'pan_number', 'aadhaar_number',
  'reporting_manager', 'date_of_joining'
];
function profileCompletionPct(emp, documents) {
  const filled = PROFILE_COMPLETION_FIELDS.filter((f) => emp[f]?.toString().trim()).length + (documents.length > 0 ? 1 : 0);
  const total = PROFILE_COMPLETION_FIELDS.length + 1; // +1 for "has at least one document"
  return Math.round((filled / total) * 100);
}

function hydrate(emp) {
  let documents = [];
  if (emp.documents) { try { documents = JSON.parse(emp.documents); } catch { documents = []; } }
  // phone_otp_code/phone_otp_expires and their email equivalents are one-time secrets in transit
  // to the employee — never echo them back over the API to anyone (HR included) viewing this record.
  const { phone_otp_code, phone_otp_expires, email_otp_code, email_otp_expires, ...rest } = emp;
  const editRequests = editRequestsFor(emp.name);
  return {
    ...rest, documents, phone_verified: !!emp.phone_verified, email_verified: !!emp.email_verified, custom_fields: customFieldValuesFor(emp.id),
    profile_completion: profileCompletionPct(emp, documents),
    edit_requests: editRequests,
    edit_request_count: editRequests.length,
    // Derived, not the raw column — a Pending row in the chain is the actual source of truth now.
    edit_requested: editRequests.some((r) => r.status === 'Pending'),
    edit_chain_label: approvalChainLabel(),
    transfers: transfersFor(emp.id)
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

// Attrition Risk: an HR/manager-only advisory signal (never shown to the employee themself — see
// GET / below, which only attaches this on the HR/scoped-role branches) blending three things
// already tracked elsewhere in the app — this month's attendance, open disciplinary cases, and
// how much leave was taken in the last 90 days (a recent-pace check, distinct from Leave's own
// year-to-date "Approval Suggestion" number). Purely advisory, same spirit as Progress Score and
// Approval Suggestion: always shows the real numbers + specific reasons, never blocks anything.
function attritionRiskFor(employeeId) {
  const month = new Date().toISOString().slice(0, 7);
  const { attendancePct } = monthlyAttendanceSummary(employeeId, month);
  const cases = db.prepare("SELECT status FROM disciplinary_cases WHERE employee_id = ?").all(employeeId);
  const openCases = cases.filter((c) => c.status === 'Open').length;
  const leaveDaysRecent = db.prepare(`
    SELECT COALESCE(SUM(days), 0) AS total FROM leaves
    WHERE employee_id = ? AND cancelled = 0 AND status IN ('Pending', 'Approved') AND from_date >= date('now', '-90 days')
  `).get(employeeId).total;

  let score = 0;
  const reasons = [];
  if (attendancePct < 70) { score += 35; reasons.push(`attendance is low this month (${attendancePct}%)`); }
  else if (attendancePct < 85) { score += 15; reasons.push(`attendance has dipped this month (${attendancePct}%)`); }
  if (openCases > 0) { score += 35; reasons.push(`${openCases} open disciplinary case${openCases === 1 ? '' : 's'}`); }
  if (leaveDaysRecent > 15) { score += 30; reasons.push(`${leaveDaysRecent} leave days taken in the last 90 days`); }
  else if (leaveDaysRecent > 8) { score += 15; reasons.push(`${leaveDaysRecent} leave days taken in the last 90 days — above typical pace`); }

  score = Math.min(100, score);
  const band = score >= 55 ? 'High' : score >= 25 ? 'Medium' : 'Low';
  return { score, band, attendancePct, openCases, leaveDaysRecent, reasons };
}
// account_active mirrors the linked login's users.active flag (null if there's no login yet) so
// the Employee list can show/toggle Pause-Reactivate without a separate trip to User Management.
const EMP_WITH_TEAM = 'SELECT e.*, t.name AS team_name, u.active AS account_active FROM employees e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN users u ON u.id = e.user_id';
const getEmp = (id) => db.prepare(`${EMP_WITH_TEAM} WHERE e.id = ?`).get(id);

// AI-assisted document check: OCRs the document the caller is already looking at (sent in the
// request body, not fetched from the DB) and cross-checks every relevant typed field against it
// — not just the name (which document's typed fields are "relevant" is decided client-side, per
// document type — see relevantFieldsFor in Employees.jsx). Open to any authenticated user rather
// than HR-only, since both the HR "Add/Edit Employee" form and the employee's own self-service
// form use it, on a document the requester already has in front of them either way.
router.post('/verify-document', async (req, res) => {
  try {
    const result = await verifyDocumentFields(req.body?.documentLabel, req.body?.fields, req.body?.dataUrl);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Attaches attrition_risk to everyone still employed — including On Probation, where the same
// signals (attendance, disciplinary record) matter just as much for a confirm/extend/let-go call
// as they do for a confirmed employee's flight risk. Only Exited is excluded (nothing left to
// predict). Never called on the self-view branch below, so an employee never sees their own flag.
const withAttritionRisk = (rows) => rows.map((r) => (r.status !== 'Exited' ? { ...r, attrition_risk: attritionRiskFor(r.id) } : r));

// STL/TL visibility, department-based by default: if Super Admin has explicitly configured a
// supervisor scope for this person (User Management → team or department grants — e.g. Sirisha
// scoped to just Team-A, or an STL spanning multiple teams/departments), that explicit
// configuration wins, exactly as before. Otherwise — no configuration at all, which is the normal
// starting state for a newly-assigned TL in ANY department (Medical, Educational, Manufacturing,
// BDE, R&D, HR, or one added after this code was written) — they automatically default to seeing
// their own department, so a fresh TL is useful out of the box without Super Admin having to
// configure User Management first. This is purely derived from the employee's own `department`
// field, so it needs zero per-department setup and updates immediately if that field changes.
function scopedTeamRows(req, allRows) {
  const me = myEmployee(req.user.sub);
  if (!me) return [];
  return filterToScopeOrOwnDepartment(allRows, req.user.role, me.id);
}

router.get('/', (req, res) => {
  // Checked BEFORE isHR, deliberately: STL/TL are scoped-by-nature roles — they must never see
  // company-wide data, even if Super Admin grants one of them a write action on Employee
  // Management in Manage Roles. A granted action making canModuleAdmin() true is about WHAT they
  // can do, not about widening WHICH employees they can see — those are separate questions, and
  // this order keeps them that way. Same fetch-then-filter scoping as Attendance/Leave.
  // Assistant Manager is NOT in STL_TL_ROLES — once granted real access, they see company-wide
  // data via the isHR branch below, same tier as Manager/HR Admin.
  if (STL_TL_ROLES.includes(req.user.role)) {
    const rows = db.prepare(`${EMP_WITH_TEAM} ORDER BY e.id`).all();
    const scoped = scopedTeamRows(req, rows);
    // Seeing your own record is self-service, intrinsic to every employee, and separate from
    // the supervisor-scope grant that decides which OTHER employees you can see (rbac.js's own
    // stated philosophy). A TL's own department/team isn't guaranteed to fall inside their own
    // configured scope (e.g. no scope assigned yet, or they supervise a different team than the
    // one they belong to) — without this, "My Profile" would wrongly report no linked record.
    if (!scoped.some((r) => r.user_id === req.user.sub)) {
      const own = rows.find((r) => r.user_id === req.user.sub);
      if (own) scoped.push(own);
    }
    return res.json({ employees: withAttritionRisk(scoped).map((r) => present(r, req.user)) });
  }
  if (isHR(req.user.role)) {
    const rows = db.prepare(`${EMP_WITH_TEAM} ORDER BY e.id`).all();
    return res.json({ employees: withAttritionRisk(rows).map((r) => present(r, req.user)) });
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

// Declared before '/:id' so 'import-template.csv' is never swallowed as an id — same reason
// '/custom-fields' above it is.
// Sample CSV covering every importable field (built-in + active custom fields) with one example
// row, so a Super Admin/HR always knows exactly which columns bulk import actually accepts.
router.get('/import-template.csv', requireHR, (req, res) => {
  const customFields = activeCustomFields();
  const headers = [...CSV_FIELDS.map((f) => f.key), ...customFields.map((f) => f.key)];
  const sampleRow = [...CSV_FIELDS.map((f) => f.sample), ...customFields.map(() => '')];
  const escape = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const csv = [headers.join(','), sampleRow.map(escape).join(',')].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.csv"');
  res.send(csv);
});

router.get('/:id', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  // Same precedence as GET / above: STL/TL are checked against scope first and ALWAYS, regardless
  // of isHR — never falls through to unrestricted access just because Super Admin granted them
  // some write action on Employee Management elsewhere. Assistant Manager is excluded from
  // STL_TL_ROLES on purpose — they get company-wide access via isHR below once granted real access.
  if (STL_TL_ROLES.includes(req.user.role)) {
    const inScope = emp.user_id === req.user.sub || scopedTeamRows(req, [emp]).length > 0;
    if (!inScope) return res.status(403).json({ error: 'Insufficient permissions' });
  } else if (!isHR(req.user.role) && emp.user_id !== req.user.sub) {
    return res.status(403).json({ error: 'Insufficient permissions' });
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
  if (body.date_of_joining) {
    const oneYearOut = new Date();
    oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
    if (new Date(body.date_of_joining) > oneYearOut) {
      return res.status(400).json({ error: 'Date of joining cannot be more than a year in the future' });
    }
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
  // Not provided → leave the key out of the INSERT entirely so the column's own
  // NOT NULL DEFAULT applies, instead of inserting an explicit NULL that violates it.
  if (values.shift == null) delete values.shift;

  const createBoth = db.transaction(() => {
    const userInfo = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(body.name.trim(), email, bcrypt.hashSync(body.password, 10), roleKey);
    values.user_id = userInfo.lastInsertRowid;
    const columns = ['employee_code', 'stage', 'user_id', ...HR_EDITABLE_FIELDS].filter((c) => c in values);
    const result = db.prepare(`INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map((c) => '@' + c).join(', ')})`).run(values);
    saveCustomFieldValues(result.lastInsertRowid, body.custom_fields);
    return result;
  });
  const info = createBoth();

  res.status(201).json({ employee: present(getEmp(info.lastInsertRowid), req.user) });

  // Welcome email — best-effort, after responding, never blocks/fails employee creation itself if
  // email isn't configured or the send fails (same fire-and-forget shape as the AI interview
  // invite in recruitment.routes.js). Includes the login the HR admin just set so the new hire can
  // sign in immediately — a normal "here are your account details" onboarding email.
  const loginUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}/login`;
  sendEmail(
    email,
    'Welcome — your HRMS account is ready',
    `Hi ${body.name.trim()},\n\nWelcome aboard! Your HRMS account has been created.\n\nLogin: ${loginUrl}\nEmail: ${email}\nPassword: ${body.password}\n\nWe recommend changing your password after your first login.\n\nLooking forward to having you on the team!`
  ).catch(() => {});
});

// Bulk import — inserts already-onboarded (locked) records. Full-field: every column CSV_FIELDS
// knows about (see employeeCsvFields.js), not just the original
// name/email/designation/department/branch/phone subset, plus any active
// Super-Admin-defined custom field whose `key` appears as a CSV column. Values go through the
// same serializeField() the single-employee edit form uses, so a CSV round-trips identically to
// filling the form by hand (team resolved by name against the row's department, employment_type/
// status validated against their allowed values, etc.).
router.post('/bulk', requireHR, (req, res) => {
  const { rows, defaultDepartment, defaultBranch, defaultJoiningDate } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' });

  const customFieldByKey = {};
  activeCustomFields().forEach((f) => { customFieldByKey[f.key] = f; });

  function resolveTeamId(teamName, departmentName) {
    if (!teamName?.trim()) return null;
    const dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(departmentName);
    if (!dept) return null;
    return db.prepare('SELECT id FROM teams WHERE name = ? AND department_id = ?').get(teamName.trim(), dept.id)?.id || null;
  }

  const results = { inserted: 0, skipped: 0, errors: [], payrollWarnings: [] };
  const insertOne = db.transaction((list) => {
    list.forEach((raw, i) => {
      const name = raw.name?.trim();
      const email = raw.email?.trim();
      const designation = raw.designation?.trim();
      const department = (raw.department || defaultDepartment || '').trim();
      const dateOfJoining = (raw.date_of_joining || defaultJoiningDate || '').trim();
      if (!name || !email || !department || !designation || !dateOfJoining) {
        results.errors.push(`Row ${i + 1}: missing name/email/department/designation/joining date`);
        return;
      }
      if (db.prepare('SELECT id FROM employees WHERE email = ?').get(email)) { results.skipped++; return; }

      const values = { name, email, department, designation, date_of_joining: dateOfJoining };
      DIRECT_COLUMN_KEYS.forEach((key) => {
        if (values[key] !== undefined) return; // already set above from name/email/department/designation/date_of_joining
        let v = raw[key];
        if (key === 'branch' && !v) v = defaultBranch;
        if (key === 'status' && !['Active', 'On Probation', 'Exited'].includes(v)) v = 'Active';
        if (key === 'pay_type' && !['Package', 'Stipend'].includes(v)) v = 'Package'; // CHECK-constrained column
        if (key === 'ctc') v = v ? Math.max(0, parseInt(v, 10) || 0) : null; // INTEGER column
        // Not provided → leave shift out of `values` so the NOT NULL DEFAULT applies below,
        // instead of inserting an explicit NULL that violates it.
        if (key === 'shift' && !v) return;
        values[key] = serializeField(key, typeof v === 'string' ? v.trim() || null : v ?? null);
      });
      values.team_id = resolveTeamId(raw.team, department);

      // Plain CSV rows never carry these (a data URL / a {name,dataUrl}[] don't fit a CSV cell —
      // see employeeCsvFields.js), but a row from Employee Management's full JSON export does, so
      // that export/import round-trip keeps every employee's photo and documents, not just the
      // spreadsheet-friendly fields.
      if (raw.photo) values.photo = raw.photo;
      let docs = raw.documents;
      if (typeof docs === 'string') { try { docs = JSON.parse(docs); } catch { docs = null; } }
      if (Array.isArray(docs) && docs.length) values.documents = JSON.stringify(docs);

      // A per-row try/catch — one row hitting an unexpected constraint (or anything else) turns
      // into an error entry for that row alone, instead of throwing inside the transaction and
      // silently rolling back every row already inserted in this same batch.
      try {
        const columns = Object.keys(values);
        const info = db.prepare(`
          INSERT INTO employees (employee_code, stage, ${columns.join(', ')})
          VALUES (?, 'locked', ${columns.map(() => '?').join(', ')})
        `).run(nextEmployeeCode(), ...columns.map((c) => values[c]));

        // Any CSV column matching an active custom field's key becomes that field's value —
        // same storage saveCustomFieldValues() already uses for the form, keyed by field_id.
        const customValues = {};
        Object.entries(raw).forEach(([k, v]) => {
          if (customFieldByKey[k]) customValues[customFieldByKey[k].id] = v;
        });
        if (Object.keys(customValues).length) saveCustomFieldValues(info.lastInsertRowid, customValues);

        // A CTC came in on this row — apply it to Payroll right away, same as HR entering it
        // by hand on the Payroll page, so imported employees don't sit at Gross/Net = ₹0 until
        // someone re-enters a CTC that was already right there in the CSV.
        if (values.ctc && values.pay_type !== 'Stipend') {
          try { applyCtcSplit(info.lastInsertRowid, values.ctc); }
          catch (err) { results.payrollWarnings.push(`Row ${i + 1} (${name}): CTC not applied to Payroll — ${err.message}`); }
        }

        results.inserted++;
      } catch (err) {
        results.errors.push(`Row ${i + 1}: ${err.message}`);
      }
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
  // The account being linked here was created independently in Role & User Management, often
  // with a default/placeholder role — without this, it can permanently disagree with this
  // employee's actual designation (e.g. profile says "Team Lead (TL)" but the login stays on
  // Employee-tier access) since nothing else ever re-visits an already-linked account's role.
  syncUserRoleToDesignation(user.id, emp.designation);
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
  // Login only ever gets revoked here — an employee's Last Working Day arriving does NOT do this
  // automatically (see autoMarkExitedEmployees in recruitment.routes.js) — so this is the one real
  // moment the "Revoke system login access" offboarding checklist item should tick itself off.
  if (!active) autoCompleteOffboardingTask(req.params.id, 'Revoke system login access');
  res.json({ employee: present(getEmp(req.params.id), req.user) });
});

// Transfer: department/designation/team change with an effective date, kept as its own dated
// history (employee_transfers) instead of a plain field edit that would silently overwrite the
// old value — so the profile can show what changed and when, not just the current designation.
// STL/TL do not get this action — same tier as full Edit, Super Admin/HR Admin only.
router.post('/:id/transfer', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { department, designation, team_id, transfer_date, reason } = req.body || {};
  if (!transfer_date) return res.status(400).json({ error: 'transfer_date is required' });
  const toDepartment = department?.trim() || emp.department;
  const toDesignation = designation?.trim() || emp.designation;
  const toTeamId = team_id !== undefined ? (team_id || null) : emp.team_id;
  if (toDepartment === emp.department && toDesignation === emp.designation && toTeamId === emp.team_id) {
    return res.status(400).json({ error: 'Nothing changed — pick a new department, designation, or team to transfer to.' });
  }
  db.prepare(`
    INSERT INTO employee_transfers (employee_id, from_department, to_department, from_designation, to_designation, from_team_id, to_team_id, transfer_date, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(emp.id, emp.department, toDepartment, emp.designation, toDesignation, emp.team_id, toTeamId, transfer_date, reason?.trim() || null, req.user.name || null);
  db.prepare('UPDATE employees SET department = ?, designation = ?, team_id = ? WHERE id = ?').run(toDepartment, toDesignation, toTeamId, emp.id);
  syncUserRoleToDesignation(emp.user_id, toDesignation);

  // If this person's own old department/team was itself one of their granted supervisor scopes
  // (the common case for a TL/STL who supervises their own home team/department — see
  // scopedTeamRows's same "no explicit scope → default to own department" precedent), move that
  // specific grant along with them, so a transferred TL/STL sees their new team, not their old
  // one. Any OTHER scope grant unrelated to their old assignment (e.g. an STL additionally scoped
  // over a separate department) is left untouched — this transfer says nothing about that.
  if (toDepartment !== emp.department) {
    const oldDept = db.prepare('SELECT id FROM departments WHERE name = ?').get(emp.department);
    const newDept = db.prepare('SELECT id FROM departments WHERE name = ?').get(toDepartment);
    if (oldDept && newDept) {
      db.prepare('UPDATE supervisor_scopes SET department_id = ? WHERE employee_id = ? AND department_id = ?').run(newDept.id, emp.id, oldDept.id);
    }
  }
  if (emp.team_id && toTeamId && toTeamId !== emp.team_id) {
    db.prepare('UPDATE supervisor_scopes SET team_id = ? WHERE employee_id = ? AND team_id = ?').run(toTeamId, emp.id, emp.team_id);
  }

  res.status(201).json({ employee: present(getEmp(req.params.id), req.user) });
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

  // Employee ID is otherwise fixed for life once auto-assigned at creation — it's referenced by
  // code (not just id) across Payroll/Attendance/Reports exports, so changing it is Super Admin
  // only, not the general HR Admin edit tier.
  let employeeCodeChanged = false;
  if (req.user.role === 'super_admin' && req.body?.employee_code !== undefined) {
    const newCode = req.body.employee_code?.trim();
    if (!newCode) return res.status(400).json({ error: 'Employee ID cannot be blank' });
    if (newCode !== emp.employee_code) {
      const conflict = db.prepare('SELECT id FROM employees WHERE employee_code = ? AND id != ?').get(newCode, emp.id);
      if (conflict) return res.status(409).json({ error: 'This Employee ID is already in use' });
      employeeCodeChanged = true;
    }
  }

  const allowed = hr ? HR_EDITABLE_FIELDS : EMPLOYEE_EDITABLE_FIELDS;
  const updated = { ...emp };
  allowed.forEach((f) => { if (req.body?.[f] !== undefined) updated[f] = serializeField(f, req.body[f]); });
  if (employeeCodeChanged) updated.employee_code = req.body.employee_code.trim();

  // Changing the phone number invalidates any earlier OTP verification of the old number; changing
  // the email does the same for email verification.
  const phoneChanged = req.body?.phone !== undefined && req.body.phone !== emp.phone;
  if (phoneChanged) { updated.phone_verified = 0; updated.phone_otp_code = null; updated.phone_otp_expires = null; }
  const emailChanged = req.body?.email !== undefined && req.body.email !== emp.email;
  if (emailChanged) { updated.email_verified = 0; updated.email_otp_code = null; updated.email_otp_expires = null; }
  const setCols = [
    ...allowed,
    ...(phoneChanged ? ['phone_verified', 'phone_otp_code', 'phone_otp_expires'] : []),
    ...(emailChanged ? ['email_verified', 'email_otp_code', 'email_otp_expires'] : []),
    ...(employeeCodeChanged ? ['employee_code'] : [])
  ];

  // Keep the linked login (users.email) in sync whenever the employee's own email is edited —
  // without this, users.email silently drifts from what's shown on the profile, and anything
  // keyed off login email (password reset, future "sign in" flows) quietly breaks for that person.
  if (emailChanged && emp.user_id && updated.email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(updated.email, emp.user_id);
    if (conflict) return res.status(409).json({ error: 'A login account with this email already exists' });
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(updated.email, emp.user_id);
  }

  db.prepare(`UPDATE employees SET ${setCols.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`).run(updated);
  saveCustomFieldValues(emp.id, req.body?.custom_fields);

  // Keep the linked login's actual RBAC role in lockstep with the edited Role/Designation —
  // allowed.includes('designation') is only true for the HR edit tier (HR_EDITABLE_FIELDS), never
  // an employee's own self-edit, so this can't be used to self-promote.
  if (allowed.includes('designation') && req.body?.designation !== undefined) {
    syncUserRoleToDesignation(emp.user_id, updated.designation);
  }

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

// Email verification — same OTP shape as phone, delivered by email instead of SMS.
router.post('/:id/email/send-otp', async (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const own = emp.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!emp.email) return res.status(400).json({ error: 'Add an email address first.' });

  const otp = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('UPDATE employees SET email_otp_code = ?, email_otp_expires = ? WHERE id = ?').run(otp, expires, emp.id);

  try {
    await sendEmail(emp.email, 'Verify your email address', `Your OTP is ${otp}. It expires in 10 minutes.`);
  } catch (err) {
    console.log(`[email-otp] Could not email ${emp.email} (${err.message}). OTP: ${otp}`);
  }
  res.json({ message: 'OTP sent to the email address on file.' });
});

router.post('/:id/email/verify-otp', (req, res) => {
  const emp = getEmp(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const own = emp.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });

  const { otp } = req.body || {};
  if (!otp) return res.status(400).json({ error: 'Enter the OTP sent to the email.' });
  if (!emp.email_otp_code || !emp.email_otp_expires || new Date(emp.email_otp_expires) < new Date()) {
    return res.status(400).json({ error: 'OTP expired or not requested — send a new one.' });
  }
  if (otp !== emp.email_otp_code) return res.status(400).json({ error: 'Incorrect OTP.' });

  db.prepare('UPDATE employees SET email_verified = 1, email_otp_code = NULL, email_otp_expires = NULL WHERE id = ?').run(emp.id);
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
  const emp = db.prepare('SELECT user_id FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  // Deleting the employee record must not leave their login account active — otherwise the
  // deleted employee can still sign in even though their employee record is gone.
  const deleteBoth = db.transaction(() => {
    if (emp.user_id) db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(emp.user_id);
    db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  });
  deleteBoth();
  res.status(204).send();
});

export default router;

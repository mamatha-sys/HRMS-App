import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';

// Roles that get the full HR list view (browse employee records) vs. self-service "My Profile".
const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Of those, only these can actually create/onboard/pause records — a Senior Team Lead/Team Lead
// gets read access to their assigned departments/teams (via a scoped GET /employees on the
// server) but not module '02' admin, so Add Employee/Approve/Reject/Unlock/Pause stay hidden.
const WRITE_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
// Manager/Assistant Manager/HR Admin are employees too, same as STL/TL — they also get their
// own "My Profile" card above the (company-wide, unscoped) employee list, rather than only the
// admin table. Super Admin is a pure system-administrator account with no such expectation.
const SELF_SERVICE_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];

const STAGE_LABEL = { draft: 'Draft', assigned: 'Assigned', submitted: 'Submitted', locked: 'Locked' };
const STAGE_CLASS = { draft: 'pending', assigned: 'info', submitted: 'present', locked: 'locked' };

const EMPTY_FORM = {
  employee_code: '', name: '', email: '', email_verified: false, password: '', phone: '', phone_verified: false, photo: '', date_of_birth: '',
  emergency_contact_name: '', emergency_contact_relation: '', emergency_contact_number: '',
  address_type: '', address_line1: '', address_line2: '',
  address_city: '', address_district: '', address_state: '', address_country: '', address_pincode: '',
  department: '', branch: '', team_id: '', designation: '', date_of_joining: '', reporting_manager: '', status: 'Active',
  shift: 'General (9:00 AM – 6:00 PM)', employment_type: '',
  bank_name: '', bank_account_number: '', ifsc_code: '',
  pan_number: '', aadhaar_number: '', uan_number: '', pf_number: '', esi_number: '',
  education: '', experience: '', skills: '', documents: [], custom_fields: {}
};

// Field-level input validation — 'text' fields strip out digits as you type, 'number' fields
// strip out everything but digits, 'alphanumeric' fields (PAN/IFSC/PF number — genuinely mixed
// letters+digits, e.g. PAN's ABCDE1234F format) strip anything else and force uppercase, matching
// how these IDs are always written. Fields not listed here (dates, free-text notes, dropdowns)
// are left alone.
const FIELD_KIND = {
  name: 'text', emergency_contact_name: 'text', emergency_contact_relation: 'text',
  address_city: 'text', address_district: 'text', address_state: 'text', address_country: 'text',
  bank_name: 'text', reporting_manager: 'text',
  emergency_contact_number: 'number', address_pincode: 'number', bank_account_number: 'number',
  aadhaar_number: 'number', uan_number: 'number', esi_number: 'number',
  pan_number: 'alphanumeric', ifsc_code: 'alphanumeric', pf_number: 'alphanumeric'
};
const FIELD_MAXLEN = {
  address_pincode: 6, aadhaar_number: 12, uan_number: 12, esi_number: 10,
  pan_number: 10, ifsc_code: 11, emergency_contact_number: 10
};
function sanitizeFieldValue(key, value) {
  const kind = FIELD_KIND[key];
  let v = value;
  if (kind === 'number') v = v.replace(/\D/g, '');
  else if (kind === 'text') v = v.replace(/[^A-Za-z\s.'-]/g, '');
  else if (kind === 'alphanumeric') v = v.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const max = FIELD_MAXLEN[key];
  return max ? v.slice(0, max) : v;
}

// Indian bank account numbers vary by bank (no universal checksum) but are always 9–18 digits —
// this is a format sanity check, not real-time confirmation the account exists at the bank (that
// would need a paid penny-drop/bank-verification API, not something available for free).
function bankAccountHint(value) {
  if (!value) return null;
  const valid = value.length >= 9 && value.length <= 18;
  return (
    <div className="note" style={{ color: valid ? '#1E8E5A' : '#B3401E', marginTop: 2 }}>
      {valid ? `✓ Valid format (${value.length} digits)` : `⚠ Invalid — account numbers are 9–18 digits (currently ${value.length})`}
    </div>
  );
}

const SHIFT_OPTIONS = ['General (9:00 AM – 6:00 PM)'];

// Document names offered when attaching a file — scoped to Fresher vs Experienced so, e.g., a
// Fresher never sees "Experience Letter" as an option and an Experienced hire never sees
// "Provisional Certificate". Unset employment type shows everything (nothing to narrow by yet).
const COMMON_DOC_NAMES = ['Photo', 'Aadhaar Card', 'PAN Card', 'Address Proof', 'Resume', 'Degree Certificate'];
const FRESHER_ONLY_DOC_NAMES = ['10th Marksheet', '12th Marksheet', 'Provisional Certificate'];
const EXPERIENCED_ONLY_DOC_NAMES = ['Offer Letter (Previous Company)', 'Experience Letter', 'Relieving Letter', 'Latest Salary Slip', 'Form 16'];
function docNameOptionsFor(employmentType) {
  if (employmentType === 'Fresher') return [...COMMON_DOC_NAMES, ...FRESHER_ONLY_DOC_NAMES];
  if (employmentType === 'Experienced') return [...COMMON_DOC_NAMES, ...EXPERIENCED_ONLY_DOC_NAMES];
  return [...COMMON_DOC_NAMES, ...FRESHER_ONLY_DOC_NAMES, ...EXPERIENCED_ONLY_DOC_NAMES];
}

// Shared by the HR edit form and the employee's own self-service form: pick what a document IS
// before attaching it, rather than defaulting its label to the raw filename. `employeeName` is
// the currently-typed name on the form (not necessarily saved yet) — used for the AI "Verify
// name" check, which cross-reads the document's own text via OCR rather than trusting the label.
function DocumentsEditor({ documents, employmentType, editable, employeeName, onAdd, onRename, onRemove }) {
  const [pickName, setPickName] = useState('');
  const [customName, setCustomName] = useState('');
  const [verifying, setVerifying] = useState(null); // index currently being checked
  const [results, setResults] = useState({}); // index -> { match, note, extractedText } | { error }
  const options = docNameOptionsFor(employmentType);
  const resolvedName = (pickName === '__other__' ? customName : pickName).trim();

  async function onFiles(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length || !resolvedName) return;
    onAdd(files, resolvedName);
    setPickName(''); setCustomName('');
  }

  async function verifyDoc(idx) {
    if (!employeeName?.trim()) { setResults((r) => ({ ...r, [idx]: { error: 'Enter the employee name first.' } })); return; }
    setVerifying(idx);
    setResults((r) => ({ ...r, [idx]: null }));
    try {
      const res = await api.post('/employees/verify-document', { name: employeeName, dataUrl: documents[idx].dataUrl });
      setResults((r) => ({ ...r, [idx]: res.data }));
    } catch (err) {
      setResults((r) => ({ ...r, [idx]: { error: err.response?.data?.error || 'Could not verify this document.' } }));
    } finally {
      setVerifying(null);
    }
  }

  return (
    <div>
      {documents.length === 0 && <div className="note" style={{ marginBottom: 6 }}>No documents added yet.</div>}
      {documents.map((doc, idx) => {
        const result = results[idx];
        return (
          <div key={idx} style={{ marginBottom: 6 }}>
            <div className="row">
              <input value={doc.name} disabled={!editable} onChange={(e) => onRename(idx, e.target.value)} placeholder="Document label" style={{ flex: '2 1 200px' }} />
              <a href={doc.dataUrl} download={doc.name} className="crumb" style={{ flexShrink: 0 }}>view</a>
              <button type="button" onClick={() => verifyDoc(idx)} disabled={verifying === idx} style={{ flexShrink: 0 }} title="AI-check whether this document's text matches the typed name">
                {verifying === idx ? 'Checking…' : '🔍 Verify name'}
              </button>
              {editable && <button type="button" onClick={() => onRemove(idx)} style={{ flexShrink: 0 }}>Remove</button>}
            </div>
            {result?.error && <div className="note" style={{ color: '#B3401E', marginTop: 2 }}>⚠ {result.error}</div>}
            {result && !result.error && result.match === true && <div className="note" style={{ color: '#1E8E5A', marginTop: 2 }}>✓ Name matches this document{result.note ? ` — ${result.note}` : ''}</div>}
            {result && !result.error && result.match === false && <div className="note" style={{ color: '#B3401E', marginTop: 2 }}>⚠ Possible name mismatch{result.note ? ` — ${result.note}` : ''}</div>}
            {result && !result.error && result.match === null && <div className="note" style={{ color: '#8A5A0A', marginTop: 2 }}>? {result.note}</div>}
          </div>
        );
      })}
      {editable && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <select value={pickName} onChange={(e) => setPickName(e.target.value)} style={{ flex: '1 1 200px' }}>
            <option value="">What is this document?</option>
            {options.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="__other__">Other…</option>
          </select>
          {pickName === '__other__' && (
            <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Document name" style={{ flex: '1 1 160px' }} />
          )}
          <input type="file" multiple accept="image/*,application/pdf" disabled={!resolvedName} onChange={onFiles} style={{ flex: '1 1 200px' }} />
        </div>
      )}
      {editable && !employmentType && (
        <div className="note" style={{ marginTop: 4 }}>Tip: set Employment Type above to narrow this list to relevant document names.</div>
      )}
    </div>
  );
}

// India OTP verification for a phone number already saved on the record — send-OTP only enables
// once the number is a complete 10 digits, and re-verification is required after any edit to it
// (handled server-side: changing the phone clears phone_verified).
function PhoneVerification({ employeeId, phone, verified, editable }) {
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [justVerified, setJustVerified] = useState(false);

  if (!editable) return null;
  if (verified || justVerified) return <span className="status-tag present" style={{ marginLeft: 6 }}>Verified</span>;
  if (!phone || phone.length !== 10) return null;

  async function sendOtp() {
    setMsg(''); setSending(true);
    try {
      const res = await api.post(`/employees/${employeeId}/phone/send-otp`);
      setOtpSent(true);
      setMsg(res.data.message);
    } catch (err) { setMsg(err.response?.data?.error || 'Could not send OTP.'); }
    finally { setSending(false); }
  }
  async function verifyOtp() {
    setMsg('');
    try {
      await api.post(`/employees/${employeeId}/phone/verify-otp`, { otp });
      setOtpSent(false); setOtp(''); setJustVerified(true);
    } catch (err) { setMsg(err.response?.data?.error || 'Could not verify OTP.'); }
  }

  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {!otpSent
        ? <button type="button" onClick={sendOtp} disabled={sending}>{sending ? 'Sending...' : 'Send OTP'}</button>
        : (
          <>
            <input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="OTP" style={{ width: 70 }} />
            <button type="button" onClick={verifyOtp}>Verify</button>
          </>
        )}
      {msg && <span className="note">{msg}</span>}
    </span>
  );
}

// Same shape as PhoneVerification, just for an email address — an OTP mailed to the address on
// file rather than texted. Re-verification is required after any edit to it (handled server-side:
// changing the email clears email_verified).
function EmailVerification({ employeeId, email, verified, editable }) {
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [justVerified, setJustVerified] = useState(false);

  if (!editable) return null;
  if (verified || justVerified) return <span className="status-tag present" style={{ marginLeft: 6 }}>Verified</span>;
  if (!email) return null;

  async function sendOtp() {
    setMsg(''); setSending(true);
    try {
      const res = await api.post(`/employees/${employeeId}/email/send-otp`);
      setOtpSent(true);
      setMsg(res.data.message);
    } catch (err) { setMsg(err.response?.data?.error || 'Could not send OTP.'); }
    finally { setSending(false); }
  }
  async function verifyOtp() {
    setMsg('');
    try {
      await api.post(`/employees/${employeeId}/email/verify-otp`, { otp });
      setOtpSent(false); setOtp(''); setJustVerified(true);
    } catch (err) { setMsg(err.response?.data?.error || 'Could not verify OTP.'); }
  }

  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      {!otpSent
        ? <button type="button" onClick={sendOtp} disabled={sending}>{sending ? 'Sending...' : 'Send OTP'}</button>
        : (
          <>
            <input value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="OTP" style={{ width: 70 }} />
            <button type="button" onClick={verifyOtp}>Verify</button>
          </>
        )}
      {msg && <span className="note">{msg}</span>}
    </span>
  );
}

const MAX_FILE_BYTES = 3 * 1024 * 1024;
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function statusClass(status) {
  if (status === 'Active') return 'present';
  if (status === 'On Probation') return 'pending';
  return 'absent';
}

// Where a custom field's input actually lands on the form — the same section headings the
// built-in fields already use, so an added field sits next to the fields it's related to
// instead of always landing in one lumped block at the end.
const SECTION_LABELS = {
  personal: 'Personal Information', address: 'Address', emergency: 'Emergency Contact',
  employment: 'Employment Details', bank: 'Bank & Statutory Details', education: 'Education & Work Experience'
};

// Super Admin only — define a new field once and it shows up on every employee's form
// (create, HR edit, and self-service) for HR/the employee to fill in. Pausing a field hides it
// from the form without deleting the values already saved against it.
function CustomFieldManager({ fields, onAdd, onToggle, onMove, onRename, onRemove }) {
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [section, setSection] = useState('personal');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  async function submit(e) {
    e.preventDefault();
    await onAdd({ label, field_type: fieldType, section });
    setLabel(''); setFieldType('text'); setSection('personal'); setShowForm(false);
  }

  function startRename(f) { setRenamingId(f.id); setRenameValue(f.label); }
  async function saveRename(f) {
    if (!renameValue.trim()) return;
    await onRename(f, renameValue.trim());
    setRenamingId(null);
  }
  async function remove(f) {
    if (!window.confirm(`Remove field "${f.label}"? This also deletes every employee's stored value for it. This cannot be undone.`)) return;
    await onRemove(f);
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="feature-name">Manage Fields <span className="note">(Super Admin only — rename, move, pause or remove any custom field)</span></div>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add Field'}</button>
      </div>
      {showForm && (
        <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <input placeholder="Field name (e.g. T-Shirt Size)" value={label} onChange={(e) => setLabel(e.target.value)} required style={{ flex: '2 1 200px' }} />
          <select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
          </select>
          <select value={section} onChange={(e) => setSection(e.target.value)}>
            {Object.entries(SECTION_LABELS).map(([key, lbl]) => <option key={key} value={key}>{lbl}</option>)}
          </select>
          <button className="primary" type="submit">Add</button>
        </form>
      )}
      {fields.length === 0 ? <div className="empty">No custom fields yet.</div> : fields.map((f) => (
        <div key={f.id} className="rec-row">
          {renamingId === f.id ? (
            <span className="row" style={{ gap: 6, flex: 1 }}>
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus style={{ flex: '1 1 180px' }} />
              <button className="primary" onClick={() => saveRename(f)}>Save</button>
              <button onClick={() => setRenamingId(null)}>Cancel</button>
            </span>
          ) : (
            <span>{f.label} <span className="feature-meta">({f.field_type})</span></span>
          )}
          {renamingId !== f.id && (
            <span className="row" style={{ gap: 6, flexShrink: 0 }}>
              <select value={f.section} onChange={(e) => onMove(f, e.target.value)}>
                {Object.entries(SECTION_LABELS).map(([key, lbl]) => <option key={key} value={key}>{lbl}</option>)}
              </select>
              <span className={'status-tag ' + (f.active ? 'present' : 'pending')} style={{ cursor: 'pointer' }} onClick={() => onToggle(f)} title="Click to pause/resume">
                {f.active ? 'Active' : 'Paused'}
              </span>
              <button onClick={() => startRename(f)}>Rename</button>
              <button onClick={() => remove(f)}>Remove</button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// Built-in fields (Employee ID, Name, Address, etc.) — the same rename/hide idea as custom
// fields above, but for the fixed set of fields already hardcoded into the form. Data/columns
// are never dropped; hiding only affects whether the form shows an input for it. A protected
// field (Employee ID/Name/Email/Department/Role/Status — load-bearing for Payroll/Attendance/
// RBAC/Reports) can be renamed but never hidden, shown here as a locked "Required" tag.
function BuiltinFieldManager({ fields, onSave }) {
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  function startRename(f) { setRenamingKey(f.key); setRenameValue(f.label); }
  async function saveRename(f) {
    if (!renameValue.trim()) return;
    await onSave(f, { label: renameValue.trim() });
    setRenamingKey(null);
  }
  async function toggleHidden(f) {
    if (f.protected) return;
    await onSave(f, { hidden: !f.hidden });
  }

  const bySection = {};
  fields.forEach((f) => { (bySection[f.section] ||= []).push(f); });

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="feature-name" style={{ marginBottom: 8 }}>
        Built-in Fields <span className="note">(Super Admin only — rename any field; hide any except the required ones)</span>
      </div>
      {Object.entries(SECTION_LABELS).map(([sectionKey, sectionLabel]) => {
        const rows = bySection[sectionKey];
        if (!rows?.length) return null;
        return (
          <div key={sectionKey} style={{ marginBottom: 10 }}>
            <div className="feature-meta" style={{ fontWeight: 700, marginTop: 8, marginBottom: 2 }}>{sectionLabel}</div>
            {rows.map((f) => (
              <div key={f.key} className="rec-row">
                {renamingKey === f.key ? (
                  <span className="row" style={{ gap: 6, flex: 1 }}>
                    <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus style={{ flex: '1 1 180px' }} />
                    <button className="primary" onClick={() => saveRename(f)}>Save</button>
                    <button onClick={() => setRenamingKey(null)}>Cancel</button>
                  </span>
                ) : (
                  <span>{f.label}{f.label !== f.defaultLabel && <span className="feature-meta"> (was "{f.defaultLabel}")</span>}</span>
                )}
                {renamingKey !== f.key && (
                  <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                    {f.protected ? (
                      <span className="status-tag locked" title="Required by Payroll/Attendance/RBAC/Reports — cannot be hidden">Required</span>
                    ) : (
                      <span className={'status-tag ' + (f.hidden ? 'pending' : 'present')} style={{ cursor: 'pointer' }} onClick={() => toggleHidden(f)} title="Click to hide/show on the form">
                        {f.hidden ? 'Hidden' : 'Visible'}
                      </span>
                    )}
                    <button onClick={() => startRename(f)}>Rename</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function Employees() {
  const { user } = useAuth();
  const canHR = HR_ROLES.includes(user?.role);
  const canManageEmployees = WRITE_ROLES.includes(user?.role);
  const showMyProfile = SELF_SERVICE_ROLES.includes(user?.role);
  const canExport = user?.role === 'super_admin' || user?.role === 'manager';
  const canEditEmployee = user?.role === 'super_admin' || user?.role === 'hr_admin';

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [teams, setTeams] = useState([]);
  const [systemRoles, setSystemRoles] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showFieldManager, setShowFieldManager] = useState(false);
  const [fieldConfig, setFieldConfig] = useState([]);
  const isSuperAdmin = user?.role === 'super_admin';
  const [filterId, setFilterId] = useState('');
  const [filterName, setFilterName] = useState('');
  const filteredEmployees = employees.filter((e) =>
    (!filterId || (e.employee_code || '').toLowerCase().includes(filterId.trim().toLowerCase())) &&
    (!filterName || (e.name || '').toLowerCase().includes(filterName.trim().toLowerCase()))
  );
  const [transferFor, setTransferFor] = useState(null); // employee id currently showing the transfer form
  const [transferForm, setTransferForm] = useState({ department: '', designation: '', team_id: '', transfer_date: new Date().toISOString().slice(0, 10), reason: '' });
  function startTransfer(emp) {
    setTransferFor(emp.id);
    setTransferForm({ department: emp.department || '', designation: emp.designation || '', team_id: emp.team_id || '', transfer_date: new Date().toISOString().slice(0, 10), reason: '' });
  }
  async function submitTransfer(e, empId) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post(`/employees/${empId}/transfer`, transferForm); setInfo('Employee transferred.'); setTransferFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not transfer employee.'); }
  }

  function loadCustomFields() { api.get('/employees/custom-fields').then((r) => setCustomFields(r.data.fields)).catch(() => {}); }
  function loadFieldConfig() { api.get('/employees/field-config').then((r) => setFieldConfig(r.data.fields)).catch(() => {}); }
  const fieldConfigByKey = {};
  fieldConfig.forEach((f) => { fieldConfigByKey[f.key] = f; });
  // Every built-in field label/visibility ultimately flows through these two — the field()
  // helper below and the "special" (non-field()) inputs in FullEmployeeFields/EmployeeSelfCard
  // both call these so a Super Admin rename/hide takes effect everywhere the field is rendered.
  const labelFor = (key, fallback) => fieldConfigByKey[key]?.label || fallback;
  const isFieldHidden = (key) => !!fieldConfigByKey[key]?.hidden;
  async function saveFieldConfig(f, patch) {
    setError('');
    try { await api.put(`/employees/field-config/${f.key}`, patch); loadFieldConfig(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update field.'); }
  }

  // form: { mode: 'create' | 'edit', minimal: bool }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formMode, setFormMode] = useState(null);
  const [editingId, setEditingId] = useState(null);

  function load() {
    setLoading(true);
    api.get('/employees').then((res) => setEmployees(res.data.employees))
      .catch(() => setError('Could not load employees.')).finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(loadCustomFields, []);

  // Hired candidates arrive here from Recruitment's "Convert to Employee" button with a
  // navigation-state prefill (name/department/designation) — opens the Add Employee form
  // already filled in rather than auto-creating a full employee record sight-unseen (a real
  // employee needs email/DOJ/bank/etc. HR should still review before saving). Consumed once
  // via replace so re-visiting/back-navigating here doesn't keep re-opening the form.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.state?.prefillEmployee) {
      setForm({ ...EMPTY_FORM, ...location.state.prefillEmployee });
      setFormMode('create');
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  useEffect(loadFieldConfig, []);
  useEffect(() => {
    if (!canHR) return;
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/branches').then((r) => setBranches(r.data.branches)).catch(() => {});
    api.get('/org/teams').then((r) => setTeams(r.data.teams)).catch(() => {});
    api.get('/org/roles').then((r) => setSystemRoles(r.data.roles)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canHR]);

  function reset() { setFormMode(null); setEditingId(null); setForm(EMPTY_FORM); setError(''); setInfo(''); }

  function startCreate() { setEditingId(null); setForm(EMPTY_FORM); setFormMode('create'); }
  function startEdit(emp) {
    setEditingId(emp.id);
    const next = { ...EMPTY_FORM };
    Object.keys(EMPTY_FORM).forEach((k) => { next[k] = emp[k] ?? ''; });
    next.employee_code = emp.employee_code || '';
    next.documents = Array.isArray(emp.documents) ? emp.documents : [];
    next.custom_fields = {};
    (emp.custom_fields || []).forEach((f) => { next.custom_fields[f.field_id] = f.value; });
    setForm(next);
    setFormMode('edit');
  }

  async function handlePhoto(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError('Photo is too large (max 3 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setForm((f) => ({ ...f, photo: dataUrl }));
  }
  async function handleAddDocuments(files, name) {
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is too large (max 3 MB).`); continue; }
      const dataUrl = await readFileAsDataUrl(file);
      setForm((f) => ({ ...f, documents: [...f.documents, { name: files.length > 1 ? `${name} (${file.name})` : name, dataUrl }] }));
    }
  }
  const renameDocument = (i, name) => setForm((f) => ({ ...f, documents: f.documents.map((d, idx) => idx === i ? { ...d, name } : d) }));
  const removeDocument = (i) => setForm((f) => ({ ...f, documents: f.documents.filter((_, idx) => idx !== i) }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editingId) await api.put(`/employees/${editingId}`, form);
      else await api.post('/employees', form);
      reset(); load();
    } catch (err) { setError(err.response?.data?.error || 'Save failed.'); }
  }

  async function act(id, verb, body) {
    setError(''); setInfo('');
    try {
      const res = await api.post(`/employees/${id}/${verb}`, body || {});
      load();
      return res.data.employee;
    } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }

  async function toggleAccount(emp) {
    const reactivating = emp.account_active === 0;
    if (!reactivating && !window.confirm(`Mark ${emp.name} as exited? They'll be signed out and can no longer log in.`)) return;
    setError(''); setInfo('');
    try {
      await api.put(`/employees/${emp.id}/account-status`, { active: reactivating });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }

  async function downloadCsv() {
    const res = await api.get('/reports/employees.csv', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = 'employees.csv'; a.click();
    URL.revokeObjectURL(url);
  }
  async function downloadOneCsv(emp) {
    const res = await api.get('/reports/employees.csv', { params: { id: emp.id }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = `${emp.employee_code || emp.name}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function addCustomField(newField) {
    setError('');
    try { await api.post('/employees/custom-fields', newField); loadCustomFields(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add field.'); }
  }
  async function toggleCustomField(f) {
    setError('');
    try { await api.put(`/employees/custom-fields/${f.id}`, { active: !f.active }); loadCustomFields(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update field.'); }
  }
  async function moveCustomField(f, section) {
    setError('');
    try { await api.put(`/employees/custom-fields/${f.id}`, { section }); loadCustomFields(); }
    catch (err) { setError(err.response?.data?.error || 'Could not move field.'); }
  }
  async function renameCustomField(f, label) {
    setError('');
    try { await api.put(`/employees/custom-fields/${f.id}`, { label }); loadCustomFields(); }
    catch (err) { setError(err.response?.data?.error || 'Could not rename field.'); }
  }
  async function removeCustomField(f) {
    setError('');
    try { await api.delete(`/employees/custom-fields/${f.id}`); loadCustomFields(); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not remove field.'); }
  }

  const field = (key, label, type = 'text') => {
    if (isFieldHidden(key)) return null;
    return (
      <div>
        <label className="field-label">{labelFor(key, label)}</label>
        <span className="row" style={{ alignItems: 'center' }}>
          <input type={type} value={form[key]} style={{ flex: 1 }}
            onChange={(e) => setForm({ ...form, [key]: sanitizeFieldValue(key, e.target.value), ...(key === 'email' ? { email_verified: false } : {}) })} />
          {key === 'email' && <EmailVerification employeeId={editingId} email={form.email} verified={form.email_verified} editable />}
        </span>
        {key === 'bank_account_number' && bankAccountHint(form[key])}
      </div>
    );
  };

  // ---------- Employee (self-service) view ----------
  if (!canHR) {
    const me = employees[0];
    return (
      <div>
        <h1>My Profile</h1>
        <div className="subtitle">Your onboarding profile. Fill your details when assigned; once approved it is locked.</div>
        {error && <div className="banner error">{error}</div>}
        {info && <div className="banner info">{info}</div>}
        {!loading && !me && <div className="empty">No employee record is linked to your account yet. Your HR will assign one.</div>}
        {me && <EmployeeSelfCard emp={me} onSaved={load} setError={setError} setInfo={setInfo} customFields={customFields} fieldConfig={fieldConfig} />}
      </div>
    );
  }

  // A Senior Team Lead/Team Lead/Manager/Assistant Manager/HR Admin is an employee too — their
  // own record (own onboarding, own edit requests) alongside the employee list below (scoped to
  // their assigned departments/teams for STL/TL, company-wide for the others, as already set up).
  const myRecord = showMyProfile ? employees.find((e) => e.user_id === user?.id) : null;

  // ---------- HR view ----------
  const quickActions = [
    { to: '/bulk-import', label: 'Bulk Import' },
    { to: '/organization', label: 'Add Departments' },
    { to: '/organization', label: 'Add Branch' },
    { to: '/policies', label: 'Configuration Policies' }
  ];

  return (
    <div>
      <h1>Employee Management</h1>
      <div className="subtitle">Onboard, review and manage employee records through the 5-stage workflow.</div>

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {showMyProfile && (
        <div style={{ marginBottom: 18 }}>
          <div className="section-label" style={{ paddingLeft: 0 }}>My Profile</div>
          {!loading && !myRecord && <div className="empty">No employee record is linked to your account yet.</div>}
          {myRecord && <EmployeeSelfCard emp={myRecord} onSaved={load} setError={setError} setInfo={setInfo} customFields={customFields} fieldConfig={fieldConfig} />}
        </div>
      )}

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">Total Employees</div><div className="kpi-value">{employees.length}</div></div>
        <div className="kpi-card green"><div className="kpi-label">Active</div><div className="kpi-value">{employees.filter((e) => e.status === 'Active').length}</div></div>
        <div className="kpi-card gold"><div className="kpi-label">On Probation</div><div className="kpi-value">{employees.filter((e) => e.status === 'On Probation').length}</div></div>
        <div className="kpi-card red"><div className="kpi-label">Exited</div><div className="kpi-value">{employees.filter((e) => e.status === 'Exited').length}</div></div>
      </div>

      <div className="filter-bar">
        <input placeholder="Filter by Employee ID…" value={filterId} onChange={(e) => setFilterId(e.target.value)} style={{ width: 'auto' }} />
        <input placeholder="Filter by Name…" value={filterName} onChange={(e) => setFilterName(e.target.value)} style={{ width: 'auto' }} />
        {(filterId || filterName) && <button onClick={() => { setFilterId(''); setFilterName(''); }}>Clear</button>}
        <div className="spacer" />
        <span className="feature-meta">{filteredEmployees.length} of {employees.length}</span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
        {canManageEmployees && quickActions.map((a) => (
          <Link key={a.label} to={a.to}><button>{a.label}</button></Link>
        ))}
        <div style={{ flex: 1 }} />
        {isSuperAdmin && <button onClick={() => setShowFieldManager((v) => !v)}>{showFieldManager ? 'Close Field Manager' : 'Manage Fields'}</button>}
        {canExport && <button onClick={downloadCsv}>Export</button>}
        {canManageEmployees && <button className="primary" onClick={startCreate}>+ Add Employee</button>}
      </div>

      {showFieldManager && isSuperAdmin && (
        <>
          <BuiltinFieldManager fields={fieldConfig} onSave={saveFieldConfig} />
          <CustomFieldManager fields={customFields} onAdd={addCustomField} onToggle={toggleCustomField} onMove={moveCustomField} onRename={renameCustomField} onRemove={removeCustomField} />
        </>
      )}

      {formMode && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            {formMode === 'create' ? (
              <>
                <div className="section-label" style={{ paddingLeft: 0 }}>Add Employee — creates their employee record and login together</div>
                <div className="grid2">
                  <div>
                    <label className="field-label">{labelFor('employee_code', 'Employee ID')} <span className="note">(optional — auto if blank)</span></label>
                    <input value={form.employee_code} placeholder="e.g. EMP-009" onChange={(e) => setForm({ ...form, employee_code: e.target.value })} />
                  </div>
                  {field('name', 'Full name')}
                  <div>
                    <label className="field-label">{labelFor('department', 'Department')}</label>
                    <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required>
                      <option value="">Select department</option>
                      {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="field-label">{labelFor('designation', 'Role')}</label>
                    <select value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} required>
                      <option value="">Select role</option>
                      {form.designation && !systemRoles.some((r) => r.name === form.designation) && <option value={form.designation}>{form.designation}</option>}
                      {systemRoles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
                    </select>
                  </div>
                  {field('email', 'Email (used to log in)', 'email')}
                  <div>
                    <label className="field-label">Password <span className="note">(for their login)</span></label>
                    <div className="row" style={{ gap: 6 }}>
                      <input type={showPassword ? 'text' : 'password'} value={form.password} minLength={6} placeholder="At least 6 characters"
                        onChange={(e) => setForm({ ...form, password: e.target.value })} required style={{ flex: 1 }} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ flexShrink: 0 }}>{showPassword ? 'Hide' : 'Show'}</button>
                    </div>
                  </div>
                </div>
                <div className="note" style={{ marginTop: 8 }}>Creates their employee record and login account together — they can sign in right away to fill in the rest of their profile.</div>
              </>
            ) : (
              <FullEmployeeFields form={form} setForm={setForm} field={field} departments={departments} branches={branches} teams={teams} systemRoles={systemRoles}
                handlePhoto={handlePhoto} handleAddDocuments={handleAddDocuments} renameDocument={renameDocument} removeDocument={removeDocument} employeeId={editingId} customFields={customFields}
                labelFor={labelFor} isFieldHidden={isFieldHidden} hr />
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" type="submit">{editingId ? 'Save changes' : 'Create employee'}</button>
              <button type="button" onClick={reset}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {loading && <div className="empty">Loading...</div>}
        {!loading && employees.length === 0 && <div className="empty">No employee records yet.</div>}
        {!loading && employees.length > 0 && filteredEmployees.length === 0 && <div className="empty">No employees match your filters.</div>}
        {!loading && filteredEmployees.length > 0 && (
          <table>
            <thead>
              <tr>
                <th></th><th>Code</th><th>Name</th><th>Department</th><th>Team</th><th>Designation</th><th>Status</th><th>Stage</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.map((emp) => (
                <Fragment key={emp.id}>
                  <tr>
                    <td>
                      {emp.photo
                        ? <img src={emp.photo} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: '50%', border: '1px solid #E2E5EA' }} />
                        : <span style={{ display: 'inline-flex', width: 28, height: 28, borderRadius: '50%', background: '#EEF0F3', color: '#8A93A3', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{(emp.name || '?').charAt(0).toUpperCase()}</span>}
                    </td>
                    <td>{emp.employee_code}</td>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); setExpandedId(expandedId === emp.id ? null : emp.id); }}>{emp.name}</a></td>
                    <td>{emp.department}</td>
                    <td>{emp.team_name || '—'}</td>
                    <td>{emp.designation}</td>
                    <td><span className={'status-tag ' + statusClass(emp.status)}>{emp.status}</span></td>
                    <td>
                      <span className={'status-tag ' + STAGE_CLASS[emp.stage]}>{STAGE_LABEL[emp.stage]}</span>
                      {emp.edit_requested && <span className="status-tag pending" style={{ marginLeft: 4 }}>edit req</span>}
                      {emp.edit_request_count > 0 && <span className="feature-meta" style={{ marginLeft: 4 }}>({emp.edit_request_count} edit req{emp.edit_request_count === 1 ? '' : 's'} total)</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEditEmployee && <button onClick={() => startEdit(emp)}>Edit</button>}
                      {canManageEmployees && emp.stage === 'submitted' && (
                        <>
                          <button className="btn-approve" style={{ marginLeft: 6 }} onClick={() => act(emp.id, 'approve')}>Approve</button>
                          <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => act(emp.id, 'reject')}>Reject</button>
                        </>
                      )}
                      {canManageEmployees && emp.stage === 'locked' && (
                        <button className={emp.edit_requested ? 'btn-approve' : ''} style={{ marginLeft: 6 }} onClick={() => act(emp.id, 'approve-edit')}>
                          {emp.edit_requested ? 'Approve edit' : 'Unlock'}
                        </button>
                      )}
                      {canManageEmployees && emp.user_id && (
                        <button style={{ marginLeft: 6 }} onClick={() => toggleAccount(emp)}>
                          {emp.account_active === 0 ? 'Reactivate' : 'Pause'}
                        </button>
                      )}
                      {canEditEmployee && <button style={{ marginLeft: 6 }} onClick={() => (transferFor === emp.id ? setTransferFor(null) : startTransfer(emp))}>{transferFor === emp.id ? 'Cancel' : 'Transfer'}</button>}
                      {canExport && <button style={{ marginLeft: 6 }} onClick={() => downloadOneCsv(emp)}>Export</button>}
                    </td>
                  </tr>
                  {transferFor === emp.id && (
                    <tr><td colSpan={9} style={{ textAlign: 'left', background: '#F7F8FA' }}>
                      <form onSubmit={(e) => submitTransfer(e, emp.id)} className="row" style={{ flexWrap: 'wrap', padding: '10px 6px' }}>
                        <div style={{ flex: '1 1 160px' }}>
                          <label className="field-label">New Department</label>
                          <select value={transferForm.department} onChange={(e) => setTransferForm({ ...transferForm, department: e.target.value })}>
                            {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: '1 1 160px' }}>
                          <label className="field-label">New Designation</label>
                          <select value={transferForm.designation} onChange={(e) => setTransferForm({ ...transferForm, designation: e.target.value })}>
                            {transferForm.designation && !systemRoles.some((r) => r.name === transferForm.designation) && <option value={transferForm.designation}>{transferForm.designation}</option>}
                            {systemRoles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: '1 1 140px' }}>
                          <label className="field-label">New Team <span className="note">(optional)</span></label>
                          <select value={transferForm.team_id} onChange={(e) => setTransferForm({ ...transferForm, team_id: e.target.value })}>
                            <option value="">No team</option>
                            {teams.filter((t) => t.department_id === departments.find((d) => d.name === transferForm.department)?.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: '0 1 150px' }}>
                          <label className="field-label">Transfer date</label>
                          <input type="date" value={transferForm.transfer_date} onChange={(e) => setTransferForm({ ...transferForm, transfer_date: e.target.value })} required />
                        </div>
                        <div style={{ flex: '2 1 200px' }}>
                          <label className="field-label">Reason <span className="note">(optional)</span></label>
                          <input value={transferForm.reason} onChange={(e) => setTransferForm({ ...transferForm, reason: e.target.value })} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                          <button className="primary" type="submit">Confirm transfer</button>
                        </div>
                      </form>
                    </td></tr>
                  )}
                  {expandedId === emp.id && (
                    <tr><td colSpan={9} style={{ textAlign: 'left', background: '#F7F8FA' }}>
                      <EmployeeDetail emp={emp} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- Shared full-fields form ----------
// Renders one input per active custom field belonging to `section`, bound to
// form.custom_fields[field_id] — meant to be dropped inside that section's existing grid2, so an
// added field sits alongside the built-in fields it's related to, not in a separate block.
// Shared by both the HR form and the employee's own self-service form.
function CustomFieldInputs({ customFields, section, form, setForm, editable = true }) {
  const fields = customFields.filter((f) => f.active && f.section === section);
  return fields.map((f) => (
    <div key={f.id}>
      <label className="field-label">{f.label}</label>
      <input
        type={f.field_type === 'number' ? 'text' : f.field_type}
        disabled={!editable}
        value={form.custom_fields?.[f.id] ?? ''}
        onChange={(e) => setForm({ ...form, custom_fields: { ...form.custom_fields, [f.id]: f.field_type === 'number' ? e.target.value.replace(/\D/g, '') : e.target.value } })}
      />
    </div>
  ));
}

function FullEmployeeFields({ form, setForm, field, departments, branches, teams, systemRoles, handlePhoto, handleAddDocuments, renameDocument, removeDocument, employeeId, customFields, labelFor, isFieldHidden, hr }) {
  const [showPassword, setShowPassword] = useState(false);
  const label = labelFor || ((key, fallback) => fallback);
  const hidden = isFieldHidden || (() => false);
  return (
    <>
      <div className="section-label" style={{ paddingLeft: 0 }}>Personal information</div>
      <div className="grid2">
        {hr && (
          <div>
            <label className="field-label">{label('employee_code', 'Employee ID')}</label>
            <input value={form.employee_code} disabled />
          </div>
        )}
        {field('name', 'Full name')}
        {field('date_of_birth', 'Date of birth', 'date')}
        {!hidden('phone') && (
          <div>
            <label className="field-label">{label('phone', 'Phone')}</label>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span>+91</span>
              <input value={form.phone} maxLength={10} placeholder="10-digit mobile number" style={{ flex: 1 }}
                onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10), phone_verified: false })} />
              <PhoneVerification employeeId={employeeId} phone={form.phone} verified={form.phone_verified} editable />
            </div>
          </div>
        )}
        {field('email', 'Email', 'email')}
        {!hidden('photo') && (
          <div>
            <label className="field-label">{label('photo', 'Employee photo')}</label>
            <input type="file" accept="image/*" onChange={handlePhoto} />
            {form.photo && <img src={form.photo} alt="preview" style={{ marginTop: 6, width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA' }} />}
          </div>
        )}
        {hr && (
          <div>
            <label className="field-label">Reset password <span className="note">(leave blank to keep unchanged)</span></label>
            <div className="row" style={{ gap: 6 }}>
              <input type={showPassword ? 'text' : 'password'} value={form.password} placeholder="New password" minLength={6}
                onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ flex: 1 }} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ flexShrink: 0 }}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
          </div>
        )}
        <CustomFieldInputs customFields={customFields || []} section="personal" form={form} setForm={setForm} />
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Address</div>
      <div className="grid2">
        {!hidden('address_type') && (
          <div>
            <label className="field-label">{label('address_type', 'Address Type')}</label>
            <select value={form.address_type} onChange={(e) => setForm({ ...form, address_type: e.target.value })}>
              <option value="">Select type</option>
              <option value="Current">Current</option>
              <option value="Permanent">Permanent</option>
            </select>
          </div>
        )}
        {field('address_line1', 'Address Line 1 (House/Flat No., Building Name)')}
        {field('address_line2', 'Address Line 2 (Street, Area, Landmark)')}
        {field('address_city', 'City / Town')}
        {field('address_district', 'District')}
        {field('address_state', 'State / Province')}
        {field('address_country', 'Country')}
        {field('address_pincode', 'Postal Code / ZIP Code')}
        <CustomFieldInputs customFields={customFields || []} section="address" form={form} setForm={setForm} />
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Emergency contact</div>
      <div className="grid2">
        {field('emergency_contact_name', 'Contact name')}
        {field('emergency_contact_relation', 'Relation')}
        {field('emergency_contact_number', 'Contact number')}
        <CustomFieldInputs customFields={customFields || []} section="emergency" form={form} setForm={setForm} />
      </div>

      {hr && (
        <>
          <div className="section-label" style={{ paddingLeft: 0 }}>Employment details</div>
          <div className="grid2">
            <div>
              <label className="field-label">{label('department', 'Department')}</label>
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value, team_id: '' })} required>
                <option value="">Select department</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            {!hidden('branch') && (
              <div>
                <label className="field-label">{label('branch', 'Branch')}</label>
                <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                  <option value="">Select branch</option>
                  {branches.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
              </div>
            )}
            {!hidden('team_id') && (() => {
              const teamsForDept = teams.filter((t) => t.department_name === form.department);
              if (teamsForDept.length === 0) return null;
              return (
                <div>
                  <label className="field-label">{label('team_id', 'Team')} <span className="note">(optional)</span></label>
                  <select value={form.team_id || ''} onChange={(e) => setForm({ ...form, team_id: e.target.value ? Number(e.target.value) : '' })}>
                    <option value="">No team</option>
                    {teamsForDept.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              );
            })()}
            <div>
              <label className="field-label">{label('designation', 'Role')}</label>
              <select value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} required>
                <option value="">Select role</option>
                {form.designation && !systemRoles.some((r) => r.name === form.designation) && <option value={form.designation}>{form.designation}</option>}
                {systemRoles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
              </select>
            </div>
            {field('date_of_joining', 'Date of joining', 'date')}
            {field('reporting_manager', 'Reporting manager')}
            <div>
              <label className="field-label">{label('status', 'Status')}</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="Active">Active</option>
                <option value="On Probation">On Probation</option>
                <option value="Exited">Exited</option>
              </select>
            </div>
            {!hidden('shift') && (
              <div>
                <label className="field-label">{label('shift', 'Shift')}</label>
                <select value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>
                  {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            <CustomFieldInputs customFields={customFields || []} section="employment" form={form} setForm={setForm} />
          </div>
        </>
      )}

      <div className="section-label" style={{ paddingLeft: 0 }}>Bank &amp; statutory details <span className="note">(restricted — shown on payslips)</span></div>
      <div className="grid2">
        {field('bank_name', 'Bank name')}
        {field('bank_account_number', 'Account number')}
        {field('ifsc_code', 'IFSC code')}
        {field('pan_number', 'PAN number')}
        {field('aadhaar_number', 'Aadhaar number')}
        {field('uan_number', 'UAN number')}
        {field('pf_number', 'PF number')}
        {field('esi_number', 'ESI number')}
        <CustomFieldInputs customFields={customFields || []} section="bank" form={form} setForm={setForm} />
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Education &amp; work experience</div>
      <div className="grid2">
        {!hidden('employment_type') && (
          <div>
            <label className="field-label">{label('employment_type', 'Employment Type')}</label>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className={form.employment_type === 'Fresher' ? 'primary' : ''} onClick={() => setForm({ ...form, employment_type: 'Fresher' })}>Fresher</button>
              <button type="button" className={form.employment_type === 'Experienced' ? 'primary' : ''} onClick={() => setForm({ ...form, employment_type: 'Experienced' })}>Experienced</button>
            </div>
          </div>
        )}
        {field('education', 'Education details')}
        {form.employment_type === 'Experienced' && field('experience', 'Work experience details')}
        {field('skills', 'Skills & certifications')}
        <CustomFieldInputs customFields={customFields || []} section="education" form={form} setForm={setForm} />
      </div>

      {!hidden('documents') && (
        <>
          <div className="section-label" style={{ paddingLeft: 0 }}>{label('documents', 'Documents')} <span className="note">(choose what each document is before attaching it)</span></div>
          <DocumentsEditor documents={form.documents} employmentType={form.employment_type} editable employeeName={form.name}
            onAdd={handleAddDocuments} onRename={renameDocument} onRemove={removeDocument} />
        </>
      )}
    </>
  );
}

// ---------- Detail (read-only expand) ----------
function EmployeeDetail({ emp }) {
  const addr = [
    emp.address_line1, emp.address_line2, emp.address_city, emp.address_district, emp.address_state, emp.address_country, emp.address_pincode
  ].filter(Boolean).join(', ');
  return (
    <div style={{ padding: '10px 6px' }}>
      {emp.photo && <img src={emp.photo} alt={emp.name} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA', marginBottom: 10 }} />}
      <div className="grid2">
        <div>Employee ID: <strong>{emp.employee_code}</strong></div>
        <div>
          Designation: <strong>{emp.designation}</strong>
          {emp.transfers?.length > 0 && <span className="feature-meta"> (transferred {emp.transfers[0].transfer_date})</span>}
        </div>
        <div>Branch: <strong>{emp.branch || '—'}</strong></div>
        <div>Shift: <strong>{emp.shift || '—'}</strong></div>
        <div>Reporting manager: <strong>{emp.reporting_manager || '—'}</strong></div>
        <div>Phone: <strong>{emp.phone ? `+91 ${emp.phone}` : '—'}</strong>{emp.phone && (emp.phone_verified ? <span className="status-tag present" style={{ marginLeft: 6 }}>Verified</span> : <span className="status-tag pending" style={{ marginLeft: 6 }}>Unverified</span>)}</div>
        <div>Email: <strong>{emp.email || '—'}</strong>{emp.email && (emp.email_verified ? <span className="status-tag present" style={{ marginLeft: 6 }}>Verified</span> : <span className="status-tag pending" style={{ marginLeft: 6 }}>Unverified</span>)}</div>
        <div>Date of birth: <strong>{emp.date_of_birth || '—'}</strong></div>
        <div>Address{emp.address_type ? ` (${emp.address_type})` : ''}: <strong>{addr || '—'}</strong></div>
        <div>Emergency: <strong>{emp.emergency_contact_name ? `${emp.emergency_contact_name} (${emp.emergency_contact_relation}) — ${emp.emergency_contact_number}` : '—'}</strong></div>
        <div>Employment Type: <strong>{emp.employment_type || '—'}</strong></div>
        <div>Education: <strong>{emp.education || '—'}</strong></div>
        {emp.employment_type === 'Experienced' && <div>Experience: <strong>{emp.experience || '—'}</strong></div>}
        <div>Skills: <strong>{emp.skills || '—'}</strong></div>
      </div>
      <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Documents</div>
      {emp.documents && emp.documents.length > 0
        ? emp.documents.map((doc, i) => <a key={i} href={doc.dataUrl} download={doc.name} className="pill" style={{ display: 'inline-block', marginRight: 6 }}>📎 {doc.name}</a>)
        : <div className="note">No documents uploaded.</div>}

      <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Transfer History</div>
      {emp.transfers && emp.transfers.length > 0 ? (
        emp.transfers.map((t) => (
          <div key={t.id} className="rec-row" style={{ alignItems: 'flex-start' }}>
            <span>
              {t.from_department !== t.to_department && <>{t.from_department || '—'} → <strong>{t.to_department}</strong>{t.from_designation !== t.to_designation ? ', ' : ''}</>}
              {t.from_designation !== t.to_designation && <>{t.from_designation || '—'} → <strong>{t.to_designation}</strong></>}
              {t.reason && <div className="feature-meta">{t.reason}</div>}
            </span>
            <span className="feature-meta">{t.transfer_date}</span>
          </div>
        ))
      ) : <div className="note">No transfers on record.</div>}
      <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Bank &amp; statutory details</div>
      {emp.sensitiveFieldsMasked ? (
        <div className="empty">Masked — only Super Admin or the employee can see bank details.</div>
      ) : (
        <div className="grid2">
          <div>Bank: <strong>{emp.bank_name || '—'}</strong></div>
          <div>Account number: <strong>{emp.bank_account_number || '—'}</strong></div>
          <div>IFSC: <strong>{emp.ifsc_code || '—'}</strong></div>
          <div>PAN: <strong>{emp.pan_number || '—'}</strong></div>
          <div>Aadhaar: <strong>{emp.aadhaar_number || '—'}</strong></div>
          <div>UAN: <strong>{emp.uan_number || '—'}</strong></div>
          <div>PF number: <strong>{emp.pf_number || '—'}</strong></div>
          <div>ESI number: <strong>{emp.esi_number || '—'}</strong></div>
        </div>
      )}
      {emp.custom_fields?.filter((f) => f.value).length > 0 && (
        <>
          <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Additional information</div>
          <div className="grid2">
            {emp.custom_fields.filter((f) => f.value).map((f) => <div key={f.field_id}>{f.label}: <strong>{f.value}</strong></div>)}
          </div>
        </>
      )}
      {emp.edit_requests?.length > 0 && (
        <>
          <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>
            Edit Request History <span className="feature-meta">({emp.edit_request_count} raised)</span>
          </div>
          {emp.edit_requests.map((r) => (
            <div key={r.id} style={{ marginBottom: 8 }}>
              <div className="rec-row">
                <span>{r.detail}<div className="feature-meta">{r.created_at.slice(0, 10)}</div></span>
                <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : r.status === 'Rejected' ? 'absent' : 'pending')}>{r.status}</span>
              </div>
              {r.status === 'Pending' && <ChainStepper chainLabel={emp.edit_chain_label} currentStageName={r.current_stage_name} status={r.status} />}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---------- Employee self-service card ----------
const EMP_EMPTY = { ...EMPTY_FORM };
function EmployeeSelfCard({ emp, onSaved, setError, setInfo, customFields, fieldConfig }) {
  const [form, setForm] = useState(EMP_EMPTY);
  useEffect(() => {
    const next = { ...EMP_EMPTY };
    Object.keys(EMP_EMPTY).forEach((k) => { next[k] = emp[k] ?? ''; });
    next.documents = Array.isArray(emp.documents) ? emp.documents : [];
    next.custom_fields = {};
    (emp.custom_fields || []).forEach((f) => { next.custom_fields[f.field_id] = f.value; });
    setForm(next);
  }, [emp]);

  const editable = emp.stage === 'assigned';

  const fieldConfigByKey = {};
  (fieldConfig || []).forEach((f) => { fieldConfigByKey[f.key] = f; });
  const label = (key, fallback) => fieldConfigByKey[key]?.label || fallback;
  const hidden = (key) => !!fieldConfigByKey[key]?.hidden;

  const field = (key, fallbackLabel, type = 'text') => {
    if (hidden(key)) return null;
    return (
      <div>
        <label className="field-label">{label(key, fallbackLabel)}</label>
        <span className="row" style={{ alignItems: 'center' }}>
          <input type={type} value={form[key]} disabled={!editable} style={{ flex: 1 }}
            onChange={(e) => setForm({ ...form, [key]: sanitizeFieldValue(key, e.target.value), ...(key === 'email' ? { email_verified: false } : {}) })} />
          {key === 'email' && <EmailVerification employeeId={emp.id} email={form.email} verified={form.email_verified} editable={editable} />}
        </span>
        {key === 'bank_account_number' && bankAccountHint(form[key])}
      </div>
    );
  };
  async function handlePhoto(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError('Photo is too large (max 3 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setForm((f) => ({ ...f, photo: dataUrl }));
  }
  async function handleAddDocuments(files, name) {
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is too large.`); continue; }
      const dataUrl = await readFileAsDataUrl(file);
      setForm((f) => ({ ...f, documents: [...f.documents, { name: files.length > 1 ? `${name} (${file.name})` : name, dataUrl }] }));
    }
  }
  const renameDocument = (i, name) => setForm((f) => ({ ...f, documents: f.documents.map((d, idx) => idx === i ? { ...d, name } : d) }));
  const removeDocument = (i) => setForm((f) => ({ ...f, documents: f.documents.filter((_, idx) => idx !== i) }));

  async function save(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.put(`/employees/${emp.id}`, form); setInfo('Saved. Submit when your details are complete.'); onSaved(); }
    catch (err) { setError(err.response?.data?.error || 'Save failed.'); }
  }
  async function submit() {
    setError(''); setInfo('');
    try { await api.post(`/employees/${emp.id}/submit`); setInfo('Submitted for HR review.'); onSaved(); }
    catch (err) { setError(err.response?.data?.error || 'Submit failed.'); }
  }
  const [showEditRequestForm, setShowEditRequestForm] = useState(false);
  const [editReason, setEditReason] = useState('');
  async function requestEdit(e) {
    e.preventDefault();
    setError(''); setInfo('');
    try {
      await api.post(`/employees/${emp.id}/request-edit`, { reason: editReason });
      setInfo('Edit request sent for approval.'); setEditReason(''); setShowEditRequestForm(false); onSaved();
    } catch (err) { setError(err.response?.data?.error || 'Request failed.'); }
  }
  const pendingEditRequest = (emp.edit_requests || []).find((r) => r.status === 'Pending');

  const banner = {
    assigned: 'Your HR has assigned this profile to you — fill in your details and Submit.',
    submitted: 'Submitted — waiting for HR to review and approve. You cannot edit until it is approved or sent back.',
    locked: emp.edit_requested ? 'Your profile is locked. Edit request sent — waiting for approval.' : 'Your profile is approved and locked. Raise an edit request if you need to change something.',
    draft: 'Your HR is still preparing this profile.'
  }[emp.stage];

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {form.photo
            ? <img src={form.photo} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: '50%', border: '1px solid #E2E5EA' }} />
            : <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: '50%', background: '#EEF0F3', color: '#8A93A3', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700 }}>{(emp.name || '?').charAt(0).toUpperCase()}</span>}
          <div className="feature-name">{emp.name} · {emp.employee_code}</div>
        </div>
        <span className={'status-tag ' + STAGE_CLASS[emp.stage]}>{STAGE_LABEL[emp.stage]}</span>
      </div>
      <div className="banner info">{banner}</div>

      <form onSubmit={save}>
        <div className="section-label" style={{ paddingLeft: 0 }}>Personal</div>
        <div className="grid2">
          {field('name', 'Full name')}
          {field('date_of_birth', 'Date of birth', 'date')}
          {!hidden('phone') && (
            <div>
              <label className="field-label">{label('phone', 'Phone')}</label>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span>+91</span>
                <input value={form.phone} disabled={!editable} maxLength={10} placeholder="10-digit mobile number" style={{ flex: 1 }}
                  onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10), phone_verified: false })} />
                <PhoneVerification employeeId={emp.id} phone={form.phone} verified={form.phone_verified} editable={editable} />
              </div>
            </div>
          )}
          {!hidden('photo') && (
            <div>
              <label className="field-label">{label('photo', 'Photo')}</label>
              <input type="file" accept="image/*" disabled={!editable} onChange={handlePhoto} />
              {form.photo && <img src={form.photo} alt="" style={{ marginTop: 6, width: 60, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA' }} />}
            </div>
          )}
          <CustomFieldInputs customFields={customFields || []} section="personal" form={form} setForm={setForm} editable={editable} />
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Address</div>
        <div className="grid2">
          {!hidden('address_type') && (
            <div>
              <label className="field-label">{label('address_type', 'Address Type')}</label>
              <select value={form.address_type} disabled={!editable} onChange={(e) => setForm({ ...form, address_type: e.target.value })}>
                <option value="">Select type</option>
                <option value="Current">Current</option>
                <option value="Permanent">Permanent</option>
              </select>
            </div>
          )}
          {field('address_line1', 'Address Line 1 (House/Flat No., Building Name)')}
          {field('address_line2', 'Address Line 2 (Street, Area, Landmark)')}
          {field('address_city', 'City / Town')}
          {field('address_district', 'District')}
          {field('address_state', 'State / Province')}
          {field('address_country', 'Country')}
          {field('address_pincode', 'Postal Code / ZIP Code')}
          <CustomFieldInputs customFields={customFields || []} section="address" form={form} setForm={setForm} editable={editable} />
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Emergency contact</div>
        <div className="grid2">
          {field('emergency_contact_name', 'Name')}
          {field('emergency_contact_relation', 'Relation')}
          {field('emergency_contact_number', 'Number')}
          <CustomFieldInputs customFields={customFields || []} section="emergency" form={form} setForm={setForm} editable={editable} />
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Bank &amp; statutory details <span className="note">(shown on your payslips)</span></div>
        <div className="grid2">
          {field('bank_name', 'Bank name')}
          {field('bank_account_number', 'Account number')}
          {field('ifsc_code', 'IFSC code')}
          {field('pan_number', 'PAN number')}
          {field('aadhaar_number', 'Aadhaar number')}
          {field('uan_number', 'UAN number')}
          {field('pf_number', 'PF number')}
          {field('esi_number', 'ESI number')}
          <CustomFieldInputs customFields={customFields || []} section="bank" form={form} setForm={setForm} editable={editable} />
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Education &amp; experience</div>
        <div className="grid2">
          {!hidden('employment_type') && (
            <div>
              <label className="field-label">{label('employment_type', 'Employment Type')}</label>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" disabled={!editable} className={form.employment_type === 'Fresher' ? 'primary' : ''} onClick={() => setForm({ ...form, employment_type: 'Fresher' })}>Fresher</button>
                <button type="button" disabled={!editable} className={form.employment_type === 'Experienced' ? 'primary' : ''} onClick={() => setForm({ ...form, employment_type: 'Experienced' })}>Experienced</button>
              </div>
            </div>
          )}
          {field('education', 'Education')}
          {form.employment_type === 'Experienced' && field('experience', 'Work experience')}
          {field('skills', 'Skills')}
          <CustomFieldInputs customFields={customFields || []} section="education" form={form} setForm={setForm} editable={editable} />
        </div>

        {!hidden('documents') && (
          <>
            <div className="section-label" style={{ paddingLeft: 0 }}>{label('documents', 'Documents')}</div>
            <DocumentsEditor documents={form.documents} employmentType={form.employment_type} editable={editable} employeeName={form.name}
              onAdd={handleAddDocuments} onRename={renameDocument} onRemove={removeDocument} />
          </>
        )}

        {editable && (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" type="submit">Save</button>
            <button type="button" onClick={submit}>Submit for review</button>
          </div>
        )}
      </form>

      {emp.stage === 'locked' && !emp.edit_requested && (
        showEditRequestForm ? (
          <form onSubmit={requestEdit} className="card" style={{ marginTop: 12, background: '#F7F8FA' }}>
            <label className="field-label">Why do you need to edit your profile?</label>
            <input value={editReason} onChange={(e) => setEditReason(e.target.value)} required placeholder="e.g. My phone number changed" style={{ marginBottom: 10 }} />
            <div className="row">
              <button className="primary" type="submit">Send Request</button>
              <button type="button" onClick={() => { setShowEditRequestForm(false); setEditReason(''); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 12 }} onClick={() => setShowEditRequestForm(true)}>Request edit</button>
        )
      )}

      {pendingEditRequest && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="feature-name" style={{ marginBottom: 8 }}>Edit Request — Pending</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>{pendingEditRequest.detail}</div>
          <ChainStepper chainLabel={emp.edit_chain_label} currentStageName={pendingEditRequest.current_stage_name} status={pendingEditRequest.status} />
        </div>
      )}

      {emp.edit_requests?.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="feature-name" style={{ marginBottom: 8 }}>Edit Request History <span className="feature-meta">({emp.edit_request_count} raised)</span></div>
          {emp.edit_requests.map((r) => (
            <div key={r.id} className="rec-row">
              <span>{r.detail}<div className="feature-meta">{r.created_at.slice(0, 10)}</div></span>
              <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : r.status === 'Rejected' ? 'absent' : 'pending')}>{r.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

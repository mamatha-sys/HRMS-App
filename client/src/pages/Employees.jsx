import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

const STAGE_LABEL = { draft: 'Draft', assigned: 'Assigned', submitted: 'Submitted', locked: 'Locked' };
const STAGE_CLASS = { draft: 'pending', assigned: 'info', submitted: 'present', locked: 'locked' };

const EMPTY_FORM = {
  employee_code: '', name: '', email: '', phone: '', photo: '', date_of_birth: '',
  emergency_contact_name: '', emergency_contact_relation: '', emergency_contact_number: '',
  address_street: '', address_city: '', address_state: '', address_country: '', address_pincode: '',
  department: '', branch: '', designation: '', date_of_joining: '', reporting_manager: '', status: 'Active',
  bank_name: '', bank_account_number: '', ifsc_code: '', education: '', experience: '', skills: '', documents: []
};

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

export default function Employees() {
  const { user } = useAuth();
  const canHR = HR_ROLES.includes(user?.role);
  const canDelete = user?.role === 'super_admin';

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [assignableUsers, setAssignableUsers] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  // form: { mode: 'create' | 'edit', minimal: bool }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formMode, setFormMode] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [assigningId, setAssigningId] = useState(null);
  const [assignUserId, setAssignUserId] = useState('');

  function load() {
    setLoading(true);
    api.get('/employees').then((res) => setEmployees(res.data.employees))
      .catch(() => setError('Could not load employees.')).finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => {
    if (!canHR) return;
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/branches').then((r) => setBranches(r.data.branches)).catch(() => {});
    api.get('/employees/assignable-users').then((r) => setAssignableUsers(r.data.users)).catch(() => {});
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
    setForm(next);
    setFormMode('edit');
  }

  async function handlePhoto(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError('Photo is too large (max 3 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setForm((f) => ({ ...f, photo: dataUrl }));
  }
  async function handleAddDocuments(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is too large (max 3 MB).`); continue; }
      const dataUrl = await readFileAsDataUrl(file);
      setForm((f) => ({ ...f, documents: [...f.documents, { name: file.name, dataUrl }] }));
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

  async function doAssign(id) {
    if (!assignUserId) { setError('Pick a user to assign to.'); return; }
    setError('');
    try {
      await api.put(`/employees/${id}/assign`, { user_id: Number(assignUserId) });
      setAssigningId(null); setAssignUserId('');
      api.get('/employees/assignable-users').then((r) => setAssignableUsers(r.data.users)).catch(() => {});
      load();
    } catch (err) { setError(err.response?.data?.error || 'Assign failed.'); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this employee record?')) return;
    try { await api.delete(`/employees/${id}`); load(); } catch (err) { setError(err.response?.data?.error || 'Delete failed.'); }
  }

  const field = (key, label, type = 'text') => (
    <div>
      <label className="field-label">{label}</label>
      <input type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

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
        {me && <EmployeeSelfCard emp={me} onSaved={load} setError={setError} setInfo={setInfo} />}
      </div>
    );
  }

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

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">Total Employees</div><div className="kpi-value">{employees.length}</div></div>
        <div className="kpi-card green"><div className="kpi-label">Active</div><div className="kpi-value">{employees.filter((e) => e.status === 'Active').length}</div></div>
        <div className="kpi-card gold"><div className="kpi-label">On Probation</div><div className="kpi-value">{employees.filter((e) => e.status === 'On Probation').length}</div></div>
        <div className="kpi-card red"><div className="kpi-label">Exited</div><div className="kpi-value">{employees.filter((e) => e.status === 'Exited').length}</div></div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
        {quickActions.map((a) => (
          <Link key={a.label} to={a.to}><button>{a.label}</button></Link>
        ))}
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={startCreate}>+ Add employee (Stage 1)</button>
      </div>

      {formMode && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            {formMode === 'create' ? (
              <>
                <div className="section-label" style={{ paddingLeft: 0 }}>Stage 1 — create draft (HR enters the essentials)</div>
                <div className="grid2">
                  <div>
                    <label className="field-label">Employee ID <span className="note">(optional — auto if blank)</span></label>
                    <input value={form.employee_code} placeholder="e.g. EMP-009" onChange={(e) => setForm({ ...form, employee_code: e.target.value })} />
                  </div>
                  {field('name', 'Full name')}
                  <div>
                    <label className="field-label">Department</label>
                    <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required>
                      <option value="">Select department</option>
                      {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select>
                  </div>
                  {field('designation', 'Designation')}
                </div>
                <div className="note" style={{ marginTop: 8 }}>After saving, assign the draft to an employee so they can fill their own details.</div>
              </>
            ) : (
              <FullEmployeeFields form={form} setForm={setForm} field={field} departments={departments} branches={branches}
                handlePhoto={handlePhoto} handleAddDocuments={handleAddDocuments} renameDocument={renameDocument} removeDocument={removeDocument} hr />
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" type="submit">{editingId ? 'Save changes' : 'Create draft'}</button>
              <button type="button" onClick={reset}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {loading && <div className="empty">Loading...</div>}
        {!loading && employees.length === 0 && <div className="empty">No employee records yet.</div>}
        {!loading && employees.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>Status</th><th>Stage</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <Fragment key={emp.id}>
                  <tr>
                    <td>{emp.employee_code}</td>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); setExpandedId(expandedId === emp.id ? null : emp.id); }}>{emp.name}</a></td>
                    <td>{emp.department}</td>
                    <td>{emp.designation}</td>
                    <td><span className={'status-tag ' + statusClass(emp.status)}>{emp.status}</span></td>
                    <td>
                      <span className={'status-tag ' + STAGE_CLASS[emp.stage]}>{STAGE_LABEL[emp.stage]}</span>
                      {emp.edit_requested && <span className="status-tag pending" style={{ marginLeft: 4 }}>edit req</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {emp.stage === 'draft' && <button onClick={() => { setAssigningId(assigningId === emp.id ? null : emp.id); setAssignUserId(''); }}>Assign</button>}
                      {emp.stage === 'assigned' && <span className="note">awaiting employee</span>}
                      {emp.stage === 'submitted' && (
                        <>
                          <button className="btn-approve" onClick={() => act(emp.id, 'approve')}>Approve</button>
                          <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => act(emp.id, 'reject')}>Reject</button>
                        </>
                      )}
                      {emp.stage === 'locked' && (
                        <button className={emp.edit_requested ? 'btn-approve' : ''} onClick={() => act(emp.id, 'approve-edit')}>
                          {emp.edit_requested ? 'Approve edit' : 'Unlock'}
                        </button>
                      )}
                      {emp.stage !== 'locked' && emp.stage !== 'draft' && <button style={{ marginLeft: 6 }} onClick={() => startEdit(emp)}>Edit</button>}
                      {emp.stage === 'draft' && <button style={{ marginLeft: 6 }} onClick={() => startEdit(emp)}>Edit</button>}
                      {canDelete && <button style={{ marginLeft: 6 }} onClick={() => handleDelete(emp.id)}>Delete</button>}
                    </td>
                  </tr>
                  {assigningId === emp.id && (
                    <tr><td colSpan={7} style={{ background: '#F7F8FA' }}>
                      <div className="row" style={{ margin: '8px 4px', flexWrap: 'wrap' }}>
                        <span style={{ alignSelf: 'center' }}>Stage 2 — assign to employee:</span>
                        <select value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)} style={{ flex: '1 1 220px' }}>
                          <option value="">Select an employee-role user…</option>
                          {assignableUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                        </select>
                        <button className="primary" onClick={() => doAssign(emp.id)}>Assign</button>
                        <button onClick={() => setAssigningId(null)}>Cancel</button>
                        {assignableUsers.length === 0 && <span className="note">No unassigned employee users — create one in Role &amp; User Management first.</span>}
                      </div>
                    </td></tr>
                  )}
                  {expandedId === emp.id && (
                    <tr><td colSpan={7} style={{ textAlign: 'left', background: '#F7F8FA' }}>
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
function FullEmployeeFields({ form, setForm, field, departments, branches, handlePhoto, handleAddDocuments, renameDocument, removeDocument, hr }) {
  return (
    <>
      <div className="section-label" style={{ paddingLeft: 0 }}>Personal information</div>
      <div className="grid2">
        {hr && (
          <div>
            <label className="field-label">Employee ID</label>
            <input value={form.employee_code} disabled />
          </div>
        )}
        {field('name', 'Full name')}
        {field('date_of_birth', 'Date of birth', 'date')}
        {field('phone', 'Phone')}
        {field('email', 'Email', 'email')}
        <div>
          <label className="field-label">Employee photo</label>
          <input type="file" accept="image/*" onChange={handlePhoto} />
          {form.photo && <img src={form.photo} alt="preview" style={{ marginTop: 6, width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA' }} />}
        </div>
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Address</div>
      <div className="grid2">
        {field('address_street', 'Street')}
        {field('address_city', 'City')}
        {field('address_state', 'State')}
        {field('address_country', 'Country')}
        {field('address_pincode', 'Pincode / ZIP')}
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Emergency contact</div>
      <div className="grid2">
        {field('emergency_contact_name', 'Contact name')}
        {field('emergency_contact_relation', 'Relation')}
        {field('emergency_contact_number', 'Contact number')}
      </div>

      {hr && (
        <>
          <div className="section-label" style={{ paddingLeft: 0 }}>Employment details</div>
          <div className="grid2">
            <div>
              <label className="field-label">Department</label>
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required>
                <option value="">Select department</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Branch</label>
              <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                <option value="">Select branch</option>
                {branches.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
              </select>
            </div>
            {field('designation', 'Designation')}
            {field('date_of_joining', 'Date of joining', 'date')}
            {field('reporting_manager', 'Reporting manager')}
            <div>
              <label className="field-label">Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="Active">Active</option>
                <option value="On Probation">On Probation</option>
                <option value="Exited">Exited</option>
              </select>
            </div>
          </div>
        </>
      )}

      <div className="section-label" style={{ paddingLeft: 0 }}>Bank details <span className="note">(restricted)</span></div>
      <div className="grid2">
        {field('bank_name', 'Bank name')}
        {field('bank_account_number', 'Account number')}
        {field('ifsc_code', 'IFSC code')}
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Education &amp; work experience</div>
      <div className="grid2">
        {field('education', 'Education details')}
        {field('experience', 'Work experience details')}
        {field('skills', 'Skills & certifications')}
      </div>

      <div className="section-label" style={{ paddingLeft: 0 }}>Documents <span className="note">(add as many as needed — each with its own label)</span></div>
      <div>
        {form.documents.length === 0 && <div className="note" style={{ marginBottom: 6 }}>No documents added yet.</div>}
        {form.documents.map((doc, idx) => (
          <div key={idx} className="row" style={{ marginBottom: 6 }}>
            <input value={doc.name} onChange={(e) => renameDocument(idx, e.target.value)} placeholder="Document label" style={{ flex: '2 1 200px' }} />
            <a href={doc.dataUrl} download={doc.name} className="crumb" style={{ flexShrink: 0 }}>view</a>
            <button type="button" onClick={() => removeDocument(idx)} style={{ flexShrink: 0 }}>Remove</button>
          </div>
        ))}
        <label className="field-label" style={{ marginTop: 8 }}>Add documents</label>
        <input type="file" multiple accept="image/*,application/pdf" onChange={handleAddDocuments} />
      </div>
    </>
  );
}

// ---------- Detail (read-only expand) ----------
function EmployeeDetail({ emp }) {
  const addr = [emp.address_street, emp.address_city, emp.address_state, emp.address_country, emp.address_pincode].filter(Boolean).join(', ');
  return (
    <div style={{ padding: '10px 6px' }}>
      {emp.photo && <img src={emp.photo} alt={emp.name} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA', marginBottom: 10 }} />}
      <div className="grid2">
        <div>Employee ID: <strong>{emp.employee_code}</strong></div>
        <div>Branch: <strong>{emp.branch || '—'}</strong></div>
        <div>Reporting manager: <strong>{emp.reporting_manager || '—'}</strong></div>
        <div>Phone: <strong>{emp.phone || '—'}</strong></div>
        <div>Date of birth: <strong>{emp.date_of_birth || '—'}</strong></div>
        <div>Address: <strong>{addr || '—'}</strong></div>
        <div>Emergency: <strong>{emp.emergency_contact_name ? `${emp.emergency_contact_name} (${emp.emergency_contact_relation}) — ${emp.emergency_contact_number}` : '—'}</strong></div>
        <div>Education: <strong>{emp.education || '—'}</strong></div>
        <div>Experience: <strong>{emp.experience || '—'}</strong></div>
        <div>Skills: <strong>{emp.skills || '—'}</strong></div>
      </div>
      <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Documents</div>
      {emp.documents && emp.documents.length > 0
        ? emp.documents.map((doc, i) => <a key={i} href={doc.dataUrl} download={doc.name} className="pill" style={{ display: 'inline-block', marginRight: 6 }}>📎 {doc.name}</a>)
        : <div className="note">No documents uploaded.</div>}
      <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Bank details</div>
      {emp.sensitiveFieldsMasked ? (
        <div className="empty">Masked — only Super Admin or the employee can see bank details.</div>
      ) : (
        <div className="grid2">
          <div>Bank: <strong>{emp.bank_name || '—'}</strong></div>
          <div>Account number: <strong>{emp.bank_account_number || '—'}</strong></div>
          <div>IFSC: <strong>{emp.ifsc_code || '—'}</strong></div>
        </div>
      )}
    </div>
  );
}

// ---------- Employee self-service card ----------
const EMP_EMPTY = { ...EMPTY_FORM };
function EmployeeSelfCard({ emp, onSaved, setError, setInfo }) {
  const [form, setForm] = useState(EMP_EMPTY);
  useEffect(() => {
    const next = { ...EMP_EMPTY };
    Object.keys(EMP_EMPTY).forEach((k) => { next[k] = emp[k] ?? ''; });
    next.documents = Array.isArray(emp.documents) ? emp.documents : [];
    setForm(next);
  }, [emp]);

  const editable = emp.stage === 'assigned';

  const field = (key, label, type = 'text') => (
    <div>
      <label className="field-label">{label}</label>
      <input type={type} value={form[key]} disabled={!editable} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );
  async function handlePhoto(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError('Photo is too large (max 3 MB).'); return; }
    const dataUrl = await readFileAsDataUrl(file);
    setForm((f) => ({ ...f, photo: dataUrl }));
  }
  async function handleAddDocuments(e) {
    const files = Array.from(e.target.files || []); e.target.value = '';
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is too large.`); continue; }
      const dataUrl = await readFileAsDataUrl(file);
      setForm((f) => ({ ...f, documents: [...f.documents, { name: file.name, dataUrl }] }));
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
  async function requestEdit() {
    setError(''); setInfo('');
    try { await api.post(`/employees/${emp.id}/request-edit`); setInfo('Edit request sent to HR.'); onSaved(); }
    catch (err) { setError(err.response?.data?.error || 'Request failed.'); }
  }

  const banner = {
    assigned: 'Your HR has assigned this profile to you — fill in your details and Submit.',
    submitted: 'Submitted — waiting for HR to review and approve. You cannot edit until it is approved or sent back.',
    locked: emp.edit_requested ? 'Your profile is locked. Edit request sent — waiting for HR to approve.' : 'Your profile is approved and locked. Raise an edit request if you need to change something.',
    draft: 'Your HR is still preparing this profile.'
  }[emp.stage];

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="feature-name">{emp.name} · {emp.employee_code}</div>
        <span className={'status-tag ' + STAGE_CLASS[emp.stage]}>{STAGE_LABEL[emp.stage]}</span>
      </div>
      <div className="banner info">{banner}</div>

      <form onSubmit={save}>
        <div className="section-label" style={{ paddingLeft: 0 }}>Personal</div>
        <div className="grid2">
          {field('name', 'Full name')}
          {field('date_of_birth', 'Date of birth', 'date')}
          {field('phone', 'Phone')}
          <div>
            <label className="field-label">Photo</label>
            <input type="file" accept="image/*" disabled={!editable} onChange={handlePhoto} />
            {form.photo && <img src={form.photo} alt="" style={{ marginTop: 6, width: 60, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E5EA' }} />}
          </div>
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Address</div>
        <div className="grid2">
          {field('address_street', 'Street')}
          {field('address_city', 'City')}
          {field('address_state', 'State')}
          {field('address_country', 'Country')}
          {field('address_pincode', 'Pincode / ZIP')}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Emergency contact</div>
        <div className="grid2">
          {field('emergency_contact_name', 'Name')}
          {field('emergency_contact_relation', 'Relation')}
          {field('emergency_contact_number', 'Number')}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Bank details</div>
        <div className="grid2">
          {field('bank_name', 'Bank name')}
          {field('bank_account_number', 'Account number')}
          {field('ifsc_code', 'IFSC code')}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Education &amp; experience</div>
        <div className="grid2">
          {field('education', 'Education')}
          {field('experience', 'Work experience')}
          {field('skills', 'Skills')}
        </div>

        <div className="section-label" style={{ paddingLeft: 0 }}>Documents</div>
        <div>
          {form.documents.map((doc, idx) => (
            <div key={idx} className="row" style={{ marginBottom: 6 }}>
              <input value={doc.name} disabled={!editable} onChange={(e) => renameDocument(idx, e.target.value)} style={{ flex: '2 1 200px' }} />
              <a href={doc.dataUrl} download={doc.name} className="crumb">view</a>
              {editable && <button type="button" onClick={() => removeDocument(idx)}>Remove</button>}
            </div>
          ))}
          {editable && <input type="file" multiple accept="image/*,application/pdf" onChange={handleAddDocuments} style={{ marginTop: 6 }} />}
        </div>

        {editable && (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="primary" type="submit">Save</button>
            <button type="button" onClick={submit}>Submit for review</button>
          </div>
        )}
      </form>

      {emp.stage === 'locked' && !emp.edit_requested && (
        <button className="primary" style={{ marginTop: 12 }} onClick={requestEdit}>Request edit</button>
      )}
    </div>
  );
}

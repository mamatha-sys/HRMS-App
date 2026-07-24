import { Fragment, useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const EMPTY_FORM = {
  name: '', email: '', phone: '', photo: '', date_of_birth: '',
  emergency_contact_name: '', emergency_contact_relation: '', emergency_contact_number: '',
  department: '', branch: '', designation: '', date_of_joining: '', reporting_manager: '', status: 'Active',
  bank_name: '', bank_account_number: '', ifsc_code: '', aadhaar_number: '', pan_number: '',
  education: '', experience: '', skills: ''
};

export default function Employees() {
  const { user } = useAuth();
  const canEdit = user?.role === 'super_admin' || user?.role === 'manager';
  const canDelete = user?.role === 'super_admin';

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState(null);

  function load() {
    setLoading(true);
    api
      .get('/employees')
      .then((res) => setEmployees(res.data.employees))
      .catch(() => setError('Could not load employees.'))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);
  useEffect(() => {
    if (!canEdit) return;
    api.get('/org/departments').then((res) => setDepartments(res.data.departments)).catch(() => {});
    api.get('/org/branches').then((res) => setBranches(res.data.branches)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function startEdit(emp) {
    setEditingId(emp.id);
    const next = { ...EMPTY_FORM };
    Object.keys(EMPTY_FORM).forEach((k) => { next[k] = emp[k] ?? ''; });
    setForm(next);
    setShowForm(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        await api.put(`/employees/${editingId}`, form);
      } else {
        await api.post('/employees', form);
      }
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed.');
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this employee record?')) return;
    try {
      await api.delete(`/employees/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed.');
    }
  }

  function field(key, label, type = 'text') {
    return (
      <div>
        <label className="field-label">{label}</label>
        <input type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      </div>
    );
  }

  return (
    <div>
      <h1>Employee Management</h1>
      <div className="subtitle">
        {canEdit ? 'View, add, edit and manage employee records.' : 'View your own employee record.'}
      </div>

      {error && <div className="banner error">{error}</div>}

      {canEdit && (
        <div className="row" style={{ marginBottom: 14, justifyContent: 'flex-end' }}>
          <button className="primary" onClick={startCreate}>+ Add employee</button>
        </div>
      )}

      {showForm && (
        <div className="card">
          <form onSubmit={handleSubmit}>
            <div className="section-label" style={{ paddingLeft: 0 }}>Personal information</div>
            <div className="grid2">
              {field('name', 'Full name')}
              {field('date_of_birth', 'Date of birth', 'date')}
              {field('phone', 'Phone')}
              {field('email', 'Email', 'email')}
            </div>

            <div className="section-label" style={{ paddingLeft: 0 }}>Emergency contact</div>
            <div className="grid2">
              {field('emergency_contact_name', 'Contact name')}
              {field('emergency_contact_relation', 'Relation')}
              {field('emergency_contact_number', 'Contact number')}
            </div>

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
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
            </div>

            <div className="section-label" style={{ paddingLeft: 0 }}>Bank details <span className="note">(restricted — masked from managers on other employees)</span></div>
            <div className="grid2">
              {field('bank_name', 'Bank name')}
              {field('bank_account_number', 'Account number')}
              {field('ifsc_code', 'IFSC code')}
            </div>

            <div className="section-label" style={{ paddingLeft: 0 }}>Identity documents <span className="note">(restricted)</span></div>
            <div className="grid2">
              {field('aadhaar_number', 'Aadhaar number')}
              {field('pan_number', 'PAN number')}
            </div>

            <div className="section-label" style={{ paddingLeft: 0 }}>Education &amp; experience</div>
            <div className="grid2">
              {field('education', 'Education details')}
              {field('experience', 'Experience details')}
              {field('skills', 'Skills & certifications')}
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" type="submit">{editingId ? 'Save changes' : 'Create employee'}</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {loading && <div className="empty">Loading...</div>}
        {!loading && employees.length === 0 && <div className="empty">No employee records to show.</div>}
        {!loading && employees.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Department</th>
                <th>Designation</th>
                <th>Joined</th>
                <th>Status</th>
                {canEdit && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <Fragment key={emp.id}>
                  <tr>
                    <td>{emp.employee_code}</td>
                    <td>
                      <a href="#" onClick={(e) => { e.preventDefault(); setExpandedId(expandedId === emp.id ? null : emp.id); }}>
                        {emp.name}
                      </a>
                    </td>
                    <td>{emp.department}</td>
                    <td>{emp.designation}</td>
                    <td>{emp.date_of_joining}</td>
                    <td><span className={'status-tag ' + (emp.status === 'Active' ? 'present' : 'absent')}>{emp.status}</span></td>
                    {canEdit && (
                      <td>
                        <button onClick={() => startEdit(emp)}>Edit</button>
                        {canDelete && <button onClick={() => handleDelete(emp.id)} style={{ marginLeft: 6 }}>Delete</button>}
                      </td>
                    )}
                  </tr>
                  {expandedId === emp.id && (
                    <tr>
                      <td colSpan={canEdit ? 7 : 6} style={{ textAlign: 'left', background: '#F7F8FA' }}>
                        <div style={{ padding: '10px 6px' }}>
                          <div className="grid2">
                            <div>Branch: <strong>{emp.branch || '—'}</strong></div>
                            <div>Reporting manager: <strong>{emp.reporting_manager || '—'}</strong></div>
                            <div>Phone: <strong>{emp.phone || '—'}</strong></div>
                            <div>Date of birth: <strong>{emp.date_of_birth || '—'}</strong></div>
                            <div>Emergency contact: <strong>{emp.emergency_contact_name ? `${emp.emergency_contact_name} (${emp.emergency_contact_relation}) — ${emp.emergency_contact_number}` : '—'}</strong></div>
                            <div>Education: <strong>{emp.education || '—'}</strong></div>
                            <div>Experience: <strong>{emp.experience || '—'}</strong></div>
                            <div>Skills: <strong>{emp.skills || '—'}</strong></div>
                          </div>
                          <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Bank &amp; identity details</div>
                          {emp.sensitiveFieldsMasked ? (
                            <div className="empty">Masked — bank and identity details are only visible to Super Admin or the employee themselves.</div>
                          ) : (
                            <div className="grid2">
                              <div>Bank: <strong>{emp.bank_name || '—'}</strong></div>
                              <div>Account number: <strong>{emp.bank_account_number || '—'}</strong></div>
                              <div>IFSC: <strong>{emp.ifsc_code || '—'}</strong></div>
                              <div>Aadhaar: <strong>{emp.aadhaar_number || '—'}</strong></div>
                              <div>PAN: <strong>{emp.pan_number || '—'}</strong></div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
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

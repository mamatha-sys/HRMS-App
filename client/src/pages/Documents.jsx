import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they should still be able to
// acknowledge mandatory documents themselves, not just administer them. Super Admin is a pure
// system-administrator account with no "own" acknowledgment expectation.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing the (company-wide) document library only —
// per Super Admin policy, no upload/delete/acknowledgment-tracking actions unless explicitly
// granted. HR_ROLES above still drives read-only decorations (ack counts, HR-flavored subtitle
// wording); CAN_MANAGE_ROLES gates every actual write affordance.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Documents() {
  const { user } = useAuth();
  const isHR = HR_ROLES.includes(user?.role);
  const showOwn = SELF_AND_ADMIN_ROLES.includes(user?.role) || !isHR;
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Policy');
  const [mandatory, setMandatory] = useState(false);
  const [published, setPublished] = useState(true);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewingAck, setViewingAck] = useState(null);
  const [ackData, setAckData] = useState(null);
  // Same "Send to" targeting as the Announcements compose form: everyone, one department, or a
  // hand-picked set of employees.
  const [targetMode, setTargetMode] = useState('all');
  const [targetDepartment, setTargetDepartment] = useState('');
  const [employeeIds, setEmployeeIds] = useState([]);
  const [options, setOptions] = useState({ departments: [], employees: [] });
  const toggleEmployee = (id) => setEmployeeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  function load() { api.get('/documents').then((r) => setDocuments(r.data.documents)).catch(() => setError('Could not load documents.')); }
  useEffect(load, []);
  useEffect(() => { if (canManage) api.get('/documents/compose-options').then((r) => setOptions(r.data)).catch(() => {}); }, [canManage]);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!file) { setError('A file is required.'); return; }
    if (targetMode === 'department' && !targetDepartment) { setError('Choose a department.'); return; }
    if (targetMode === 'individual' && employeeIds.length === 0) { setError('Choose at least one employee.'); return; }
    setSaving(true);
    try {
      const file_data_url = await readFileAsDataUrl(file);
      await api.post('/documents', {
        title, category, mandatory, published, file_data_url,
        target_department: targetMode === 'department' ? targetDepartment : null,
        employee_ids: targetMode === 'individual' ? employeeIds : []
      });
      setTitle(''); setCategory('Policy'); setMandatory(false); setPublished(true); setFile(null);
      setTargetMode('all'); setTargetDepartment(''); setEmployeeIds([]); setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not upload document.'); }
    finally { setSaving(false); }
  }
  async function acknowledge(id) {
    setError('');
    try { await api.post(`/documents/${id}/acknowledge`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not acknowledge.'); }
  }
  async function remove(id) {
    setError('');
    try { await api.delete(`/documents/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not delete.'); }
  }
  async function togglePublish(d) {
    setError('');
    try { await api.put(`/documents/${d.id}/publish`, { published: !d.published }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function viewAck(id) {
    setViewingAck(id); setError('');
    try { const r = await api.get(`/documents/${id}/acknowledgments`); setAckData(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not load acknowledgments.'); }
  }

  if (viewingAck) {
    return (
      <div>
        <h1>Acknowledgments{ackData ? ` — ${ackData.document.title}` : ''}</h1>
        {error && <div className="banner error">{error}</div>}
        <button onClick={() => { setViewingAck(null); setAckData(null); }} style={{ marginBottom: 14 }}>← Back to Documents</button>
        {!ackData ? <div className="empty">Loading…</div> : (
          <div className="dashboard-grid">
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Acknowledged ({ackData.acknowledged.length})</div>
              {ackData.acknowledged.length === 0 && <div className="empty">No one yet.</div>}
              {ackData.acknowledged.map((e, i) => <div key={i} className="rec-row"><span>{e.name} ({e.employee_code})</span><span className="feature-meta">{e.acknowledged_at.slice(0, 10)}</span></div>)}
            </div>
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Pending ({ackData.pending.length}){ackData.targetLabel ? <span className="feature-meta"> — sent to {ackData.targetLabel}</span> : null}</div>
              {ackData.pending.length === 0 && <div className="empty">Everyone has acknowledged.</div>}
              {ackData.pending.map((e, i) => <div key={i} className="rec-row"><span>{e.name} ({e.employee_code})</span></div>)}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>Document Management</h1>
      <div className="subtitle">Company policies, handbooks and forms{isHR ? ' — mandatory documents require every employee to acknowledge them.' : ' — mandatory documents require your acknowledgment.'}</div>
      {error && <div className="banner error">{error}</div>}

      {canManage && (
        <div className="card" style={{ marginBottom: 14 }}>
          {showForm ? (
            <form onSubmit={submit}>
              <label className="field-label">Title *</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ marginBottom: 10 }} />
              <label className="field-label">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginBottom: 10 }}>
                {['Policy', 'Handbook', 'Form', 'Other'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} style={{ width: 16, height: 16 }} /> Mandatory (requires acknowledgment)
              </label>
              <label className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} style={{ width: 16, height: 16 }} /> Publish to employees now (leave unchecked to keep it admin-only for now)
              </label>

              <label className="field-label">Send to</label>
              <select value={targetMode} onChange={(e) => setTargetMode(e.target.value)} style={{ marginBottom: 10 }}>
                <option value="all">Everyone</option>
                <option value="department">By department</option>
                <option value="individual">Individual employee(s)</option>
              </select>
              {targetMode === 'department' && (
                <select value={targetDepartment} onChange={(e) => setTargetDepartment(e.target.value)} style={{ marginBottom: 10 }}>
                  <option value="">Select department…</option>
                  {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              {targetMode === 'individual' && (
                <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid #EEF0F3', borderRadius: 6, padding: 6, marginBottom: 10 }}>
                  {options.employees.map((emp) => (
                    <label key={emp.id} className="row" style={{ alignItems: 'center', gap: 6, padding: '2px 0' }}>
                      <input type="checkbox" checked={employeeIds.includes(emp.id)} onChange={() => toggleEmployee(emp.id)} style={{ width: 14, height: 14 }} />
                      {emp.name} <span className="feature-meta">({emp.employee_code} · {emp.department})</span>
                    </label>
                  ))}
                </div>
              )}

              <label className="field-label">File *</label>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ marginBottom: 10 }} />
              <div className="row">
                <button className="primary" type="submit" disabled={saving}>Upload Document</button>
                <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="primary" onClick={() => setShowForm(true)}>+ Upload Document</button>
          )}
        </div>
      )}

      <div className="card">
        {documents.length === 0 && <div className="empty">No documents yet.</div>}
        {documents.map((d) => (
          <div key={d.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{d.title}</strong> <span className="feature-meta">· {d.category}{d.mandatory ? ' · Mandatory' : ''}</span></span>
              <span className="row" style={{ gap: 6 }}>
                {isHR && <span className={'status-tag ' + (d.published ? 'present' : 'locked')}>{d.published ? 'Published' : 'Hidden from employees'}</span>}
                {d.mandatory && <span className={'status-tag ' + (d.acknowledgedByMe ? 'present' : 'pending')}>{d.acknowledgedByMe ? 'Acknowledged' : 'Not yet acknowledged'}</span>}
              </span>
            </div>
            <div className="feature-meta">
              Uploaded by {d.uploaded_by} · {d.created_at.slice(0, 10)} · Sent to: {d.targetLabel}
              {isHR && d.mandatory ? ` · ${d.ackCount} of ${d.audienceCount} acknowledged` : (isHR ? ` · ${d.ackCount} acknowledgment(s)` : '')}
            </div>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <a className="pill" href={d.file_data_url || '#'} target="_blank" rel="noreferrer" onClick={async (e) => {
                if (d.file_data_url) return;
                e.preventDefault();
                const r = await api.get(`/documents/${d.id}`);
                window.open(r.data.document.file_data_url, '_blank');
              }}>View</a>
              {showOwn && d.mandatory && !d.acknowledgedByMe && <button className="primary" onClick={() => acknowledge(d.id)}>Acknowledge</button>}
              {canManage && d.mandatory && <button onClick={() => viewAck(d.id)}>Acknowledgments</button>}
              {canManage && <button onClick={() => togglePublish(d)}>{d.published ? 'Hide from Employees' : 'Publish to Employees'}</button>}
              {canManage && <button onClick={() => remove(d.id)}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

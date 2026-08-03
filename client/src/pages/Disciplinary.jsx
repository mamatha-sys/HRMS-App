import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own case record.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own case record
// (EmployeeView) AND the company case log below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
const CATEGORY_CLASS = { Warning: 'pending', Suspension: 'absent', Termination: 'absent', Other: 'info' };

export default function Disciplinary() {
  const { user } = useAuth();
  const [openId, setOpenId] = useState(null);

  if (openId) return <CaseDetail id={openId} onBack={() => setOpenId(null)} />;
  if (FULL_HR_ROLES.includes(user?.role)) return <HRView onOpen={setOpenId} />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) {
    return (<><EmployeeView compact onOpen={setOpenId} /><HRView compact sectionLabel="Company Disciplinary Cases" onOpen={setOpenId} /></>);
  }
  return <EmployeeView onOpen={setOpenId} />;
}

function HRView({ onOpen, compact, sectionLabel }) {
  const [cases, setCases] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_id: '', category: '', description: '' });

  function load() {
    api.get('/disciplinary').then((r) => setCases(r.data.cases)).catch(() => setError('Could not load cases.'));
    api.get('/employees').then((r) => setEmployees(r.data.employees || r.data)).catch(() => {});
  }
  useEffect(load, []);

  async function raise(e) {
    e.preventDefault(); setError('');
    if (!form.employee_id || !form.category || !form.description.trim()) { setError('Employee, category and description are all required.'); return; }
    try { await api.post('/disciplinary', form); setForm({ employee_id: '', category: '', description: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not raise case.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Disciplinary Cases'}</div> : <h1>Disciplinary Action Tracking</h1>}
      {!compact && <div className="subtitle">HR-only case log — visible to HR roles and, read-only, to the employee it concerns.</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={raise}>
            <label className="field-label">Employee *</label>
            <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required style={{ marginBottom: 10 }}>
              <option value="">Select employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
            </select>
            <label className="field-label">Category *</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required style={{ marginBottom: 10 }}>
              <option value="">Select category…</option>
              {['Warning', 'Suspension', 'Termination', 'Other'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="field-label">Description *</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required style={{ marginBottom: 10 }} />
            <div className="row">
              <button className="primary" type="submit">Raise Case</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : <button className="primary" onClick={() => setShowForm(true)}>+ Raise Case</button>}
      </div>

      <div className="card">
        {cases.length === 0 && <div className="empty">No disciplinary cases on record.</div>}
        {cases.map((c) => (
          <div key={c.id} className="rec-row" onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
            <span>{c.employee_name} — {c.description}<div className="feature-meta">{c.created_at}</div></span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (CATEGORY_CLASS[c.category] || 'info')}>{c.category}</span>
              <span className={'status-tag ' + (c.status === 'Open' ? 'pending' : 'present')}>{c.status}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmployeeView({ onOpen, compact }) {
  const [cases, setCases] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/disciplinary/mine').then((r) => setCases(r.data.cases)).catch(() => setError('Could not load your cases.')); }, []);

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Disciplinary Cases</div> : <h1>Disciplinary Cases</h1>}
      {!compact && <div className="subtitle">Your own record — visible only to you and HR.</div>}
      {error && <div className="banner error">{error}</div>}
      <div className="card">
        {cases.length === 0 && <div className="empty">No disciplinary cases on your record.</div>}
        {cases.map((c) => (
          <div key={c.id} className="rec-row" onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
            <span>{c.description}<div className="feature-meta">{c.created_at}</div></span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (CATEGORY_CLASS[c.category] || 'info')}>{c.category}</span>
              <span className={'status-tag ' + (c.status === 'Open' ? 'pending' : 'present')}>{c.status}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CaseDetail({ id, onBack }) {
  const { user } = useAuth();
  const isHR = FULL_HR_ROLES.includes(user?.role) || SELF_AND_ADMIN_ROLES.includes(user?.role);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');

  function load() { api.get(`/disciplinary/${id}`).then((r) => setData(r.data)).catch(() => setError('Could not load case.')); }
  useEffect(load, [id]);

  async function addNote(e) {
    e.preventDefault(); setError('');
    if (!note.trim()) return;
    try { await api.post(`/disciplinary/${id}/notes`, { note }); setNote(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add note.'); }
  }
  async function resolve() {
    try { await api.put(`/disciplinary/${id}`, { status: 'Resolved', resolution_notes: resolutionNotes }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not resolve.'); }
  }
  async function reopen() {
    try { await api.put(`/disciplinary/${id}`, { status: 'Open' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not reopen.'); }
  }

  if (!data) return <div><button onClick={onBack}>← Back</button></div>;
  const { case: c, notes } = data;
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back</button>
      <h1>{c.employee_name ? `${c.employee_name} — ` : ''}{c.category}</h1>
      <div className="subtitle">{c.description}</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className={'status-tag ' + (c.status === 'Open' ? 'pending' : 'present')}>{c.status}</span>
          {isHR && (c.status === 'Open' ? (
            <div className="row" style={{ gap: 6 }}>
              <input placeholder="Resolution notes" value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} />
              <button className="primary" onClick={resolve}>Mark Resolved</button>
            </div>
          ) : <button onClick={reopen}>Reopen</button>)}
        </div>
        {c.resolution_notes && <div className="feature-meta" style={{ marginTop: 8 }}>Resolution: {c.resolution_notes}</div>}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Timeline</div>
        {notes.length === 0 && <div className="empty">No notes yet.</div>}
        {notes.map((n) => (
          <div key={n.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
            <div><strong>{n.author_name}</strong> <span className="feature-meta">{n.created_at}</span></div>
            <div>{n.note}</div>
          </div>
        ))}
        {isHR && (
          <form onSubmit={addNote} className="row" style={{ marginTop: 10 }}>
            <input placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" type="submit">Add</button>
          </form>
        )}
      </div>
    </div>
  );
}

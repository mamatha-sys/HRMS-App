import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const STATUS_CLASS = { Pending: 'pending', Approved: 'present', Rejected: 'absent' };

export default function Timesheet() {
  const { user } = useAuth();
  const isHR = HR_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('main');

  if (screen === 'reports') return <ReportsScreen onBack={() => setScreen('main')} />;
  return isHR ? <HRView onReports={() => setScreen('reports')} /> : <EmployeeView />;
}

function EmployeeView() {
  const [entries, setEntries] = useState([]);
  const [myProjects, setMyProjects] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ project_id: '', date: '', task_description: '', hours: '' });

  function load() { api.get('/timesheet').then((r) => { setEntries(r.data.entries); setMyProjects(r.data.myProjects); }).catch(() => setError('Could not load timesheet.')); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      await api.post('/timesheet', form);
      setForm({ project_id: '', date: '', task_description: '', hours: '' });
      setShowForm(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not log hours.'); }
  }

  return (
    <div>
      <h1>Timesheet</h1>
      <div className="subtitle">Log hours against your assigned projects.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap' }}>
            <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} required style={{ flex: '1 1 160px' }}>
              <option value="">Select project…</option>
              {myProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            <input placeholder="Task description" value={form.task_description} onChange={(e) => setForm({ ...form, task_description: e.target.value })} style={{ flex: '2 1 200px' }} />
            <input type="number" step="0.5" min="0" max="24" placeholder="Hours" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} required style={{ width: 90 }} />
            <button className="primary" type="submit">Log Hours</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        ) : <button className="primary" onClick={() => setShowForm(true)}>+ Log Hours</button>}
      </div>

      <div className="card">
        {entries.length === 0 && <div className="empty">No timesheet entries yet.</div>}
        {entries.map((e) => (
          <div key={e.id} className="rec-row">
            <span><strong>{e.project_name}</strong> — {e.date} · {e.hours}h
              {e.task_description && <div className="feature-meta">{e.task_description}</div>}
            </span>
            <span className={'status-tag ' + (STATUS_CLASS[e.status] || 'info')}>{e.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HRView({ onReports }) {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');

  function load() { api.get('/timesheet/overview').then((r) => setEntries(r.data.entries)).catch(() => setError('Could not load timesheet entries.')); }
  useEffect(load, []);

  async function decide(id, decision) {
    try { await api.put(`/timesheet/${id}/${decision}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Timesheet</h1>
          <div className="subtitle">Review and approve logged hours.</div>
        </div>
        <button onClick={onReports}>Reports</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="card">
        {entries.length === 0 && <div className="empty">No timesheet entries yet.</div>}
        {entries.map((e) => (
          <div key={e.id} className="rec-row">
            <span>{e.employee_name} — <strong>{e.project_name}</strong> · {e.date} · {e.hours}h
              {e.task_description && <div className="feature-meta">{e.task_description}</div>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (STATUS_CLASS[e.status] || 'info')}>{e.status}</span>
              {e.status === 'Pending' && <>
                <button onClick={() => decide(e.id, 'approve')}>Approve</button>
                <button onClick={() => decide(e.id, 'reject')}>Reject</button>
              </>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportsScreen({ onBack }) {
  const [byProject, setByProject] = useState([]);
  const [byEmployee, setByEmployee] = useState([]);
  useEffect(() => { api.get('/timesheet/reports').then((r) => { setByProject(r.data.byProject); setByEmployee(r.data.byEmployee); }).catch(() => {}); }, []);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Timesheet</button>
      <h1>Timesheet Reports</h1>
      <div className="subtitle">Total approved hours by project and by employee.</div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>By Project</div>
        {byProject.map((p, i) => (
          <div key={i} className="rec-row"><span>{p.project_name}</span><span>{p.total_hours}h</span></div>
        ))}
      </div>
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>By Employee</div>
        {byEmployee.map((e, i) => (
          <div key={i} className="rec-row"><span>{e.employee_name}</span><span>{e.total_hours}h</span></div>
        ))}
      </div>
    </div>
  );
}

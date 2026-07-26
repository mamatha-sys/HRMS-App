import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const STATUS_CLASS = { Pending: 'pending', Approved: 'present', Rejected: 'absent' };
const today = () => new Date().toISOString().slice(0, 10);

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

      <div className="card" style={{ marginBottom: 14 }}>
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

      <MyTasksSection isHR={false} />
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
      <div className="card" style={{ marginBottom: 14 }}>
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

      <MyTasksSection isHR={true} />
    </div>
  );
}

// "My Tasks" — shared by both employee and HR views. HR additionally gets an "Assign To"
// picker in the New Task modal so a higher authority can assign a task straight to an
// employee, and it shows up on that employee's own My Tasks list (with a notification).
function MyTasksSection({ isHR }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [updatesTaskId, setUpdatesTaskId] = useState(null);

  function load() { api.get('/timesheet/tasks').then((r) => setTasks(r.data.tasks)).catch(() => setError('Could not load tasks.')); }
  useEffect(load, []);

  async function setStatus(taskId, status) {
    try { await api.put(`/timesheet/tasks/${taskId}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update status.'); }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="feature-name">My Tasks</div>
        <button className="primary" onClick={() => setShowModal(true)}>+ New Task</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
      {tasks.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #EEF0F3' }}>
                <th style={{ padding: '6px 8px' }}>Task</th>
                <th style={{ padding: '6px 8px' }}>Sub Task Name</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Start Date</th>
                <th style={{ padding: '6px 8px' }}>End Date</th>
                <th style={{ padding: '6px 8px' }}>Updates</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #EEF0F3' }}>
                  <td style={{ padding: '6px 8px' }}>
                    <strong>{t.task_name}</strong>
                    {t.department && <div className="feature-meta">{t.department}</div>}
                    {t.created_by_name && <div className="feature-meta">Assigned by {t.created_by_name}</div>}
                    {t.is_dependent && t.depends_on_name && <div className="feature-meta">Depends on: {t.depends_on_name}</div>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{t.sub_task_name || '—'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)}>
                      {['Not Started', 'In Progress', 'Completed', 'On Hold'].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px' }}>{t.start_date}</td>
                  <td style={{ padding: '6px 8px' }}>{t.end_date || '—'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <button onClick={() => setUpdatesTaskId(t.id)} title="Updates">💬</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <NewTaskModal isHR={isHR} onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />}
      {updatesTaskId && <TaskUpdatesModal taskId={updatesTaskId} onClose={() => setUpdatesTaskId(null)} />}
    </div>
  );
}

function NewTaskModal({ isHR, onClose, onCreated }) {
  const [options, setOptions] = useState({ departments: [], statuses: [], employees: [] });
  const [existingTasks, setExistingTasks] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    department: '', task_name: '', description: '', sub_task_name: '',
    status: '', start_date: today(), end_date: '', is_dependent: false, depends_on_task_id: '',
    assigned_to_employee_id: ''
  });

  useEffect(() => {
    api.get('/timesheet/tasks/options').then((r) => setOptions(r.data)).catch(() => {});
    api.get('/timesheet/tasks').then((r) => setExistingTasks(r.data.tasks)).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.department) { setError('Select a department.'); return; }
    if (!form.task_name.trim()) { setError('Task name is required.'); return; }
    if (!form.status) { setError('Select a status.'); return; }
    if (!form.start_date) { setError('Task start date is required.'); return; }
    try {
      await api.post('/timesheet/tasks', form);
      onCreated();
    } catch (err) { setError(err.response?.data?.error || 'Could not create task.'); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>New Task</h2>
          <button onClick={onClose}>✕</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        <form onSubmit={submit}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Select Department *</label>
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required>
                <option value="">-- Select Department --</option>
                {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Task Name *</label>
              <input value={form.task_name} onChange={(e) => setForm({ ...form, task_name: e.target.value })} required />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Task Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Sub Task Name</label>
              <input value={form.sub_task_name} onChange={(e) => setForm({ ...form, sub_task_name: e.target.value })} />
            </div>
            {isHR && (
              <div style={{ flex: '1 1 260px' }}>
                <label className="field-label">Assign To (optional — leave blank for yourself)</label>
                <select value={form.assigned_to_employee_id} onChange={(e) => setForm({ ...form, assigned_to_employee_id: e.target.value })}>
                  <option value="">Myself</option>
                  {options.employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                </select>
              </div>
            )}
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Status *</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} required>
                <option value="">-- Select Status --</option>
                {options.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 260px' }} />
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Task Start Date *</label>
              <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} required />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Task End Date</label>
              <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label className="field-label">Dependent Task</label>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className={!form.is_dependent ? 'primary' : ''} onClick={() => setForm({ ...form, is_dependent: false, depends_on_task_id: '' })}>No</button>
              <button type="button" className={form.is_dependent ? 'primary' : ''} onClick={() => setForm({ ...form, is_dependent: true })}>Yes</button>
            </div>
            {form.is_dependent && (
              <select value={form.depends_on_task_id} onChange={(e) => setForm({ ...form, depends_on_task_id: e.target.value })} style={{ marginTop: 8 }}>
                <option value="">Depends on which task?</option>
                {existingTasks.map((t) => <option key={t.id} value={t.id}>{t.task_name}</option>)}
              </select>
            )}
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit">+ Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TaskUpdatesModal({ taskId, onClose }) {
  const [updates, setUpdates] = useState([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');

  function load() { api.get(`/timesheet/tasks/${taskId}/updates`).then((r) => setUpdates(r.data.updates)).catch(() => setError('Could not load updates.')); }
  useEffect(load, [taskId]);

  async function add(e) {
    e.preventDefault(); setError('');
    if (!comment.trim()) return;
    try { await api.post(`/timesheet/tasks/${taskId}/updates`, { comment }); setComment(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add update.'); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Task Updates</h2>
          <button onClick={onClose}>✕</button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {updates.length === 0 && <div className="empty">No updates yet.</div>}
        {updates.map((u) => (
          <div key={u.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
            <div><strong>{u.author_name}</strong> <span className="feature-meta">{u.created_at}</span></div>
            <div>{u.comment}</div>
          </div>
        ))}
        <form onSubmit={add} className="row" style={{ marginTop: 10 }}>
          <input placeholder="Add an update…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" type="submit">Add</button>
        </form>
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

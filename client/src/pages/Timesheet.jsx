import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Assign-to-others in My Tasks: full managers assign company-wide; STL/TL assign within their
// own assigned department(s)/team(s) only (enforced server-side either way). Everyone else
// (including Assistant Manager) can still see the module and their own/scoped tasks — they just
// can't assign to someone else.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const STL_TL_ROLES = ['stl', 'tl'];
// Task Reports (company-wide task-status breakdown) is visible to the same audience as the
// scoped/company-wide view in My Tasks itself — i.e. everyone except a plain employee.
const CAN_SEE_REPORTS_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
const today = () => new Date().toISOString().slice(0, 10);

export default function Timesheet() {
  const { user } = useAuth();
  const [screen, setScreen] = useState('main');
  const canAssignTasks = CAN_MANAGE_ROLES.includes(user?.role) || STL_TL_ROLES.includes(user?.role);
  const canSeeReports = CAN_SEE_REPORTS_ROLES.includes(user?.role);

  if (screen === 'taskReports') return <TaskStatusReportScreen onBack={() => setScreen('main')} />;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Timesheet</h1>
          <div className="subtitle">Track and assign work via My Tasks.</div>
        </div>
        {canSeeReports && <button onClick={() => setScreen('taskReports')}>Task Reports</button>}
      </div>
      <MyTasksSection isHR={canAssignTasks} />
    </div>
  );
}

// "My Tasks" — the same list works for both a plain employee (own tasks only) and HR/supervisory
// roles (company-wide or scoped, with an "Assign To" picker in the New Task modal), since the
// server already returns the right scope for whoever's asking. Super Admin and every HR-tier/
// scoped role additionally get Department, Team, and Daily/Weekly/Monthly filters to slice the
// list down — the Range filter is available to everyone, Department/Team only to isHR since a
// plain employee's own list rarely spans more than one of either.
function MyTasksSection({ isHR }) {
  const [tasks, setTasks] = useState([]);
  const [teams, setTeams] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [updatesTaskId, setUpdatesTaskId] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [filterDept, setFilterDept] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const [range, setRange] = useState('all');

  function load() {
    const params = {};
    if (filterDept) params.department = filterDept;
    if (filterTeam) params.team_id = filterTeam;
    if (range !== 'all') params.range = range;
    api.get('/timesheet/tasks', { params }).then((r) => setTasks(r.data.tasks)).catch(() => setError('Could not load tasks.'));
  }
  useEffect(load, [filterDept, filterTeam, range]);
  useEffect(() => { api.get('/timesheet/tasks/options').then((r) => { setDepartments(r.data.departments); setTeams(r.data.teams); }).catch(() => {}); }, []);

  async function setStatus(taskId, status) {
    try { await api.put(`/timesheet/tasks/${taskId}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update status.'); }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div className="feature-name">My Tasks</div>
        <button className="primary" onClick={() => setShowModal(true)}>+ New Task</button>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        {isHR && (
          <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {isHR && (
          <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)}>
            <option value="">All Teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.department})</option>)}
          </select>
        )}
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="all">All Time</option>
          <option value="daily">Today</option>
          <option value="weekly">This Week</option>
          <option value="monthly">This Month</option>
        </select>
      </div>
      {error && <div className="banner error">{error}</div>}
      {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
      {tasks.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #EEF0F3' }}>
                <th style={{ padding: '6px 8px' }}>Task</th>
                <th style={{ padding: '6px 8px' }}>Assigned To</th>
                <th style={{ padding: '6px 8px' }}>Sub Task Name</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}>Start Date</th>
                <th style={{ padding: '6px 8px' }}>End Date</th>
                <th style={{ padding: '6px 8px' }}>Actions</th>
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
                  <td style={{ padding: '6px 8px' }}>
                    {t.assigned_to_name || '—'}
                    {t.assigned_to_team_name && <div className="feature-meta">{t.assigned_to_team_name}</div>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{t.sub_task_name || '—'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)}>
                      {['Not Started', 'In Progress', 'Completed', 'On Hold'].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '6px 8px' }}>{t.start_date}</td>
                  <td style={{ padding: '6px 8px' }}>{t.end_date || '—'}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => setEditingTask(t)} title="Edit the full task">Edit</button>
                    <button style={{ marginLeft: 4 }} onClick={() => setUpdatesTaskId(t.id)} title="Updates">💬</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <NewTaskModal isHR={isHR} onClose={() => setShowModal(false)} onCreated={() => { setShowModal(false); load(); }} />}
      {editingTask && <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={() => { setEditingTask(null); load(); }} />}
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

// Full task edit — every field (not just status), pre-filled from the task. Reassigning who
// it's for isn't part of this; that's the separate "assign" step in New Task.
function EditTaskModal({ task, onClose, onSaved }) {
  const [options, setOptions] = useState({ departments: [] });
  const [existingTasks, setExistingTasks] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    department: task.department || '', task_name: task.task_name || '', description: task.description || '', sub_task_name: task.sub_task_name || '',
    status: task.status, start_date: task.start_date, end_date: task.end_date || '',
    is_dependent: !!task.is_dependent, depends_on_task_id: task.depends_on_task_id || ''
  });

  useEffect(() => {
    api.get('/timesheet/tasks/options').then((r) => setOptions(r.data)).catch(() => {});
    api.get('/timesheet/tasks').then((r) => setExistingTasks(r.data.tasks.filter((t) => t.id !== task.id))).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.department) { setError('Select a department.'); return; }
    if (!form.task_name.trim()) { setError('Task name is required.'); return; }
    if (!form.start_date) { setError('Task start date is required.'); return; }
    setSaving(true);
    try { await api.put(`/timesheet/tasks/${task.id}`, form); onSaved(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save task.'); }
    finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Edit Task{task.assigned_to_name ? ` — ${task.assigned_to_name}` : ''}</h2>
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
            <div style={{ flex: '1 1 260px' }}>
              <label className="field-label">Status *</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} required>
                {['Not Started', 'In Progress', 'Completed', 'On Hold'].map((s) => <option key={s} value={s}>{s}</option>)}
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
            <button className="primary" type="submit" disabled={saving}>Save</button>
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

// Company-wide view of how the allocated My Tasks work is progressing per employee — who's
// completed their allocated tasks vs who still has work pending or in progress.
function TaskStatusReportScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [teams, setTeams] = useState([]);
  const [filterDept, setFilterDept] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const [range, setRange] = useState('all');

  useEffect(() => { api.get('/timesheet/tasks/options').then((r) => { setDepartments(r.data.departments); setTeams(r.data.teams); }).catch(() => {}); }, []);
  useEffect(() => {
    const params = {};
    if (filterDept) params.department = filterDept;
    if (filterTeam) params.team_id = filterTeam;
    if (range !== 'all') params.range = range;
    api.get('/timesheet/reports/task-status', { params }).then((r) => setData(r.data)).catch(() => setError('Could not load task status report.'));
  }, [filterDept, filterTeam, range]);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Timesheet</button>
      <h1>Task Status Report</h1>
      <div className="subtitle">Allocated tasks per employee — completed, in progress, pending, and on hold.</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)}>
          <option value="">All Teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.department})</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="all">All Time</option>
          <option value="daily">Today</option>
          <option value="weekly">This Week</option>
          <option value="monthly">This Month</option>
        </select>
      </div>
      {error && <div className="banner error">{error}</div>}

      {data && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Total Allocated</div><div className="kpi-value">{data.totals.total}</div></div>
          <div className="kpi-card green"><div className="kpi-label">Completed</div><div className="kpi-value">{data.totals.completed}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">In Progress</div><div className="kpi-value">{data.totals.in_progress}</div></div>
          <div className="kpi-card red"><div className="kpi-label">Pending</div><div className="kpi-value">{data.totals.pending}</div></div>
        </div>
      )}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>By Employee</div>
        {!data && <div className="empty">Loading…</div>}
        {data && data.rows.length === 0 && <div className="empty">No allocated tasks yet.</div>}
        {data && data.rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid #EEF0F3' }}>
                  <th style={{ padding: '6px 8px' }}>Employee</th>
                  <th style={{ padding: '6px 8px' }}>Department</th>
                  <th style={{ padding: '6px 8px' }}>Total</th>
                  <th style={{ padding: '6px 8px' }}>Completed</th>
                  <th style={{ padding: '6px 8px' }}>In Progress</th>
                  <th style={{ padding: '6px 8px' }}>Pending</th>
                  <th style={{ padding: '6px 8px' }}>On Hold</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.employee_id} style={{ borderBottom: '1px solid #EEF0F3' }}>
                    <td style={{ padding: '6px 8px' }}>{r.employee_name} <span className="feature-meta">({r.employee_code})</span></td>
                    <td style={{ padding: '6px 8px' }}>{r.department || '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{r.total}</td>
                    <td style={{ padding: '6px 8px' }}><span className="status-tag present">{r.completed}</span></td>
                    <td style={{ padding: '6px 8px' }}><span className="status-tag info">{r.in_progress}</span></td>
                    <td style={{ padding: '6px 8px' }}><span className="status-tag pending">{r.pending}</span></td>
                    <td style={{ padding: '6px 8px' }}><span className="status-tag absent">{r.on_hold}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

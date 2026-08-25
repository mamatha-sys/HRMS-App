import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own project list.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own projects
// (MyProjects) AND the company project list below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
const STATUS_CLASS = { Active: 'present', 'On Hold': 'pending', Completed: 'locked' };
const TIMESHEET_STATUS_CLASS = { Pending: 'pending', Approved: 'present', Rejected: 'absent' };

export default function Projects() {
  const { user } = useAuth();
  const isHR = FULL_HR_ROLES.includes(user?.role) || SELF_AND_ADMIN_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('list');
  const [selectedId, setSelectedId] = useState(null);

  if (screen === 'detail') return <ProjectDetail id={selectedId} isHR={isHR} onBack={() => setScreen('list')} />;
  if (screen === 'resources') return <ResourceOverview onBack={() => setScreen('list')} />;
  if (screen === 'timesheetReports') return <TimesheetReportsScreen onBack={() => setScreen('list')} />;

  if (FULL_HR_ROLES.includes(user?.role)) {
    return <ProjectList onOpen={(id) => { setSelectedId(id); setScreen('detail'); }} onResources={() => setScreen('resources')} onTimesheetReports={() => setScreen('timesheetReports')} />;
  }
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) {
    return (<>
      <MyProjects compact />
      <ProjectList compact sectionLabel="Company Projects" onOpen={(id) => { setSelectedId(id); setScreen('detail'); }} onResources={() => setScreen('resources')} onTimesheetReports={() => setScreen('timesheetReports')} />
    </>);
  }
  return <MyProjects />;
}

function ProjectList({ onOpen, onResources, onTimesheetReports, compact, sectionLabel }) {
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', start_date: '' });

  function load() { api.get('/projects').then((r) => setProjects(r.data.projects)).catch(() => setError('Could not load projects.')); }
  useEffect(load, []);

  async function add(e) {
    e.preventDefault(); setError('');
    if (!form.name.trim()) { setError('Project name is required.'); return; }
    try { await api.post('/projects', form); setForm({ name: '', description: '', start_date: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add project.'); }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Projects'}</div> : <h1>Project &amp; Resource Management</h1>}
          {!compact && <div className="subtitle">Track projects, hours logged against them, and who's allocated to them.</div>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button onClick={onTimesheetReports}>Timesheet Reports</button>
          <button onClick={onResources}>Resource Overview</button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={add} className="row" style={{ flexWrap: 'wrap' }}>
            <input placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ flex: '1 1 160px' }} />
            <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ flex: '2 1 200px' }} />
            <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            <button className="primary" type="submit">+ Add Project</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        ) : <button className="primary" onClick={() => setShowForm(true)}>+ Add Project</button>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        {projects.length === 0 && <div className="empty">No projects yet.</div>}
        {projects.map((p) => (
          <div key={p.id} className="rec-row" onClick={() => onOpen(p.id)} style={{ cursor: 'pointer' }}>
            <span><strong>{p.name}</strong> <span className="feature-meta">{p.assignedCount} assigned</span>
              {p.description && <div className="feature-meta">{p.description}</div>}
            </span>
            <span className={'status-tag ' + (STATUS_CLASS[p.status] || 'info')}>{p.status}</span>
          </div>
        ))}
      </div>

      <TimesheetApprovalSection />
    </div>
  );
}

function ProjectDetail({ id, isHR, onBack }) {
  const [project, setProject] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ employee_id: '', allocation_pct: 100, role_on_project: '' });

  function load() {
    api.get(`/projects/${id}`).then((r) => { setProject(r.data.project); setAssignments(r.data.assignments); }).catch(() => setError('Could not load project.'));
    if (isHR) api.get('/employees').then((r) => setEmployees(r.data.employees || r.data)).catch(() => {});
  }
  useEffect(load, [id]);

  async function assign(e) {
    e.preventDefault(); setError('');
    if (!form.employee_id) { setError('Choose an employee.'); return; }
    try { await api.post(`/projects/${id}/assign`, form); setForm({ employee_id: '', allocation_pct: 100, role_on_project: '' }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign.'); }
  }
  async function unassign(employeeId) {
    try { await api.delete(`/projects/${id}/assign/${employeeId}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not remove.'); }
  }
  async function setStatus(status) {
    try { await api.put(`/projects/${id}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  if (!project) return <div><button onClick={onBack}>← Back to Projects</button></div>;
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Projects</button>
      <h1>{project.name}</h1>
      <div className="subtitle">{project.description}</div>
      {error && <div className="banner error">{error}</div>}

      {isHR && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ gap: 6 }}>
            {['Active', 'On Hold', 'Completed'].map((s) => (
              <button key={s} className={project.status === s ? 'primary' : ''} onClick={() => setStatus(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Assigned Employees</div>
        {assignments.length === 0 && <div className="empty">No one assigned yet.</div>}
        {assignments.map((a) => (
          <div key={a.employee_id} className="rec-row">
            <span>{a.name} <span className="feature-meta">({a.employee_code}){a.role_on_project ? ` · ${a.role_on_project}` : ''}</span></span>
            <span className="row" style={{ gap: 6 }}>
              <span className="status-tag info">{a.allocation_pct}%</span>
              {isHR && <button onClick={() => unassign(a.employee_id)}>Remove</button>}
            </span>
          </div>
        ))}
        {isHR && (
          <form onSubmit={assign} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} required style={{ flex: '1 1 180px' }}>
              <option value="">Select employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <input type="number" min="1" max="100" placeholder="Allocation %" value={form.allocation_pct} onChange={(e) => setForm({ ...form, allocation_pct: e.target.value })} style={{ width: 110 }} />
            <input placeholder="Role on project" value={form.role_on_project} onChange={(e) => setForm({ ...form, role_on_project: e.target.value })} style={{ flex: '1 1 140px' }} />
            <button className="primary" type="submit">Assign</button>
          </form>
        )}
      </div>
    </div>
  );
}

function ResourceOverview({ onBack }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/projects/reports/resource-overview').then((r) => setRows(r.data.rows)).catch(() => setError('Could not load resource overview.')); }, []);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Projects</button>
      <h1>Resource Overview</h1>
      <div className="subtitle">Total allocation % across every Active project — anyone over 100% is double-booked.</div>
      {error && <div className="banner error">{error}</div>}
      <div className="card">
        {rows.length === 0 && <div className="empty">No active project assignments.</div>}
        {rows.map((r) => (
          <div key={r.id} className="rec-row">
            <span>{r.name} <span className="feature-meta">({r.employee_code} · {r.department}) · {r.project_count} project{r.project_count === 1 ? '' : 's'}</span></span>
            <span className={'status-tag ' + (r.overAllocated ? 'absent' : 'present')}>{r.total_allocation_pct}%{r.overAllocated ? ' — over-allocated' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Total approved hours by project, and by employee.
function TimesheetReportsScreen({ onBack }) {
  const [byProject, setByProject] = useState([]);
  const [byEmployee, setByEmployee] = useState([]);
  useEffect(() => { api.get('/projects/timesheet/reports').then((r) => { setByProject(r.data.byProject); setByEmployee(r.data.byEmployee); }).catch(() => {}); }, []);

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Projects</button>
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

// HR/manager-facing card: review and approve/reject hours employees have logged against
// projects. Shown beneath the project list — same audience as the rest of this admin view
// (company-wide HR-tier, or scoped for Assistant Manager/STL/TL).
function TimesheetApprovalSection() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');

  function load() { api.get('/projects/timesheet/overview').then((r) => setEntries(r.data.entries)).catch(() => setError('Could not load timesheet entries.')); }
  useEffect(load, []);

  async function decide(id, decision) {
    try { await api.put(`/projects/timesheet/${id}/${decision}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>Timesheet Approval</div>
      {error && <div className="banner error">{error}</div>}
      {entries.length === 0 && <div className="empty">No timesheet entries yet.</div>}
      {entries.map((e) => (
        <div key={e.id} className="rec-row">
          <span>{e.employee_name} — <strong>{e.project_name}</strong> · {e.date} · {e.hours}h
            {e.task_description && <div className="feature-meta">{e.task_description}</div>}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <span className={'status-tag ' + (TIMESHEET_STATUS_CLASS[e.status] || 'info')}>{e.status}</span>
            {e.status === 'Pending' && <>
              <button onClick={() => decide(e.id, 'approve')}>Approve</button>
              <button onClick={() => decide(e.id, 'reject')}>Reject</button>
            </>}
          </span>
        </div>
      ))}
    </div>
  );
}

// Employee self-service: log hours against a project I'm assigned to, and see my own entries.
function MyTimesheetSection() {
  const [entries, setEntries] = useState([]);
  const [myProjects, setMyProjects] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ project_id: '', date: '', task_description: '', hours: '' });

  function load() { api.get('/projects/timesheet').then((r) => { setEntries(r.data.entries); setMyProjects(r.data.myProjects); }).catch(() => setError('Could not load timesheet.')); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      await api.post('/projects/timesheet', form);
      setForm({ project_id: '', date: '', task_description: '', hours: '' });
      setShowForm(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not log hours.'); }
  }

  return (
    <div>
      <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>My Timesheet</div>
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
            <span className={'status-tag ' + (TIMESHEET_STATUS_CLASS[e.status] || 'info')}>{e.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MyProjects({ compact }) {
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/projects/mine/list').then((r) => setAssignments(r.data.assignments)).catch(() => setError('Could not load your projects.')); }, []);

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Projects</div> : <h1>My Projects</h1>}
      {!compact && <div className="subtitle">Projects you're assigned to.</div>}
      {error && <div className="banner error">{error}</div>}
      <div className="card">
        {assignments.length === 0 && <div className="empty">You're not assigned to any project yet.</div>}
        {assignments.map((a) => (
          <div key={a.id} className="rec-row">
            <span><strong>{a.project_name}</strong>{a.role_on_project ? ` — ${a.role_on_project}` : ''}</span>
            <span className="row" style={{ gap: 6 }}>
              <span className="status-tag info">{a.allocation_pct}%</span>
              <span className={'status-tag ' + (STATUS_CLASS[a.project_status] || 'info')}>{a.project_status}</span>
            </span>
          </div>
        ))}
      </div>

      <MyTimesheetSection />
    </div>
  );
}

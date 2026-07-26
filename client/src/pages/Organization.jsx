import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function Organization() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [teams, setTeams] = useState([]);
  const [error, setError] = useState('');
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptParent, setNewDeptParent] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchLocation, setNewBranchLocation] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDept, setNewTeamDept] = useState('');
  const [editing, setEditing] = useState(null); // { type:'dept'|'branch'|'team', id }
  const [editValue, setEditValue] = useState('');

  function load() {
    Promise.all([api.get('/org/departments'), api.get('/org/branches'), api.get('/org/teams')])
      .then(([d, b, t]) => { setDepartments(d.data.departments); setBranches(b.data.branches); setTeams(t.data.teams); })
      .catch(() => setError('Could not load organization structure.'));
  }
  useEffect(load, []);

  async function addDepartment(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/org/departments', { name: newDeptName, parent_department_id: newDeptParent || null });
      setNewDeptName(''); setNewDeptParent('');
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add department.'); }
  }

  async function addBranch(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/org/branches', { name: newBranchName, location: newBranchLocation });
      setNewBranchName(''); setNewBranchLocation('');
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add branch.'); }
  }

  async function addTeam(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/org/teams', { name: newTeamName, department_id: newTeamDept });
      setNewTeamName(''); setNewTeamDept('');
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add team.'); }
  }

  const typePath = { dept: 'departments', branch: 'branches', team: 'teams' };

  async function togglePause(type, item) {
    setError('');
    const next = item.status === 'Paused' ? 'Active' : 'Paused';
    try {
      await api.put(`/org/${typePath[type]}/${item.id}`, { status: next });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  function startEdit(type, item) { setEditing({ type, id: item.id }); setEditValue(item.name); }

  async function saveEdit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/org/${typePath[editing.type]}/${editing.id}`, { name: editValue });
      setEditing(null);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not rename.'); }
  }

  const roots = departments.filter((d) => !d.parent_department_id);
  const childrenOf = (id) => departments.filter((d) => d.parent_department_id === id);
  const isEditing = (type, id) => editing && editing.type === type && editing.id === id;

  const actions = (type, item) => isSuperAdmin && !isEditing(type, item.id) && (
    <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
      <button onClick={() => startEdit(type, item)}>Edit</button>
      <button onClick={() => togglePause(type, item)}>{item.status === 'Paused' ? 'Resume' : 'Pause'}</button>
    </span>
  );

  const statusTag = (item) => (
    <span className={'status-tag ' + (item.status === 'Paused' ? 'pending' : 'present')} style={{ marginLeft: 6 }}>{item.status}</span>
  );

  return (
    <div>
      <h1>Organization Structure</h1>
      <div className="subtitle">Departments and branches used across Employee Management. Edit or pause any entry; paused ones stay on record with their history.</div>

      {error && <div className="banner error">{error}</div>}

      <div className="grid2">
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 10 }}>Departments</div>
          {roots.map((root) => (
            <div key={root.id}>
              <div className="rec-row" style={{ opacity: root.status === 'Paused' ? 0.6 : 1 }}>
                {isEditing('dept', root.id) ? (
                  <form onSubmit={saveEdit} className="row" style={{ flex: 1, marginBottom: 0 }}>
                    <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                    <button className="primary" type="submit">Save</button>
                    <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <span>{root.name}{statusTag(root)}<div className="feature-meta">Added {root.created_at?.slice(0, 10)}</div></span>
                )}
                {actions('dept', root)}
              </div>
              {childrenOf(root.id).map((child) => (
                <div key={child.id} className="rec-row" style={{ paddingLeft: 20, opacity: child.status === 'Paused' ? 0.6 : 1 }}>
                  {isEditing('dept', child.id) ? (
                    <form onSubmit={saveEdit} className="row" style={{ flex: 1, marginBottom: 0 }}>
                      <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                      <button className="primary" type="submit">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <span>└ {child.name}{statusTag(child)}<div className="feature-meta">Added {child.created_at?.slice(0, 10)}</div></span>
                  )}
                  {actions('dept', child)}
                </div>
              ))}
            </div>
          ))}
          {departments.length === 0 && <div className="empty">No departments yet.</div>}

          {isSuperAdmin && (
            <form onSubmit={addDepartment} className="row" style={{ marginTop: 14 }}>
              <input placeholder="New department name" value={newDeptName} onChange={(e) => setNewDeptName(e.target.value)} required />
              <select value={newDeptParent} onChange={(e) => setNewDeptParent(e.target.value)}>
                <option value="">No parent (top-level)</option>
                {departments.map((d) => <option key={d.id} value={d.id}>Under: {d.name}</option>)}
              </select>
              <button className="primary" type="submit">+ Add</button>
            </form>
          )}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 10 }}>Branches</div>
          {branches.map((b) => (
            <div key={b.id} className="rec-row" style={{ opacity: b.status === 'Paused' ? 0.6 : 1 }}>
              {isEditing('branch', b.id) ? (
                <form onSubmit={saveEdit} className="row" style={{ flex: 1, marginBottom: 0 }}>
                  <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                  <button className="primary" type="submit">Save</button>
                  <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <span>{b.name} {b.location ? `— ${b.location}` : ''}{statusTag(b)}<div className="feature-meta">Added {b.created_at?.slice(0, 10)}</div></span>
              )}
              {actions('branch', b)}
            </div>
          ))}
          {branches.length === 0 && <div className="empty">No branches yet.</div>}

          {isSuperAdmin && (
            <form onSubmit={addBranch} className="row" style={{ marginTop: 14 }}>
              <input placeholder="Branch name" value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} required />
              <input placeholder="Location" value={newBranchLocation} onChange={(e) => setNewBranchLocation(e.target.value)} />
              <button className="primary" type="submit">+ Add</button>
            </form>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="feature-name" style={{ marginBottom: 4 }}>Teams</div>
        <div className="feature-meta" style={{ marginBottom: 10 }}>Sub-units within a department (e.g. Education's Team-A / Team-B). Used to scope a Team Lead's or Senior Team Lead's Attendance/Leave/Approvals access in User &amp; Role Management — see Manage Users.</div>
        {departments.map((d) => {
          const deptTeams = teams.filter((t) => t.department_id === d.id);
          if (deptTeams.length === 0) return null;
          return (
            <div key={d.id} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13, opacity: 0.8 }}>{d.name}</div>
              {deptTeams.map((t) => (
                <div key={t.id} className="rec-row" style={{ paddingLeft: 20, opacity: t.status === 'Paused' ? 0.6 : 1 }}>
                  {isEditing('team', t.id) ? (
                    <form onSubmit={saveEdit} className="row" style={{ flex: 1, marginBottom: 0 }}>
                      <input value={editValue} onChange={(e) => setEditValue(e.target.value)} autoFocus />
                      <button className="primary" type="submit">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <span>└ {t.name}{statusTag(t)}<div className="feature-meta">Added {t.created_at?.slice(0, 10)}</div></span>
                  )}
                  {actions('team', t)}
                </div>
              ))}
            </div>
          );
        })}
        {teams.length === 0 && <div className="empty">No teams yet.</div>}

        {isSuperAdmin && (
          <form onSubmit={addTeam} className="row" style={{ marginTop: 14 }}>
            <input placeholder="Team name (e.g. Team-A)" value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} required />
            <select value={newTeamDept} onChange={(e) => setNewTeamDept(e.target.value)} required>
              <option value="">Under department...</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="primary" type="submit">+ Add</button>
          </form>
        )}
      </div>
    </div>
  );
}

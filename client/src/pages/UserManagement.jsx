import { Fragment, useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { SCOPED_ROLES } from '../roles.js';

const EMPTY_NEW_USER = { name: '', email: '', password: '', role: 'employee' };


export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [teams, setTeams] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [scopeEditingId, setScopeEditingId] = useState(null);
  const [scopeDraft, setScopeDraft] = useState({ departmentIds: [], teamIds: [] });

  function load() {
    setLoading(true);
    api.get('/users')
      .then((res) => setUsers(res.data.users))
      .catch(() => setError('Could not load users.'))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);
  useEffect(() => {
    api.get('/roles').then((res) => setRoles(res.data.roles)).catch(() => {});
    api.get('/org/departments').then((res) => setDepartments(res.data.departments)).catch(() => {});
    api.get('/org/teams').then((res) => setTeams(res.data.teams)).catch(() => {});
  }, []);

  async function startEditScope(u) {
    setError('');
    try {
      const res = await api.get(`/users/${u.id}/scope`);
      setScopeDraft({ departmentIds: res.data.departmentIds, teamIds: res.data.teamIds });
      setScopeEditingId(u.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load scope.');
    }
  }

  function toggleScopeId(kind, id) {
    setScopeDraft((d) => {
      const key = kind === 'dept' ? 'departmentIds' : 'teamIds';
      const has = d[key].includes(id);
      return { ...d, [key]: has ? d[key].filter((x) => x !== id) : [...d[key], id] };
    });
  }

  async function saveScope(id) {
    setError('');
    try {
      await api.put(`/users/${id}/scope`, scopeDraft);
      setScopeEditingId(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save scope.');
    }
  }

  const roleLabel = (key) => roles.find((r) => r.key === key)?.name || key;

  async function addUser(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/users', newUser);
      setNewUser(EMPTY_NEW_USER);
      setShowAdd(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create user.');
    }
  }

  async function changeRole(id, role) {
    setError('');
    try {
      await api.put(`/users/${id}`, { role });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change role.');
    }
  }

  async function toggleActive(u) {
    setError('');
    try {
      await api.put(`/users/${u.id}`, { active: !u.active });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update status.');
    }
  }

  return (
    <div>
      <h1>Role &amp; User Management</h1>
      <div className="subtitle">Add users, change a user's role, or deactivate their account. Deactivated users cannot sign in.</div>

      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
        <button className="primary" onClick={() => setShowAdd((v) => !v)}>{showAdd ? 'Cancel' : '+ Add user'}</button>
      </div>

      {showAdd && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 10 }}>Add user</div>
          <form onSubmit={addUser}>
            <div className="grid2">
              <div>
                <label className="field-label">Full name</label>
                <input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} required />
              </div>
              <div>
                <label className="field-label">Email</label>
                <input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} required />
              </div>
              <div>
                <label className="field-label">Password <span className="note">(min 6 chars)</span></label>
                <input type="text" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} required />
              </div>
              <div>
                <label className="field-label">Role</label>
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                  {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" type="submit">Create user</button>
            </div>
            <div className="note" style={{ marginTop: 6 }}>The user signs in with this email + password.</div>
          </form>
        </div>
      )}

      <div className="card">
        {loading && <div className="empty">Loading...</div>}
        {!loading && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Scope</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>
                      <select value={u.role} disabled={u.id === currentUser.id} onChange={(e) => changeRole(u.id, e.target.value)}>
                        {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                      </select>
                    </td>
                    <td><span className={'status-tag ' + (u.active ? 'present' : 'absent')}>{u.active ? 'Active' : 'Deactivated'}</span></td>
                    <td>
                      {SCOPED_ROLES.includes(u.role)
                        ? <button onClick={() => (scopeEditingId === u.id ? setScopeEditingId(null) : startEditScope(u))}>
                            {scopeEditingId === u.id ? 'Close' : 'Edit scope'}
                          </button>
                        : <span className="feature-meta">—</span>}
                    </td>
                    <td>
                      <button disabled={u.id === currentUser.id} onClick={() => toggleActive(u)}>
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  </tr>
                  {scopeEditingId === u.id && (
                    <tr>
                      <td colSpan={6}>
                        <div className="card" style={{ margin: '4px 0' }}>
                          <div className="feature-name" style={{ marginBottom: 6 }}>Assigned departments &amp; teams for {u.name}</div>
                          <div className="feature-meta" style={{ marginBottom: 10 }}>
                            A department grant covers every team within it (Senior Team Lead scope); a team grant covers only that team's members (Team Lead scope). Attendance, Leave and Approvals are filtered to whatever is checked below — nothing checked means no visibility.
                          </div>
                          <div className="grid2">
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Departments</div>
                              {departments.map((d) => (
                                <label key={d.id} style={{ display: 'block', marginBottom: 4 }}>
                                  <input type="checkbox" checked={scopeDraft.departmentIds.includes(d.id)} onChange={() => toggleScopeId('dept', d.id)} /> {d.name}
                                </label>
                              ))}
                              {departments.length === 0 && <div className="empty">No departments yet.</div>}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Teams</div>
                              {teams.map((t) => (
                                <label key={t.id} style={{ display: 'block', marginBottom: 4 }}>
                                  <input type="checkbox" checked={scopeDraft.teamIds.includes(t.id)} onChange={() => toggleScopeId('team', t.id)} /> {t.name} <span className="feature-meta">({t.department_name})</span>
                                </label>
                              ))}
                              {teams.length === 0 && <div className="empty">No teams yet — add some in Organization Structure.</div>}
                            </div>
                          </div>
                          <div className="row" style={{ marginTop: 12 }}>
                            <button className="primary" onClick={() => saveScope(u.id)}>Save scope</button>
                            <button onClick={() => setScopeEditingId(null)}>Cancel</button>
                          </div>
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

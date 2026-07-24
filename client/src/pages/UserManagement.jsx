import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const EMPTY_NEW_USER = { name: '', email: '', password: '', role: 'employee' };

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);

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
  }, []);

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

  async function resetFace(id) {
    if (!window.confirm('Clear this user\'s enrolled face? Their next successful login will re-enroll a new one.')) return;
    setError('');
    try {
      await api.put(`/users/${id}/reset-face`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset face enrollment.');
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
            <div className="note" style={{ marginTop: 6 }}>The user signs in with this email + password; their face is enrolled on first login.</div>
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
                <th>Face enrolled</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role} disabled={u.id === currentUser.id} onChange={(e) => changeRole(u.id, e.target.value)}>
                      {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select>
                  </td>
                  <td>{u.faceEnrolled ? 'Yes' : 'No'}</td>
                  <td><span className={'status-tag ' + (u.active ? 'present' : 'absent')}>{u.active ? 'Active' : 'Deactivated'}</span></td>
                  <td>
                    <button disabled={u.id === currentUser.id} onClick={() => toggleActive(u)}>
                      {u.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                    {u.faceEnrolled && (
                      <button style={{ marginLeft: 6 }} onClick={() => resetFace(u.id)}>Reset face</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

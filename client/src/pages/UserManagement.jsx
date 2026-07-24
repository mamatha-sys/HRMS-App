import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const ROLE_LABELS = { super_admin: 'Super Admin', manager: 'Manager', employee: 'Employee' };

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    api.get('/users')
      .then((res) => setUsers(res.data.users))
      .catch(() => setError('Could not load users.'))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

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
      <div className="subtitle">Change a user's role or deactivate their account. Deactivated users cannot sign in.</div>

      {error && <div className="banner error">{error}</div>}

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
                      {Object.entries(ROLE_LABELS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
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

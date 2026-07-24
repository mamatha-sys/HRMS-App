import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function Organization() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptParent, setNewDeptParent] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchLocation, setNewBranchLocation] = useState('');

  function load() {
    Promise.all([api.get('/org/departments'), api.get('/org/branches')])
      .then(([d, b]) => { setDepartments(d.data.departments); setBranches(b.data.branches); })
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
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add department.');
    }
  }

  async function deleteDepartment(id) {
    if (!window.confirm('Delete this department?')) return;
    try {
      await api.delete(`/org/departments/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete department.');
    }
  }

  async function addBranch(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/org/branches', { name: newBranchName, location: newBranchLocation });
      setNewBranchName(''); setNewBranchLocation('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add branch.');
    }
  }

  async function deleteBranch(id) {
    if (!window.confirm('Delete this branch?')) return;
    try {
      await api.delete(`/org/branches/${id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete branch.');
    }
  }

  const roots = departments.filter((d) => !d.parent_department_id);
  const childrenOf = (id) => departments.filter((d) => d.parent_department_id === id);

  return (
    <div>
      <h1>Organization Structure</h1>
      <div className="subtitle">Departments (with hierarchy) and branches used across Employee Management.</div>

      {error && <div className="banner error">{error}</div>}

      <div className="grid2">
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 10 }}>Departments</div>
          {roots.map((root) => (
            <div key={root.id}>
              <div className="tree-item" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{root.name}</span>
                {isSuperAdmin && <button onClick={() => deleteDepartment(root.id)}>Delete</button>}
              </div>
              {childrenOf(root.id).map((child) => (
                <div key={child.id} className="tree-item sub" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>└ {child.name}</span>
                  {isSuperAdmin && <button onClick={() => deleteDepartment(child.id)}>Delete</button>}
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
            <div key={b.id} className="rec-row">
              <span>{b.name} {b.location ? `— ${b.location}` : ''}</span>
              {isSuperAdmin && <button onClick={() => deleteBranch(b.id)}>Delete</button>}
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
    </div>
  );
}

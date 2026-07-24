import { useEffect, useState } from 'react';
import api from '../api.js';

// Three nested views: role catalog -> module list (Edit Access) -> feature/action matrix (Configure).
export default function ManageRoles() {
  const [view, setView] = useState('catalog'); // catalog | modules | matrix
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScope, setNewScope] = useState('');

  const [activeRole, setActiveRole] = useState(null);
  const [modules, setModules] = useState([]);
  const [activeModule, setActiveModule] = useState(null);
  const [matrix, setMatrix] = useState(null);

  function loadCatalog() {
    api.get('/roles').then((res) => setRoles(res.data.roles)).catch(() => setError('Could not load roles.'));
  }
  useEffect(loadCatalog, []);

  async function createRole(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/roles', { name: newName, scope_description: newScope });
      setNewName(''); setNewScope(''); setShowCreate(false);
      loadCatalog();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create role.');
    }
  }

  async function openModules(role) {
    setError('');
    try {
      const res = await api.get(`/roles/${role.id}/modules`);
      setActiveRole(res.data.role);
      setModules(res.data.modules);
      setView('modules');
    } catch {
      setError('Could not load modules for this role.');
    }
  }

  async function openMatrix(module_) {
    setError('');
    try {
      const res = await api.get(`/roles/${activeRole.id}/modules/${module_.id}`);
      setActiveModule(res.data.module);
      setMatrix(res.data);
      setView('matrix');
    } catch {
      setError('Could not load the permission matrix.');
    }
  }

  async function toggle(feature, action, granted) {
    if (activeRole.is_system) return;
    // optimistic update
    setMatrix((prev) => ({
      ...prev,
      features: prev.features.map((f) => f.id !== feature.id ? f : {
        ...f,
        actions: granted ? [...f.actions, action] : f.actions.filter((a) => a !== action)
      })
    }));
    try {
      await api.put(`/roles/${activeRole.id}/permissions`, { feature_id: feature.id, action, granted });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update permission.');
      openMatrix(activeModule); // resync
    }
  }

  // --- View 1: Role Catalog ---
  if (view === 'catalog') {
    return (
      <div>
        <h1>Manage Roles</h1>
        <div className="subtitle">Role catalog and per-role, per-feature access. Click Edit Access to configure a role's module and feature permissions.</div>
        {error && <div className="banner error">{error}</div>}

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Role Catalog</div>
          {roles.map((r) => (
            <div key={r.id} className="role-row">
              <div>
                <div className="role-name">{r.name}{r.userCount > 0 ? ` · ${r.userCount} user${r.userCount === 1 ? '' : 's'}` : ''}</div>
                <div className="role-scope">{r.scope_description}</div>
              </div>
              <button className="access-btn" onClick={() => openModules(r)}>Edit Access</button>
            </div>
          ))}

          {showCreate ? (
            <form onSubmit={createRole} className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
              <input placeholder="Role name (e.g. Regional Auditor)" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: '1 1 180px' }} />
              <input placeholder="Data scope description" value={newScope} onChange={(e) => setNewScope(e.target.value)} style={{ flex: '2 1 220px' }} />
              <button className="primary" type="submit">Create</button>
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
            </form>
          ) : (
            <button className="primary" style={{ marginTop: 14 }} onClick={() => setShowCreate(true)}>+ Create Role</button>
          )}
        </div>
      </div>
    );
  }

  // --- View 2: Module list for a role (Edit Access) ---
  if (view === 'modules') {
    return (
      <div>
        <h1>Edit Access — {activeRole.name}</h1>
        <div className="subtitle">
          <span className="crumb" onClick={() => setView('catalog')}>← Back to Role Catalog</span>
        </div>
        {error && <div className="banner error">{error}</div>}

        <div className="scope-banner">Data Scope for this role: {activeRole.scope_description}</div>
        {activeRole.is_system && <div className="banner info">Super Admin always has full access on every feature — permissions are shown read-only.</div>}

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Modules</div>
          {modules.map((m) => (
            <div key={m.id} className="role-row">
              <div>
                <div className="role-name">{m.code}. {m.name}</div>
                <div className="role-scope">{m.featureCount} features · {m.grantedFeatureCount} with at least one action granted</div>
              </div>
              <button className="access-btn" onClick={() => openMatrix(m)}>Configure →</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --- View 3: Feature/action matrix (Configure) ---
  const grouped = {};
  matrix.features.forEach((f) => { (grouped[f.category] = grouped[f.category] || []).push(f); });

  return (
    <div>
      <h1>{activeModule.name} — {activeRole.name}</h1>
      <div className="subtitle">
        <span className="crumb" onClick={() => setView('catalog')}>Role Catalog</span>
        {' / '}
        <span className="crumb" onClick={() => setView('modules')}>Edit Access</span>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="scope-banner">Data Scope: {activeRole.scope_description}</div>
      {activeRole.is_system && <div className="banner info">Super Admin permissions are read-only — this role always has every action.</div>}

      {Object.entries(grouped).map(([category, feats]) => (
        <div key={category} className="card">
          <div className="feature-name" style={{ marginBottom: 6 }}>{category} <span className="note">({feats.length} feature{feats.length === 1 ? '' : 's'})</span></div>
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Feature</th>
                  {matrix.actions.map((a) => <th key={a} title={a}>{a.slice(0, 4)}</th>)}
                </tr>
              </thead>
              <tbody>
                {feats.map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td>
                    {matrix.actions.map((a) => {
                      const checked = f.actions.includes(a);
                      return (
                        <td key={a}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={activeRole.is_system}
                            onChange={(e) => toggle(f, a, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

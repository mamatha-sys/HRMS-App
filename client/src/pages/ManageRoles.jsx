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
  const [showCreateAction, setShowCreateAction] = useState(false);
  const [newAction, setNewAction] = useState('');
  // Every action that exists anywhere, so the add box can suggest ones not yet on this module.
  const [knownActions, setKnownActions] = useState([]);
  useEffect(() => { api.get('/roles/actions').then((r) => setKnownActions(r.data.actions)).catch(() => {}); }, []);

  // Action names are global — a new one becomes an extra column in every module's matrix,
  // granted to nobody until someone ticks it.
  async function createAction(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/roles/actions', { name: newAction, module_id: activeModule.id });
      setNewAction(''); setShowCreateAction(false);
      await openMatrix(activeModule); // reload so the new column appears
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create that action.');
    }
  }

  async function removeAction(action) {
    if (!window.confirm(`Stop showing "${action}" on ${activeModule.name}?\n\nAny ${action} permission already granted on this module will be cleared. Other modules keep it.`)) return;
    setError('');
    try {
      await api.delete(`/roles/actions/${encodeURIComponent(action)}?module_id=${activeModule.id}`);
      await openMatrix(activeModule);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove that action.');
    }
  }

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
        {/* Re-fetch rather than just switching view: the module list carries each module's
            "features with at least one action granted" count, which is now stale after the
            grants just toggled in this matrix. Without this, revoking a permission and going
            back still shows the old count, so the change looks like it didn't apply. */}
        <span className="crumb" onClick={() => openModules(activeRole)}>Edit Access</span>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="scope-banner">Data Scope: {activeRole.scope_description}</div>
      {activeRole.is_system && <div className="banner info">Super Admin permissions are read-only — this role always has every action.</div>}

      {!activeRole.is_system && (
        <div className="card">
          <div className="row" style={{ alignItems: 'center' }}>
            <div>
              <div className="feature-name">Actions</div>
              <div className="feature-meta">
                {matrix.actions.length} action{matrix.actions.length === 1 ? '' : 's'} shown on this module.
                Add an existing one (e.g. Export) to show its column here, or type a new name to create it.
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => setShowCreateAction((v) => !v)}>{showCreateAction ? 'Cancel' : '+ Add action'}</button>
          </div>
          {showCreateAction && (
            <form onSubmit={createAction} className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <input list="known-actions" placeholder="Action name (e.g. Export)" value={newAction} onChange={(e) => setNewAction(e.target.value)} required style={{ flex: '1 1 240px' }} />
              <datalist id="known-actions">
                {knownActions.filter((a) => !matrix.actions.includes(a)).map((a) => <option key={a} value={a} />)}
              </datalist>
              <button className="primary" type="submit">Add</button>
            </form>
          )}

          {/* Only a module with its own configured list can have an action taken off it — an
              unrestricted module shows all twelve and has no list to remove from. */}
          {matrix.restricted && (
            <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
              {matrix.actions.map((a) => (
                <span key={a} className="status-tag info" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {a}
                  <button
                    title={`Stop showing ${a} on this module`}
                    onClick={() => removeAction(a)}
                    style={{ width: 'auto', padding: '0 4px', border: 'none', background: 'none', cursor: 'pointer', lineHeight: 1 }}
                  >×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

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

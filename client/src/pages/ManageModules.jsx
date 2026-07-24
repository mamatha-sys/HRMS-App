import { useEffect, useState } from 'react';
import api from '../api.js';

export default function ManageModules() {
  const [modules, setModules] = useState([]);
  const [standardModules, setStandardModules] = useState([]);
  const [error, setError] = useState('');
  const [newModuleName, setNewModuleName] = useState('');
  const [newFeatureName, setNewFeatureName] = useState({});
  const [featureFormOpen, setFeatureFormOpen] = useState({});
  const [editingModule, setEditingModule] = useState(null);
  const [editName, setEditName] = useState('');

  function load() {
    api.get('/modules').then((res) => {
      setModules(res.data.modules);
      setStandardModules(res.data.standardModules || []);
    }).catch(() => setError('Could not load modules.'));
  }
  useEffect(load, []);

  async function addModule(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/modules', { name: newModuleName });
      setNewModuleName('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add module.');
    }
  }

  async function addFeature(moduleId, e) {
    e.preventDefault();
    setError('');
    const name = newFeatureName[moduleId];
    if (!name) return;
    try {
      await api.post(`/modules/${moduleId}/features`, { name });
      setNewFeatureName((prev) => ({ ...prev, [moduleId]: '' }));
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add feature.');
    }
  }

  async function toggleModuleStatus(m) {
    setError('');
    try {
      await api.put(`/modules/${m.id}`, { status: m.status === 'Paused' ? 'Active' : 'Paused' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update module.');
    }
  }

  function startEditModule(m) {
    setEditingModule(m.id);
    setEditName(m.name);
  }

  async function saveModuleName(m, e) {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/modules/${m.id}`, { name: editName });
      setEditingModule(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not rename module.');
    }
  }

  return (
    <div>
      <h1>Manage modules &amp; features</h1>
      <div className="subtitle">
        Add a custom module and its features — they appear immediately in the sidebar for every user as a generic record-list screen. No deployment needed.
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="section-label" style={{ paddingLeft: 0 }}>Existing modules</div>
      <div className="card">
        <div className="feature-meta" style={{ marginBottom: 8 }}>Built-in modules already in the system (configure their access in Manage Roles):</div>
        {standardModules.map((m) => (
          <div key={m.id} style={{ padding: '6px 0', borderTop: '1px solid #EEF0F3' }}>
            <div className="feature-name" style={{ fontSize: 13.5 }}>{m.code}. {m.name} <span className="note">({m.features.length} features)</span></div>
          </div>
        ))}
        {standardModules.length === 0 && <div className="empty">No built-in modules.</div>}
      </div>

      {modules.length > 0 && <div className="section-label" style={{ paddingLeft: 0 }}>Custom modules</div>}
      {modules.map((m) => (
        <div key={m.id} className="card" style={{ opacity: m.status === 'Paused' ? 0.6 : 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            {editingModule === m.id ? (
              <form onSubmit={(e) => saveModuleName(m, e)} className="row" style={{ flex: 1, marginBottom: 0 }}>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
                <button className="primary" type="submit">Save</button>
                <button type="button" onClick={() => setEditingModule(null)}>Cancel</button>
              </form>
            ) : (
              <div className="feature-name">
                {m.name}{' '}
                <span className={'status-tag ' + (m.status === 'Paused' ? 'pending' : 'present')} style={{ marginLeft: 6 }}>{m.status}</span>
              </div>
            )}
            {editingModule !== m.id && (
              <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => startEditModule(m)}>Edit</button>
                <button onClick={() => toggleModuleStatus(m)}>{m.status === 'Paused' ? 'Resume' : 'Pause'}</button>
              </span>
            )}
          </div>

          {m.features.map((f) => (
            <div key={f.id} className="feature-meta" style={{ marginTop: 4 }}>• {f.name}</div>
          ))}
          {m.features.length === 0 && <div className="empty" style={{ padding: 10, marginTop: 8 }}>No features yet.</div>}

          {featureFormOpen[m.id] ? (
            <form onSubmit={(e) => addFeature(m.id, e)} className="row" style={{ marginTop: 10 }}>
              <input
                placeholder="New feature name (e.g. Onboarding Checklist)"
                value={newFeatureName[m.id] || ''}
                onChange={(e) => setNewFeatureName((prev) => ({ ...prev, [m.id]: e.target.value }))}
                autoFocus
              />
              <button className="primary" type="submit">Add</button>
              <button type="button" onClick={() => setFeatureFormOpen((p) => ({ ...p, [m.id]: false }))}>Cancel</button>
            </form>
          ) : (
            <button style={{ marginTop: 10 }} onClick={() => setFeatureFormOpen((p) => ({ ...p, [m.id]: true }))}>+ Add features</button>
          )}
        </div>
      ))}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Add a new custom module</div>
        <form onSubmit={addModule} className="row">
          <input placeholder="New module name (e.g. Asset Management)" value={newModuleName} onChange={(e) => setNewModuleName(e.target.value)} required />
          <button className="primary" type="submit">+ Add module</button>
        </form>
      </div>
    </div>
  );
}

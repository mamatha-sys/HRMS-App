import { useEffect, useState } from 'react';
import api from '../api.js';

export default function ManageModules() {
  const [modules, setModules] = useState([]);
  const [standardModules, setStandardModules] = useState([]);
  const [error, setError] = useState('');
  const [newModuleName, setNewModuleName] = useState('');
  const [newFeatureName, setNewFeatureName] = useState({});

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
        <div key={m.id} className="card">
          <div className="feature-name">{m.name}</div>
          {m.features.map((f) => (
            <div key={f.id} className="feature-meta" style={{ marginTop: 4 }}>• {f.name}</div>
          ))}
          {m.features.length === 0 && <div className="empty" style={{ padding: 10 }}>No features yet.</div>}

          <form onSubmit={(e) => addFeature(m.id, e)} className="row" style={{ marginTop: 10 }}>
            <input
              placeholder="New feature name (e.g. Onboarding Checklist)"
              value={newFeatureName[m.id] || ''}
              onChange={(e) => setNewFeatureName((prev) => ({ ...prev, [m.id]: e.target.value }))}
            />
            <button className="primary" type="submit">+ Add feature</button>
          </form>
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

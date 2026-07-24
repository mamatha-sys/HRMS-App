import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';

export default function Configurations() {
  const [widgets, setWidgets] = useState([]);
  const [error, setError] = useState('');

  function load() {
    api.get('/config/dashboard').then((res) => setWidgets(res.data.widgets)).catch(() => setError('Could not load configuration.'));
  }
  useEffect(load, []);

  async function toggle(widget, visible) {
    setError('');
    setWidgets((prev) => prev.map((w) => w.widget_key === widget.widget_key ? { ...w, visible } : w));
    try {
      await api.put('/config/dashboard', { widget_key: widget.widget_key, visible });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save.');
      load();
    }
  }

  return (
    <div>
      <h1>Configurations</h1>
      <div className="subtitle">Customize the Dashboard — choose which cards, charts and widgets appear. Changes apply to everyone's dashboard.</div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Dashboard widgets</div>
        {widgets.map((w) => (
          <div key={w.widget_key} className="rec-row">
            <span>{w.label}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', width: 'auto' }}>
              <input type="checkbox" checked={w.visible} onChange={(e) => toggle(w, e.target.checked)} style={{ width: 16, height: 16 }} />
              <span style={{ fontSize: 12, color: w.visible ? '#1E8E5A' : '#8A93A6' }}>{w.visible ? 'Shown' : 'Hidden'}</span>
            </label>
          </div>
        ))}
      </div>

      <div className="note">Tip: hidden widgets are removed from the Dashboard for all roles. <Link to="/dashboard">Go to Dashboard →</Link></div>
    </div>
  );
}

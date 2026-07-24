import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const STATUS_TAG_CLASS = { Open: 'pending', 'In Progress': 'pending', Closed: 'present' };

export default function CustomFeature() {
  const { moduleId, featureId } = useParams();
  const { user } = useAuth();
  const canEdit = user?.role === 'super_admin' || user?.role === 'manager';

  const [records, setRecords] = useState([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  function load() {
    api.get(`/modules/${moduleId}/features/${featureId}/records`)
      .then((res) => setRecords(res.data.records))
      .catch(() => setError('Could not load records.'));
  }
  useEffect(load, [moduleId, featureId]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/modules/${moduleId}/features/${featureId}/records`, { title });
      setTitle('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add record.');
    }
  }

  async function cycleStatus(id) {
    await api.put(`/modules/${moduleId}/features/${featureId}/records/${id}`);
    load();
  }

  return (
    <div>
      <h1>Custom feature</h1>
      <div className="subtitle">A generic record list — every custom module/feature works this way until it needs bespoke UI.</div>

      {error && <div className="banner error">{error}</div>}

      {canEdit && (
        <form onSubmit={submit} className="row" style={{ marginBottom: 14 }}>
          <input placeholder="New record title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <button className="primary" type="submit">+ Add</button>
        </form>
      )}

      <div className="card">
        {records.length === 0 && <div className="empty">No records yet.</div>}
        {records.map((r) => (
          <div key={r.id} className="rec-row">
            <span>{r.title}</span>
            <span
              className={'status-tag ' + STATUS_TAG_CLASS[r.status]}
              style={{ cursor: canEdit ? 'pointer' : 'default' }}
              onClick={() => canEdit && cycleStatus(r.id)}
            >
              {r.status}{canEdit ? ' — click to change' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../api.js';

export default function Recognition() {
  const [feed, setFeed] = useState([]);
  const [awardTypes, setAwardTypes] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ to_employee_id: '', award_type: '', message: '' });

  function load() {
    api.get('/recognition/feed').then((r) => { setFeed(r.data.feed); setAwardTypes(r.data.awardTypes); }).catch(() => setError('Could not load recognitions.'));
    api.get('/recognition/leaderboard').then((r) => setLeaderboard(r.data.leaderboard)).catch(() => {});
    api.get('/employees').then((r) => setEmployees(r.data.employees || r.data)).catch(() => {});
  }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.to_employee_id || !form.award_type || !form.message.trim()) { setError('Choose who, the award type, and write a message.'); return; }
    try {
      await api.post('/recognition', form);
      setForm({ to_employee_id: '', award_type: '', message: '' });
      setShowForm(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not send recognition.'); }
  }

  return (
    <div>
      <h1>Rewards &amp; Recognition</h1>
      <div className="subtitle">Celebrate great work — nominate a colleague and see the company-wide recognition feed.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={submit}>
            <label className="field-label">Recognize *</label>
            <select value={form.to_employee_id} onChange={(e) => setForm({ ...form, to_employee_id: e.target.value })} required style={{ marginBottom: 10 }}>
              <option value="">Select employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
            </select>
            <label className="field-label">Award *</label>
            <select value={form.award_type} onChange={(e) => setForm({ ...form, award_type: e.target.value })} required style={{ marginBottom: 10 }}>
              <option value="">Select award…</option>
              {awardTypes.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <label className="field-label">Message *</label>
            <input value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required style={{ marginBottom: 10 }} />
            <div className="row">
              <button className="primary" type="submit">Give Recognition</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : <button className="primary" onClick={() => setShowForm(true)}>+ Give Recognition</button>}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Leaderboard</div>
        {leaderboard.length === 0 && <div className="empty">No recognitions yet.</div>}
        {leaderboard.map((l, i) => (
          <div key={l.id} className="rec-row">
            <span>#{i + 1} {l.name} <span className="feature-meta">({l.employee_code} · {l.department})</span></span>
            <span><strong>{l.total_points}</strong> pts · {l.award_count} award{l.award_count === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recognition Feed</div>
        {feed.length === 0 && <div className="empty">No recognitions yet.</div>}
        {feed.map((f) => (
          <div key={f.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{f.from_name}</strong> → <strong>{f.to_name}</strong></span>
              <span className="status-tag present">{f.award_type} · +{f.points}</span>
            </div>
            <div className="feature-meta" style={{ marginTop: 4 }}>{f.message}</div>
            <div className="feature-meta">{f.created_at}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

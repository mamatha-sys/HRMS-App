import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const CATEGORY_CLASS = { General: 'info', Policy: 'pending', Event: 'present', Holiday: 'present' };

export default function Announcements() {
  const { user } = useAuth();
  const isHR = HR_ROLES.includes(user?.role);
  const [announcements, setAnnouncements] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', category: 'General', pinned: false });

  function load() { api.get('/announcements').then((r) => setAnnouncements(r.data.announcements)).catch(() => setError('Could not load announcements.')); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.title.trim() || !form.body.trim()) { setError('Title and body are both required.'); return; }
    try { await api.post('/announcements', form); setForm({ title: '', body: '', category: 'General', pinned: false }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not post announcement.'); }
  }
  async function togglePin(a) {
    setError('');
    try { await api.put(`/announcements/${a.id}`, { pinned: !a.pinned }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function remove(id) {
    setError('');
    try { await api.delete(`/announcements/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not delete.'); }
  }

  return (
    <div>
      <h1>Announcements</h1>
      <div className="subtitle">Company-wide notice board.</div>
      {error && <div className="banner error">{error}</div>}

      {isHR && (
        <div className="card" style={{ marginBottom: 14 }}>
          {showForm ? (
            <form onSubmit={submit}>
              <label className="field-label">Title *</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={{ marginBottom: 10 }} />
              <label className="field-label">Body *</label>
              <input value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required style={{ marginBottom: 10 }} />
              <label className="field-label">Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ marginBottom: 10 }}>
                {['General', 'Policy', 'Event', 'Holiday'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="row" style={{ alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} style={{ width: 16, height: 16 }} /> Pin to top
              </label>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" type="submit">Post Announcement</button>
                <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="primary" onClick={() => setShowForm(true)}>+ Post Announcement</button>
          )}
        </div>
      )}

      <div className="card">
        {announcements.length === 0 && <div className="empty">No announcements yet.</div>}
        {announcements.map((a) => (
          <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{a.title}</strong>{!!a.pinned && <span className="status-tag pending" style={{ marginLeft: 8 }}>Pinned</span>}</span>
              <span className={'status-tag ' + (CATEGORY_CLASS[a.category] || 'info')}>{a.category}</span>
            </div>
            <div className="feature-meta" style={{ marginTop: 4 }}>{a.body}</div>
            <div className="feature-meta">By {a.posted_by} · {a.created_at.slice(0, 10)}</div>
            {isHR && (
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <button onClick={() => togglePin(a)}>{a.pinned ? 'Unpin' : 'Pin'}</button>
                <button onClick={() => remove(a.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

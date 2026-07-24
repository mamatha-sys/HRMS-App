import { useEffect, useState } from 'react';
import api from '../api.js';

export default function NotificationsWidget({ canCreate, badge }) {
  const [notifications, setNotifications] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [targetRole, setTargetRole] = useState('all');
  const [error, setError] = useState('');

  function load() {
    api.get('/notifications').then((res) => setNotifications(res.data.notifications)).catch(() => {});
  }
  useEffect(load, []);

  async function markRead(id) {
    await api.post(`/notifications/${id}/read`);
    load();
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/notifications', { title, message, target_role: targetRole });
      setTitle(''); setMessage(''); setTargetRole('all'); setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send notification.');
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="feature-name">{badge && <span className="widget-badge">{badge}</span>}Alerts &amp; Notifications</div>
        {canCreate && <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Send'}</button>}
      </div>

      {error && <div className="banner error">{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ flex: '1 1 140px' }} />
          <input placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} required style={{ flex: '2 1 200px' }} />
          <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)} style={{ flex: '1 1 120px' }}>
            <option value="all">Everyone</option>
            <option value="manager">Managers</option>
            <option value="employee">Employees</option>
          </select>
          <button className="primary" type="submit">Send</button>
        </form>
      )}

      {notifications.length === 0 && <div className="empty">No notifications.</div>}
      {notifications.map((n) => (
        <div key={n.id} className="rec-row">
          <span>
            <strong>{n.title}</strong> — {n.message}
            <div className="feature-meta">{n.created_at}</div>
          </span>
          {!n.is_read && <button onClick={() => markRead(n.id)}>Mark read</button>}
        </div>
      ))}
    </div>
  );
}

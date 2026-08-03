import { useEffect, useState } from 'react';
import api from '../api.js';

const CHANNELS = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' }
];
// Mirrors the Helpdesk module's urgency colors (green/yellow/orange/red) so a ticket-related
// notification here carries the same at-a-glance priority as it does inside Helpdesk itself.
const PRIORITY_CLASS = { Low: 'priority-low', Medium: 'priority-medium', High: 'priority-high', Critical: 'priority-critical' };

export default function NotificationsWidget({ canCreate, badge }) {
  const [notifications, setNotifications] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [targetMode, setTargetMode] = useState('all'); // all | role | department | individual
  const [targetRole, setTargetRole] = useState('employee');
  const [targetDepartment, setTargetDepartment] = useState('');
  const [employeeIds, setEmployeeIds] = useState([]);
  const [channels, setChannels] = useState([]);
  const [options, setOptions] = useState({ departments: [], employees: [] });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  function load() {
    api.get('/notifications').then((res) => setNotifications(res.data.notifications)).catch(() => {});
  }
  useEffect(load, []);
  useEffect(() => {
    if (canCreate) api.get('/notifications/compose-options').then((res) => setOptions(res.data)).catch(() => {});
  }, [canCreate]);

  async function markRead(id) {
    await api.post(`/notifications/${id}/read`);
    load();
  }

  function toggleChannel(key) {
    setChannels((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key]));
  }
  function toggleEmployee(id) {
    setEmployeeIds((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]));
  }

  async function submit(e) {
    e.preventDefault();
    setError(''); setSending(true);
    try {
      await api.post('/notifications', {
        title, message,
        target_role: targetMode === 'role' ? targetRole : 'all',
        target_department: targetMode === 'department' ? targetDepartment : null,
        employee_ids: targetMode === 'individual' ? employeeIds : [],
        channels
      });
      setTitle(''); setMessage(''); setTargetMode('all'); setTargetDepartment(''); setEmployeeIds([]); setChannels([]); setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send notification.');
    } finally {
      setSending(false);
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
        <form onSubmit={submit} style={{ marginBottom: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required style={{ flex: '1 1 140px' }} />
            <input placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} required style={{ flex: '2 1 200px' }} />
          </div>

          <label className="field-label">Send to</label>
          <select value={targetMode} onChange={(e) => setTargetMode(e.target.value)} style={{ marginBottom: 8 }}>
            <option value="all">Everyone</option>
            <option value="role">By role</option>
            <option value="department">By department</option>
            <option value="individual">Individual employee(s)</option>
          </select>

          {targetMode === 'role' && (
            <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)} style={{ marginBottom: 8 }}>
              <option value="manager">Managers</option>
              <option value="employee">Employees</option>
            </select>
          )}
          {targetMode === 'department' && (
            <select value={targetDepartment} onChange={(e) => setTargetDepartment(e.target.value)} style={{ marginBottom: 8 }}>
              <option value="">Select department…</option>
              {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {targetMode === 'individual' && (
            <div style={{ maxHeight: 130, overflowY: 'auto', border: '1px solid #EEF0F3', borderRadius: 6, padding: 6, marginBottom: 8 }}>
              {options.employees.map((emp) => (
                <label key={emp.id} className="row" style={{ alignItems: 'center', gap: 6, padding: '2px 0' }}>
                  <input type="checkbox" checked={employeeIds.includes(emp.id)} onChange={() => toggleEmployee(emp.id)} style={{ width: 14, height: 14 }} />
                  {emp.name} <span className="feature-meta">({emp.employee_code} · {emp.department})</span>
                </label>
              ))}
            </div>
          )}

          <label className="field-label">Also deliver via</label>
          <div className="row" style={{ gap: 12, marginBottom: 8 }}>
            {CHANNELS.map((c) => (
              <label key={c.key} className="row" style={{ alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={channels.includes(c.key)} onChange={() => toggleChannel(c.key)} style={{ width: 14, height: 14 }} /> {c.label}
              </label>
            ))}
          </div>

          <button className="primary" type="submit" disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
        </form>
      )}

      {notifications.length === 0 && <div className="empty">No notifications.</div>}
      {notifications.map((n) => (
        <div key={n.id} className="rec-row">
          <span>
            <strong>{n.title}</strong>{n.priority && <span className={'priority-badge ' + (PRIORITY_CLASS[n.priority] || 'priority-medium')} style={{ marginLeft: 6 }}>{n.priority}</span>} — {n.message}
            <div className="feature-meta">{n.created_at}</div>
          </span>
          {!n.is_read && <button onClick={() => markRead(n.id)}>Mark read</button>}
        </div>
      ))}
    </div>
  );
}

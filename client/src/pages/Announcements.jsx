import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Assistant Manager/STL/TL are limited to viewing the announcement feed (already scoped to
// their own + assigned department(s)/team(s) server-side) — per Super Admin policy, no compose/
// pin/delete/log actions here unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const CATEGORY_CLASS = { General: 'info', Policy: 'pending', Event: 'present', Holiday: 'present' };
const CHANNELS = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' }
];
const CHANNEL_LABEL = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

export default function Announcements() {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('main'); // main | log
  const [announcements, setAnnouncements] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', category: 'General', pinned: false });
  const [targetMode, setTargetMode] = useState('all'); // all | department | individual
  const [targetDepartment, setTargetDepartment] = useState('');
  const [employeeIds, setEmployeeIds] = useState([]);
  const [channels, setChannels] = useState([]);
  const [options, setOptions] = useState({ departments: [], employees: [] });
  const [deliveries, setDeliveries] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);

  function load() { api.get('/announcements').then((r) => setAnnouncements(r.data.announcements)).catch(() => setError('Could not load announcements.')); }
  useEffect(load, []);
  useEffect(() => {
    if (canManage) api.get('/announcements/compose-options').then((r) => setOptions(r.data)).catch(() => {});
  }, [canManage]);

  function loadDeliveries() { api.get('/announcements/deliveries').then((r) => setDeliveries(r.data.deliveries)).catch(() => {}); }
  useEffect(() => { if (screen === 'log') loadDeliveries(); }, [screen]);

  function toggleChannel(key) { setChannels((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key])); }
  function toggleEmployee(id) { setEmployeeIds((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id])); }

  async function aiAssist() {
    setError('');
    if (!form.title.trim()) { setError('Enter a title first, then click AI Assist.'); return; }
    setAiLoading(true);
    try {
      const r = await api.post('/announcements/ai-assist', { title: form.title, category: form.category });
      setForm((f) => ({ ...f, body: r.data.body || f.body }));
    } catch (err) { setError(err.response?.data?.error || 'AI Assist could not draft an announcement.'); }
    finally { setAiLoading(false); }
  }
  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.title.trim() || !form.body.trim()) { setError('Title and body are both required.'); return; }
    setSending(true);
    try {
      await api.post('/announcements', {
        ...form,
        target_department: targetMode === 'department' ? targetDepartment : null,
        employee_ids: targetMode === 'individual' ? employeeIds : [],
        channels
      });
      setForm({ title: '', body: '', category: 'General', pinned: false });
      setTargetMode('all'); setTargetDepartment(''); setEmployeeIds([]); setChannels([]);
      setShowForm(false); load();
    }
    catch (err) { setError(err.response?.data?.error || 'Could not post announcement.'); }
    finally { setSending(false); }
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

  if (screen === 'log') {
    return (
      <div>
        <button onClick={() => setScreen('main')} style={{ marginBottom: 10 }}>← Back to Announcements</button>
        <h1>Notification Log</h1>
        <div className="subtitle">Every real Email / SMS / WhatsApp send attempt, across Announcements and Notifications.</div>
        <div className="card">
          {deliveries.length === 0 && <div className="empty">No channel deliveries yet — post an announcement with a channel selected, or send a Notification, to see entries here.</div>}
          {deliveries.map((d) => (
            <div key={d.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><strong>{CHANNEL_LABEL[d.channel]}</strong> → {d.employee_name || 'Unknown'}: {d.title}</span>
                <span className={'status-tag ' + (d.status === 'Sent' ? 'present' : 'absent')}>{d.status}</span>
              </div>
              <div className="feature-meta">{d.target || 'no contact on file'} · {d.created_at}{d.error ? ` · ${d.error}` : ''}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Announcements</h1>
          <div className="subtitle">Company-wide notice board.</div>
        </div>
        {canManage && <button onClick={() => setScreen('log')}>Notification Log</button>}
      </div>
      {error && <div className="banner error">{error}</div>}

      {canManage && (
        <div className="card" style={{ marginBottom: 14 }}>
          {showForm ? (
            <form onSubmit={submit}>
              <label className="field-label">Title *</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={{ marginBottom: 10 }} />
              <div className="row" style={{ marginBottom: 6 }}>
                <button type="button" onClick={aiAssist} disabled={aiLoading} title="Draft the body from the title and category">
                  {aiLoading ? 'Thinking…' : '✨ AI Assist'}
                </button>
              </div>
              <label className="field-label">Body *</label>
              <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required rows={4} style={{ marginBottom: 10, width: '100%' }} />
              <label className="field-label">Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ marginBottom: 10 }}>
                {['General', 'Policy', 'Event', 'Holiday'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>

              <label className="field-label">Send to</label>
              <select value={targetMode} onChange={(e) => setTargetMode(e.target.value)} style={{ marginBottom: 10 }}>
                <option value="all">Everyone</option>
                <option value="department">By department</option>
                <option value="individual">Individual employee(s)</option>
              </select>
              {targetMode === 'department' && (
                <select value={targetDepartment} onChange={(e) => setTargetDepartment(e.target.value)} style={{ marginBottom: 10 }}>
                  <option value="">Select department…</option>
                  {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              {targetMode === 'individual' && (
                <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid #EEF0F3', borderRadius: 6, padding: 6, marginBottom: 10 }}>
                  {options.employees.map((emp) => (
                    <label key={emp.id} className="row" style={{ alignItems: 'center', gap: 6, padding: '2px 0' }}>
                      <input type="checkbox" checked={employeeIds.includes(emp.id)} onChange={() => toggleEmployee(emp.id)} style={{ width: 14, height: 14 }} />
                      {emp.name} <span className="feature-meta">({emp.employee_code} · {emp.department})</span>
                    </label>
                  ))}
                </div>
              )}

              <label className="field-label">Also deliver via</label>
              <div className="row" style={{ gap: 12, marginBottom: 10 }}>
                {CHANNELS.map((c) => (
                  <label key={c.key} className="row" style={{ alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={channels.includes(c.key)} onChange={() => toggleChannel(c.key)} style={{ width: 14, height: 14 }} /> {c.label}
                  </label>
                ))}
              </div>

              <label className="row" style={{ alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} style={{ width: 16, height: 16 }} /> Pin to top
              </label>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" type="submit" disabled={sending}>{sending ? 'Posting…' : 'Post Announcement'}</button>
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
            <div className="feature-meta">
              By {a.posted_by} · {a.created_at.slice(0, 10)}
              {canManage && a.target_department && ` · Sent to: ${a.target_department} dept`}
              {canManage && a.recipient_names?.length > 0 && ` · Sent to: ${a.recipient_names.join(', ')}`}
            </div>
            {canManage && (
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

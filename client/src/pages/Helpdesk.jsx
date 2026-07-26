import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const STATUS_CLASS = { Open: 'pending', 'In Progress': 'info', Resolved: 'present', Closed: 'absent' };

export default function Helpdesk() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRHelpdesk /> : <MyHelpdesk />;
}

function TicketThread({ ticket, onCommented }) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    setError('');
    try { await api.post(`/helpdesk/${ticket.id}/comments`, { comment }); setComment(''); onCommented(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add comment.'); }
  }

  return (
    <div style={{ marginTop: 8, paddingLeft: 8 }}>
      {error && <div className="banner error">{error}</div>}
      {ticket.comments.length === 0 && <div className="feature-meta">No replies yet.</div>}
      {ticket.comments.map((c) => (
        <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '6px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{c.author_name}</strong>
            <span className="feature-meta">{c.created_at.slice(0, 10)}</span>
          </div>
          <div className="feature-meta">{c.comment}</div>
        </div>
      ))}
      <form onSubmit={submit} className="row" style={{ marginTop: 6 }}>
        <input placeholder="Reply…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" type="submit">Reply</button>
      </form>
    </div>
  );
}

// Employee self-service: raise IT/HR/Admin/Grievance tickets, track status, reply on the thread.
function MyHelpdesk() {
  const [tickets, setTickets] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'IT', priority: 'Medium', subject: '', description: '' });
  const [expanded, setExpanded] = useState(null);

  function load() { api.get('/helpdesk/my').then((r) => setTickets(r.data.tickets)).catch(() => {}); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.subject.trim()) { setError('Subject is required.'); return; }
    try { await api.post('/helpdesk', form); setForm({ category: 'IT', priority: 'Medium', subject: '', description: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not raise ticket.'); }
  }

  return (
    <div>
      <h1>Helpdesk</h1>
      <div className="subtitle">Raise IT, HR, Admin or Grievance tickets and track their status.</div>
      {error && <div className="banner error">{error}</div>}
      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={submit}>
            <label className="field-label">Category *</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ marginBottom: 10 }}>
              {['IT', 'HR', 'Admin', 'Grievance', 'Other'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="field-label">Priority</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={{ marginBottom: 10 }}>
              {['Low', 'Medium', 'High'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <label className="field-label">Subject *</label>
            <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required style={{ marginBottom: 10 }} />
            <label className="field-label">Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ marginBottom: 10 }} />
            <div className="row">
              <button className="primary" type="submit">Submit Ticket</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="primary" onClick={() => setShowForm(true)}>+ Raise Ticket</button>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My Tickets</div>
        {tickets.length === 0 && <div className="empty">You haven't raised any tickets yet.</div>}
        {tickets.map((t) => (
          <div key={t.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{t.subject}</strong> <span className="feature-meta">· {t.category} · {t.priority} priority</span></span>
              <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
            </div>
            {t.description && <div className="feature-meta">{t.description}</div>}
            <button style={{ marginTop: 4 }} onClick={() => setExpanded(expanded === t.id ? null : t.id)}>{expanded === t.id ? 'Hide thread' : `Thread (${t.comments.length})`}</button>
            {expanded === t.id && <TicketThread ticket={t} onCommented={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRHelpdesk() {
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('All');

  function load() { api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load tickets.')); }
  useEffect(load, []);

  async function setStatus(id, status) {
    setError('');
    try { await api.put(`/helpdesk/${id}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update ticket.'); }
  }

  const tickets = ov?.tickets.filter((t) => filter === 'All' || t.status === filter) || [];

  return (
    <div>
      <h1>Helpdesk</h1>
      <div className="subtitle">Track and resolve employee IT/HR/Admin/Grievance tickets.</div>
      {error && <div className="banner error">{error}</div>}
      {ov && (
        <div className="kpi-row">
          {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
        </div>
      )}
      <div className="filter-bar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {['All', 'Open', 'In Progress', 'Resolved', 'Closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && tickets.length === 0 && <div className="empty">No tickets match this filter.</div>}
        {tickets.map((t) => (
          <div key={t.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{t.subject}</strong> <span className="feature-meta">· {t.employee_name} ({t.employee_code}) · {t.category} · {t.priority} priority</span></span>
              <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
            </div>
            {t.description && <div className="feature-meta">{t.description}</div>}
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {t.status !== 'In Progress' && <button onClick={() => setStatus(t.id, 'In Progress')}>Mark In Progress</button>}
              {t.status !== 'Resolved' && <button onClick={() => setStatus(t.id, 'Resolved')}>Mark Resolved</button>}
              {t.status !== 'Closed' && <button onClick={() => setStatus(t.id, 'Closed')}>Close</button>}
              <button onClick={() => setExpanded(expanded === t.id ? null : t.id)}>{expanded === t.id ? 'Hide thread' : `Thread (${t.comments.length})`}</button>
            </div>
            {expanded === t.id && <TicketThread ticket={t} onCommented={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

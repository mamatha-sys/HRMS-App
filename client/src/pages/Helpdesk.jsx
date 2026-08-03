import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin dashboard only, no own tickets.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own ticket
// raising/tracking (MyHelpdesk) AND the company-wide dashboard below it, rather than one
// replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing their assigned department(s)/team(s) — per
// Super Admin policy, no create/assign/resolve/escalate/KB-manage actions here unless
// explicitly granted. This gates every write affordance (previously a broader combined
// FULL_HR_ROLES + SELF_AND_ADMIN_ROLES constant incorrectly gated Knowledge Base compose/delete).
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const STATUS_CLASS = { Open: 'pending', 'In Progress': 'info', Resolved: 'present', Closed: 'absent' };
const CATEGORIES = ['IT', 'HR', 'Admin', 'Grievance', 'Facilities', 'Payroll', 'Other'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
// Urgency colors, consistent everywhere a ticket's priority is shown: green → yellow → orange → red.
const PRIORITY_CLASS = { Low: 'priority-low', Medium: 'priority-medium', High: 'priority-high', Critical: 'priority-critical' };
function PriorityBadge({ priority }) {
  return <span className={'priority-badge ' + (PRIORITY_CLASS[priority] || 'priority-medium')}>{priority}</span>;
}

const KEY_FEATURES = [
  { key: 'creation', label: 'Ticket Creation, Assignment & Categorization' },
  { key: 'sla', label: 'SLA Tracking & Status' },
  { key: 'resolution', label: 'Ticket Resolution, Closure & Reopening' },
  { key: 'notes', label: 'Internal Notes, Attachments & Screenshots' },
  { key: 'kb', label: 'Knowledge Base' },
  { key: 'routing', label: 'Auto Routing & Email Notifications' },
  { key: 'escalation', label: 'Ticket Escalation' },
  { key: 'csat', label: 'CSAT / Customer Satisfaction Feedback' },
  { key: 'reports', label: 'Helpdesk Dashboard, Reports & Analytics' }
];

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Helpdesk() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRHelpdesk />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyHelpdesk compact /><HRHelpdesk compact sectionLabel="Company Helpdesk" /></>);
  return <MyHelpdesk />;
}

function TicketThread({ ticket, isHR, onChanged }) {
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    setError('');
    try {
      const attachment_data_url = file ? await readFileAsDataUrl(file) : undefined;
      await api.post(`/helpdesk/${ticket.id}/comments`, { comment, internal, attachment_data_url, attachment_name: file?.name });
      setComment(''); setFile(null); setInternal(false); onChanged();
    } catch (err) { setError(err.response?.data?.error || 'Could not add comment.'); }
  }

  return (
    <div style={{ marginTop: 8, paddingLeft: 8 }}>
      {error && <div className="banner error">{error}</div>}
      {ticket.comments.length === 0 && <div className="feature-meta">No replies yet.</div>}
      {ticket.comments.map((c) => (
        <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '6px 0' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{c.author_name}{!!c.internal && <span className="status-tag pending" style={{ marginLeft: 6 }}>Internal</span>}</strong>
            <span className="feature-meta">{c.created_at.slice(0, 10)}</span>
          </div>
          <div className="feature-meta">{c.comment}</div>
          {c.attachment_data_url && <a className="pill" href={c.attachment_data_url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>📎 {c.attachment_name || 'Attachment'}</a>}
        </div>
      ))}
      <form onSubmit={submit} style={{ marginTop: 6 }}>
        <div className="row">
          <input placeholder="Reply…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" type="submit">Reply</button>
        </div>
        <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          {isHR && (
            <label className="row" style={{ alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} style={{ width: 16, height: 16 }} /> Internal note (hidden from requester)
            </label>
          )}
        </div>
      </form>
    </div>
  );
}

// Employee self-service: raise tickets, track status, confirm/reopen/rate resolution.
function MyHelpdesk({ compact }) {
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
  async function confirm(id) {
    setError('');
    try { await api.post(`/helpdesk/${id}/confirm`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not confirm.'); }
  }
  async function reopen(id) {
    setError('');
    try { await api.post(`/helpdesk/${id}/reopen`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not reopen.'); }
  }
  async function rate(id, rating) {
    setError('');
    try { await api.post(`/helpdesk/${id}/csat`, { rating }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit rating.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Helpdesk</div> : <h1>Helpdesk</h1>}
      {!compact && <div className="subtitle">Raise IT, HR, Admin, Grievance, Facilities or Payroll tickets and track their status.</div>}
      {error && <div className="banner error">{error}</div>}
      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={submit}>
            <label className="field-label">Category *</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ marginBottom: 10 }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="field-label">Priority</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={{ marginBottom: 10 }}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
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
              <span><strong>{t.subject}</strong> <span className="feature-meta">· {t.category}</span></span>
              <span className="row" style={{ gap: 6 }}>
                <PriorityBadge priority={t.priority} />
                <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
              </span>
            </div>
            {t.description && <div className="feature-meta">{t.description}</div>}
            {t.status === 'Resolved' && !t.requester_confirmed && (
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <button className="primary" onClick={() => confirm(t.id)}>Confirm Resolution</button>
                <button onClick={() => reopen(t.id)}>Not Fixed — Reopen</button>
              </div>
            )}
            {['Resolved', 'Closed'].includes(t.status) && t.csat_rating == null && (
              <div className="row" style={{ marginTop: 6, gap: 4, alignItems: 'center' }}>
                <span className="feature-meta">Rate this resolution:</span>
                {[1, 2, 3, 4, 5].map((n) => <button key={n} onClick={() => rate(t.id, n)}>{n}</button>)}
              </div>
            )}
            {t.csat_rating != null && <div className="feature-meta" style={{ marginTop: 4 }}>You rated this {t.csat_rating}/5</div>}
            {t.status === 'Closed' && <button style={{ marginTop: 6 }} onClick={() => reopen(t.id)}>Reopen</button>}
            <div style={{ marginTop: 4 }}>
              <button onClick={() => setExpanded(expanded === t.id ? null : t.id)}>{expanded === t.id ? 'Hide thread' : `Thread (${t.comments.length})`}</button>
            </div>
            {expanded === t.id && <TicketThread ticket={t} isHR={false} onChanged={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRHelpdesk({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('dashboard');
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');

  function load() { api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load tickets.')); }
  useEffect(load, []);

  async function setStatus(id, status) {
    setError('');
    try { await api.put(`/helpdesk/${id}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update ticket.'); }
  }

  if (screen === 'creation') return <CreationScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'sla') return <SlaScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'resolution') return <ResolutionScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'notes') return <NotesScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'kb') return <KnowledgeBaseScreen onBack={() => setScreen('dashboard')} />;
  if (screen === 'routing') return <RoutingScreen onBack={() => setScreen('dashboard')} />;
  if (screen === 'escalation') return <EscalationScreen onBack={() => { load(); setScreen('dashboard'); }} />;
  if (screen === 'csat') return <CsatScreen onBack={() => setScreen('dashboard')} />;
  if (screen === 'reports') return <ReportsScreen onBack={() => setScreen('dashboard')} />;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Helpdesk'}</div> : <h1>Helpdesk</h1>}
      {!compact && <div className="subtitle">Track and resolve employee IT/HR/Admin/Grievance/Facilities/Payroll tickets.</div>}
      {error && <div className="banner error">{error}</div>}
      {ov && (
        <div className="kpi-row">
          {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
        </div>
      )}
      <div className="dashboard-grid">
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">1</span>Helpdesk Tickets</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>Resolved/Closed tickets drop off this list — see them in Ticket Resolution or Reports.</div>
          {!ov && <div className="empty">Loading…</div>}
          {ov && ov.tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length === 0 && <div className="empty">No open tickets.</div>}
          {ov && ov.tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status)).map((t) => (
            <div key={t.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><strong>{t.subject}</strong></span>
                <span className="row" style={{ gap: 6 }}>
                  <PriorityBadge priority={t.priority} />
                  <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
                </span>
              </div>
              <div className="feature-meta">{t.employee_name} · {t.category}</div>
              {canManage && t.status === 'Open' && <button style={{ marginTop: 4 }} onClick={() => setStatus(t.id, 'Resolved')}>Mark Resolved</button>}
            </div>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">4</span>Key Features</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>{KEY_FEATURES.length} features in this module — click any tile to open its screen.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {/* Non-canManage (Assistant Manager/STL/TL) only get view-safe screens — every other
                tile drives a write endpoint (create/assign/resolve/escalate/KB-manage/routing/
                reports) that's now blocked server-side for them. */}
            {KEY_FEATURES.filter((f) => canManage || ['sla', 'kb'].includes(f.key)).map((f) => <button key={f.key} className="pill" onClick={() => setScreen(f.key)}>{f.label}</button>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Ticket Creation, Assignment & Categorization ---
function CreationScreen({ onBack }) {
  const [ov, setOv] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'IT', priority: 'Medium', subject: '', description: '' });

  function load() { api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load tickets.')); }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.subject.trim()) { setError('Subject is required.'); return; }
    try { await api.post('/helpdesk', form); setForm({ category: 'IT', priority: 'Medium', subject: '', description: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not raise ticket.'); }
  }
  async function assign(id, employeeId) {
    setError('');
    try { await api.put(`/helpdesk/${id}`, { assigned_to_employee_id: employeeId || null }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign.'); }
  }

  return (
    <div>
      <h1>Ticket Creation, Assignment &amp; Categorization</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && ov.tickets.map((t) => (
          <div key={t.id} className="rec-row" style={{ alignItems: 'flex-start' }}>
            <span>{t.subject} — {t.employee_name}</span>
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="feature-meta">{t.category}</span>
              <PriorityBadge priority={t.priority} />
              <select value={t.assigned_to_employee_id || ''} onChange={(e) => assign(t.id, e.target.value)}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </span>
          </div>
        ))}
        {showForm ? (
          <form onSubmit={submit} style={{ marginTop: 10 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ flex: '1 1 120px' }}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={{ flex: '1 1 100px' }}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <input placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required style={{ marginTop: 8, marginBottom: 8 }} />
            <input placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ marginBottom: 8 }} />
            <div className="row">
              <button className="primary" type="submit">Create Ticket</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>+ Raise Ticket</button>
        )}
      </div>
    </div>
  );
}

// --- SLA Tracking & Status ---
function SlaScreen({ onBack }) {
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load tickets.')); }, []);

  return (
    <div>
      <h1>SLA Tracking &amp; Status</h1>
      <div className="subtitle">Critical: 1h · High: 4h · Medium: 24h · Low: 72h response targets. Separately, any ticket left unresolved for 24+ hours auto-escalates one priority level, repeating every further 24h until Critical or resolved.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && ov.tickets.map((t) => (
          <div key={t.id} className="rec-row">
            <span className="row" style={{ gap: 6 }}>{t.subject} <PriorityBadge priority={t.priority} /></span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
              {t.slaBreached ? <span className="status-tag absent">SLA Breached</span> : <span className="status-tag present">Within SLA</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Ticket Resolution, Closure & Reopening ---
function ResolutionScreen({ onBack }) {
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');

  function load() { api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load tickets.')); }
  useEffect(load, []);

  async function setStatus(id, status) {
    setError('');
    try { await api.put(`/helpdesk/${id}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update ticket.'); }
  }
  async function reopen(id) {
    setError('');
    try { await api.post(`/helpdesk/${id}/reopen`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not reopen.'); }
  }

  return (
    <div>
      <h1>Ticket Resolution, Closure &amp; Reopening</h1>
      <div className="subtitle">Rule: a ticket cannot be closed until the requester confirms resolution or the auto-close window (3 days) elapses.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && ov.tickets.map((t) => (
          <div key={t.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{t.subject}</strong>
              <span className={'status-tag ' + (STATUS_CLASS[t.status] || 'info')}>{t.status}</span>
            </div>
            {['Resolved', 'Closed'].includes(t.status) && <div className="feature-meta">Requester confirmed: {t.requester_confirmed ? 'Yes' : 'No'}</div>}
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {t.status === 'Open' && <button onClick={() => setStatus(t.id, 'Resolved')}>Mark Resolved</button>}
              {t.status === 'Resolved' && <button disabled={!t.canClose} onClick={() => setStatus(t.id, 'Closed')}>Close Ticket</button>}
              {['Resolved', 'Closed'].includes(t.status) && <button onClick={() => reopen(t.id)}>Reopen</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Internal Notes, Attachments & Screenshots ---
function NotesScreen({ onBack }) {
  const [ov, setOv] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  function load() { api.get('/helpdesk/overview').then((r) => { setOv(r.data); if (selected) setSelected(r.data.tickets.find((t) => t.id === selected.id) || null); }).catch(() => setError('Could not load tickets.')); }
  useEffect(load, []);

  return (
    <div>
      <h1>Internal Notes, Attachments &amp; Screenshots</h1>
      <div className="subtitle">Internal notes and file attachments are never visible to the requester.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      {!selected ? (
        <div className="card">
          {!ov && <div className="empty">Loading…</div>}
          {ov && ov.tickets.map((t) => (
            <div key={t.id} className="rec-row">
              <span>{t.subject} — {t.employee_name}</span>
              <button onClick={() => setSelected(t)}>Open</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name">{selected.subject}</div>
            <button onClick={() => setSelected(null)}>← All Tickets</button>
          </div>
          <TicketThread ticket={selected} isHR onChanged={load} />
        </div>
      )}
    </div>
  );
}

// --- Knowledge Base ---
function KnowledgeBaseScreen({ onBack }) {
  const { user } = useAuth();
  // Browsing the Knowledge Base stays open to everyone who reaches this screen (matches the
  // backend, which lets any authenticated user GET articles); only composing/deleting is a
  // write action, gated by the restrictive canManage.
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [articles, setArticles] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('IT');

  function load() { api.get('/helpdesk/kb/articles').then((r) => setArticles(r.data.articles)).catch(() => setError('Could not load articles.')); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!title.trim() || !body.trim()) { setError('Title and body are both required.'); return; }
    try { await api.post('/helpdesk/kb/articles', { title, body, category }); setTitle(''); setBody(''); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create article.'); }
  }
  async function remove(id) {
    setError('');
    try { await api.delete(`/helpdesk/kb/articles/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not delete article.'); }
  }

  return (
    <div>
      <h1>Knowledge Base</h1>
      <div className="subtitle">Self-help articles employees can check before raising a ticket.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      {canManage && (
        <div className="card" style={{ marginBottom: 14 }}>
          {showForm ? (
            <form onSubmit={submit}>
              <label className="field-label">Title *</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ marginBottom: 10 }} />
              <label className="field-label">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ marginBottom: 10 }}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="field-label">Body *</label>
              <input value={body} onChange={(e) => setBody(e.target.value)} required style={{ marginBottom: 10 }} />
              <div className="row">
                <button className="primary" type="submit">Publish Article</button>
                <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="primary" onClick={() => setShowForm(true)}>+ New Article</button>
          )}
        </div>
      )}
      <div className="card">
        {!articles && <div className="empty">Loading…</div>}
        {articles && articles.length === 0 && <div className="empty">No articles yet.</div>}
        {articles && articles.map((a) => (
          <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{a.title}</strong>
              <span className="status-tag info">{a.category}</span>
            </div>
            <div className="feature-meta">{a.body}</div>
            {canManage && <button style={{ marginTop: 4 }} onClick={() => remove(a.id)}>Delete</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Auto Routing & Email Notifications ---
function RoutingScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('IT');
  const [employeeId, setEmployeeId] = useState('');

  function load() { api.get('/helpdesk/routing/rules').then((r) => setData(r.data)).catch(() => setError('Could not load routing rules.')); }
  useEffect(load, []);

  async function save(e) {
    e.preventDefault(); setError('');
    if (!employeeId) { setError('Select an employee.'); return; }
    try { await api.put('/helpdesk/routing/rules', { category, assigned_to_employee_id: employeeId }); setEmployeeId(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save rule.'); }
  }
  async function remove(cat) {
    setError('');
    try { await api.delete(`/helpdesk/routing/rules/${cat}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not remove rule.'); }
  }

  return (
    <div>
      <h1>Auto Routing &amp; Email Notifications</h1>
      <div className="subtitle">New tickets in a mapped category auto-assign to that employee, and a notification is sent.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="card" style={{ marginBottom: 14 }}>
        <form onSubmit={save} className="row" style={{ flexWrap: 'wrap' }}>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: '1 1 120px' }}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={{ flex: '1 1 160px' }}>
            <option value="">Assign to…</option>
            {data?.employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
          </select>
          <button className="primary" type="submit">Save Rule</button>
        </form>
      </div>
      <div className="card">
        {!data && <div className="empty">Loading…</div>}
        {data && data.rules.length === 0 && <div className="empty">No routing rules configured yet.</div>}
        {data && data.rules.map((r) => (
          <div key={r.category} className="rec-row">
            <span>{r.category} → {r.assignee_name} ({r.employee_code})</span>
            <button onClick={() => remove(r.category)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Ticket Escalation ---
function EscalationScreen({ onBack }) {
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');

  function load() { api.get('/helpdesk/escalations/list').then((r) => setTickets(r.data.tickets)).catch(() => setError('Could not load escalations.')); }
  useEffect(load, []);

  async function approve(id) {
    setError('');
    try { await api.post(`/helpdesk/${id}/escalate`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not escalate.'); }
  }

  return (
    <div>
      <h1>Ticket Escalation</h1>
      <div className="subtitle">Tickets that have breached their SLA and are still unresolved. Note: tickets unresolved for 24+ hours also auto-escalate on their own, independent of manual approval here.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="card">
        {!tickets && <div className="empty">Loading…</div>}
        {tickets && tickets.length === 0 && <div className="empty">No tickets currently need escalation.</div>}
        {tickets && tickets.map((t) => (
          <div key={t.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row" style={{ gap: 6 }}>{t.subject} <span className="feature-meta">· {t.employee_name}</span></span>
              <span className="row" style={{ gap: 6 }}>
                <PriorityBadge priority={t.priority} />
                <span className="status-tag absent">SLA Breached</span>
              </span>
            </div>
            {t.escalated ? <div className="status-tag present" style={{ marginTop: 6, display: 'inline-block' }}>Already escalated</div> : <button style={{ marginTop: 6 }} onClick={() => approve(t.id)}>Approve Escalation</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- CSAT / Customer Satisfaction Feedback ---
function CsatScreen({ onBack }) {
  const [reports, setReports] = useState(null);
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/helpdesk/reports/summary').then((r) => setReports(r.data)).catch(() => setError('Could not load CSAT data.'));
    api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => {});
  }, []);

  const rated = ov?.tickets.filter((t) => t.csat_rating != null) || [];

  return (
    <div>
      <h1>CSAT / Customer Satisfaction Feedback</h1>
      <div className="subtitle">Requester ratings collected after a ticket is Resolved or Closed.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">Average CSAT</div><div className="kpi-value">{reports?.avgCsat != null ? `${reports.avgCsat} / 5` : '—'}</div></div>
        <div className="kpi-card green"><div className="kpi-label">Rated Tickets</div><div className="kpi-value">{reports?.ratedCount ?? '—'}</div></div>
      </div>
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Ratings</div>
        {rated.length === 0 && <div className="empty">No ratings submitted yet.</div>}
        {rated.map((t) => (
          <div key={t.id} className="rec-row">
            <span>{t.subject} — {t.employee_name}</span>
            <span>{t.csat_rating} / 5</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Helpdesk Dashboard, Reports & Analytics ---
function ReportsScreen({ onBack }) {
  const [reports, setReports] = useState(null);
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/helpdesk/reports/summary').then((r) => setReports(r.data)).catch(() => setError('Could not load reports.'));
    api.get('/helpdesk/overview').then((r) => setOv(r.data)).catch(() => {});
  }, []);

  function exportCsv() {
    if (!ov) return;
    const rows = [['Subject', 'Employee', 'Category', 'Priority', 'Status', 'Created', 'Resolved', 'CSAT']];
    ov.tickets.forEach((t) => rows.push([t.subject, t.employee_name, t.category, t.priority, t.status, t.created_at, t.resolved_at || '', t.csat_rating ?? '']));
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'helpdesk-tickets.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const maxCount = reports ? Math.max(1, ...reports.byCategory.map((c) => c.count)) : 1;
  const COLORS = ['#2E5CB8', '#1E8E5A', '#946E0A', '#B3401E'];

  return (
    <div>
      <h1>Helpdesk Dashboard, Reports &amp; Analytics</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Helpdesk</button>
      {reports && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Total Tickets</div><div className="kpi-value">{reports.totalTickets}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Open</div><div className="kpi-value">{reports.openCount}</div></div>
          <div className="kpi-card green"><div className="kpi-label">Resolved/Closed</div><div className="kpi-value">{reports.resolvedCount}</div></div>
        </div>
      )}
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Tickets by Category</div>
        {!reports && <div className="empty">Loading…</div>}
        {reports && (
          <div className="row" style={{ alignItems: 'flex-end', gap: 16, height: 140 }}>
            {reports.byCategory.map((c, i) => (
              <div key={c.category} style={{ textAlign: 'center' }}>
                <div className="feature-meta" style={{ marginBottom: 4 }}>{c.count}</div>
                <div style={{ width: 48, height: Math.round((c.count / maxCount) * 100) + 20, background: COLORS[i % COLORS.length], borderRadius: 4 }} />
                <div className="feature-meta" style={{ marginTop: 4 }}>{c.category}</div>
              </div>
            ))}
          </div>
        )}
        <div className="feature-meta" style={{ marginTop: 10 }}>Average CSAT: {reports?.avgCsat != null ? `${reports.avgCsat} / 5` : '—'}</div>
        <button className="primary" style={{ marginTop: 10 }} onClick={exportCsv} disabled={!ov}>Export</button>
      </div>
    </div>
  );
}

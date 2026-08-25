import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Pure system-administrator accounts have no linked employee record (mirrors Helpdesk.jsx /
// Learning.jsx's own split) — they get the admin view only, never a "submit your idea" form.
const FULL_HR_ROLES = ['super_admin'];
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];

const STATUS_CLASS = { Approved: 'present', Rejected: 'absent', Pending: 'pending' };

function ScoreRow({ label, value }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
      <span className="feature-meta">{label}</span>
      <span className="feature-meta"><strong>{value}</strong>/100</span>
    </div>
  );
}

function IdeaCard({ idea, onRetry, retrying }) {
  return (
    <div style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{idea.title}</strong>
        <span className={'status-tag ' + (STATUS_CLASS[idea.status] || 'pending')}>{idea.status}</span>
      </div>
      <div className="feature-meta" style={{ marginTop: 2 }}>{idea.description}</div>
      <div className="feature-meta">{idea.created_at?.slice(0, 10)} · Week of {idea.week_start}</div>

      {idea.status === 'Pending' && (
        <div className="feature-meta" style={{ marginTop: 6 }}>🤖 AI is reviewing this idea (duplicate check + scoring) — usually under a minute.</div>
      )}
      {idea.status === 'Rejected' && (
        <div className="banner error" style={{ marginTop: 6, padding: '6px 10px' }}>
          Not counted this week — {idea.reject_reason || 'this looks like a duplicate of an existing idea.'} Please submit a different idea.
        </div>
      )}
      {idea.status === 'Approved' && (
        <div style={{ marginTop: 6, background: '#F7F9FC', borderRadius: 6, padding: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <strong style={{ fontSize: 13 }}>Overall Score</strong>
            <strong style={{ fontSize: 13 }}>{idea.overall_score}/100</strong>
          </div>
          <ScoreRow label="Originality" value={idea.originality_score} />
          <ScoreRow label="Usefulness" value={idea.usefulness_score} />
          <ScoreRow label="Impact" value={idea.impact_score} />
          <ScoreRow label="Clarity" value={idea.clarity_score} />
          <ScoreRow label="Feasibility" value={idea.feasibility_score} />
          {idea.ai_feedback && <div className="feature-meta" style={{ marginTop: 6 }}>💬 {idea.ai_feedback}</div>}
        </div>
      )}
      {onRetry && idea.status === 'Pending' && (
        <button style={{ marginTop: 6 }} onClick={() => onRetry(idea.id)} disabled={retrying}>{retrying ? 'Retrying…' : 'Stuck? Retry review'}</button>
      )}
    </div>
  );
}

// Self-service: this week's status, a submit form, and my own submission history.
function MyIdeas({ compact }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  const [retryingId, setRetryingId] = useState(null);

  function load() { api.get('/ideas/my').then((r) => setData(r.data)).catch(() => setError('Could not load your ideas.')); }
  useEffect(load, []);

  // Poll while anything of mine is still Pending — same non-blocking pattern used everywhere
  // else AI runs in the background in this app (ticket first-response, offer letters, JDs).
  useEffect(() => {
    if (!data?.ideas.some((i) => i.status === 'Pending')) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [data]);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.title.trim() || !form.description.trim()) { setError('Title and description are both required.'); return; }
    setSubmitting(true);
    try {
      await api.post('/ideas', form);
      setForm({ title: '', description: '' }); setShowForm(false);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit your idea.'); }
    finally { setSubmitting(false); }
  }
  async function retry(id) {
    setRetryingId(id);
    try { await api.post(`/ideas/${id}/retry`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not retry.'); }
    finally { setRetryingId(null); }
  }

  if (!data) return <div className="card"><div className="empty">Loading…</div></div>;

  return (
    <div className="card" style={{ marginBottom: compact ? 14 : 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="feature-name">My Weekly Idea Contribution</div>
        {!showForm && <button className="primary" onClick={() => setShowForm(true)}>+ Submit an Idea</button>}
      </div>

      {data.weeklyRequirementMet ? (
        <div className="banner info">✅ You've submitted {data.approvedThisWeek}/{data.requiredPerWeek} unique ideas for the week of {data.weekStart} — you're all set. Feel free to submit more.</div>
      ) : data.hasPendingThisWeek ? (
        <div className="banner info">🤖 {data.approvedThisWeek}/{data.requiredPerWeek} unique ideas so far this week — another one is still being reviewed by AI, check back shortly.</div>
      ) : (
        <div className="banner error">⚠️ {data.approvedThisWeek}/{data.requiredPerWeek} unique ideas submitted for the week of {data.weekStart}. {data.requiredPerWeek} unique ideas are required every week.</div>
      )}

      {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}

      {showForm && (
        <form onSubmit={submit} style={{ marginTop: 10 }}>
          <label className="field-label">Idea Title *</label>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={{ marginBottom: 8, width: '100%' }} />
          <label className="field-label">Describe your idea *</label>
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required rows={4} style={{ marginBottom: 8, width: '100%' }}
            placeholder="What should change, and why would it help? AI will check this isn't a duplicate of an existing idea, then score it on originality, usefulness, impact, clarity, and feasibility." />
          <div className="row">
            <button className="primary" type="submit" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit Idea'}</button>
            <button type="button" onClick={() => { setShowForm(false); setForm({ title: '', description: '' }); }}>Cancel</button>
          </div>
        </form>
      )}

      <div style={{ marginTop: 10 }}>
        {data.ideas.length === 0 && <div className="empty">No ideas submitted yet.</div>}
        {data.ideas.slice(0, compact ? 3 : data.ideas.length).map((idea) => (
          <IdeaCard key={idea.id} idea={idea} onRetry={retry} retrying={retryingId === idea.id} />
        ))}
      </div>
    </div>
  );
}

function formatScore(n) { return Math.round(n || 0); }

// HR/manager-tier: weekly compliance (who has/hasn't submitted), the full company-wide feed, and
// the leaderboard — all from the single admin overview endpoint.
function IdeaAdminScreen({ compact, sectionLabel }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('compliance');

  function load() { api.get('/ideas/overview').then((r) => setData(r.data)).catch(() => setError('Could not load Knowledge Transfer overview.')); }
  useEffect(load, []);

  if (!compact) {
    // Full page: give it a header of its own.
  }

  return (
    <div>
      {!compact && <h1>Knowledge Transfer — AI Weekly Idea Contribution</h1>}
      {!compact && <div className="subtitle">Every employee submits {data?.requiredPerWeek || 3} unique HRMS-improvement ideas per week. AI screens for duplicates and scores each unique idea on originality, usefulness, impact, clarity, and feasibility.</div>}
      {compact && <div className="feature-name" style={{ margin: '14px 0 8px' }}>{sectionLabel || 'Company Knowledge Transfer'}</div>}
      {error && <div className="banner error">{error}</div>}
      {!data && <div className="empty">Loading…</div>}
      {data && (
        <>
          <div className="kpi-row" style={{ marginBottom: 14 }}>
            <div className="kpi-card blue">
              <div className="kpi-label">Met {data.requiredPerWeek}-Idea Quota</div>
              <div className="kpi-value">{data.complianceSummary.submitted} / {data.complianceSummary.total}</div>
            </div>
            <div className="kpi-card gold">
              <div className="kpi-label">Week Starting</div>
              <div className="kpi-value text">{data.weekStart}</div>
            </div>
            <div className="kpi-card green">
              <div className="kpi-label">Total Ideas on File</div>
              <div className="kpi-value">{data.feed.length}</div>
            </div>
          </div>

          <div className="chat-mode-tabs" style={{ marginBottom: 10, maxWidth: 420 }}>
            <button type="button" className={tab === 'compliance' ? 'active' : ''} onClick={() => setTab('compliance')}>Weekly Compliance</button>
            <button type="button" className={tab === 'leaderboard' ? 'active' : ''} onClick={() => setTab('leaderboard')}>Leaderboard</button>
            <button type="button" className={tab === 'feed' ? 'active' : ''} onClick={() => setTab('feed')}>All Ideas</button>
          </div>

          {tab === 'compliance' && (
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Weekly quota — {data.requiredPerWeek} unique ideas</div>
              <table>
                <thead><tr><th>Employee</th><th>Department</th><th>This Week</th><th>Status</th></tr></thead>
                <tbody>
                  {data.compliance.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name} <span className="feature-meta">({c.employee_code})</span></td>
                      <td>{c.department}</td>
                      <td>{c.approvedThisWeek} / {data.requiredPerWeek}</td>
                      <td><span className={'status-tag ' + (c.submittedThisWeek ? 'present' : 'absent')}>{c.submittedThisWeek ? 'Met' : 'Short'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'leaderboard' && (
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Employee Leaderboard (all-time)</div>
              {data.leaderboard.length === 0 && <div className="empty">No approved ideas yet.</div>}
              {data.leaderboard.length > 0 && (
                <table>
                  <thead><tr><th>#</th><th>Employee</th><th>Ideas</th><th>Total Score</th><th>Avg Score</th><th>This Week</th><th>This Month</th></tr></thead>
                  <tbody>
                    {data.leaderboard.map((l, i) => (
                      <tr key={l.employee_id}>
                        <td>{i + 1}</td>
                        <td>{l.name} <span className="feature-meta">({l.employee_code})</span></td>
                        <td>{l.ideaCount}</td>
                        <td>{formatScore(l.totalScore)}</td>
                        <td>{l.avgScore}</td>
                        <td>{formatScore(l.weekScore)}</td>
                        <td>{formatScore(l.monthScore)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'feed' && (
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>All Ideas — Approved &amp; Rejected</div>
              {data.feed.length === 0 && <div className="empty">No ideas submitted yet.</div>}
              {data.feed.map((idea) => (
                <div key={idea.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span><strong>{idea.title}</strong> <span className="feature-meta">— {idea.employee_name} ({idea.employee_code})</span></span>
                    <span className={'status-tag ' + (STATUS_CLASS[idea.status] || 'pending')}>{idea.status}</span>
                  </div>
                  <div className="feature-meta">{idea.description}</div>
                  <div className="feature-meta">
                    Week of {idea.week_start} · {idea.created_at?.slice(0, 10)}
                    {idea.status === 'Approved' && ` · Overall score: ${idea.overall_score}/100`}
                    {idea.status === 'Rejected' && idea.reject_reason && ` · ${idea.reject_reason}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function KnowledgeTransfer() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <IdeaAdminScreen />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyIdeas compact /><IdeaAdminScreen compact sectionLabel="Company Knowledge Transfer" /></>);
  return (
    <div>
      <h1>Knowledge Transfer — AI Weekly Idea Contribution</h1>
      <div className="subtitle">Submit 3 unique HRMS-improvement ideas every week. AI checks each one isn't a duplicate, then scores it on originality, usefulness, impact, clarity, and feasibility.</div>
      <MyIdeas />
    </div>
  );
}

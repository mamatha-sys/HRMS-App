import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin dashboard only, no own responses.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own survey
// response view (MySurveys) AND the company-wide dashboard below it, rather than one replacing
// the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing the company-wide (anonymized/aggregated)
// survey dashboard — per Super Admin policy, no create/activate/close actions here unless
// explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];

export default function Surveys() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRSurveys />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MySurveys compact /><HRSurveys compact sectionLabel="Company Surveys" /></>);
  return <MySurveys />;
}

// Employee self-service: respond to active surveys (rating 1-5 per question + optional comment).
function MySurveys({ compact }) {
  const [surveys, setSurveys] = useState([]);
  const [error, setError] = useState('');
  const [answering, setAnswering] = useState(null);
  const [answers, setAnswers] = useState({});
  const [comment, setComment] = useState('');

  function load() { api.get('/surveys/active').then((r) => setSurveys(r.data.surveys)).catch(() => setError('Could not load surveys.')); }
  useEffect(load, []);

  async function submit(survey) {
    setError('');
    const payload = { answers: survey.questions.map((q) => ({ question_id: q.id, rating: answers[q.id] || 3 })), comment };
    try { await api.post(`/surveys/${survey.id}/respond`, payload); setAnswering(null); setAnswers({}); setComment(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit response.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Surveys</div> : <h1>Employee Engagement Surveys</h1>}
      {!compact && <div className="subtitle">Share your feedback — responses feed into an aggregated report only.</div>}
      {error && <div className="banner error">{error}</div>}
      {surveys.length === 0 && <div className="card"><div className="empty">No surveys are open right now.</div></div>}
      {surveys.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 14 }}>
          <div className="feature-name">{s.title}</div>
          {s.description && <div className="feature-meta" style={{ marginBottom: 8 }}>{s.description}</div>}
          {s.answered ? (
            <div className="status-tag present" style={{ display: 'inline-block' }}>You've already responded — thank you!</div>
          ) : answering === s.id ? (
            <div>
              {s.questions.map((q) => (
                <div key={q.id} style={{ marginBottom: 10 }}>
                  <div className="feature-meta" style={{ marginBottom: 4 }}>{q.question_text}</div>
                  <div className="row" style={{ gap: 6 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} className={answers[q.id] === n ? 'primary' : ''} onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: n }))}>{n}</button>
                    ))}
                  </div>
                </div>
              ))}
              <label className="field-label">Comment (optional)</label>
              <input value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginBottom: 10 }} />
              <div className="row">
                <button className="primary" onClick={() => submit(s)} disabled={s.questions.some((q) => !answers[q.id])}>Submit Response</button>
                <button onClick={() => { setAnswering(null); setAnswers({}); setComment(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="primary" onClick={() => setAnswering(s.id)}>Respond</button>
          )}
        </div>
      ))}
    </div>
  );
}

function HRSurveys({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [surveys, setSurveys] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [questions, setQuestions] = useState(['', '']);
  const [results, setResults] = useState(null);
  const [viewing, setViewing] = useState(null);

  function load() { api.get('/surveys').then((r) => setSurveys(r.data.surveys)).catch(() => setError('Could not load surveys.')); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    const qs = questions.filter((q) => q.trim());
    if (qs.length === 0) { setError('At least one question is required.'); return; }
    try { await api.post('/surveys', { title, description, questions: qs }); setTitle(''); setDescription(''); setQuestions(['', '']); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create survey.'); }
  }
  async function setStatus(id, status) {
    setError('');
    try { await api.put(`/surveys/${id}`, { status }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update survey.'); }
  }
  async function viewResults(id) {
    setViewing(id); setError('');
    try { const r = await api.get(`/surveys/${id}/results`); setResults(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not load results.'); }
  }

  if (viewing) {
    return (
      <div>
        <h1>Survey Results{results ? ` — ${results.survey.title}` : ''}</h1>
        {error && <div className="banner error">{error}</div>}
        <button onClick={() => { setViewing(null); setResults(null); }} style={{ marginBottom: 14 }}>← Back to Surveys</button>
        {!results ? <div className="empty">Loading…</div> : (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="feature-name" style={{ marginBottom: 8 }}>Average Rating per Question ({results.totalResponses} response{results.totalResponses === 1 ? '' : 's'})</div>
              {results.questions.map((q) => (
                <div key={q.id} className="rec-row">
                  <span>{q.question_text}</span>
                  <span>{q.avgRating != null ? `${q.avgRating} / 5` : 'No responses yet'}</span>
                </div>
              ))}
            </div>
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Comments</div>
              {results.comments.length === 0 && <div className="empty">No comments yet.</div>}
              {results.comments.map((c, i) => <div key={i} className="feature-meta" style={{ borderTop: '1px solid #EEF0F3', padding: '6px 0' }}>{c.comment} <span style={{ opacity: 0.6 }}>({c.submitted_at.slice(0, 10)})</span></div>)}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Surveys'}</div> : <h1>Employee Engagement Surveys</h1>}
      {!compact && <div className="subtitle">Create pulse surveys and review aggregated results.</div>}
      {error && <div className="banner error">{error}</div>}

      {canManage && (
        <div className="card" style={{ marginBottom: 14 }}>
          {showForm ? (
            <form onSubmit={submit}>
              <label className="field-label">Title *</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required style={{ marginBottom: 10 }} />
              <label className="field-label">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} style={{ marginBottom: 10 }} />
              <label className="field-label">Questions (1–5 rating scale)</label>
              {questions.map((q, i) => (
                <input key={i} value={q} onChange={(e) => { const next = [...questions]; next[i] = e.target.value; setQuestions(next); }} placeholder={`Question ${i + 1}`} style={{ marginBottom: 8 }} />
              ))}
              <button type="button" onClick={() => setQuestions([...questions, ''])} style={{ marginBottom: 10 }}>+ Add Question</button>
              <div className="row">
                <button className="primary" type="submit">Create Survey</button>
                <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="primary" onClick={() => setShowForm(true)}>+ New Survey</button>
          )}
        </div>
      )}

      <div className="card">
        {!surveys && <div className="empty">Loading…</div>}
        {surveys && surveys.length === 0 && <div className="empty">No surveys yet.</div>}
        {surveys && surveys.map((s) => (
          <div key={s.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span><strong>{s.title}</strong> <span className="feature-meta">· {s.questions.length} question(s) · {s.responseCount} response(s)</span></span>
              <span className={'status-tag ' + (s.status === 'Active' ? 'present' : (s.status === 'Closed' ? 'absent' : 'info'))}>{s.status}</span>
            </div>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {canManage && s.status === 'Draft' && <button onClick={() => setStatus(s.id, 'Active')}>Activate</button>}
              {canManage && s.status === 'Active' && <button onClick={() => setStatus(s.id, 'Closed')}>Close</button>}
              <button onClick={() => viewResults(s.id)}>View Results</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

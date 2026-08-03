import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own reviews.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own reviews
// (MyPerformance) AND the performance admin view below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing their assigned department(s)/team(s) — per
// Super Admin policy, no create/edit/approve/manage actions here unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];

export default function Performance() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRPerformance />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyPerformance compact /><HRPerformance compact sectionLabel="Company Performance" /></>);
  return <MyPerformance />;
}

// Self-Appraisal self-service: an employee's own reviews, with their own self-assessment
// submit button and read/add access to the 360° feedback thread.
function MyPerformance({ compact }) {
  const [reviews, setReviews] = useState([]);
  const [error, setError] = useState('');
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');

  function load() { api.get('/performance/my-reviews').then((r) => setReviews(r.data.reviews)).catch(() => {}); }
  useEffect(load, []);

  async function submitSelfAssessment(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/self-assessment`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit self-assessment.'); }
  }
  async function addFeedback(id) {
    if (!note.trim()) return;
    setError('');
    try { await api.post(`/performance/reviews/${id}/feedback`, { note, author_type: 'Self' }); setNote(''); setNoteFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add feedback.'); }
  }

  const ratedReviews = reviews.filter((r) => r.rating != null);
  const avgRating = ratedReviews.length ? Math.round((ratedReviews.reduce((t, r) => t + r.rating, 0) / ratedReviews.length) * 10) / 10 : null;
  const completedCount = reviews.filter((r) => r.status === 'Completed').length;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Performance</div> : <h1>Performance Management</h1>}
      {!compact && <div className="subtitle">Your goals, self-appraisal and review status.</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My Goals</div>
        {reviews.length === 0 && <div className="empty">No goals assigned yet.</div>}
        {reviews.length > 0 && (
          <table>
            <thead><tr><th>Goal</th><th>Due</th><th>Progress</th></tr></thead>
            <tbody>{reviews.map((r) => (
              <tr key={r.id}>
                <td>{r.goal_text}</td>
                <td>{r.due_date || '—'}</td>
                <td>
                  <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', marginBottom: 2 }}>
                    <div style={{ height: '100%', width: `${r.progress_pct}%`, background: '#2E5CB8' }} />
                  </div>
                  <span className="feature-meta">{r.progress_pct}%</span>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">My Goals</div><div className="kpi-value">{reviews.length}</div></div>
        <div className="kpi-card green"><div className="kpi-label">Completed Reviews</div><div className="kpi-value">{completedCount}</div></div>
        <div className="kpi-card gold"><div className="kpi-label">My Avg Rating</div><div className="kpi-value">{avgRating ?? '—'}</div></div>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My Reviews</div>
        {reviews.length === 0 && <div className="empty">No performance review has been created for you yet.</div>}
        {reviews.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <span><strong>{r.goal_text}</strong>{r.team && <span className="status-tag info" style={{ marginLeft: 6 }}>{r.team}</span>}</span>
              <span className={'status-tag ' + (r.status === 'Completed' ? 'present' : 'pending')}>{r.status}</span>
            </div>
            {r.kpi_text && <div className="feature-meta">KPI: {r.kpi_text}</div>}
            <div className="feature-meta">Self-Assessment: {r.self_assessment_status} · Manager Assessment: {r.manager_assessment_status}{r.rating ? ` · Rating: ${r.rating}/5` : ''}</div>
            {(r.achievements_text || r.development_areas) && (
              <div className="feature-meta">
                {r.achievements_text ? `Achievements: ${r.achievements_text}` : ''}{r.achievements_text && r.development_areas ? ' · ' : ''}{r.development_areas ? `Development: ${r.development_areas}` : ''}
              </div>
            )}
            {r.self_assessment_status === 'Pending' && <button style={{ marginTop: 6 }} onClick={() => submitSelfAssessment(r.id)}>Submit Self-Assessment</button>}
            <div style={{ marginTop: 8 }}>
              <div className="feature-meta">360° Feedback ({r.feedback.length})</div>
              {r.feedback.map((f) => <div key={f.id} className="feature-meta" style={{ paddingLeft: 8 }}>— {f.note} <em>({f.author_name} · {f.author_type})</em></div>)}
              {noteFor === r.id ? (
                <div className="row" style={{ marginTop: 4 }}>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add feedback note" style={{ flex: 1 }} />
                  <button className="primary" onClick={() => addFeedback(r.id)}>Post</button>
                  <button onClick={() => setNoteFor(null)}>Cancel</button>
                </div>
              ) : <button style={{ marginTop: 4 }} onClick={() => setNoteFor(r.id)}>+ Add feedback</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function useReview(reviewId) {
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  function load() {
    if (!reviewId) return;
    api.get(`/performance/reviews/${reviewId}`).then((r) => setReview(r.data.review)).catch(() => setError('Could not load review.'));
  }
  useEffect(load, [reviewId]);
  return { review, error, reload: load };
}

function HRPerformance({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('dashboard');
  const [activeReviewId, setActiveReviewId] = useState(null);
  const [tab, setTab] = useState('dashboard'); // dashboard | reports (kept separate from `screen`)
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '' });

  function load() {
    api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load performance overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'reports') api.get('/performance/reports').then((r) => setReports(r.data)).catch(() => {}); }, [tab]);

  function goToReviewScreen(reviewId, target) { setActiveReviewId(reviewId); setScreen(target); }
  function backToDashboard() { setScreen('dashboard'); setActiveReviewId(null); load(); }

  async function submitReview(e) {
    e.preventDefault(); setError('');
    try { await api.post('/performance/reviews', form); setForm({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create review.'); }
  }
  async function markComplete(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/complete`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not mark complete.'); }
  }

  if (screen === 'goals') return <GoalsScreen employees={employees} canManage={canManage} onBack={backToDashboard} />;
  if (screen === 'appraisal') return <AppraisalScreen reviewId={activeReviewId} onDone={backToDashboard} onBack={backToDashboard} />;
  if (screen === 'feedback') return <FeedbackScreen reviewId={activeReviewId} onBack={backToDashboard} />;
  if (screen === 'competency') return <CompetencyScreen reviewId={activeReviewId} onDone={backToDashboard} onBack={backToDashboard} />;
  if (screen === 'plan') return <PlanScreen reviewId={activeReviewId} onDone={backToDashboard} onBack={backToDashboard} />;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Performance'}</div> : <h1>Performance Management</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? (
        <>
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Ratings by Team</div>
            {!reports && <div className="empty">Loading…</div>}
            {reports && (
              <table>
                <thead><tr><th>Team</th><th>Reviews</th><th>Avg Rating</th></tr></thead>
                <tbody>{reports.teamStats.map((t) => (
                  <tr key={t.team}><td>{t.team}</td><td>{t.count}</td><td>{t.avgRating ?? '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
          {reports && (
            <div className="dashboard-grid">
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}>Rating Distribution</div>
                {reports.distribution.map((d) => (
                  <div key={d.rating} className="rec-row"><span>{d.rating} star(s)</span><span>{d.count}</span></div>
                ))}
              </div>
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}>Status</div>
                <div className="rec-row"><span>In Progress</span><span>{reports.statusCounts['In Progress']}</span></div>
                <div className="rec-row"><span>Completed</span><span>{reports.statusCounts.Completed}</span></div>
              </div>
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}>Promotion &amp; PIP</div>
                <div className="rec-row"><span>Promotion</span><span>{reports.planCounts.Promotion}</span></div>
                <div className="rec-row"><span>PIP</span><span>{reports.planCounts.PIP}</span></div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {ov && (
            <div className="kpi-row">
              {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
            </div>
          )}

          <div className="dashboard-grid">
            <div className="card" id="section-reviews">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name"><span className="widget-badge">1</span>Performance Reviews</div>
                {canManage && <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add Review'}</button>}
              </div>
              {canManage && showForm && (
                <form onSubmit={submitReview} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                  <select value={form.employee_id} onChange={(e) => {
                    const emp = employees.find((x) => String(x.id) === e.target.value);
                    setForm({ ...form, employee_id: e.target.value, employee_name: emp?.name || form.employee_name });
                  }} style={{ flex: '1 1 160px' }}>
                    <option value="">Select employee…</option>
                    {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name} ({emp.employee_code})</option>)}
                  </select>
                  <input placeholder="Team (optional)" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} style={{ flex: '1 1 100px' }} />
                  <input placeholder="Goal" value={form.goal_text} onChange={(e) => setForm({ ...form, goal_text: e.target.value })} required style={{ flex: '2 1 200px' }} />
                  <input placeholder="KPI" value={form.kpi_text} onChange={(e) => setForm({ ...form, kpi_text: e.target.value })} style={{ flex: '1 1 160px' }} />
                  <button className="primary" type="submit">Add</button>
                </form>
              )}
              {ov?.reviews.length === 0 && <div className="empty">No performance reviews yet.</div>}
              {ov?.reviews.map((r) => {
                const bothSubmitted = r.self_assessment_status === 'Submitted' && r.manager_assessment_status === 'Submitted';
                return (
                  <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                      <span><strong>{r.employee_name}</strong>{r.team && <span className="status-tag info" style={{ marginLeft: 6 }}>{r.team}</span>}{r.plan_type !== 'None' && <span className={'status-tag ' + (r.plan_type === 'Promotion' ? 'present' : 'absent')} style={{ marginLeft: 6 }}>{r.plan_type}</span>}</span>
                      <span className={'status-tag ' + (r.status === 'Completed' ? 'present' : (r.manager_assessment_status === 'Pending' ? 'pending' : 'absent'))}>
                        {r.status === 'Completed' ? 'Completed' : (r.self_assessment_status === 'Pending' ? 'Self-Assessment Pending' : 'Manager Assessment Pending')}
                      </span>
                    </div>
                    <div className="feature-meta">{r.goal_text}{r.kpi_text ? ` · KPI: ${r.kpi_text}` : ''}</div>
                    <div className="feature-meta">Self-Assessment: {r.self_assessment_status} · Manager Assessment: {r.manager_assessment_status}{r.rating ? ` · Rating: ${r.rating}/5` : ''}</div>

                    {canManage && r.status !== 'Completed' && (
                      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button onClick={() => goToReviewScreen(r.id, 'appraisal')}>Submit Manager Assessment</button>
                        <button disabled={!bothSubmitted} onClick={() => markComplete(r.id)} title={!bothSubmitted ? 'Both self- and manager-assessment must be submitted first' : ''}>
                          Mark Review Complete
                        </button>
                      </div>
                    )}
                    {canManage && (
                      <div className="feature-meta" style={{ marginTop: 6 }}>
                        <a href="#" onClick={(e) => { e.preventDefault(); goToReviewScreen(r.id, 'feedback'); }}>360° Feedback</a>
                        {' · '}
                        <a href="#" onClick={(e) => { e.preventDefault(); goToReviewScreen(r.id, 'competency'); }}>Competency</a>
                        {' · '}
                        <a href="#" onClick={(e) => { e.preventDefault(); goToReviewScreen(r.id, 'plan'); }}>Plan</a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Each feature opens its own screen.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {ov?.keyFeatures.map((f) => <button key={f.key} className="pill" onClick={() => f.screen === 'reports' ? setTab('reports') : setScreen(f.screen)}>{f.label}</button>)}
              </div>
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Field-Level Access</div>
              {ov?.fieldAccess.map((f) => (
                <div key={f.field} className="rec-row"><span>{f.field}</span><span className="status-tag present">{f.access}</span></div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">4</span>Quick Actions</div>
            {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
          </div>
        </>
      )}
    </div>
  );
}

// --- Dedicated "Goal Assignment & Tracking" screen: Employee | Goal | Due | Progress. ---
function GoalsScreen({ employees, canManage, onBack }) {
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_id: '', employee_name: '', goal_text: '', due_date: '' });
  const [editingProgress, setEditingProgress] = useState(null);
  const [progressDraft, setProgressDraft] = useState(0);

  function load() { api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load goals.')); }
  useEffect(load, []);

  async function assignGoal(e) {
    e.preventDefault(); setError('');
    try { await api.post('/performance/reviews', form); setForm({ employee_id: '', employee_name: '', goal_text: '', due_date: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign goal.'); }
  }
  async function saveProgress(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/progress`, { progress_pct: progressDraft }); setEditingProgress(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update progress.'); }
  }

  return (
    <div>
      <h1>Goal Assignment &amp; Tracking</h1>
      <div className="subtitle">Assign goals and track progress across the team.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Performance Management</button>

      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && (
          <table>
            <thead><tr><th>Employee</th><th>Goal</th><th>Due</th><th>Progress</th></tr></thead>
            <tbody>{ov.reviews.map((r) => (
              <tr key={r.id}>
                <td>{r.employee_name}</td>
                <td>{r.goal_text}</td>
                <td>{r.due_date || '—'}</td>
                <td style={{ minWidth: 140 }}>
                  {canManage && editingProgress === r.id ? (
                    <span className="row" style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <input type="number" min="0" max="100" value={progressDraft} onChange={(e) => setProgressDraft(e.target.value)} style={{ width: 60 }} />
                      <button className="primary" onClick={() => saveProgress(r.id)}>Save</button>
                      <button onClick={() => setEditingProgress(null)}>Cancel</button>
                    </span>
                  ) : (
                    <span onClick={canManage ? () => { setEditingProgress(r.id); setProgressDraft(r.progress_pct); } : undefined} style={canManage ? { cursor: 'pointer' } : undefined} title={canManage ? 'Click to update' : ''}>
                      <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', marginBottom: 2 }}>
                        <div style={{ height: '100%', width: `${r.progress_pct}%`, background: '#2E5CB8' }} />
                      </div>
                      <span className="feature-meta">{r.progress_pct}%</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {canManage && showForm && (
        <div className="card">
          <form onSubmit={assignGoal} className="row" style={{ flexWrap: 'wrap' }}>
            <select value={form.employee_id} onChange={(e) => {
              const emp = employees.find((x) => String(x.id) === e.target.value);
              setForm({ ...form, employee_id: e.target.value, employee_name: emp?.name || '' });
            }} required style={{ flex: '1 1 160px' }}>
              <option value="">Select employee…</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name} ({emp.employee_code})</option>)}
            </select>
            <input placeholder="Goal" value={form.goal_text} onChange={(e) => setForm({ ...form, goal_text: e.target.value })} required style={{ flex: '2 1 200px' }} />
            <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} style={{ flex: '1 1 140px' }} />
            <button className="primary" type="submit">Assign</button>
          </form>
        </div>
      )}
      {canManage && (
        <button style={{ background: '#1E8E5A', color: '#fff', borderColor: '#1E8E5A' }} onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Assign New Goal'}</button>
      )}
    </div>
  );
}

// --- Dedicated "Performance Reviews & Appraisals — <Name>" screen. ---
function AppraisalScreen({ reviewId, onDone, onBack }) {
  const { review, error: loadError } = useReview(reviewId);
  const [achievements, setAchievements] = useState('');
  const [development, setDevelopment] = useState('');
  const [rating, setRating] = useState(5);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (review && !loaded) {
      setAchievements(review.achievements_text || '');
      setDevelopment(review.development_areas || '');
      setRating(review.rating || 5);
      setLoaded(true);
    }
  }, [review, loaded]);

  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      await api.put(`/performance/reviews/${reviewId}/manager-assessment`, { achievements_text: achievements, development_areas: development, rating });
      onDone();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit assessment.'); }
  }

  return (
    <div>
      <h1>Performance Reviews &amp; Appraisals{review ? ` — ${review.employee_name}` : ''}</h1>
      {(error || loadError) && <div className="banner error">{error || loadError}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Performance Management</button>
      {!review ? <div className="empty">Loading…</div> : (
        <form onSubmit={submit} className="card" style={{ maxWidth: 520 }}>
          <label className="field-label">Achievements this cycle</label>
          <textarea value={achievements} onChange={(e) => setAchievements(e.target.value)} rows={3} style={{ marginBottom: 14, width: '100%' }} />
          <label className="field-label">Areas for Development</label>
          <textarea value={development} onChange={(e) => setDevelopment(e.target.value)} rows={3} style={{ marginBottom: 14, width: '100%' }} />
          <label className="field-label">Rating (1–5)</label>
          <input type="number" min="1" max="5" value={rating} onChange={(e) => setRating(e.target.value)} style={{ marginBottom: 14, width: 80 }} />
          <div><button type="submit" className="primary">Submit</button></div>
        </form>
      )}
    </div>
  );
}

// --- Dedicated "360° & Continuous Feedback — <Name>" screen. ---
function FeedbackScreen({ reviewId, onBack }) {
  const { review, error: loadError, reload } = useReview(reviewId);
  const [note, setNote] = useState('');
  const [authorType, setAuthorType] = useState('Manager');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!note.trim()) return;
    try { await api.post(`/performance/reviews/${reviewId}/feedback`, { note, author_type: authorType }); setNote(''); reload(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add feedback.'); }
  }

  return (
    <div>
      <h1>360° &amp; Continuous Feedback{review ? ` — ${review.employee_name}` : ''}</h1>
      {(error || loadError) && <div className="banner error">{error || loadError}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Performance Management</button>
      {!review ? <div className="empty">Loading…</div> : (
        <div className="card" style={{ maxWidth: 560 }}>
          {review.feedback.length === 0 && <div className="empty">No feedback yet.</div>}
          {review.feedback.map((f) => (
            <div key={f.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{f.author_name} ({f.author_type})</strong>
                <span className="feature-meta">{f.created_at.slice(0, 10)}</span>
              </div>
              <div className="feature-meta">{f.note}</div>
            </div>
          ))}
          <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
            <select value={authorType} onChange={(e) => setAuthorType(e.target.value)} style={{ flex: '1 1 100px' }}>
              <option value="Manager">Manager</option>
              <option value="Peer">Peer</option>
              <option value="Self">Self</option>
              <option value="Other">Other</option>
            </select>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add feedback…" style={{ flex: '3 1 220px' }} />
            <button className="primary" type="submit">Submit Feedback</button>
          </form>
        </div>
      )}
    </div>
  );
}

// --- Dedicated "Competency & Skill Gap Assessment — <Name>" screen. ---
function CompetencyScreen({ reviewId, onDone, onBack }) {
  const { review, error: loadError } = useReview(reviewId);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { if (review && !loaded) { setNotes(review.competency_notes || ''); setLoaded(true); } }, [review, loaded]);

  async function save(e) {
    e.preventDefault(); setError('');
    try { await api.put(`/performance/reviews/${reviewId}/competency`, { notes }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }

  return (
    <div>
      <h1>Competency &amp; Skill Gap Assessment{review ? ` — ${review.employee_name}` : ''}</h1>
      {(error || loadError) && <div className="banner error">{error || loadError}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Performance Management</button>
      {!review ? <div className="empty">Loading…</div> : (
        <form onSubmit={save} className="card" style={{ maxWidth: 520 }}>
          <label className="field-label">Competency / skill-gap notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} style={{ marginBottom: 14, width: '100%' }} />
          <button type="submit" className="primary">Save</button>
        </form>
      )}
    </div>
  );
}

// --- Dedicated "Promotion & Improvement Plans (PIP) — <Name>" screen. ---
function PlanScreen({ reviewId, onDone, onBack }) {
  const { review, error: loadError } = useReview(reviewId);
  const [planType, setPlanType] = useState('None');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { if (review && !loaded) { setPlanType(review.plan_type || 'None'); setLoaded(true); } }, [review, loaded]);

  async function save(e) {
    e.preventDefault(); setError('');
    try { await api.put(`/performance/reviews/${reviewId}/plan`, { plan_type: planType }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }

  return (
    <div>
      <h1>Promotion &amp; Improvement Plans (PIP){review ? ` — ${review.employee_name}` : ''}</h1>
      {(error || loadError) && <div className="banner error">{error || loadError}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Performance Management</button>
      {!review ? <div className="empty">Loading…</div> : (
        <form onSubmit={save} className="card" style={{ maxWidth: 420 }}>
          <label className="field-label">Plan</label>
          <select value={planType} onChange={(e) => setPlanType(e.target.value)} style={{ marginBottom: 14 }}>
            <option value="None">None</option>
            <option value="Promotion">Promotion</option>
            <option value="PIP">PIP</option>
          </select>
          <button type="submit" className="primary">Save</button>
        </form>
      )}
    </div>
  );
}

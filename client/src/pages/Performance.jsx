import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.style.transition = 'box-shadow 0.2s';
  el.style.boxShadow = '0 0 0 3px #2E5CB8';
  setTimeout(() => { el.style.boxShadow = ''; }, 1200);
}

export default function Performance() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRPerformance /> : <MyPerformance />;
}

// Self-Appraisal self-service: an employee's own reviews, with their own self-assessment
// submit button and read/add access to the 360° feedback thread.
function MyPerformance() {
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
    try { await api.post(`/performance/reviews/${id}/feedback`, { note }); setNote(''); setNoteFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add feedback.'); }
  }

  return (
    <div>
      <h1>Performance Management</h1>
      <div className="subtitle">Your goals, self-appraisal and review status.</div>
      {error && <div className="banner error">{error}</div>}
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
            {r.self_assessment_status === 'Pending' && <button style={{ marginTop: 6 }} onClick={() => submitSelfAssessment(r.id)}>Submit Self-Assessment</button>}
            <div style={{ marginTop: 8 }}>
              <div className="feature-meta">360° Feedback ({r.feedback.length})</div>
              {r.feedback.map((f) => <div key={f.id} className="feature-meta" style={{ paddingLeft: 8 }}>— {f.note} <em>({f.author_name})</em></div>)}
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

function HRPerformance() {
  const { user } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '' });
  const [ratingFor, setRatingFor] = useState(null);
  const [rating, setRating] = useState(5);
  const [editingGoal, setEditingGoal] = useState(null);
  const [goalDraft, setGoalDraft] = useState({ goal_text: '', kpi_text: '' });
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');
  const [competencyFor, setCompetencyFor] = useState(null);
  const [competencyDraft, setCompetencyDraft] = useState('');

  function load() {
    api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load performance overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'reports') api.get('/performance/reports').then((r) => setReports(r.data)).catch(() => {}); }, [tab]);

  async function submitReview(e) {
    e.preventDefault(); setError('');
    try { await api.post('/performance/reviews', form); setForm({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create review.'); }
  }
  async function saveGoal(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}`, goalDraft); setEditingGoal(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function submitManagerAssessment(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/manager-assessment`, { rating }); setRatingFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit assessment.'); }
  }
  async function markComplete(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/complete`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not mark complete.'); }
  }
  async function addFeedback(id) {
    if (!note.trim()) return;
    setError('');
    try { await api.post(`/performance/reviews/${id}/feedback`, { note }); setNote(''); setNoteFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add feedback.'); }
  }
  async function saveCompetency(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/competency`, { notes: competencyDraft }); setCompetencyFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function setPlan(id, plan_type) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/plan`, { plan_type }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  return (
    <div>
      <h1>Performance Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
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
                <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add Review'}</button>
              </div>
              {showForm && (
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

                    {editingGoal === r.id ? (
                      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 4 }}>
                        <input value={goalDraft.goal_text} onChange={(e) => setGoalDraft({ ...goalDraft, goal_text: e.target.value })} placeholder="Goal" style={{ flex: '2 1 200px' }} />
                        <input value={goalDraft.kpi_text} onChange={(e) => setGoalDraft({ ...goalDraft, kpi_text: e.target.value })} placeholder="KPI" style={{ flex: '1 1 160px' }} />
                        <button className="primary" onClick={() => saveGoal(r.id)}>Save</button>
                        <button onClick={() => setEditingGoal(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="feature-meta">
                        {r.goal_text}{r.kpi_text ? ` · KPI: ${r.kpi_text}` : ''}
                        <button style={{ marginLeft: 8 }} onClick={() => { setEditingGoal(r.id); setGoalDraft({ goal_text: r.goal_text, kpi_text: r.kpi_text || '' }); }}>Edit goal/KPI</button>
                      </div>
                    )}

                    <div className="feature-meta">Self-Assessment: {r.self_assessment_status} · Manager Assessment: {r.manager_assessment_status}{r.rating ? ` · Rating: ${r.rating}/5` : ''}</div>

                    {competencyFor === r.id ? (
                      <div className="row" style={{ marginTop: 4 }}>
                        <input value={competencyDraft} onChange={(e) => setCompetencyDraft(e.target.value)} placeholder="Competency / skill-gap notes" style={{ flex: 1 }} />
                        <button className="primary" onClick={() => saveCompetency(r.id)}>Save</button>
                        <button onClick={() => setCompetencyFor(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="feature-meta">Competency notes: {r.competency_notes || '—'} <button onClick={() => { setCompetencyFor(r.id); setCompetencyDraft(r.competency_notes || ''); }}>Edit</button></div>
                    )}

                    <div className="feature-meta" style={{ marginTop: 4 }}>
                      Plan: <select value={r.plan_type} onChange={(e) => setPlan(r.id, e.target.value)} style={{ width: 'auto', display: 'inline-block' }}>
                        <option value="None">None</option>
                        <option value="Promotion">Promotion</option>
                        <option value="PIP">PIP</option>
                      </select>
                    </div>

                    <div style={{ marginTop: 6 }}>
                      <div className="feature-meta">360° Feedback ({r.feedback.length})</div>
                      {r.feedback.map((f) => <div key={f.id} className="feature-meta" style={{ paddingLeft: 8 }}>— {f.note} <em>({f.author_name})</em></div>)}
                      {noteFor === r.id ? (
                        <div className="row" style={{ marginTop: 4 }}>
                          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add feedback note" style={{ flex: 1 }} />
                          <button className="primary" onClick={() => addFeedback(r.id)}>Post</button>
                          <button onClick={() => setNoteFor(null)}>Cancel</button>
                        </div>
                      ) : <button style={{ marginTop: 4 }} onClick={() => setNoteFor(r.id)}>+ Add feedback</button>}
                    </div>

                    {r.status !== 'Completed' && (
                      <div style={{ marginTop: 8 }}>
                        {ratingFor === r.id ? (
                          <span className="row" style={{ display: 'inline-flex' }}>
                            <select value={rating} onChange={(e) => setRating(e.target.value)} style={{ width: 'auto' }}>
                              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <button className="primary" onClick={() => submitManagerAssessment(r.id)}>Save</button>
                            <button onClick={() => setRatingFor(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button onClick={() => { setRatingFor(r.id); setRating(r.rating || 5); }}>Submit Manager Assessment</button>
                        )}
                        <button style={{ marginLeft: 6 }} disabled={!bothSubmitted} onClick={() => markComplete(r.id)} title={!bothSubmitted ? 'Both self- and manager-assessment must be submitted first' : ''}>
                          Mark Review Complete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Click a feature to jump to it.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>Goal Assignment &amp; Tracking</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>KPI / KRA / OKR Management</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>Performance Reviews &amp; Appraisals</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>Self-Appraisal</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>360° &amp; Continuous Feedback</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>Competency &amp; Skill Gap Assessment</button>
                <button className="pill" onClick={() => scrollToSection('section-reviews')}>Promotion &amp; Improvement Plans (PIP)</button>
                <button className="pill" onClick={() => setTab('reports')}>Performance Reports &amp; Analytics</button>
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

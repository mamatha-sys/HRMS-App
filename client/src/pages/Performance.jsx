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
  const [attendance, setAttendance] = useState(null);
  const [thisMonthTargets, setThisMonthTargets] = useState({ assigned: 0, completed: 0 });
  const [progressScore, setProgressScore] = useState(null);
  const [error, setError] = useState('');
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');

  function load() {
    api.get('/performance/my-reviews').then((r) => {
      setReviews(r.data.reviews);
      setAttendance(r.data.attendance);
      setThisMonthTargets(r.data.thisMonthTargets || { assigned: 0, completed: 0 });
      setProgressScore(r.data.progressScore || null);
    }).catch(() => {});
  }
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

      <div className="kpi-row">
        {progressScore && (
          <div className={'kpi-card ' + (progressScore.band === 'High' ? 'green' : progressScore.band === 'Medium' ? 'gold' : 'red')}>
            <div className="kpi-label">Overall Progress</div>
            <div className="kpi-value">{progressScore.overall}% · {progressScore.band}</div>
            <div className="feature-meta">
              Goals {progressScore.goalsScore ?? '—'}{progressScore.goalsScore != null ? '%' : ' (none assigned)'} · Attendance {progressScore.attendanceScore}% · Disciplinary {progressScore.disciplinaryScore}%
              {progressScore.knowledgeTransferScore != null && ` · Knowledge Transfer ${progressScore.knowledgeTransferScore}% (${progressScore.weeksComplied}/${progressScore.weeksExpected} wks)`}
              {progressScore.learningScore != null && ` · Learning ${progressScore.learningScore}% (${progressScore.coursesCompleted}/${progressScore.coursesEnrolled})`}
            </div>
            <div className="feature-meta" style={{ marginTop: 4 }}>
              Salary Increase Recommendation (advisory — HR decides): <strong>{progressScore.salaryRecommendation}</strong>
            </div>
          </div>
        )}
        <div className="kpi-card blue"><div className="kpi-label">This Month's Targets</div><div className="kpi-value">{thisMonthTargets.completed}/{thisMonthTargets.target || thisMonthTargets.assigned || 4}</div></div>
        <div className="kpi-card green"><div className="kpi-label">This Month's Attendance</div><div className="kpi-value">{attendance ? `${attendance.attendancePct}%` : '—'}</div></div>
        {attendance && <div className="kpi-card gold"><div className="kpi-label">Late Check-ins</div><div className="kpi-value">{attendance.late}</div></div>}
      </div>

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
                  <span className="feature-meta">
                    {r.target_value != null ? `${r.achieved_value ?? 0}/${r.target_value} ${r.unit || ''} · ` : ''}{r.progress_pct}%
                  </span>
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
  const [tab, setTab] = useState('overview'); // overview | progress | reviews | reports (kept separate from `screen`)
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '', month: new Date().toISOString().slice(0, 7), target_value: '', unit: '' });
  const [expandedDetails, setExpandedDetails] = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  // Employee ID / Name / Department, narrowing what the Employee Progress table displays. Same
  // shape as the Payroll preview's — ID and name match on a case-insensitive substring,
  // department is exact, since it comes from a dropdown of values actually present in the rows.
  const [progressFilters, setProgressFilters] = useState({ code: '', name: '', department: '' });

  // A plain-text summary of one review — everything the card shows plus the write-up fields that
  // only appear in "View Details" — downloaded client-side, same lightweight Blob-download
  // pattern already used for Recruitment/Leave CSV exports (no server-side PDF generation).
  function downloadReviewReport(r) {
    const lines = [
      'Performance Review Report',
      '=========================',
      `Employee: ${r.employee_name} (${r.employee_code || '—'})`,
      `Department: ${r.employee_department || '—'}`,
      `Designation: ${r.employee_designation || '—'}`,
      `Review Month: ${r.month || '—'}`,
      `Team: ${r.team || '—'}`,
      '',
      `Goal: ${r.goal_text}`,
      `KPI: ${r.kpi_text || '—'}`,
      r.target_value != null ? `Goal Progress: ${r.achieved_value ?? 0}/${r.target_value} ${r.unit || ''} (${r.progress_pct}%)` : `Goal Progress: ${r.progress_pct}%`,
      `Overall Score: ${r.overallScore}/100`,
      `Rating: ${r.rating != null ? `${r.rating}/5` : '—'}`,
      '',
      `Self-Assessment: ${r.self_assessment_status}`,
      `Manager Assessment: ${r.manager_assessment_status}`,
      `Review Status: ${r.status}`,
      `Plan: ${r.plan_type}`,
      '',
      `Achievements: ${r.achievements_text || '—'}`,
      `Development Areas: ${r.development_areas || '—'}`,
      `Competency Notes: ${r.competency_notes || '—'}`,
      r.attendance ? `\nAttendance (${r.attendance.month}): ${r.attendance.attendancePct}% · Late check-ins: ${r.attendance.late} · Missing punches: ${r.attendance.missingPunch}` : ''
    ].filter((l) => l !== '');
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `performance-review-${(r.employee_name || 'employee').replace(/\s+/g, '-')}-${r.month || r.id}.txt`; a.click();
    URL.revokeObjectURL(url);
  }

  function load() {
    api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load performance overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'reports') api.get('/performance/reports').then((r) => setReports(r.data)).catch(() => {}); }, [tab]);

  const [targetPolicy, setTargetPolicy] = useState(null);
  const [policyDraft, setPolicyDraft] = useState({});
  function loadTargetPolicy() { api.get('/performance/target-policy').then((r) => setTargetPolicy(r.data)).catch(() => {}); }
  useEffect(loadTargetPolicy, []);
  async function savePolicy(departmentId) {
    setError('');
    try { await api.put(`/performance/target-policy/${departmentId}`, { targets_per_month: policyDraft[departmentId] }); loadTargetPolicy(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save target policy.'); }
  }
  // The selected employee's department decides how many targets they're allowed this month —
  // shown live in the Add Review form so HR knows the cap before hitting it.
  const selectedEmpDept = employees.find((e) => String(e.id) === String(form.employee_id))?.department;
  // Departments offered are the ones actually present in the rows this user can see, not the
  // org-wide list — a scoped role only ever receives their own departments from the server.
  const progressDepartments = [...new Set((ov?.employeeProgress || []).map((e) => e.department).filter(Boolean))].sort();
  const filteredProgress = (ov?.employeeProgress || []).filter((e) =>
    (!progressFilters.code || (e.employee_code || '').toLowerCase().includes(progressFilters.code.trim().toLowerCase())) &&
    (!progressFilters.name || (e.name || '').toLowerCase().includes(progressFilters.name.trim().toLowerCase())) &&
    (!progressFilters.department || e.department === progressFilters.department)
  );

  const capForSelected = targetPolicy?.departments.find((d) => d.department === selectedEmpDept)?.targets_per_month ?? targetPolicy?.defaultTargetsPerMonth ?? 4;

  function goToReviewScreen(reviewId, target) { setActiveReviewId(reviewId); setScreen(target); }
  function backToDashboard() { setScreen('dashboard'); setActiveReviewId(null); load(); }

  async function submitReview(e) {
    e.preventDefault(); setError('');
    try {
      await api.post('/performance/reviews', form);
      setForm({ employee_id: '', employee_name: '', team: '', goal_text: '', kpi_text: '', month: new Date().toISOString().slice(0, 7), target_value: '', unit: '' });
      setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not create review.'); }
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

      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <button className={tab === 'overview' ? 'primary' : ''} onClick={() => setTab('overview')}>Overview</button>
        <button className={tab === 'progress' ? 'primary' : ''} onClick={() => setTab('progress')}>Progress</button>
        <button className={tab === 'reviews' ? 'primary' : ''} onClick={() => setTab('reviews')}>Reviews</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
        {/* Goals is a full screen rather than a tab panel, but it belongs in the same row: it was
            previously reachable ONLY from the Key Features card, and nothing else opens it. */}
        <button onClick={() => setScreen('goals')}>Goals &amp; KPI / KRA / OKR</button>
      </div>

      {tab === 'reports' && (
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
      )}

      {tab === 'overview' && (
        <>
          {ov && (
            <div className="kpi-row">
              {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
            </div>
          )}

          {ov?.mySupervisorProgress && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="feature-name" style={{ marginBottom: 4 }}>My Standing ({ov.mySupervisorProgress.month})</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Blends your own target progress with your department's average — completing your team's targets improves this too.</div>
              <div className="row" style={{ gap: 16 }}>
                <span>Personal: <strong>{ov.mySupervisorProgress.personalAvgProgress}%</strong></span>
                <span>Department avg: <strong>{ov.mySupervisorProgress.departmentAvgProgress}%</strong></span>
                <span>Combined: <strong style={{ color: '#2E5CB8' }}>{ov.mySupervisorProgress.combined}%</strong></span>
              </div>
            </div>
          )}

          <div className="dashboard-grid">
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">1</span>Field-Level Access</div>
              {ov?.fieldAccess.map((f) => (
                <div key={f.field} className="rec-row"><span>{f.field}</span><span className="status-tag present">{f.access}</span></div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>Quick Actions</div>
            {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
          </div>
        </>
      )}

      {tab === 'progress' && (
        <>
          {ov?.departmentProgress?.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="feature-name" style={{ marginBottom: 8 }}>Department-wise Progress &amp; Top Performers ({ov.month})</div>
              {ov.departmentProgress.map((d, i) => (
                <div key={d.department} className="rec-row" style={{ alignItems: 'center' }}>
                  <span>
                    {i === 0 && <span className="status-tag present" style={{ marginRight: 6 }}>Top</span>}
                    <strong>{d.department}</strong>
                    <span className="feature-meta" style={{ marginLeft: 6 }}>
                      {d.employeesWithTargets} with targets · {d.fullyCompletedCount} completed all {d.targetsPerMonth}
                      {d.topPerformer ? ` · Top: ${d.topPerformer.name} (${d.topPerformer.targetsCompleted}/${d.topPerformer.targetsAssigned}, ${d.topPerformer.avgProgress}%)` : ''}
                    </span>
                  </span>
                  <span style={{ minWidth: 140 }}>
                    <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', marginBottom: 2 }}>
                      <div style={{ height: '100%', width: `${d.avgProgress}%`, background: '#2E5CB8' }} />
                    </div>
                    <span className="feature-meta">{d.avgProgress}%</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {ov?.employeeProgress?.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name">Employee Progress ({ov.month})</div>
                <button onClick={() => setShowProgress((v) => !v)}>{showProgress ? 'Hide' : 'Show all'}</button>
              </div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>
                One score blending this month's goal completion (40%), attendance (20%), disciplinary record (15%), Knowledge Transfer weekly idea contribution (15%), and Learning course completion (10%). Salary Increase Recommendation is advisory only — HR always makes the actual compensation decision; this is never wired into Payroll automatically.
              </div>
              {showProgress && (
                <>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  <input placeholder="Employee ID…" value={progressFilters.code}
                    onChange={(ev) => setProgressFilters({ ...progressFilters, code: ev.target.value })} style={{ flex: '1 1 120px', maxWidth: 180 }} />
                  <input placeholder="Employee name…" value={progressFilters.name}
                    onChange={(ev) => setProgressFilters({ ...progressFilters, name: ev.target.value })} style={{ flex: '1 1 140px', maxWidth: 200 }} />
                  <select value={progressFilters.department}
                    onChange={(ev) => setProgressFilters({ ...progressFilters, department: ev.target.value })} style={{ flex: '1 1 140px', maxWidth: 200 }}>
                    <option value="">All Departments</option>
                    {progressDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  {(progressFilters.code || progressFilters.name || progressFilters.department) && (
                    <button onClick={() => setProgressFilters({ code: '', name: '', department: '' })}>Clear</button>
                  )}
                  <div className="spacer" />
                  <span className="feature-meta">{filteredProgress.length} of {ov.employeeProgress.length}</span>
                </div>

                {filteredProgress.length === 0 && <div className="empty">No employees match these filters.</div>}
                {filteredProgress.length > 0 && (
                <table>
                  <thead><tr><th>Employee ID</th><th>Employee</th><th>Department</th><th>Goals</th><th>Attendance</th><th title="Disciplinary record — 100% with a clean record, reduced by each case on file">Disciplinary</th><th>Knowledge Transfer</th><th>Learning</th><th>Overall</th><th>Band</th><th>Salary Increase</th></tr></thead>
                  <tbody>{filteredProgress.map((e) => (
                    <tr key={e.employee_id}>
                      <td>{e.employee_code}</td>
                      <td>{e.name}</td>
                      <td>{e.department}</td>
                      <td>{e.goalsScore != null ? `${e.goalsScore}%` : '—'} <span className="feature-meta">({e.targetsCompleted}/{e.targetsAssigned})</span></td>
                      <td>{e.attendanceScore}%</td>
                      <td>{e.disciplinaryScore}% {e.openCases > 0 && <span className="status-tag absent" style={{ marginLeft: 4 }}>{e.openCases} open</span>}</td>
                      <td>{e.knowledgeTransferScore != null ? `${e.knowledgeTransferScore}%` : '—'} {e.weeksExpected != null && <span className="feature-meta">({e.weeksComplied}/{e.weeksExpected} wks)</span>}</td>
                      <td>{e.learningScore != null ? `${e.learningScore}%` : '—'} {e.coursesEnrolled != null && <span className="feature-meta">({e.coursesCompleted}/{e.coursesEnrolled})</span>}</td>
                      <td style={{ fontWeight: 700 }}>{e.overall}%</td>
                      <td><span className={'status-tag ' + (e.band === 'High' ? 'present' : e.band === 'Medium' ? 'pending' : 'absent')}>{e.band}</span></td>
                      <td><span className={'status-tag ' + (e.salaryRecommendation === 'Recommended' ? 'present' : e.salaryRecommendation === 'Review at Next Cycle' ? 'pending' : 'absent')}>{e.salaryRecommendation}</span></td>
                    </tr>
                  ))}</tbody>
                </table>
                )}
                </>
              )}
            </div>
          )}

          {user?.role === 'super_admin' && targetPolicy && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="feature-name" style={{ marginBottom: 4 }}>Target Policy — Targets per Month by Department</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>How many monthly targets each department's employees get. Default is {targetPolicy.defaultTargetsPerMonth} for any department not overridden below.</div>
              {targetPolicy.departments.map((d) => (
                <div key={d.department_id} className="rec-row">
                  <span>{d.department}</span>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <input
                      type="number" min="1" style={{ width: 60 }}
                      value={policyDraft[d.department_id] ?? d.targets_per_month}
                      onChange={(e) => setPolicyDraft({ ...policyDraft, [d.department_id]: e.target.value })}
                    />
                    <button onClick={() => savePolicy(d.department_id)}>Save</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'reviews' && (
        <>
          <div className="card" id="section-reviews">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="feature-name">Performance Reviews</div>
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
                <div style={{ flex: '0 1 130px' }}>
                  <label className="field-label" style={{ fontSize: 11 }}>Target month</label>
                  <input type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
                </div>
                <input type="number" min="0" placeholder="Target value (optional)" value={form.target_value} onChange={(e) => setForm({ ...form, target_value: e.target.value })} style={{ flex: '1 1 140px' }} />
                <input placeholder="Unit (e.g. deals, tickets)" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ flex: '1 1 140px' }} />
                <button className="primary" type="submit">Add</button>
              </form>
            )}
            <div className="feature-meta" style={{ marginBottom: 8 }}>
              {selectedEmpDept ? `Up to ${capForSelected} target(s) per month for ${selectedEmpDept}.` : 'Target count is set per department — see the Progress tab\'s Target Policy.'}
              {' '}Leave target value blank for a qualitative goal — set it for a measurable one so progress is computed, not guessed.
            </div>
            {ov?.reviews.length === 0 && <div className="empty">No performance reviews yet.</div>}
            {ov?.reviews.map((r) => {
                const bothSubmitted = r.self_assessment_status === 'Submitted' && r.manager_assessment_status === 'Submitted';
                const notStarted = r.self_assessment_status === 'Pending' && r.manager_assessment_status === 'Pending';
                return (
                  <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                      <span>
                        <strong>{r.employee_name}</strong> <span className="feature-meta">({r.employee_code || 'no ID on file'})</span>
                        {r.team && <span className="status-tag info" style={{ marginLeft: 6 }}>{r.team}</span>}
                        {r.plan_type !== 'None' && <span className={'status-tag ' + (r.plan_type === 'Promotion' ? 'present' : 'absent')} style={{ marginLeft: 6 }}>{r.plan_type}</span>}
                      </span>
                      <span className={'status-tag ' + (r.status === 'Completed' ? 'present' : 'pending')}>{r.status}</span>
                    </div>

                    <div className="grid2" style={{ marginBottom: 6 }}>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Department &amp; Designation</div>
                        <div>{r.employee_department || '—'}{r.employee_designation ? ` · ${r.employee_designation}` : ''}</div>
                      </div>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Review Month</div>
                        <div>{r.month || '—'}</div>
                      </div>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Goal Progress</div>
                        <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', marginTop: 4, marginBottom: 2, maxWidth: 160 }}>
                          <div style={{ height: '100%', width: `${r.progress_pct}%`, background: '#2E5CB8' }} />
                        </div>
                        <span className="feature-meta">
                          {r.target_value != null ? `${r.achieved_value ?? 0}/${r.target_value} ${r.unit || ''} · ` : ''}{r.progress_pct}%
                        </span>
                      </div>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Overall Score</div>
                        <div style={{ fontWeight: 700 }}>{r.overallScore}/100</div>
                      </div>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Self Assessment</div>
                        <span className={'status-tag ' + (r.self_assessment_status === 'Submitted' ? 'present' : 'pending')}>{r.self_assessment_status}</span>
                      </div>
                      <div>
                        <div className="field-label" style={{ fontSize: 11 }}>Manager Assessment</div>
                        <span className={'status-tag ' + (r.manager_assessment_status === 'Submitted' ? 'present' : 'pending')}>{r.manager_assessment_status}</span>
                      </div>
                    </div>

                    {canManage && (
                      <div className="row" style={{ marginTop: 4, gap: 6, flexWrap: 'wrap' }}>
                        {r.status !== 'Completed' && r.manager_assessment_status === 'Pending' && (
                          <button className="primary" onClick={() => goToReviewScreen(r.id, 'appraisal')}>{notStarted ? 'Start Review' : 'Submit Assessment'}</button>
                        )}
                        <button onClick={() => setExpandedDetails(expandedDetails === r.id ? null : r.id)}>{expandedDetails === r.id ? 'Hide Details' : 'View Details'}</button>
                        <button onClick={() => downloadReviewReport(r)}>Download Report</button>
                        {r.status !== 'Completed' && (
                          <button disabled={!bothSubmitted} onClick={() => markComplete(r.id)} title={!bothSubmitted ? 'Both self- and manager-assessment must be submitted first' : ''}>
                            Mark Review Complete
                          </button>
                        )}
                      </div>
                    )}

                    {expandedDetails === r.id && (
                      <div className="card" style={{ marginTop: 8, background: '#F7F9FC' }}>
                        <div className="feature-meta">Goal: {r.goal_text}</div>
                        {r.kpi_text && <div className="feature-meta">KPI: {r.kpi_text}</div>}
                        {r.rating != null && <div className="feature-meta">Rating: {r.rating}/5</div>}
                        {r.achievements_text && <div className="feature-meta">Achievements: {r.achievements_text}</div>}
                        {r.development_areas && <div className="feature-meta">Development Areas: {r.development_areas}</div>}
                        {r.competency_notes && <div className="feature-meta">Competency Notes: {r.competency_notes}</div>}
                        {r.attendance && <div className="feature-meta">Attendance ({r.attendance.month}): {r.attendance.attendancePct}% · {r.attendance.late} late check-in(s) · {r.attendance.missingPunch} missing punch(es)</div>}
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
                    )}
                  </div>
                );
              })}
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
  const [form, setForm] = useState({ employee_id: '', employee_name: '', goal_text: '', due_date: '', target_value: '', unit: '' });
  const [editingProgress, setEditingProgress] = useState(null);
  const [progressDraft, setProgressDraft] = useState(0);

  function load() { api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load goals.')); }
  useEffect(load, []);

  async function assignGoal(e) {
    e.preventDefault(); setError('');
    try {
      await api.post('/performance/reviews', form);
      setForm({ employee_id: '', employee_name: '', goal_text: '', due_date: '', target_value: '', unit: '' });
      setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not assign goal.'); }
  }
  // Measurable goals (target_value set) save an achieved amount, which the server turns into
  // progress_pct — qualitative goals still save a typed-in percentage directly.
  async function saveProgress(r) {
    setError('');
    try {
      await api.put(`/performance/reviews/${r.id}/progress`, r.target_value != null ? { achieved_value: progressDraft } : { progress_pct: progressDraft });
      setEditingProgress(null); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not update progress.'); }
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
                      {r.target_value != null ? (
                        <>
                          <input type="number" min="0" value={progressDraft} onChange={(e) => setProgressDraft(e.target.value)} style={{ width: 70 }} />
                          <span className="feature-meta">/ {r.target_value} {r.unit || ''}</span>
                        </>
                      ) : (
                        <input type="number" min="0" max="100" value={progressDraft} onChange={(e) => setProgressDraft(e.target.value)} style={{ width: 60 }} />
                      )}
                      <button className="primary" onClick={() => saveProgress(r)}>Save</button>
                      <button onClick={() => setEditingProgress(null)}>Cancel</button>
                    </span>
                  ) : (
                    <span onClick={canManage ? () => { setEditingProgress(r.id); setProgressDraft(r.target_value != null ? r.achieved_value : r.progress_pct); } : undefined} style={canManage ? { cursor: 'pointer' } : undefined} title={canManage ? 'Click to update' : ''}>
                      <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', marginBottom: 2 }}>
                        <div style={{ height: '100%', width: `${r.progress_pct}%`, background: '#2E5CB8' }} />
                      </div>
                      <span className="feature-meta">
                        {r.target_value != null ? `${r.achieved_value ?? 0}/${r.target_value} ${r.unit || ''} · ` : ''}{r.progress_pct}%
                      </span>
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
            <input type="number" min="0" placeholder="Target value (optional)" value={form.target_value} onChange={(e) => setForm({ ...form, target_value: e.target.value })} style={{ flex: '1 1 140px' }} />
            <input placeholder="Unit (e.g. deals, tickets)" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ flex: '1 1 140px' }} />
            <button className="primary" type="submit">Assign</button>
          </form>
          <div className="feature-meta" style={{ marginTop: 4 }}>Leave target value blank for a qualitative goal (progress entered manually as a %). Set it for a measurable one (e.g. "20 deals") — progress is then computed from achieved ÷ target.</div>
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

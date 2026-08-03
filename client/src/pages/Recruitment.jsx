import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own vacancies view.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own read-only
// vacancies view (BasicRecruitment) AND the recruitment view below it, rather than one replacing
// the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing their assigned department(s)/team(s) — per
// Super Admin policy, no create/edit/approve/manage actions here unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
// Job requisitions specifically can also be raised (not approved/managed) by Assistant
// Manager/STL/TL, scoped server-side to their own assigned department(s) — everything else in
// Recruitment stays canManage-only.
const CAN_REQUEST_ROLES = [...CAN_MANAGE_ROLES, 'assistant_manager', 'stl', 'tl'];

// today + N days, as an YYYY-MM-DD string — used to suggest a Last Working Day from the
// configured notice period (the date input stays fully editable either way).
function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.style.transition = 'box-shadow 0.2s';
  el.style.boxShadow = '0 0 0 3px #2E5CB8';
  setTimeout(() => { el.style.boxShadow = ''; }, 1200);
}

// Read-only view of an onboarding/offboarding checklist for the employee it belongs to — same
// task list and order HR sees, just no checkbox interaction (HR/the process owner still ticks
// these off; the employee only ever gets to see where things stand).
function ReadOnlyChecklist({ title, subtitle, tasks, pct, accentColor }) {
  return (
    <div className="card" style={accentColor ? { borderLeft: `4px solid ${accentColor}` } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <div className="feature-name">{title}</div>
        <span>{pct}% complete</span>
      </div>
      {subtitle && <div className="feature-meta" style={{ marginBottom: 8 }}>{subtitle}</div>}
      {(tasks || []).map((t) => (
        <label key={t.id} className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <input type="checkbox" checked={!!t.completed} disabled style={{ width: 16, height: 16 }} />
          <span style={{ textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? '#8A93A3' : 'inherit' }}>{t.task_name}</span>
        </label>
      ))}
    </div>
  );
}

// Non-HR roles (TL/STL/Employee) get a self-service view — refer a candidate for an open
// position, or submit your own resignation — recruitment itself stays HR-run.
function BasicRecruitment({ compact }) {
  const [referrals, setReferrals] = useState([]);
  const [openPositions, setOpenPositions] = useState([]);
  const [resignation, setResignation] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showReferForm, setShowReferForm] = useState(false);
  const [referForm, setReferForm] = useState({ name: '', position_id: '', contact: '' });
  const [showResignForm, setShowResignForm] = useState(false);
  const [resignForm, setResignForm] = useState({ last_working_day: '', reason: '' });
  const [noticeDays, setNoticeDays] = useState(45);

  function load() {
    api.get('/recruitment/my').then((r) => {
      setReferrals(r.data.referrals); setOpenPositions(r.data.openPositions);
      setResignation(r.data.resignation); setOnboarding(r.data.onboarding);
    }).catch(() => {});
  }
  useEffect(load, []);
  useEffect(() => { api.get('/recruitment/notice-period').then((r) => setNoticeDays(r.data.days)).catch(() => {}); }, []);

  function openResignForm() {
    setResignForm((f) => ({ ...f, last_working_day: f.last_working_day || addDaysIso(noticeDays) }));
    setShowResignForm(true);
  }

  async function submitRefer(e) {
    e.preventDefault(); setError(''); setInfo('');
    try {
      await api.post('/recruitment/refer', referForm);
      setReferForm({ name: '', position_id: '', contact: '' }); setShowReferForm(false); setInfo('Referral submitted — thank you!'); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit referral.'); }
  }

  async function submitResign(e) {
    e.preventDefault(); setError(''); setInfo('');
    if (!window.confirm('Submit your resignation? HR will be notified and offboarding will begin.')) return;
    try {
      await api.post('/recruitment/resign', resignForm);
      setResignForm({ last_working_day: '', reason: '' }); setShowResignForm(false); setInfo('Resignation submitted to HR.'); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit resignation.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Recruitment</div> : <h1>Recruitment</h1>}
      {!compact && <div className="subtitle">Refer a candidate for an open position, or submit your resignation.</div>}
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">Referrals</div><div className="kpi-value">{referrals.length}</div></div>
      </div>

      {onboarding && (
        <div className="banner info">
          You're currently onboarding — {onboarding.onboarding_pct}% of your checklist is complete.
        </div>
      )}
      {resignation && (
        <div className="banner info">
          Resignation submitted — last working day {resignation.last_working_day}
          {resignation.notice_days_remaining != null && (resignation.notice_days_remaining >= 0
            ? ` (${resignation.notice_days_remaining} day(s) left)`
            : ` (${-resignation.notice_days_remaining} day(s) overdue)`)}
          {' · '}Clearance {resignation.clearance_current}/{resignation.clearance_total}
        </div>
      )}

      {(onboarding || resignation) && (
        <div className="dashboard-grid">
          {onboarding && (
            <ReadOnlyChecklist
              title="My Onboarding"
              subtitle="What's done so far in your onboarding, and what's still pending."
              tasks={onboarding.tasks}
              pct={onboarding.onboarding_pct}
              accentColor="#1E8E5A"
            />
          )}
          {resignation && (
            <ReadOnlyChecklist
              title="My Offboarding"
              subtitle={`Last working day ${resignation.last_working_day} · Clearance ${resignation.clearance_current}/${resignation.clearance_total}`}
              tasks={resignation.tasks}
              pct={resignation.clearance_total > 0 ? Math.round((resignation.clearance_current / resignation.clearance_total) * 100) : 0}
              accentColor="#B3401E"
            />
          )}
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">1</span>Quick Actions</div>
          </div>
          {showReferForm ? (
            <form onSubmit={submitRefer} className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
              <input placeholder="Candidate name" value={referForm.name} onChange={(e) => setReferForm({ ...referForm, name: e.target.value })} required style={{ flex: '1 1 160px' }} />
              <select value={referForm.position_id} onChange={(e) => setReferForm({ ...referForm, position_id: e.target.value })} style={{ flex: '1 1 160px' }}>
                <option value="">Applying for… (optional)</option>
                {openPositions.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.department_name})</option>)}
              </select>
              <input placeholder="Candidate contact (phone/email)" value={referForm.contact} onChange={(e) => setReferForm({ ...referForm, contact: e.target.value })} style={{ flex: '1 1 200px' }} />
              <button className="primary" type="submit">Submit Referral</button>
              <button type="button" onClick={() => setShowReferForm(false)}>Cancel</button>
            </form>
          ) : (
            <button className="pill" style={{ width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => setShowReferForm(true)}>+ Refer Candidate</button>
          )}
          {!resignation && (showResignForm ? (
            <form onSubmit={submitResign}>
              <div className="feature-meta" style={{ marginBottom: 6 }}>Notice period is {noticeDays} days — Last Working Day is suggested below, but you can change it.</div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <input type="date" value={resignForm.last_working_day} onChange={(e) => setResignForm({ ...resignForm, last_working_day: e.target.value })} required style={{ flex: '1 1 160px' }} />
                <input placeholder="Reason (optional)" value={resignForm.reason} onChange={(e) => setResignForm({ ...resignForm, reason: e.target.value })} style={{ flex: '2 1 200px' }} />
                <button className="primary" type="submit">Submit Resignation</button>
                <button type="button" onClick={() => setShowResignForm(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="pill" style={{ width: '100%', textAlign: 'left' }} onClick={openResignForm}>+ Submit Resignation</button>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>My Referrals</div>
          {referrals.length === 0 && <div className="empty">No referrals yet.</div>}
          {referrals.map((r) => (
            <div key={r.id} className="rec-row">
              <span>{r.name}{r.position_title ? ` — ${r.position_title}` : ''}</span>
              <span className="status-tag info">{r.stage || '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Recruitment() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRRecruitment />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><BasicRecruitment compact /><HRRecruitment compact sectionLabel="Company Recruitment" /></>);
  return <BasicRecruitment />;
}

function HRRecruitment({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const canRequest = CAN_REQUEST_ROLES.includes(user?.role);
  const [ov, setOv] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [myDepartments, setMyDepartments] = useState([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('dashboard'); // dashboard | pipeline

  const [showReqForm, setShowReqForm] = useState(false);
  const [reqForm, setReqForm] = useState({ department_id: '', title: '', target_headcount: 1 });
  const [showCandForm, setShowCandForm] = useState(false);
  const [candForm, setCandForm] = useState({ name: '', position_id: '', panel: '', source_id: '' });
  const [showHireForm, setShowHireForm] = useState(false);
  const [hireForm, setHireForm] = useState({ employee_id: '', start_date: '' });
  const [showExitForm, setShowExitForm] = useState(false);
  const [exitForm, setExitForm] = useState({ employee_id: '', last_working_day: '' });
  const [noticeDays, setNoticeDays] = useState(45);
  const [editingNoticeDays, setEditingNoticeDays] = useState(false);
  const [noticeDaysDraft, setNoticeDaysDraft] = useState(45);
  const [activeEmployees, setActiveEmployees] = useState([]);
  const [jobBoards, setJobBoards] = useState([]);
  const [postingFor, setPostingFor] = useState(null);
  const [postingSelection, setPostingSelection] = useState({});
  const [expandedHire, setExpandedHire] = useState(null);
  const [expandedExit, setExpandedExit] = useState(null);

  const [showRoundForm, setShowRoundForm] = useState(false);
  const [newRoundName, setNewRoundName] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Candidate Pipeline filters — kept in their own state, untouched by load()/advance, so moving
  // a candidate forward (e.g. to Hired) never resets which position/stage you were looking at.
  const [pipelinePosition, setPipelinePosition] = useState('');
  const [pipelineDept, setPipelineDept] = useState('');
  const [pipelineStage, setPipelineStage] = useState('');
  const [pipelineSource, setPipelineSource] = useState('');
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [newSourceLabel, setNewSourceLabel] = useState('');

  function load() {
    api.get('/recruitment/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load recruitment overview.'));
  }
  function loadNoticeDays() {
    api.get('/recruitment/notice-period').then((r) => { setNoticeDays(r.data.days); setNoticeDaysDraft(r.data.days); }).catch(() => {});
  }
  useEffect(load, []);
  useEffect(loadNoticeDays, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  useEffect(() => { api.get('/positions/my-departments').then((r) => setMyDepartments(r.data.departments)).catch(() => {}); }, []);
  useEffect(() => { api.get('/employees').then((r) => setActiveEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { api.get('/positions/job-boards').then((r) => setJobBoards(r.data.boards)).catch(() => {}); }, []);

  function openExitForm() {
    setExitForm((f) => ({ ...f, last_working_day: f.last_working_day || addDaysIso(noticeDays) }));
    setShowExitForm(true);
  }
  async function saveNoticeDays(e) {
    e.preventDefault(); setError('');
    try { await api.put('/recruitment/notice-period', { days: noticeDaysDraft }); setEditingNoticeDays(false); loadNoticeDays(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save notice period.'); }
  }

  // Renders each posted board's name — as a link to its connected URL (e.g. a LinkedIn job page)
  // when the board's credential is a real URL, otherwise plain text.
  function boardLabels(postedBoardsJson) {
    if (!postedBoardsJson) return null;
    let keys = [];
    try { keys = JSON.parse(postedBoardsJson); } catch { return null; }
    return keys.map((key, i) => {
      const board = key === 'careers' ? { label: 'Company Careers Page', link: null } : jobBoards.find((b) => b.key === key) || { label: key, link: null };
      return (
        <span key={key}>
          {i > 0 && ', '}
          {board.link ? <a href={board.link} target="_blank" rel="noreferrer">{board.label}</a> : board.label}
        </span>
      );
    });
  }

  async function submitRequisition(e) {
    e.preventDefault(); setError('');
    try { await api.post('/positions', reqForm); setReqForm({ department_id: '', title: '', target_headcount: 1 }); setShowReqForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create requisition.'); }
  }
  async function decide(id, decision) {
    setError('');
    try { await api.put(`/positions/${id}/decide`, { decision }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }
  async function savePosting(id) {
    setError('');
    const boards = Object.keys(postingSelection).filter((k) => postingSelection[k]);
    try { await api.put(`/positions/${id}/posting`, { boards }); setPostingFor(null); setPostingSelection({}); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save posting.'); }
  }
  function openPostingFor(r) {
    let keys = [];
    try { keys = r.posted_boards ? JSON.parse(r.posted_boards) : []; } catch { keys = []; }
    setPostingSelection(Object.fromEntries(keys.map((k) => [k, true])));
    setPostingFor(r.id);
  }
  function togglePostingBoard(key) {
    setPostingSelection((s) => ({ ...s, [key]: !s[key] }));
  }
  async function submitCandidate(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/candidates', candForm); setCandForm({ name: '', position_id: '', panel: '', source_id: '' }); setShowCandForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add candidate.'); }
  }
  async function advanceCandidate(id) {
    setError('');
    try { await api.put(`/recruitment/candidates/${id}/advance`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not advance candidate.'); }
  }
  async function revertCandidate(id) {
    setError('');
    try { await api.put(`/recruitment/candidates/${id}/revert`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not move candidate back.'); }
  }
  async function submitHire(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/new-hires', hireForm); setHireForm({ employee_id: '', start_date: '' }); setShowHireForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add new hire.'); }
  }
  async function toggleOnboardingTask(hireId, taskId, completed) {
    setError('');
    try { await api.put(`/recruitment/new-hires/${hireId}/tasks/${taskId}`, { completed }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update task.'); }
  }
  async function submitExit(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/exits', exitForm); setExitForm({ employee_id: '', last_working_day: '' }); setShowExitForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add exit.'); }
  }
  async function toggleOffboardingTask(exitId, taskId, completed) {
    setError('');
    try { await api.put(`/recruitment/exits/${exitId}/tasks/${taskId}`, { completed }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update task.'); }
  }
  async function addRound(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/interview-rounds', { name: newRoundName }); setNewRoundName(''); setShowRoundForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add round.'); }
  }
  async function pauseRound(round) {
    setError('');
    try { await api.put(`/recruitment/interview-rounds/${round.id}/pause`, { paused: !round.paused }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update round.'); }
  }
  async function addSource(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/candidate-sources', { label: newSourceLabel }); setNewSourceLabel(''); setShowSourceForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add source.'); }
  }
  async function toggleSource(source) {
    setError('');
    try { await api.put(`/recruitment/candidate-sources/${source.id}`, { paused: !source.paused }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update source.'); }
  }

  const filteredRequisitions = (ov?.requisitions || []).filter((r) =>
    (!filterDept || r.department_name === filterDept) && (!filterStatus || r.approval_status === filterStatus)
  );

  const alreadyOnboardingIds = new Set((ov?.newHires || []).filter((h) => !h.completed_at).map((h) => h.employee_id));
  const employeesNotOnboarding = activeEmployees.filter((e) => !alreadyOnboardingIds.has(e.id));

  const filteredCandidates = (ov?.candidates || []).filter((c) =>
    (!pipelinePosition || String(c.position_id) === pipelinePosition) &&
    (!pipelineDept || c.position_department === pipelineDept) &&
    (!pipelineStage || c.stage === pipelineStage) &&
    (!pipelineSource || String(c.source_id) === pipelineSource)
  );
  const pipelineDeptOptions = [...new Set((ov?.candidates || []).map((c) => c.position_department).filter(Boolean))].sort();
  const pipelineStageOptions = [...new Set((ov?.candidates || []).map((c) => c.stage).filter(Boolean))];

  function exportCandidatesCsv() {
    const lines = ['name,position,department,stage,source,feedback_status,referred_by',
      ...filteredCandidates.map((c) => `${c.name},${c.position_title || ''},${c.position_department || ''},${c.stage || ''},${c.source_label || ''},${c.feedback_status},${c.referred_by_name || ''}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'candidate-pipeline.csv'; a.click(); URL.revokeObjectURL(url);
  }

  function exportRequisitionsCsv() {
    const lines = ['title,department,target_headcount,status,requested_by',
      ...filteredRequisitions.map((r) => `${r.title},${r.department_name},${r.target_headcount},${r.approval_status},${r.requested_by || ''}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'job-requisitions.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Recruitment'}</div> : <h1>Recruitment</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'pipeline' ? 'primary' : ''} onClick={() => setTab('pipeline')}>Candidate Pipeline</button>
      </div>

      {tab === 'dashboard' && (
      <>
      <div className="filter-bar">
        <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="Pending Approval">Pending Approval</option>
          <option value="Approved">Approved</option>
          <option value="Rejected">Rejected</option>
        </select>
        <div className="spacer" />
        {canManage && <button className="primary" onClick={exportRequisitionsCsv}>Export</button>}
      </div>

      {ov && (
        <div className="kpi-row">
          {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card" id="section-requisitions">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">1</span>Job Requisitions</div>
            {canRequest && <button onClick={() => setShowReqForm((v) => !v)}>{showReqForm ? 'Cancel' : '+ Add Requisition'}</button>}
          </div>
          {canRequest && showReqForm && (
            <form onSubmit={submitRequisition} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <select value={reqForm.department_id} onChange={(e) => setReqForm({ ...reqForm, department_id: e.target.value })} required style={{ flex: '1 1 140px' }}>
                <option value="">Select department</option>
                {myDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input placeholder="Position title" value={reqForm.title} onChange={(e) => setReqForm({ ...reqForm, title: e.target.value })} required style={{ flex: '1 1 160px' }} />
              <input type="number" min="1" value={reqForm.target_headcount} onChange={(e) => setReqForm({ ...reqForm, target_headcount: e.target.value })} style={{ flex: '0 1 90px' }} />
              <button className="primary" type="submit">Create</button>
            </form>
          )}
          {filteredRequisitions.length === 0 && <div className="empty">No requisitions{ov?.requisitions.length ? ' match this filter.' : ' yet.'}</div>}
          {filteredRequisitions.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{r.title}</strong>
                <span className={'status-tag ' + (r.approval_status === 'Pending Approval' ? 'pending' : 'present')}>
                  {r.approval_status === 'Pending Approval' ? 'Pending Approval' : 'Approved — Posted'}
                </span>
              </div>
              <div className="feature-meta">{r.department_name} · {r.target_headcount} position(s){r.requested_by ? ` · requested by ${r.requested_by}` : ''}</div>
              {r.approval_status === 'Approved' && r.posted_boards && <div className="feature-meta">Live on: {boardLabels(r.posted_boards)}</div>}
              {canManage && (
                <div style={{ marginTop: 6 }}>
                  {r.approval_status === 'Pending Approval' ? (
                    <>
                      <button className="btn-approve" onClick={() => decide(r.id, 'approve')}>Approve</button>
                      <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(r.id, 'reject')}>Reject</button>
                    </>
                  ) : postingFor === r.id ? (
                    <div style={{ marginTop: 4 }}>
                      <div className="feature-meta" style={{ marginBottom: 8 }}>Marks this requisition as posted on the selected boards for tracking — post it there yourself first; this doesn't publish it for you.</div>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
                        {jobBoards.map((b) => (
                          <label key={b.key} className="row" style={{ gap: 4, opacity: b.connected ? 1 : 0.5 }}>
                            <input type="checkbox" disabled={!b.connected} checked={!!postingSelection[b.key]} onChange={() => togglePostingBoard(b.key)} />
                            {b.label}{!b.connected && ' (not connected)'}
                          </label>
                        ))}
                      </div>
                      <label className="row" style={{ gap: 4, marginBottom: 8 }}>
                        <input type="checkbox" checked={!!postingSelection.careers} onChange={() => togglePostingBoard('careers')} />
                        Company Careers Page
                      </label>
                      <div className="row">
                        <button className="primary" onClick={() => savePosting(r.id)}>Update Posting</button>
                        <button onClick={() => setPostingFor(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => openPostingFor(r)}>Manage Posting →</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card" id="section-rounds">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">2</span>Interview Rounds</div>
            {canManage && <button onClick={() => setShowRoundForm((v) => !v)}>{showRoundForm ? 'Cancel' : '+ Add Round'}</button>}
          </div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>The candidate pipeline advances through these rounds, in order. Pause a round to skip it without losing history.</div>
          {canManage && showRoundForm && (
            <form onSubmit={addRound} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Round name (e.g. Culture Fit)" value={newRoundName} onChange={(e) => setNewRoundName(e.target.value)} required style={{ flex: '1 1 160px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.interviewRounds.map((r) => (
            <div key={r.id} className="rec-row" style={{ opacity: r.paused ? 0.55 : 1 }}>
              <span>{r.name}{r.is_final ? <span className="status-tag present" style={{ marginLeft: 6 }}>Final</span> : null}{r.paused ? <span className="status-tag pending" style={{ marginLeft: 6 }}>Paused</span> : null}</span>
              {canManage && <button onClick={() => pauseRound(r)}>{r.paused ? 'Resume' : 'Pause'}</button>}
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card" id="section-onboarding">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name" style={{ color: '#1E8E5A' }}><span className="widget-badge" style={{ background: '#1E8E5A' }}>3</span>Onboarding — New Hires</div>
            {canManage && <button onClick={() => setShowHireForm((v) => !v)}>{showHireForm ? 'Cancel' : '+ Add New Hire'}</button>}
          </div>
          {canManage && showHireForm && (
            <form onSubmit={submitHire} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <select value={hireForm.employee_id} onChange={(e) => setHireForm({ ...hireForm, employee_id: e.target.value })} required style={{ flex: '1 1 200px' }}>
                <option value="">Select employee</option>
                {employeesNotOnboarding.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code}) — {e.department}</option>)}
              </select>
              <input type="date" value={hireForm.start_date} onChange={(e) => setHireForm({ ...hireForm, start_date: e.target.value })} required style={{ flex: '1 1 140px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.newHires.length === 0 && <div className="empty">No new hires onboarding.</div>}
          {ov?.newHires.map((h) => (
            <div key={h.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setExpandedHire(expandedHire === h.id ? null : h.id); }}>
                  {h.name}<div className="feature-meta">{h.designation} · {h.department} · Starts {h.start_date}</div>
                </a>
                <span>{h.onboarding_pct}% complete</span>
              </div>
              {expandedHire === h.id && (
                <div style={{ marginTop: 8, paddingLeft: 8 }}>
                  <div className="feature-meta" style={{ marginBottom: 4 }}>Onboarding responsibilities:</div>
                  {h.tasks.map((t) => (
                    <label key={t.id} className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <input type="checkbox" checked={!!t.completed} disabled={!canManage} onChange={(e) => toggleOnboardingTask(h.id, t.id, e.target.checked)} style={{ width: 16, height: 16 }} />
                      <span style={{ textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? '#8A93A3' : 'inherit' }}>{t.task_name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card" id="section-offboarding" style={{ borderLeft: '4px solid #B3401E' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name" style={{ color: '#B3401E' }}><span className="widget-badge">4</span>Offboarding — Exiting Employees</div>
            {canManage && <button onClick={() => (showExitForm ? setShowExitForm(false) : openExitForm())}>{showExitForm ? 'Cancel' : '+ Add Exit'}</button>}
          </div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>
            Notice period: {editingNoticeDays ? (
              <form onSubmit={saveNoticeDays} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="number" min="1" value={noticeDaysDraft} onChange={(e) => setNoticeDaysDraft(e.target.value)} style={{ width: 60 }} />
                <button className="primary" type="submit">Save</button>
                <button type="button" onClick={() => { setEditingNoticeDays(false); setNoticeDaysDraft(noticeDays); }}>Cancel</button>
              </form>
            ) : (
              <>
                {noticeDays} days
                {user?.role === 'super_admin' && <button style={{ marginLeft: 6 }} onClick={() => setEditingNoticeDays(true)}>Edit</button>}
              </>
            )}
          </div>
          {canManage && showExitForm && (
            <form onSubmit={submitExit} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <select value={exitForm.employee_id} onChange={(e) => setExitForm({ ...exitForm, employee_id: e.target.value })} required style={{ flex: '1 1 160px' }}>
                <option value="">Select employee</option>
                {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
              </select>
              <input type="date" value={exitForm.last_working_day} onChange={(e) => setExitForm({ ...exitForm, last_working_day: e.target.value })} required style={{ flex: '1 1 140px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.exits.length === 0 && <div className="empty">No employees currently exiting.</div>}
          {ov?.exits.map((x) => (
            <div key={x.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setExpandedExit(expandedExit === x.id ? null : x.id); }}>
                  {x.name}<div className="feature-meta">{x.department} · Last working day: {x.last_working_day} · Clearance: {x.clearance_current}/{x.clearance_total}</div>
                </a>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className="status-tag pending">{x.status}</span>
                  {x.notice_days_remaining != null && (
                    <span className="feature-meta" style={{ color: x.notice_days_remaining < 0 ? '#B3401E' : 'inherit' }}>
                      {x.notice_days_remaining < 0 ? `${-x.notice_days_remaining} day(s) overdue` : `${x.notice_days_remaining} day(s) on notice`}
                    </span>
                  )}
                </span>
              </div>
              {expandedExit === x.id && (
                <div style={{ marginTop: 8, paddingLeft: 8 }}>
                  <div className="feature-meta" style={{ marginBottom: 4 }}>Offboarding responsibilities:</div>
                  {x.tasks.map((t) => (
                    <label key={t.id} className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <input type="checkbox" checked={!!t.completed} disabled={!canManage} onChange={(e) => toggleOffboardingTask(x.id, t.id, e.target.checked)} style={{ width: 16, height: 16 }} />
                      <span style={{ textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? '#8A93A3' : 'inherit' }}>{t.task_name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card" id="section-vacancies">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">5</span>Department-wise Vacancies</div>
          {ov?.vacancies.length === 0 && <div className="empty">No headcount data yet.</div>}
          {ov?.vacancies.length > 0 && (
            <table>
              <thead><tr><th>Department</th><th>Current / Target</th><th>Vacancies</th></tr></thead>
              <tbody>{ov.vacancies.map((v) => (
                <tr key={v.department_id}>
                  <td>
                    {v.department}
                    {v.teams?.length > 0 && (
                      <div className="feature-meta">{v.teams.map((t) => `${t.name}: ${t.current}`).join(' · ')}</div>
                    )}
                  </td>
                  <td>{v.current} / {v.target}</td>
                  <td>
                    {v.vacancies}
                    <div style={{ height: 6, background: '#EEF0F3', borderRadius: 3, overflow: 'hidden', marginTop: 3 }}>
                      <div style={{ height: '100%', width: `${v.target > 0 ? Math.round((v.current / v.target) * 100) : 100}%`, background: v.vacancies > 0 ? '#B3401E' : '#1E8E5A' }} />
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">6</span>Key Features</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>Click a feature to jump to it.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button className="pill" onClick={() => scrollToSection('section-requisitions')}>Job Requisition Management</button>
            <button className="pill" onClick={() => setTab('pipeline')}>Candidate Pipeline &amp; Scheduling</button>
            <button className="pill" onClick={() => scrollToSection('section-rounds')}>Interview Rounds Configuration</button>
            <button className="pill" onClick={() => scrollToSection('section-onboarding')}>Onboarding Checklist</button>
            <button className="pill" onClick={() => scrollToSection('section-offboarding')}>Offboarding &amp; Clearance</button>
            <button className="pill" onClick={() => scrollToSection('section-vacancies')}>Department-wise Vacancies</button>
          </div>
        </div>

        {canRequest && (
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">7</span>Quick Actions</div>
            <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowReqForm(true); scrollToSection('section-requisitions'); }}>+ Add Requisition</button>
            {canManage && <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowRoundForm(true); scrollToSection('section-rounds'); }}>+ Interview Rounds</button>}
            {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
          </div>
        )}
      </div>
      </>
      )}

      {tab === 'pipeline' && (
        <CandidatePipelineTab
          ov={ov}
          canManage={canManage}
          candForm={candForm}
          setCandForm={setCandForm}
          submitCandidate={submitCandidate}
          showCandForm={showCandForm}
          setShowCandForm={setShowCandForm}
          advanceCandidate={advanceCandidate}
          revertCandidate={revertCandidate}
          filteredCandidates={filteredCandidates}
          pipelinePosition={pipelinePosition} setPipelinePosition={setPipelinePosition}
          pipelineDept={pipelineDept} setPipelineDept={setPipelineDept}
          pipelineStage={pipelineStage} setPipelineStage={setPipelineStage}
          pipelineSource={pipelineSource} setPipelineSource={setPipelineSource}
          pipelineDeptOptions={pipelineDeptOptions}
          pipelineStageOptions={pipelineStageOptions}
          exportCandidatesCsv={exportCandidatesCsv}
          showSourceForm={showSourceForm} setShowSourceForm={setShowSourceForm}
          newSourceLabel={newSourceLabel} setNewSourceLabel={setNewSourceLabel}
          addSource={addSource} toggleSource={toggleSource}
        />
      )}
    </div>
  );
}

// Candidate Pipeline as its own screen (not just a scrolled-to card) — filters (Position/
// Department/Stage/Source) live in the parent's state so they persist across candidate actions;
// moving someone to Hired reloads the list but never resets which position/stage you were
// looking at, since load() only replaces `ov`, not the filter state.
function CandidatePipelineTab({
  ov, canManage, candForm, setCandForm, submitCandidate, showCandForm, setShowCandForm, advanceCandidate, revertCandidate,
  filteredCandidates, pipelinePosition, setPipelinePosition, pipelineDept, setPipelineDept,
  pipelineStage, setPipelineStage, pipelineSource, setPipelineSource, pipelineDeptOptions, pipelineStageOptions,
  exportCandidatesCsv, showSourceForm, setShowSourceForm, newSourceLabel, setNewSourceLabel, addSource, toggleSource
}) {
  return (
    <div>
      <div className="filter-bar">
        <select value={pipelinePosition} onChange={(e) => setPipelinePosition(e.target.value)}>
          <option value="">All Positions</option>
          {(ov?.requisitions || []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <select value={pipelineDept} onChange={(e) => setPipelineDept(e.target.value)}>
          <option value="">All Departments</option>
          {pipelineDeptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={pipelineStage} onChange={(e) => setPipelineStage(e.target.value)}>
          <option value="">All Stages</option>
          {pipelineStageOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={pipelineSource} onChange={(e) => setPipelineSource(e.target.value)}>
          <option value="">All Sources</option>
          {(ov?.candidateSources || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="spacer" />
        <button className="primary" onClick={exportCandidatesCsv}>Export</button>
      </div>

      <div className="dashboard-grid">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name">Candidate Pipeline</div>
            {canManage && <button onClick={() => setShowCandForm((v) => !v)}>{showCandForm ? 'Cancel' : '+ Add Candidate'}</button>}
          </div>
          {canManage && showCandForm && (
            <form onSubmit={submitCandidate} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Candidate name" value={candForm.name} onChange={(e) => setCandForm({ ...candForm, name: e.target.value })} required style={{ flex: '1 1 140px' }} />
              <select value={candForm.position_id} onChange={(e) => setCandForm({ ...candForm, position_id: e.target.value })} style={{ flex: '1 1 140px' }}>
                <option value="">Applying for…</option>
                {ov?.requisitions.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
              <select value={candForm.source_id} onChange={(e) => setCandForm({ ...candForm, source_id: e.target.value })} style={{ flex: '1 1 140px' }}>
                <option value="">Source…</option>
                {(ov?.candidateSources || []).filter((s) => !s.paused).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <input placeholder="Panel / notes (optional)" value={candForm.panel} onChange={(e) => setCandForm({ ...candForm, panel: e.target.value })} style={{ flex: '1 1 120px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {filteredCandidates.length === 0 && <div className="empty">No candidates{ov?.candidates?.length ? ' match this filter.' : ' yet.'}</div>}
          {filteredCandidates.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{c.name}</strong>
                <span className="status-tag info">{c.stage || '—'}</span>
              </div>
              <div className="feature-meta">
                Applying for: {c.position_title || '—'}{c.position_department ? ` (${c.position_department})` : ''} · Source: {c.source_label || '—'}
                {c.referred_by_name ? ` — referred by ${c.referred_by_name}` : ''} · {c.feedback_status}
                {c.panel ? ` · ${c.panel}` : ''}
              </div>
              {canManage && (
                <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {c.next_stage && <button onClick={() => advanceCandidate(c.id)}>Move to {c.next_stage}</button>}
                  {c.prev_stage && <button onClick={() => revertCandidate(c.id)}>← Move back to {c.prev_stage}</button>}
                </span>
              )}
            </div>
          ))}
        </div>

        {canManage && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="feature-name">Candidate Sources</div>
              <button onClick={() => setShowSourceForm((v) => !v)}>{showSourceForm ? 'Cancel' : '+ Add'}</button>
            </div>
            <div className="feature-meta" style={{ marginBottom: 8 }}>Shown in the "Source" dropdown when adding a candidate, and as a filter above.</div>
            {showSourceForm && (
              <form onSubmit={addSource} className="row" style={{ marginBottom: 10 }}>
                <input placeholder="Source name (e.g. Instahyre)" value={newSourceLabel} onChange={(e) => setNewSourceLabel(e.target.value)} required style={{ flex: 1 }} />
                <button className="primary" type="submit">Add</button>
              </form>
            )}
            {(ov?.candidateSources || []).map((s) => (
              <div key={s.id} className="rec-row" style={{ opacity: s.paused ? 0.55 : 1 }}>
                <span>{s.label}{s.paused ? <span className="status-tag pending" style={{ marginLeft: 6 }}>Paused</span> : null}</span>
                {s.label !== 'Referral' && <button onClick={() => toggleSource(s)}>{s.paused ? 'Resume' : 'Pause'}</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

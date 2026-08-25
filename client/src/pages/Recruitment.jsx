import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Same base64-data-URL pattern already used for leave documents / expense receipts / employee
// document uploads.
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const esc = (v) => (v == null || v === '' ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

// Open a blank tab FIRST (synchronously, inside the click handler) so the browser's popup blocker
// still sees this as a direct user action — same pattern as Payroll's openPayslip.
function openOfferLetterDoc(candidateId) {
  const win = window.open('', '_blank');
  if (win) { win.document.write('<p style="font-family: sans-serif; padding: 24px;">Loading offer letter…</p>'); win.document.close(); }
  api.get(`/recruitment/candidates/${candidateId}/offer-letter`).then((r) => {
    if (!win) return;
    win.document.open();
    win.document.write(offerLetterHtml(r.data));
    win.document.close();
  }).catch((err) => { if (win) win.document.body.innerHTML = `<p style="font-family: sans-serif; padding: 24px;">${esc(err.response?.data?.error || 'Could not load this offer letter.')}</p>`; });
}

// A printable, letterheaded offer letter — same company-header layout (logo + name + address) and
// "Print / Save as PDF" toolbar convention as Payroll's payslip and Learning's certificate, so
// every printable document in this app looks and behaves consistently. No PDF library involved —
// relies on the browser's own print dialog.
function offerLetterHtml({ candidate, company }) {
  const todayStr = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
  const bodyHtml = esc(candidate.offer_letter_text).split(/\n\s*\n/).map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Offer Letter — ${esc(candidate.name)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 40px auto; max-width: 720px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  td { padding: 0; vertical-align: top; }
  .logo-cell { width: 220px; text-align: center; }
  .logo-cell img { max-width: 200px; max-height: 90px; object-fit: contain; }
  .company-cell { font-size: 13px; line-height: 1.5; text-align: right; }
  .company-name { font-weight: 700; font-size: 17px; margin-bottom: 4px; }
  .letter-title { text-align: center; font-weight: 700; font-size: 18px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 4px; border-bottom: 2px solid #333; padding-bottom: 14px; }
  .date-line { text-align: right; font-size: 13px; color: #444; margin: 14px 0 20px; }
  .letter-body p { font-size: 14px; line-height: 1.8; margin: 0 0 14px; text-align: justify; }
  .toolbar { text-align: right; margin-bottom: 12px; }
  .toolbar button { padding: 8px 16px; font-size: 13px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { margin: 0 auto; } }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <table>
    <tr>
      <td class="logo-cell">${company?.company_logo ? `<img src="${company.company_logo}" alt="logo">` : ''}</td>
      <td class="company-cell">
        <div class="company-name">${esc(company?.company_name) || 'Company'}</div>
        <div>${esc(company?.company_address).replace(/\n/g, '<br>')}</div>
      </td>
    </tr>
  </table>
  <div class="letter-title">Offer of Employment</div>
  <div class="date-line">${todayStr}</div>
  <div class="letter-body">${bodyHtml}</div>
</body></html>`;
}

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
  const [reqForm, setReqForm] = useState({
    department_id: '', title: '', target_headcount: 1,
    is_replacement: false, replacement_for: '', replacement_target_date: '',
    job_description: '', jd_date: ''
  });
  const [jdAiLoading, setJdAiLoading] = useState(false);
  const [jdPendingFor, setJdPendingFor] = useState(null); // requisition id whose JD is drafting in the background
  const [jdTimedOutFor, setJdTimedOutFor] = useState(null);
  const [jdRegeneratingFor, setJdRegeneratingFor] = useState(null);
  const [showCandForm, setShowCandForm] = useState(false);
  const [interviewMode, setInterviewMode] = useState('ai'); // 'ai' = AI generates the questions | 'custom' = HR supplies their own
  const [customQuestionsText, setCustomQuestionsText] = useState('');
  const [candForm, setCandForm] = useState({
    name: '', position_id: '', panel: '', source_id: '',
    email: '', phone: '', experience_years: '', current_ctc: '', expected_ctc: '', notice_period: '',
    linkedin_url: '', location: ''
  });
  const [candResume, setCandResume] = useState(null);
  const [messageFor, setMessageFor] = useState(null); // candidate id currently composing a Send Update message
  const [messageDraft, setMessageDraft] = useState({ channel: 'email', subject: '', message: '' });
  const [messageStatus, setMessageStatus] = useState('');
  const [interviewData, setInterviewData] = useState({}); // candidate id -> { interview } | { loading: true } | { error }
  const [selectedCandidateId, setSelectedCandidateId] = useState(null); // candidate id currently open in the detail view (list vs. detail split)
  const [offerLetterTimedOutFor, setOfferLetterTimedOutFor] = useState(null); // candidate id whose background offer-letter draft never landed within the poll window
  const [inviteStatus, setInviteStatus] = useState('');
  const navigate = useNavigate();
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
  const [interviewAccuracy, setInterviewAccuracy] = useState(null);

  function load() {
    api.get('/recruitment/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load recruitment overview.'));
  }
  function loadInterviewAccuracy() {
    api.get('/recruitment/interview-score-accuracy').then((r) => setInterviewAccuracy(r.data)).catch(() => {});
  }
  function loadNoticeDays() {
    api.get('/recruitment/notice-period').then((r) => { setNoticeDays(r.data.days); setNoticeDaysDraft(r.data.days); }).catch(() => {});
  }
  useEffect(load, []);
  useEffect(loadNoticeDays, []);
  useEffect(loadInterviewAccuracy, []);
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

  async function aiAssistJd() {
    setError('');
    if (!reqForm.title.trim()) { setError('Enter a position title first, then click AI Assist.'); return; }
    setJdAiLoading(true);
    try {
      const r = await api.post('/positions/ai-assist', { title: reqForm.title, department_id: reqForm.department_id });
      setReqForm((f) => ({ ...f, job_description: r.data.job_description || f.job_description }));
    } catch (err) { setError(err.response?.data?.error || 'AI Assist could not draft a job description.'); }
    finally { setJdAiLoading(false); }
  }
  async function submitRequisition(e) {
    e.preventDefault(); setError('');
    try {
      const r = await api.post('/positions', reqForm);
      setReqForm({ department_id: '', title: '', target_headcount: 1, is_replacement: false, replacement_for: '', replacement_target_date: '', job_description: '', jd_date: '' });
      setShowReqForm(false); load();
      // HR left the JD blank — it's drafting in the background (see positions.routes.js POST /),
      // same non-blocking pattern as the Offer Letter: requisition creation itself was instant,
      // poll a few times for the draft to land rather than making HR wait on it.
      if (r.data.jdPending) {
        const newId = r.data.position?.id;
        if (newId) { setJdTimedOutFor((v) => (v === newId ? null : v)); pollForJobDescription(newId); }
      }
    } catch (err) { setError(err.response?.data?.error || 'Could not create requisition.'); }
  }
  function pollForJobDescription(id, attempt = 0) {
    if (attempt >= 10) { setJdPendingFor((v) => (v === id ? null : v)); setJdTimedOutFor(id); return; }
    setJdPendingFor(id);
    setTimeout(() => {
      api.get('/recruitment/overview').then((r) => {
        setOv(r.data);
        const p = r.data.requisitions.find((x) => x.id === id);
        if (p?.job_description) setJdPendingFor((v) => (v === id ? null : v));
        else pollForJobDescription(id, attempt + 1);
      }).catch(() => {});
    }, 3000);
  }
  async function regenerateJobDescription(id) {
    setError(''); setJdRegeneratingFor(id);
    try {
      await api.post(`/positions/${id}/job-description/regenerate`);
      setJdTimedOutFor((v) => (v === id ? null : v));
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not regenerate the job description.'); }
    finally { setJdRegeneratingFor(null); }
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
    try {
      const resume = candResume ? await readFileAsDataUrl(candResume) : undefined;
      const customQuestions = interviewMode === 'custom'
        ? customQuestionsText.split('\n').map((q) => q.trim()).filter(Boolean)
        : undefined;
      if (interviewMode === 'custom' && (!customQuestions || customQuestions.length < 1)) {
        setError('Enter at least one interview question, or switch back to AI-generated.'); return;
      }
      await api.post('/recruitment/candidates', { ...candForm, resume_data_url: resume, resume_name: candResume?.name, interview_questions: customQuestions });
      setCandForm({ name: '', position_id: '', panel: '', source_id: '', email: '', phone: '', experience_years: '', current_ctc: '', expected_ctc: '', notice_period: '', linkedin_url: '', location: '' });
      setCandResume(null); setShowCandForm(false); setInterviewMode('ai'); setCustomQuestionsText(''); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add candidate.'); }
  }
  // Hired candidates go here rather than being auto-created — a real employee record needs
  // email/DOJ/bank/login details HR should fill in and review, so this just opens Employees'
  // Add Employee form pre-filled with what recruitment already knows (name + department). Not
  // "designation" — that field is actually the employee's system access role (Manager/TL/etc.),
  // not a free-text job title, so the position's title wouldn't be a valid value there.
  function convertToEmployee(c) {
    navigate('/employees', { state: { prefillEmployee: { name: c.name, department: c.position_department || '' } } });
  }
  function openMessageFor(c) {
    setMessageFor(c.id); setMessageStatus('');
    setMessageDraft({ channel: c.email ? 'email' : 'whatsapp', subject: `Update on your ${c.position_title || ''} application`, message: '' });
  }
  async function sendCandidateMessage(id) {
    setMessageStatus('Sending…');
    try {
      await api.post(`/recruitment/candidates/${id}/message`, messageDraft);
      setMessageStatus('Sent.'); setTimeout(() => { setMessageFor(null); setMessageStatus(''); }, 1200);
    } catch (err) { setMessageStatus(err.response?.data?.error || 'Could not send message.'); }
  }
  function loadInterviewData(id) {
    setInterviewData((d) => ({ ...d, [id]: { loading: true } }));
    api.get(`/recruitment/candidates/${id}/interview`)
      .then((r) => setInterviewData((d) => ({ ...d, [id]: { interview: r.data.interview } })))
      .catch((err) => setInterviewData((d) => ({ ...d, [id]: { error: err.response?.data?.error || 'Could not load interview.' } })));
  }
  function openCandidateDetail(id) {
    setSelectedCandidateId(id);
    setMessageFor(null); setInviteStatus('');
    if (!interviewData[id]) loadInterviewData(id);
  }
  async function sendInterviewInviteManually(id) {
    setInviteStatus('Sending…');
    try {
      await api.post(`/recruitment/candidates/${id}/send-interview-invite`);
      setInviteStatus('Invite queued — it can take a few moments to generate and send.');
      setTimeout(() => loadInterviewData(id), 4000);
    } catch (err) { setInviteStatus(err.response?.data?.error || 'Could not send invite.'); }
  }
  async function deleteAnswerVideo(candidateId, answerId) {
    try {
      await api.delete(`/recruitment/candidates/interview-answers/${answerId}/video`);
      loadInterviewData(candidateId);
    } catch (err) { setError(err.response?.data?.error || 'Could not delete video.'); }
  }
  async function advanceCandidate(id, body) {
    setError('');
    try {
      const r = await api.put(`/recruitment/candidates/${id}/advance`, body || {});
      load();
      // The stage move is already done by the time this responds — the AI letter drafts in the
      // background on the server, so poll a few times (rather than making HR wait on the request
      // itself) until it shows up, then stop.
      if (r.data.offerLetterPending) { setOfferLetterTimedOutFor((v) => (v === id ? null : v)); pollForOfferLetter(id); }
    } catch (err) { setError(err.response?.data?.error || 'Could not advance candidate.'); }
  }
  // Giving up after ~30s used to leave the "AI is drafting…" placeholder up forever with no
  // explanation — indistinguishable from it still working. Now it says so explicitly and points
  // at Regenerate, which still works as a manual retry.
  function pollForOfferLetter(id, attempt = 0) {
    if (attempt >= 10) { setOfferLetterTimedOutFor(id); return; }
    setTimeout(() => {
      api.get('/recruitment/overview').then((r) => {
        setOv(r.data);
        const c = r.data.candidates.find((x) => x.id === id);
        if (!c?.offer_letter_text) pollForOfferLetter(id, attempt + 1);
      }).catch(() => {});
    }, 3000);
  }
  async function revertCandidate(id) {
    setError('');
    try { await api.put(`/recruitment/candidates/${id}/revert`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not move candidate back.'); }
  }
  async function saveOfferLetter(id, offer_letter_text) {
    setError('');
    try { await api.put(`/recruitment/candidates/${id}/offer-letter`, { offer_letter_text }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save the offer letter.'); }
  }
  async function regenerateOfferLetter(id, offered_ctc, joining_date) {
    setError('');
    try {
      await api.post(`/recruitment/candidates/${id}/offer-letter/regenerate`, { offered_ctc, joining_date });
      setOfferLetterTimedOutFor((v) => (v === id ? null : v));
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not regenerate the offer letter.'); }
  }
  // The letter is only ever generated/edited automatically — actually emailing it to the
  // candidate is always this one explicit HR click, never automatic.
  async function sendOfferLetter(id) {
    setError('');
    try { await api.post(`/recruitment/candidates/${id}/offer-letter/send`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not send the offer letter.'); }
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
            <form onSubmit={submitRequisition} style={{ marginBottom: 12 }}>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <select value={reqForm.department_id} onChange={(e) => setReqForm({ ...reqForm, department_id: e.target.value })} required style={{ flex: '1 1 140px' }}>
                  <option value="">Select department</option>
                  {myDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <input placeholder="Position title" value={reqForm.title} onChange={(e) => setReqForm({ ...reqForm, title: e.target.value })} required style={{ flex: '1 1 160px' }} />
                <input type="number" min="1" value={reqForm.target_headcount} onChange={(e) => setReqForm({ ...reqForm, target_headcount: e.target.value })} style={{ flex: '0 1 90px' }} />
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                <label className="row" style={{ gap: 4, flex: '0 0 auto' }}>
                  <input type="checkbox" checked={reqForm.is_replacement} onChange={(e) => setReqForm({ ...reqForm, is_replacement: e.target.checked })} />
                  This is a replacement hire
                </label>
                {reqForm.is_replacement && (
                  <>
                    <input placeholder="Replacing (employee name)" value={reqForm.replacement_for} onChange={(e) => setReqForm({ ...reqForm, replacement_for: e.target.value })} required style={{ flex: '1 1 160px' }} />
                    <div style={{ flex: '0 1 170px' }}>
                      <label className="field-label" style={{ fontSize: 11 }}>Target completion date</label>
                      <input type="date" value={reqForm.replacement_target_date} onChange={(e) => setReqForm({ ...reqForm, replacement_target_date: e.target.value })} />
                    </div>
                  </>
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-start' }}>
                <textarea placeholder="Job description (optional — leave blank and AI will draft one automatically after you create this requisition)" value={reqForm.job_description} onChange={(e) => setReqForm({ ...reqForm, job_description: e.target.value })} rows={3} style={{ flex: '1 1 260px' }} />
                <div style={{ flex: '0 1 170px' }}>
                  <label className="field-label" style={{ fontSize: 11 }}>JD date</label>
                  <input type="date" value={reqForm.jd_date} onChange={(e) => setReqForm({ ...reqForm, jd_date: e.target.value })} />
                </div>
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" onClick={aiAssistJd} disabled={jdAiLoading} title="Draft a job description from the position title">
                  {jdAiLoading ? 'Thinking…' : '✨ AI Assist'}
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}><button className="primary" type="submit">Create</button></div>
            </form>
          )}
          {filteredRequisitions.length === 0 && <div className="empty">No requisitions{ov?.requisitions.length ? ' match this filter.' : ' yet.'}</div>}
          {filteredRequisitions.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{r.title}</strong>
                <span className="row" style={{ gap: 6 }}>
                  {!!r.is_replacement && <span className="status-tag pending">Replacement</span>}
                  <span className={'status-tag ' + (r.approval_status === 'Pending Approval' ? 'pending' : 'present')}>
                    {r.approval_status === 'Pending Approval' ? 'Pending Approval' : 'Approved — Posted'}
                  </span>
                </span>
              </div>
              <div className="feature-meta">{r.department_name} · {r.target_headcount} position(s){r.requested_by ? ` · requested by ${r.requested_by}` : ''}</div>
              {!!r.is_replacement && (
                <div className="feature-meta">Replacing: {r.replacement_for}{r.replacement_target_date ? ` · target completion ${r.replacement_target_date}` : ''}</div>
              )}
              {!r.job_description && jdPendingFor === r.id && (
                <div className="feature-meta">🤖 AI is drafting the job description in the background — this updates automatically once it's ready (usually under 30 seconds).</div>
              )}
              {!r.job_description && jdTimedOutFor === r.id && (
                <div className="feature-meta">
                  ⚠️ The draft didn't arrive — local AI may be unavailable right now (check the AI status indicator at the top of the page).
                  {canManage && <button style={{ marginLeft: 6 }} onClick={() => regenerateJobDescription(r.id)} disabled={jdRegeneratingFor === r.id}>{jdRegeneratingFor === r.id ? 'Trying…' : 'Try again'}</button>}
                </div>
              )}
              {r.job_description && (
                <div className="feature-meta">
                  JD{r.jd_date ? ` (${r.jd_date})` : ''}: {r.job_description}
                  {canManage && (
                    <button style={{ marginLeft: 6 }} onClick={() => regenerateJobDescription(r.id)} disabled={jdRegeneratingFor === r.id}>
                      {jdRegeneratingFor === r.id ? 'Regenerating…' : 'Regenerate'}
                    </button>
                  )}
                </div>
              )}
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

        {canManage && (
          <div className="card" id="section-interview-accuracy">
            <div className="feature-name" style={{ marginBottom: 4 }}>
              <span className="widget-badge">6</span>Interview Score Accuracy
            </div>
            <div className="feature-meta" style={{ marginBottom: 8 }}>
              Checks the AI video interview's eligibility call against what actually happened to the candidate afterward — a candidate reaching Hired, or stalling 30+ days at the same stage without moving. Still-in-progress candidates aren't judged yet.
            </div>
            {!interviewAccuracy && <div className="empty">Loading…</div>}
            {interviewAccuracy && interviewAccuracy.candidates.length === 0 && (
              <div className="empty">No completed AI video interviews yet.</div>
            )}
            {interviewAccuracy && interviewAccuracy.candidates.length > 0 && (
              <>
                <div className="row" style={{ gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span className="feature-meta">
                    <strong>{interviewAccuracy.summary.accuracyPct ?? '—'}{interviewAccuracy.summary.accuracyPct != null ? '%' : ''}</strong> agreement
                    {interviewAccuracy.summary.decided > 0 && ` (${interviewAccuracy.summary.matches}/${interviewAccuracy.summary.decided} decided cases)`}
                  </span>
                  {interviewAccuracy.summary.total - interviewAccuracy.summary.decided > 0 && (
                    <span className="feature-meta">{interviewAccuracy.summary.total - interviewAccuracy.summary.decided} still in progress — too early to judge</span>
                  )}
                </div>
                <table>
                  <thead><tr><th>Candidate</th><th>AI Score</th><th>AI Said</th><th>Actually Happened</th><th>Verdict</th></tr></thead>
                  <tbody>
                    {interviewAccuracy.candidates.map((c) => (
                      <tr key={c.candidateId}>
                        <td>{c.name}{c.position && <div className="feature-meta">{c.position}</div>}</td>
                        <td>{c.aiScore ?? '—'}</td>
                        <td>{c.aiEligible === null ? 'No usable score' : c.aiEligible ? 'Eligible' : 'Not eligible'}</td>
                        <td>{c.outcome}</td>
                        <td>
                          <span className={'status-tag ' + (c.verdict === 'match' ? 'present' : c.verdict === 'mismatch' ? 'absent' : 'pending')}>
                            {c.verdict === 'match' ? 'Matched' : c.verdict === 'mismatch' ? 'Mismatch' : 'Pending'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">7</span>Key Features</div>
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
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">8</span>Quick Actions</div>
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
          interviewMode={interviewMode} setInterviewMode={setInterviewMode}
          customQuestionsText={customQuestionsText} setCustomQuestionsText={setCustomQuestionsText}
          showCandForm={showCandForm}
          setShowCandForm={setShowCandForm}
          advanceCandidate={advanceCandidate}
          revertCandidate={revertCandidate}
          saveOfferLetter={saveOfferLetter}
          regenerateOfferLetter={regenerateOfferLetter}
          sendOfferLetter={sendOfferLetter}
          offerLetterTimedOut={offerLetterTimedOutFor === selectedCandidateId}
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
          candResume={candResume} setCandResume={setCandResume}
          convertToEmployee={convertToEmployee}
          messageFor={messageFor} messageDraft={messageDraft} setMessageDraft={setMessageDraft} messageStatus={messageStatus}
          openMessageFor={openMessageFor} sendCandidateMessage={sendCandidateMessage} setMessageFor={setMessageFor}
          interviewData={interviewData}
          selectedCandidateId={selectedCandidateId} openCandidateDetail={openCandidateDetail} closeCandidateDetail={() => setSelectedCandidateId(null)}
          sendInterviewInviteManually={sendInterviewInviteManually} inviteStatus={inviteStatus}
          deleteAnswerVideo={deleteAnswerVideo}
        />
      )}
    </div>
  );
}

// Resume screening badge — a plain 0-100 fit signal + proceed/review verdict, shown wherever a
// candidate's resume screening result needs to appear (compact row and detail view alike).
function ResumeScreenBadge({ c }) {
  if (c.resume_screen_score == null && !c.resume_screen_recommendation) return null;
  const isReview = c.resume_screen_recommendation === 'review';
  return (
    <span className={'status-tag ' + (isReview ? 'pending' : 'present')} title={c.resume_screen_summary || ''}>
      Resume screen{c.resume_screen_score != null ? `: ${c.resume_screen_score}/100` : ''}{isReview ? ' — needs review' : ''}
    </span>
  );
}

// One candidate's full profile, actions, and AI interview results — its own screen (not an
// inline-expanding list row) so a candidate with a completed interview (transcript + video per
// question) has room to breathe instead of stretching the whole list.
function CandidateDetail({
  c, canManage, onBack, advanceCandidate, revertCandidate, saveOfferLetter, regenerateOfferLetter, sendOfferLetter, offerLetterTimedOut, convertToEmployee,
  messageDraft, setMessageDraft, messageStatus, messageOpen, openMessage, closeMessage, sendCandidateMessage,
  interviewInfo, sendInterviewInviteManually, inviteStatus, deleteAnswerVideo
}) {
  const iv = interviewInfo?.interview;
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [offerForm, setOfferForm] = useState({ offered_ctc: c.offered_ctc || '', joining_date: c.joining_date || '' });
  const [offerBusy, setOfferBusy] = useState(false);
  const [letterDraft, setLetterDraft] = useState(c.offer_letter_text || '');
  const [editingLetter, setEditingLetter] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  async function confirmMoveToOffer() {
    if (!offerForm.offered_ctc.trim() || !offerForm.joining_date.trim()) return;
    setOfferBusy(true);
    // Advancing the stage itself is fast now — the AI letter drafts in the background after
    // this returns (see advanceCandidate's polling), so the form doesn't need to stay open/
    // disabled for the 10-30s the model actually takes.
    try { await advanceCandidate(c.id, offerForm); setShowOfferForm(false); }
    finally { setOfferBusy(false); }
  }
  async function handleRegenerate() {
    setOfferBusy(true);
    try { await regenerateOfferLetter(c.id, c.offered_ctc, c.joining_date); }
    finally { setOfferBusy(false); }
  }
  async function handleSendOfferLetter() {
    setSendBusy(true);
    try { await sendOfferLetter(c.id); }
    finally { setSendBusy(false); }
  }
  function downloadOfferLetter() {
    const blob = new Blob([c.offer_letter_text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `offer-letter-${c.name.replace(/\s+/g, '-')}.txt`; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="card">
      <button onClick={onBack} style={{ marginBottom: 10 }}>← Back to Candidate Pipeline</button>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 6 }}>
        <h1 style={{ margin: 0 }}>{c.name}</h1>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="status-tag info">{c.stage || '—'}</span>
          <ResumeScreenBadge c={c} />
        </span>
      </div>
      <div className="subtitle">
        Applying for: {c.position_title || '—'}{c.position_department ? ` (${c.position_department})` : ''} · Source: {c.source_label || '—'}
        {c.referred_by_name ? ` — referred by ${c.referred_by_name}` : ''} · {c.feedback_status}{c.panel ? ` · ${c.panel}` : ''}
      </div>

      <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
        <div className="feature-name" style={{ marginBottom: 6 }}>Profile</div>
        <div className="feature-meta">
          {c.email ? `✉ ${c.email}` : 'No email on file'}{c.phone ? ` · ☎ ${c.phone}` : ''}{c.location ? ` · ${c.location}` : ''}<br />
          {c.experience_years ? `${c.experience_years} yrs exp` : ''}{c.current_ctc ? ` · Current CTC ${c.current_ctc}` : ''}{c.expected_ctc ? ` · Expected ${c.expected_ctc}` : ''}{c.notice_period ? ` · Notice: ${c.notice_period}` : ''}
          {(c.linkedin_url || c.resume_data_url) && <br />}
          {c.linkedin_url ? <a href={c.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a> : ''}
          {c.linkedin_url && c.resume_data_url ? ' · ' : ''}
          {c.resume_data_url ? <a href={c.resume_data_url} download={c.resume_name || 'resume'} target="_blank" rel="noreferrer">📎 Resume</a> : ''}
        </div>
        {c.resume_screen_summary && <div className="feature-meta" style={{ marginTop: 6 }}>AI resume screen: {c.resume_screen_summary}</div>}
      </div>

      {canManage && (
        <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {c.next_stage && (
            <button onClick={() => (c.next_stage === 'Offer' ? setShowOfferForm((v) => !v) : advanceCandidate(c.id))}>
              {c.next_stage === 'Offer' && showOfferForm ? 'Cancel' : `Move to ${c.next_stage}`}
            </button>
          )}
          {c.prev_stage && <button onClick={() => revertCandidate(c.id)}>← Move back to {c.prev_stage}</button>}
          {(c.email || c.phone) && <button onClick={() => (messageOpen ? closeMessage() : openMessage())}>{messageOpen ? 'Cancel message' : 'Send Update'}</button>}
          {!!c.is_final && <button className="primary" onClick={() => convertToEmployee(c)}>Convert to Employee →</button>}
        </div>
      )}

      {showOfferForm && (
        <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
          <div className="feature-name" style={{ marginBottom: 6 }}>Move to Offer</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>Enter the real offered CTC and joining date — the AI offer letter is drafted from exactly these figures, nothing guessed.</div>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ flex: '1 1 160px' }}>
              <label className="field-label">Offered CTC *</label>
              <input placeholder="e.g. ₹12,00,000 per annum" value={offerForm.offered_ctc} onChange={(e) => setOfferForm({ ...offerForm, offered_ctc: e.target.value })} />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label className="field-label">Joining Date *</label>
              <input type="date" value={offerForm.joining_date} onChange={(e) => setOfferForm({ ...offerForm, joining_date: e.target.value })} />
            </div>
          </div>
          <button className="primary" onClick={confirmMoveToOffer} disabled={offerBusy || !offerForm.offered_ctc.trim() || !offerForm.joining_date.trim()}>
            {offerBusy ? 'Moving…' : 'Confirm & Generate Offer Letter'}
          </button>
        </div>
      )}

      {c.stage === 'Offer' && !c.offer_letter_text && !offerLetterTimedOut && (
        <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
          <div className="feature-name" style={{ marginBottom: 4 }}>Offer Letter</div>
          <div className="feature-meta">🤖 AI is drafting the offer letter in the background — this page updates automatically once it's ready (usually under 30 seconds).</div>
        </div>
      )}

      {c.stage === 'Offer' && !c.offer_letter_text && offerLetterTimedOut && (
        <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
          <div className="feature-name" style={{ marginBottom: 4 }}>Offer Letter</div>
          <div className="feature-meta">⚠️ The draft didn't arrive — local AI may be unavailable right now (check the AI status indicator at the top of the page).</div>
          {canManage && <button style={{ marginTop: 6 }} onClick={handleRegenerate} disabled={offerBusy}>{offerBusy ? 'Regenerating…' : 'Try again'}</button>}
        </div>
      )}

      {c.offer_letter_text && (
        <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap' }}>
            <div className="feature-name">Offer Letter</div>
            <span className="feature-meta">Offered {c.offered_ctc} · Joining {c.joining_date}</span>
          </div>
          {c.offer_letter_sent_at ? (
            <div className="feature-meta" style={{ marginBottom: 6 }}>✅ Emailed to the candidate on {c.offer_letter_sent_at.slice(0, 10)}</div>
          ) : (
            <div className="feature-meta" style={{ marginBottom: 6 }}>Not sent yet — the candidate has not been emailed this offer letter.</div>
          )}
          {editingLetter ? (
            <>
              <textarea value={letterDraft} onChange={(e) => setLetterDraft(e.target.value)} rows={12} style={{ width: '100%', fontFamily: 'inherit' }} />
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <button className="primary" onClick={async () => { await saveOfferLetter(c.id, letterDraft); setEditingLetter(false); }}>Save</button>
                <button onClick={() => { setLetterDraft(c.offer_letter_text); setEditingLetter(false); }}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{c.offer_letter_text}</div>
              {canManage && (
                <>
                  <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                    <button className="primary" onClick={handleSendOfferLetter} disabled={sendBusy || !c.email}>
                      {sendBusy ? 'Sending…' : c.offer_letter_sent_at ? '📧 Resend to Candidate' : '📧 Send to Candidate'}
                    </button>
                    <button onClick={() => openOfferLetterDoc(c.id)}>📄 View / Print Letter</button>
                    <button onClick={() => { setLetterDraft(c.offer_letter_text); setEditingLetter(true); }}>Edit</button>
                    <button onClick={handleRegenerate} disabled={offerBusy}>{offerBusy ? 'Regenerating…' : 'Regenerate'}</button>
                    <button onClick={downloadOfferLetter}>Download (.txt)</button>
                  </div>
                  {!c.email && <div className="feature-meta" style={{ marginTop: 4 }}>⚠️ No email on file for this candidate — add one to send the offer letter.</div>}
                </>
              )}
            </>
          )}
        </div>
      )}

      {messageOpen && (
        <div className="card" style={{ marginBottom: 12, background: '#F7F9FC' }}>
          <div className="feature-name" style={{ marginBottom: 6 }}>Send Update</div>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
            <select value={messageDraft.channel} onChange={(e) => setMessageDraft({ ...messageDraft, channel: e.target.value })} style={{ flex: '0 1 130px' }}>
              {c.email && <option value="email">Email</option>}
              {c.phone && <option value="whatsapp">WhatsApp</option>}
            </select>
            {messageDraft.channel === 'email' && <input placeholder="Subject" value={messageDraft.subject} onChange={(e) => setMessageDraft({ ...messageDraft, subject: e.target.value })} style={{ flex: '1 1 200px' }} />}
          </div>
          <textarea placeholder="Message" value={messageDraft.message} onChange={(e) => setMessageDraft({ ...messageDraft, message: e.target.value })} rows={2} style={{ width: '100%' }} />
          <div className="row" style={{ marginTop: 6, alignItems: 'center' }}>
            <button className="primary" onClick={() => sendCandidateMessage(c.id)} disabled={!messageDraft.message.trim()}>Send</button>
            {messageStatus && <span className="feature-meta">{messageStatus}</span>}
          </div>
        </div>
      )}

      <div className="card" style={{ background: '#F7F9FC' }}>
        <div className="feature-name" style={{ marginBottom: 6 }}>AI Video Interview</div>
        {interviewInfo?.loading && <div className="note">Loading…</div>}
        {interviewInfo?.error && <div className="note" style={{ color: '#B3401E' }}>{interviewInfo.error}</div>}
        {iv === null && (
          <div>
            <div className="note" style={{ marginBottom: 8 }}>
              {c.resume_screen_recommendation === 'review'
                ? 'Resume screening flagged this candidate for a human look before auto-inviting — review the resume above, then send the invite yourself if you\'d like to proceed.'
                : 'No AI interview has been created for this candidate yet (needs an email on file).'}
            </div>
            {canManage && c.email && (
              <button onClick={() => sendInterviewInviteManually(c.id)}>Send Interview Invite</button>
            )}
            {inviteStatus && <div className="feature-meta" style={{ marginTop: 6 }}>{inviteStatus}</div>}
          </div>
        )}
        {iv && (
          <div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
              <strong>{iv.status === 'completed' ? 'Completed' : iv.status === 'in_progress' ? `In progress (${iv.currentIndex}/${iv.totalQuestions})` : 'Invite sent, not started'}</strong>
              {iv.status === 'completed' && (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {iv.score != null && <span className="status-tag present">Overall: {iv.score}/100</span>}
                  {iv.communicationScore != null && <span className="status-tag info">Communication: {iv.communicationScore}/100</span>}
                  {iv.eligible != null && <span className={'status-tag ' + (iv.eligible ? 'present' : 'absent')}>{iv.eligible ? '✓ Eligible' : '✗ Not eligible'}</span>}
                </span>
              )}
            </div>
            {iv.status !== 'completed' && <div className="feature-meta" style={{ marginBottom: 6 }}>Interview link: <a href={iv.link} target="_blank" rel="noreferrer">{iv.link}</a></div>}
            {iv.summary && <div className="feature-meta" style={{ marginBottom: 8 }}>{iv.summary}</div>}
            {iv.answers?.length > 0 && iv.answers.map((a) => (
              <div key={a.question_index} style={{ marginBottom: 10 }}>
                <div className="feature-meta" style={{ fontWeight: 600 }}>Q{a.question_index + 1}: {a.question}</div>
                {a.video_data_url && (
                  <>
                    <video src={a.video_data_url} controls style={{ width: 240, borderRadius: 6, marginTop: 4, display: 'block' }} />
                    {canManage && (
                      <button
                        style={{ marginTop: 4 }}
                        onClick={() => { if (window.confirm('Delete this recorded video? The transcript and score are kept.')) deleteAnswerVideo(c.id, a.id); }}
                      >
                        🗑 Delete video
                      </button>
                    )}
                  </>
                )}
                {a.transcript && <div className="feature-meta" style={{ marginTop: 4 }}>Transcript: {a.transcript}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Candidate Pipeline as its own screen (not just a scrolled-to card) — filters (Position/
// Department/Stage/Source) live in the parent's state so they persist across candidate actions;
// moving someone to Hired reloads the list but never resets which position/stage you were
// looking at, since load() only replaces `ov`, not the filter state.
//
// Split into three separately-scoped pieces rather than one long card: "Add Candidate" (its own
// toggleable form), the candidate list (compact rows — click one to open its own detail screen
// with full profile/messaging/AI interview, instead of expanding two different panels inline),
// and "Candidate Sources" management, already its own card.
function CandidatePipelineTab({
  ov, canManage, candForm, setCandForm, submitCandidate, showCandForm, setShowCandForm, advanceCandidate, revertCandidate,
  saveOfferLetter, regenerateOfferLetter, sendOfferLetter, offerLetterTimedOut,
  filteredCandidates, pipelinePosition, setPipelinePosition, pipelineDept, setPipelineDept,
  pipelineStage, setPipelineStage, pipelineSource, setPipelineSource, pipelineDeptOptions, pipelineStageOptions,
  exportCandidatesCsv, showSourceForm, setShowSourceForm, newSourceLabel, setNewSourceLabel, addSource, toggleSource,
  candResume, setCandResume, convertToEmployee, messageFor, messageDraft, setMessageDraft, messageStatus, setMessageFor, openMessageFor, sendCandidateMessage,
  interviewData,
  interviewMode, setInterviewMode, customQuestionsText, setCustomQuestionsText,
  selectedCandidateId, openCandidateDetail, closeCandidateDetail, sendInterviewInviteManually, inviteStatus, deleteAnswerVideo
}) {
  const selected = selectedCandidateId ? (ov?.candidates || []).find((c) => c.id === selectedCandidateId) : null;
  if (selected) {
    return (
      <CandidateDetail
        c={selected}
        canManage={canManage}
        onBack={closeCandidateDetail}
        advanceCandidate={advanceCandidate}
        revertCandidate={revertCandidate}
        saveOfferLetter={saveOfferLetter}
        regenerateOfferLetter={regenerateOfferLetter}
        sendOfferLetter={sendOfferLetter}
        offerLetterTimedOut={offerLetterTimedOut}
        convertToEmployee={convertToEmployee}
        messageDraft={messageDraft} setMessageDraft={setMessageDraft} messageStatus={messageStatus}
        messageOpen={messageFor === selected.id} openMessage={() => openMessageFor(selected)} closeMessage={() => setMessageFor(null)}
        sendCandidateMessage={sendCandidateMessage}
        interviewInfo={interviewData[selected.id]}
        sendInterviewInviteManually={sendInterviewInviteManually}
        inviteStatus={inviteStatus}
        deleteAnswerVideo={deleteAnswerVideo}
      />
    );
  }

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

      {canManage && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: showCandForm ? 8 : 0 }}>
            <div className="feature-name">Add Candidate</div>
            <button onClick={() => setShowCandForm((v) => !v)}>{showCandForm ? 'Cancel' : '+ Add Candidate'}</button>
          </div>
          {showCandForm && (
            <form onSubmit={submitCandidate}>
              <div className="row" style={{ flexWrap: 'wrap' }}>
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
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <input type="email" placeholder="Email" value={candForm.email} onChange={(e) => setCandForm({ ...candForm, email: e.target.value })} style={{ flex: '1 1 160px' }} />
                <input placeholder="Phone" value={candForm.phone} onChange={(e) => setCandForm({ ...candForm, phone: e.target.value })} style={{ flex: '1 1 120px' }} />
                <input placeholder="Experience (yrs)" value={candForm.experience_years} onChange={(e) => setCandForm({ ...candForm, experience_years: e.target.value })} style={{ flex: '1 1 100px' }} />
                <input placeholder="Location" value={candForm.location} onChange={(e) => setCandForm({ ...candForm, location: e.target.value })} style={{ flex: '1 1 120px' }} />
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                <input placeholder="Current CTC" value={candForm.current_ctc} onChange={(e) => setCandForm({ ...candForm, current_ctc: e.target.value })} style={{ flex: '1 1 120px' }} />
                <input placeholder="Expected CTC" value={candForm.expected_ctc} onChange={(e) => setCandForm({ ...candForm, expected_ctc: e.target.value })} style={{ flex: '1 1 120px' }} />
                <input placeholder="Notice period" value={candForm.notice_period} onChange={(e) => setCandForm({ ...candForm, notice_period: e.target.value })} style={{ flex: '1 1 120px' }} />
                <input placeholder="LinkedIn URL" value={candForm.linkedin_url} onChange={(e) => setCandForm({ ...candForm, linkedin_url: e.target.value })} style={{ flex: '1 1 160px' }} />
              </div>
              <div style={{ marginTop: 10, padding: 10, background: '#F7F9FC', borderRadius: 8 }}>
                <div className="field-label" style={{ marginBottom: 6 }}>AI video interview questions</div>
                <label className="row" style={{ gap: 6, marginBottom: 4 }}>
                  <input type="radio" checked={interviewMode === 'ai'} onChange={() => setInterviewMode('ai')} />
                  Let AI generate them from the position's title/job description
                </label>
                <label className="row" style={{ gap: 6 }}>
                  <input type="radio" checked={interviewMode === 'custom'} onChange={() => setInterviewMode('custom')} />
                  I'll write my own questions
                </label>
                {interviewMode === 'custom' && (
                  <textarea
                    placeholder={'One question per line, e.g.\nTell me about yourself.\nDescribe a challenging project you led.'}
                    value={customQuestionsText}
                    onChange={(e) => setCustomQuestionsText(e.target.value)}
                    rows={4}
                    style={{ width: '100%', marginTop: 8 }}
                  />
                )}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                <label className="field-label" style={{ flex: '0 0 auto' }}>Resume <input type="file" accept=".pdf,.doc,.docx,image/*" onChange={(e) => setCandResume(e.target.files?.[0] || null)} /></label>
                <button className="primary" type="submit">Add</button>
              </div>
              <div className="note" style={{ marginTop: 6 }}>If a resume is attached, AI screens it first — a clear fit goes straight to the interview invite; anything unclear waits here for you to review and send manually.</div>
            </form>
          )}
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="feature-name" style={{ marginBottom: 8 }}>Candidates</div>
          {filteredCandidates.length === 0 && <div className="empty">No candidates{ov?.candidates?.length ? ' match this filter.' : ' yet.'}</div>}
          {filteredCandidates.map((c) => (
            <div key={c.id} className="rec-row" style={{ cursor: 'pointer', alignItems: 'flex-start' }} onClick={() => openCandidateDetail(c.id)}>
              <span>
                <strong>{c.name}</strong>
                <div className="feature-meta">
                  {c.position_title || '—'}{c.position_department ? ` (${c.position_department})` : ''} · {c.source_label || '—'}{c.email ? ` · ✉ ${c.email}` : ''}
                </div>
              </span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <ResumeScreenBadge c={c} />
                <span className="status-tag info">{c.stage || '—'}</span>
              </span>
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

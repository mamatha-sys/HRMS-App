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

// Non-HR roles (TL/STL/Employee) get a read-only vacancies view — recruitment itself is HR-run.
function BasicRecruitment() {
  const [vacancies, setVacancies] = useState([]);
  useEffect(() => { api.get('/positions/vacancies').then((r) => setVacancies(r.data.vacancies)).catch(() => {}); }, []);
  return (
    <div>
      <h1>Recruitment</h1>
      <div className="subtitle">Department-wise vacancies computed from real employee headcount and open positions.</div>
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Department-wise Vacancies</div>
        {vacancies.length === 0 && <div className="empty">No headcount data yet.</div>}
        {vacancies.map((v) => {
          const pct = v.target > 0 ? Math.round((v.current / v.target) * 100) : 100;
          return (
            <div key={v.department_id} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                <span><strong>{v.department}</strong> — {v.current} / {v.target}</span>
                <span style={{ color: v.vacancies > 0 ? '#B3401E' : '#1E8E5A' }}>{v.vacancies} vacancies</span>
              </div>
              <div style={{ height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: v.vacancies > 0 ? '#946E0A' : '#1E8E5A' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Recruitment() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRRecruitment /> : <BasicRecruitment />;
}

function HRRecruitment() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');

  const [showReqForm, setShowReqForm] = useState(false);
  const [reqForm, setReqForm] = useState({ department_id: '', title: '', target_headcount: 1 });
  const [showCandForm, setShowCandForm] = useState(false);
  const [candForm, setCandForm] = useState({ name: '', position_id: '', panel: '' });
  const [showHireForm, setShowHireForm] = useState(false);
  const [hireForm, setHireForm] = useState({ name: '', designation: '', department: '', start_date: '' });
  const [showExitForm, setShowExitForm] = useState(false);
  const [exitForm, setExitForm] = useState({ employee_id: '', last_working_day: '' });
  const [activeEmployees, setActiveEmployees] = useState([]);
  const [postingFor, setPostingFor] = useState(null);
  const [postingBoards, setPostingBoards] = useState('');
  const [expandedHire, setExpandedHire] = useState(null);
  const [expandedExit, setExpandedExit] = useState(null);

  const [showRoundForm, setShowRoundForm] = useState(false);
  const [newRoundName, setNewRoundName] = useState('');
  const [editingRound, setEditingRound] = useState(null);
  const [editRoundName, setEditRoundName] = useState('');

  function load() {
    api.get('/recruitment/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load recruitment overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  useEffect(() => { api.get('/employees').then((r) => setActiveEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);

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
    try { await api.put(`/positions/${id}/posting`, { posted_boards: postingBoards }); setPostingFor(null); setPostingBoards(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save posting.'); }
  }
  async function submitCandidate(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/candidates', candForm); setCandForm({ name: '', position_id: '', panel: '' }); setShowCandForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add candidate.'); }
  }
  async function advanceCandidate(id) {
    setError('');
    try { await api.put(`/recruitment/candidates/${id}/advance`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not advance candidate.'); }
  }
  async function submitHire(e) {
    e.preventDefault(); setError('');
    try { await api.post('/recruitment/new-hires', hireForm); setHireForm({ name: '', designation: '', department: '', start_date: '' }); setShowHireForm(false); load(); }
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
  async function saveRound(id) {
    setError('');
    try { await api.put(`/recruitment/interview-rounds/${id}`, { name: editRoundName }); setEditingRound(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save round.'); }
  }
  async function pauseRound(round) {
    setError('');
    try { await api.put(`/recruitment/interview-rounds/${round.id}/pause`, { paused: !round.paused }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update round.'); }
  }

  return (
    <div>
      <h1>Recruitment</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="filter-bar">
        <select disabled><option>All Departments</option></select>
        <select disabled><option>All Statuses</option></select>
        <div className="spacer" />
        <button className="primary">Export</button>
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
            <button onClick={() => setShowReqForm((v) => !v)}>{showReqForm ? 'Cancel' : '+ Add Requisition'}</button>
          </div>
          {showReqForm && (
            <form onSubmit={submitRequisition} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <select value={reqForm.department_id} onChange={(e) => setReqForm({ ...reqForm, department_id: e.target.value })} required style={{ flex: '1 1 140px' }}>
                <option value="">Select department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input placeholder="Position title" value={reqForm.title} onChange={(e) => setReqForm({ ...reqForm, title: e.target.value })} required style={{ flex: '1 1 160px' }} />
              <input type="number" min="1" value={reqForm.target_headcount} onChange={(e) => setReqForm({ ...reqForm, target_headcount: e.target.value })} style={{ flex: '0 1 90px' }} />
              <button className="primary" type="submit">Create</button>
            </form>
          )}
          {ov?.requisitions.length === 0 && <div className="empty">No requisitions yet.</div>}
          {ov?.requisitions.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{r.title}</strong>
                <span className={'status-tag ' + (r.approval_status === 'Pending Approval' ? 'pending' : 'present')}>
                  {r.approval_status === 'Pending Approval' ? 'Pending Approval' : 'Approved — Posted'}
                </span>
              </div>
              <div className="feature-meta">{r.department_name} · {r.target_headcount} position(s){r.requested_by ? ` · requested by ${r.requested_by}` : ''}</div>
              {r.approval_status === 'Approved' && r.posted_boards && <div className="feature-meta">Live on: {r.posted_boards}</div>}
              <div style={{ marginTop: 6 }}>
                {r.approval_status === 'Pending Approval' ? (
                  <>
                    <button className="btn-approve" onClick={() => decide(r.id, 'approve')}>Approve</button>
                    <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(r.id, 'reject')}>Reject</button>
                  </>
                ) : postingFor === r.id ? (
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <input placeholder="e.g. LinkedIn, Naukri" value={postingBoards} onChange={(e) => setPostingBoards(e.target.value)} style={{ flex: '1 1 160px' }} />
                    <button className="primary" onClick={() => savePosting(r.id)}>Save</button>
                    <button onClick={() => setPostingFor(null)}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => { setPostingFor(r.id); setPostingBoards(r.posted_boards || ''); }}>Manage Posting →</button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="card" id="section-pipeline">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">2</span>Candidate Pipeline</div>
            <button onClick={() => setShowCandForm((v) => !v)}>{showCandForm ? 'Cancel' : '+ Add Candidate'}</button>
          </div>
          {showCandForm && (
            <form onSubmit={submitCandidate} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Candidate name" value={candForm.name} onChange={(e) => setCandForm({ ...candForm, name: e.target.value })} required style={{ flex: '1 1 140px' }} />
              <select value={candForm.position_id} onChange={(e) => setCandForm({ ...candForm, position_id: e.target.value })} style={{ flex: '1 1 140px' }}>
                <option value="">Applying for…</option>
                {ov?.requisitions.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
              <input placeholder="Panel (optional)" value={candForm.panel} onChange={(e) => setCandForm({ ...candForm, panel: e.target.value })} style={{ flex: '1 1 120px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.candidates.length === 0 && <div className="empty">No candidates yet.</div>}
          {ov?.candidates.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{c.name}</strong>
                <span className="status-tag info">{c.stage || '—'}</span>
              </div>
              <div className="feature-meta">Applying for: {c.position_title || '—'} · Panel: {c.panel || '—'} · {c.feedback_status}</div>
              {c.next_stage && <button style={{ marginTop: 6 }} onClick={() => advanceCandidate(c.id)}>Move to {c.next_stage}</button>}
            </div>
          ))}
        </div>

        <div className="card" id="section-rounds">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">3</span>Interview Rounds</div>
            <button onClick={() => setShowRoundForm((v) => !v)}>{showRoundForm ? 'Cancel' : '+ Add Round'}</button>
          </div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>The candidate pipeline advances through these rounds, in order. Pause a round to skip it without losing history.</div>
          {showRoundForm && (
            <form onSubmit={addRound} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Round name (e.g. Culture Fit)" value={newRoundName} onChange={(e) => setNewRoundName(e.target.value)} required style={{ flex: '1 1 160px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.interviewRounds.map((r) => (
            <div key={r.id} className="rec-row" style={{ opacity: r.paused ? 0.55 : 1 }}>
              {editingRound === r.id ? (
                <span className="row" style={{ flex: 1, flexWrap: 'wrap' }}>
                  <input value={editRoundName} onChange={(e) => setEditRoundName(e.target.value)} style={{ flex: '1 1 140px' }} autoFocus />
                  <button className="primary" onClick={() => saveRound(r.id)}>Save</button>
                  <button onClick={() => setEditingRound(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  <span>{r.name}{r.is_final ? <span className="status-tag present" style={{ marginLeft: 6 }}>Final</span> : null}{r.paused ? <span className="status-tag pending" style={{ marginLeft: 6 }}>Paused</span> : null}</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setEditingRound(r.id); setEditRoundName(r.name); }}>Edit</button>
                    <button onClick={() => pauseRound(r)}>{r.paused ? 'Resume' : 'Pause'}</button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card" id="section-onboarding">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name" style={{ color: '#1E8E5A' }}><span className="widget-badge" style={{ background: '#1E8E5A' }}>4</span>Onboarding — New Hires</div>
            <button onClick={() => setShowHireForm((v) => !v)}>{showHireForm ? 'Cancel' : '+ Add New Hire'}</button>
          </div>
          {showHireForm && (
            <form onSubmit={submitHire} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Name" value={hireForm.name} onChange={(e) => setHireForm({ ...hireForm, name: e.target.value })} required style={{ flex: '1 1 120px' }} />
              <input placeholder="Designation" value={hireForm.designation} onChange={(e) => setHireForm({ ...hireForm, designation: e.target.value })} style={{ flex: '1 1 120px' }} />
              <select value={hireForm.department} onChange={(e) => setHireForm({ ...hireForm, department: e.target.value })} style={{ flex: '1 1 120px' }}>
                <option value="">Department</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
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
                      <input type="checkbox" checked={!!t.completed} onChange={(e) => toggleOnboardingTask(h.id, t.id, e.target.checked)} style={{ width: 16, height: 16 }} />
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
            <div className="feature-name" style={{ color: '#B3401E' }}><span className="widget-badge">5</span>Offboarding — Exiting Employees</div>
            <button onClick={() => setShowExitForm((v) => !v)}>{showExitForm ? 'Cancel' : '+ Add Exit'}</button>
          </div>
          {showExitForm && (
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
                <span className="status-tag pending">{x.status}</span>
              </div>
              {expandedExit === x.id && (
                <div style={{ marginTop: 8, paddingLeft: 8 }}>
                  <div className="feature-meta" style={{ marginBottom: 4 }}>Offboarding responsibilities:</div>
                  {x.tasks.map((t) => (
                    <label key={t.id} className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <input type="checkbox" checked={!!t.completed} onChange={(e) => toggleOffboardingTask(x.id, t.id, e.target.checked)} style={{ width: 16, height: 16 }} />
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
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">6</span>Department-wise Vacancies</div>
          {ov?.vacancies.length === 0 && <div className="empty">No headcount data yet.</div>}
          {ov?.vacancies.length > 0 && (
            <table>
              <thead><tr><th>Department</th><th>Current / Target</th><th>Vacancies</th></tr></thead>
              <tbody>{ov.vacancies.map((v) => (
                <tr key={v.department_id}>
                  <td>{v.department}</td><td>{v.current} / {v.target}</td>
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
          <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">7</span>Key Features</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>Click a feature to jump to it.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button className="pill" onClick={() => scrollToSection('section-requisitions')}>Job Requisition Management</button>
            <button className="pill" onClick={() => scrollToSection('section-pipeline')}>Candidate Pipeline &amp; Scheduling</button>
            <button className="pill" onClick={() => scrollToSection('section-rounds')}>Interview Rounds Configuration</button>
            <button className="pill" onClick={() => scrollToSection('section-onboarding')}>Onboarding Checklist</button>
            <button className="pill" onClick={() => scrollToSection('section-offboarding')}>Offboarding &amp; Clearance</button>
            <button className="pill" onClick={() => scrollToSection('section-vacancies')}>Department-wise Vacancies</button>
          </div>
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">8</span>Quick Actions</div>
          <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowReqForm(true); scrollToSection('section-requisitions'); }}>+ Add Requisition</button>
          <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowRoundForm(true); scrollToSection('section-rounds'); }}>+ Interview Rounds</button>
          {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
        </div>
      </div>
    </div>
  );
}

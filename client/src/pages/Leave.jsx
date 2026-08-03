import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own leave balance.
const FULL_HR_ROLES = ['super_admin'];
const SCOPED_ROLES = ['stl', 'tl'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own leave
// balance/apply (MyLeave) AND the dashboard/reports below it (company-wide for the first three,
// scoped to their assigned departments/teams for STL/TL), rather than one replacing the other.
const SELF_AND_TEAM_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
const tag = (s) => s === 'Approved' ? 'present' : s === 'Rejected' ? 'absent' : 'pending';

export default function Leave() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRLeave />;
  if (SELF_AND_TEAM_ROLES.includes(user?.role)) {
    const sectionLabel = SCOPED_ROLES.includes(user?.role) ? 'Team Leave' : 'Company Leave';
    return (<><MyLeave compact /><HRLeave compact sectionLabel={sectionLabel} /></>);
  }
  return <MyLeave />;
}

function MyLeave({ compact }) {
  const [leaves, setLeaves] = useState([]);
  const [balances, setBalances] = useState([]);
  const [history, setHistory] = useState([]);
  const [chainLabel, setChainLabel] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState({ leave_type_id: '', from_date: '', to_date: '', reason: '' });
  const [showForm, setShowForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  function load() {
    api.get('/leaves/mine').then((r) => {
      setLeaves(r.data.leaves);
      setBalances(r.data.balances || []);
      setHistory(r.data.history || []);
      setChainLabel(r.data.chainLabel || '');
      if (r.data.balances?.length && !form.leave_type_id) setForm((f) => ({ ...f, leave_type_id: r.data.balances[0].leave_type_id }));
    }).catch(() => setError('Could not load leaves.'));
  }
  useEffect(load, []);

  async function apply(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/leaves', form); setInfo('Leave applied.'); setForm({ ...form, from_date: '', to_date: '', reason: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not apply.'); }
  }
  async function requestCancel(id) {
    setError(''); setInfo('');
    try { await api.post(`/leaves/${id}/request-cancel`, { reason: 'Requested by employee' }); setInfo('Cancellation request sent to HR.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not request cancellation.'); }
  }
  async function withdrawCancel(id) {
    setError(''); setInfo('');
    try { await api.post(`/leaves/${id}/withdraw-cancel`); setInfo('Cancellation request withdrawn.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not withdraw.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Leave</div> : <h1>Leave Management</h1>}
      {!compact && <div className="subtitle">Apply for leave and track your balance and requests.</div>}
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {balances.length > 0 && (
        <div className="kpi-row">
          {balances.map((b) => (
            <div key={b.leave_type_id} className="kpi-card blue">
              <div className="kpi-label">{b.name}</div>
              <div className={'kpi-value' + (b.unpaid ? ' text' : '')}>{b.unpaid ? 'Unlimited' : b.balance}</div>
              {b.unpaid && <div className="feature-meta">{b.days_taken_ytd || 0} day(s) taken this year</div>}
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide balance history' : 'Balance history'}</button>
        <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Apply for leave'}</button>
      </div>

      {showHistory && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Leave balance history</div>
          {history.length === 0 && <div className="empty">No balance changes yet.</div>}
          {history.map((h) => (
            <div key={h.id} className="rec-row">
              <span>{h.leave_type} — {h.reason}<div className="feature-meta">{h.created_at}</div></span>
              <span style={{ fontWeight: 700, color: h.change < 0 ? '#B3401E' : '#1E8E5A' }}>{h.change > 0 ? '+' : ''}{h.change} (bal: {h.balance_after})</span>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="card">
          <form onSubmit={apply}>
            <div className="grid2">
              <div><label className="field-label">Type</label>
                <select value={form.leave_type_id} onChange={(e) => setForm({ ...form, leave_type_id: Number(e.target.value) })}>
                  {balances.map((b) => <option key={b.leave_type_id} value={b.leave_type_id}>{b.name}{b.unpaid ? ' (Unpaid)' : ''}</option>)}
                </select>
              </div>
              <div><label className="field-label">Reason</label><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
              <div><label className="field-label">From</label><input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} required /></div>
              <div><label className="field-label">To</label><input type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} required /></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><button className="primary" type="submit">Submit application</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My leave requests</div>
        {leaves.length === 0 && <div className="empty">No leave requests.</div>}
        {leaves.map((l) => (
          <div key={l.id} className="card" style={{ background: '#FBFCFE' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>{l.type} — {l.from_date} to {l.to_date} ({l.days}d){l.reason ? ` — ${l.reason}` : ''}</span>
              <span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}{l.cancel_requested ? ' · cancel pending' : ''}</span>
            </div>
            {l.status === 'Pending' && chainLabel && <ChainStepper chainLabel={chainLabel} currentStageName={l.current_stage_name} status={l.status} />}
            {l.status !== 'Pending' && l.decided_by_name && (
              <div className="feature-meta" style={{ marginBottom: 6 }}>
                {l.status} by {l.decided_by_name}
                {l.approval_reason_labels?.length ? ` — Reason: ${l.approval_reason_labels.join(', ')}` : ''}
              </div>
            )}
            {l.status === 'Approved' && !l.cancelled && !l.cancel_requested && (
              <button onClick={() => requestCancel(l.id)}>Request cancellation</button>
            )}
            {l.cancel_requested && !l.cancelled && (
              <button onClick={() => withdrawCancel(l.id)}>Withdraw cancellation request</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Approving a 4+ day leave request requires the approver to pick at least one reason from the
// Super-Admin-managed catalog — Super Admin itself is exempt (system administrator, not a
// workflow participant, mirrors the max_leave_approval_days exemption on the server). Owns its
// whole row (header line + reason panel) so the checkbox panel always drops to its own full-width
// line below the name/buttons instead of being squeezed into a narrow flex column beside them.
function ApproveControl({ leave, header, reasons, isSuperAdmin, onDecide, onError, onReject }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const needsReason = !isSuperAdmin && leave.days >= 4;
  const activeReasons = reasons.filter((r) => r.active);

  function toggle(id) { setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]); }
  function approveClick() { needsReason ? setOpen(true) : onDecide(leave.id, 'approve'); }
  async function confirm() {
    if (!selected.length) { onError('Select at least one reason before approving.'); return; }
    await onDecide(leave.id, 'approve', { reason_ids: selected });
    setOpen(false); setSelected([]);
  }

  return (
    <div style={{ width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap' }}>
        {header}
        {!open && (
          <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button className="btn-approve" onClick={approveClick}>Approve</button>
            <button className="btn-reject" onClick={onReject}>Reject</button>
          </span>
        )}
      </div>
      {open && (
        <div style={{ background: '#F4F7FB', border: '1px solid #EEF0F3', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div className="feature-meta" style={{ marginBottom: 8 }}>Reason for approving this {leave.days}-day request:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 10 }}>
            {activeReasons.map((r) => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                {r.label}
              </label>
            ))}
          </div>
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn-approve" onClick={confirm}>Confirm approve</button>
            <button onClick={() => setOpen(false)}>Cancel</button>
          </span>
        </div>
      )}
    </div>
  );
}

// Table-row equivalent of ApproveControl — a <tr> can't host a block-level dropped panel inline,
// so the reason checkboxes render as a second full-width (colSpan) row directly below instead.
function LeaveTableRow({ l, reasons, isSuperAdmin, onDecide, onError }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const needsReason = !isSuperAdmin && l.days >= 4;
  const activeReasons = reasons.filter((r) => r.active);

  function toggle(id) { setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]); }
  function approveClick() { needsReason ? setOpen(true) : onDecide(l.id, 'approve'); }
  async function confirm() {
    if (!selected.length) { onError('Select at least one reason before approving.'); return; }
    await onDecide(l.id, 'approve', { reason_ids: selected });
    setOpen(false); setSelected([]);
  }

  return (
    <>
      <tr>
        <td>{l.employee_name}</td><td>{l.team_name || '—'}</td><td>{l.type}</td><td>{l.from_date}</td><td>{l.to_date}</td><td>{l.days}</td>
        <td>
          <span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}</span>
          {l.status !== 'Pending' && l.decided_by_name && <div className="feature-meta">by {l.decided_by_name}</div>}
        </td>
        <td>{l.status === 'Pending' ? (
          !open && (
            <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
              <button className="btn-approve" onClick={approveClick}>Approve</button>
              <button className="btn-reject" onClick={() => onDecide(l.id, 'reject')}>Reject</button>
            </span>
          )
        ) : <span className="note">decided</span>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            <div style={{ background: '#F4F7FB', border: '1px solid #EEF0F3', borderRadius: 8, padding: 10, textAlign: 'left' }}>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Reason for approving this {l.days}-day request:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 10 }}>
                {activeReasons.map((r) => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                    <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                    {r.label}
                  </label>
                ))}
              </div>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn-approve" onClick={confirm}>Confirm approve</button>
                <button onClick={() => setOpen(false)}>Cancel</button>
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function HRLeave({ compact, sectionLabel }) {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [cancellations, setCancellations] = useState([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showAddType, setShowAddType] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [newType, setNewType] = useState({ name: '', code: '', annual_quota: '', unpaid: false });
  const [tab, setTab] = useState('dashboard'); // dashboard | reports
  const [departments, setDepartments] = useState([]);
  const [filterDept, setFilterDept] = useState('');
  const [filterType, setFilterType] = useState('');
  const [reasons, setReasons] = useState([]);
  const [showAddReason, setShowAddReason] = useState(false);
  const [newReason, setNewReason] = useState('');

  function load() {
    api.get('/leaves/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load leave overview.'));
    api.get('/leaves').then((r) => setLeaves(r.data.leaves)).catch(() => {});
    api.get('/leaves/cancellations').then((r) => setCancellations(r.data.cancellations)).catch(() => {});
  }
  function loadReasons() { api.get('/leaves/approval-reasons').then((r) => setReasons(r.data.reasons)).catch(() => {}); }
  useEffect(load, []);
  useEffect(loadReasons, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);

  async function decide(id, verb, body) {
    setError('');
    try { await api.post(`/leaves/${id}/${verb}`, body); load(); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function addReason(e) {
    e.preventDefault(); setError('');
    try { await api.post('/leaves/approval-reasons', { label: newReason }); setNewReason(''); setShowAddReason(false); loadReasons(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add reason.'); }
  }
  async function toggleReason(r) {
    setError('');
    try { await api.put(`/leaves/approval-reasons/${r.id}`, { active: !r.active }); loadReasons(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update reason.'); }
  }
  async function decideCancel(id, verb) {
    setError('');
    try { await api.post(`/leaves/cancellations/${id}/${verb}`); load(); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function addType(e) {
    e.preventDefault(); setError('');
    try { await api.post('/leaves/types', newType); setNewType({ name: '', code: '', annual_quota: '', unpaid: false }); setShowAddType(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add leave type.'); }
  }
  function startEditType(t) { setEditingType(t.id); setEditDraft({ name: t.name, annual_quota: t.annual_quota, unpaid: !!t.unpaid }); }
  async function saveType(id) {
    setError('');
    try { await api.put(`/leaves/types/${id}`, editDraft); setEditingType(null); load(); } catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function toggleType(t) {
    setError('');
    try { await api.put(`/leaves/types/${t.id}/pause`, { active: !t.active }); load(); } catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  const filteredLeaves = leaves.filter((l) =>
    (!filterDept || l.department === filterDept) && (!filterType || l.type === filterType)
  );
  const leaveTypeOptions = [...new Set(leaves.map((l) => l.type))].sort();

  async function exportCsv() {
    const lines = ['employee,type,from,to,days,status', ...filteredLeaves.map((l) => `${l.employee_name},${l.type},${l.from_date},${l.to_date},${l.days},${l.cancelled ? 'Cancelled' : l.status}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'leave-requests.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Team Leave'}</div> : <h1>Leave Management</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? <LeaveReports /> : (
        <>
          <div className="filter-bar">
            <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">Leave Type</option>
              {leaveTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="spacer" />
            <button className="primary" onClick={exportCsv}>Export</button>
          </div>

          {ov && (
            <div className="kpi-row">
              {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
            </div>
          )}

          <div className="dashboard-grid">
            {ov && (
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">1</span>Leave Approval Chain</div>
                <div className="feature-meta" style={{ marginBottom: 8 }}>{ov.chainLabel}</div>
                {ov.chainList.length === 0 && <div className="empty">No pending requests.</div>}
                {ov.chainList.map((l) => (
                  <div key={l.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
                    <ApproveControl
                      leave={l}
                      reasons={reasons}
                      isSuperAdmin={user?.role === 'super_admin'}
                      onDecide={decide}
                      onError={setError}
                      onReject={() => decide(l.id, 'reject')}
                      header={<span>{l.employee_name}{l.team_name && <span className="feature-meta"> ({l.team_name})</span>} — {l.type} ({l.days}d)</span>}
                    />
                    <ChainStepper chainLabel={ov.chainLabel} currentStageName={l.current_stage_name} status={l.status} />
                  </div>
                ))}
              </div>
            )}

            {ov && (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="feature-name"><span className="widget-badge">2</span>Leave Types &amp; Policy</div>
                  {user?.role === 'super_admin' && <button onClick={() => setShowAddType((v) => !v)}>{showAddType ? 'Cancel' : '+ Add'}</button>}
                </div>
                {showAddType && (
                  <form onSubmit={addType} className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
                    <input placeholder="Name" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} required style={{ flex: '2 1 140px' }} />
                    <input placeholder="Code" value={newType.code} onChange={(e) => setNewType({ ...newType, code: e.target.value })} required style={{ flex: '1 1 80px' }} />
                    {!newType.unpaid && <input placeholder="Days/yr" value={newType.annual_quota} onChange={(e) => setNewType({ ...newType, annual_quota: e.target.value })} style={{ flex: '1 1 80px' }} />}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, width: 'auto', flex: '0 0 auto' }}>
                      <input type="checkbox" checked={newType.unpaid} onChange={(e) => setNewType({ ...newType, unpaid: e.target.checked })} style={{ width: 16, height: 16 }} />
                      <span style={{ fontSize: 12.5 }}>Unpaid</span>
                    </label>
                    <button className="primary" type="submit">Add</button>
                  </form>
                )}
                {ov.leaveTypes.map((t) => (
                  <div key={t.id} className="rec-row" style={{ opacity: t.active ? 1 : 0.55 }}>
                    {editingType === t.id ? (
                      <>
                        <span className="row" style={{ marginBottom: 0, flex: 1, alignItems: 'center' }}>
                          <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} style={{ flex: 2 }} />
                          {!editDraft.unpaid && <input value={editDraft.annual_quota} onChange={(e) => setEditDraft({ ...editDraft, annual_quota: e.target.value })} style={{ flex: 1, width: 60 }} />}
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, width: 'auto' }}>
                            <input type="checkbox" checked={editDraft.unpaid} onChange={(e) => setEditDraft({ ...editDraft, unpaid: e.target.checked })} style={{ width: 15, height: 15 }} />
                            <span style={{ fontSize: 11.5 }}>Unpaid</span>
                          </label>
                        </span>
                        <span style={{ display: 'flex', gap: 6 }}>
                          <button className="primary" onClick={() => saveType(t.id)}>Save</button>
                          <button onClick={() => setEditingType(null)}>Cancel</button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span>{t.name} ({t.code}) {!t.active && <span className="status-tag pending">Paused</span>}</span>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className="feature-meta">{t.unpaid ? 'Unpaid' : `${t.annual_quota}/yr`}</span>
                          {user?.role === 'super_admin' && (
                            <>
                              <button onClick={() => startEditType(t)}>Edit</button>
                              <button onClick={() => toggleType(t)}>{t.active ? 'Pause' : 'Resume'}</button>
                            </>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {user?.role === 'super_admin' && (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div className="feature-name"><span className="widget-badge">3</span>Leave Approval Reasons</div>
                  <button onClick={() => setShowAddReason((v) => !v)}>{showAddReason ? 'Cancel' : '+ Add'}</button>
                </div>
                <div className="feature-meta" style={{ marginBottom: 8 }}>Shown as checkboxes when approving a leave request of 4+ days.</div>
                {showAddReason && (
                  <form onSubmit={addReason} className="row" style={{ marginBottom: 10 }}>
                    <input placeholder="Reason label" value={newReason} onChange={(e) => setNewReason(e.target.value)} required style={{ flex: 1 }} />
                    <button className="primary" type="submit">Add</button>
                  </form>
                )}
                {reasons.length === 0 && <div className="empty">No reasons yet.</div>}
                {reasons.map((r) => (
                  <div key={r.id} className="rec-row" style={{ opacity: r.active ? 1 : 0.55 }}>
                    <span>{r.label} {!r.active && <span className="status-tag pending">Paused</span>}</span>
                    <button onClick={() => toggleReason(r)}>{r.active ? 'Pause' : 'Resume'}</button>
                  </div>
                ))}
              </div>
            )}

            {ov && (
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">4</span>Employees on Leave — Department Wise</div>
                {ov.byDept.every((d) => d.people.length === 0) && <div className="empty">No one on leave today.</div>}
                {ov.byDept.map((d) => (
                  <div key={d.department} className="rec-row">
                    <span>{d.department}
                      {d.people.map((p, i) => <div key={i} className="feature-meta">{p.name}{p.team_name ? ` (${p.team_name})` : ''} — {p.type} ({p.from_date}–{p.to_date}){p.reason ? ` — ${p.reason}` : ''}</div>)}
                    </span>
                    <span className={'status-tag ' + (d.people.length > 0 ? 'pending' : 'present')}>{d.people.length} on leave</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {cancellations.length > 0 && (
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Cancellation Requests</div>
              {cancellations.map((c) => (
                <div key={c.id} className="rec-row">
                  <span>{c.employee_name}{c.team_name && <span className="feature-meta"> ({c.team_name})</span>} — {c.type} ({c.from_date} to {c.to_date}){c.reason ? `: ${c.reason}` : ''}</span>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn-approve" onClick={() => decideCancel(c.id, 'approve')}>Approve</button>
                    <button className="btn-reject" onClick={() => decideCancel(c.id, 'reject')}>Reject</button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="feature-name">All leave requests</div>
              <button onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide' : 'Show all'}</button>
            </div>
            {showAll && (
              filteredLeaves.length === 0 ? <div className="empty">No leave requests{leaves.length ? ' match this filter.' : '.'}</div> : (
                <table>
                  <thead><tr><th>Employee</th><th>Team</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{filteredLeaves.map((l) => (
                    <LeaveTableRow key={l.id} l={l} reasons={reasons} isSuperAdmin={user?.role === 'super_admin'} onDecide={decide} onError={setError} />
                  ))}</tbody>
                </table>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LeaveReports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/leaves/reports').then((r) => setData(r.data)).catch(() => setError('Could not load reports.')); }, []);

  async function exportCsv() {
    const res = await api.get('/leaves/reports/export', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = 'leave-balances.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      {error && <div className="banner error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}><button className="primary" onClick={exportCsv}>Export balances</button></div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Leave Balances <span className="note">(paused types are hidden)</span></div>
        {data && (
          <div className="matrix-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Department</th>{data.leaveTypes.map((t) => <th key={t.id}>{t.code}{t.unpaid ? ' (used)' : ''}</th>)}</tr></thead>
              <tbody>{data.balances.map((b) => (
                <tr key={b.employee_id}>
                  <td>{b.employee_code}</td><td>{b.name}</td><td>{b.department}</td>
                  {data.leaveTypes.map((t) => <td key={t.id}>{b.values[t.id]}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Leave History (all employees)</div>
        {data && data.history.length === 0 && <div className="empty">No history yet.</div>}
        {data && data.history.map((h) => (
          <div key={h.id} className="rec-row">
            <span>{h.employee_name} — {h.leave_type} — {h.reason}<div className="feature-meta">{h.created_at}</div></span>
            <span style={{ fontWeight: 700, color: h.change < 0 ? '#B3401E' : '#1E8E5A' }}>{h.change > 0 ? '+' : ''}{h.change} (bal: {h.balance_after})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

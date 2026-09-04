import { Fragment, useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';
import { SCOPED_ROLES } from '../roles.js';

// Same base64-data-URL pattern already used for expense receipts / helpdesk attachments.
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Super Admin is a pure system-administrator account — admin overview only, no own leave balance.
const FULL_HR_ROLES = ['super_admin'];

// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own leave
// balance/apply (MyLeave) AND the dashboard/reports below it (company-wide for the first three,
// scoped to their assigned departments/teams for STL/TL), rather than one replacing the other.
const SELF_AND_TEAM_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Below the very top of the approval chain — these roles can push a pending request straight to
// the next role up instead of deciding it themselves (e.g. it exceeds their own approval-days
// limit, or they'd rather a senior colleague weigh in). HR Admin/Super Admin sit at the top and
// have no one to reassign to.
const REASSIGN_ROLES = ['tl', 'stl', 'assistant_manager', 'manager'];
const tag = (s) => s === 'Approved' ? 'present' : s === 'Rejected' ? 'absent' : 'pending';

// Approval Suggestion: advisory context for whoever is deciding a pending request — this
// month's goal progress, this month's attendance, and leave days already taken this year
// (including this request). Never blocks or auto-decides anything, just surfaces the same
// signals a manager would informally check before approving.
function ApprovalSuggestion({ s }) {
  if (!s) return null;
  const isApprove = s.recommendation === 'Approve';
  return (
    <div className={'banner ' + (isApprove ? 'info' : 'error')} style={{ margin: '4px 0', padding: '6px 10px', fontSize: 12 }}>
      {isApprove ? '✅ Looks fine to approve' : '⚠️ Worth a second look'} — Targets {s.targetsScore != null ? `${s.targetsScore}%` : 'none this month'} · Attendance {s.attendanceScore}% · {s.leaveDaysYtd} leave day{s.leaveDaysYtd === 1 ? '' : 's'} this year
      {s.reasons.length > 0 && <div>{s.reasons.map((r) => `• ${r}`).join('  ')}</div>}
    </div>
  );
}

// Groups one leave type's ledger entries (each already tagged with the calendar month it belongs
// to via period_month) into a month-by-month table: what was earned, what was taken, and the
// balance standing at the end of that month — ascending so the balance rolls forward correctly.
function monthlyBreakdown(history, leaveTypeName) {
  const rows = history.filter((h) => h.leave_type === leaveTypeName)
    .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const byMonth = new Map();
  rows.forEach((h) => {
    const key = h.period_month || (h.created_at || '').slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { month: key, earned: 0, taken: 0, balance: h.balance_after });
    const m = byMonth.get(key);
    if (h.change > 0) m.earned += h.change; else m.taken += -h.change;
    m.balance = h.balance_after;
  });
  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}
function monthLabel(key) {
  const [y, m] = (key || '').split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return m ? names[Number(m) - 1] : key;
}
// The exact "Month / Leave Earned / Leave Taken / Balance" table, shared by both the employee's
// own view (MyLeave) and HR's per-employee "Employee View" (LeaveReports) — one leave type's
// monthly ledger, rendered identically wherever it's shown.
function MonthlyLedgerTable({ history, leaveTypeName }) {
  const rows = monthlyBreakdown(history, leaveTypeName);
  if (rows.length === 0) return <div className="empty">No accrual months recorded yet — check back after the first full month.</div>;
  return (
    <div className="matrix-wrap">
      <table>
        <thead><tr><th>Month</th><th>Leave Earned</th><th>Leave Taken</th><th>Balance</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <td>{monthLabel(r.month)}</td>
              <td style={{ color: '#1E8E5A' }}>{r.earned > 0 ? `+${r.earned}` : '—'}</td>
              <td>{r.taken}</td>
              <td style={{ fontWeight: 700 }}>{r.balance}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  const [form, setForm] = useState({ leave_type_id: '', from_date: '', to_date: '', reason: '', is_emergency: false, handover_to_employee_id: '', handover_notes: '' });
  const [document, setDocument] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [colleagues, setColleagues] = useState([]);
  const [handoverFor, setHandoverFor] = useState(null);
  const [handoverDraft, setHandoverDraft] = useState({ handover_to_employee_id: '', handover_notes: '' });
  const [handoverFile, setHandoverFile] = useState(null);
  const [handoverEditFile, setHandoverEditFile] = useState(null);

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
  // Scoped server-side to the requester's own department, plus (for Team Leads) every other
  // Team Lead — not the full company employee list, matching what the server will actually accept.
  useEffect(() => { api.get('/leaves/handover-candidates').then((r) => setColleagues(r.data.candidates)).catch(() => {}); }, []);

  async function apply(e) {
    e.preventDefault(); setError(''); setInfo('');
    try {
      const document_data_url = document ? await readFileAsDataUrl(document) : undefined;
      const handover_attachment_data_url = handoverFile ? await readFileAsDataUrl(handoverFile) : undefined;
      await api.post('/leaves', { ...form, document_data_url, document_name: document?.name, handover_attachment_data_url, handover_attachment_name: handoverFile?.name });
      setInfo('Leave applied.'); setForm({ ...form, from_date: '', to_date: '', reason: '', is_emergency: false, handover_to_employee_id: '', handover_notes: '' }); setDocument(null); setHandoverFile(null); setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not apply.'); }
  }
  async function saveHandover(id) {
    setError('');
    try {
      const handover_attachment_data_url = handoverEditFile ? await readFileAsDataUrl(handoverEditFile) : undefined;
      await api.put(`/leaves/${id}/handover`, { ...handoverDraft, handover_attachment_data_url, handover_attachment_name: handoverEditFile?.name });
      setHandoverFor(null); setHandoverEditFile(null); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not set handover.'); }
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
              <div className="kpi-label">{b.name}{b.carry_forward && <span className="status-tag present" style={{ marginLeft: 6 }}>Carries forward</span>}</div>
              <div className={'kpi-value' + (b.unpaid ? ' text' : '')}>{b.unpaid ? 'Unlimited' : b.balance}</div>
              {b.unpaid && <div className="feature-meta">{b.days_taken_ytd || 0} day(s) taken this year</div>}
              {b.monthly_accrual > 0 && (
                <div className="feature-meta">
                  Accrues {b.monthly_accrual}/month{b.carry_forward ? ', never expires' : ''} — available balance is this month's total, carried over from every unused month before it.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {balances.filter((b) => b.monthly_accrual > 0).map((b) => (
        <div key={b.leave_type_id} className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Monthly {b.name} balance</div>
          <MonthlyLedgerTable history={history} leaveTypeName={b.name} />
        </div>
      ))}

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
              <div>
                <label className="field-label">Supporting document <span className="note">(optional — e.g. medical certificate)</span></label>
                <input type="file" accept="image/*,application/pdf" onChange={(e) => setDocument(e.target.files?.[0] || null)} />
              </div>
              <div>
                <label className="field-label">Hand over work to <span className="note">(required before this can be approved — your department, or another Team Lead if you're one)</span></label>
                <select value={form.handover_to_employee_id} onChange={(e) => setForm({ ...form, handover_to_employee_id: e.target.value })}>
                  <option value="">Select colleague…</option>
                  {colleagues.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.employee_code}){c.department ? ` — ${c.department}` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Handover notes <span className="note">(optional)</span></label>
                <input placeholder="e.g. what to watch for while I'm out" value={form.handover_notes} onChange={(e) => setForm({ ...form, handover_notes: e.target.value })} />
              </div>
              <div>
                <label className="field-label">Handover file <span className="note">(optional — e.g. status notes, docs)</span></label>
                <input type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => setHandoverFile(e.target.files?.[0] || null)} />
              </div>
            </div>
            <label className="row" style={{ alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input type="checkbox" checked={form.is_emergency} onChange={(e) => setForm({ ...form, is_emergency: e.target.checked })} style={{ width: 16, height: 16 }} />
              <span>This is an emergency — let it through even if the team's concurrent-leave limit is full</span>
            </label>
            {form.is_emergency && <div className="feature-meta" style={{ marginBottom: 8 }}>A reason is required for emergency leave — HR is notified if this pushes your department over its usual limit.</div>}
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
              <span>
                {l.type} — {l.from_date} to {l.to_date} ({l.days}d){l.reason ? ` — ${l.reason}` : ''}
                {!!l.is_emergency && <span className="status-tag absent" style={{ marginLeft: 6 }}>Emergency</span>}
              </span>
              <span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}{l.cancel_requested ? ' · cancel pending' : ''}</span>
            </div>
            {l.document_data_url && (
              <a className="pill" href={l.document_data_url} download={l.document_name || 'document'} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginBottom: 6 }}>
                📎 {l.document_name || 'Attachment'}
              </a>
            )}
            <div className="feature-meta" style={{ marginBottom: 6 }}>
              {l.handover_to_name ? `Handover: ${l.handover_to_name}${l.handover_notes ? ` — ${l.handover_notes}` : ''}` : (
                l.status === 'Pending' ? <span style={{ color: '#B3401E' }}>No handover assigned yet — required before this can be approved.</span> : 'No handover was assigned.'
              )}
              {l.handover_attachment_data_url && (
                <a href={l.handover_attachment_data_url} download={l.handover_attachment_name || 'handover-file'} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>📎 {l.handover_attachment_name || 'Handover file'}</a>
              )}
              {l.status === 'Pending' && (
                <button style={{ marginLeft: 8 }} onClick={() => { setHandoverFor(l.id); setHandoverDraft({ handover_to_employee_id: l.handover_to_employee_id || '', handover_notes: l.handover_notes || '' }); setHandoverEditFile(null); }}>
                  {l.handover_to_name ? 'Change' : 'Set handover'}
                </button>
              )}
            </div>
            {handoverFor === l.id && (
              <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6, gap: 6, alignItems: 'center' }}>
                <select value={handoverDraft.handover_to_employee_id} onChange={(e) => setHandoverDraft({ ...handoverDraft, handover_to_employee_id: e.target.value })}>
                  <option value="">Select colleague…</option>
                  {colleagues.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.employee_code}){c.department ? ` — ${c.department}` : ''}</option>)}
                </select>
                <input placeholder="Notes (optional)" value={handoverDraft.handover_notes} onChange={(e) => setHandoverDraft({ ...handoverDraft, handover_notes: e.target.value })} style={{ flex: '1 1 160px' }} />
                <input type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => setHandoverEditFile(e.target.files?.[0] || null)} style={{ flex: '1 1 160px' }} />
                <button className="primary" onClick={() => saveHandover(l.id)} disabled={!handoverDraft.handover_to_employee_id}>Save</button>
                <button onClick={() => setHandoverFor(null)}>Cancel</button>
              </div>
            )}
            {l.status === 'Pending' && chainLabel && <ChainStepper chainLabel={chainLabel} currentStageName={l.current_stage_name} status={l.status} />}
            {l.status !== 'Pending' && l.decided_by_name && (
              <div className="feature-meta" style={{ marginBottom: 6 }}>
                {l.status} by {l.decided_by_name}
                {l.approval_reason_labels?.length ? ` — Reason: ${l.approval_reason_labels.join(', ')}` : ''}
                {l.decision_note?.trim() ? ` — Note: ${l.decision_note}` : ''}
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

// Approve/Reject/Reassign all open this same popup dialog to capture a reason before the action
// fires, instead of acting instantly or dropping an inline panel into the row: Approve keeps its
// existing 4+ day reason-catalog requirement (Super Admin exempt, mirrors the
// max_leave_approval_days exemption on the server), while Reject and Reassign — which never had
// any reason capture before — now always require a free-text one, since there's no catalog for
// either.
function DecisionModal({ leave, verb, reasons, isSuperAdmin, onConfirm, onCancel }) {
  const [selected, setSelected] = useState([]);
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const needsReasonCatalog = verb === 'approve' && !isSuperAdmin && leave.days >= 4;
  const noteRequired = verb !== 'approve';
  const activeReasons = reasons.filter((r) => r.active);

  function toggle(id) { setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]); }

  async function confirm() {
    setLocalError('');
    if (needsReasonCatalog && !selected.length) { setLocalError('Select at least one reason before approving.'); return; }
    if (noteRequired && !note.trim()) { setLocalError(`A reason is required to ${verb} this request.`); return; }
    setSubmitting(true);
    const body = { note: note.trim() || undefined };
    if (verb === 'approve' && selected.length) body.reason_ids = selected;
    const err = await onConfirm(body);
    setSubmitting(false);
    if (err) setLocalError(err);
  }

  const title = verb === 'approve' ? 'Approve leave request' : verb === 'reject' ? 'Reject leave request' : 'Reassign to next approver';
  const confirmLabel = submitting ? 'Saving…' : verb === 'approve' ? 'Confirm approve' : verb === 'reject' ? 'Confirm reject' : 'Confirm reassign';
  const confirmClass = verb === 'approve' ? 'btn-approve' : verb === 'reject' ? 'btn-reject' : '';
  const notePlaceholder = verb === 'approve' ? 'Any note for the record…' : verb === 'reject' ? 'Required — this is shown to the employee' : 'Required — kept on the record for whoever this goes to next';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(22,30,51,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onCancel}>
      <div className="card" style={{ width: 420, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="feature-name" style={{ marginBottom: 4 }}>{title}</div>
        <div className="feature-meta" style={{ marginBottom: 10 }}>{leave.employee_name} — {leave.type}, {leave.from_date} to {leave.to_date} ({leave.days}d)</div>
        {localError && <div className="banner error" style={{ marginBottom: 10 }}>{localError}</div>}
        {needsReasonCatalog && (
          <>
            <div className="feature-meta" style={{ marginBottom: 6 }}>Reason for approving this {leave.days}-day request:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 10 }}>
              {activeReasons.map((r) => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} />
                  {r.label}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="field-label" htmlFor="decision-note">{verb === 'approve' ? 'Note (optional)' : `Reason for ${verb === 'reject' ? 'rejecting' : 'reassigning'} *`}</label>
        <textarea
          id="decision-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={notePlaceholder}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13, padding: '8px 10px', borderRadius: 7, border: '1px solid #D7DBE2' }}
        />
        <div className="row" style={{ gap: 6, marginTop: 12, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={submitting}>Cancel</button>
          <button className={confirmClass} onClick={confirm} disabled={submitting}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ApproveControl({ leave, header, reasons, isSuperAdmin, canReassign, onDecide }) {
  const [modalVerb, setModalVerb] = useState(null); // null | 'approve' | 'reject' | 'reassign'

  return (
    <div style={{ width: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap' }}>
        {header}
        <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button className="btn-approve" onClick={() => setModalVerb('approve')}>Approve</button>
          <button className="btn-reject" onClick={() => setModalVerb('reject')}>Reject</button>
          {canReassign && <button onClick={() => setModalVerb('reassign')} title="Send this to the next role up without deciding it yourself">Reassign</button>}
        </span>
      </div>
      {modalVerb && (
        <DecisionModal
          leave={leave}
          verb={modalVerb}
          reasons={reasons}
          isSuperAdmin={isSuperAdmin}
          onCancel={() => setModalVerb(null)}
          onConfirm={async (body) => {
            const err = await onDecide(leave.id, modalVerb, body);
            if (!err) setModalVerb(null);
            return err;
          }}
        />
      )}
    </div>
  );
}

// Table-row equivalent of ApproveControl — a <tr> can't host a block-level dropped panel inline,
// so the reason checkboxes render as a second full-width (colSpan) row directly below instead.
function LeaveTableRow({ l, reasons, isSuperAdmin, canReassign, onDecide }) {
  const [modalVerb, setModalVerb] = useState(null); // null | 'approve' | 'reject' | 'reassign'

  return (
    <>
      <tr>
        <td>{l.employee_name}</td><td>{l.team_name || '—'}</td>
        <td>
          {l.type}{!!l.is_emergency && <span className="status-tag absent" style={{ marginLeft: 4 }}>Emergency</span>}{l.document_data_url && <a href={l.document_data_url} download={l.document_name || 'document'} target="_blank" rel="noreferrer" title={l.document_name || 'Attachment'} style={{ marginLeft: 4 }}>📎</a>}
          {l.status === 'Pending' && (l.handover_to_name ? <div className="feature-meta">Handover: {l.handover_to_name}</div> : <div className="feature-meta" style={{ color: '#B3401E' }}>No handover</div>)}
        </td>
        <td>{l.reason?.trim() || '—'}</td>
        <td>{l.from_date}</td><td>{l.to_date}</td><td>{l.days}</td>
        <td>
          <span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}</span>
          {l.status !== 'Pending' && l.decided_by_name && <div className="feature-meta">by {l.decided_by_name}</div>}
          {l.decision_note?.trim() && <div className="feature-meta">Note: {l.decision_note}</div>}
          {l.approvalSuggestion && (
            <div
              className="feature-meta"
              title={`Targets ${l.approvalSuggestion.targetsScore != null ? l.approvalSuggestion.targetsScore + '%' : 'none this month'} · Attendance ${l.approvalSuggestion.attendanceScore}% · ${l.approvalSuggestion.leaveDaysYtd} leave days this year${l.approvalSuggestion.reasons.length ? ' — ' + l.approvalSuggestion.reasons.join('; ') : ''}`}
            >
              {l.approvalSuggestion.recommendation === 'Approve' ? '✅ Good to approve' : '⚠️ Worth a look'}
            </div>
          )}
        </td>
        <td>{l.status === 'Pending' ? (
          <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            <button className="btn-approve" onClick={() => setModalVerb('approve')}>Approve</button>
            <button className="btn-reject" onClick={() => setModalVerb('reject')}>Reject</button>
            {canReassign && <button onClick={() => setModalVerb('reassign')} title="Send this to the next role up without deciding it yourself">Reassign</button>}
          </span>
        ) : <span className="note">decided</span>}</td>
      </tr>
      {modalVerb && (
        <DecisionModal
          leave={l}
          verb={modalVerb}
          reasons={reasons}
          isSuperAdmin={isSuperAdmin}
          onCancel={() => setModalVerb(null)}
          onConfirm={async (body) => {
            const err = await onDecide(l.id, modalVerb, body);
            if (!err) setModalVerb(null);
            return err;
          }}
        />
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
  const [limitPct, setLimitPct] = useState(null);
  const [limitDraft, setLimitDraft] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);
  const [maxCount, setMaxCount] = useState(null);
  const [maxCountDraft, setMaxCountDraft] = useState('');
  const [editingMaxCount, setEditingMaxCount] = useState(false);

  function load() {
    api.get('/leaves/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load leave overview.'));
    api.get('/leaves').then((r) => setLeaves(r.data.leaves)).catch(() => {});
    api.get('/leaves/cancellations').then((r) => setCancellations(r.data.cancellations)).catch(() => {});
  }
  function loadReasons() { api.get('/leaves/approval-reasons').then((r) => setReasons(r.data.reasons)).catch(() => {}); }
  useEffect(load, []);
  useEffect(loadReasons, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  useEffect(() => { api.get('/leaves/concurrent-limit').then((r) => setLimitPct(r.data.limitPct)).catch(() => {}); }, []);
  useEffect(() => { api.get('/leaves/concurrent-max-count').then((r) => setMaxCount(r.data.maxCount)).catch(() => {}); }, []);

  async function saveLimit() {
    setError('');
    const pct = parseInt(limitDraft, 10);
    try { await api.put('/leaves/concurrent-limit', { limitPct: pct }); setLimitPct(pct); setEditingLimit(false); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function saveMaxCount() {
    setError('');
    const n = parseInt(maxCountDraft, 10);
    try { await api.put('/leaves/concurrent-max-count', { maxCount: n }); setMaxCount(n); setEditingMaxCount(false); }
    catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }

  async function decide(id, verb, body) {
    setError('');
    try { await api.post(`/leaves/${id}/${verb}`, body); load(); return null; }
    catch (err) { const msg = err.response?.data?.error || 'Action failed.'; setError(msg); return msg; }
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
                      canReassign={REASSIGN_ROLES.includes(user?.role)}
                      onDecide={decide}
                      header={
                        <span>
                          <span>
                            {l.employee_name}{l.team_name && <span className="feature-meta"> ({l.team_name})</span>} — {l.type} ({l.days}d)
                            {!!l.is_emergency && <span className="status-tag absent" style={{ marginLeft: 6 }}>Emergency</span>}
                            {l.document_data_url && (
                              <a href={l.document_data_url} download={l.document_name || 'document'} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>📎 {l.document_name || 'Attachment'}</a>
                            )}
                          </span>
                          <div className="feature-meta">Reason: {l.reason?.trim() || '—'}</div>
                          <div className="feature-meta">
                            {l.handover_to_name ? `Handover: ${l.handover_to_name}` : <span style={{ color: '#B3401E', fontWeight: 600 }}>No handover assigned — cannot be approved yet.</span>}
                            {l.handover_attachment_data_url && (
                              <a href={l.handover_attachment_data_url} download={l.handover_attachment_name || 'handover-file'} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>📎 {l.handover_attachment_name || 'Handover file'}</a>
                            )}
                          </div>
                          {l.decision_note?.trim() && <div className="feature-meta">Note from a previous stage: {l.decision_note}</div>}
                          <ApprovalSuggestion s={l.approvalSuggestion} />
                        </span>
                      }
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
                        <span>
                          {t.name} ({t.code}) {!t.active && <span className="status-tag pending">Paused</span>}
                          {!!t.carry_forward && <span className="status-tag present" style={{ marginLeft: 4 }}>Carries forward</span>}
                        </span>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className="feature-meta">
                            {t.unpaid ? 'Unpaid' : t.monthly_accrual > 0 ? `${t.monthly_accrual}/month` : `${t.annual_quota}/yr`}
                          </span>
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

                <div className="rec-row" style={{ marginTop: 4, borderTop: '1px solid #EEF0F3', paddingTop: 10 }}>
                  <span>
                    Concurrent Leave Cap
                    <div className="feature-meta">Max % of a department that can be on leave for the same dates at once — blocks new applications past this.</div>
                  </span>
                  {editingLimit ? (
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="number" min="1" max="100" value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} style={{ width: 60 }} />
                      <span>%</span>
                      <button className="primary" onClick={saveLimit}>Save</button>
                      <button onClick={() => setEditingLimit(false)}>Cancel</button>
                    </span>
                  ) : (
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className="feature-meta" style={{ fontWeight: 700 }}>{limitPct ?? '—'}%</span>
                      {user?.role === 'super_admin' && <button onClick={() => { setLimitDraft(String(limitPct ?? '')); setEditingLimit(true); }}>Edit</button>}
                    </span>
                  )}
                </div>

                <div className="rec-row" style={{ borderTop: '1px solid #EEF0F3', paddingTop: 10 }}>
                  <span>
                    Concurrent Leave Cap — Flat Headcount
                    <div className="feature-meta">Absolute max people from one department on leave at once, regardless of department size — whichever cap (this or the % above) is stricter wins.</div>
                  </span>
                  {editingMaxCount ? (
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="number" min="1" value={maxCountDraft} onChange={(e) => setMaxCountDraft(e.target.value)} style={{ width: 60 }} />
                      <button className="primary" onClick={saveMaxCount}>Save</button>
                      <button onClick={() => setEditingMaxCount(false)}>Cancel</button>
                    </span>
                  ) : (
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className="feature-meta" style={{ fontWeight: 700 }}>{maxCount ?? '—'}</span>
                      {user?.role === 'super_admin' && <button onClick={() => { setMaxCountDraft(String(maxCount ?? '')); setEditingMaxCount(true); }}>Edit</button>}
                    </span>
                  )}
                </div>
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
                  <thead><tr><th>Employee</th><th>Team</th><th>Type</th><th>Reason</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{filteredLeaves.map((l) => (
                    <LeaveTableRow key={l.id} l={l} reasons={reasons} isSuperAdmin={user?.role === 'super_admin'} canReassign={REASSIGN_ROLES.includes(user?.role)} onDecide={decide} />
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
  const [employeeViewFor, setEmployeeViewFor] = useState(null); // employee_id currently expanded
  const [employeeViewHistory, setEmployeeViewHistory] = useState([]);
  useEffect(() => { api.get('/leaves/reports').then((r) => setData(r.data)).catch(() => setError('Could not load reports.')); }, []);

  async function exportCsv() {
    const res = await api.get('/leaves/reports/export', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = 'leave-balances.csv'; a.click(); URL.revokeObjectURL(url);
  }
  async function exportOneCsv(b) {
    const res = await api.get('/leaves/reports/export', { params: { id: b.employee_id }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `leave-balance-${b.employee_code || b.name}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  // Same Month/Leave Earned/Leave Taken/Balance ledger the employee sees on their own Leave page —
  // available here per-employee so HR can pull it up for anyone, not just each person for themselves.
  async function toggleEmployeeView(b) {
    if (employeeViewFor === b.employee_id) { setEmployeeViewFor(null); return; }
    setEmployeeViewFor(b.employee_id);
    try { const r = await api.get('/leaves/balance-history', { params: { employee_id: b.employee_id } }); setEmployeeViewHistory(r.data.history || []); }
    catch { setError('Could not load this employee\'s ledger.'); }
  }
  const monthlyAccrualTypes = (data?.leaveTypes || []).filter((t) => t.monthly_accrual > 0);

  return (
    <div>
      {error && <div className="banner error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}><button className="primary" onClick={exportCsv}>Export balances</button></div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Leave Balances <span className="note">(paused types are hidden)</span></div>
        {data && (
          <div className="matrix-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Department</th>{data.leaveTypes.map((t) => <th key={t.id}>{t.code}{t.unpaid ? ' (used)' : ''}</th>)}<th></th></tr></thead>
              <tbody>{data.balances.map((b) => (
                <Fragment key={b.employee_id}>
                  <tr>
                    <td>{b.employee_code}</td><td>{b.name}</td><td>{b.department}</td>
                    {data.leaveTypes.map((t) => <td key={t.id}>{b.values[t.id]}</td>)}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {monthlyAccrualTypes.length > 0 && (
                        <button onClick={() => toggleEmployeeView(b)}>{employeeViewFor === b.employee_id ? 'Hide' : 'Employee View'}</button>
                      )}{' '}
                      <button onClick={() => exportOneCsv(b)}>Export</button>
                    </td>
                  </tr>
                  {employeeViewFor === b.employee_id && (
                    <tr>
                      <td colSpan={4 + data.leaveTypes.length}>
                        <div className="feature-name" style={{ marginBottom: 8 }}>Employee View — {b.name}</div>
                        {monthlyAccrualTypes.map((t) => (
                          <div key={t.id} style={{ marginBottom: 10 }}>
                            {monthlyAccrualTypes.length > 1 && <div className="feature-meta" style={{ marginBottom: 4 }}>{t.name}</div>}
                            <MonthlyLedgerTable history={employeeViewHistory} leaveTypeName={t.name} />
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
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

import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';

// Super Admin is a pure system-administrator account — admin dashboard only, no own claims.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own claim
// submission/tracking (MyExpenses) AND the company-wide dashboard below it, rather than one
// replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL can view + approve claims for their assigned department/team, but
// marking a claim reimbursed ("Reimbursement Processing") is a finance/manage action reserved
// for these roles unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const STATUS_CLASS = { Pending: 'pending', Approved: 'present', Rejected: 'absent', Reimbursed: 'present' };
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Expenses() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRExpenses />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyExpenses compact /><HRExpenses compact sectionLabel="Company Expense Claims" /></>);
  return <MyExpenses />;
}

// One receipt's AI-check verdict, wherever it's shown — the submit form (before sending) and the
// HR queue (after). Kept as one component so the two can't drift into showing the check
// differently.
function ReceiptVerdict({ r }) {
  if (!r.aiChecked) return <span className="feature-meta">Not checked</span>;
  if (r.amountMatch == null && r.placeMatch == null) {
    return <span className="feature-meta" title={r.note}>{r.note || 'Nothing to check'}</span>;
  }
  const bad = r.amountMatch === false || r.placeMatch === false;
  return (
    <span className={'status-tag ' + (bad ? 'absent' : 'present')} title={r.note}>
      {r.amountMatch === true && '✓ Amount'}{r.amountMatch === false && '✗ Amount'}
      {r.placeMatch != null && (r.amountMatch != null ? ' · ' : '')}
      {r.placeMatch === true && '✓ Place'}{r.placeMatch === false && '✗ Place'}
    </span>
  );
}

// Employee self-service: submit and track expense/travel claims.
function MyExpenses({ compact }) {
  const [claims, setClaims] = useState([]);
  const [chainLabel, setChainLabel] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'Travel', amount: '', description: '', place: '', from_date: '', to_date: '' });
  const [receipts, setReceipts] = useState([]); // [{name, dataUrl, aiChecked, amountMatch, placeMatch, note}]
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  function load() { api.get('/expenses/my').then((r) => { setClaims(r.data.claims); setChainLabel(r.data.chainLabel); }).catch(() => {}); }
  useEffect(load, []);

  const isTravel = form.category === 'Travel';
  const days = form.from_date && form.to_date && form.to_date >= form.from_date
    ? Math.round((new Date(form.to_date) - new Date(form.from_date)) / 86400000) + 1
    : null;

  async function addReceipts(fileList) {
    setError('');
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) { setError(`"${file.name}" is too large (max 5 MB).`); continue; }
      const dataUrl = await readFileAsDataUrl(file);
      setReceipts((prev) => [...prev, { name: file.name, dataUrl, aiChecked: false, amountMatch: null, placeMatch: null, note: '' }]);
    }
  }
  function removeReceipt(i) { setReceipts((prev) => prev.filter((_, idx) => idx !== i)); }

  // Runs the OCR check against whatever amount/place are typed right now, for every attached
  // receipt — one button rather than per-file, since the amount typically applies to the whole
  // claim (a hotel bill and a cab receipt on the same Travel claim both get checked against the
  // same claimed amount and place).
  async function checkReceipts() {
    if (!form.amount || receipts.length === 0) return;
    setChecking(true); setError('');
    try {
      const results = await Promise.all(receipts.map((r) =>
        api.post('/expenses/verify-receipt', { amount: form.amount, place: form.place, dataUrl: r.dataUrl })
          .then((res) => ({ aiChecked: true, ...res.data }))
          .catch(() => ({ aiChecked: true, amountMatch: null, placeMatch: null, note: 'Could not run the check.' }))
      ));
      setReceipts((prev) => prev.map((r, i) => ({ ...r, ...results[i] })));
    } finally { setChecking(false); }
  }

  async function submit(e) {
    e.preventDefault(); setError(''); setWarning('');
    if (!form.amount || Number(form.amount) <= 0) { setError('A valid amount is required.'); return; }
    if (isTravel && !form.place.trim()) { setError('Place is required for a Travel claim.'); return; }
    if (isTravel && (!form.from_date || !form.to_date)) { setError('From and To dates are required for a Travel claim.'); return; }
    setSaving(true);
    try {
      const r = await api.post('/expenses', { ...form, receipts });
      if (r.data.duplicateWarning) setWarning(r.data.duplicateWarning);
      setForm({ category: 'Travel', amount: '', description: '', place: '', from_date: '', to_date: '' });
      setReceipts([]); setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit claim.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Expense Claims</div> : <h1>Expense &amp; Travel Claims</h1>}
      {!compact && <div className="subtitle">Submit a claim and track it through approval: {chainLabel}.</div>}
      {error && <div className="banner error">{error}</div>}
      {warning && <div className="banner info">⚠️ {warning}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {showForm ? (
          <form onSubmit={submit}>
            <label className="field-label">Category *</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ marginBottom: 10 }}>
              {['Travel', 'Food', 'Accommodation', 'Other'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="field-label">Amount (₹) *</label>
            <input type="number" min="1" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required style={{ marginBottom: 10 }} />
            <label className="field-label">Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ marginBottom: 10 }} />

            <label className="field-label">Place {isTravel && '*'}</label>
            <input value={form.place} placeholder="e.g. Bengaluru" onChange={(e) => setForm({ ...form, place: e.target.value })} required={isTravel} style={{ marginBottom: 10 }} />

            <div className="row" style={{ gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="field-label">From {isTravel && '*'}</label>
                <input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} required={isTravel} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="field-label">To {isTravel && '*'}</label>
                <input type="date" value={form.to_date} min={form.from_date || undefined} onChange={(e) => setForm({ ...form, to_date: e.target.value })} required={isTravel} />
              </div>
            </div>
            {days != null && <div className="feature-meta" style={{ marginTop: 4, marginBottom: 10 }}>{days} day{days === 1 ? '' : 's'}</div>}

            <label className="field-label" style={{ marginTop: 10 }}>Receipts / Bills</label>
            <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => { addReceipts(e.target.files); e.target.value = ''; }} style={{ marginBottom: 8 }} />
            {receipts.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {receipts.map((r, i) => (
                  <div key={i} className="row" style={{ alignItems: 'center', gap: 8, borderTop: '1px solid #EEF0F3', padding: '6px 0' }}>
                    <a href={r.dataUrl} target="_blank" rel="noreferrer" style={{ flex: 1 }}>{r.name}</a>
                    <ReceiptVerdict r={r} />
                    <button type="button" onClick={() => removeReceipt(i)} title="Remove">✕</button>
                  </div>
                ))}
                <button type="button" onClick={checkReceipts} disabled={checking || !form.amount} style={{ marginTop: 6 }}>
                  {checking ? 'Checking…' : '🔎 AI Check Receipts'}
                </button>
                <div className="feature-meta" style={{ marginTop: 4 }}>
                  Checks whether the claimed amount{form.place ? ' and place' : ''} actually appear on each receipt — a consistency check, not proof the receipt is genuine.
                </div>
              </div>
            )}

            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" type="submit" disabled={saving}>Submit Claim</button>
              <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="primary" onClick={() => setShowForm(true)}>+ Submit Claim</button>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My Claims</div>
        {claims.length === 0 && <div className="empty">No claims submitted yet.</div>}
        {claims.map((c) => (
          <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong>{c.category}</strong> — ₹{c.amount.toLocaleString('en-IN')}{c.description ? ` · ${c.description}` : ''}
                {c.place && <span className="feature-meta"> · {c.place}{c.days ? ` (${c.days} day${c.days === 1 ? '' : 's'})` : ''}</span>}
                {c.isDuplicateReceipt && <span className="status-tag absent" style={{ marginLeft: 6 }} title="One of these receipts matches another claim on file">⚠️ Duplicate receipt</span>}
              </span>
              <span className={'status-tag ' + (STATUS_CLASS[c.status] || 'info')}>{c.status}</span>
            </div>
            {c.receipts?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {c.receipts.map((r, i) => (
                  <div key={i} className="row" style={{ alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <a href={r.dataUrl} target="_blank" rel="noreferrer">{r.name}</a>
                    <ReceiptVerdict r={r} />
                    {r.isDuplicate && <span className="status-tag absent">duplicate</span>}
                  </div>
                ))}
              </div>
            )}
            {c.status === 'Pending' && <ChainStepper chainLabel={chainLabel} currentStageName={c.current_stage_name} status={c.status} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRExpenses({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [claims, setClaims] = useState(null);
  const [chainLabel, setChainLabel] = useState('');
  const [reports, setReports] = useState(null);
  const [screen, setScreen] = useState('queue');
  const [error, setError] = useState('');
  const [recheckingId, setRecheckingId] = useState(null);
  // Employee ID / Name / Department — same shape as the Payroll preview and Performance progress
  // table filters, narrowing what is displayed rather than what the server returns.
  const [filters, setFilters] = useState({ code: '', name: '', department: '' });

  function load() { api.get('/expenses').then((r) => { setClaims(r.data.claims); setChainLabel(r.data.chainLabel); }).catch(() => setError('Could not load claims.')); }
  useEffect(load, []);
  useEffect(() => { if (screen === 'reports') api.get('/expenses/reports').then((r) => setReports(r.data)).catch(() => {}); }, [screen]);

  async function decide(id, action) {
    setError('');
    try { await api.put(`/expenses/${id}/${action}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }
  async function reimburse(id) {
    setError('');
    try { await api.put(`/expenses/${id}/reimburse`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not mark reimbursed.'); }
  }
  // HR/finance re-checking one receipt already on file — the same live OCR check the employee
  // could have run at submission, available here too since nobody is forced to trust the
  // employee's own check before approving a payout.
  async function recheckReceipt(claim, receiptIndex) {
    setRecheckingId(`${claim.id}-${receiptIndex}`);
    try {
      const r = claim.receipts[receiptIndex];
      const res = await api.post('/expenses/verify-receipt', { amount: claim.amount, place: claim.place, dataUrl: r.dataUrl });
      setClaims((prev) => prev.map((c) => c.id !== claim.id ? c : {
        ...c, receipts: c.receipts.map((rr, i) => i !== receiptIndex ? rr : { ...rr, aiChecked: true, ...res.data })
      }));
    } catch { setError('Could not run the AI check.'); }
    finally { setRecheckingId(null); }
  }

  const departments = [...new Set((claims || []).map((c) => c.department).filter(Boolean))].sort();
  const filteredClaims = (claims || []).filter((c) =>
    (!filters.code || (c.employee_code || '').toLowerCase().includes(filters.code.trim().toLowerCase())) &&
    (!filters.name || (c.employee_name || '').toLowerCase().includes(filters.name.trim().toLowerCase())) &&
    (!filters.department || c.department === filters.department)
  );
  const anyFilter = filters.code || filters.name || filters.department;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Expense Claims'}</div> : <h1>Expense &amp; Travel Claims</h1>}
      {!compact && <div className="subtitle">Approval chain: {chainLabel}.</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={screen === 'queue' ? 'primary' : ''} onClick={() => setScreen('queue')}>Claims</button>
        <button className={screen === 'reports' ? 'primary' : ''} onClick={() => setScreen('reports')}>Reports</button>
      </div>

      {screen === 'reports' ? (
        <>
          {reports && (
            <div className="kpi-row">
              <div className="kpi-card blue"><div className="kpi-label">Total Claims</div><div className="kpi-value">{reports.totalClaims}</div></div>
              <div className="kpi-card gold"><div className="kpi-label">Pending Amount</div><div className="kpi-value text">₹{reports.totalPending.toLocaleString('en-IN')}</div></div>
              <div className="kpi-card green"><div className="kpi-label">Reimbursed</div><div className="kpi-value text">₹{reports.totalReimbursed.toLocaleString('en-IN')}</div></div>
            </div>
          )}
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>By Category</div>
            {!reports && <div className="empty">Loading…</div>}
            {reports && (
              <table>
                <thead><tr><th>Category</th><th>Count</th><th>Total Amount</th></tr></thead>
                <tbody>{reports.byCategory.map((c) => (
                  <tr key={c.category}><td>{c.category}</td><td>{c.count}</td><td>₹{c.totalAmount.toLocaleString('en-IN')}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="card">
          {!claims && <div className="empty">Loading…</div>}
          {claims && claims.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <input placeholder="Employee ID…" value={filters.code} onChange={(e) => setFilters({ ...filters, code: e.target.value })} style={{ flex: '1 1 120px', maxWidth: 180 }} />
              <input placeholder="Employee name…" value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} style={{ flex: '1 1 140px', maxWidth: 200 }} />
              <select value={filters.department} onChange={(e) => setFilters({ ...filters, department: e.target.value })} style={{ flex: '1 1 140px', maxWidth: 200 }}>
                <option value="">All Departments</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {anyFilter && <button onClick={() => setFilters({ code: '', name: '', department: '' })}>Clear</button>}
              <div className="spacer" />
              <span className="feature-meta">{filteredClaims.length} of {claims.length}</span>
            </div>
          )}
          {claims && claims.length === 0 && <div className="empty">No claims yet.</div>}
          {claims && claims.length > 0 && filteredClaims.length === 0 && <div className="empty">No claims match these filters.</div>}
          {filteredClaims.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <span>
                  <span className="feature-meta">Raised by </span>
                  <strong>{c.employee_name}</strong> <span className="feature-meta">({c.employee_code} · {c.department})</span>
                  <br />
                  {c.category} — ₹{c.amount.toLocaleString('en-IN')}{c.description ? ` · ${c.description}` : ''}
                  {c.place && <span className="feature-meta"> · {c.place}{c.days ? ` (${c.days} day${c.days === 1 ? '' : 's'})` : ''}</span>}
                </span>
                <span className={'status-tag ' + (STATUS_CLASS[c.status] || 'info')}>{c.status}</span>
              </div>
              {c.isDuplicateReceipt && (
                <div className="banner error" style={{ margin: '4px 0', padding: '4px 10px', fontSize: 12 }}>
                  ⚠️ Possible duplicate — a receipt on this claim matches another claim on file. Check before approving.
                </div>
              )}
              {c.receipts?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {c.receipts.map((r, i) => (
                    <div key={i} className="row" style={{ alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
                      <a className="pill" href={r.dataUrl} target="_blank" rel="noreferrer">📎 {r.name}</a>
                      <ReceiptVerdict r={r} />
                      {r.isDuplicate && <span className="status-tag absent">duplicate</span>}
                      <button onClick={() => recheckReceipt(c, i)} disabled={isRechecking(recheckingId, c.id, i)}>
                        {isRechecking(recheckingId, c.id, i) ? 'Checking…' : (r.aiChecked ? 'Re-check' : '🔎 AI Check')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {c.status === 'Pending' && (
                <>
                  <ChainStepper chainLabel={chainLabel} currentStageName={c.current_stage_name} status={c.status} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn-approve" onClick={() => decide(c.id, 'approve')}>Approve</button>
                    <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(c.id, 'reject')}>Reject</button>
                  </div>
                </>
              )}
              {c.status === 'Approved' && canManage && <button style={{ marginTop: 6 }} onClick={() => reimburse(c.id)}>Mark Reimbursed</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function isRechecking(recheckingId, claimId, receiptIndex) { return recheckingId === `${claimId}-${receiptIndex}`; }

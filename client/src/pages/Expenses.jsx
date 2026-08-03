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

// Employee self-service: submit and track expense/travel claims.
function MyExpenses({ compact }) {
  const [claims, setClaims] = useState([]);
  const [chainLabel, setChainLabel] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'Travel', amount: '', description: '' });
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);

  function load() { api.get('/expenses/my').then((r) => { setClaims(r.data.claims); setChainLabel(r.data.chainLabel); }).catch(() => {}); }
  useEffect(load, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.amount || Number(form.amount) <= 0) { setError('A valid amount is required.'); return; }
    setSaving(true);
    try {
      const receipt_data_url = receipt ? await readFileAsDataUrl(receipt) : null;
      await api.post('/expenses', { ...form, receipt_data_url });
      setForm({ category: 'Travel', amount: '', description: '' }); setReceipt(null); setShowForm(false); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit claim.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Expense Claims</div> : <h1>Expense &amp; Travel Claims</h1>}
      {!compact && <div className="subtitle">Submit a claim and track it through approval: {chainLabel}.</div>}
      {error && <div className="banner error">{error}</div>}

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
            <label className="field-label">Receipt (optional)</label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setReceipt(e.target.files?.[0] || null)} style={{ marginBottom: 10 }} />
            <div className="row">
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
              <span><strong>{c.category}</strong> — ₹{c.amount.toLocaleString('en-IN')}{c.description ? ` · ${c.description}` : ''}</span>
              <span className={'status-tag ' + (STATUS_CLASS[c.status] || 'info')}>{c.status}</span>
            </div>
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
          {claims && claims.length === 0 && <div className="empty">No claims yet.</div>}
          {claims && claims.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span><strong>{c.employee_name}</strong> ({c.employee_code}) · {c.category} — ₹{c.amount.toLocaleString('en-IN')}{c.description ? ` · ${c.description}` : ''}</span>
                <span className={'status-tag ' + (STATUS_CLASS[c.status] || 'info')}>{c.status}</span>
              </div>
              {c.receipt_data_url && <a className="pill" href={c.receipt_data_url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>View Receipt</a>}
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

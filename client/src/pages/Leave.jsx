import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const tag = (s) => s === 'Approved' ? 'present' : s === 'Rejected' ? 'absent' : 'pending';

export default function Leave() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRLeave /> : <MyLeave />;
}

// Visual horizontal stepper for the approval chain — TL -> STL -> AM -> Manager -> HR -> Super Admin.
function ChainStepper({ chainLabel, currentStageName, status }) {
  const steps = chainLabel.split(' → ');
  const currentIdx = status === 'Approved' ? steps.length : status === 'Rejected' ? -1 : steps.indexOf(currentStageName);
  return (
    <div className="chain-stepper">
      {steps.map((s, i) => {
        let cls = 'chain-step';
        if (status === 'Rejected') cls += ' rejected';
        else if (i < currentIdx || status === 'Approved') cls += ' done';
        else if (i === currentIdx) cls += ' current';
        return (
          <div key={s} className={cls}>
            <div className="chain-dot">{status === 'Rejected' ? '✕' : (i < currentIdx || status === 'Approved') ? '✓' : i + 1}</div>
            <div className="chain-label">{s}</div>
            {i < steps.length - 1 && <div className="chain-line" />}
          </div>
        );
      })}
    </div>
  );
}

function MyLeave() {
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState(null);
  const [history, setHistory] = useState([]);
  const [chainLabel, setChainLabel] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState({ type: 'Casual', from_date: '', to_date: '', reason: '' });
  const [showForm, setShowForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  function load() {
    api.get('/leaves').then((r) => { setLeaves(r.data.leaves); if (r.data.balance) setBalance(r.data.balance); }).catch(() => setError('Could not load leaves.'));
    api.get('/leaves/balance-history').then((r) => setHistory(r.data.history)).catch(() => {});
  }
  useEffect(load, []);
  useEffect(() => { api.get('/leaves/overview').then((r) => setChainLabel(r.data.chainLabel)).catch(() => {}); }, []);

  async function apply(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/leaves', form); setInfo('Leave applied.'); setForm({ type: 'Casual', from_date: '', to_date: '', reason: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not apply.'); }
  }
  async function requestCancel(id) {
    setError(''); setInfo('');
    try { await api.post(`/leaves/${id}/request-cancel`, { reason: 'Requested by employee' }); setInfo('Cancellation request sent to HR.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not request cancellation.'); }
  }

  return (
    <div>
      <h1>Leave Management</h1>
      <div className="subtitle">Apply for leave and track your balance and requests.</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {balance && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Casual left</div><div className="kpi-value">{balance.casual}</div></div>
          <div className="kpi-card green"><div className="kpi-label">Sick left</div><div className="kpi-value">{balance.sick}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Earned left</div><div className="kpi-value">{balance.earned}</div></div>
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
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option>Casual</option><option>Sick</option><option>Earned</option></select>
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
              <span>{l.type} Leave — {l.from_date} to {l.to_date} ({l.days}d){l.reason ? ` — ${l.reason}` : ''}</span>
              <span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}{l.cancel_requested ? ' · cancel pending' : ''}</span>
            </div>
            {l.status === 'Pending' && chainLabel && <ChainStepper chainLabel={chainLabel} currentStageName={l.current_stage_name} status={l.status} />}
            {l.status === 'Approved' && !l.cancelled && !l.cancel_requested && (
              <button onClick={() => requestCancel(l.id)}>Request cancellation</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HRLeave() {
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

  function load() {
    api.get('/leaves/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load leave overview.'));
    api.get('/leaves').then((r) => setLeaves(r.data.leaves)).catch(() => {});
    api.get('/leaves/cancellations').then((r) => setCancellations(r.data.cancellations)).catch(() => {});
  }
  useEffect(load, []);

  async function decide(id, verb) {
    setError('');
    try { await api.post(`/leaves/${id}/${verb}`); load(); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
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
  function startEditType(t) { setEditingType(t.id); setEditDraft({ name: t.name, annual_quota: t.annual_quota }); }
  async function saveType(id) {
    setError('');
    try { await api.put(`/leaves/types/${id}`, editDraft); setEditingType(null); load(); } catch (err) { setError(err.response?.data?.error || 'Could not save.'); }
  }
  async function toggleType(t) {
    setError('');
    try { await api.put(`/leaves/types/${t.id}/pause`, { active: !t.active }); load(); } catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function exportCsv() {
    const lines = ['employee,type,from,to,days,status', ...leaves.map((l) => `${l.employee_name},${l.type},${l.from_date},${l.to_date},${l.days},${l.cancelled ? 'Cancelled' : l.status}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'leave-requests.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Leave Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? <LeaveReports /> : (
        <>
          <div className="filter-bar">
            <select disabled><option>All Departments</option></select>
            <select disabled><option>Leave Type</option></select>
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
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                      <span>{l.employee_name} — {l.type} Leave</span>
                      <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button className="btn-approve" onClick={() => decide(l.id, 'approve')}>Approve</button>
                        <button className="btn-reject" onClick={() => decide(l.id, 'reject')}>Reject</button>
                      </span>
                    </div>
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
                    <input placeholder="Days/yr" value={newType.annual_quota} onChange={(e) => setNewType({ ...newType, annual_quota: e.target.value })} style={{ flex: '1 1 80px' }} />
                    <button className="primary" type="submit">Add</button>
                  </form>
                )}
                {ov.leaveTypes.map((t) => (
                  <div key={t.id} className="rec-row" style={{ opacity: t.active ? 1 : 0.55 }}>
                    {editingType === t.id ? (
                      <>
                        <span className="row" style={{ marginBottom: 0, flex: 1 }}>
                          <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} style={{ flex: 2 }} />
                          <input value={editDraft.annual_quota} onChange={(e) => setEditDraft({ ...editDraft, annual_quota: e.target.value })} style={{ flex: 1, width: 60 }} />
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

            {ov && (
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Employees on Leave — Department Wise</div>
                {ov.byDept.every((d) => d.people.length === 0) && <div className="empty">No one on leave today.</div>}
                {ov.byDept.map((d) => (
                  <div key={d.department} className="rec-row">
                    <span>{d.department}
                      {d.people.map((p, i) => <div key={i} className="feature-meta">{p.name} — {p.type} Leave ({p.from_date}–{p.to_date}){p.reason ? ` — ${p.reason}` : ''}</div>)}
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
                  <span>{c.employee_name} — {c.type} Leave ({c.from_date} to {c.to_date}){c.reason ? `: ${c.reason}` : ''}</span>
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
              leaves.length === 0 ? <div className="empty">No leave requests.</div> : (
                <table>
                  <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{leaves.map((l) => (
                    <tr key={l.id}>
                      <td>{l.employee_name}</td><td>{l.type}</td><td>{l.from_date}</td><td>{l.to_date}</td><td>{l.days}</td>
                      <td><span className={'status-tag ' + tag(l.status)}>{l.cancelled ? 'Cancelled' : l.status}</span></td>
                      <td>{l.status === 'Pending' ? (
                        <>
                          <button className="btn-approve" onClick={() => decide(l.id, 'approve')}>Approve</button>
                          <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(l.id, 'reject')}>Reject</button>
                        </>
                      ) : <span className="note">decided</span>}</td>
                    </tr>
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
        <div className="feature-name" style={{ marginBottom: 8 }}>Leave Balances</div>
        {data && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Casual</th><th>Sick</th><th>Earned</th></tr></thead>
            <tbody>{data.balances.map((b) => (
              <tr key={b.employee_id}><td>{b.employee_code}</td><td>{b.name}</td><td>{b.department}</td><td>{b.casual ?? '—'}</td><td>{b.sick ?? '—'}</td><td>{b.earned ?? '—'}</td></tr>
            ))}</tbody>
          </table>
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

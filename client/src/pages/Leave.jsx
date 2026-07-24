import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const tag = (s) => s === 'Approved' ? 'present' : s === 'Rejected' ? 'absent' : 'pending';

export default function Leave() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRLeave /> : <MyLeave />;
}

function MyLeave() {
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState({ type: 'Casual', from_date: '', to_date: '', reason: '' });
  const [showForm, setShowForm] = useState(false);

  function load() { api.get('/leaves').then((r) => { setLeaves(r.data.leaves); if (r.data.balance) setBalance(r.data.balance); }).catch(() => setError('Could not load leaves.')); }
  useEffect(load, []);

  async function apply(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/leaves', form); setInfo('Leave applied.'); setForm({ type: 'Casual', from_date: '', to_date: '', reason: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not apply.'); }
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
        <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Apply for leave'}</button>
      </div>

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
        {leaves.length > 0 && (
          <table>
            <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>{leaves.map((l) => (
              <tr key={l.id}><td>{l.type}</td><td>{l.from_date}</td><td>{l.to_date}</td><td>{l.days}</td><td>{l.reason || '—'}</td><td><span className={'status-tag ' + tag(l.status)}>{l.status}</span></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HRLeave() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showAddType, setShowAddType] = useState(false);
  const [newType, setNewType] = useState({ name: '', code: '', annual_quota: '', unpaid: false });

  function load() {
    api.get('/leaves/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load leave overview.'));
    api.get('/leaves').then((r) => setLeaves(r.data.leaves)).catch(() => {});
  }
  useEffect(load, []);

  async function decide(id, verb) {
    setError('');
    try { await api.post(`/leaves/${id}/${verb}`); load(); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function addType(e) {
    e.preventDefault(); setError('');
    try { await api.post('/leaves/types', newType); setNewType({ name: '', code: '', annual_quota: '', unpaid: false }); setShowAddType(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add leave type.'); }
  }
  async function exportCsv() {
    const lines = ['employee,type,from,to,days,status', ...leaves.map((l) => `${l.employee_name},${l.type},${l.from_date},${l.to_date},${l.days},${l.status}`)];
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
              <div key={l.id} className="rec-row">
                <span>{l.employee_name} — {l.type} Leave<div className="feature-meta">Pending · waiting on {l.waiting_on}</div></span>
                <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn-approve" onClick={() => decide(l.id, 'approve')}>Approve</button>
                  <button className="btn-reject" onClick={() => decide(l.id, 'reject')}>Reject</button>
                </span>
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
              <div key={t.id} className="rec-row"><span>{t.name} ({t.code})</span><span className="feature-meta">{t.unpaid ? 'Unpaid' : `${t.annual_quota}/yr`}</span></div>
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
                  <td><span className={'status-tag ' + tag(l.status)}>{l.status}</span></td>
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
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const tag = (s) => s === 'Approved' ? 'present' : s === 'Rejected' ? 'absent' : 'pending';

export default function Leave() {
  const { user } = useAuth();
  const canHR = HR_ROLES.includes(user?.role);
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [form, setForm] = useState({ type: 'Casual', from_date: '', to_date: '', reason: '' });
  const [showForm, setShowForm] = useState(false);

  function load() {
    api.get('/leaves').then((r) => { setLeaves(r.data.leaves); if (r.data.balance) setBalance(r.data.balance); }).catch(() => setError('Could not load leaves.'));
  }
  useEffect(load, []);

  async function apply(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/leaves', form); setInfo('Leave applied.'); setForm({ type: 'Casual', from_date: '', to_date: '', reason: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not apply.'); }
  }
  async function decide(id, verb) {
    setError('');
    try { await api.post(`/leaves/${id}/${verb}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }

  return (
    <div>
      <h1>Leave Management</h1>
      <div className="subtitle">{canHR ? 'Review and decide leave requests across the team.' : 'Apply for leave and track your balance and requests.'}</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {!canHR && balance && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Casual left</div><div className="kpi-value">{balance.casual}</div></div>
          <div className="kpi-card green"><div className="kpi-label">Sick left</div><div className="kpi-value">{balance.sick}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Earned left</div><div className="kpi-value">{balance.earned}</div></div>
        </div>
      )}

      {!canHR && (
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
          <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Apply for leave'}</button>
        </div>
      )}

      {showForm && (
        <div className="card">
          <form onSubmit={apply}>
            <div className="grid2">
              <div>
                <label className="field-label">Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option>Casual</option><option>Sick</option><option>Earned</option>
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
        <div className="feature-name" style={{ marginBottom: 8 }}>{canHR ? 'All leave requests' : 'My leave requests'}</div>
        {leaves.length === 0 && <div className="empty">No leave requests.</div>}
        {leaves.length > 0 && (
          <table>
            <thead><tr>{canHR && <th>Employee</th>}<th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th>{canHR && <th>Action</th>}</tr></thead>
            <tbody>{leaves.map((l) => (
              <tr key={l.id}>
                {canHR && <td>{l.employee_name}</td>}
                <td>{l.type}</td><td>{l.from_date}</td><td>{l.to_date}</td><td>{l.days}</td><td>{l.reason || '—'}</td>
                <td><span className={'status-tag ' + tag(l.status)}>{l.status}</span></td>
                {canHR && <td style={{ whiteSpace: 'nowrap' }}>
                  {l.status === 'Pending' ? (
                    <>
                      <button className="btn-approve" onClick={() => decide(l.id, 'approve')}>Approve</button>
                      <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(l.id, 'reject')}>Reject</button>
                    </>
                  ) : <span className="note">decided</span>}
                </td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

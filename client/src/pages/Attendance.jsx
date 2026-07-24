import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const tag = (s) => s === 'Present' ? 'present' : s === 'Leave' ? 'info' : s === 'Absent' ? 'absent' : 'locked';

export default function Attendance() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRAttendance /> : <MyAttendance />;
}

function MyAttendance() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [method, setMethod] = useState('Web Check-in');
  const [reg, setReg] = useState({ date: '', reason: '' });
  const [showReg, setShowReg] = useState(false);

  function load() { api.get('/attendance').then((r) => setData(r.data)).catch(() => setError('Could not load attendance.')); }
  useEffect(load, []);

  async function action(verb) {
    setError(''); setInfo('');
    try { await api.post(`/attendance/${verb}`, verb === 'check-in' ? { method } : {}); setInfo(verb === 'check-in' ? 'Checked in.' : 'Checked out.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function submitReg(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/attendance/regularize', reg); setInfo('Regularization request sent to HR.'); setReg({ date: '', reason: '' }); setShowReg(false); }
    catch (err) { setError(err.response?.data?.error || 'Request failed.'); }
  }

  const t = data?.today;
  return (
    <div>
      <h1>Attendance</h1>
      <div className="subtitle">Check in and out, and review your recent attendance.</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Today</div>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Status: <span className={'status-tag ' + tag(t?.status)}>{t?.status || 'Not marked'}</span></span>
          {t?.check_in_time && <span className="feature-meta">In: {t.check_in_time} ({t.method})</span>}
          {t?.check_out_time && <span className="feature-meta">Out: {t.check_out_time}</span>}
          <div style={{ flex: 1 }} />
          <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!!t?.check_in_time} style={{ width: 'auto' }}>
            <option>Web Check-in</option><option>Mobile App</option><option>Biometric (Fingerprint)</option><option>Face Recognition</option>
          </select>
          <button className="primary" onClick={() => action('check-in')} disabled={!!t?.check_in_time}>Check in</button>
          <button onClick={() => action('check-out')} disabled={!t?.check_in_time || !!t?.check_out_time}>Check out</button>
          <button onClick={() => setShowReg((v) => !v)}>Regularize</button>
        </div>
        {showReg && (
          <form onSubmit={submitReg} className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <input type="date" value={reg.date} onChange={(e) => setReg({ ...reg, date: e.target.value })} required />
            <input placeholder="Reason (e.g. forgot to check out)" value={reg.reason} onChange={(e) => setReg({ ...reg, reason: e.target.value })} required style={{ flex: '2 1 200px' }} />
            <button className="primary" type="submit">Send request</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recent (last 30 days)</div>
        {(!data || data.rows.length === 0) && <div className="empty">No attendance records yet.</div>}
        {data && data.rows.length > 0 && (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Method</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}><td>{r.date}</td><td><span className={'status-tag ' + tag(r.status)}>{r.status}</span></td><td>{r.check_in_time || '—'}</td><td>{r.check_out_time || '—'}</td><td>{r.method || '—'}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HRAttendance() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [grid, setGrid] = useState(null);
  const [date, setDate] = useState('');
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [showGrid, setShowGrid] = useState(false);

  function load(d, dp) {
    const params = {};
    if (d) params.date = d;
    if (dp) params.department = dp;
    api.get('/attendance/overview', { params }).then((r) => { setOv(r.data); setDate(r.data.date); }).catch(() => setError('Could not load attendance.'));
    api.get('/attendance', { params: d ? { date: d } : {} }).then((r) => setGrid(r.data)).catch(() => {});
  }
  useEffect(() => { load(); api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);

  async function decide(id, verb) {
    try { await api.post(`/approvals/${id}/${verb}`); load(date, dept); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function mark(employee_id, status) {
    try { await api.post('/attendance/mark', { employee_id, date, status }); load(date, dept); } catch (err) { setError(err.response?.data?.error || 'Could not mark.'); }
  }
  async function exportCsv() {
    const res = await api.get('/attendance/export', { params: { date }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-${date}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Attendance</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="filter-bar">
        <select value={dept} onChange={(e) => { setDept(e.target.value); load(date, e.target.value); }}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => load(e.target.value, dept)} style={{ width: 'auto' }} />
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
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">1</span>Biometric Reports — Check-in / Check-out</div>
            <div className="row">
              <div className="kpi-card green" style={{ flex: 1 }}><div className="kpi-label">Total Checked In</div><div className="kpi-value">{ov.biometric.checkedIn}</div></div>
              <div className="kpi-card gold" style={{ flex: 1 }}><div className="kpi-label">Total Checked Out</div><div className="kpi-value">{ov.biometric.checkedOut}</div></div>
            </div>
            {ov.biometric.methods.length === 0 && <div className="note" style={{ marginTop: 10 }}>No check-ins recorded for this date yet.</div>}
            {ov.biometric.methods.map((m) => (
              <div key={m.method} className="rec-row"><span>{m.method}</span><span className="feature-meta">In: {m.in} · Out: {m.out}</span></div>
            ))}
          </div>
        )}

        {ov && (
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>Regularization Requests</div>
            {ov.regularizations.length === 0 && <div className="empty">No regularization requests.</div>}
            {ov.regularizations.map((r) => (
              <div key={r.id} className="rec-row">
                <span>{r.requester}<div className="feature-meta">{r.detail}</div></span>
                {r.status === 'Pending' ? (
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn-approve" onClick={() => decide(r.id, 'approve')}>Approve</button>
                    <button className="btn-reject" onClick={() => decide(r.id, 'reject')}>Reject</button>
                  </span>
                ) : <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : 'absent')}>{r.status}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Quick Actions</div>
          <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowGrid((v) => !v)}>
            {showGrid ? '− Hide daily marking' : '+ Mark attendance (daily)'}
          </button>
          {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
        </div>
      </div>

      {showGrid && grid && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Daily marking — {date}</div>
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Status</th><th>In</th><th>Mark</th></tr></thead>
            <tbody>{grid.rows.map((r) => (
              <tr key={r.employee_id}>
                <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td>
                <td><span className={'status-tag ' + tag(r.status)}>{r.status || 'Not marked'}</span></td>
                <td>{r.check_in_time || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-approve" onClick={() => mark(r.employee_id, 'Present')}>P</button>
                  <button className="btn-reject" style={{ marginLeft: 4 }} onClick={() => mark(r.employee_id, 'Absent')}>A</button>
                  <button style={{ marginLeft: 4 }} onClick={() => mark(r.employee_id, 'Leave')}>L</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

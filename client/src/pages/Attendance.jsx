import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const tag = (s) => s === 'Present' ? 'present' : s === 'Leave' ? 'info' : s === 'Absent' ? 'absent' : 'locked';

export default function Attendance() {
  const { user } = useAuth();
  const canHR = HR_ROLES.includes(user?.role);
  return canHR ? <HRAttendance /> : <MyAttendance />;
}

function MyAttendance() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [reg, setReg] = useState({ date: '', reason: '' });
  const [showReg, setShowReg] = useState(false);

  function load() { api.get('/attendance').then((r) => setData(r.data)).catch(() => setError('Could not load attendance.')); }
  useEffect(load, []);

  async function action(verb) {
    setError(''); setInfo('');
    try { await api.post(`/attendance/${verb}`); setInfo(verb === 'check-in' ? 'Checked in.' : 'Checked out.'); load(); }
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
        <div className="row" style={{ alignItems: 'center' }}>
          <span>Status: <span className={'status-tag ' + tag(t?.status)}>{t?.status || 'Not marked'}</span></span>
          {t?.check_in_time && <span className="feature-meta">In: {t.check_in_time}</span>}
          {t?.check_out_time && <span className="feature-meta">Out: {t.check_out_time}</span>}
          <div style={{ flex: 1 }} />
          <button className="primary" onClick={() => action('check-in')} disabled={!!t?.check_in_time}>Check in</button>
          <button onClick={() => action('check-out')} disabled={!t?.check_in_time || !!t?.check_out_time}>Check out</button>
          <button onClick={() => setShowReg((v) => !v)}>Regularize</button>
        </div>
        {showReg && (
          <form onSubmit={submitReg} className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <input type="date" value={reg.date} onChange={(e) => setReg({ ...reg, date: e.target.value })} required />
            <input placeholder="Reason (e.g. forgot to check in)" value={reg.reason} onChange={(e) => setReg({ ...reg, reason: e.target.value })} required style={{ flex: '2 1 200px' }} />
            <button className="primary" type="submit">Send request</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recent (last 30 days)</div>
        {(!data || data.rows.length === 0) && <div className="empty">No attendance records yet.</div>}
        {data && data.rows.length > 0 && (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}><td>{r.date}</td><td><span className={'status-tag ' + tag(r.status)}>{r.status}</span></td><td>{r.check_in_time || '—'}</td><td>{r.check_out_time || '—'}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HRAttendance() {
  const [data, setData] = useState(null);
  const [date, setDate] = useState('');
  const [error, setError] = useState('');

  function load(d) { api.get('/attendance', { params: d ? { date: d } : {} }).then((r) => { setData(r.data); setDate(r.data.date); }).catch(() => setError('Could not load attendance.')); }
  useEffect(() => { load(); }, []);

  async function mark(employee_id, status) {
    setError('');
    try { await api.post('/attendance/mark', { employee_id, date, status }); load(date); }
    catch (err) { setError(err.response?.data?.error || 'Could not mark.'); }
  }

  return (
    <div>
      <h1>Attendance</h1>
      <div className="subtitle">Daily attendance across all employees. Mark anyone Present, Absent or on Leave.</div>
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <label className="field-label" style={{ margin: 0 }}>Date</label>
        <input type="date" value={date} onChange={(e) => load(e.target.value)} style={{ width: 'auto' }} />
      </div>

      {data && (
        <div className="kpi-row">
          <div className="kpi-card green"><div className="kpi-label">Present</div><div className="kpi-value">{data.summary.present}</div></div>
          <div className="kpi-card red"><div className="kpi-label">Absent</div><div className="kpi-value">{data.summary.absent}</div></div>
          <div className="kpi-card blue"><div className="kpi-label">On Leave</div><div className="kpi-value">{data.summary.onLeave}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Unmarked</div><div className="kpi-value">{data.summary.unmarked}</div></div>
        </div>
      )}

      <div className="card">
        {data && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Status</th><th>In</th><th>Mark</th></tr></thead>
            <tbody>{data.rows.map((r) => (
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
        )}
      </div>
    </div>
  );
}

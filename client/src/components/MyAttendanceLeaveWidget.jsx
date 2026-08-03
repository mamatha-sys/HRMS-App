import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';

const tag = (s) => s === 'Present' ? 'present' : s === 'Leave' ? 'info' : s === 'Absent' ? 'absent' : 'locked';

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 4000 }
    );
  });
}

// Employee's own attendance + leave, right on the Dashboard — check in/out here without a trip
// to the Attendance page, and see this month's presence and leave balance at a glance.
export default function MyAttendanceLeaveWidget() {
  const [attendance, setAttendance] = useState(null);
  const [balances, setBalances] = useState([]);
  const [pendingLeaves, setPendingLeaves] = useState(0);
  const [method, setMethod] = useState('Web Check-in');
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  function load() {
    api.get('/attendance').then((r) => setAttendance(r.data)).catch(() => {});
    api.get('/leaves/balance').then((r) => setBalances(r.data.balances)).catch(() => {});
    api.get('/leaves').then((r) => setPendingLeaves(r.data.leaves.filter((l) => l.status === 'Pending').length)).catch(() => {});
  }
  useEffect(load, []);

  async function checkIn() {
    setError(''); setInfo(''); setLocating(true);
    const loc = await getLocation();
    setLocating(false);
    try {
      await api.post('/attendance/check-in', { method, ...(loc || {}) });
      setInfo(loc ? 'Checked in with location.' : 'Checked in (location unavailable).');
      load();
    } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function checkOut() {
    setError(''); setInfo('');
    try { await api.post('/attendance/check-out'); setInfo('Checked out.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }

  const t = attendance?.today;
  const now = new Date();
  const presentThisMonth = (attendance?.rows || []).filter((r) => {
    const d = new Date(r.date);
    return r.status === 'Present' && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const totalLeaveBalance = balances.filter((b) => !b.unpaid).reduce((sum, b) => sum + (b.balance || 0), 0);

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>My Attendance &amp; Leave</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">Today</div><div className="kpi-value text">{t?.status || 'Not marked'}</div></div>
        <div className="kpi-card green"><div className="kpi-label">Present (this month)</div><div className="kpi-value">{presentThisMonth}</div></div>
        <div className="kpi-card gold"><div className="kpi-label">Leave Balance</div><div className="kpi-value">{totalLeaveBalance}</div></div>
        <div className="kpi-card red"><div className="kpi-label">Pending Leave Requests</div><div className="kpi-value">{pendingLeaves}</div></div>
      </div>

      <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
        <span>Status: <span className={'status-tag ' + tag(t?.status)}>{t?.status || 'Not marked'}</span></span>
        {t?.check_in_time && <span className="feature-meta">In: {t.check_in_time} ({t.method})</span>}
        {t?.check_out_time && <span className="feature-meta">Out: {t.check_out_time}</span>}
        <div style={{ flex: 1 }} />
        <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!!t?.check_in_time} style={{ width: 'auto' }}>
          <option>Web Check-in</option><option>Mobile App</option><option>Biometric (Fingerprint)</option><option>Face Recognition</option>
        </select>
        <button className="primary" onClick={checkIn} disabled={!!t?.check_in_time || locating}>{locating ? 'Locating...' : 'Check in'}</button>
        <button onClick={checkOut} disabled={!t?.check_in_time || !!t?.check_out_time}>Check out</button>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <Link to="/attendance"><button>View Attendance →</button></Link>
        <Link to="/leave"><button>View Leave →</button></Link>
      </div>
    </div>
  );
}

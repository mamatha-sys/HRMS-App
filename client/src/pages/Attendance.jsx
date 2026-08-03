import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';
import { loadFaceModels, extractFaceDescriptor, detectFacePresence } from '../faceApi.js';

// Super Admin is a pure system-administrator account — admin overview only, no own check-in/out.
const FULL_HR_ROLES = ['super_admin'];
const SCOPED_ROLES = ['stl', 'tl'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own check-in/out
// (MyAttendance) AND the overview below it (company-wide for the first three, scoped to their
// assigned departments/teams for STL/TL), rather than one replacing the other.
const SELF_AND_TEAM_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL can view + approve regularizations for their assigned department/
// team, but marking someone else's attendance directly is an edit action reserved for these
// roles (per Super Admin policy) unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
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

function mapLink(lat, lng) { return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`; }

// Web Check-in and Mobile App both require a live face capture before the check-in is accepted —
// opens the camera, waits for a face in frame, and hands the extracted descriptor back to the
// caller to submit alongside the check-in request. First successful check-in enrolls the
// employee's face; every one after that must match it (enforced server-side).
function FaceCheckInPanel({ onCapture, onCancel, submitting }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectLoopRef = useRef(null);
  const [cameraStatus, setCameraStatus] = useState('loading'); // loading | ready | error
  const [facePresent, setFacePresent] = useState(false);
  const [error, setError] = useState('');
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function setup() {
      try {
        await loadFaceModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        setCameraStatus('ready');
        detectLoopRef.current = setInterval(async () => {
          if (cancelled || !videoRef.current) return;
          setFacePresent(await detectFacePresence(videoRef.current));
        }, 500);
      } catch (err) {
        setCameraStatus('error');
        setError('Camera/model setup failed: ' + (err.message || 'permission denied or unsupported browser.'));
      }
    }
    setup();
    return () => {
      cancelled = true;
      if (detectLoopRef.current) clearInterval(detectLoopRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function capture() {
    setError(''); setCapturing(true);
    const descriptor = await extractFaceDescriptor(videoRef.current);
    setCapturing(false);
    if (!descriptor) { setError('No face detected. Move closer, face the camera directly, and make sure the room is well lit.'); return; }
    onCapture(descriptor);
  }

  return (
    <div className="card" style={{ marginTop: 10, maxWidth: 360 }}>
      <div className="feature-name" style={{ marginBottom: 8 }}>Face Verification</div>
      {error && <div className="banner error">{error}</div>}
      <div className="camera-box">
        <video ref={videoRef} muted playsInline className="camera-video" />
        {cameraStatus === 'loading' && <div className="camera-overlay">Loading camera &amp; face models...</div>}
        {cameraStatus === 'error' && <div className="camera-overlay">Camera unavailable</div>}
        {cameraStatus === 'ready' && (
          <div className={'face-indicator ' + (facePresent ? 'ok' : 'warn')}>{facePresent ? '✓ Face detected' : 'No face detected'}</div>
        )}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={capture} disabled={cameraStatus !== 'ready' || capturing || submitting}>
          {capturing || submitting ? 'Verifying...' : 'Capture & Check In'}
        </button>
        <button type="button" onClick={onCancel} disabled={capturing || submitting}>Cancel</button>
      </div>
    </div>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRAttendance />;
  if (SELF_AND_TEAM_ROLES.includes(user?.role)) {
    const sectionLabel = SCOPED_ROLES.includes(user?.role) ? 'Team Attendance' : 'Company Attendance';
    return (<><MyAttendance compact /><HRAttendance compact sectionLabel={sectionLabel} /></>);
  }
  return <MyAttendance />;
}

function MyAttendance({ compact }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [methods, setMethods] = useState(['Web Check-in']);
  const [method, setMethod] = useState('Web Check-in');
  const [locating, setLocating] = useState(false);
  const [showFaceCapture, setShowFaceCapture] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reg, setReg] = useState({ date: '', reason: '' });
  const [showReg, setShowReg] = useState(false);

  function load() { api.get('/attendance/mine').then((r) => setData(r.data)).catch(() => setError('Could not load attendance.')); }
  useEffect(load, []);
  useEffect(() => {
    api.get('/attendance/methods').then((r) => {
      setMethods(r.data.methods);
      if (r.data.methods.length && !r.data.methods.includes(method)) setMethod(r.data.methods[0]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startCheckIn() { setError(''); setInfo(''); setShowFaceCapture(true); }

  async function checkIn(faceDescriptor) {
    setError(''); setInfo(''); setLocating(true);
    const loc = await getLocation();
    setLocating(false); setSubmitting(true);
    try {
      const r = await api.post('/attendance/check-in', { method, faceDescriptor, ...(loc || {}) });
      setShowFaceCapture(false);
      setInfo((r.data.faceJustEnrolled ? 'Face enrolled for check-in verification. ' : '') + (loc ? 'Checked in with location.' : 'Checked in (location unavailable).'));
      load();
    } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
    finally { setSubmitting(false); }
  }
  async function checkOut() {
    setError(''); setInfo('');
    try { await api.post('/attendance/check-out'); setInfo('Checked out.'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function submitReg(e) {
    e.preventDefault(); setError(''); setInfo('');
    try { await api.post('/attendance/regularize', reg); setInfo('Regularization request sent to HR.'); setReg({ date: '', reason: '' }); setShowReg(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Request failed.'); }
  }

  const t = data?.today;
  const s = data?.summary;
  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Attendance</div> : <h1>Attendance</h1>}
      {!compact && <div className="subtitle">Check in and out, and review your recent attendance.</div>}
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {s && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Attendance % ({s.month})</div><div className="kpi-value">{s.attendancePct}%</div></div>
          <div className="kpi-card green"><div className="kpi-label">Present</div><div className="kpi-value">{s.present}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Late Arrivals</div><div className="kpi-value">{s.late}</div></div>
          <div className="kpi-card red"><div className="kpi-label">Half-day Cut</div><div className="kpi-value">{s.halfDayCut}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Missing Punch-in</div><div className="kpi-value">{s.missingPunch}</div></div>
        </div>
      )}

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Today</div>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Status: <span className={'status-tag ' + tag(t?.status)}>{t?.status || 'Not marked'}</span></span>
          {t?.check_in_time && <span className="feature-meta">In: {t.check_in_time} ({t.method})</span>}
          {t?.check_out_time && <span className="feature-meta">Out: {t.check_out_time}</span>}
          {t?.latitude != null && (
            <span className="feature-meta">
              📍 {t.latitude.toFixed(5)}, {t.longitude.toFixed(5)}{' '}
              <a className="crumb" href={mapLink(t.latitude, t.longitude)} target="_blank" rel="noreferrer">view on map</a>
            </span>
          )}
          <div style={{ flex: 1 }} />
          <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!!t?.check_in_time || showFaceCapture} style={{ width: 'auto' }}>
            {methods.map((m) => <option key={m}>{m}</option>)}
          </select>
          <button className="primary" onClick={startCheckIn} disabled={!!t?.check_in_time || showFaceCapture}>Check in</button>
          <button onClick={checkOut} disabled={!t?.check_in_time || !!t?.check_out_time}>Check out</button>
          <button onClick={() => setShowReg((v) => !v)}>Regularize</button>
        </div>
        <div className="note" style={{ marginTop: 6 }}>Check-in captures your GPS location (browser will ask permission) and requires a quick face verification.</div>
        {showFaceCapture && (
          <FaceCheckInPanel onCapture={checkIn} onCancel={() => setShowFaceCapture(false)} submitting={locating || submitting} />
        )}
        {showReg && (
          <form onSubmit={submitReg} className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <input type="date" value={reg.date} onChange={(e) => setReg({ ...reg, date: e.target.value })} required />
            <input placeholder="Reason (e.g. forgot to check out)" value={reg.reason} onChange={(e) => setReg({ ...reg, reason: e.target.value })} required style={{ flex: '2 1 200px' }} />
            <button className="primary" type="submit">Send request</button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My Regularization Requests</div>
        {(!data || data.regularizations?.length === 0) && <div className="empty">No regularization requests yet.</div>}
        {data?.regularizations?.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="feature-meta">{r.detail}</span>
              {r.status !== 'Pending' && <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : 'absent')}>{r.status}</span>}
            </div>
            {r.status === 'Pending' && <ChainStepper chainLabel={data.chainLabel} currentStageName={r.current_stage_name} status={r.status} />}
            {r.status !== 'Pending' && r.decided_by_name && (
              <div className="feature-meta">{r.status} by {r.decided_by_name}</div>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Recent (last 30 days)</div>
        {(!data || data.rows.length === 0) && <div className="empty">No attendance records yet.</div>}
        {data && data.rows.length > 0 && (
          <table>
            <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Method</th><th>Location</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.date}</td><td><span className={'status-tag ' + tag(r.status)}>{r.status}</span></td><td>{r.check_in_time || '—'}</td><td>{r.check_out_time || '—'}</td><td>{r.method || '—'}</td>
                <td>{r.latitude != null ? (
                  <span className="feature-meta">{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)} <a className="crumb" href={mapLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer">map</a></span>
                ) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HRAttendance({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const isSuperAdmin = user?.role === 'super_admin';
  const [ov, setOv] = useState(null);
  const [grid, setGrid] = useState(null);
  const [date, setDate] = useState('');
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [showGrid, setShowGrid] = useState(false);
  const [tab, setTab] = useState('dashboard'); // dashboard | biometric | reports | methods
  const [checkInMethods, setCheckInMethods] = useState(null);

  function load(d, dp) {
    const params = {};
    if (d) params.date = d;
    if (dp) params.department = dp;
    api.get('/attendance/overview', { params }).then((r) => { setOv(r.data); setDate(r.data.date); }).catch(() => setError('Could not load attendance.'));
    api.get('/attendance', { params: d ? { date: d } : {} }).then((r) => setGrid(r.data)).catch(() => {});
  }
  useEffect(() => { load(); api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  function loadCheckInMethods() { api.get('/attendance/methods/all').then((r) => setCheckInMethods(r.data.methods)).catch(() => {}); }
  useEffect(() => { if (tab === 'methods' && isSuperAdmin) loadCheckInMethods(); }, [tab, isSuperAdmin]);

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
  async function toggleCheckInMethod(m) {
    setError('');
    try { await api.put(`/attendance/methods/${encodeURIComponent(m.method)}`, { enabled: !m.enabled }); loadCheckInMethods(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Team Attendance'}</div> : <h1>Attendance</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'biometric' ? 'primary' : ''} onClick={() => setTab('biometric')}>Biometric Attendance List</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports (Monthly)</button>
        {isSuperAdmin && <button className={tab === 'methods' ? 'primary' : ''} onClick={() => setTab('methods')}>Check-in Methods</button>}
      </div>

      {tab === 'methods' && isSuperAdmin && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Check-in Methods</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>
            Control which methods employees can pick when checking in. Both require a live face-verification capture. Biometric (Fingerprint) isn't listed here — it's pushed directly by registered devices (Integrations) and always shows up in the Biometric Attendance List / Reports.
          </div>
          {!checkInMethods && <div className="empty">Loading…</div>}
          {checkInMethods && checkInMethods.map((m) => (
            <div key={m.method} className="rec-row">
              <span>{m.method}</span>
              <span className="row" style={{ gap: 10, flexShrink: 0 }}>
                <span className={'status-tag ' + (m.enabled ? 'present' : 'locked')}>{m.enabled ? 'Enabled' : 'Disabled'}</span>
                <button onClick={() => toggleCheckInMethod(m)}>{m.enabled ? 'Disable' : 'Enable'}</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'dashboard' && (
        <>
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
                  <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                      <span>{r.requester}{r.team_name && <span className="feature-meta"> ({r.team_name})</span>}<div className="feature-meta">{r.detail}</div></span>
                      {r.status === 'Pending' ? (
                        <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button className="btn-approve" onClick={() => decide(r.id, 'approve')}>Approve</button>
                          <button className="btn-reject" onClick={() => decide(r.id, 'reject')}>Reject</button>
                        </span>
                      ) : <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : 'absent')}>{r.status}</span>}
                    </div>
                    {r.status === 'Pending' && <ChainStepper chainLabel={ov.chainLabel} currentStageName={r.current_stage_name} status={r.status} />}
                  </div>
                ))}
              </div>
            )}

            {canManage && (
              <div className="card">
                <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Quick Actions</div>
                <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowGrid((v) => !v)}>
                  {showGrid ? '− Hide daily marking' : '+ Mark attendance (daily)'}
                </button>
                {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
              </div>
            )}
          </div>

          {canManage && showGrid && grid && (
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>Daily marking — {date}</div>
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Status</th><th>In</th><th>Location</th><th>Mark</th></tr></thead>
                <tbody>{grid.rows.map((r) => (
                  <tr key={r.employee_id}>
                    <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td>
                    <td><span className={'status-tag ' + tag(r.status)}>{r.status || 'Not marked'}</span></td>
                    <td>{r.check_in_time || '—'}{!!r.half_day_flag && <span className="status-tag absent" style={{ marginLeft: 6 }} title="Late beyond the free monthly allowance — half-day pay cut">½-day cut</span>}</td>
                    <td>{r.latitude != null ? <a className="crumb" href={mapLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer">📍 map</a> : '—'}</td>
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
        </>
      )}

      {tab === 'biometric' && <BiometricList />}
      {tab === 'reports' && <MonthlyReports />}
    </div>
  );
}

function BiometricList() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/attendance/biometric-list').then((r) => setData(r.data)).catch(() => setError('Could not load biometric list.')); }, []);

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>Biometric &amp; Device Attendance — Employee List {data && <span className="note">({data.month})</span>}</div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <div className="empty">Loading...</div>}
      {data && (
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Last method</th><th>Last check-in</th><th>Location</th><th>Present (month)</th><th>Late (month)</th><th>Half-day Cut (month)</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.employee_id}>
              <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td>
              <td>{r.last_method || '—'}</td><td>{r.last_check_in || '—'}</td>
              <td>{r.last_location ? <a className="crumb" href={mapLink(r.last_location.lat, r.last_location.lng)} target="_blank" rel="noreferrer">📍 map</a> : '—'}</td>
              <td>{r.present_days_month}</td><td>{r.late_days_month}</td>
              <td>{r.half_day_cut_days_month > 0 ? <span className="status-tag absent">{r.half_day_cut_days_month}</span> : 0}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function MonthlyReports() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  function load(m) { api.get('/attendance/monthly-report', { params: { month: m } }).then((r) => setData(r.data)).catch(() => setError('Could not load report.')); }
  useEffect(() => load(month), []);

  async function exportCsv() {
    const res = await api.get('/attendance/monthly-report/export', { params: { month }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-monthly-${month}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="feature-name">Monthly Attendance Report</div>
        <div style={{ flex: 1 }} />
        <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); load(e.target.value); }} style={{ width: 'auto' }} />
        <button className="primary" onClick={exportCsv}>Export</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {data && (
        <>
          <div className="note" style={{ marginTop: 8 }}>Grace time 9:15 AM · {data.freeLateAllowance} free late arrival(s)/month, then each late day is flagged with an automatic half-day pay cut.</div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late</th><th>Half-day Cut</th><th>Attendance %</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td>
                <td>{r.present}</td><td>{r.absent}</td><td>{r.leave}</td><td>{r.late}</td>
                <td>{r.halfDayCut > 0 ? <span className="status-tag absent">{r.halfDayCut}</span> : 0}</td>
                <td><strong>{r.attendancePct}%</strong></td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

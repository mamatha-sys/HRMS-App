import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import ChainStepper from '../components/ChainStepper.jsx';
import { loadFaceModels, extractFaceDescriptor, detectFacePresence } from '../faceApi.js';
import { SCOPED_ROLES } from '../roles.js';

// Super Admin is a pure system-administrator account — admin overview only, no own check-in/out.
const FULL_HR_ROLES = ['super_admin'];

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

// Same color meanings as the status-tag classes used everywhere else (present=green, absent=red,
// info=blue for Leave, locked=gray for Not marked) — a calendar is just those same colors laid
// out as a month grid instead of a list.
const CALENDAR_COLORS = {
  Present: { bg: '#E4F5EC', color: '#1E8E5A' },
  Absent: { bg: '#FBEAE5', color: '#B3401E' },
  Leave: { bg: '#E8EEF9', color: '#2E5CB8' },
  'Not marked': { bg: '#EEF0F3', color: '#5A6472' }
};
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Month-grid calendar, color-coded by day status, with a per-month Present/Absent/Leave/Not-
// marked count row — used both for an employee's own view (no employeeId) and, from HR's Monthly
// Report, for any one employee in scope (employeeId set, mirrors the CSV export's ?id= idiom).
// `initialMonth` opens the calendar on the month being worked on rather than today's — marking
// attendance for a past date and then opening the calendar on the current month shows a grid with
// none of the marks just made. `refreshKey` re-fetches when the underlying attendance changes, so
// a mark made in the grid above appears on the calendar immediately.
function AttendanceCalendar({ employeeId, employeeLabel, initialMonth, refreshKey, canMark }) {
  const [month, setMonth] = useState(initialMonth || new Date().toISOString().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // Which day the Present/Absent/Leave chooser is open on. Correcting a missed punch means fixing
  // one specific past date, so the choice happens on the day itself rather than by changing the
  // page's date filter and using the grid.
  const [pickFor, setPickFor] = useState(null);
  const [saving, setSaving] = useState(false);

  function load(m) {
    api.get('/attendance/calendar', { params: { month: m, ...(employeeId ? { id: employeeId } : {}) } })
      .then((r) => setData(r.data)).catch(() => setError('Could not load calendar.'));
  }
  useEffect(() => { load(month); }, [employeeId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function markDay(date, status) {
    if (!employeeId) return;
    setError(''); setSaving(true);
    try {
      await api.post('/attendance/mark', { employee_id: employeeId, date, status });
      setPickFor(null);
      load(month);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not mark that day.');
    } finally { setSaving(false); }
  }

  function changeMonth(delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    setMonth(next); load(next);
  }

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <div className="empty">Loading calendar…</div>;

  const firstDow = new Date(`${data.month}-01T00:00:00`).getDay();
  const cells = [...Array(firstDow).fill(null), ...data.days];

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="feature-name">{employeeLabel || 'My'} Attendance Calendar — {data.month}</div>
        <div style={{ flex: 1 }} />
        <button onClick={() => changeMonth(-1)}>← Prev</button>
        <button onClick={() => changeMonth(1)}>Next →</button>
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="status-tag present">Present: {data.summary.present}</span>
        <span className="status-tag absent">Absent: {data.summary.absent}</span>
        <span className="status-tag info">Leave: {data.summary.leave}</span>
        <span className="status-tag locked">Not marked: {data.summary.notMarked}</span>
        {data.summary.halfDayCut > 0 && <span className="status-tag pending">Half-day cut: {data.summary.halfDayCut}</span>}
      </div>
      {canMark && employeeId && (
        <div className="feature-meta" style={{ marginBottom: 8 }}>
          Click any day to set it Present, Absent or Leave — for correcting a missed punch the employee
          has raised a regularization request for. Approving that request from the Dashboard tab marks
          the day Present automatically.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {WEEKDAY_LABELS.map((d) => <div key={d} className="feature-meta" style={{ textAlign: 'center', fontWeight: 700 }}>{d}</div>)}
        {cells.map((c, i) => {
          if (!c) return <div key={`blank-${i}`} />;
          const style = c.status && CALENDAR_COLORS[c.status] ? CALENDAR_COLORS[c.status] : { bg: '#fff', color: '#B7BEC9' };
          // A future date has no status and nothing to correct, so it stays inert.
          const markable = canMark && !!employeeId && !!c.status;
          const title = c.status
            ? `${c.date} — ${c.status}${c.check_in_time ? ` · In ${c.check_in_time}` : ''}${c.check_out_time ? ` · Out ${c.check_out_time}` : ''}${c.half_day_flag ? ' · Half-day cut' : ''}${markable ? ' · click to change' : ''}`
            : c.date;
          return (
            <div key={c.date} style={{ position: 'relative' }}>
              <div
                title={title}
                onClick={markable ? () => setPickFor(pickFor === c.date ? null : c.date) : undefined}
                style={{
                  background: style.bg, color: style.color, borderRadius: 6, padding: '8px 4px', textAlign: 'center',
                  fontSize: 13, fontWeight: 600, minHeight: 40, cursor: markable ? 'pointer' : 'default',
                  border: pickFor === c.date ? '2px solid #2E5CB8'
                    : c.half_day_flag ? '2px solid #C2540A'
                    : c.status ? '1px solid transparent' : '1px dashed #EEF0F3'
                }}
              >
                {c.day}
              </div>
              {pickFor === c.date && (
                <div style={{
                  position: 'absolute', zIndex: 5, top: '100%', left: 0, marginTop: 4, background: '#fff',
                  border: '1px solid #E2E5EA', borderRadius: 8, padding: 8, boxShadow: '0 4px 14px rgba(0,0,0,.12)', minWidth: 150
                }}>
                  <div className="feature-meta" style={{ marginBottom: 6 }}>{c.date}</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-approve" disabled={saving} onClick={() => markDay(c.date, 'Present')}>Present</button>
                    <button className="btn-reject" disabled={saving} onClick={() => markDay(c.date, 'Absent')}>Absent</button>
                    <button disabled={saving} onClick={() => markDay(c.date, 'Leave')}>Leave</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
  const [showCalendar, setShowCalendar] = useState(false);

  // First Check-In / Last Check-Out report: filter by Month OR a Start/End Date range.
  const [reportMonth, setReportMonth] = useState('');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [reportData, setReportData] = useState(null);
  const [reportError, setReportError] = useState('');
  const [expandedDate, setExpandedDate] = useState(null);

  function reportParams() {
    if (reportMonth) return { month: reportMonth };
    if (reportFrom && reportTo) return { from: reportFrom, to: reportTo };
    return undefined;
  }
  function loadReport(params) {
    setReportError('');
    api.get('/attendance/mine/report', { params }).then((r) => setReportData(r.data)).catch(() => setReportError('Could not load report.'));
  }
  useEffect(() => { loadReport(); }, []);
  function searchReport() {
    if (reportMonth) { loadReport({ month: reportMonth }); return; }
    if (reportFrom && reportTo) { loadReport({ from: reportFrom, to: reportTo }); return; }
    setReportError('Choose either Month, or both a Start Date and End Date.');
  }
  function resetReportFilters() { setReportMonth(''); setReportFrom(''); setReportTo(''); setExpandedDate(null); loadReport(); }
  async function exportReportExcel() {
    const res = await api.get('/attendance/mine/report/export.xlsx', { params: reportParams(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `my-attendance-${reportData?.from || 'export'}-to-${reportData?.to || ''}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }

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
          <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!!t?.check_in_time || showFaceCapture || methods.length === 0} style={{ width: 'auto' }}>
            {methods.map((m) => <option key={m}>{m}</option>)}
          </select>
          <button className="primary" onClick={startCheckIn} disabled={!!t?.check_in_time || showFaceCapture || methods.length === 0}>Check in</button>
          <button onClick={checkOut} disabled={!t?.check_in_time || !!t?.check_out_time}>Check out</button>
          <button onClick={() => setShowReg((v) => !v)}>Regularize</button>
          <button onClick={() => setShowCalendar((v) => !v)}>{showCalendar ? 'Hide calendar' : 'Calendar view'}</button>
        </div>
        {methods.length === 0 ? (
          // Assigned to Biometric (Fingerprint) only — nothing here is self-selectable for them.
          <div className="note" style={{ marginTop: 6 }}>You're assigned to Biometric (Fingerprint) attendance — punch on the biometric device instead of checking in here. Your punches still appear below and in all reports.</div>
        ) : (
          <div className="note" style={{ marginTop: 6 }}>Check-in captures your GPS location (browser will ask permission) and requires a quick face verification.</div>
        )}
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

      {showCalendar && (
        <div className="card">
          <AttendanceCalendar />
        </div>
      )}

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
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="feature-name">First Check-In &amp; Last Check-Out</div>
          <div style={{ flex: 1 }} />
          <button className="primary" onClick={exportReportExcel}>Export (Excel)</button>
        </div>
        <div className="feature-meta" style={{ margin: '8px 0 10px' }}>Choose either <strong>Month</strong> OR (<strong>Start Date</strong> and <strong>End Date</strong>)</div>
        <div className="filter-bar" style={{ marginBottom: 8 }}>
          <input type="month" placeholder="Month" value={reportMonth} onChange={(e) => { setReportMonth(e.target.value); if (e.target.value) { setReportFrom(''); setReportTo(''); } }} style={{ width: 'auto' }} />
          <input type="date" placeholder="Start Date" value={reportFrom} onChange={(e) => { setReportFrom(e.target.value); if (e.target.value) setReportMonth(''); }} style={{ width: 'auto' }} />
          <input type="date" placeholder="End Date" value={reportTo} onChange={(e) => { setReportTo(e.target.value); if (e.target.value) setReportMonth(''); }} style={{ width: 'auto' }} />
          <button className="primary" onClick={searchReport}>Search</button>
          <button onClick={resetReportFilters}>Reset Filters</button>
        </div>
        {reportError && <div className="banner error">{reportError}</div>}
        {reportData?.branch && <div className="feature-meta" style={{ marginBottom: 8 }}>Work Location: {reportData.branch}</div>}
        {!reportData && !reportError && <div className="empty">Loading…</div>}
        {reportData && reportData.rows.length === 0 && <div className="empty">No check-ins in this range.</div>}
        {reportData && reportData.rows.length > 0 && (
          <table>
            <thead><tr><th>Date</th><th>First Check-In</th><th>Last Check-Out</th><th>Method</th><th>Location</th><th>Total Hours</th><th>Status</th><th>Logs</th></tr></thead>
            <tbody>{reportData.rows.map((r) => (
              <Fragment key={r.date}>
                <tr>
                  <td>{r.date}</td>
                  <td>{r.first_check_in || '—'}</td>
                  <td>{r.last_check_out || '—'}</td>
                  <td>{r.method || '—'}</td>
                  <td>{r.latitude != null ? (
                    <span className="feature-meta">{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)} <a className="crumb" href={mapLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer">map</a></span>
                  ) : '—'}</td>
                  <td>{r.total_hours || '—'}</td>
                  <td><span className={'status-tag ' + (r.status === 'Checked Out' ? 'present' : 'pending')}>{r.status}</span></td>
                  <td><button onClick={() => setExpandedDate(expandedDate === r.date ? null : r.date)}>{expandedDate === r.date ? 'Hide' : 'View Logs'}</button></td>
                </tr>
                {expandedDate === r.date && (
                  <tr>
                    <td colSpan={8}>
                      <div className="feature-meta">{r.logs.length} punch{r.logs.length === 1 ? '' : 'es'}: {r.logs.join(', ')}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
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
  const [calendarFor, setCalendarFor] = useState(null);
  const [calRefresh, setCalRefresh] = useState(0);
  const [tab, setTab] = useState('dashboard'); // dashboard | biometric | reports | methods
  const [checkInMethods, setCheckInMethods] = useState(null);
  const [empMethods, setEmpMethods] = useState(null);
  const [empMethodFilters, setEmpMethodFilters] = useState({ name: '', department: '' });
  const [allMethods, setAllMethods] = useState([]);

  function load(d, dp) {
    const params = {};
    if (d) params.date = d;
    if (dp) params.department = dp;
    api.get('/attendance/overview', { params }).then((r) => { setOv(r.data); setDate(r.data.date); }).catch(() => setError('Could not load attendance.'));
    api.get('/attendance', { params: d ? { date: d } : {} }).then((r) => setGrid(r.data)).catch(() => {});
  }
  useEffect(() => { load(); api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  function loadCheckInMethods() { api.get('/attendance/methods/all').then((r) => setCheckInMethods(r.data.methods)).catch(() => {}); }
  function loadEmpMethods() {
    const params = {};
    if (empMethodFilters.name) params.name = empMethodFilters.name;
    if (empMethodFilters.department) params.department = empMethodFilters.department;
    api.get('/attendance/checkin-methods/employees', { params }).then((r) => { setEmpMethods(r.data.employees); setAllMethods(r.data.allMethods); }).catch(() => {});
  }
  useEffect(() => { if (tab === 'methods' && isSuperAdmin) { loadCheckInMethods(); loadEmpMethods(); } }, [tab, isSuperAdmin]);
  async function toggleEmployeeMethod(emp, method) {
    const has = emp.methods.includes(method);
    const methods = has ? emp.methods.filter((m) => m !== method) : [...emp.methods, method];
    setEmpMethods((prev) => prev.map((e) => (e.id === emp.id ? { ...e, methods } : e)));
    try { await api.put(`/attendance/checkin-methods/${emp.id}`, { methods }); }
    catch (err) { setError(err.response?.data?.error || 'Could not update assignment.'); loadEmpMethods(); }
  }

  async function decide(id, verb) {
    try { await api.post(`/approvals/${id}/${verb}`); load(date, dept); } catch (err) { setError(err.response?.data?.error || 'Action failed.'); }
  }
  async function mark(employee_id, status) {
    try {
      await api.post('/attendance/mark', { employee_id, date, status });
      load(date, dept);
      setCalRefresh((k) => k + 1); // so an open calendar shows the mark that was just made
    } catch (err) { setError(err.response?.data?.error || 'Could not mark.'); }
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
        <button className={tab === 'punchlog' ? 'primary' : ''} onClick={() => setTab('punchlog')}>Punch Log (Detailed)</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports (Monthly)</button>
        {isSuperAdmin && <button className={tab === 'methods' ? 'primary' : ''} onClick={() => setTab('methods')}>Check-in Methods</button>}
      </div>

      {tab === 'methods' && isSuperAdmin && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Check-in Methods</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>
            Control which attendance methods are available company-wide. Web Check-in and Mobile App are self-service and require a live face-verification capture. Biometric (Fingerprint) is never self-selected from a dropdown — it's punched on a registered device (Integrations) — but it is listed here so you can turn it off company-wide or assign it to specific employees below.
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

      {tab === 'methods' && isSuperAdmin && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="feature-name" style={{ marginBottom: 8 }}>Per-employee assignment</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>
            Restrict a specific employee to a subset of the company-enabled methods above (e.g. Mobile App only, or Biometric only). An employee with no boxes checked is unrestricted and can use any company-enabled method. Checking <strong>only</strong> Biometric (Fingerprint) means they cannot self check-in at all — they must punch on the device.
          </div>
          <div className="filter-bar" style={{ marginBottom: 10 }}>
            <input placeholder="Search name…" value={empMethodFilters.name} onChange={(e) => setEmpMethodFilters({ ...empMethodFilters, name: e.target.value })} />
            <select value={empMethodFilters.department} onChange={(e) => setEmpMethodFilters({ ...empMethodFilters, department: e.target.value })}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <button onClick={loadEmpMethods}>Apply</button>
          </div>
          {!empMethods && <div className="empty">Loading…</div>}
          {empMethods && empMethods.length === 0 && <div className="empty">No employees match this filter.</div>}
          {empMethods && empMethods.map((e) => (
            <div key={e.id} className="rec-row">
              <span>{e.name} ({e.employee_code}) — {e.department}
                <div className="feature-meta">{e.methods.length ? `Restricted to: ${e.methods.join(', ')}` : 'Unrestricted (all company-enabled methods)'}</div>
              </span>
              <span className="row" style={{ gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
                {allMethods.map((m) => (
                  <label key={m} className="row" style={{ gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" checked={e.methods.includes(m)} onChange={() => toggleEmployeeMethod(e, m)} />
                    {m}
                  </label>
                ))}
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
                  <Fragment key={r.employee_id}>
                    <tr>
                      <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td>
                      <td><span className={'status-tag ' + tag(r.status)}>{r.status || 'Not marked'}</span></td>
                      <td>{r.check_in_time || '—'}{!!r.half_day_flag && <span className="status-tag absent" style={{ marginLeft: 6 }} title="Late beyond the free monthly allowance — half-day pay cut">½-day cut</span>}</td>
                      <td>{r.latitude != null ? <a className="crumb" href={mapLink(r.latitude, r.longitude)} target="_blank" rel="noreferrer">📍 map</a> : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn-approve" onClick={() => mark(r.employee_id, 'Present')}>P</button>
                        <button className="btn-reject" style={{ marginLeft: 4 }} onClick={() => mark(r.employee_id, 'Absent')}>A</button>
                        <button style={{ marginLeft: 4 }} onClick={() => mark(r.employee_id, 'Leave')}>L</button>
                        {/* The grid marks one date at a time; the calendar is the same data for the
                            whole month, so you can see what you just marked in context and spot the
                            gaps that Payroll will treat as Loss of Pay. */}
                        <button
                          style={{ marginLeft: 6 }}
                          title={`Show ${r.name}'s month calendar`}
                          onClick={() => setCalendarFor(calendarFor === r.employee_id ? null : r.employee_id)}
                        >{calendarFor === r.employee_id ? '📅 Hide' : '📅 Calendar'}</button>
                      </td>
                    </tr>
                    {calendarFor === r.employee_id && (
                      <tr><td colSpan={7} style={{ background: '#F7F8FA' }}>
                        <AttendanceCalendar
                          employeeId={r.employee_id}
                          employeeLabel={`${r.name}'s`}
                          initialMonth={date ? date.slice(0, 7) : undefined}
                          refreshKey={calRefresh}
                          canMark={canManage}
                        />
                      </td></tr>
                    )}
                  </Fragment>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'biometric' && <BiometricList />}
      {tab === 'punchlog' && <PunchLog />}
      {tab === 'reports' && <MonthlyReports />}
    </div>
  );
}

function BiometricList() {
  const [date, setDate] = useState('');
  const [empId, setEmpId] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [designation, setDesignation] = useState('');
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  function filterParams(f) {
    const { date: d = date, employeeCode = empId, name: n = name, department = dept, designation: r = designation } = f || {};
    return { date: d || undefined, employeeCode: employeeCode || undefined, name: n || undefined, department: department || undefined, designation: r || undefined };
  }
  function load(f) { api.get('/attendance/biometric-list', { params: filterParams(f) }).then((r) => setData(r.data)).catch(() => setError('Could not load biometric list.')); }
  useEffect(() => {
    load();
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/roles').then((r) => setRoles(r.data.roles)).catch(() => {});
  }, []);

  function clearFilters() { setDate(''); setEmpId(''); setName(''); setDept(''); setDesignation(''); load({ date: '', employeeCode: '', name: '', department: '', designation: '' }); }

  async function exportCsv() {
    const res = await api.get('/attendance/biometric-list/export', { params: filterParams(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-biometric-${data?.date || data?.month || 'export'}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function exportExcel() {
    const res = await api.get('/attendance/biometric-list/export.xlsx', { params: filterParams(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-biometric-${data?.date || data?.month || 'export'}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="feature-name">Biometric &amp; Device Attendance — Employee List {data && <span className="note">({data.date || data.month})</span>}</div>
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={exportCsv}>Export</button>
        <button onClick={exportExcel}>Export (Excel)</button>
      </div>
      <div className="filter-bar" style={{ marginTop: 10, marginBottom: 8 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
        <input placeholder="Employee ID" value={empId} onChange={(e) => setEmpId(e.target.value)} style={{ width: 140 }} />
        <input placeholder="Employee name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <select value={designation} onChange={(e) => setDesignation(e.target.value)}>
          <option value="">All Roles</option>
          {roles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
        </select>
        <button onClick={() => load()}>Filter</button>
        {(date || empId || name || dept || designation) && <button onClick={clearFilters}>Clear</button>}
      </div>
      {!date && <div className="feature-meta" style={{ marginBottom: 8 }}>Showing each employee's last-ever punch. Pick a date above to see that specific day's biometric report instead.</div>}
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <div className="empty">Loading...</div>}
      {data && (
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Role</th><th>Method</th><th>{date ? 'Last punch (day)' : 'Last punch (ever)'}</th>{date && <th>Punch Count</th>}<th>Check-in</th><th>Check-out</th><th>Location</th><th>Present (month)</th><th>Late (month)</th><th>Half-day Cut (month)</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.employee_id}>
              <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td><td>{r.designation || '—'}</td>
              <td>{r.last_method || '—'}</td>
              <td>{r.last_punch || '—'}</td>
              {date && <td>{r.punch_count ?? 0}</td>}
              <td>{r.check_in || '—'}</td>
              <td>{r.check_out || '—'}</td>
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
  const [empId, setEmpId] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [designation, setDesignation] = useState('');
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [calendarFor, setCalendarFor] = useState(null); // the employee row currently showing its calendar

  function filterParams(m, f) {
    const { employeeCode = empId, name: n = name, department = dept, designation: r = designation } = f || {};
    return { month: m, employeeCode: employeeCode || undefined, name: n || undefined, department: department || undefined, designation: r || undefined };
  }
  function load(m, f) { api.get('/attendance/monthly-report', { params: filterParams(m, f) }).then((r) => setData(r.data)).catch(() => setError('Could not load report.')); }
  useEffect(() => {
    load(month);
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/roles').then((r) => setRoles(r.data.roles)).catch(() => {});
  }, []);

  function clearFilters() { setEmpId(''); setName(''); setDept(''); setDesignation(''); load(month, { employeeCode: '', name: '', department: '', designation: '' }); }

  async function exportCsv() {
    const res = await api.get('/attendance/monthly-report/export', { params: filterParams(month), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-monthly-${month}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function exportExcel() {
    const res = await api.get('/attendance/monthly-report/export.xlsx', { params: filterParams(month), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-monthly-${month}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }
  async function exportOneCsv(r) {
    const res = await api.get('/attendance/monthly-report/export', { params: { month, id: r.id }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-monthly-${month}-${r.employee_code || r.name}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="feature-name">Monthly Attendance Report</div>
        <div style={{ flex: 1 }} />
        <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); load(e.target.value); }} style={{ width: 'auto' }} />
        <button className="primary" onClick={exportCsv}>Export</button>
        <button onClick={exportExcel}>Export (Excel)</button>
      </div>
      <div className="filter-bar" style={{ marginTop: 10 }}>
        <input placeholder="Employee ID" value={empId} onChange={(e) => setEmpId(e.target.value)} style={{ width: 140 }} />
        <input placeholder="Employee name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <select value={designation} onChange={(e) => setDesignation(e.target.value)}>
          <option value="">All Roles</option>
          {roles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
        </select>
        <button onClick={() => load(month)}>Filter</button>
        {(empId || name || dept || designation) && <button onClick={clearFilters}>Clear</button>}
      </div>
      {error && <div className="banner error">{error}</div>}
      {data && (
        <>
          <div className="note" style={{ marginTop: 8 }}>Grace time 9:15 AM · {data.freeLateAllowance} free late arrival(s)/month, then each late day is flagged with an automatic half-day pay cut.</div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Role</th><th>Present</th><th>Absent</th><th>Leave</th><th>Late</th><th>Half-day Cut</th><th>Attendance %</th><th></th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>{r.employee_code}</td><td>{r.name}</td><td>{r.department}</td><td>{r.designation || '—'}</td>
                  <td>{r.present}</td><td>{r.absent}</td><td>{r.leave}</td><td>{r.late}</td>
                  <td>{r.halfDayCut > 0 ? <span className="status-tag absent">{r.halfDayCut}</span> : 0}</td>
                  <td><strong>{r.attendancePct}%</strong></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => setCalendarFor(calendarFor === r.id ? null : r.id)}>{calendarFor === r.id ? 'Hide calendar' : 'Calendar'}</button>{' '}
                    <button onClick={() => exportOneCsv(r)}>Export</button>
                  </td>
                </tr>
                {calendarFor === r.id && (
                  <tr>
                    <td colSpan={11}><AttendanceCalendar employeeId={r.id} employeeLabel={r.name} /></td>
                  </tr>
                )}
              </Fragment>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function PunchLog() {
  const todayStr = new Date().toISOString().slice(0, 10);
  // From/To are the date filter — set both to the same day for a single-day log (the default).
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [empId, setEmpId] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [designation, setDesignation] = useState('');
  const [status, setStatus] = useState('');
  const [departments, setDepartments] = useState([]);
  const [roles, setRoles] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  function filterParams(f) {
    const { from: fr = from, to: t = to, employeeCode = empId, name: n = name, department = dept, designation: r = designation, status: s = status } = f || {};
    return { from: fr || undefined, to: t || undefined, employeeCode: employeeCode || undefined, name: n || undefined, department: department || undefined, designation: r || undefined, status: s || undefined };
  }
  function load(f) { api.get('/attendance/punch-log', { params: filterParams(f) }).then((r) => setData(r.data)).catch(() => setError('Could not load punch log.')); }
  useEffect(() => {
    load();
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/roles').then((r) => setRoles(r.data.roles)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearFilters() {
    setFrom(todayStr); setTo(todayStr); setEmpId(''); setName(''); setDept(''); setDesignation(''); setStatus('');
    load({ from: todayStr, to: todayStr, employeeCode: '', name: '', department: '', designation: '', status: '' });
  }

  const rangeLabel = data ? (data.from === data.to ? data.from : `${data.from} to ${data.to}`) : '';
  const fileLabel = data ? (data.from === data.to ? data.from : `${data.from}_to_${data.to}`) : 'export';

  async function exportCsv() {
    const res = await api.get('/attendance/punch-log/export', { params: filterParams(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-punch-log-${fileLabel}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function exportExcel() {
    const res = await api.get('/attendance/punch-log/export.xlsx', { params: filterParams(), responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = `attendance-punch-log-${fileLabel}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="feature-name">Punch Log — Check-In / Check-Out Times {data && <span className="note">({rangeLabel})</span>}</div>
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={exportCsv}>Export</button>
        <button onClick={exportExcel}>Export (Excel)</button>
      </div>
      <div className="filter-bar" style={{ marginTop: 10, marginBottom: 8 }}>
        <label className="feature-meta" style={{ alignSelf: 'center' }}>From</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
        <label className="feature-meta" style={{ alignSelf: 'center' }}>To</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
        <input placeholder="Employee ID" value={empId} onChange={(e) => setEmpId(e.target.value)} style={{ width: 140 }} />
        <input placeholder="Employee name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <select value={designation} onChange={(e) => setDesignation(e.target.value)}>
          <option value="">All Roles</option>
          {roles.map((r) => <option key={r.key} value={r.name}>{r.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Checked In &amp; Checked Out</option>
          <option value="checked_in">Checked In only (no check-out yet)</option>
          <option value="checked_out">Checked Out (complete)</option>
        </select>
        <button className="primary" onClick={() => load()}>Filter</button>
        <button onClick={clearFilters}>Clear</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <div className="empty">Loading...</div>}
      {data && data.rows.length === 0 && <div className="empty">No punches recorded for {rangeLabel}.</div>}
      {data && data.rows.length > 0 && (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Employee</th><th>Department</th><th>Role</th><th>Date</th><th>Method</th><th>Status</th>
              <th>Check-In Times</th><th>Check-Out Times</th>
              <th>First In</th><th>Last Out</th><th>Worked Span</th><th>Punches</th>
            </tr>
          </thead>
          <tbody>{data.rows.map((r) => (
            <tr key={`${r.employee_id}-${r.date}`}>
              <td>{r.employee_code} - {r.name}</td>
              <td>{r.department}</td>
              <td>{r.designation || '—'}</td>
              <td>{r.date}</td>
              <td>{r.method}</td>
              <td><span className={'status-tag ' + (r.status === 'Checked Out' ? 'present' : 'pending')}>{r.status}</span></td>
              <td style={{ fontFamily: 'monospace', textAlign: 'left' }}>
                {r.check_ins.length ? r.check_ins.join(', ') : '—'}
                {r.check_ins.length > 0 && <div className="feature-meta">{r.check_in_count} check-in{r.check_in_count === 1 ? '' : 's'}</div>}
                {r.unclassified.length > 0 && <div className="feature-meta" style={{ color: '#B3401E' }}>Unclassified: {r.unclassified.join(', ')}</div>}
              </td>
              <td style={{ fontFamily: 'monospace', textAlign: 'left' }}>
                {r.check_outs.length ? r.check_outs.join(', ') : '—'}
                {r.check_outs.length > 0 && <div className="feature-meta">{r.check_out_count} check-out{r.check_out_count === 1 ? '' : 's'}</div>}
              </td>
              <td style={{ fontFamily: 'monospace' }}>{r.first_check_in || '—'}</td>
              <td style={{ fontFamily: 'monospace' }}>{r.last_check_out || '—'}</td>
              <td style={{ fontFamily: 'monospace' }}>{r.worked_span || '—'}</td>
              <td>{r.punch_count}</td>
            </tr>
          ))}</tbody>
        </table>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own roster.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own roster
// (EmployeeView) AND the company roster below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
// Assistant Manager/STL/TL are limited to viewing their assigned department(s)' roster and
// shift-swap requests — per Super Admin policy, no create/edit/pause/assign/approve actions
// here unless explicitly granted. Shift Swap Approval is not one of the 4 workflow approvals
// (Leave/Attendance/Expense/Timesheet) carved out for these roles, so it stays blocked too.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const today = () => new Date().toISOString().slice(0, 10);

export default function ShiftRoster() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRView />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) {
    return (<><EmployeeView compact /><HRView compact sectionLabel="Company Shift & Roster" /></>);
  }
  return <EmployeeView />;
}

function HRView({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [shifts, setShifts] = useState([]);
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [swaps, setSwaps] = useState([]);
  const [error, setError] = useState('');
  const [shiftForm, setShiftForm] = useState({ name: '', start_time: '', end_time: '' });
  const [showShiftForm, setShowShiftForm] = useState(false);

  function loadShifts() { api.get('/shift-roster/shifts').then((r) => setShifts(r.data.shifts)).catch(() => {}); }
  function loadRoster() { api.get('/shift-roster/roster', { params: { date } }).then((r) => setRows(r.data.rows)).catch(() => setError('Could not load roster.')); }
  function loadSwaps() { api.get('/shift-roster/swap-requests').then((r) => setSwaps(r.data.requests)).catch(() => {}); }
  useEffect(loadShifts, []);
  useEffect(loadRoster, [date]);
  useEffect(loadSwaps, []);

  async function addShift(e) {
    e.preventDefault(); setError('');
    try { await api.post('/shift-roster/shifts', shiftForm); setShiftForm({ name: '', start_time: '', end_time: '' }); setShowShiftForm(false); loadShifts(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add shift.'); }
  }
  async function toggleShift(s) {
    try { await api.put(`/shift-roster/shifts/${s.id}`, { status: s.status === 'Active' ? 'Paused' : 'Active' }); loadShifts(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function assign(employeeId, shiftId) {
    if (!shiftId) return;
    try { await api.post('/shift-roster/roster', { employee_id: employeeId, shift_id: shiftId, date }); loadRoster(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign shift.'); }
  }
  async function decideSwap(id, decision) {
    try { await api.put(`/shift-roster/swap-requests/${id}/${decision}`); loadSwaps(); loadRoster(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Shift & Roster'}</div> : <h1>Shift &amp; Roster</h1>}
      {!compact && <div className="subtitle">Define shift patterns, assign employees per date, and manage shift-swap requests.</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="feature-name" style={{ marginBottom: 8 }}>Shift Patterns</div>
        {shifts.map((s) => (
          <div key={s.id} className="rec-row" style={{ opacity: s.status === 'Paused' ? 0.6 : 1 }}>
            <span><strong>{s.name}</strong> — {s.start_time} to {s.end_time}</span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (s.status === 'Active' ? 'present' : 'locked')}>{s.status}</span>
              {canManage && <button onClick={() => toggleShift(s)}>{s.status === 'Active' ? 'Pause' : 'Resume'}</button>}
            </span>
          </div>
        ))}
        {canManage && (showShiftForm ? (
          <form onSubmit={addShift} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <input placeholder="Shift name" value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} required style={{ flex: '1 1 140px' }} />
            <input type="time" value={shiftForm.start_time} onChange={(e) => setShiftForm({ ...shiftForm, start_time: e.target.value })} required style={{ flex: '1 1 100px' }} />
            <input type="time" value={shiftForm.end_time} onChange={(e) => setShiftForm({ ...shiftForm, end_time: e.target.value })} required style={{ flex: '1 1 100px' }} />
            <button className="primary" type="submit">Add</button>
            <button type="button" onClick={() => setShowShiftForm(false)}>Cancel</button>
          </form>
        ) : <button style={{ marginTop: 10 }} onClick={() => setShowShiftForm(true)}>+ Add Shift</button>)}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="feature-name">Roster</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {rows.map((r) => (
          <div key={r.employee_id} className="rec-row">
            <span>{r.name} <span className="feature-meta">({r.employee_code} · {r.department})</span></span>
            {canManage ? (
              <select value={r.shift_id || ''} onChange={(e) => assign(r.employee_id, e.target.value)}>
                <option value="">Unassigned</option>
                {shifts.filter((s) => s.status === 'Active').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : (
              <span className="feature-meta">{r.shift_name || 'Unassigned'}</span>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Shift Swap Requests</div>
        {swaps.length === 0 && <div className="empty">No swap requests.</div>}
        {swaps.map((s) => (
          <div key={s.id} className="rec-row">
            <span>{s.requester_name} wants to swap on {s.date}{s.target_name ? ` with ${s.target_name}` : ''}
              {s.reason && <div className="feature-meta">{s.reason}</div>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <span className={'status-tag ' + (s.status === 'Pending' ? 'pending' : s.status === 'Approved' ? 'present' : 'absent')}>{s.status}</span>
              {s.status === 'Pending' && canManage && <>
                <button onClick={() => decideSwap(s.id, 'approve')}>Approve</button>
                <button onClick={() => decideSwap(s.id, 'reject')}>Reject</button>
              </>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmployeeView({ compact }) {
  const [rows, setRows] = useState([]);
  const [swaps, setSwaps] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ date: '', reason: '' });
  const [showForm, setShowForm] = useState(false);

  function load() {
    api.get('/shift-roster/roster/mine').then((r) => setRows(r.data.rows)).catch(() => setError('Could not load your roster.'));
    api.get('/shift-roster/swap-requests').then((r) => setSwaps(r.data.requests)).catch(() => {});
  }
  useEffect(load, []);

  async function requestSwap(e) {
    e.preventDefault(); setError('');
    if (!form.date) { setError('Pick a date.'); return; }
    try { await api.post('/shift-roster/swap-requests', form); setForm({ date: '', reason: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit request.'); }
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Roster</div> : <h1>My Roster</h1>}
      {!compact && <div className="subtitle">Your upcoming shift assignments.</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        {rows.length === 0 && <div className="empty">No upcoming shifts assigned.</div>}
        {rows.map((r, i) => (
          <div key={i} className="rec-row">
            <span>{r.date}</span>
            <span>{r.shift_name} ({r.start_time}–{r.end_time})</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Shift Swap Requests</div>
        {swaps.map((s) => (
          <div key={s.id} className="rec-row">
            <span>{s.date}{s.reason && ` — ${s.reason}`}</span>
            <span className={'status-tag ' + (s.status === 'Pending' ? 'pending' : s.status === 'Approved' ? 'present' : 'absent')}>{s.status}</span>
          </div>
        ))}
        {showForm ? (
          <form onSubmit={requestSwap} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            <input placeholder="Reason (optional)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} style={{ flex: '1 1 160px' }} />
            <button className="primary" type="submit">Request Swap</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        ) : <button style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>+ Request Shift Swap</button>}
      </div>
    </div>
  );
}

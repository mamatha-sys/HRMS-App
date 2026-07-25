import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { bottomRole, approvalChainLabel } from '../utils/chain.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const today = () => db.prepare("SELECT date('now') AS d").get().d;
// Company rule: General shift is 9:00 AM – 6:00 PM with a grace period until 9:15.
const LATE_AFTER = '09:15';

export function freeLateAllowance() {
  const row = db.prepare("SELECT value FROM policies WHERE name = 'Free late arrivals per month'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

// Recomputes half_day_flag for every late day this month for one employee, in date order,
// so the (allowance+1)-th late arrival onward is flagged for an automatic payroll deduction.
// Re-run after every check-in so corrections (e.g. HR editing a time) stay consistent.
function recomputeLateFlags(employeeId, month) {
  const allowance = freeLateAllowance();
  const lateRows = db.prepare('SELECT id FROM attendance WHERE employee_id = ? AND date LIKE ? AND check_in_time > ? ORDER BY date')
    .all(employeeId, month + '%', LATE_AFTER);
  const update = db.prepare('UPDATE attendance SET half_day_flag = ? WHERE id = ?');
  lateRows.forEach((r, idx) => update.run(idx >= allowance ? 1 : 0, r.id));
}

const SCOPE_BANNER = {
  super_admin: 'Full, unrestricted access — configures the escalation window itself, organization-wide.',
  hr_admin: 'Company-wide attendance — mark, regularize and export across all departments.',
  manager: 'Team/organization attendance — mark and approve regularizations.',
  assistant_manager: 'Team/organization attendance — mark and approve regularizations.'
};

// HR overview: KPIs + biometric check-in/out report + regularization queue.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const date = req.query.date || today();
  const dept = req.query.department || null;

  const rows = db.prepare(`
    SELECT e.department, a.status, a.check_in_time, a.check_out_time, a.method, a.half_day_flag
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = @date
    WHERE (@dept IS NULL OR e.department = @dept)
  `).all({ date, dept });

  const present = rows.filter((r) => r.status === 'Present').length;
  const absent = rows.filter((r) => r.status === 'Absent').length;
  const late = rows.filter((r) => r.check_in_time && r.check_in_time > LATE_AFTER).length;
  const halfDayCut = rows.filter((r) => r.half_day_flag).length;
  const missingPunch = rows.filter((r) => r.status === 'Present' && !r.check_in_time).length;
  const checkedIn = rows.filter((r) => r.check_in_time).length;
  const checkedOut = rows.filter((r) => r.check_out_time).length;

  const methods = {};
  rows.forEach((r) => {
    const m = r.method || 'Web Check-in';
    methods[m] = methods[m] || { method: m, in: 0, out: 0 };
    if (r.check_in_time) methods[m].in++;
    if (r.check_out_time) methods[m].out++;
  });

  const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
  const regularizations = db.prepare("SELECT * FROM approvals WHERE type = 'Regularization' ORDER BY (status='Pending') DESC, created_at DESC LIMIT 10")
    .all().map((r) => ({ ...r, current_stage_name: roleNameOf(r.current_stage_role_id) }));

  res.json({
    date,
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Present Today', value: present, color: 'blue' },
      { label: 'Absent Today', value: absent, color: 'red' },
      { label: 'Late Check-in', value: late, color: 'gold' },
      { label: 'Half-day Cut', value: halfDayCut, color: 'red' },
      { label: 'Missing Punch-in', value: missingPunch, color: 'gold' }
    ],
    biometric: { checkedIn, checkedOut, methods: Object.values(methods) },
    regularizations,
    chainLabel: approvalChainLabel()
  });
});

// HR: per-employee biometric/device attendance list — last check-in method/time/location
// plus this month's present & late counts, so HR can see who's on which device.
router.get('/biometric-list', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const monthPrefix = db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;

  const employees = db.prepare('SELECT id, employee_code, name, department FROM employees ORDER BY id').all();
  const rows = employees.map((e) => {
    const last = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND check_in_time IS NOT NULL ORDER BY date DESC LIMIT 1').get(e.id);
    const monthRows = db.prepare("SELECT status, check_in_time, half_day_flag FROM attendance WHERE employee_id = ? AND date LIKE ?").all(e.id, monthPrefix + '%');
    const presentDays = monthRows.filter((r) => r.status === 'Present').length;
    const lateDays = monthRows.filter((r) => r.check_in_time && r.check_in_time > LATE_AFTER).length;
    const halfDayCutDays = monthRows.filter((r) => r.half_day_flag).length;
    return {
      employee_id: e.id, employee_code: e.employee_code, name: e.name, department: e.department,
      last_method: last?.method || null, last_check_in: last ? `${last.date} ${last.check_in_time}` : null,
      last_location: last?.latitude != null ? { lat: last.latitude, lng: last.longitude } : null,
      present_days_month: presentDays, late_days_month: lateDays, half_day_cut_days_month: halfDayCutDays
    };
  });
  res.json({ month: monthPrefix, rows });
});

// HR monthly attendance report — present/absent/leave/late counts + attendance % per employee.
router.get('/monthly-report', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
  const daysInMonth = db.prepare("SELECT CAST(strftime('%d', date(?  || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(month).d;

  const employees = db.prepare('SELECT id, employee_code, name, department FROM employees ORDER BY id').all();
  const rows = employees.map((e) => {
    const marks = db.prepare('SELECT status, check_in_time, half_day_flag FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, month + '%');
    const present = marks.filter((m) => m.status === 'Present').length;
    const absent = marks.filter((m) => m.status === 'Absent').length;
    const leave = marks.filter((m) => m.status === 'Leave').length;
    const late = marks.filter((m) => m.check_in_time && m.check_in_time > LATE_AFTER).length;
    const halfDayCut = marks.filter((m) => m.half_day_flag).length;
    const attendancePct = daysInMonth > 0 ? Math.round((present / daysInMonth) * 100) : 0;
    return { ...e, present, absent, leave, late, halfDayCut, attendancePct };
  });
  res.json({ month, daysInMonth, rows, freeLateAllowance: freeLateAllowance() });
});

router.get('/monthly-report/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
  const employees = db.prepare('SELECT id, employee_code, name, department FROM employees ORDER BY id').all();
  const rows = employees.map((e) => {
    const marks = db.prepare('SELECT status, check_in_time, half_day_flag FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, month + '%');
    return {
      ...e,
      present: marks.filter((m) => m.status === 'Present').length,
      absent: marks.filter((m) => m.status === 'Absent').length,
      leave: marks.filter((m) => m.status === 'Leave').length,
      late: marks.filter((m) => m.check_in_time && m.check_in_time > LATE_AFTER).length,
      halfDayCut: marks.filter((m) => m.half_day_flag).length
    };
  });
  const csv = ['code,name,department,present,absent,leave,late,half_day_cut', ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.present},${r.absent},${r.leave},${r.late},${r.halfDayCut}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-monthly-${month}.csv"`);
  res.send(csv);
});

// HR: everyone's attendance for a date. Employee: own recent history.
router.get('/', (req, res) => {
  if (isHR(req.user.role)) {
    const date = req.query.date || today();
    const rows = db.prepare(`
      SELECT e.id AS employee_id, e.employee_code, e.name, e.department,
             a.status, a.check_in_time, a.check_out_time, a.method, a.latitude, a.longitude, a.half_day_flag
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
      ORDER BY e.id
    `).all(date);
    const present = rows.filter((r) => r.status === 'Present').length;
    const absent = rows.filter((r) => r.status === 'Absent').length;
    const onLeave = rows.filter((r) => r.status === 'Leave').length;
    return res.json({ date, rows, summary: { present, absent, onLeave, unmarked: rows.length - present - absent - onLeave } });
  }
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ rows: [], me: null });
  const rows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 30').all(me.id);
  const todays = rows.find((r) => r.date === today()) || null;
  const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
  const regularizations = db.prepare("SELECT * FROM approvals WHERE type = 'Regularization' AND requester = ? ORDER BY created_at DESC").all(me.name)
    .map((r) => ({ ...r, current_stage_name: roleNameOf(r.current_stage_role_id) }));
  res.json({ rows, today: todays, me: { id: me.id, name: me.name, employee_code: me.employee_code }, regularizations, chainLabel: approvalChainLabel() });
});

function upsertToday(employeeId, patch) {
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, today());
  if (existing) {
    const merged = { ...existing, ...patch };
    db.prepare('UPDATE attendance SET status = @status, check_in_time = @check_in_time, check_out_time = @check_out_time, method = @method, latitude = @latitude, longitude = @longitude WHERE id = @id').run(merged);
    return db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
  }
  const row = { employee_id: employeeId, date: today(), status: 'Present', check_in_time: null, check_out_time: null, method: 'Web Check-in', latitude: null, longitude: null, ...patch };
  const info = db.prepare('INSERT INTO attendance (employee_id, date, status, check_in_time, check_out_time, method, latitude, longitude) VALUES (@employee_id, @date, @status, @check_in_time, @check_out_time, @method, @latitude, @longitude)').run(row);
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(info.lastInsertRowid);
}

const METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)', 'Face Recognition'];

function validCoord(v) { return typeof v === 'number' && Number.isFinite(v); }

router.post('/check-in', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (existing?.check_in_time) return res.status(400).json({ error: 'Already checked in today at ' + existing.check_in_time });
  const method = METHODS.includes(req.body?.method) ? req.body.method : 'Web Check-in';
  const latitude = validCoord(req.body?.latitude) ? req.body.latitude : null;
  const longitude = validCoord(req.body?.longitude) ? req.body.longitude : null;
  const attendance = upsertToday(me.id, { status: 'Present', check_in_time: nowTime(), method, latitude, longitude });
  recomputeLateFlags(me.id, today().slice(0, 7));
  res.json({ attendance: db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendance.id) });
});

router.post('/check-out', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (!existing?.check_in_time) return res.status(400).json({ error: 'Check in first.' });
  if (existing.check_out_time) return res.status(400).json({ error: 'Already checked out at ' + existing.check_out_time });
  res.json({ attendance: upsertToday(me.id, { check_out_time: nowTime() }) });
});

// HR marks an employee's attendance for a date.
router.post('/mark', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, date, status } = req.body || {};
  if (!employee_id || !['Present', 'Absent', 'Leave'].includes(status)) return res.status(400).json({ error: 'employee_id and a valid status are required' });
  const d = date || today();
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employee_id, d);
  if (existing) db.prepare('UPDATE attendance SET status = ? WHERE id = ?').run(status, existing.id);
  else db.prepare('INSERT INTO attendance (employee_id, date, status) VALUES (?, ?, ?)').run(employee_id, d, status);
  res.json({ ok: true });
});

// CSV export of a date's attendance (HR).
router.get('/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const date = req.query.date || today();
  const rows = db.prepare(`
    SELECT e.employee_code, e.name, e.department, COALESCE(a.status,'Not marked') status, COALESCE(a.check_in_time,'') check_in, COALESCE(a.check_out_time,'') check_out, COALESCE(a.method,'') method, COALESCE(a.half_day_flag,0) half_day_flag
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ? ORDER BY e.id
  `).all(date);
  const csv = ['code,name,department,status,check_in,check_out,method,half_day_cut',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.status},${r.check_in},${r.check_out},${r.method},${r.half_day_flag ? 1 : 0}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.csv"`);
  res.send(csv);
});

// Employee raises a regularization request (routed through the shared approvals queue).
router.post('/regularize', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { date, reason } = req.body || {};
  if (!date || !reason) return res.status(400).json({ error: 'date and reason are required' });
  const stage = bottomRole();
  db.prepare('INSERT INTO approvals (type, requester, detail, current_stage_role_id) VALUES (?, ?, ?, ?)')
    .run('Regularization', me.name, `${date}: ${reason}`, stage ? stage.id : null);
  res.status(201).json({ ok: true });
});

export default router;

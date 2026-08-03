import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, filterToScope } from '../utils/scope.js';
import { bottomRole, approvalChainLabel } from '../utils/chain.js';
import { nowTime, today, LATE_AFTER, METHODS, freeLateAllowance, recomputeLateFlags, upsertAttendanceForDate, enabledMethods, isMethodEnabled, setMethodEnabled, notifyIfLate, notifyIfEarlyLogout, notifyAttendanceGaps } from '../utils/attendanceCore.js';
import { isValidDescriptor, euclideanDistance, FACE_MATCH_THRESHOLD } from '../utils/face.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '07' (Attendance & Time Tracking). A Senior Team
// Lead/Team Lead/Assistant Manager also passes: every READ route below already fetches-then-
// filters via filterToScope, so admitting them here only ever narrows to their assigned
// departments/teams, never widens to company-wide. Write actions (e.g. /mark) intentionally
// check canModuleAdmin directly instead of this isHR, so scoped roles stay view/approval-only.
const isHR = (role) => canModuleAdmin(role, '07') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

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

  let rows = db.prepare(`
    SELECT e.department, e.team_id, a.status, a.check_in_time, a.check_out_time, a.method, a.half_day_flag
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = @date
    WHERE (@dept IS NULL OR e.department = @dept)
  `).all({ date, dept });
  rows = filterToScope(rows, req.user.role, myEmployee(req.user.sub)?.id);

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
  // The `approvals` table records the requester by name only (no employee_id/department column)
  // — same convention as approvals.routes.js. Enrich with the requester's department/team so a
  // scoped STL/TL only ever sees regularization requests from their own assigned people here too.
  const employeeByName = (name) => db.prepare('SELECT department, team_id FROM employees WHERE name = ?').get(name);
  // A department can be split into teams (e.g. Education's Team-A/Team-B) — surface which team
  // the requester belongs to so an STL overseeing both teams can tell them apart at a glance.
  const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);
  let regularizations = db.prepare("SELECT * FROM approvals WHERE type = 'Regularization' ORDER BY (status='Pending') DESC, created_at DESC")
    .all().map((r) => ({ ...r, ...(employeeByName(r.requester) || {}) }));
  regularizations = filterToScope(regularizations, req.user.role, myEmployee(req.user.sub)?.id)
    .slice(0, 10)
    .map((r) => ({ ...r, team_name: teamNameOf(r.team_id), current_stage_name: roleNameOf(r.current_stage_role_id) }));

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

  const employees = filterToScope(
    db.prepare('SELECT id, employee_code, name, department, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  );
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

  const employees = filterToScope(
    db.prepare('SELECT id, employee_code, name, department, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  );
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
  const employees = filterToScope(
    db.prepare('SELECT id, employee_code, name, department, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  );
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
    let rows = db.prepare(`
      SELECT e.id AS employee_id, e.employee_code, e.name, e.department, e.team_id,
             a.status, a.check_in_time, a.check_out_time, a.method, a.latitude, a.longitude, a.half_day_flag
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
      ORDER BY e.id
    `).all(date);
    rows = filterToScope(rows, req.user.role, myEmployee(req.user.sub)?.id);
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

// Always "my own" recent history + regularizations, regardless of role — a Senior Team Lead/
// Team Lead is an employee too and needs their own record here, not the company/team-wide grid
// that GET / above returns for them once isHR admits scoped roles.
router.get('/mine', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ rows: [], me: null });
  notifyAttendanceGaps(me.id); // catches a missed checkout/check-in even on days they don't check in again
  const rows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC LIMIT 30').all(me.id);
  const todays = rows.find((r) => r.date === today()) || null;
  const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
  // Whoever actually decided this (approvals.decided_by is just a users.id) — resolved to their
  // account name so the employee can see e.g. "Approved by Priya Manager", not just a status tag.
  const decidedByName = (userId) => (userId ? db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name : null);
  const regularizations = db.prepare("SELECT * FROM approvals WHERE type = 'Regularization' AND requester = ? ORDER BY created_at DESC").all(me.name)
    .map((r) => ({ ...r, current_stage_name: roleNameOf(r.current_stage_role_id), decided_by_name: decidedByName(r.decided_by) }));

  // This month's own Present/Late/Half-day-cut/Missing-punch counts + attendance % — same formula
  // as the HR-only monthly report (present ÷ days in month), just scoped to the calling employee.
  const month = today().slice(0, 7);
  const daysInMonth = db.prepare("SELECT CAST(strftime('%d', date(? || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(month).d;
  const monthRows = db.prepare('SELECT status, check_in_time, half_day_flag FROM attendance WHERE employee_id = ? AND date LIKE ?').all(me.id, month + '%');
  const summary = {
    month,
    present: monthRows.filter((m) => m.status === 'Present').length,
    absent: monthRows.filter((m) => m.status === 'Absent').length,
    late: monthRows.filter((m) => m.check_in_time && m.check_in_time > LATE_AFTER).length,
    halfDayCut: monthRows.filter((m) => m.half_day_flag).length,
    missingPunch: monthRows.filter((m) => m.status === 'Present' && !m.check_in_time).length,
    attendancePct: daysInMonth > 0 ? Math.round((monthRows.filter((m) => m.status === 'Present').length / daysInMonth) * 100) : 0
  };

  res.json({ rows, today: todays, me: { id: me.id, name: me.name, employee_code: me.employee_code }, regularizations, chainLabel: approvalChainLabel(), summary });
});

const upsertToday = (employeeId, patch) => upsertAttendanceForDate(employeeId, today(), patch);

function validCoord(v) { return typeof v === 'number' && Number.isFinite(v); }

// Both selectable methods (Web Check-in, Mobile App) require a live face-verification capture —
// first successful check-in enrolls the employee's face on their login account (same account
// doing the check-in), every check-in after that must match it. This is a separate enrollment
// from anything login-related; it just happens to reuse the same users.face_descriptor column.
router.post('/check-in', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (existing?.check_in_time) return res.status(400).json({ error: 'Already checked in today at ' + existing.check_in_time });

  const method = METHODS.includes(req.body?.method) ? req.body.method : METHODS[0];
  if (!isMethodEnabled(method)) return res.status(400).json({ error: `${method} has been disabled by your administrator.` });

  const faceDescriptor = req.body?.faceDescriptor;
  if (!isValidDescriptor(faceDescriptor)) return res.status(400).json({ error: 'Face verification is required to check in.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  let faceJustEnrolled = false;
  if (!user.face_descriptor) {
    db.prepare('UPDATE users SET face_descriptor = ? WHERE id = ?').run(JSON.stringify(faceDescriptor), user.id);
    faceJustEnrolled = true;
  } else {
    const distance = euclideanDistance(JSON.parse(user.face_descriptor), faceDescriptor);
    if (distance > FACE_MATCH_THRESHOLD) return res.status(401).json({ error: 'Face verification failed — this does not match your enrolled face.' });
  }

  const latitude = validCoord(req.body?.latitude) ? req.body.latitude : null;
  const longitude = validCoord(req.body?.longitude) ? req.body.longitude : null;
  const attendance = upsertToday(me.id, { status: 'Present', check_in_time: nowTime(), method, latitude, longitude });
  recomputeLateFlags(me.id, today().slice(0, 7));
  notifyIfLate(me.id, attendance);
  notifyAttendanceGaps(me.id); // e.g. yesterday's missed checkout, surfaced right when they check in again
  res.json({ attendance: db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendance.id), faceJustEnrolled });
});

// The check-in dropdown's options — only methods Super Admin has left enabled.
router.get('/methods', (req, res) => {
  res.json({ methods: enabledMethods() });
});

// Super Admin: every method with its enabled state, for the admin toggle screen.
router.get('/methods/all', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ methods: METHODS.map((m) => ({ method: m, enabled: isMethodEnabled(m) })) });
});

router.put('/methods/:method', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Insufficient permissions' });
  const method = decodeURIComponent(req.params.method);
  if (!METHODS.includes(method)) return res.status(404).json({ error: 'Unknown check-in method' });
  setMethodEnabled(method, !!req.body?.enabled);
  res.json({ methods: METHODS.map((m) => ({ method: m, enabled: isMethodEnabled(m) })) });
});

router.post('/check-out', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (!existing?.check_in_time) return res.status(400).json({ error: 'Check in first.' });
  if (existing.check_out_time) return res.status(400).json({ error: 'Already checked out at ' + existing.check_out_time });
  const attendance = upsertToday(me.id, { check_out_time: nowTime() });
  notifyIfEarlyLogout(me.id, attendance);
  res.json({ attendance });
});

// HR marks an employee's attendance for a date. Deliberately NOT admitting isScopedRole here —
// marking attendance edits someone else's record, which is a step beyond the view + workflow-
// approval access Assistant Manager/STL/TL are limited to; only a real Manage Roles grant opens it.
router.post('/mark', (req, res) => {
  if (!canModuleAdmin(req.user.role, '07')) return res.status(403).json({ error: 'Insufficient permissions' });
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
  let rows = db.prepare(`
    SELECT e.employee_code, e.name, e.department, e.team_id, COALESCE(a.status,'Not marked') status, COALESCE(a.check_in_time,'') check_in, COALESCE(a.check_out_time,'') check_out, COALESCE(a.method,'') method, COALESCE(a.half_day_flag,0) half_day_flag
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ? ORDER BY e.id
  `).all(date);
  rows = filterToScope(rows, req.user.role, myEmployee(req.user.sub)?.id);
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

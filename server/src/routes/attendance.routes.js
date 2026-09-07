import { Router } from 'express';
import ExcelJS from 'exceljs';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, filterToScopeOrOwnDepartment } from '../utils/scope.js';
import { bottomRole, approvalChainLabel } from '../utils/chain.js';
import { nowTime, today, LATE_AFTER, METHODS, freeLateAllowance, recomputeLateFlags, upsertAttendanceForDate, enabledMethods, isMethodEnabled, setMethodEnabled, employeeCheckinMethods, setEmployeeCheckinMethods, effectiveMethodsFor, notifyIfLate, notifyIfEarlyLogout, notifyAttendanceGaps, effectiveShiftFor, computeWorkStats } from '../utils/attendanceCore.js';
import { notifyEmployee } from '../utils/notify.js';
import { applyEmployeeFilters } from '../utils/employeeFilters.js';
import { isValidDescriptor, euclideanDistance, FACE_MATCH_THRESHOLD } from '../utils/face.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '07' (Attendance & Time Tracking). A Senior Team
// Lead/Team Lead/Assistant Manager also passes: every READ route below already fetches-then-
// filters via filterToScopeOrOwnDepartment, so admitting them here only ever narrows to their
// assigned departments/teams, never widens to company-wide. Write actions (e.g. /mark)
// intentionally check canModuleAdmin directly instead of this isHR, so scoped roles stay
// view/approval-only.
const isHR = (role) => canModuleAdmin(role, '07') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

// One small workbook, one sheet, a bold header row — shared by every .xlsx export below so each
// just supplies its own headers/rows/filename instead of repeating the workbook boilerplate.
async function sendXlsx(res, sheetName, headers, rows, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers).font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  sheet.columns.forEach((col) => { col.width = 18; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
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

  let rows = db.prepare(`
    SELECT e.department, e.team_id, a.status, a.check_in_time, a.check_out_time, a.method, a.half_day_flag, a.late_minutes
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = @date
    WHERE (@dept IS NULL OR e.department = @dept)
  `).all({ date, dept });
  rows = filterToScopeOrOwnDepartment(rows, req.user.role, myEmployee(req.user.sub)?.id);

  const present = rows.filter((r) => r.status === 'Present').length;
  const absent = rows.filter((r) => r.status === 'Absent').length;
  const late = rows.filter((r) => r.late_minutes > 0).length;
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
  regularizations = filterToScopeOrOwnDepartment(regularizations, req.user.role, myEmployee(req.user.sub)?.id)
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

// Shared by /biometric-list and its export twins — an optional ?date=YYYY-MM-DD narrows the
// report to that one day's punches/attendance (falling back to "last ever" when omitted, the
// original behavior), and always drives the month-count columns off that date's own month, so
// picking a date in a past month reports that month's counts, not the current one.
function biometricListRows(req) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const monthPrefix = date ? date.slice(0, 7) : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;

  const employees = applyEmployeeFilters(filterToScopeOrOwnDepartment(
    db.prepare('SELECT id, employee_code, name, department, designation, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  ), req.query);

  const rows = employees.map((e) => {
    const lastAttendance = date
      ? db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(e.id, date)
      : db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND check_in_time IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1').get(e.id);

    const dayPunches = date
      ? db.prepare('SELECT * FROM biometric_punches WHERE employee_id = ? AND punch_time LIKE ? ORDER BY punch_time DESC, id DESC').all(e.id, date + '%')
      : [];

    const lastPunch = date
      ? (dayPunches[0] || null)
      : db.prepare('SELECT * FROM biometric_punches WHERE employee_id = ? ORDER BY punch_time DESC, id DESC LIMIT 1').get(e.id);

    const monthRows = db.prepare('SELECT status, check_in_time, half_day_flag, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, monthPrefix + '%');

    const presentDays = monthRows.filter((r) => r.status === 'Present').length;
    const lateDays = monthRows.filter((r) => r.late_minutes > 0).length;
    const halfDayCutDays = monthRows.filter((r) => r.half_day_flag).length;

    return {
      employee_id: e.id,
      employee_code: e.employee_code,
      name: e.name,
      department: e.department,
      designation: e.designation,

      last_method: lastPunch
        ? 'Biometric (Fingerprint)'
        : (lastAttendance?.method || null),

      last_punch: lastPunch?.punch_time
        ? lastPunch.punch_time.slice(0, 16)
        : null,

      punch_count: date ? dayPunches.length : null,

      check_in: lastAttendance?.check_in_time
        ? `${lastAttendance.date} ${lastAttendance.check_in_time}`
        : null,

      check_out: lastAttendance?.check_out_time
        ? `${lastAttendance.date} ${lastAttendance.check_out_time}`
        : null,

      last_check_in: lastPunch
        ? lastPunch.punch_time.slice(0, 16)
        : (lastAttendance ? `${lastAttendance.date} ${lastAttendance.check_in_time}` : null),

      last_location: lastAttendance?.latitude != null
        ? { lat: lastAttendance.latitude, lng: lastAttendance.longitude }
        : null,

      present_days_month: presentDays,
      late_days_month: lateDays,
      half_day_cut_days_month: halfDayCutDays
    };
  });
  return { date, month: monthPrefix, rows };
}

// HR: per-employee biometric/device attendance list — last check-in method/time/location
// plus this month's present & late counts, so HR can see who's on which device. An optional
// ?date= narrows it to one specific day — see biometricListRows above.
router.get('/biometric-list', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(biometricListRows(req));
});

// CSV/Excel twins of /biometric-list — same filters (including ?date=), same columns as the
// on-screen table.
router.get('/biometric-list/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { date, month, rows } = biometricListRows(req);
  const csv = [
    'code,name,department,designation,last_method,last_check_in,punch_count,present_days_month,late_days_month,half_day_cut_days_month',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.designation || ''},${r.last_method || ''},${r.last_check_in || ''},${r.punch_count ?? ''},${r.present_days_month},${r.late_days_month},${r.half_day_cut_days_month}`)
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-biometric-${date || month}.csv"`);
  res.send(csv);
});

router.get('/biometric-list/export.xlsx', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { date, month, rows } = biometricListRows(req);
  const excelRows = rows.map((r) => [
    r.employee_code, r.name, r.department, r.designation || '',
    r.last_method || '', r.last_check_in || '', r.punch_count ?? '',
    r.present_days_month, r.late_days_month, r.half_day_cut_days_month
  ]);
  await sendXlsx(res, 'Biometric Attendance', ['code', 'name', 'department', 'designation', 'last_method', 'last_check_in', 'punch_count', 'present_days_month', 'late_days_month', 'half_day_cut_days_month'], excelRows, `attendance-biometric-${date || month}.xlsx`);
});

// HR monthly attendance report — present/absent/leave/late counts + attendance % per employee.
router.get('/monthly-report', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
  const daysInMonth = db.prepare("SELECT CAST(strftime('%d', date(?  || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(month).d;

  const employees = applyEmployeeFilters(filterToScopeOrOwnDepartment(
    db.prepare('SELECT id, employee_code, name, department, designation, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  ), req.query);
  const rows = employees.map((e) => {
    const marks = db.prepare('SELECT status, check_in_time, half_day_flag, half_day_manual, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, month + '%');
    const present = marks.filter((m) => m.status === 'Present').length;
    const halfDay = marks.filter((m) => m.half_day_manual).length;
    const absent = marks.filter((m) => m.status === 'Absent').length;
    const leave = marks.filter((m) => m.status === 'Leave').length;
    const late = marks.filter((m) => m.late_minutes > 0).length;
    const halfDayCut = marks.filter((m) => m.half_day_flag).length;
    // A half day is stored as a Present row, so counting Present alone would report it as a whole
    // day attended while Payroll pays it at half — the two must agree.
    const effectivePresent = present - 0.5 * halfDay;
    const attendancePct = daysInMonth > 0 ? Math.round((effectivePresent / daysInMonth) * 100) : 0;
    return { ...e, present, halfDay, effectivePresent, absent, leave, late, halfDayCut, attendancePct };
  });
  res.json({ month, daysInMonth, rows, freeLateAllowance: freeLateAllowance() });
});

// ?id=<employee id> narrows this to a single employee's monthly summary — same columns, one row
// — rather than a separate endpoint, matching /reports/employees.csv's pattern. Filtered through
// filterToScopeOrOwnDepartment FIRST so a scoped role can't export someone outside their
// department/team just by passing an arbitrary id.
router.get('/monthly-report/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let employees = applyEmployeeFilters(filterToScopeOrOwnDepartment(
    db.prepare('SELECT id, employee_code, name, department, designation, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  ), req.query);
  if (employeeId) employees = employees.filter((e) => e.id === employeeId);
  const rows = employees.map((e) => {
    const marks = db.prepare('SELECT status, check_in_time, half_day_flag, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, month + '%');
    return {
      ...e,
      present: marks.filter((m) => m.status === 'Present').length,
      absent: marks.filter((m) => m.status === 'Absent').length,
      leave: marks.filter((m) => m.status === 'Leave').length,
      late: marks.filter((m) => m.late_minutes > 0).length,
      halfDayCut: marks.filter((m) => m.half_day_flag).length
    };
  });
  const csv = [
    'code,name,department,designation,present,absent,leave,late,half_day_cut',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.designation || ''},${r.present},${r.absent},${r.leave},${r.late},${r.halfDayCut}`)
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `attendance-monthly-${month}-${rows[0]?.employee_code || employeeId}` : `attendance-monthly-${month}`}.csv"`);
  res.send(csv);
});

router.get('/monthly-report/export.xlsx', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let employees = applyEmployeeFilters(filterToScopeOrOwnDepartment(
    db.prepare('SELECT id, employee_code, name, department, designation, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  ), req.query);
  if (employeeId) employees = employees.filter((e) => e.id === employeeId);
  const rows = employees.map((e) => {
    const marks = db.prepare('SELECT status, check_in_time, half_day_flag, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, month + '%');
    return [
      e.employee_code, e.name, e.department, e.designation || '',
      marks.filter((m) => m.status === 'Present').length, marks.filter((m) => m.status === 'Absent').length, marks.filter((m) => m.status === 'Leave').length,
      marks.filter((m) => m.late_minutes > 0).length, marks.filter((m) => m.half_day_flag).length
    ];
  });
  const filename = employeeId ? `attendance-monthly-${month}-${rows[0]?.[0] || employeeId}.xlsx` : `attendance-monthly-${month}.xlsx`;
  await sendXlsx(res, 'Monthly Report', ['code', 'name', 'department', 'designation', 'present', 'absent', 'leave', 'late', 'half_day_cut'], rows, filename);
});

// HR: everyone's attendance for a date. Employee: own recent history.
router.get('/', (req, res) => {
  if (isHR(req.user.role)) {
    const date = req.query.date || today();
    let rows = db.prepare(`
      SELECT e.id AS employee_id, e.employee_code, e.name, e.department, e.team_id,
             a.status, a.check_in_time, a.check_out_time, a.method, a.latitude, a.longitude, a.half_day_flag, a.half_day_manual
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ?
      ORDER BY e.id
    `).all(date);
    rows = filterToScopeOrOwnDepartment(rows, req.user.role, myEmployee(req.user.sub)?.id);
    // A half day is a Present row, so it stays inside `present` for the headline count and is
    // reported alongside it rather than as a fourth, overlapping bucket that wouldn't sum.
    const present = rows.filter((r) => r.status === 'Present').length;
    const halfDay = rows.filter((r) => r.half_day_manual).length;
    const absent = rows.filter((r) => r.status === 'Absent').length;
    const onLeave = rows.filter((r) => r.status === 'Leave').length;
    return res.json({ date, rows, summary: { present, halfDay, absent, onLeave, unmarked: rows.length - present - absent - onLeave } });
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
  const monthRows = db.prepare('SELECT status, check_in_time, half_day_flag, late_minutes FROM attendance WHERE employee_id = ? AND date LIKE ?').all(me.id, month + '%');
  const summary = {
    month,
    present: monthRows.filter((m) => m.status === 'Present').length,
    absent: monthRows.filter((m) => m.status === 'Absent').length,
    late: monthRows.filter((m) => m.late_minutes > 0).length,
    halfDayCut: monthRows.filter((m) => m.half_day_flag).length,
    missingPunch: monthRows.filter((m) => m.status === 'Present' && !m.check_in_time).length,
    attendancePct: daysInMonth > 0 ? Math.round((monthRows.filter((m) => m.status === 'Present').length / daysInMonth) * 100) : 0
  };

  res.json({ rows, today: todays, me: { id: me.id, name: me.name, employee_code: me.employee_code }, regularizations, chainLabel: approvalChainLabel(), summary });
});

function hmsToSeconds(t) {
  const [h, m, s = 0] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
function secondsToHms(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Shared by /mine/report and its export twins — same per-day punch-time resolution as
// punchLogRows (raw biometric punches when present, else the attendance row's own
// check-in/check-out), just scoped to the caller instead of HR's company-wide view, and
// spanning a range instead of one date. Only days with at least a check-in are returned — an
// unmarked/absent day has no punches to report.
function myReportRows(req) {
  const me = myEmployee(req.user.sub);
  if (!me) return { from: null, to: null, branch: null, rows: [] };

  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  let from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  if (month) {
    from = `${month}-01`;
    to = db.prepare("SELECT date(? || '-01', '+1 month', '-1 day') AS d").get(month).d;
  } else if (!from || !to) {
    const m = today().slice(0, 7);
    from = `${m}-01`;
    to = today();
  }

  // No `check_in_time IS NOT NULL` filter: a day Super Admin/HR marked by hand has no check-in
  // time, so that condition hid every HR-marked day from the employee's own report — they were
  // told nothing while the day still decided their pay. Days with no attendance row at all are
  // still absent from this list by design; the calendar is what shows those gaps.
  const attRows = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(me.id, from, to);
  const userName = (id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name : null);
  const rows = attRows.map((att) => {
    const punches = db.prepare('SELECT punch_time FROM biometric_punches WHERE employee_id = ? AND punch_time LIKE ? ORDER BY punch_time ASC').all(me.id, att.date + '%');
    let times = punches.map((p) => p.punch_time.slice(11, 19));
    if (times.length === 0) {
      if (att.check_in_time) times.push(att.check_in_time.length === 5 ? `${att.check_in_time}:00` : att.check_in_time);
      if (att.check_out_time) times.push(att.check_out_time.length === 5 ? `${att.check_out_time}:00` : att.check_out_time);
    }
    const first = times[0] || null;
    const last = times.length > 1 ? times[times.length - 1] : null;
    const totalSeconds = first && last ? Math.max(0, hmsToSeconds(last) - hmsToSeconds(first)) : null;
    // Two different facts, kept as two fields: what the day COUNTS AS (which is what pay follows)
    // and what the punches show. An HR-marked day has the first and not the second.
    const markedByName = userName(att.marked_by);
    return {
      date: att.date,
      attendance_status: att.half_day_manual ? 'Half Day' : att.status,
      marked_by_name: markedByName,
      first_check_in: first,
      last_check_out: last,
      total_hours: totalSeconds != null ? secondsToHms(totalSeconds) : null,
      method: punches.length > 0 ? 'Biometric (Fingerprint)' : (att.check_in_time ? att.method : null),
      status: att.check_in_time
        ? (att.check_out_time ? 'Checked Out' : 'Checked In')
        : (markedByName ? `Marked by ${markedByName}` : 'No punch'),
      latitude: att.latitude,
      longitude: att.longitude,
      logs: times
    };
  });
  return { from, to, branch: me.branch || null, rows };
}

router.get('/mine/report', (req, res) => {
  res.json(myReportRows(req));
});

// Excel twin of /mine/report — same filters/columns as the on-screen table, plus a Logs column
// (every raw punch time for that day) since there's no click-to-expand in a spreadsheet — this is
// what "View Logs" downloads as.
router.get('/mine/report/export.xlsx', async (req, res) => {
  const { from, to, rows } = myReportRows(req);
  const excelRows = rows.map((r) => [
    r.date, r.attendance_status || '', r.marked_by_name || '', r.first_check_in || '', r.last_check_out || '', r.method || '',
    r.latitude != null ? `${r.latitude}, ${r.longitude}` : '', r.total_hours || '', r.status, r.logs.join(' | ')
  ]);
  await sendXlsx(res, 'My Attendance',
    ['date', 'attendance', 'marked_by', 'first_check_in', 'last_check_out', 'method', 'location', 'total_hours', 'status', 'logs'],
    excelRows, `my-attendance-${from}-to-${to}.xlsx`);
});

// One day's punches as a spreadsheet — what "View Logs" downloads. The row report above gives one
// line per DAY; this is the detail inside a single day, every punch in order with whether it was a
// check-in or a check-out, so a disputed day can be checked punch by punch.
//
// Device punches are the source when there are any (biometric_punches carries a punch_type per
// event). A day with no device punches falls back to the attendance row's own check-in/check-out
// times, and a day Super Admin/HR marked by hand has neither — that still exports, with the mark
// and who made it, rather than downloading an empty sheet.
router.get('/mine/logs/export.xlsx', async (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const date = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date is required in YYYY-MM-DD format' });

  const att = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, date);
  const punches = db.prepare('SELECT punch_time, punch_type, device_serial FROM biometric_punches WHERE employee_id = ? AND punch_time LIKE ? ORDER BY punch_time ASC')
    .all(me.id, date + '%');

  const TYPE_LABEL = { 'check-in': 'Check-In', 'check-out': 'Check-Out', unknown: 'Punch' };
  let rows;
  if (punches.length) {
    rows = punches.map((p, i) => [i + 1, TYPE_LABEL[p.punch_type] || 'Punch', p.punch_time.slice(11, 19), 'Biometric (Fingerprint)', p.device_serial || '']);
  } else {
    const asHms = (t) => (t && t.length === 5 ? `${t}:00` : t);
    rows = [];
    if (att?.check_in_time) rows.push([rows.length + 1, 'Check-In', asHms(att.check_in_time), att.method || '', '']);
    if (att?.check_out_time) rows.push([rows.length + 1, 'Check-Out', asHms(att.check_out_time), att.method || '', '']);
  }
  if (!rows.length) {
    const markedBy = att?.marked_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(att.marked_by)?.name : null;
    rows.push(['', 'No punches recorded', '', markedBy ? `Marked ${att.half_day_manual ? 'Half Day' : att.status} by ${markedBy}` : (att ? `Marked ${att.status}` : 'Not marked'), '']);
  }

  await sendXlsx(res, `Logs ${date}`,
    ['#', 'type', 'time', 'method', 'device'],
    rows, `attendance-logs-${me.employee_code || me.id}-${date}.xlsx`);
});

// Calendar view — every day of one calendar month for one employee (self by default; HR/scoped
// roles can pass ?id= for anyone in their scope, same filterToScope-then-narrow idiom as the CSV
// exports), so the client can color a full month grid instead of just a rolling 30-day list.
// Days with no attendance row are 'Not marked' if they're in the past, or null (not yet reached)
// if they're still upcoming — the client tells those apart to avoid painting the future absent.
router.get('/calendar', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let employee;
  if (employeeId) {
    if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const scoped = filterToScopeOrOwnDepartment(
      db.prepare('SELECT id, employee_code, name, department, team_id FROM employees WHERE id = ?').all(employeeId),
      req.user.role, myEmployee(req.user.sub)?.id
    );
    employee = scoped[0];
    if (!employee) return res.status(404).json({ error: 'Employee not found or outside your scope' });
  } else {
    employee = myEmployee(req.user.sub);
    if (!employee) return res.json({ month, employee: null, days: [], summary: null });
  }

  const daysInMonth = db.prepare("SELECT CAST(strftime('%d', date(? || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(month).d;
  const marks = db.prepare('SELECT date, status, check_in_time, check_out_time, half_day_flag, half_day_manual FROM attendance WHERE employee_id = ? AND date LIKE ?').all(employee.id, month + '%');
  const byDate = Object.fromEntries(marks.map((m) => [m.date, m]));
  const todayStr = today();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const mark = byDate[date];
    return {
      date, day: i + 1,
      status: mark?.status ?? (date <= todayStr ? 'Not marked' : null),
      check_in_time: mark?.check_in_time || null, check_out_time: mark?.check_out_time || null,
      half_day_flag: !!mark?.half_day_flag,
      half_day_manual: !!mark?.half_day_manual
    };
  });
  const summary = {
    present: days.filter((d) => d.status === 'Present').length,
    absent: days.filter((d) => d.status === 'Absent').length,
    leave: days.filter((d) => d.status === 'Leave').length,
    halfDayCut: days.filter((d) => d.half_day_flag).length,
    halfDay: days.filter((d) => d.half_day_manual).length,
    notMarked: days.filter((d) => d.status === 'Not marked').length
  };
  res.json({ month, employee: { id: employee.id, name: employee.name, employee_code: employee.employee_code }, days, summary });
});

const upsertToday = (employeeId, patch) => upsertAttendanceForDate(employeeId, today(), patch);

function validCoord(v) { return typeof v === 'number' && Number.isFinite(v); }

// Both selectable methods (Web Check-in, Mobile App) require a live face-verification capture —
// first successful check-in enrolls the employee's face on their login account (same account
// doing the check-in), every check-in after that must match it. This is a separate enrollment
// from anything login-related; it just happens to reuse the same users.face_descriptor column.
// Biometric (Fingerprint) is never a choice here — it only ever means a real device punch,
// applied directly by biometricPunch.js's own write path (bypassing this route entirely). Letting
// someone self-select it from this dropdown would mislabel an ordinary face-verified web/mobile
// check-in as a device punch, undermining the Biometric Attendance List/Punch Log as a genuine
// device-sourced record. Falls back to Web Check-in exactly like an unrecognized/disabled method
// already did.
const SELF_CHECKIN_METHODS = METHODS.filter((m) => m !== 'Biometric (Fingerprint)');

router.post('/check-in', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (existing?.check_in_time) return res.status(400).json({ error: 'Already checked in today at ' + existing.check_in_time });

  const method = SELF_CHECKIN_METHODS.includes(req.body?.method) ? req.body.method : SELF_CHECKIN_METHODS[0];
  if (!isMethodEnabled(method)) return res.status(400).json({ error: `${method} has been disabled by your administrator.` });
  const myMethods = effectiveMethodsFor(me.id);
  if (!myMethods.includes(method)) {
    // Assigned Biometric only: there is nothing to self-select — they're expected to punch on the
    // physical device, so say that rather than the generic "not assigned to you".
    if (myMethods.length && myMethods.every((m) => !SELF_CHECKIN_METHODS.includes(m))) {
      return res.status(403).json({ error: 'You are assigned to Biometric (Fingerprint) attendance — please punch on the biometric device instead of checking in here.' });
    }
    return res.status(403).json({ error: `${method} has not been assigned to you by your administrator.` });
  }

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
  const checkInTime = nowTime();
  const shift = effectiveShiftFor(me.id, today());
  const stats = computeWorkStats(checkInTime, null, shift);
  const attendance = upsertToday(me.id, { status: 'Present', check_in_time: checkInTime, method, latitude, longitude, shift_id: shift.shiftId, ...stats });
  recomputeLateFlags(me.id, today().slice(0, 7));
  notifyIfLate(me.id, attendance, shift);
  notifyAttendanceGaps(me.id); // e.g. yesterday's missed checkout, surfaced right when they check in again
  res.json({ attendance: db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendance.id), faceJustEnrolled });
});

// The check-in dropdown's options — company-enabled methods, further narrowed to this specific
// employee's personal assignment (if Super Admin has set one), minus Biometric (Fingerprint),
// which is never a self-selectable option — see SELF_CHECKIN_METHODS above.
router.get('/methods', (req, res) => {
  const me = myEmployee(req.user.sub);
  const methods = me ? effectiveMethodsFor(me.id) : enabledMethods();
  res.json({ methods: methods.filter((m) => m !== 'Biometric (Fingerprint)') });
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

// Super Admin: per-employee check-in method assignment — restrict a specific employee to a
// subset of the company-enabled methods (e.g. Mobile App only). No assignment row for an
// employee = unrestricted, so this list is opt-in only, never opt-out-by-omission.
router.get('/checkin-methods/employees', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Insufficient permissions' });
  const employees = applyEmployeeFilters(
    db.prepare("SELECT id, employee_code, name, department, designation FROM employees WHERE status = 'Active' ORDER BY name").all(),
    req.query
  );
  const rows = employees.map((e) => ({ ...e, methods: employeeCheckinMethods(e.id) }));
  res.json({ employees: rows, allMethods: METHODS });
});

router.put('/checkin-methods/:employeeId', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Insufficient permissions' });
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const methods = Array.isArray(req.body?.methods) ? req.body.methods : [];
  try {
    setEmployeeCheckinMethods(employee.id, methods);
    res.json({ employeeId: employee.id, methods: employeeCheckinMethods(employee.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/check-out', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (!existing?.check_in_time) return res.status(400).json({ error: 'Check in first.' });
  if (existing.check_out_time) return res.status(400).json({ error: 'Already checked out at ' + existing.check_out_time });
  const checkOutTime = nowTime();
  const shift = effectiveShiftFor(me.id, today());
  const stats = computeWorkStats(existing.check_in_time, checkOutTime, shift);
  const attendance = upsertToday(me.id, { check_out_time: checkOutTime, shift_id: shift.shiftId, ...stats });
  notifyIfEarlyLogout(me.id, attendance, shift);
  res.json({ attendance });
});

// HR marks an employee's attendance for a date. Deliberately NOT admitting isScopedRole here —
// marking attendance edits someone else's record, which is a step beyond the view + workflow-
// approval access Assistant Manager/STL/TL are limited to; only a real Manage Roles grant opens it.
router.post('/mark', (req, res) => {
  if (!canModuleAdmin(req.user.role, '07')) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, date, status } = req.body || {};
  // 'Half Day' is not an attendance.status value — it is a Present day worth half, recorded as
  // status Present + half_day_manual. 'Leave' stays accepted here (approved leave and existing
  // rows still use it) even though the marking UI no longer offers it.
  if (!employee_id || !['Present', 'Absent', 'Leave', 'Half Day'].includes(status)) {
    return res.status(400).json({ error: 'employee_id and a valid status are required' });
  }
  const d = date || today();
  const halfDay = status === 'Half Day' ? 1 : 0;
  const storedStatus = status === 'Half Day' ? 'Present' : status;
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employee_id, d);
  const wasLabel = existing ? (existing.half_day_manual ? 'Half Day' : existing.status) : 'Not marked';
  // Re-marking a day as anything else clears the half-day mark, so the two can never disagree.
  if (existing) db.prepare("UPDATE attendance SET status = ?, half_day_manual = ?, marked_by = ?, marked_at = datetime('now') WHERE id = ?").run(storedStatus, halfDay, req.user.sub, existing.id);
  else db.prepare("INSERT INTO attendance (employee_id, date, status, half_day_manual, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(employee_id, d, storedStatus, halfDay, req.user.sub);

  // A day marked by hand decides that day's pay, so the employee is told rather than left to
  // discover it on a payslip. Silent when nothing actually changed (re-clicking the same button).
  if (wasLabel !== status) {
    notifyEmployee(employee_id, `Attendance updated — ${d}`,
      `${req.user.name || 'HR'} set your attendance for ${d} to ${status}${wasLabel !== 'Not marked' ? ` (was ${wasLabel})` : ''}. Raise a regularization request from My Attendance if this is wrong.`);
  }
  res.json({ ok: true });
});

// CSV export of a date's attendance (HR). ?id=<employee id> narrows to a single employee's row,
// same idiom as /monthly-report/export and /reports/employees.csv.
router.get('/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const date = req.query.date || today();
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let rows = db.prepare(`
    SELECT e.id, e.employee_code, e.name, e.department, e.team_id, COALESCE(a.status,'Not marked') status, COALESCE(a.check_in_time,'') check_in, COALESCE(a.check_out_time,'') check_out, COALESCE(a.method,'') method, COALESCE(a.half_day_flag,0) half_day_flag
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ? ORDER BY e.id
  `).all(date);
  rows = filterToScopeOrOwnDepartment(rows, req.user.role, myEmployee(req.user.sub)?.id);
  if (employeeId) rows = rows.filter((r) => r.id === employeeId);
  const csv = ['code,name,department,status,check_in,check_out,method,half_day_cut',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.status},${r.check_in},${r.check_out},${r.method},${r.half_day_flag ? 1 : 0}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `attendance-${date}-${rows[0]?.employee_code || employeeId}` : `attendance-${date}`}.csv"`);
  res.send(csv);
});

router.get('/export.xlsx', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const date = req.query.date || today();
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let rows = db.prepare(`
    SELECT e.id, e.employee_code, e.name, e.department, e.team_id, COALESCE(a.status,'Not marked') status, COALESCE(a.check_in_time,'') check_in, COALESCE(a.check_out_time,'') check_out, COALESCE(a.method,'') method, COALESCE(a.half_day_flag,0) half_day_flag
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ? ORDER BY e.id
  `).all(date);
  rows = filterToScopeOrOwnDepartment(rows, req.user.role, myEmployee(req.user.sub)?.id);
  if (employeeId) rows = rows.filter((r) => r.id === employeeId);
  await sendXlsx(res, 'Attendance',
    ['code', 'name', 'department', 'status', 'check_in', 'check_out', 'method', 'half_day_cut'],
    rows.map((r) => [r.employee_code, r.name, r.department, r.status, r.check_in, r.check_out, r.method, r.half_day_flag ? 1 : 0]),
    `attendance-${date}.xlsx`);
});

// HR: one row per employee per day, every punch that day — not just first-in/last-out, and not
// just device punches. A biometric-sourced day reads its full raw punch history from
// biometric_punches (mirroring the device's own log, break-in/break-out included); a Web
// Check-in/Mobile App day has no rows there at all (no device involved), so it falls back to that
// day's plain check-in/check-out times from attendance — otherwise a manually checked-in
// employee would never show up here at all. Only employees with at least one punch/check-in on
// the given date are included — an all-zero grid of everyone else isn't useful here.
// Punch log over a date RANGE (?from=&to=), or a single day (?date=, still accepted) — one row
// per employee per day that actually had activity.
//
// Check-ins and check-outs are reported as two separate lists rather than one merged blob,
// bucketed by the device's own punch_type. That type is trustworthy on real hardware and, just as
// importantly, cannot be reconstructed by alternating in/out: genuine device data contains long
// runs of the same type (e.g. eight consecutive check-ins), so a first-is-in/second-is-out guess
// would mislabel most of a real day.
function punchLogRows(req) {
  const single = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  let from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  if (!from || !to) { from = single || today(); to = single || today(); }
  if (from > to) { const swap = from; from = to; to = swap; }

  const employees = applyEmployeeFilters(filterToScopeOrOwnDepartment(
    db.prepare('SELECT id, employee_code, name, department, designation, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  ), req.query);

  const hms = (t) => (t && t.length === 5 ? `${t}:00` : t);

  let rows = [];
  employees.forEach((e) => {
    const punches = db.prepare(
      'SELECT punch_time, punch_type FROM biometric_punches WHERE employee_id = ? AND date(punch_time) BETWEEN ? AND ? ORDER BY punch_time ASC'
    ).all(e.id, from, to);
    const attRows = db.prepare(
      'SELECT date, check_in_time, check_out_time, method FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ?'
    ).all(e.id, from, to);

    const byDate = new Map();
    const bucket = (d) => {
      if (!byDate.has(d)) byDate.set(d, { checkIns: [], checkOuts: [], unclassified: [], devicePunches: 0 });
      return byDate.get(d);
    };
    punches.forEach((p) => {
      const b = bucket(p.punch_time.slice(0, 10));
      const time = p.punch_time.slice(11, 19);
      b.devicePunches++;
      if (p.punch_type === 'check-in') b.checkIns.push(time);
      else if (p.punch_type === 'check-out') b.checkOuts.push(time);
      else b.unclassified.push(time); // a status code we don't map — surfaced, never silently relabelled
    });
    // A manual web/mobile day has no raw punches; its single in/out pair is that day's whole log.
    const methodByDate = {};
    attRows.forEach((a) => {
      methodByDate[a.date] = a.method;
      const b = bucket(a.date);
      if (b.devicePunches === 0) {
        if (a.check_in_time) b.checkIns.push(hms(a.check_in_time));
        if (a.check_out_time) b.checkOuts.push(hms(a.check_out_time));
      }
    });

    [...byDate.entries()].forEach(([date, b]) => {
      const total = b.checkIns.length + b.checkOuts.length + b.unclassified.length;
      if (total === 0) return;
      const firstIn = b.checkIns[0] || null;
      const lastOut = b.checkOuts.length ? b.checkOuts[b.checkOuts.length - 1] : null;
      const spanSeconds = firstIn && lastOut ? Math.max(0, hmsToSeconds(lastOut) - hmsToSeconds(firstIn)) : null;
      rows.push({
        employee_id: e.id, employee_code: e.employee_code, name: e.name,
        department: e.department, designation: e.designation,
        date,
        method: b.devicePunches > 0 ? 'Biometric (Fingerprint)' : (methodByDate[date] || 'Web Check-in'),
        // "Checked Out" only once a real check-out exists for that day; otherwise still in.
        status: lastOut ? 'Checked Out' : 'Checked In',
        punch_count: total,
        check_in_count: b.checkIns.length,
        check_out_count: b.checkOuts.length,
        check_ins: b.checkIns,
        check_outs: b.checkOuts,
        unclassified: b.unclassified,
        first_check_in: firstIn,
        last_check_out: lastOut,
        worked_span: spanSeconds != null ? secondsToHms(spanSeconds) : null
      });
    });
  });

  rows.sort((a, b) => (a.date === b.date ? a.employee_id - b.employee_id : a.date.localeCompare(b.date)));
  if (req.query.status === 'checked_in') rows = rows.filter((r) => r.status === 'Checked In');
  if (req.query.status === 'checked_out') rows = rows.filter((r) => r.status === 'Checked Out');
  return { from, to, date: from === to ? from : null, rows };
}

router.get('/punch-log', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(punchLogRows(req));
});

// Exports mirror the on-screen columns exactly, with check-in and check-out times in their own
// separate columns (semicolon-separated within a cell, so a spreadsheet keeps them in one field).
const PUNCH_LOG_HEADERS = ['code', 'name', 'department', 'designation', 'date', 'method', 'status',
  'punch_count', 'check_in_count', 'check_out_count', 'check_in_times', 'check_out_times',
  'first_check_in', 'last_check_out', 'worked_span'];
const punchLogCells = (r) => [
  r.employee_code, r.name, r.department, r.designation || '', r.date, r.method, r.status,
  r.punch_count, r.check_in_count, r.check_out_count,
  r.check_ins.join('; '), r.check_outs.join('; '),
  r.first_check_in || '', r.last_check_out || '', r.worked_span || ''
];
const punchLogFilename = (from, to) => (from === to ? from : `${from}_to_${to}`);

router.get('/punch-log/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { from, to, rows } = punchLogRows(req);
  const csv = [
    PUNCH_LOG_HEADERS.join(','),
    ...rows.map((r) => punchLogCells(r).map((c) => (String(c).includes(',') || String(c).includes(';') ? `"${c}"` : c)).join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-punch-log-${punchLogFilename(from, to)}.csv"`);
  res.send(csv);
});

router.get('/punch-log/export.xlsx', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { from, to, rows } = punchLogRows(req);
  await sendXlsx(res, 'Punch Log', PUNCH_LOG_HEADERS, rows.map(punchLogCells),
    `attendance-punch-log-${punchLogFilename(from, to)}.xlsx`);
});

// Employee raises a regularization request (routed through the shared approvals queue).
router.post('/regularize', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { date, reason } = req.body || {};
  if (!date || !reason) return res.status(400).json({ error: 'date and reason are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (date > today()) return res.status(400).json({ error: 'You cannot regularize a date in the future.' });
  // One open request per date — re-raising the same day should not stack duplicates for approvers.
  const alreadyOpen = db.prepare("SELECT 1 FROM approvals WHERE type = 'Regularization' AND requester = ? AND target_date = ? AND status = 'Pending'").get(me.name, date);
  if (alreadyOpen) return res.status(409).json({ error: 'You already have a pending regularization request for that date.' });

  const stage = bottomRole();
  // target_date is stored as its own column, not just inside `detail`: approving this request now
  // marks that day's attendance, which needs a date the code can act on rather than parse.
  db.prepare('INSERT INTO approvals (type, requester, detail, target_date, current_stage_role_id) VALUES (?, ?, ?, ?, ?)')
    .run('Regularization', me.name, `${date}: ${reason}`, date, stage ? stage.id : null);
  res.status(201).json({ ok: true });
});

export default router;

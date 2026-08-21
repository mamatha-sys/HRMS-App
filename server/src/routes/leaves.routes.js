import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, isEmployeeInScope, filterToScope, scopeDepartmentNames } from '../utils/scope.js';
import { bottomRole, approvalChainLabel, evaluateDecision } from '../utils/chain.js';
import { notifyEmployee } from '../utils/notify.js';
import { monthlyAttendanceSummary } from '../utils/attendanceCore.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '08' (Leave Management). A Senior Team Lead/Team Lead
// also passes: every isHR-gated route here already fetches-then-filters via filterToScope, and
// leave-type management (add/edit/pause) is independently locked to Super Admin only just below
// — so admitting scoped roles through this gate only narrows to their assigned departments/
// teams, it never opens company-wide config actions.
const isHR = (role) => canModuleAdmin(role, '08') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function activeTypes() { return db.prepare('SELECT * FROM leave_types WHERE active = 1 ORDER BY id').all(); }
function allTypes() { return db.prepare('SELECT * FROM leave_types ORDER BY id').all(); }
function typeById(id) { return db.prepare('SELECT * FROM leave_types WHERE id = ?').get(id); }

function activeReasons() { return db.prepare('SELECT * FROM leave_approval_reasons WHERE active = 1 ORDER BY sort_order, id').all(); }
function allReasons() { return db.prepare('SELECT * FROM leave_approval_reasons ORDER BY sort_order, id').all(); }
// 4+ day leave requests must record which company-approved reason(s) justified the approval —
// resolves the stored JSON array of leave_approval_reasons.id into their current labels.
function reasonLabelsOf(approvalReasonIds) {
  if (!approvalReasonIds) return null;
  let ids;
  try { ids = JSON.parse(approvalReasonIds); } catch { return null; }
  if (!Array.isArray(ids) || !ids.length) return null;
  const all = allReasons();
  return ids.map((id) => all.find((r) => r.id === id)?.label).filter(Boolean);
}

// Concurrent Leave Cap: HR-configurable ceiling on what % of a department can be off at the same
// time. Stored in the generic `policies` table (category 'setting'), same getter/setter shape as
// Payroll's split-config % and Recruitment's notice period — a dedicated GET/PUT pair below rather
// than the free-text Configuration Policies screen, so the value is validated as a real percentage.
const CONCURRENT_LEAVE_LIMIT_NAME = 'Max concurrent leave % per department';
const DEFAULT_CONCURRENT_LEAVE_LIMIT_PCT = 30;
function getConcurrentLeaveLimitPct() {
  const row = db.prepare("SELECT value FROM policies WHERE category = 'setting' AND name = ?").get(CONCURRENT_LEAVE_LIMIT_NAME);
  const pct = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(pct) && pct >= 1 && pct <= 100 ? pct : DEFAULT_CONCURRENT_LEAVE_LIMIT_PCT;
}
function setConcurrentLeaveLimitPct(pct) {
  const existing = db.prepare("SELECT id FROM policies WHERE category = 'setting' AND name = ?").get(CONCURRENT_LEAVE_LIMIT_NAME);
  if (existing) db.prepare('UPDATE policies SET value = ? WHERE id = ?').run(String(pct), existing.id);
  else db.prepare("INSERT INTO policies (category, name, value) VALUES ('setting', ?, ?)").run(CONCURRENT_LEAVE_LIMIT_NAME, String(pct));
}

// A flat absolute-headcount ceiling on top of the percentage above — whichever is stricter wins
// (see the min() in POST /leaves below). Exists because a percentage alone can still let a small
// department's whole team slip out at once (e.g. 30% of a 3-person team rounds to 1, but a
// 10-person department's 30% is 3) — this caps it at a fixed number company-wide regardless of
// department size. Same getter/setter shape as the percentage setting.
const CONCURRENT_LEAVE_MAX_COUNT_NAME = 'Max concurrent leave headcount per department';
const DEFAULT_CONCURRENT_LEAVE_MAX_COUNT = 2;
function getConcurrentLeaveMaxCount() {
  const row = db.prepare("SELECT value FROM policies WHERE category = 'setting' AND name = ?").get(CONCURRENT_LEAVE_MAX_COUNT_NAME);
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONCURRENT_LEAVE_MAX_COUNT;
}
function setConcurrentLeaveMaxCount(n) {
  const existing = db.prepare("SELECT id FROM policies WHERE category = 'setting' AND name = ?").get(CONCURRENT_LEAVE_MAX_COUNT_NAME);
  if (existing) db.prepare('UPDATE policies SET value = ? WHERE id = ?').run(String(n), existing.id);
  else db.prepare("INSERT INTO policies (category, name, value) VALUES ('setting', ?, ?)").run(CONCURRENT_LEAVE_MAX_COUNT_NAME, String(n));
}

// How many OTHER active employees in this employee's department already have a Pending or
// Approved (non-cancelled) leave overlapping the given date range — counted at submission time
// (not just Approved) so two people can't both slip in on the same day before either is decided,
// only to have the department end up over its cap once both get approved later. Standard interval-
// overlap predicate: two ranges overlap unless one ends before the other starts.
// Stale-pending-approval reminder: a leave sitting Pending too long without a decision means the
// requester has no idea whether it's being looked at, which is exactly what leads to them
// resubmitting the same request out of frustration. Same lazy, no-background-scheduler idiom as
// Helpdesk's 24h auto-escalation and Performance's assessment reminders — runs at the top of
// every leave-list read, only fires once per LEAVE_REMINDER_COOLDOWN_DAYS per request (via
// last_reminded_at) so repeated page loads don't spam it. Reassures the requester (their request
// wasn't lost, no need to resubmit) AND nudges whoever needs to act on it.
const LEAVE_REMINDER_COOLDOWN_DAYS = 2;
function sendPendingLeaveReminders() {
  const stale = db.prepare(`
    SELECT * FROM leaves
    WHERE status = 'Pending' AND cancelled = 0
      AND COALESCE(last_reminded_at, created_at) <= datetime('now', ?)
  `).all(`-${LEAVE_REMINDER_COOLDOWN_DAYS} days`);
  stale.forEach((l) => {
    const emp = empOf(l.employee_id);
    notifyEmployee(l.employee_id, 'Leave request still pending', `Your ${l.type} request (${l.from_date} to ${l.to_date}) is still awaiting approval — it hasn't been missed, no need to submit it again.`);
    db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)')
      .run('Leave Approval Pending', `${emp.name || 'An employee'}'s ${l.type} request (${l.from_date} to ${l.to_date}) has been pending for ${LEAVE_REMINDER_COOLDOWN_DAYS}+ days — please review.`, 'staff');
    db.prepare("UPDATE leaves SET last_reminded_at = datetime('now') WHERE id = ?").run(l.id);
  });
}

// Approval Suggestion: gives whoever is deciding a pending request the same three signals a
// manager would informally weigh before approving — this month's goal progress, this month's
// attendance, and how much leave the employee has already taken this calendar year — without
// making the decision for them. Purely advisory: always shows the real numbers alongside the
// verdict so the approver can override it, same "numbers first, judgment stays human" spirit as
// the Progress Score in Performance Management (whose High/Medium/Low bands this reuses).
const LEAVE_YTD_REVIEW_THRESHOLD_DAYS = 24; // ~2 days/month average — past this, worth a second look, not a hard rule.

function targetsScoreFor(employeeId, month) {
  const targets = db.prepare('SELECT progress_pct FROM performance_reviews WHERE employee_id = ? AND month = ?').all(employeeId, month);
  return targets.length ? Math.round(targets.reduce((s, t) => s + t.progress_pct, 0) / targets.length) : null;
}

function leaveDaysThisYear(employeeId, excludeLeaveId) {
  const year = new Date().getFullYear();
  const row = db.prepare(`
    SELECT COALESCE(SUM(days), 0) AS total FROM leaves
    WHERE employee_id = ? AND id != ? AND cancelled = 0 AND status IN ('Pending', 'Approved')
      AND strftime('%Y', from_date) = ?
  `).get(employeeId, excludeLeaveId || 0, String(year));
  return row.total;
}

function approvalSuggestionFor(leave) {
  const month = leave.from_date.slice(0, 7);
  const targetsScore = targetsScoreFor(leave.employee_id, month);
  const attendanceScore = monthlyAttendanceSummary(leave.employee_id, month).attendancePct;
  const leaveDaysYtd = leaveDaysThisYear(leave.employee_id, leave.id) + leave.days;

  const reasons = [];
  if (targetsScore != null && targetsScore < 50) reasons.push(`goal progress is low this month (${targetsScore}%)`);
  if (attendanceScore < 50) reasons.push(`attendance is low this month (${attendanceScore}%)`);
  if (leaveDaysYtd > LEAVE_YTD_REVIEW_THRESHOLD_DAYS) reasons.push(`already at ${leaveDaysYtd} leave days this year including this request`);

  return {
    targetsScore, attendanceScore, leaveDaysYtd,
    recommendation: reasons.length ? 'Review' : 'Approve',
    reasons
  };
}

// Work Handover — who's eligible to receive it: normally a colleague in the SAME department
// (handing work to someone unrelated to it doesn't make sense), with one exception — a Team
// Lead may hand over to another Team Lead in a DIFFERENT department too, since a small
// department/team often has no second TL to receive it. Role lives on `users`, not `employees`,
// so this always resolves it via the linked user row rather than trusting anything the client sends.
const roleOfEmployee = (employeeId) => db.prepare('SELECT u.role FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ?').get(employeeId)?.role || null;

function isValidHandoverTarget(ownerEmployeeId, ownerDepartment, targetId) {
  if (!targetId || Number(targetId) === ownerEmployeeId) return false;
  const target = db.prepare("SELECT id, department, status FROM employees WHERE id = ?").get(targetId);
  if (!target || target.status !== 'Active') return false;
  if (target.department === ownerDepartment) return true;
  return roleOfEmployee(ownerEmployeeId) === 'tl' && roleOfEmployee(target.id) === 'tl';
}

function handoverCandidatesFor(ownerEmployeeId, ownerDepartment) {
  const sameDept = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE department = ? AND status = 'Active' AND id != ?").all(ownerDepartment, ownerEmployeeId);
  if (roleOfEmployee(ownerEmployeeId) !== 'tl') return sameDept;
  const otherTls = db.prepare(`
    SELECT e.id, e.name, e.employee_code, e.department FROM employees e JOIN users u ON u.id = e.user_id
    WHERE u.role = 'tl' AND e.status = 'Active' AND e.id != ?
  `).all(ownerEmployeeId);
  const seen = new Set(sameDept.map((c) => c.id));
  otherTls.forEach((c) => { if (!seen.has(c.id)) { sameDept.push(c); seen.add(c.id); } });
  return sameDept;
}

function overlappingDeptLeaveCount(employee, fromDate, toDate) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT l.employee_id) AS n
    FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE e.department = ? AND l.employee_id != ? AND e.status = 'Active'
      AND l.status IN ('Pending', 'Approved') AND l.cancelled = 0
      AND l.from_date <= ? AND l.to_date >= ?
  `).get(employee.department, employee.id, toDate, fromDate);
  return row.n;
}

function ensureBalances(employeeId) {
  const types = allTypes();
  const have = new Set(db.prepare('SELECT leave_type_id FROM employee_leave_balances WHERE employee_id = ?').all(employeeId).map((r) => r.leave_type_id));
  const ins = db.prepare("INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance, last_accrued_at) VALUES (?, ?, ?, datetime('now'))");
  types.forEach((t) => { if (!have.has(t.id)) ins.run(employeeId, t.id, t.annual_quota); });
}

// Sick Leave (currently the only monthly_accrual type) doesn't get its annual_quota granted
// upfront — it credits 1 day for every whole month elapsed since last_accrued_at, carrying
// forward with no cap (per Super Admin policy). Lazy, same reasoning as Helpdesk's 24h
// auto-escalation: no background scheduler in this app, so this runs whenever a balance is read,
// crediting however many months have piled up since the last check rather than missing them.
function applyMonthlyAccrual(employeeId) {
  ensureBalances(employeeId);
  const accrualTypes = db.prepare('SELECT * FROM leave_types WHERE monthly_accrual > 0 AND active = 1').all();
  accrualTypes.forEach((t) => {
    const row = db.prepare('SELECT * FROM employee_leave_balances WHERE employee_id = ? AND leave_type_id = ?').get(employeeId, t.id);
    if (!row?.last_accrued_at) return;
    const elapsed = db.prepare(`
      SELECT (CAST(strftime('%Y','now') AS INTEGER) - CAST(strftime('%Y', ?) AS INTEGER)) * 12
           + (CAST(strftime('%m','now') AS INTEGER) - CAST(strftime('%m', ?) AS INTEGER))
           - (CASE WHEN strftime('%d','now') < strftime('%d', ?) THEN 1 ELSE 0 END) AS months
    `).get(row.last_accrued_at, row.last_accrued_at, row.last_accrued_at).months;
    if (elapsed >= 1) {
      // One history row per elapsed month (not a single batched row) so the ledger stays truly
      // month-wise even when several months piled up before the balance was next read — each row
      // is tagged with the specific month it accrued for, letting the client build an accurate
      // month-by-month balance table straight from history instead of parsing free-text reasons.
      let bal = row.balance;
      let cursor = row.last_accrued_at;
      for (let i = 0; i < elapsed; i += 1) {
        cursor = db.prepare("SELECT datetime(?, '+1 month') AS d").get(cursor).d;
        bal += t.monthly_accrual;
        const parts = db.prepare("SELECT strftime('%Y-%m', ?) AS m, CAST(strftime('%m', ?) AS INTEGER) AS mnum, strftime('%Y', ?) AS y").get(cursor, cursor, cursor);
        const pretty = `${MONTH_NAMES[parts.mnum - 1]} ${parts.y}`;
        logBalanceHistory(employeeId, t.name, t.monthly_accrual, bal, `Monthly accrual — ${pretty}`, null, parts.m);
      }
      db.prepare('UPDATE employee_leave_balances SET balance = ?, last_accrued_at = ? WHERE employee_id = ? AND leave_type_id = ?')
        .run(bal, cursor, employeeId, t.id);
    }
  });
}

function balanceOf(employeeId, leaveTypeId) {
  applyMonthlyAccrual(employeeId);
  return db.prepare('SELECT balance FROM employee_leave_balances WHERE employee_id = ? AND leave_type_id = ?').get(employeeId, leaveTypeId)?.balance ?? 0;
}
function setBalance(employeeId, leaveTypeId, balance) {
  db.prepare('INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance) VALUES (?, ?, ?) ON CONFLICT(employee_id, leave_type_id) DO UPDATE SET balance = excluded.balance')
    .run(employeeId, leaveTypeId, balance);
}
function logBalanceHistory(employeeId, leaveTypeName, change, balanceAfter, reason, actorId, periodMonth) {
  db.prepare('INSERT INTO leave_balance_history (employee_id, leave_type, change, balance_after, reason, created_by, period_month) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, leaveTypeName, change, balanceAfter, reason, actorId || null, periodMonth || db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m);
}

// Days already taken this calendar year for one employee + leave type (Approved, not cancelled).
// Shown for unpaid/unlimited types so "Unlimited" still means something concrete, not a blank.
function daysTakenThisYear(employeeId, leaveTypeId) {
  return db.prepare(`
    SELECT COALESCE(SUM(days), 0) AS total FROM leaves
    WHERE employee_id = ? AND leave_type_id = ? AND status = 'Approved' AND cancelled = 0
      AND strftime('%Y', from_date) = strftime('%Y', 'now')
  `).get(employeeId, leaveTypeId).total;
}

// All balances for an employee, active types only (paused types are hidden everywhere).
function balancesFor(employeeId) {
  applyMonthlyAccrual(employeeId);
  return db.prepare(`
    SELECT lt.id AS leave_type_id, lt.name, lt.code, lt.unpaid, lt.carry_forward, lt.monthly_accrual, elb.balance
    FROM leave_types lt LEFT JOIN employee_leave_balances elb ON elb.leave_type_id = lt.id AND elb.employee_id = ?
    WHERE lt.active = 1 ORDER BY lt.id
  `).all(employeeId).map((b) => ({ ...b, carry_forward: !!b.carry_forward, days_taken_ytd: b.unpaid ? daysTakenThisYear(employeeId, b.leave_type_id) : null }));
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

const empOf = (id) => db.prepare('SELECT name, department, team_id FROM employees WHERE id = ?').get(id) || {};
const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
// A department can be split into teams (e.g. Education's Team-A/Team-B) — surface which team
// the requester belongs to wherever a request is listed, so an STL overseeing both teams (or
// anyone above them in the chain) can tell them apart at a glance.
const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);
const decidedByName = (userId) => (userId ? db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name : null);
const withName = (rows) => rows.map((r) => {
  const e = empOf(r.employee_id);
  return {
    ...r,
    employee_name: e.name,
    team_name: teamNameOf(e.team_id),
    current_stage_name: roleNameOf(r.current_stage_role_id),
    decided_by_name: decidedByName(r.decided_by),
    approval_reason_labels: reasonLabelsOf(r.approval_reason_ids),
    handover_to_name: r.handover_to_employee_id ? empOf(r.handover_to_employee_id).name : null
  };
});

const SCOPE_BANNER = {
  super_admin: 'Full, unrestricted access — configures Leave Types/Policy and every approval cap itself.',
  hr_admin: 'Company-wide leave — review, decide and configure leave types across all departments.',
  manager: 'Team/organization leave — review and decide requests.',
  assistant_manager: 'Team/organization leave — review and decide requests.'
};

// HR overview: KPIs + approval chain + leave types + on-leave-by-department.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  sendPendingLeaveReminders();
  const myEmpId = myEmployee(req.user.sub)?.id;

  // For a scoped role (stl/tl), every KPI/widget below is derived from filtered row sets
  // (not raw SQL COUNTs) so the numbers reflect only their assigned departments/teams.
  const withEmp = (rows) => rows.map((r) => ({ ...r, department: empOf(r.employee_id).department, team_id: empOf(r.employee_id).team_id }));

  const pendingRows = filterToScope(withEmp(db.prepare("SELECT * FROM leaves WHERE status = 'Pending'").all()), req.user.role, myEmpId);
  const approvedMtdRows = filterToScope(withEmp(db.prepare("SELECT * FROM leaves WHERE status = 'Approved' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").all()), req.user.role, myEmpId);
  const rejectedMtdRows = filterToScope(withEmp(db.prepare("SELECT * FROM leaves WHERE status = 'Rejected' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").all()), req.user.role, myEmpId);
  const onLeaveToday = filterToScope(withEmp(db.prepare("SELECT * FROM leaves WHERE status = 'Approved' AND cancelled = 0 AND date('now') BETWEEN from_date AND to_date").all()), req.user.role, myEmpId);

  const chainList = filterToScope(withEmp(db.prepare("SELECT * FROM leaves WHERE status = 'Pending' ORDER BY created_at DESC").all()), req.user.role, myEmpId)
    .slice(0, 8)
    .map((l) => ({ ...l, employee_name: empOf(l.employee_id).name, team_name: teamNameOf(l.team_id), current_stage_name: roleNameOf(l.current_stage_role_id) }))
    .map((l) => ({ ...l, waiting_on: l.current_stage_name || bottomRole()?.name }))
    .map((l) => ({ ...l, approvalSuggestion: approvalSuggestionFor(l) }));

  const byDept = {};
  let deptNames = db.prepare('SELECT name FROM departments ORDER BY name').all().map((d) => d.name);
  if (isScopedRole(req.user.role)) {
    const names = new Set(scopeDepartmentNames(getSupervisorScope(myEmpId)));
    deptNames = deptNames.filter((n) => names.has(n));
  }
  deptNames.forEach((name) => { byDept[name] = []; });
  onLeaveToday.forEach((l) => {
    const e = empOf(l.employee_id);
    const dept = e.department || 'Unassigned';
    (byDept[dept] = byDept[dept] || []).push({ name: e.name, team_name: teamNameOf(e.team_id), type: l.type, from_date: l.from_date, to_date: l.to_date, reason: l.reason });
  });

  const cancellationCount = filterToScope(
    withEmp(db.prepare("SELECT lc.id, l.employee_id FROM leave_cancellations lc JOIN leaves l ON l.id = lc.leave_id WHERE lc.status = 'Pending'").all()),
    req.user.role, myEmpId
  ).length;

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Pending Requests', value: pendingRows.length, color: 'blue' },
      { label: 'Approved (MTD)', value: approvedMtdRows.length, color: 'green' },
      { label: 'Rejected (MTD)', value: rejectedMtdRows.length, color: 'red' },
      { label: 'Employees on Leave Today', value: onLeaveToday.length, color: 'gold' },
      { label: 'Cancellation Requests', value: cancellationCount, color: 'gold' }
    ],
    chainLabel: approvalChainLabel(),
    chainList,
    leaveTypes: allTypes(),
    byDept: Object.entries(byDept).map(([department, people]) => ({ department, people }))
  });
});

// --- Leave types: read by anyone authed; edit/pause/add by Super Admin only ---
router.get('/types', (req, res) => res.json({ leaveTypes: allTypes() }));

// Concurrent Leave Cap setting — everyone can read it (shown as context on the apply form),
// only Super Admin can change it, same gate as leave-type management just below.
router.get('/concurrent-limit', (req, res) => res.json({ limitPct: getConcurrentLeaveLimitPct() }));
router.put('/concurrent-limit', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change this setting' });
  const pct = parseInt(req.body?.limitPct, 10);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) return res.status(400).json({ error: 'limitPct must be a whole number between 1 and 100.' });
  setConcurrentLeaveLimitPct(pct);
  res.json({ limitPct: pct });
});

// Flat headcount ceiling — same read/write gate as the percentage above.
router.get('/concurrent-max-count', (req, res) => res.json({ maxCount: getConcurrentLeaveMaxCount() }));
router.put('/concurrent-max-count', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change this setting' });
  const n = parseInt(req.body?.maxCount, 10);
  if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'maxCount must be a whole number of at least 1.' });
  setConcurrentLeaveMaxCount(n);
  res.json({ maxCount: n });
});

router.post('/types', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can add leave types' });
  const { name, code, annual_quota, unpaid } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  const quota = unpaid ? 0 : Math.max(0, parseInt(annual_quota, 10) || 0);
  try {
    const info = db.prepare('INSERT INTO leave_types (name, code, annual_quota, unpaid) VALUES (?, ?, ?, ?)')
      .run(name.trim(), code.trim().toUpperCase(), quota, unpaid ? 1 : 0);
    // Provision a balance row for every existing employee so the new type is immediately usable.
    const ins = db.prepare('INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance) VALUES (?, ?, ?)');
    db.prepare('SELECT id FROM employees').all().forEach((e) => ins.run(e.id, info.lastInsertRowid, quota));
    res.status(201).json({ leaveTypes: allTypes() });
  } catch { res.status(409).json({ error: 'A leave type with this code already exists' }); }
});

router.put('/types/:id', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can edit leave types' });
  const t = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Leave type not found' });
  const { name, annual_quota, unpaid } = req.body || {};
  const nextUnpaid = unpaid === undefined ? t.unpaid : (unpaid ? 1 : 0);
  const nextQuota = nextUnpaid ? 0 : (annual_quota !== undefined ? Math.max(0, parseInt(annual_quota, 10) || 0) : t.annual_quota);
  db.prepare('UPDATE leave_types SET name = COALESCE(?, name), annual_quota = ?, unpaid = ? WHERE id = ?')
    .run(name?.trim() || null, nextQuota, nextUnpaid, req.params.id);
  res.json({ leaveType: db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id) });
});

router.put('/types/:id/pause', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can pause leave types' });
  const t = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Leave type not found' });
  db.prepare('UPDATE leave_types SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, req.params.id);
  res.json({ leaveType: db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id) });
});

// --- Approval reasons: a fixed catalog an approver picks from when approving a 4+ day leave
// request (see decide() below). Read by anyone authed; add/edit/pause by Super Admin only —
// same catalog+active-toggle shape as leave types.
router.get('/approval-reasons', (req, res) => res.json({ reasons: allReasons() }));

router.post('/approval-reasons', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can add approval reasons' });
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM leave_approval_reasons').get().m;
    db.prepare('INSERT INTO leave_approval_reasons (label, sort_order) VALUES (?, ?)').run(label.trim(), maxOrder + 1);
    res.status(201).json({ reasons: allReasons() });
  } catch { res.status(409).json({ error: 'This reason already exists' }); }
});

router.put('/approval-reasons/:id', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can edit approval reasons' });
  const r = db.prepare('SELECT * FROM leave_approval_reasons WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reason not found' });
  const { label, active } = req.body || {};
  db.prepare('UPDATE leave_approval_reasons SET label = COALESCE(?, label), active = ? WHERE id = ?')
    .run(label?.trim() || null, active === undefined ? r.active : (active ? 1 : 0), req.params.id);
  res.json({ reason: db.prepare('SELECT * FROM leave_approval_reasons WHERE id = ?').get(req.params.id) });
});

// --- Reports: per-type balances table + full balance-change history ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const types = activeTypes();
  const employees = filterToScope(
    db.prepare('SELECT id, employee_code, name, department, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  );
  const balances = employees.map((e) => {
    const values = {};
    types.forEach((t) => { values[t.id] = t.unpaid ? daysTakenThisYear(e.id, t.id) : balanceOf(e.id, t.id); });
    return { employee_id: e.id, employee_code: e.employee_code, name: e.name, department: e.department, values };
  });
  const history = db.prepare(`
    SELECT h.*, e.name AS employee_name FROM leave_balance_history h JOIN employees e ON e.id = h.employee_id
    ORDER BY h.created_at DESC LIMIT 200
  `).all();
  res.json({ leaveTypes: types, balances, history });
});

// ?id=<employee id> narrows this to a single employee's leave balances — same columns, one row —
// rather than a separate endpoint, matching /reports/employees.csv's pattern. Filtered through
// filterToScope FIRST so a scoped role can't export someone outside their department/team just by
// passing an arbitrary id.
router.get('/reports/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const types = activeTypes();
  const employeeId = req.query.id ? Number(req.query.id) : null;
  let employees = filterToScope(
    db.prepare('SELECT id, employee_code, name, department, team_id FROM employees ORDER BY id').all(),
    req.user.role, myEmployee(req.user.sub)?.id
  );
  if (employeeId) employees = employees.filter((e) => e.id === employeeId);
  const header = ['code', 'name', 'department', ...types.map((t) => t.unpaid ? `${t.code} (days used)` : t.code)];
  const rows = employees.map((e) => [e.employee_code, e.name, e.department, ...types.map((t) => t.unpaid ? daysTakenThisYear(e.id, t.id) : balanceOf(e.id, t.id))].join(','));
  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `leave-balance-${employees[0]?.employee_code || employeeId}` : 'leave-balances'}.csv"`);
  res.send(csv);
});

router.get('/balance-history', (req, res) => {
  if (isHR(req.user.role)) {
    const employeeId = req.query.employee_id;
    if (employeeId) applyMonthlyAccrual(employeeId); // trigger any pending accrual before reading, else recent months are missing
    const rows = employeeId
      ? db.prepare('SELECT * FROM leave_balance_history WHERE employee_id = ? ORDER BY created_at DESC').all(employeeId)
      : db.prepare('SELECT * FROM leave_balance_history ORDER BY created_at DESC LIMIT 100').all();
    const enriched = rows.map((r) => ({ ...r, department: empOf(r.employee_id).department, team_id: empOf(r.employee_id).team_id }));
    const scoped = filterToScope(enriched, req.user.role, myEmployee(req.user.sub)?.id);
    return res.json({ history: scoped.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name })) });
  }
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ history: [] });
  applyMonthlyAccrual(me.id);
  res.json({ history: db.prepare('SELECT * FROM leave_balance_history WHERE employee_id = ? ORDER BY created_at DESC').all(me.id) });
});

// --- Pending cancellation requests (HR) ---
router.get('/cancellations', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT lc.*, l.type, l.from_date, l.to_date, l.days, l.employee_id
    FROM leave_cancellations lc JOIN leaves l ON l.id = lc.leave_id
    WHERE lc.status = 'Pending' ORDER BY lc.created_at DESC
  `).all();
  const enriched = rows.map((r) => ({ ...r, department: empOf(r.employee_id).department, team_id: empOf(r.employee_id).team_id }));
  const scoped = filterToScope(enriched, req.user.role, myEmployee(req.user.sub)?.id);
  res.json({ cancellations: scoped.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name, team_name: teamNameOf(r.team_id) })) });
});

function restoreBalanceForLeave(leave) {
  if (!leave.leave_type_id) return;
  const lt = typeById(leave.leave_type_id);
  if (!lt || lt.unpaid) return;
  const newBal = balanceOf(leave.employee_id, leave.leave_type_id) + leave.days;
  setBalance(leave.employee_id, leave.leave_type_id, newBal);
  logBalanceHistory(leave.employee_id, leave.type, leave.days, newBal, `Leave cancelled (${leave.from_date} to ${leave.to_date})`, null);
}

function decideCancel(finalStatus) {
  return (req, res) => {
    // Feature-level gate: cancellation decisions are part of the 'Leave Approval' feature —
    // a role needs the specific Approve/Reject action granted, not just module-level access.
    const action = finalStatus === 'Approved' ? 'Approve' : 'Reject';
    if (!canFeatureAction(req.user.role, '08', 'Leave Approval', action)) return res.status(403).json({ error: 'Insufficient permissions' });
    const c = db.prepare('SELECT * FROM leave_cancellations WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cancellation request not found' });
    if (c.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(c.leave_id);
    if (isScopedRole(req.user.role)) {
      const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
      if (!isEmployeeInScope(scope, empOf(leave.employee_id))) return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
    }

    if (finalStatus === 'Approved') {
      restoreBalanceForLeave(leave);
      db.prepare('UPDATE leaves SET cancelled = 1, cancel_requested = 0 WHERE id = ?').run(leave.id);
    } else {
      db.prepare('UPDATE leaves SET cancel_requested = 0 WHERE id = ?').run(leave.id);
    }
    db.prepare('UPDATE leave_cancellations SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, c.id);
    res.json({ ok: true });
  };
}
router.post('/cancellations/:id/approve', decideCancel('Approved'));
router.post('/cancellations/:id/reject', decideCancel('Rejected'));

// --- Main list + apply ---
router.get('/', (req, res) => {
  sendPendingLeaveReminders();
  if (isHR(req.user.role)) {
    const rows = db.prepare("SELECT * FROM leaves ORDER BY (status='Pending') DESC, created_at DESC").all();
    const enriched = rows.map((r) => ({ ...r, department: empOf(r.employee_id).department, team_id: empOf(r.employee_id).team_id }));
    const scoped = filterToScope(enriched, req.user.role, myEmployee(req.user.sub)?.id);
    const named = withName(scoped).map((l) => (l.status === 'Pending' ? { ...l, approvalSuggestion: approvalSuggestionFor(l) } : l));
    return res.json({ leaves: named });
  }
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ leaves: [], balances: [] });
  const rows = db.prepare('SELECT * FROM leaves WHERE employee_id = ? ORDER BY created_at DESC').all(me.id);
  res.json({ leaves: withName(rows), balances: balancesFor(me.id) });
});

router.get('/balance', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  res.json({ balances: balancesFor(me.id) });
});

// Always "my own" requests + balances + balance history, regardless of role — a Senior Team
// Lead/Team Lead is an employee too and needs their own record here, not the team-wide list
// that GET / and /balance-history above return for them once isHR admits scoped roles.
router.get('/mine', (req, res) => {
  const me = myEmployee(req.user.sub);
  // chainLabel is a plain "Role → Role → Role" string, not sensitive — returned here (not just
  // from /overview, which is HR-only) so a plain employee's ChainStepper can actually render
  // instead of silently failing to load it.
  if (!me) return res.json({ leaves: [], balances: [], history: [], chainLabel: approvalChainLabel() });
  sendPendingLeaveReminders();
  const rows = db.prepare('SELECT * FROM leaves WHERE employee_id = ? ORDER BY created_at DESC').all(me.id);
  const balances = balancesFor(me.id); // must run first — this is what triggers/logs the lazy accrual the history query below reads
  const history = db.prepare('SELECT * FROM leave_balance_history WHERE employee_id = ? ORDER BY created_at DESC').all(me.id);
  res.json({ leaves: withName(rows), balances, history, chainLabel: approvalChainLabel() });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { leave_type_id, from_date, to_date, reason, document_data_url, document_name, is_emergency, handover_to_employee_id, handover_notes, handover_attachment_data_url, handover_attachment_name } = req.body || {};
  const lt = leave_type_id ? typeById(leave_type_id) : null;
  if (!lt || !from_date || !to_date) return res.status(400).json({ error: 'leave_type_id, from_date and to_date are required' });
  if (!lt.active) return res.status(400).json({ error: `${lt.name} is currently paused and cannot be applied for.` });
  if (to_date < from_date) return res.status(400).json({ error: 'End date cannot be before start date' });
  const emergency = !!is_emergency;
  if (emergency && !reason?.trim()) return res.status(400).json({ error: 'A reason is required for emergency leave.' });
  if (handover_to_employee_id && !isValidHandoverTarget(me.id, me.department, handover_to_employee_id)) {
    return res.status(400).json({ error: 'Handover must go to a colleague in your own department — or, if you\'re a Team Lead, another Team Lead in any department.' });
  }

  const days = daysBetween(from_date, to_date);
  if (!lt.unpaid) {
    const bal = balanceOf(me.id, lt.id);
    if (bal < days) return res.status(400).json({ error: `Not enough ${lt.name} balance (${bal} left, ${days} requested)` });
  }

  // Concurrent Leave Cap: compare against every other employee in the same department — if too
  // many people would be out at once for these dates, the request is normally blocked outright
  // rather than silently approved and discovered short-staffed later. Two independent ceilings
  // both apply and whichever is stricter wins: a percentage of the department AND a flat
  // headcount (a % alone can still let a small department's whole team out at once). Emergency
  // leave is the one exception — a genuine emergency shouldn't be held up by a headcount rule —
  // but if it would have exceeded either cap, HR still gets alerted so the conflict is visible,
  // not silent.
  const deptTotal = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE department = ? AND status = 'Active'").get(me.department).n;
  const limitPct = getConcurrentLeaveLimitPct();
  const maxCount = getConcurrentLeaveMaxCount();
  const maxConcurrent = Math.min(Math.max(1, Math.floor(deptTotal * limitPct / 100)), maxCount);
  const alreadyOut = overlappingDeptLeaveCount(me, from_date, to_date);
  const overCap = alreadyOut + 1 > maxConcurrent;
  if (overCap && !emergency) {
    return res.status(400).json({
      error: `Too many people in ${me.department} are already scheduled off during these dates (${alreadyOut} of ${deptTotal} employees, over the limit of ${maxConcurrent}) — please pick different dates, check with HR, or mark this as an emergency if it can't wait.`
    });
  }

  const stage = bottomRole();
  const info = db.prepare(`
    INSERT INTO leaves (employee_id, leave_type_id, type, from_date, to_date, days, reason, current_stage_role_id, document_data_url, document_name, is_emergency, handover_to_employee_id, handover_notes, handover_attachment_data_url, handover_attachment_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.id, lt.id, lt.name, from_date, to_date, days, reason || null, stage ? stage.id : null, document_data_url || null, document_name || null, emergency ? 1 : 0, handover_to_employee_id || null, handover_notes?.trim() || null, handover_attachment_data_url || null, handover_attachment_name || null);

  if (overCap && emergency) {
    db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)').run(
      'Emergency Leave — Department Over Capacity',
      `${me.name}'s emergency ${lt.name} request (${from_date} to ${to_date}) was let through despite ${me.department} already having ${alreadyOut} of ${deptTotal} employees out (over the limit of ${maxConcurrent}). Reason: ${reason.trim()}`,
      'staff'
    );
  }

  if (handover_to_employee_id) {
    notifyEmployee(handover_to_employee_id, 'You\'ve been asked to cover a leave', `${me.name} has named you to cover their work while on ${lt.name} from ${from_date} to ${to_date}.${handover_notes?.trim() ? ` Notes: ${handover_notes.trim()}` : ''}`);
  }

  res.status(201).json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(info.lastInsertRowid)])[0] });
});

// Employee sets/updates who covers their work — only while the request is still Pending (once
// decided, the point of naming a handover before approval has already passed).
router.put('/:id/handover', (req, res) => {
  const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && leave.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  if (leave.status !== 'Pending') return res.status(400).json({ error: 'Only a still-pending request\'s handover can be changed.' });
  const { handover_to_employee_id, handover_notes, handover_attachment_data_url, handover_attachment_name } = req.body || {};
  if (!handover_to_employee_id) return res.status(400).json({ error: 'A handover assignee is required.' });
  const owner = empOf(leave.employee_id);
  if (!isValidHandoverTarget(leave.employee_id, owner.department, handover_to_employee_id)) {
    return res.status(400).json({ error: 'Handover must go to a colleague in the requester\'s own department — or, if they\'re a Team Lead, another Team Lead in any department.' });
  }
  db.prepare('UPDATE leaves SET handover_to_employee_id = ?, handover_notes = ?, handover_attachment_data_url = ?, handover_attachment_name = ? WHERE id = ?')
    .run(handover_to_employee_id, handover_notes?.trim() || null, handover_attachment_data_url || null, handover_attachment_name || null, leave.id);
  notifyEmployee(handover_to_employee_id, 'You\'ve been asked to cover a leave', `${owner.name || 'A colleague'} has named you to cover their work while on ${leave.type} from ${leave.from_date} to ${leave.to_date}.${handover_notes?.trim() ? ` Notes: ${handover_notes.trim()}` : ''}`);
  res.json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(leave.id)])[0] });
});

// Colleagues this user is allowed to hand their work over to — their own department, plus (if
// they're a Team Lead) every other Team Lead company-wide, since a small department may not have
// a second TL to receive it.
router.get('/handover-candidates', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ candidates: [] });
  res.json({ candidates: handoverCandidatesFor(me.id, me.department) });
});

// Employee (or HR on their behalf) requests cancellation of an already-approved, active leave.
router.post('/:id/request-cancel', (req, res) => {
  const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found' });
  const me = myEmployee(req.user.sub);
  if ((!me || leave.employee_id !== me.id) && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (leave.status !== 'Approved' || leave.cancelled) return res.status(400).json({ error: 'Only an approved, active leave can have a cancellation requested.' });
  if (db.prepare("SELECT id FROM leave_cancellations WHERE leave_id = ? AND status = 'Pending'").get(leave.id)) {
    return res.status(400).json({ error: 'A cancellation request is already pending for this leave.' });
  }
  db.prepare('INSERT INTO leave_cancellations (leave_id, reason) VALUES (?, ?)').run(leave.id, req.body?.reason || null);
  db.prepare('UPDATE leaves SET cancel_requested = 1 WHERE id = ?').run(leave.id);
  res.status(201).json({ ok: true });
});

// Employee withdraws their own still-pending cancellation request.
router.post('/:id/withdraw-cancel', (req, res) => {
  const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
  if (!leave) return res.status(404).json({ error: 'Leave request not found' });
  const me = myEmployee(req.user.sub);
  if ((!me || leave.employee_id !== me.id) && !isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const pending = db.prepare("SELECT * FROM leave_cancellations WHERE leave_id = ? AND status = 'Pending'").get(leave.id);
  if (!pending) return res.status(400).json({ error: 'There is no pending cancellation request to withdraw.' });
  db.prepare('DELETE FROM leave_cancellations WHERE id = ?').run(pending.id);
  db.prepare('UPDATE leaves SET cancel_requested = 0 WHERE id = ?').run(leave.id);
  res.json({ ok: true });
});

// Sequential approval chain — see server/src/utils/chain.js for the shared mechanics
// (also used by Attendance regularization requests).
function decide(finalStatus) {
  return (req, res) => {
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });
    if (leave.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });

    // Work Handover: a leave can't be approved until someone is named to cover the requester's
    // work — no gate on Reject, since a rejected request never goes out anyway.
    if (finalStatus === 'Approved' && !leave.handover_to_employee_id) {
      return res.status(400).json({ error: 'This request needs a handover assignee before it can be approved — ask the employee to name who will cover their work.' });
    }

    // A Senior Team Lead/Team Lead may only act on requests from employees within their
    // assigned departments/teams — even though the chain says it's their turn — unlike every
    // other HR-tier role in the chain, whose reach stays company-wide.
    if (isScopedRole(req.user.role)) {
      const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
      if (!isEmployeeInScope(scope, empOf(leave.employee_id))) {
        return res.status(403).json({ error: 'This employee is outside your assigned department/team.' });
      }
    }

    const result = evaluateDecision(req.user.role, leave.current_stage_role_id, finalStatus === 'Rejected');
    if (result.error) return res.status(403).json({ error: result.error });

    // Company rule: some roles (e.g. Team Lead) may only approve leave requests up to a
    // configured number of days — longer requests must be escalated to a more senior role.
    if (finalStatus === 'Approved' && result.actorRole.max_leave_approval_days != null && leave.days > result.actorRole.max_leave_approval_days) {
      return res.status(403).json({
        error: `${result.actorRole.name} can only approve leave requests up to ${result.actorRole.max_leave_approval_days} day(s). This request (${leave.days} days) must be escalated to a more senior approver.`
      });
    }

    // Company rule: approving a 4+ day request requires the approver to pick at least one reason
    // from the Super-Admin-managed catalog (e.g. "Medical Emergency") — a Super Admin is exempt,
    // same as they're exempt from max_leave_approval_days above, since they're the system
    // administrator of this workflow rather than a participant in it. Reasons accumulate across
    // every stage of the chain (not just whichever approval happens to finalize the request) —
    // with Super Admin unpaused/top-of-chain by default, they're often the one who finalizes, so
    // capturing only the finalizing approval's reason would silently lose the STL/Assistant
    // Manager/Manager reason that was actually required and given earlier in the chain.
    let reasonIds = null;
    const existingReasonIds = leave.approval_reason_ids ? (JSON.parse(leave.approval_reason_ids) || []) : [];
    if (finalStatus === 'Approved' && leave.days >= 4 && req.user.role !== 'super_admin') {
      const submitted = Array.isArray(req.body?.reason_ids) ? req.body.reason_ids.map((id) => parseInt(id, 10)).filter(Number.isFinite) : [];
      const valid = new Set(activeReasons().map((r) => r.id));
      reasonIds = submitted.filter((id) => valid.has(id));
      if (!reasonIds.length) {
        return res.status(400).json({ error: `Approving a ${leave.days}-day leave request requires selecting at least one reason.` });
      }
    }
    const mergedReasonIds = reasonIds ? [...new Set([...existingReasonIds, ...reasonIds])] : existingReasonIds;

    if (result.finalized) {
      if (finalStatus === 'Approved') {
        const lt = leave.leave_type_id ? typeById(leave.leave_type_id) : null;
        if (lt && !lt.unpaid) {
          const bal = balanceOf(leave.employee_id, lt.id);
          if (bal < leave.days) return res.status(400).json({ error: 'Employee no longer has enough balance' });
          const newBal = bal - leave.days;
          setBalance(leave.employee_id, lt.id, newBal);
          logBalanceHistory(leave.employee_id, leave.type, -leave.days, newBal, `Leave approved (${leave.from_date} to ${leave.to_date})`, req.user.sub);
        }
        db.prepare('UPDATE leaves SET status = ?, decided_by = ?, current_stage_role_id = NULL, approval_reason_ids = ? WHERE id = ?')
          .run('Approved', req.user.sub, mergedReasonIds.length ? JSON.stringify(mergedReasonIds) : null, leave.id);
        notifyEmployee(leave.employee_id, 'Leave approved', `Your ${leave.type} request (${leave.from_date} to ${leave.to_date}) was approved.`);
      } else {
        db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run('Rejected', req.user.sub, leave.id);
        notifyEmployee(leave.employee_id, 'Leave rejected', `Your ${leave.type} request (${leave.from_date} to ${leave.to_date}) was rejected.`);
      }
    } else {
      db.prepare('UPDATE leaves SET current_stage_role_id = ?, approval_reason_ids = ? WHERE id = ?')
        .run(result.stageRoleId, mergedReasonIds.length ? JSON.stringify(mergedReasonIds) : null, leave.id);
    }
    res.json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(leave.id)])[0] });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;

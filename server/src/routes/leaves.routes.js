import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { bottomRole, approvalChainLabel, evaluateDecision } from '../utils/chain.js';
import { notifyEmployee } from '../utils/notify.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function activeTypes() { return db.prepare('SELECT * FROM leave_types WHERE active = 1 ORDER BY id').all(); }
function allTypes() { return db.prepare('SELECT * FROM leave_types ORDER BY id').all(); }
function typeById(id) { return db.prepare('SELECT * FROM leave_types WHERE id = ?').get(id); }

function ensureBalances(employeeId) {
  const types = allTypes();
  const have = new Set(db.prepare('SELECT leave_type_id FROM employee_leave_balances WHERE employee_id = ?').all(employeeId).map((r) => r.leave_type_id));
  const ins = db.prepare('INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance) VALUES (?, ?, ?)');
  types.forEach((t) => { if (!have.has(t.id)) ins.run(employeeId, t.id, t.annual_quota); });
}
function balanceOf(employeeId, leaveTypeId) {
  ensureBalances(employeeId);
  return db.prepare('SELECT balance FROM employee_leave_balances WHERE employee_id = ? AND leave_type_id = ?').get(employeeId, leaveTypeId)?.balance ?? 0;
}
function setBalance(employeeId, leaveTypeId, balance) {
  db.prepare('INSERT INTO employee_leave_balances (employee_id, leave_type_id, balance) VALUES (?, ?, ?) ON CONFLICT(employee_id, leave_type_id) DO UPDATE SET balance = excluded.balance')
    .run(employeeId, leaveTypeId, balance);
}
function logBalanceHistory(employeeId, leaveTypeName, change, balanceAfter, reason, actorId) {
  db.prepare('INSERT INTO leave_balance_history (employee_id, leave_type, change, balance_after, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employeeId, leaveTypeName, change, balanceAfter, reason, actorId || null);
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
  ensureBalances(employeeId);
  return db.prepare(`
    SELECT lt.id AS leave_type_id, lt.name, lt.code, lt.unpaid, elb.balance
    FROM leave_types lt LEFT JOIN employee_leave_balances elb ON elb.leave_type_id = lt.id AND elb.employee_id = ?
    WHERE lt.active = 1 ORDER BY lt.id
  `).all(employeeId).map((b) => ({ ...b, days_taken_ytd: b.unpaid ? daysTakenThisYear(employeeId, b.leave_type_id) : null }));
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

const empOf = (id) => db.prepare('SELECT name, department FROM employees WHERE id = ?').get(id) || {};
const roleNameOf = (id) => (id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(id)?.name : null);
const withName = (rows) => rows.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name, current_stage_name: roleNameOf(r.current_stage_role_id) }));

const SCOPE_BANNER = {
  super_admin: 'Full, unrestricted access — configures Leave Types/Policy and every approval cap itself.',
  hr_admin: 'Company-wide leave — review, decide and configure leave types across all departments.',
  manager: 'Team/organization leave — review and decide requests.',
  assistant_manager: 'Team/organization leave — review and decide requests.'
};

// HR overview: KPIs + approval chain + leave types + on-leave-by-department.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const pending = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Pending'").get().c;
  const approvedMtd = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Approved' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().c;
  const rejectedMtd = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Rejected' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().c;
  const onLeaveToday = db.prepare("SELECT * FROM leaves WHERE status = 'Approved' AND cancelled = 0 AND date('now') BETWEEN from_date AND to_date").all();

  const chainList = withName(db.prepare("SELECT * FROM leaves WHERE status = 'Pending' ORDER BY created_at DESC LIMIT 8").all())
    .map((l) => ({ ...l, waiting_on: l.current_stage_name || bottomRole()?.name }));

  const byDept = {};
  db.prepare('SELECT name FROM departments ORDER BY name').all().forEach((d) => { byDept[d.name] = []; });
  onLeaveToday.forEach((l) => {
    const e = empOf(l.employee_id);
    const dept = e.department || 'Unassigned';
    (byDept[dept] = byDept[dept] || []).push({ name: e.name, type: l.type, from_date: l.from_date, to_date: l.to_date, reason: l.reason });
  });

  const cancellationCount = db.prepare("SELECT COUNT(*) c FROM leave_cancellations WHERE status = 'Pending'").get().c;

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Pending Requests', value: pending, color: 'blue' },
      { label: 'Approved (MTD)', value: approvedMtd, color: 'green' },
      { label: 'Rejected (MTD)', value: rejectedMtd, color: 'red' },
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

// --- Reports: per-type balances table + full balance-change history ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const types = activeTypes();
  const employees = db.prepare('SELECT id, employee_code, name, department FROM employees ORDER BY id').all();
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

router.get('/reports/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const types = activeTypes();
  const employees = db.prepare('SELECT id, employee_code, name, department FROM employees ORDER BY id').all();
  const header = ['code', 'name', 'department', ...types.map((t) => t.unpaid ? `${t.code} (days used)` : t.code)];
  const rows = employees.map((e) => [e.employee_code, e.name, e.department, ...types.map((t) => t.unpaid ? daysTakenThisYear(e.id, t.id) : balanceOf(e.id, t.id))].join(','));
  const csv = [header.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leave-balances.csv"');
  res.send(csv);
});

router.get('/balance-history', (req, res) => {
  if (isHR(req.user.role)) {
    const employeeId = req.query.employee_id;
    const rows = employeeId
      ? db.prepare('SELECT * FROM leave_balance_history WHERE employee_id = ? ORDER BY created_at DESC').all(employeeId)
      : db.prepare('SELECT * FROM leave_balance_history ORDER BY created_at DESC LIMIT 100').all();
    return res.json({ history: rows.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name })) });
  }
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ history: [] });
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
  res.json({ cancellations: rows.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name })) });
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
    if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const c = db.prepare('SELECT * FROM leave_cancellations WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cancellation request not found' });
    if (c.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(c.leave_id);

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
  if (isHR(req.user.role)) {
    const rows = db.prepare("SELECT * FROM leaves ORDER BY (status='Pending') DESC, created_at DESC").all();
    return res.json({ leaves: withName(rows) });
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

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { leave_type_id, from_date, to_date, reason } = req.body || {};
  const lt = leave_type_id ? typeById(leave_type_id) : null;
  if (!lt || !from_date || !to_date) return res.status(400).json({ error: 'leave_type_id, from_date and to_date are required' });
  if (!lt.active) return res.status(400).json({ error: `${lt.name} is currently paused and cannot be applied for.` });
  if (to_date < from_date) return res.status(400).json({ error: 'End date cannot be before start date' });

  const days = daysBetween(from_date, to_date);
  if (!lt.unpaid) {
    const bal = balanceOf(me.id, lt.id);
    if (bal < days) return res.status(400).json({ error: `Not enough ${lt.name} balance (${bal} left, ${days} requested)` });
  }

  const stage = bottomRole();
  const info = db.prepare('INSERT INTO leaves (employee_id, leave_type_id, type, from_date, to_date, days, reason, current_stage_role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(me.id, lt.id, lt.name, from_date, to_date, days, reason || null, stage ? stage.id : null);
  res.status(201).json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(info.lastInsertRowid)])[0] });
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

    const result = evaluateDecision(req.user.role, leave.current_stage_role_id, finalStatus === 'Rejected');
    if (result.error) return res.status(403).json({ error: result.error });

    // Company rule: some roles (e.g. Team Lead) may only approve leave requests up to a
    // configured number of days — longer requests must be escalated to a more senior role.
    if (finalStatus === 'Approved' && result.actorRole.max_leave_approval_days != null && leave.days > result.actorRole.max_leave_approval_days) {
      return res.status(403).json({
        error: `${result.actorRole.name} can only approve leave requests up to ${result.actorRole.max_leave_approval_days} day(s). This request (${leave.days} days) must be escalated to a more senior approver.`
      });
    }

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
        db.prepare('UPDATE leaves SET status = ?, decided_by = ?, current_stage_role_id = NULL WHERE id = ?').run('Approved', req.user.sub, leave.id);
        notifyEmployee(leave.employee_id, 'Leave approved', `Your ${leave.type} request (${leave.from_date} to ${leave.to_date}) was approved.`);
      } else {
        db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run('Rejected', req.user.sub, leave.id);
        notifyEmployee(leave.employee_id, 'Leave rejected', `Your ${leave.type} request (${leave.from_date} to ${leave.to_date}) was rejected.`);
      }
    } else {
      db.prepare('UPDATE leaves SET current_stage_role_id = ? WHERE id = ?').run(result.stageRoleId, leave.id);
    }
    res.json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(leave.id)])[0] });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;

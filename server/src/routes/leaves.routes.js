import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const BALANCE_COL = { Casual: 'casual', Sick: 'sick', Earned: 'earned' };
const CODE_OF_TYPE = { Casual: 'CL', Sick: 'SL', Earned: 'EL' };

function ensureBalance(employeeId) {
  let bal = db.prepare('SELECT * FROM leave_balances WHERE employee_id = ?').get(employeeId);
  if (!bal) {
    db.prepare('INSERT INTO leave_balances (employee_id) VALUES (?)').run(employeeId);
    bal = db.prepare('SELECT * FROM leave_balances WHERE employee_id = ?').get(employeeId);
  }
  return bal;
}

function logBalanceHistory(employeeId, leaveType, change, balanceAfter, reason, actorId) {
  db.prepare('INSERT INTO leave_balance_history (employee_id, leave_type, change, balance_after, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(employeeId, leaveType, change, balanceAfter, reason, actorId || null);
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

// The approval chain, bottom (least authority) → top, from the live role workflow.
// Paused roles are skipped and 'employee' is excluded — this drives both the display label
// and the actual sequential gating below, so reordering/pausing roles in Organization
// Structure changes how leave approval really flows, not just what's shown.
function chainRoles() {
  return db.prepare("SELECT * FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC").all();
}
function bottomRole() {
  return chainRoles()[0] || db.prepare("SELECT * FROM roles WHERE key = 'super_admin'").get();
}
function roleAbove(sortOrder) {
  return db.prepare("SELECT * FROM roles WHERE key != 'employee' AND paused = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1").get(sortOrder);
}
function approvalChainLabel() {
  return chainRoles().map((r) => r.name).join(' → ');
}

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
    leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY id').all(),
    byDept: Object.entries(byDept).map(([department, people]) => ({ department, people }))
  });
});

// --- Leave types: read by anyone authed; edit/pause by Super Admin only ---
router.get('/types', (req, res) => res.json({ leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY id').all() }));

router.post('/types', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can add leave types' });
  const { name, code, annual_quota, unpaid } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  try {
    db.prepare('INSERT INTO leave_types (name, code, annual_quota, unpaid) VALUES (?, ?, ?, ?)')
      .run(name.trim(), code.trim().toUpperCase(), Math.max(0, parseInt(annual_quota, 10) || 0), unpaid ? 1 : 0);
    res.status(201).json({ leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY id').all() });
  } catch { res.status(409).json({ error: 'A leave type with this code already exists' }); }
});

router.put('/types/:id', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can edit leave types' });
  const t = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Leave type not found' });
  const { name, annual_quota } = req.body || {};
  db.prepare('UPDATE leave_types SET name = COALESCE(?, name), annual_quota = COALESCE(?, annual_quota) WHERE id = ?')
    .run(name?.trim() || null, annual_quota !== undefined ? Math.max(0, parseInt(annual_quota, 10) || 0) : null, req.params.id);
  res.json({ leaveType: db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id) });
});

router.put('/types/:id/pause', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can pause leave types' });
  const t = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Leave type not found' });
  db.prepare('UPDATE leave_types SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, req.params.id);
  res.json({ leaveType: db.prepare('SELECT * FROM leave_types WHERE id = ?').get(req.params.id) });
});

// --- Reports: balances table + full balance-change history ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const balances = db.prepare(`
    SELECT e.id AS employee_id, e.employee_code, e.name, e.department, lb.casual, lb.sick, lb.earned
    FROM employees e LEFT JOIN leave_balances lb ON lb.employee_id = e.id ORDER BY e.id
  `).all();
  const history = db.prepare(`
    SELECT h.*, e.name AS employee_name FROM leave_balance_history h JOIN employees e ON e.id = h.employee_id
    ORDER BY h.created_at DESC LIMIT 200
  `).all();
  res.json({ balances, history });
});

router.get('/reports/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const balances = db.prepare(`
    SELECT e.employee_code, e.name, e.department, lb.casual, lb.sick, lb.earned
    FROM employees e LEFT JOIN leave_balances lb ON lb.employee_id = e.id ORDER BY e.id
  `).all();
  const csv = ['code,name,department,casual,sick,earned', ...balances.map((b) => `${b.employee_code},${b.name},${b.department},${b.casual ?? ''},${b.sick ?? ''},${b.earned ?? ''}`)].join('\n');
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

function decideCancel(finalStatus) {
  return (req, res) => {
    if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const c = db.prepare('SELECT * FROM leave_cancellations WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Cancellation request not found' });
    if (c.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(c.leave_id);

    if (finalStatus === 'Approved') {
      const col = BALANCE_COL[leave.type];
      if (col) {
        const bal = ensureBalance(leave.employee_id);
        const newBal = bal[col] + leave.days;
        db.prepare(`UPDATE leave_balances SET ${col} = ? WHERE employee_id = ?`).run(newBal, leave.employee_id);
        logBalanceHistory(leave.employee_id, leave.type, leave.days, newBal, `Leave cancelled (${leave.from_date} to ${leave.to_date})`, req.user.sub);
      }
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
  if (!me) return res.json({ leaves: [], balance: null });
  const rows = db.prepare('SELECT * FROM leaves WHERE employee_id = ? ORDER BY created_at DESC').all(me.id);
  res.json({ leaves: withName(rows), balance: ensureBalance(me.id) });
});

router.get('/balance', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  res.json({ balance: ensureBalance(me.id) });
});

router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { type, from_date, to_date, reason } = req.body || {};
  if (!BALANCE_COL[type] || !from_date || !to_date) return res.status(400).json({ error: 'type, from_date and to_date are required' });
  if (to_date < from_date) return res.status(400).json({ error: 'End date cannot be before start date' });

  const lt = db.prepare('SELECT * FROM leave_types WHERE code = ?').get(CODE_OF_TYPE[type]);
  if (lt && !lt.active) return res.status(400).json({ error: `${type} leave is currently paused and cannot be applied for.` });

  const days = daysBetween(from_date, to_date);
  const bal = ensureBalance(me.id);
  if (bal[BALANCE_COL[type]] < days) return res.status(400).json({ error: `Not enough ${type} leave balance (${bal[BALANCE_COL[type]]} left, ${days} requested)` });

  const stage = bottomRole();
  const info = db.prepare('INSERT INTO leaves (employee_id, type, from_date, to_date, days, reason, current_stage_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(me.id, type, from_date, to_date, days, reason || null, stage ? stage.id : null);
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

// Sequential approval chain. A role may act once its authority is at least as senior as the
// leave's current stage (skip-level approval is allowed); acting from a lower stage advances
// the chain to the next role above the actor, or finalizes if none remain. Super Admin always
// finalizes immediately, matching its full-access status elsewhere in the app.
function decide(finalStatus) {
  return (req, res) => {
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });
    if (leave.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });

    const actorRole = db.prepare('SELECT * FROM roles WHERE key = ?').get(req.user.role);
    if (!actorRole || actorRole.key === 'employee') return res.status(403).json({ error: 'Insufficient permissions' });

    if (req.user.role !== 'super_admin') {
      let stage = leave.current_stage_role_id ? db.prepare('SELECT * FROM roles WHERE id = ?').get(leave.current_stage_role_id) : null;
      if (!stage) stage = bottomRole();
      if (actorRole.sort_order > stage.sort_order) {
        return res.status(403).json({ error: `Waiting on ${stage.name} to act first.` });
      }
    }

    if (finalStatus === 'Rejected') {
      db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run('Rejected', req.user.sub, leave.id);
      return res.json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(leave.id)])[0] });
    }

    const above = req.user.role === 'super_admin' ? null : roleAbove(actorRole.sort_order);
    if (!above) {
      const col = BALANCE_COL[leave.type];
      const bal = ensureBalance(leave.employee_id);
      if (bal[col] < leave.days) return res.status(400).json({ error: 'Employee no longer has enough balance' });
      const newBal = bal[col] - leave.days;
      db.prepare(`UPDATE leave_balances SET ${col} = ? WHERE employee_id = ?`).run(newBal, leave.employee_id);
      logBalanceHistory(leave.employee_id, leave.type, -leave.days, newBal, `Leave approved (${leave.from_date} to ${leave.to_date})`, req.user.sub);
      db.prepare('UPDATE leaves SET status = ?, decided_by = ?, current_stage_role_id = NULL WHERE id = ?').run('Approved', req.user.sub, leave.id);
    } else {
      db.prepare('UPDATE leaves SET current_stage_role_id = ? WHERE id = ?').run(above.id, leave.id);
    }
    res.json({ leave: withName([db.prepare('SELECT * FROM leaves WHERE id = ?').get(leave.id)])[0] });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;

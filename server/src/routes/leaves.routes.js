import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const BALANCE_COL = { Casual: 'casual', Sick: 'sick', Earned: 'earned' };

function ensureBalance(employeeId) {
  let bal = db.prepare('SELECT * FROM leave_balances WHERE employee_id = ?').get(employeeId);
  if (!bal) {
    db.prepare('INSERT INTO leave_balances (employee_id) VALUES (?)').run(employeeId);
    bal = db.prepare('SELECT * FROM leave_balances WHERE employee_id = ?').get(employeeId);
  }
  return bal;
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

const empOf = (id) => db.prepare('SELECT name, department FROM employees WHERE id = ?').get(id) || {};
const withName = (rows) => rows.map((r) => ({ ...r, employee_name: empOf(r.employee_id).name }));

const SCOPE_BANNER = {
  super_admin: 'Full, unrestricted access — configures Leave Types/Policy and every approval cap itself.',
  hr_admin: 'Company-wide leave — review, decide and configure leave types across all departments.',
  manager: 'Team/organization leave — review and decide requests.',
  assistant_manager: 'Team/organization leave — review and decide requests.'
};

// Approval chain, bottom → top, from the role workflow (paused roles skipped, employee excluded).
function approvalChainLabel() {
  const roles = db.prepare("SELECT name FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC").all();
  return roles.map((r) => r.name).join(' → ');
}
function firstApprover() {
  const r = db.prepare("SELECT name FROM roles WHERE key != 'employee' AND paused = 0 ORDER BY sort_order DESC LIMIT 1").get();
  return r?.name || 'Manager';
}

// HR overview: KPIs + approval chain + leave types + on-leave-by-department.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const pending = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Pending'").get().c;
  const approvedMtd = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Approved' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().c;
  const rejectedMtd = db.prepare("SELECT COUNT(*) c FROM leaves WHERE status = 'Rejected' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().c;
  const onLeaveToday = db.prepare("SELECT * FROM leaves WHERE status = 'Approved' AND date('now') BETWEEN from_date AND to_date").all();

  const chainList = db.prepare("SELECT * FROM leaves WHERE status = 'Pending' ORDER BY created_at DESC LIMIT 8").all()
    .map((l) => ({ ...l, employee_name: empOf(l.employee_id).name, waiting_on: firstApprover() }));

  // Group today's approved leaves by department.
  const byDept = {};
  db.prepare('SELECT name FROM departments ORDER BY name').all().forEach((d) => { byDept[d.name] = []; });
  onLeaveToday.forEach((l) => {
    const e = empOf(l.employee_id);
    const dept = e.department || 'Unassigned';
    (byDept[dept] = byDept[dept] || []).push({ name: e.name, type: l.type, from_date: l.from_date, to_date: l.to_date, reason: l.reason });
  });

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Pending Requests', value: pending, color: 'blue' },
      { label: 'Approved (MTD)', value: approvedMtd, color: 'green' },
      { label: 'Rejected (MTD)', value: rejectedMtd, color: 'red' },
      { label: 'Employees on Leave Today', value: onLeaveToday.length, color: 'gold' }
    ],
    chainLabel: approvalChainLabel(),
    chainList,
    leaveTypes: db.prepare('SELECT * FROM leave_types ORDER BY id').all(),
    byDept: Object.entries(byDept).map(([department, people]) => ({ department, people }))
  });
});

// Leave types (any authed user can read; only super admin configures).
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

// Employee applies for leave.
router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { type, from_date, to_date, reason } = req.body || {};
  if (!BALANCE_COL[type] || !from_date || !to_date) return res.status(400).json({ error: 'type, from_date and to_date are required' });
  if (to_date < from_date) return res.status(400).json({ error: 'End date cannot be before start date' });

  const days = daysBetween(from_date, to_date);
  const bal = ensureBalance(me.id);
  if (bal[BALANCE_COL[type]] < days) return res.status(400).json({ error: `Not enough ${type} leave balance (${bal[BALANCE_COL[type]]} left, ${days} requested)` });

  const info = db.prepare('INSERT INTO leaves (employee_id, type, from_date, to_date, days, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(me.id, type, from_date, to_date, days, reason || null);
  res.status(201).json({ leave: db.prepare('SELECT * FROM leaves WHERE id = ?').get(info.lastInsertRowid) });
});

function decide(status) {
  return (req, res) => {
    if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id);
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });
    if (leave.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });

    if (status === 'Approved') {
      const col = BALANCE_COL[leave.type];
      const bal = ensureBalance(leave.employee_id);
      if (bal[col] < leave.days) return res.status(400).json({ error: 'Employee no longer has enough balance' });
      db.prepare(`UPDATE leave_balances SET ${col} = ${col} - ? WHERE employee_id = ?`).run(leave.days, leave.employee_id);
    }
    db.prepare('UPDATE leaves SET status = ?, decided_by = ? WHERE id = ?').run(status, req.user.sub, req.params.id);
    res.json({ leave: db.prepare('SELECT * FROM leaves WHERE id = ?').get(req.params.id) });
  };
}

router.post('/:id/approve', decide('Approved'));
router.post('/:id/reject', decide('Rejected'));

export default router;

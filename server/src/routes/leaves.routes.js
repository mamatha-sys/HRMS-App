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

const withName = (rows) => rows.map((r) => ({ ...r, employee_name: db.prepare('SELECT name FROM employees WHERE id = ?').get(r.employee_id)?.name }));

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

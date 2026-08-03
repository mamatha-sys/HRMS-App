import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { bottomRole } from '../utils/chain.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '18' (Shift & Roster). A Senior Team Lead/Team Lead/
// Assistant Manager also passes canView — but ONLY for the read-only /roster and /swap-requests
// (company) list below, both of which explicitly scope what they return to the caller's
// assigned department(s); every write endpoint (add/pause shift, assign roster, decide swap)
// still checks canModuleAdmin (or the feature-level Shift Swap Approval grant) directly, so
// scoped roles stay view-only here, matching Super Admin policy. Shift Swap Approval is not one
// of the 4 workflow approvals (Leave/Attendance/Expense/Timesheet) Super Admin carved out for
// these roles, so it stays blocked like every other manage action in this module.
const isHR = (role) => canModuleAdmin(role, '18');
const canView = (role) => canModuleAdmin(role, '18') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const employeeDepartment = (id) => db.prepare('SELECT department FROM employees WHERE id = ?').get(id)?.department;

router.get('/shifts', (req, res) => {
  res.json({ shifts: db.prepare('SELECT * FROM shifts ORDER BY start_time').all() });
});

router.post('/shifts', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, start_time, end_time } = req.body || {};
  if (!name?.trim() || !start_time || !end_time) return res.status(400).json({ error: 'Name, start time and end time are required' });
  if (db.prepare('SELECT 1 FROM shifts WHERE name = ?').get(name.trim())) return res.status(409).json({ error: 'A shift with this name already exists' });
  const info = db.prepare('INSERT INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)').run(name.trim(), start_time, end_time);
  res.status(201).json({ shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/shifts/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { status } = req.body || {};
  if (!['Active', 'Paused'].includes(status)) return res.status(400).json({ error: 'A valid status is required' });
  db.prepare('UPDATE shifts SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id) });
});

// HR (or a scoped role viewing their own department(s)): roster for a given date, every
// in-scope employee + their assigned shift (if any).
router.get('/roster', (req, res) => {
  if (!canView(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const date = req.query.date || db.prepare("SELECT date('now') AS d").get().d;
  let rows = db.prepare(`
    SELECT e.id AS employee_id, e.name, e.employee_code, e.department, ra.id AS assignment_id, s.id AS shift_id, s.name AS shift_name, s.start_time, s.end_time
    FROM employees e
    LEFT JOIN roster_assignments ra ON ra.employee_id = e.id AND ra.date = ?
    LEFT JOIN shifts s ON s.id = ra.shift_id
    WHERE e.status = 'Active'
    ORDER BY e.name
  `).all(date);
  if (isScopedRole(req.user.role)) {
    const deptNames = new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id)));
    rows = rows.filter((r) => deptNames.has(r.department));
  }
  res.json({ date, rows });
});

router.post('/roster', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, shift_id, date } = req.body || {};
  if (!employee_id || !shift_id || !date) return res.status(400).json({ error: 'employee_id, shift_id and date are required' });
  db.prepare(`
    INSERT INTO roster_assignments (employee_id, shift_id, date) VALUES (?, ?, ?)
    ON CONFLICT(employee_id, date) DO UPDATE SET shift_id = excluded.shift_id
  `).run(employee_id, shift_id, date);
  res.status(201).json({ ok: true });
});

// Employee: my own upcoming roster (today onward).
router.get('/roster/mine', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ rows: [] });
  const rows = db.prepare(`
    SELECT ra.date, s.name AS shift_name, s.start_time, s.end_time
    FROM roster_assignments ra JOIN shifts s ON s.id = ra.shift_id
    WHERE ra.employee_id = ? AND ra.date >= date('now')
    ORDER BY ra.date
  `).all(me.id);
  res.json({ rows });
});

// Employee requests a shift swap for a given date, optionally naming who they'd like to swap with.
router.post('/swap-requests', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { date, target_employee_id, reason } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date is required' });
  const stage = bottomRole();
  db.prepare('INSERT INTO shift_swap_requests (requester_employee_id, date, target_employee_id, reason) VALUES (?, ?, ?, ?)')
    .run(me.id, date, target_employee_id || null, reason || null);
  res.status(201).json({ ok: true, chainStage: stage?.name || null });
});

router.get('/swap-requests', (req, res) => {
  const withNames = (rows) => rows.map((r) => ({
    ...r,
    requester_name: db.prepare('SELECT name FROM employees WHERE id = ?').get(r.requester_employee_id)?.name,
    target_name: r.target_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(r.target_employee_id)?.name : null
  }));
  if (isHR(req.user.role)) {
    return res.json({ requests: withNames(db.prepare("SELECT * FROM shift_swap_requests ORDER BY (status='Pending') DESC, created_at DESC").all()) });
  }
  if (isScopedRole(req.user.role)) {
    const deptNames = new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id)));
    const rows = db.prepare("SELECT * FROM shift_swap_requests ORDER BY (status='Pending') DESC, created_at DESC").all()
      .filter((r) => deptNames.has(employeeDepartment(r.requester_employee_id)));
    return res.json({ requests: withNames(rows) });
  }
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ requests: [] });
  res.json({ requests: withNames(db.prepare('SELECT * FROM shift_swap_requests WHERE requester_employee_id = ? ORDER BY created_at DESC').all(me.id)) });
});

function decideSwap(finalStatus) {
  return (req, res) => {
    // Feature-level gate: this is exactly the 'Shift Swap Approval' feature.
    if (!canFeatureAction(req.user.role, '18', 'Shift Swap Approval', 'Approve')) return res.status(403).json({ error: 'Insufficient permissions' });
    const swap = db.prepare('SELECT * FROM shift_swap_requests WHERE id = ?').get(req.params.id);
    if (!swap) return res.status(404).json({ error: 'Swap request not found' });
    if (swap.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided' });
    db.prepare('UPDATE shift_swap_requests SET status = ?, decided_by = ? WHERE id = ?').run(finalStatus, req.user.sub, swap.id);
    if (finalStatus === 'Approved' && swap.target_employee_id) {
      const mine = db.prepare('SELECT shift_id FROM roster_assignments WHERE employee_id = ? AND date = ?').get(swap.requester_employee_id, swap.date);
      const theirs = db.prepare('SELECT shift_id FROM roster_assignments WHERE employee_id = ? AND date = ?').get(swap.target_employee_id, swap.date);
      if (mine) db.prepare('INSERT INTO roster_assignments (employee_id, shift_id, date) VALUES (?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET shift_id = excluded.shift_id').run(swap.target_employee_id, mine.shift_id, swap.date);
      if (theirs) db.prepare('INSERT INTO roster_assignments (employee_id, shift_id, date) VALUES (?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET shift_id = excluded.shift_id').run(swap.requester_employee_id, theirs.shift_id, swap.date);
    }
    res.json({ ok: true });
  };
}
router.put('/swap-requests/:id/approve', decideSwap('Approved'));
router.put('/swap-requests/:id/reject', decideSwap('Rejected'));

export default router;

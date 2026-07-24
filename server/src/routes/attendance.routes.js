import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const today = () => db.prepare("SELECT date('now') AS d").get().d;
const LATE_AFTER = '09:30';

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
    SELECT e.department, a.status, a.check_in_time, a.check_out_time, a.method
    FROM employees e
    LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = @date
    WHERE (@dept IS NULL OR e.department = @dept)
  `).all({ date, dept });

  const present = rows.filter((r) => r.status === 'Present').length;
  const absent = rows.filter((r) => r.status === 'Absent').length;
  const late = rows.filter((r) => r.check_in_time && r.check_in_time > LATE_AFTER).length;
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

  const regularizations = db.prepare("SELECT * FROM approvals WHERE type = 'Regularization' ORDER BY (status='Pending') DESC, created_at DESC LIMIT 10").all();

  res.json({
    date,
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Present Today', value: present, color: 'blue' },
      { label: 'Absent Today', value: absent, color: 'red' },
      { label: 'Late Check-in', value: late, color: 'gold' },
      { label: 'Missing Punch-in', value: missingPunch, color: 'gold' }
    ],
    biometric: { checkedIn, checkedOut, methods: Object.values(methods) },
    regularizations
  });
});

// HR: everyone's attendance for a date. Employee: own recent history.
router.get('/', (req, res) => {
  if (isHR(req.user.role)) {
    const date = req.query.date || today();
    const rows = db.prepare(`
      SELECT e.id AS employee_id, e.employee_code, e.name, e.department,
             a.status, a.check_in_time, a.check_out_time
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
  res.json({ rows, today: todays, me: { id: me.id, name: me.name, employee_code: me.employee_code } });
});

function upsertToday(employeeId, patch) {
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, today());
  if (existing) {
    const merged = { ...existing, ...patch };
    db.prepare('UPDATE attendance SET status = @status, check_in_time = @check_in_time, check_out_time = @check_out_time, method = @method WHERE id = @id').run(merged);
    return db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
  }
  const row = { employee_id: employeeId, date: today(), status: 'Present', check_in_time: null, check_out_time: null, method: 'Web Check-in', ...patch };
  const info = db.prepare('INSERT INTO attendance (employee_id, date, status, check_in_time, check_out_time, method) VALUES (@employee_id, @date, @status, @check_in_time, @check_out_time, @method)').run(row);
  return db.prepare('SELECT * FROM attendance WHERE id = ?').get(info.lastInsertRowid);
}

const METHODS = ['Web Check-in', 'Mobile App', 'Biometric (Fingerprint)', 'Face Recognition'];

router.post('/check-in', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const existing = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(me.id, today());
  if (existing?.check_in_time) return res.status(400).json({ error: 'Already checked in today at ' + existing.check_in_time });
  const method = METHODS.includes(req.body?.method) ? req.body.method : 'Web Check-in';
  res.json({ attendance: upsertToday(me.id, { status: 'Present', check_in_time: nowTime(), method }) });
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
    SELECT e.employee_code, e.name, e.department, COALESCE(a.status,'Not marked') status, COALESCE(a.check_in_time,'') check_in, COALESCE(a.check_out_time,'') check_out, COALESCE(a.method,'') method
    FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = ? ORDER BY e.id
  `).all(date);
  const csv = ['code,name,department,status,check_in,check_out,method',
    ...rows.map((r) => `${r.employee_code},${r.name},${r.department},${r.status},${r.check_in},${r.check_out},${r.method}`)].join('\n');
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
  db.prepare('INSERT INTO approvals (type, requester, detail) VALUES (?, ?, ?)')
    .run('Regularization', me.name, `${date}: ${reason}`);
  res.status(201).json({ ok: true });
});

export default router;

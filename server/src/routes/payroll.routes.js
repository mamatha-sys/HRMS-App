import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function ensureStructure(employeeId) {
  let s = db.prepare('SELECT * FROM salary_structures WHERE employee_id = ?').get(employeeId);
  if (!s) {
    db.prepare('INSERT INTO salary_structures (employee_id) VALUES (?)').run(employeeId);
    s = db.prepare('SELECT * FROM salary_structures WHERE employee_id = ?').get(employeeId);
  }
  return s;
}
const netOf = (s) => s.basic + s.hra + s.allowances - s.deductions;

// HR: salary structures for everyone. Employee: own structure.
router.get('/structures', (req, res) => {
  if (!isHR(req.user.role)) {
    const me = myEmployee(req.user.sub);
    if (!me) return res.json({ structures: [] });
    const s = ensureStructure(me.id);
    return res.json({ structures: [{ ...s, name: me.name, employee_code: me.employee_code, net: netOf(s) }] });
  }
  const rows = db.prepare(`
    SELECT e.id AS employee_id, e.name, e.employee_code,
           COALESCE(s.basic,0) basic, COALESCE(s.hra,0) hra, COALESCE(s.allowances,0) allowances, COALESCE(s.deductions,0) deductions
    FROM employees e LEFT JOIN salary_structures s ON s.employee_id = e.id
    ORDER BY e.id
  `).all();
  res.json({ structures: rows.map((r) => ({ ...r, net: netOf(r) })) });
});

// HR updates an employee's salary structure.
router.put('/structures/:employeeId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  ensureStructure(emp.id);
  const cur = db.prepare('SELECT * FROM salary_structures WHERE employee_id = ?').get(emp.id);
  const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Math.round(Number(v)));
  const next = {
    employee_id: emp.id,
    basic: num(req.body?.basic, cur.basic),
    hra: num(req.body?.hra, cur.hra),
    allowances: num(req.body?.allowances, cur.allowances),
    deductions: num(req.body?.deductions, cur.deductions)
  };
  db.prepare('UPDATE salary_structures SET basic=@basic, hra=@hra, allowances=@allowances, deductions=@deductions WHERE employee_id=@employee_id').run(next);
  res.json({ structure: { ...next, net: netOf(next) } });
});

// HR runs payroll for a period → generates a payslip per active employee, marks the run Completed.
router.post('/run', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { period } = req.body || {};
  if (!period) return res.status(400).json({ error: 'period is required (e.g. "July 2026")' });

  const employees = db.prepare("SELECT id FROM employees WHERE status = 'Active'").all();
  let generated = 0, skipped = 0;
  const run = db.transaction(() => {
    employees.forEach((e) => {
      if (db.prepare('SELECT id FROM payslips WHERE employee_id = ? AND period = ?').get(e.id, period)) { skipped++; return; }
      const s = ensureStructure(e.id);
      db.prepare('INSERT INTO payslips (employee_id, period, basic, hra, allowances, deductions, net) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, period, s.basic, s.hra, s.allowances, s.deductions, netOf(s));
      generated++;
    });
    db.prepare("INSERT INTO payroll_runs (period, status) VALUES (?, 'Completed')").run(period);
  });
  run();
  res.json({ generated, skipped, period });
});

// HR: all payslips. Employee: own payslips.
router.get('/payslips', (req, res) => {
  if (!isHR(req.user.role)) {
    const me = myEmployee(req.user.sub);
    if (!me) return res.json({ payslips: [] });
    return res.json({ payslips: db.prepare('SELECT * FROM payslips WHERE employee_id = ? ORDER BY created_at DESC').all(me.id) });
  }
  const rows = db.prepare(`
    SELECT p.*, e.name AS employee_name, e.employee_code
    FROM payslips p JOIN employees e ON e.id = p.employee_id
    ORDER BY p.created_at DESC, e.id
  `).all();
  res.json({ payslips: rows });
});

export default router;

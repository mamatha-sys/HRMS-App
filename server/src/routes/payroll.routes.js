import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const SCOPE_BANNER = {
  super_admin: 'Full, unrestricted access — configures pay structures, processes/approves any run, organization-wide.',
  hr_admin: 'Company-wide payroll — maintain structures and run payroll across all departments.',
  manager: 'Team/organization payroll — view structures and payslips.',
  assistant_manager: 'Team/organization payroll — view structures and payslips.'
};

const COMPONENTS = ['basic', 'hra', 'conveyance', 'special_allowance', 'pf', 'pt', 'tds'];
const gross = (s) => (s.basic || 0) + (s.hra || 0) + (s.conveyance || 0) + (s.special_allowance || 0);
const totalDeductions = (s) => (s.pf || 0) + (s.pt || 0) + (s.tds || 0);
const netOf = (s) => gross(s) - totalDeductions(s);
const withTotals = (s) => ({ ...s, gross: gross(s), total_deductions: totalDeductions(s), net: netOf(s) });

function ensureStructure(employeeId) {
  let s = db.prepare('SELECT * FROM salary_structures WHERE employee_id = ?').get(employeeId);
  if (!s) {
    db.prepare('INSERT INTO salary_structures (employee_id, basic, hra, allowances, deductions) VALUES (?, 40000, 16000, 8000, 4000)').run(employeeId);
    s = db.prepare('SELECT * FROM salary_structures WHERE employee_id = ?').get(employeeId);
  }
  return s;
}

// HR overview: KPIs + a representative salary structure breakdown.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const lastRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const cycle = lastRun ? lastRun.period : db.prepare("SELECT strftime('%m %Y','now') AS p").get().p;
  const processed = lastRun ? db.prepare('SELECT COUNT(*) c FROM payslips WHERE period = ?').get(lastRun.period).c : 0;
  const ffRequests = db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Exited'").get().c;

  // A representative structure — average across active employees, so the widget reflects real data.
  const rows = db.prepare(`
    SELECT s.* FROM salary_structures s JOIN employees e ON e.id = s.employee_id WHERE e.status = 'Active'
  `).all();
  const avg = (k) => rows.length ? Math.round(rows.reduce((t, r) => t + (r[k] || 0), 0) / rows.length) : 0;
  const template = { basic: avg('basic'), hra: avg('hra'), conveyance: avg('conveyance'), special_allowance: avg('special_allowance'), pf: avg('pf'), pt: avg('pt'), tds: avg('tds') };

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Payroll Cycle', value: cycle, color: 'blue' },
      { label: 'Employees Processed', value: processed, color: 'green' },
      { label: 'F&F Requests', value: ffRequests, color: 'gold' }
    ],
    structureTemplate: withTotals(template)
  });
});

// HR: salary structures for everyone. Employee: own structure.
router.get('/structures', (req, res) => {
  if (!isHR(req.user.role)) {
    const me = myEmployee(req.user.sub);
    if (!me) return res.json({ structures: [] });
    const s = ensureStructure(me.id);
    return res.json({ structures: [{ ...withTotals(s), name: me.name, employee_code: me.employee_code }] });
  }
  const rows = db.prepare(`
    SELECT e.id AS employee_id, e.name, e.employee_code, e.department, s.*
    FROM employees e LEFT JOIN salary_structures s ON s.employee_id = e.id
    ORDER BY e.id
  `).all();
  res.json({ structures: rows.map((r) => withTotals({ ...r, employee_id: r.employee_id })) });
});

router.put('/structures/:employeeId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const cur = ensureStructure(emp.id);
  const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Math.max(0, Math.round(Number(v))));
  const next = { employee_id: emp.id };
  COMPONENTS.forEach((c) => { next[c] = num(req.body?.[c], cur[c]); });
  db.prepare(`UPDATE salary_structures SET ${COMPONENTS.map((c) => `${c}=@${c}`).join(', ')} WHERE employee_id=@employee_id`).run(next);
  res.json({ structure: withTotals(next) });
});

// HR runs payroll for a period → one payslip per active employee (idempotent per period).
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
      const allowances = (s.conveyance || 0) + (s.special_allowance || 0);
      db.prepare('INSERT INTO payslips (employee_id, period, basic, hra, allowances, deductions, net) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, period, s.basic, s.hra, allowances, totalDeductions(s), netOf(s));
      generated++;
    });
    db.prepare("INSERT INTO payroll_runs (period, status) VALUES (?, 'Completed')").run(period);
  });
  run();
  res.json({ generated, skipped, period });
});

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

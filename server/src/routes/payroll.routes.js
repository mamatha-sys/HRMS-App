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

function activeComponents() { return db.prepare('SELECT * FROM salary_components WHERE active = 1 ORDER BY sort_order, id').all(); }
function allComponents() { return db.prepare('SELECT * FROM salary_components ORDER BY sort_order, id').all(); }

function ensureLines(employeeId) {
  const components = allComponents();
  const have = new Set(db.prepare('SELECT component_id FROM employee_salary_lines WHERE employee_id = ?').all(employeeId).map((r) => r.component_id));
  const ins = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, 0)');
  components.forEach((c) => { if (!have.has(c.id)) ins.run(employeeId, c.id); });
}

// Full breakdown for one employee: only active components, split by type, with totals.
function breakdownFor(employeeId) {
  ensureLines(employeeId);
  const lines = db.prepare(`
    SELECT c.id AS component_id, c.key, c.label, c.type, l.amount
    FROM employee_salary_lines l JOIN salary_components c ON c.id = l.component_id
    WHERE l.employee_id = ? AND c.active = 1 ORDER BY c.sort_order, c.id
  `).all(employeeId);
  const earnings = lines.filter((l) => l.type === 'earning');
  const deductions = lines.filter((l) => l.type === 'deduction');
  const gross = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductions.reduce((t, l) => t + l.amount, 0);
  return { earnings, deductions, gross, totalDeductions, net: gross - totalDeductions };
}

// HR overview: KPIs + a representative salary breakdown (average across active employees).
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const lastRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const cycle = lastRun ? lastRun.period : db.prepare("SELECT strftime('%m %Y','now') AS p").get().p;
  const processed = lastRun ? db.prepare('SELECT COUNT(*) c FROM payslips WHERE period = ?').get(lastRun.period).c : 0;
  const ffRequests = db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Exited'").get().c;

  const activeEmployees = db.prepare("SELECT id FROM employees WHERE status = 'Active'").all();
  const comps = activeComponents();
  const avgLines = comps.map((c) => {
    const rows = activeEmployees.map((e) => db.prepare('SELECT amount FROM employee_salary_lines WHERE employee_id = ? AND component_id = ?').get(e.id, c.id)?.amount || 0);
    const avg = rows.length ? Math.round(rows.reduce((t, v) => t + v, 0) / rows.length) : 0;
    return { component_id: c.id, key: c.key, label: c.label, type: c.type, amount: avg };
  });
  const earnings = avgLines.filter((l) => l.type === 'earning');
  const deductions = avgLines.filter((l) => l.type === 'deduction');
  const gross = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductions.reduce((t, l) => t + l.amount, 0);

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Payroll Cycle', value: cycle, color: 'blue' },
      { label: 'Employees Processed', value: processed, color: 'green' },
      { label: 'F&F Requests', value: ffRequests, color: 'gold' }
    ],
    structureTemplate: { earnings, deductions, gross, totalDeductions, net: gross - totalDeductions }
  });
});

// --- Salary components catalog ---
router.get('/components', (req, res) => res.json({ components: allComponents() }));

router.post('/components', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { key, label, type } = req.body || {};
  if (!label || !['earning', 'deduction'].includes(type)) return res.status(400).json({ error: 'label and a valid type (earning/deduction) are required' });
  const finalKey = (key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!finalKey) return res.status(400).json({ error: 'Could not derive a key from the label' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM salary_components').get().m;
  try {
    const info = db.prepare('INSERT INTO salary_components (key, label, type, sort_order) VALUES (?, ?, ?, ?)').run(finalKey, label.trim(), type, maxOrder + 1);
    const componentId = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, 0)');
    db.prepare('SELECT id FROM employees').all().forEach((e) => ins.run(e.id, componentId));
    res.status(201).json({ component: db.prepare('SELECT * FROM salary_components WHERE id = ?').get(componentId) });
  } catch { res.status(409).json({ error: 'A component with this key already exists' }); }
});

router.put('/components/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const c = db.prepare('SELECT * FROM salary_components WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Component not found' });
  const { label, active } = req.body || {};
  db.prepare('UPDATE salary_components SET label = COALESCE(?, label), active = COALESCE(?, active) WHERE id = ?')
    .run(label?.trim() || null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ component: db.prepare('SELECT * FROM salary_components WHERE id = ?').get(req.params.id) });
});

// --- Per-employee structures ---
router.get('/structures', (req, res) => {
  if (!isHR(req.user.role)) {
    const me = myEmployee(req.user.sub);
    if (!me) return res.json({ structures: [], components: activeComponents() });
    return res.json({ structures: [{ employee_id: me.id, name: me.name, employee_code: me.employee_code, ...breakdownFor(me.id) }], components: activeComponents() });
  }
  const employees = db.prepare('SELECT id, name, employee_code, department FROM employees ORDER BY id').all();
  const structures = employees.map((e) => ({ employee_id: e.id, name: e.name, employee_code: e.employee_code, department: e.department, ...breakdownFor(e.id) }));
  res.json({ structures, components: activeComponents() });
});

router.put('/structures/:employeeId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const upsert = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, ?) ON CONFLICT(employee_id, component_id) DO UPDATE SET amount = excluded.amount');
  const tx = db.transaction((ls) => ls.forEach((l) => {
    const amount = Math.max(0, Math.round(Number(l.amount) || 0));
    upsert.run(emp.id, l.component_id, amount);
  }));
  tx(lines);
  res.json({ structure: { employee_id: emp.id, ...breakdownFor(emp.id) } });
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
      const b = breakdownFor(e.id);
      const basicLine = b.earnings.find((l) => l.key === 'basic');
      const hraLine = b.earnings.find((l) => l.key === 'hra');
      const basic = basicLine?.amount || 0;
      const hra = hraLine?.amount || 0;
      const allowances = b.earnings.filter((l) => l.key !== 'basic' && l.key !== 'hra').reduce((t, l) => t + l.amount, 0);
      db.prepare('INSERT INTO payslips (employee_id, period, basic, hra, allowances, deductions, net) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, period, basic, hra, allowances, b.totalDeductions, b.net);
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

// --- Reports: per-period totals + department breakdown ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const byPeriod = db.prepare(`
    SELECT period, COUNT(*) AS employees, SUM(net) AS total_net, SUM(basic + hra + allowances) AS total_gross, SUM(deductions) AS total_deductions
    FROM payslips GROUP BY period ORDER BY MAX(created_at) DESC
  `).all();
  const byDept = db.prepare(`
    SELECT e.department, COUNT(*) AS employees, SUM(p.net) AS total_net
    FROM payslips p JOIN employees e ON e.id = p.employee_id
    GROUP BY e.department ORDER BY total_net DESC
  `).all();
  res.json({ byPeriod, byDept });
});

router.get('/reports/export', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT p.period, e.employee_code, e.name, e.department, p.basic, p.hra, p.allowances, p.deductions, p.net
    FROM payslips p JOIN employees e ON e.id = p.employee_id ORDER BY p.period, e.id
  `).all();
  const csv = ['period,code,name,department,basic,hra,allowances,deductions,net', ...rows.map((r) => `${r.period},${r.employee_code},${r.name},${r.department},${r.basic},${r.hra},${r.allowances},${r.deductions},${r.net}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payroll-report.csv"');
  res.send(csv);
});

export default router;

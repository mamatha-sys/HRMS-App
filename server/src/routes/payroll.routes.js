import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { getSettings } from '../utils/integrationSettings.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '09' (Payroll Management).
const isHR = (role) => canModuleAdmin(role, '09');
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

// Interns on the Stipend pay type get a fixed monthly amount — no components, no deductions,
// no add-ons at all, per company policy.
const STIPEND_AMOUNT = 10000;

// --- CTC-driven salary structure ---
// HR enters one monthly CTC figure per employee and the server splits it into
// Basic/HRA/Bonus/Special Allowance/Employee PF/PT/Employer PF/Gratuity per these
// Super-Admin-configurable percentages — replaces typing each component amount by hand.
// Reuses the `policies` table (category 'setting'), same pattern as Attendance's
// check-in-method toggles and free-late-allowance policy.
const SPLIT_POLICY_DEFAULTS = {
  'Basic % of CTC': 40,
  'HRA % of Basic': 40,
  'Bonus % of Basic': 10,
  'Employee PF % of Basic': 12,
  'Employer PF % of Basic': 12,
  'Gratuity % of Basic': 4.81,
  'Professional Tax (flat monthly)': 200
};

function getSplitPolicy(name) {
  const row = db.prepare('SELECT value FROM policies WHERE name = ?').get(name);
  const n = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(n) ? n : SPLIT_POLICY_DEFAULTS[name];
}

function splitConfig() {
  const cfg = {};
  Object.keys(SPLIT_POLICY_DEFAULTS).forEach((name) => { cfg[name] = getSplitPolicy(name); });
  return cfg;
}

function setSplitPolicy(name, value) {
  const existing = db.prepare('SELECT id FROM policies WHERE name = ?').get(name);
  if (existing) db.prepare('UPDATE policies SET value = ? WHERE id = ?').run(String(value), existing.id);
  else db.prepare("INSERT INTO policies (category, name, value) VALUES ('setting', ?, ?)").run(name, String(value));
}

// Splits a monthly CTC into components keyed exactly like salary_components.key, so the result
// can be written straight into employee_salary_lines. Special Allowance absorbs whatever's left
// after every fixed/percentage-based piece is accounted for, so Gross + Employer Costs always
// reconciles back to the entered CTC exactly (rounding aside).
function splitCtc(ctc) {
  const cfg = splitConfig();
  const basic = Math.round(ctc * cfg['Basic % of CTC'] / 100);
  const hra = Math.round(basic * cfg['HRA % of Basic'] / 100);
  const employeePf = Math.round(basic * cfg['Employee PF % of Basic'] / 100);
  const employerPf = Math.round(basic * cfg['Employer PF % of Basic'] / 100);
  const gratuity = Math.round(basic * cfg['Gratuity % of Basic'] / 100);
  const pt = Math.round(cfg['Professional Tax (flat monthly)']);
  const bonus = Math.round(basic * cfg['Bonus % of Basic'] / 100);
  const fixedTotal = basic + hra + bonus + employerPf + gratuity;
  const specialAllowance = ctc - fixedTotal;
  if (specialAllowance < 0) {
    throw Object.assign(new Error(`CTC too low for the current split settings — minimum CTC is ₹${fixedTotal.toLocaleString('en-IN')}.`), { status: 400 });
  }
  return { basic, hra, bonus, special_allowance: specialAllowance, pf: employeePf, pt, employer_pf: employerPf, gratuity };
}

// Writes a CTC's split straight into one employee's salary lines and stamps their stored CTC.
// Shared by the per-employee CTC endpoint and the split-config save handler below (which
// re-applies this to every already-configured employee, so a percentage change doesn't leave
// existing structures silently stale at the old ratios).
function applyCtcSplit(employeeId, ctc) {
  const split = splitCtc(ctc);
  ensureLines(employeeId);
  const byKey = {};
  allComponents().forEach((c) => { byKey[c.key] = c.id; });
  const upsert = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, ?) ON CONFLICT(employee_id, component_id) DO UPDATE SET amount = excluded.amount');
  Object.entries(split).forEach(([key, amount]) => {
    const componentId = byKey[key];
    if (componentId) upsert.run(employeeId, componentId, amount);
  });
  db.prepare('UPDATE employees SET ctc = ? WHERE id = ?').run(ctc, employeeId);
}

// Full breakdown for one employee: only active components, split by type, with totals.
// A 'withheld' earning (e.g. Bonus) counts toward Gross AND is shown again as its own line in
// Deductions with the same amount — part of the package, but not paid out this cycle — so it
// nets to zero effect on take-home while staying visible on the payslip.
function breakdownFor(employeeId) {
  const emp = db.prepare('SELECT pay_type, ctc FROM employees WHERE id = ?').get(employeeId);
  if (emp?.pay_type === 'Stipend') {
    return {
      payType: 'Stipend',
      earnings: [{ component_id: null, key: 'stipend', label: 'Stipend', type: 'earning', amount: STIPEND_AMOUNT }],
      deductions: [],
      employerCosts: [],
      gross: STIPEND_AMOUNT,
      totalDeductions: 0,
      net: STIPEND_AMOUNT,
      ctc: STIPEND_AMOUNT,
      enteredCtc: null
    };
  }

  ensureLines(employeeId);
  const lines = db.prepare(`
    SELECT c.id AS component_id, c.key, c.label, c.type, c.withheld, l.amount
    FROM employee_salary_lines l JOIN salary_components c ON c.id = l.component_id
    WHERE l.employee_id = ? AND c.active = 1 ORDER BY c.sort_order, c.id
  `).all(employeeId);
  const earnings = lines.filter((l) => l.type === 'earning');
  const withheldAsDeductions = earnings.filter((l) => l.withheld).map((l) => ({ ...l, type: 'deduction' }));
  const deductions = [...lines.filter((l) => l.type === 'deduction'), ...withheldAsDeductions];
  // Employer-side costs (Employer PF, Gratuity) sit outside Gross/Deductions/Net entirely —
  // they're what the company pays on top, not part of the employee's own pay — and only add
  // into CTC.
  const employerCosts = lines.filter((l) => l.type === 'employer_cost');
  const gross = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductions.reduce((t, l) => t + l.amount, 0);
  const ctc = gross + employerCosts.reduce((t, l) => t + l.amount, 0);
  return { payType: 'Package', earnings, deductions, employerCosts, gross, totalDeductions, net: gross - totalDeductions, ctc, enteredCtc: emp.ctc ?? null };
}

// HR overview: KPIs + an illustrative "standard structure" reference card, built by running a
// sample ₹25,000 CTC through the live split settings — so it always reflects whatever Super
// Admin has configured, not a stale hardcoded example.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const lastRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const cycle = lastRun ? lastRun.period : db.prepare("SELECT strftime('%m %Y','now') AS p").get().p;
  const processed = lastRun ? db.prepare('SELECT COUNT(*) c FROM payslips WHERE period = ?').get(lastRun.period).c : 0;
  const ffRequests = db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Exited'").get().c;

  const comps = activeComponents();
  let sample = {};
  try { sample = splitCtc(25000); } catch { /* current split settings can't fit a ₹25,000 sample — template just shows 0s */ }
  const templateLines = comps.map((c) => ({
    component_id: c.id, key: c.key, label: c.label, type: c.type, withheld: c.withheld,
    amount: sample[c.key] || 0
  }));
  const earnings = templateLines.filter((l) => l.type === 'earning');
  const withheldAsDeductions = earnings.filter((l) => l.withheld).map((l) => ({ ...l, type: 'deduction' }));
  const deductions = [...templateLines.filter((l) => l.type === 'deduction'), ...withheldAsDeductions];
  const employerCosts = templateLines.filter((l) => l.type === 'employer_cost');
  const gross = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductions.reduce((t, l) => t + l.amount, 0);
  const ctc = gross + employerCosts.reduce((t, l) => t + l.amount, 0);

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Payroll Cycle', value: cycle, color: 'blue' },
      { label: 'Employees Processed', value: processed, color: 'green' },
      { label: 'F&F Requests', value: ffRequests, color: 'gold' }
    ],
    structureTemplate: { earnings, deductions, employerCosts, gross, totalDeductions, net: gross - totalDeductions, ctc }
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

// --- CTC split settings: read by any HR-tier role, edited by Super Admin only ---
router.get('/split-config', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ config: splitConfig() });
});

router.put('/split-config', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change the CTC split settings' });
  const body = req.body || {};
  Object.keys(SPLIT_POLICY_DEFAULTS).forEach((name) => {
    if (body[name] !== undefined) {
      const n = parseFloat(body[name]);
      if (Number.isFinite(n) && n >= 0) setSplitPolicy(name, n);
    }
  });
  // A percentage change must apply to everyone who already has a CTC on file too — otherwise
  // their salary lines stay frozen at whatever the OLD percentages computed, silently
  // contradicting the settings now shown here. One employee's CTC becoming too low for the new
  // fixed/percentage total shouldn't block re-splitting everyone else, so failures are skipped
  // individually rather than rolling back the whole batch.
  const toResplit = db.prepare("SELECT id, ctc FROM employees WHERE pay_type = 'Package' AND ctc IS NOT NULL").all();
  let resplit = 0, skipped = 0;
  const tx = db.transaction(() => {
    toResplit.forEach((e) => {
      try { applyCtcSplit(e.id, e.ctc); resplit++; }
      catch { skipped++; }
    });
  });
  tx();
  res.json({ config: splitConfig(), resplit, skipped });
});

// --- Per-employee structures ---
router.get('/structures', (req, res) => {
  if (!isHR(req.user.role)) {
    const me = myEmployee(req.user.sub);
    if (!me) return res.json({ structures: [], components: activeComponents() });
    return res.json({ structures: [{ employee_id: me.id, name: me.name, employee_code: me.employee_code, pay_type: me.pay_type, ...breakdownFor(me.id) }], components: activeComponents() });
  }
  const employees = db.prepare('SELECT id, name, employee_code, department, pay_type FROM employees ORDER BY id').all();
  const structures = employees.map((e) => ({ employee_id: e.id, name: e.name, employee_code: e.employee_code, department: e.department, pay_type: e.pay_type, ...breakdownFor(e.id) }));
  res.json({ structures, components: activeComponents() });
});

// Stipend ↔ Package — switching to Stipend doesn't erase the employee's configured component
// amounts, it just stops using them (breakdownFor ignores lines for Stipend employees), so
// switching back to Package restores exactly what was there before.
router.put('/structures/:employeeId/pay-type', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!['Package', 'Stipend'].includes(req.body?.pay_type)) return res.status(400).json({ error: 'pay_type must be Package or Stipend' });
  db.prepare('UPDATE employees SET pay_type = ? WHERE id = ?').run(req.body.pay_type, emp.id);
  res.json({ structure: { employee_id: emp.id, ...breakdownFor(emp.id) } });
});

// Structure is now set by CTC alone — HR enters one figure and every component (Basic, HRA,
// Bonus, Special Allowance, Employee PF, PT, Employer PF, Gratuity) is derived from it via
// splitCtc(), per the configured percentages. Replaces the old per-component manual entry.
router.put('/structures/:employeeId/ctc', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (emp.pay_type === 'Stipend') return res.status(400).json({ error: 'Stipend employees have a fixed ₹10,000 monthly stipend — there is nothing to configure.' });
  const ctc = Math.round(Number(req.body?.ctc));
  if (!Number.isFinite(ctc) || ctc <= 0) return res.status(400).json({ error: 'A valid CTC amount is required' });

  try { applyCtcSplit(emp.id, ctc); } catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  res.json({ structure: { employee_id: emp.id, ...breakdownFor(emp.id) } });
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Half-day pay cut for late arrivals beyond the free monthly allowance (company rule — see
// attendance.routes.js's half_day_flag, computed at check-in time from the "Free late arrivals
// per month" policy). One half-day = gross / 30 / 2.
function lateDeductionFor(employeeId, month, gross) {
  const flaggedDays = db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE employee_id = ? AND date LIKE ? AND half_day_flag = 1").get(employeeId, month + '%').c;
  if (flaggedDays === 0) return { flaggedDays: 0, deduction: 0 };
  const halfDayRate = Math.round(gross / 30 / 2);
  return { flaggedDays, deduction: flaggedDays * halfDayRate };
}

function daysInMonthFor(month) {
  return db.prepare("SELECT CAST(strftime('%d', date(? || '-01', '+1 month', '-1 day')) AS INTEGER) AS d").get(month).d;
}

// Loss of Pay: each explicit 'Absent' mark that month is unpaid — Present, Leave, and days with
// no attendance row at all (e.g. a weekend/holiday nobody marks) are all treated as paid.
function lopFor(employeeId, month, gross) {
  const lopDays = db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE employee_id = ? AND date LIKE ? AND status = 'Absent'").get(employeeId, month + '%').c;
  if (lopDays === 0) return { lopDays: 0, deduction: 0 };
  const perDayRate = Math.round(gross / daysInMonthFor(month));
  return { lopDays, deduction: lopDays * perDayRate };
}

// Per-leave-type breakdown for the "Leave Details" section of a payslip. Payslips don't keep a
// historical snapshot of leave balances, so opening balance is reconstructed as
// (today's running balance + what was taken in that payslip's month) — an approximation, but a
// reasonable one since balances only ever move via that same month's approved leave.
function leaveDetailsFor(employeeId, month) {
  const types = db.prepare('SELECT * FROM leave_types WHERE active = 1 ORDER BY id').all();
  return types.map((t) => {
    const currentBalance = db.prepare('SELECT balance FROM employee_leave_balances WHERE employee_id = ? AND leave_type_id = ?').get(employeeId, t.id)?.balance ?? t.annual_quota;
    const takenThisMonth = db.prepare(`
      SELECT COALESCE(SUM(days), 0) AS d FROM leaves
      WHERE employee_id = ? AND leave_type_id = ? AND status = 'Approved' AND cancelled = 0 AND strftime('%Y-%m', from_date) = ?
    `).get(employeeId, t.id, month).d;
    return {
      leave_type: t.name,
      opening_balance: t.unpaid ? null : currentBalance + takenThisMonth,
      entitlement: t.unpaid ? 'Unpaid' : t.annual_quota,
      leaves_taken: takenThisMonth,
      current_balance: t.unpaid ? null : currentBalance
    };
  });
}

// HR runs payroll for a calendar month → one payslip per active employee (idempotent per
// period). Automatically deducts half a day's pay per late arrival beyond the free monthly
// allowance (company rule), shown as its own line item on the payslip.
router.post('/run', (req, res) => {
  // Feature-level gate: this is exactly the 'Payroll Run' feature.
  if (!canFeatureAction(req.user.role, '09', 'Payroll Run', 'Manage')) return res.status(403).json({ error: 'Insufficient permissions' });
  const { month } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month is required in YYYY-MM format' });
  const [y, m] = month.split('-');
  const period = `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;

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
      const { deduction: lateDeduction } = lateDeductionFor(e.id, month, b.gross);
      const { lopDays, deduction: lopDeduction } = lopFor(e.id, month, b.gross);
      const daysWorked = daysInMonthFor(month) - lopDays;
      const net = b.net - lateDeduction - lopDeduction;
      db.prepare(`
        INSERT INTO payslips (employee_id, period, month, basic, hra, allowances, deductions, late_deduction, lop_days, lop_deduction, days_worked, net, lines_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.id, period, month, basic, hra, allowances, b.totalDeductions, lateDeduction, lopDays, lopDeduction, daysWorked, net, JSON.stringify({ earnings: b.earnings, deductions: b.deductions }));
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

// Full detail for one payslip — everything a printable payslip needs: the itemized
// earnings/deductions snapshot from when payroll actually ran, the employee's identity/bank/
// statutory fields as they stand today, a Leave Details breakdown for that month, and the
// company's own branding (logo/name/address) to print in the header.
router.get('/payslips/:id', (req, res) => {
  const slip = db.prepare('SELECT * FROM payslips WHERE id = ?').get(req.params.id);
  if (!slip) return res.status(404).json({ error: 'Payslip not found' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(slip.employee_id);
  const own = emp?.user_id === req.user.sub;
  if (!isHR(req.user.role) && !own) return res.status(403).json({ error: 'Insufficient permissions' });

  let lines = { earnings: [], deductions: [] };
  if (slip.lines_json) { try { lines = JSON.parse(slip.lines_json); } catch { /* pre-existing payslip, generated before this snapshot existed */ } }

  res.json({
    payslip: { ...slip, earnings: lines.earnings, deductions: lines.deductions },
    employee: emp && {
      employee_code: emp.employee_code, name: emp.name, department: emp.department, branch: emp.branch,
      designation: emp.designation, date_of_joining: emp.date_of_joining,
      bank_name: emp.bank_name, bank_account_number: emp.bank_account_number, ifsc_code: emp.ifsc_code,
      pan_number: emp.pan_number, uan_number: emp.uan_number, pf_number: emp.pf_number, esi_number: emp.esi_number
    },
    leaveDetails: slip.month ? leaveDetailsFor(slip.employee_id, slip.month) : [],
    company: getSettings(['company_name', 'company_logo', 'company_address'])
  });
});

// --- Reports: per-period totals + department breakdown ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const byPeriod = db.prepare(`
    SELECT period, COUNT(*) AS employees, SUM(net) AS total_net, SUM(basic + hra + allowances) AS total_gross, SUM(deductions) AS total_deductions, SUM(late_deduction) AS total_late_deduction, SUM(lop_deduction) AS total_lop_deduction
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
    SELECT p.period, e.employee_code, e.name, e.department, p.basic, p.hra, p.allowances, p.deductions, p.late_deduction, p.lop_days, p.lop_deduction, p.net
    FROM payslips p JOIN employees e ON e.id = p.employee_id ORDER BY p.period, e.id
  `).all();
  const csv = ['period,code,name,department,basic,hra,allowances,deductions,late_deduction,lop_days,lop_deduction,net', ...rows.map((r) => `${r.period},${r.employee_code},${r.name},${r.department},${r.basic},${r.hra},${r.allowances},${r.deductions},${r.late_deduction},${r.lop_days},${r.lop_deduction},${r.net}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payroll-report.csv"');
  res.send(csv);
});

export default router;

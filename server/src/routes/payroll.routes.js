import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { getSettings } from '../utils/integrationSettings.js';
import { explainPayrollComparison } from '../utils/aiAssist.js';

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
  // Statutory EPF wage ceiling (₹15,000 basic × 12%) — once the percentage-based PF hits this,
  // it stops growing with basic instead of scaling further, matching real EPFO practice.
  'Employee PF Monthly Cap': 1800,
  'Employer PF Monthly Cap': 1800,
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

// Splits an ANNUAL CTC into monthly components keyed exactly like salary_components.key, so the
// result can be written straight into employee_salary_lines. Annual matches the convention used
// everywhere else CTC is entered (Recruitment offer, Bulk Import's "CTC (annual, ₹)" column) —
// this function is the only place that converts it down to a monthly figure before splitting, so
// callers everywhere pass/store the same annual number instead of two different units silently
// meaning two different things (that used to make monthly Basic/Net come out ~12x too high).
// Special Allowance absorbs whatever's left after every fixed/percentage-based piece is
// accounted for, so Gross + Employer Costs always reconciles back to the monthly CTC exactly
// (rounding aside).
function splitCtc(annualCtc) {
  const cfg = splitConfig();
  const ctc = Math.round(annualCtc / 12);
  const basic = Math.round(ctc * cfg['Basic % of CTC'] / 100);
  const hra = Math.round(basic * cfg['HRA % of Basic'] / 100);
  const employeePf = Math.min(Math.round(basic * cfg['Employee PF % of Basic'] / 100), cfg['Employee PF Monthly Cap']);
  const employerPf = Math.min(Math.round(basic * cfg['Employer PF % of Basic'] / 100), cfg['Employer PF Monthly Cap']);
  const gratuity = Math.round(basic * cfg['Gratuity % of Basic'] / 100);
  const pt = Math.round(cfg['Professional Tax (flat monthly)']);
  const bonus = Math.round(basic * cfg['Bonus % of Basic'] / 100);
  const fixedTotal = basic + hra + bonus + employerPf + gratuity;
  const specialAllowance = ctc - fixedTotal;
  if (specialAllowance < 0) {
    throw Object.assign(new Error(`CTC too low for the current split settings — minimum annual CTC is ₹${(fixedTotal * 12).toLocaleString('en-IN')}.`), { status: 400 });
  }
  return { basic, hra, bonus, special_allowance: specialAllowance, pf: employeePf, pt, employer_pf: employerPf, gratuity };
}

// Writes a CTC's split straight into one employee's salary lines and stamps their stored CTC.
// Shared by the per-employee CTC endpoint and the split-config save handler below (which
// re-applies this to every already-configured employee, so a percentage change doesn't leave
// existing structures silently stale at the old ratios).
export function applyCtcSplit(employeeId, ctc) {
  const split = splitCtc(ctc);
  ensureLines(employeeId);
  const byKey = {};
  allComponents().forEach((c) => { byKey[c.key] = c.id; });
  const missing = Object.keys(split).filter((key) => !byKey[key]);
  if (missing.length) {
    throw Object.assign(new Error(`Salary component(s) missing from the catalog: ${missing.join(', ')} — add them under Manage Salary Components before splitting CTC.`), { status: 500 });
  }
  const upsert = db.prepare('INSERT INTO employee_salary_lines (employee_id, component_id, amount) VALUES (?, ?, ?) ON CONFLICT(employee_id, component_id) DO UPDATE SET amount = excluded.amount');
  Object.entries(split).forEach(([key, amount]) => {
    upsert.run(employeeId, byKey[key], amount);
  });
  db.prepare('UPDATE employees SET ctc = ? WHERE id = ?').run(ctc, employeeId);
}

// Full breakdown for one employee: only active components, split by type, with totals. A
// 'withheld' earning would count toward Gross AND be cloned into Deductions at the same amount
// (net zero effect on take-home) — no active component uses this currently (Bonus is a plain,
// paid-out earning), but the mechanism stays available for a future component that genuinely
// needs it.
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
// sample ₹3,00,000 annual CTC (₹25,000/month) through the live split settings — so it always
// reflects whatever Super Admin has configured, not a stale hardcoded example.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const lastRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const cycle = lastRun ? lastRun.period : db.prepare("SELECT strftime('%m %Y','now') AS p").get().p;
  const processed = lastRun ? db.prepare('SELECT COUNT(*) c FROM payslips WHERE period = ?').get(lastRun.period).c : 0;
  const ffRequests = db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'Exited'").get().c;

  const comps = activeComponents();
  let sample = {};
  try { sample = splitCtc(300000); } catch { /* current split settings can't fit a ₹25,000/month sample — template just shows 0s */ }
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

// Kept separate from /split-config deliberately: those are CTC percentages and saving them
// re-splits every employee's salary structure. These decide how attendance turns into pay, and
// only affect the NEXT payroll run — payslips already generated are a snapshot and never change.
router.get('/attendance-pay-config', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ config: attendancePayConfig() });
});

router.put('/attendance-pay-config', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change how attendance affects pay' });
  const body = req.body || {};
  Object.keys(ATTENDANCE_PAY_DEFAULTS).forEach((name) => {
    if (body[name] !== undefined) setSplitPolicy(name, body[name] ? 1 : 0);
  });
  res.json({ config: attendancePayConfig() });
});

// What the next run would pay, without writing anything. Running payroll for a month whose
// attendance was never marked now produces near-zero payslips by design, and a run is idempotent
// per period (it skips anyone already generated), so it is not casually undoable — HR needs to
// see the damage before committing, not after.
router.get('/run-preview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const month = req.query.month;
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month is required in YYYY-MM format' });
  const [y, m] = month.split('-');
  const period = `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;

  const employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  const rows = employees.map((e) => {
    const already = !!db.prepare('SELECT id FROM payslips WHERE employee_id = ? AND period = ?').get(e.id, period);
    const b = breakdownFor(e.id);
    const { deduction: lateDeduction } = lateDeductionFor(e.id, month, b.gross);
    const { lopDays, absentDays, unmarkedDays, paidDays, futureDays, deduction: lopDeduction } = lopFor(e.id, month, b.gross);
    const sandwichDays = sandwichWeekendDays(e.id, month);
    const sandwichDeduction = sandwichDays * Math.round(b.gross / daysInMonthFor(month));
    return {
      future_days: futureDays,
      employee_id: e.id, name: e.name, employee_code: e.employee_code, department: e.department,
      already_generated: already,
      gross: b.gross, days_worked: Math.max(0, paidDays - sandwichDays),
      total_days: daysInMonthFor(month), absent_days: absentDays, unmarked_days: unmarkedDays, lop_days: lopDays,
      lop_deduction: lopDeduction, late_deduction: lateDeduction, sandwich_lop_deduction: sandwichDeduction,
      net: Math.max(0, b.net - lateDeduction - lopDeduction - sandwichDeduction)
    };
  });
  res.json({ period, month, config: attendancePayConfig(), employees: rows });
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

// Attendance-driven pay policy. Kept as `policies` rows (category 'setting') like the CTC split
// percentages above, so Super Admin can change it without a deploy.
const ATTENDANCE_PAY_DEFAULTS = {
  // The important one. Previously ONLY an explicit 'Absent' row was unpaid, so an employee who
  // attended two days and simply had no attendance rows for the rest of the month drew a FULL
  // month's salary — the common real case, because nobody goes back and marks 'Absent' on days
  // someone never turned up. With this on, a working day with no attendance record is unpaid,
  // so pay follows the days actually attended.
  'Unmarked working days are unpaid': 1,
  // Saturday/Sunday are never docked for being unmarked — nobody marks attendance on a weekly
  // off. The Sandwich Rule below is the only thing that makes a weekend unpaid.
  'Weekends are paid': 1
};

function getPolicyNumber(name, fallback) {
  const row = db.prepare('SELECT value FROM policies WHERE name = ?').get(name);
  const n = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function attendancePayConfig() {
  const cfg = {};
  Object.keys(ATTENDANCE_PAY_DEFAULTS).forEach((name) => { cfg[name] = getPolicyNumber(name, ATTENDANCE_PAY_DEFAULTS[name]); });
  return cfg;
}

// Day-by-day classification of one employee's month. Each calendar day is:
//   Present / Leave      -> paid (approved leave stays paid, same as before)
//   Absent               -> unpaid
//   no row, Sat/Sun      -> paid, when 'Weekends are paid' is on
//   no row, working day  -> unpaid, when 'Unmarked working days are unpaid' is on
//   before date_of_joining -> neither paid nor docked; they were not employed yet, and docking
//                            here would turn a mid-month joiner's first payslip negative.
//                            Joining-date pro-rata is a separate rule this does not implement.
//   after today            -> paid. You cannot have failed to attend a day that has not happened,
//                            so running payroll mid-month must not dock the rest of the month.
//                            Without this, a run on the 5th would pay everyone almost nothing.
function attendanceDaysFor(employeeId, month) {
  const cfg = attendancePayConfig();
  const unmarkedUnpaid = cfg['Unmarked working days are unpaid'] === 1;
  const weekendsPaid = cfg['Weekends are paid'] === 1;
  const joined = db.prepare('SELECT date_of_joining FROM employees WHERE id = ?').get(employeeId)?.date_of_joining;
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;

  const days = db.prepare(`
    WITH RECURSIVE dates(d) AS (
      SELECT date(? || '-01')
      UNION ALL
      SELECT date(d, '+1 day') FROM dates WHERE d < date(? || '-01', '+1 month', '-1 day')
    )
    SELECT d AS date, CAST(strftime('%w', d) AS INTEGER) AS dow FROM dates
  `).all(month, month);

  const statusBy = new Map(
    db.prepare('SELECT date, status FROM attendance WHERE employee_id = ? AND date LIKE ?')
      .all(employeeId, month + '%').map((r) => [r.date, r.status])
  );

  let paidDays = 0, absentDays = 0, unmarkedDays = 0, preJoiningDays = 0, futureDays = 0;
  days.forEach(({ date, dow }) => {
    if (joined && date < joined) { preJoiningDays++; return; }
    const status = statusBy.get(date);
    if (status === 'Present' || status === 'Leave') { paidDays++; return; }
    if (status === 'Absent') { absentDays++; return; }
    if (date > today) { futureDays++; paidDays++; return; }
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend && weekendsPaid) { paidDays++; return; }
    if (unmarkedUnpaid) { unmarkedDays++; return; }
    paidDays++;
  });

  return { totalDays: days.length, paidDays, absentDays, unmarkedDays, preJoiningDays, futureDays };
}

// Loss of Pay for the month: explicitly-Absent days plus (by policy) working days with no
// attendance record at all. The per-day rate stays gross/calendar-days, unchanged.
function lopFor(employeeId, month, gross) {
  const d = attendanceDaysFor(employeeId, month);
  const lopDays = d.absentDays + d.unmarkedDays;
  const perDayRate = Math.round(gross / daysInMonthFor(month));
  return {
    lopDays,
    absentDays: d.absentDays,
    unmarkedDays: d.unmarkedDays,
    paidDays: d.paidDays,
    futureDays: d.futureDays,
    deduction: lopDays * perDayRate
  };
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Sandwich Rule (company policy): a weekly-off weekend "bookended" by an unexplained Absent mark
// on both sides — the working day right before it (Friday) AND the working day right after
// (Monday) — has that Saturday/Sunday become unpaid too, on the theory that someone absent both
// days either side almost certainly didn't work the weekend either. Approved Leave never
// triggers this, only an explicit 'Absent' status on BOTH sides does — someone on legitimate
// leave adjacent to a weekend still gets it paid. There's no "weekly off" concept anywhere else
// in this app (see attendanceCore.js), so Saturday/Sunday are detected here purely by date
// (day-of-week 6/0), not by any shift/roster configuration.
function sandwichWeekendDays(employeeId, month) {
  const weekendDates = db.prepare(`
    WITH RECURSIVE dates(d) AS (
      SELECT date(? || '-01')
      UNION ALL
      SELECT date(d, '+1 day') FROM dates WHERE d < date(? || '-01', '+1 month', '-1 day')
    )
    SELECT d AS date, CAST(strftime('%w', d) AS INTEGER) AS dow FROM dates WHERE strftime('%w', d) IN ('0', '6')
  `).all(month, month);

  const statusOn = (date) => db.prepare('SELECT status FROM attendance WHERE employee_id = ? AND date = ?').get(employeeId, date)?.status;

  return weekendDates.reduce((count, row) => {
    const friday = row.dow === 6 ? shiftDate(row.date, -1) : shiftDate(row.date, -2);
    const monday = row.dow === 6 ? shiftDate(row.date, 2) : shiftDate(row.date, 1);
    return statusOn(friday) === 'Absent' && statusOn(monday) === 'Absent' ? count + 1 : count;
  }, 0);
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
      const { lopDays, unmarkedDays, paidDays, deduction: lopDeduction } = lopFor(e.id, month, b.gross);
      const sandwichDays = sandwichWeekendDays(e.id, month);
      const sandwichDeduction = sandwichDays * Math.round(b.gross / daysInMonthFor(month));
      // Days actually paid for, straight from the attendance classification, minus any weekend
      // the Sandwich Rule separately made unpaid — no longer "every day in the month that nobody
      // marked Absent", which was how a two-day month could still read as a full one.
      const daysWorked = Math.max(0, paidDays - sandwichDays);
      // Deductions can exceed gross once a month is almost entirely unattended. Net is floored at
      // zero rather than going negative — an employer withholds pay, it does not invoice for it.
      const net = Math.max(0, b.net - lateDeduction - lopDeduction - sandwichDeduction);
      db.prepare(`
        INSERT INTO payslips (employee_id, period, month, basic, hra, allowances, deductions, late_deduction, lop_days, unmarked_lop_days, lop_deduction, sandwich_lop_days, sandwich_lop_deduction, days_worked, net, lines_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e.id, period, month, basic, hra, allowances, b.totalDeductions, lateDeduction, lopDays, unmarkedDays, lopDeduction, sandwichDays, sandwichDeduction, daysWorked, net, JSON.stringify({ earnings: b.earnings, deductions: b.deductions }));
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
// statutory fields as they stand today, and the company's own branding (logo/name/address) to
// print in the header.
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
    company: getSettings(['company_name', 'company_logo', 'company_address'])
  });
});

// --- Reports: per-period totals + department breakdown ---
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const byPeriod = db.prepare(`
    SELECT period, COUNT(*) AS employees, SUM(net) AS total_net, SUM(basic + hra + allowances) AS total_gross, SUM(deductions) AS total_deductions, SUM(late_deduction) AS total_late_deduction, SUM(lop_deduction) AS total_lop_deduction, SUM(sandwich_lop_deduction) AS total_sandwich_lop_deduction
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
    SELECT p.period, e.employee_code, e.name, e.department, p.basic, p.hra, p.allowances, p.deductions, p.late_deduction, p.lop_days, p.lop_deduction, p.sandwich_lop_days, p.sandwich_lop_deduction, p.net
    FROM payslips p JOIN employees e ON e.id = p.employee_id ORDER BY p.period, e.id
  `).all();
  const csv = ['period,code,name,department,basic,hra,allowances,deductions,late_deduction,lop_days,lop_deduction,sandwich_lop_days,sandwich_lop_deduction,net', ...rows.map((r) => `${r.period},${r.employee_code},${r.name},${r.department},${r.basic},${r.hra},${r.allowances},${r.deductions},${r.late_deduction},${r.lop_days},${r.lop_deduction},${r.sandwich_lop_days},${r.sandwich_lop_deduction},${r.net}`)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payroll-report.csv"');
  res.send(csv);
});

// --- AI-assisted month-over-month comparison ---
function periodStatsFor(month) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS headcount, COALESCE(SUM(net), 0) AS totalNet,
           COALESCE(SUM(basic + hra + allowances), 0) AS totalGross,
           COALESCE(SUM(deductions), 0) AS totalDeductions,
           COALESCE(SUM(lop_deduction), 0) AS totalLop,
           COALESCE(SUM(sandwich_lop_deduction), 0) AS totalSandwichLop,
           COALESCE(SUM(late_deduction), 0) AS totalLate
    FROM payslips WHERE month = ?
  `).get(month);
  return { month, ...totals };
}

router.get('/monthly-comparison', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const months = db.prepare('SELECT DISTINCT month FROM payslips WHERE month IS NOT NULL ORDER BY month DESC').all().map((r) => r.month);
  if (months.length < 2) {
    return res.json({ available: false, months, message: 'Need at least two months of payroll runs to compare.' });
  }

  const [currentMonth, previousMonth] = months;
  const current = periodStatsFor(currentMonth);
  const previous = periodStatsFor(previousMonth);

  const currentEmployees = db.prepare('SELECT p.employee_id, e.name, p.net FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.month = ?').all(currentMonth);
  const previousEmployees = db.prepare('SELECT p.employee_id, e.name, p.net FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.month = ?').all(previousMonth);

  const currentIds = new Set(currentEmployees.map((e) => e.employee_id));
  const previousIds = new Set(previousEmployees.map((e) => e.employee_id));
  const newHires = currentEmployees.filter((e) => !previousIds.has(e.employee_id)).map((e) => e.name);
  const exited = previousEmployees.filter((e) => !currentIds.has(e.employee_id)).map((e) => e.name);

  const previousNetById = new Map(previousEmployees.map((e) => [e.employee_id, e.net]));
  const biggestChanges = currentEmployees
    .filter((e) => previousNetById.has(e.employee_id))
    .map((e) => ({ name: e.name, delta: e.net - previousNetById.get(e.employee_id) }))
    .filter((c) => c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  res.json({ available: true, months, current, previous, newHires, exited, biggestChanges });
});

router.post('/monthly-comparison/explain', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { current, previous, newHires, exited, biggestChanges } = req.body || {};
  if (!current || !previous) return res.status(400).json({ error: 'current and previous period stats are required' });
  const explanation = await explainPayrollComparison(current, previous, {
    newHires: newHires || [], exited: exited || [], biggestChanges: biggestChanges || []
  });
  res.json({ explanation });
});

export default router;

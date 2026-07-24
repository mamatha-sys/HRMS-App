import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/summary', (req, res) => {
  if (req.user.role === 'employee') {
    const me = db.prepare('SELECT * FROM employees WHERE user_id = ?').get(req.user.sub);
    return res.json({ role: 'employee', me: me || null });
  }

  const { department, branch, status } = req.query;
  const where = [];
  const params = {};
  if (department) { where.push('department = @department'); params.department = department; }
  if (branch) { where.push('branch = @branch'); params.branch = branch; }
  if (status) { where.push('status = @status'); params.status = status; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM employees ${whereSql}`).get(params).c;
  const active = db.prepare(`SELECT COUNT(*) AS c FROM employees ${whereSql ? whereSql + " AND status = 'Active'" : "WHERE status = 'Active'"}`).get(params).c;
  const inactive = total - active;
  const departments = db.prepare(`SELECT COUNT(DISTINCT department) AS c FROM employees ${whereSql}`).get(params).c;

  // Today's attendance, respecting the same department/branch/status filter via a join on employees.
  const empFilter = whereSql ? whereSql.replace(/(department|branch|status)/g, 'e.$1') : '';
  const presentToday = db.prepare(`
    SELECT COUNT(*) AS c FROM attendance a JOIN employees e ON e.id = a.employee_id
    WHERE a.date = date('now') AND a.status = 'Present' ${empFilter ? 'AND ' + empFilter.replace('WHERE ', '') : ''}
  `).get(params).c;
  const absentToday = db.prepare(`
    SELECT COUNT(*) AS c FROM attendance a JOIN employees e ON e.id = a.employee_id
    WHERE a.date = date('now') AND a.status = 'Absent' ${empFilter ? 'AND ' + empFilter.replace('WHERE ', '') : ''}
  `).get(params).c;

  const payrollRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const payrollStatus = payrollRun ? payrollRun.status : 'Pending';

  const newHires = db.prepare(`
    SELECT COUNT(*) AS c FROM employees ${whereSql ? whereSql + " AND " : "WHERE "} date_of_joining >= date('now','-90 days')
  `).get(params).c;
  const openPositions = db.prepare("SELECT COALESCE(SUM(target_headcount),0) AS c FROM positions WHERE status = 'Open'").get().c;
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE status = 'Pending'").get().c;

  const kpis = [
    { label: 'Total Employees', value: total, color: 'blue' },
    { label: 'Active / Inactive', value: `${active} / ${inactive}`, color: 'green' },
    { label: 'New Hires (90d)', value: newHires, color: 'blue' },
    { label: 'Open Positions', value: openPositions, color: 'gold' },
    { label: 'Present Today', value: presentToday, color: 'green' },
    { label: 'Absent Today', value: absentToday, color: 'red' },
    { label: 'Pending Approvals', value: pendingApprovals, color: 'red' },
    { label: 'Payroll Status', value: payrollStatus, color: 'gold' }
  ];

  const departmentBreakdown = db
    .prepare(`SELECT department, COUNT(*) AS count FROM employees ${whereSql} GROUP BY department ORDER BY count DESC`)
    .all(params);

  // Real trend data grouped by year of date_of_joining (the seed/demo data spans multiple
  // years, not recent months, so a monthly window would be misleadingly flat — year buckets
  // reflect the actual shape of the data instead of a smoother but fabricated curve).
  const joinYears = db
    .prepare(`SELECT CAST(strftime('%Y', date_of_joining) AS INTEGER) AS year, COUNT(*) AS count FROM employees ${whereSql} GROUP BY year ORDER BY year`)
    .all(params);
  let cumulative = 0;
  const growthTrend = joinYears.map((y) => { cumulative += y.count; return { label: String(y.year), value: cumulative }; });
  const hiringTrend = joinYears.map((y) => ({ label: String(y.year), value: y.count }));

  const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

  const configRows = db.prepare('SELECT widget_key, visible FROM dashboard_config').all();
  const widgetVisibility = {};
  configRows.forEach((c) => { widgetVisibility[c.widget_key] = !!c.visible; });

  res.json({
    role: req.user.role,
    kpis,
    departmentBreakdown,
    growthTrend,
    hiringTrend,
    usersCount,
    widgetVisibility
  });
});

export default router;

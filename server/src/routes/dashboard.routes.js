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
  const openPositions = db.prepare("SELECT COALESCE(SUM(target_headcount),0) AS c FROM positions WHERE status = 'Open'").get().c;

  const kpis = [
    { label: 'Total Employees', value: total, color: 'blue' },
    { label: 'Active', value: active, color: 'green' },
    { label: 'Inactive', value: inactive, color: 'red' },
    { label: 'Departments', value: departments, color: 'gold' },
    { label: 'Open Positions', value: openPositions, color: 'gold' }
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

  res.json({
    role: req.user.role,
    kpis,
    departmentBreakdown,
    growthTrend,
    hiringTrend,
    usersCount
  });
});

export default router;

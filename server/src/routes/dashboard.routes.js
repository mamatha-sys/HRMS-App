import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { isScopedRole, filterToScopeOrOwnDepartment, scopeDepartmentNamesOrOwn } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

router.get('/summary', (req, res) => {
  if (req.user.role === 'employee') {
    const me = myEmployee(req.user.sub);
    return res.json({ role: 'employee', me: me || null });
  }

  const { department, branch, status } = req.query;
  const scoped = isScopedRole(req.user.role);
  const myEmployeeId = myEmployee(req.user.sub)?.id;

  // STL/TL only ever see their own supervisor-assigned departments/teams here — every KPI,
  // chart, and count below is derived from this one already-scoped employee list, the same
  // fetch-then-filter pattern Attendance/Leave overview endpoints use, rather than company-wide
  // SQL aggregates. Falls back to their own department when Super Admin hasn't configured an
  // explicit supervisor scope yet, same precedent as Employee Management's "My Team".
  let employees = db.prepare('SELECT * FROM employees').all();
  if (department) employees = employees.filter((e) => e.department === department);
  if (branch) employees = employees.filter((e) => e.branch === branch);
  if (status) employees = employees.filter((e) => e.status === status);
  if (scoped) employees = filterToScopeOrOwnDepartment(employees, req.user.role, myEmployeeId);

  const total = employees.length;
  const active = employees.filter((e) => e.status === 'Active').length;
  const inactive = total - active;
  const departments = new Set(employees.map((e) => e.department)).size;

  const empIds = new Set(employees.map((e) => e.id));
  const todaysAttendance = db.prepare("SELECT employee_id, status FROM attendance WHERE date = date('now')")
    .all().filter((a) => empIds.has(a.employee_id));
  const presentToday = todaysAttendance.filter((a) => a.status === 'Present').length;
  const absentToday = todaysAttendance.filter((a) => a.status === 'Absent').length;

  const payrollRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const payrollStatus = payrollRun ? payrollRun.status : 'Pending';

  const newHires = employees.filter((e) => e.date_of_joining && e.date_of_joining >= db.prepare("SELECT date('now','-90 days') AS d").get().d).length;

  const openPositionRows = db.prepare(`
    SELECT p.target_headcount, d.name AS department FROM positions p JOIN departments d ON d.id = p.department_id WHERE p.status = 'Open'
  `).all();
  const openPositions = scoped
    ? openPositionRows.filter((p) => scopeDepartmentNamesOrOwn(req.user.role, myEmployeeId).includes(p.department)).reduce((sum, p) => sum + p.target_headcount, 0)
    : openPositionRows.reduce((sum, p) => sum + p.target_headcount, 0);

  // The `approvals` table records the requester by name only (no employee_id/department column)
  // — same convention as approvals.routes.js/attendance.routes.js. Enrich with the requester's
  // department/team so this count matches the (already-scoped) Pending Approvals widget below it
  // for STL/TL, instead of always showing the company-wide total.
  const employeeByName = (name) => db.prepare('SELECT department, team_id FROM employees WHERE name = ?').get(name);
  const pendingApprovalRows = db.prepare("SELECT requester FROM approvals WHERE status = 'Pending'")
    .all().map((r) => ({ ...r, ...(employeeByName(r.requester) || {}) }));
  const pendingApprovals = filterToScopeOrOwnDepartment(pendingApprovalRows, req.user.role, myEmployeeId).length;

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

  const breakdownMap = {};
  employees.forEach((e) => { breakdownMap[e.department] = (breakdownMap[e.department] || 0) + 1; });
  const departmentBreakdown = Object.entries(breakdownMap)
    .map(([dept, count]) => ({ department: dept, count }))
    .sort((a, b) => b.count - a.count);

  // STL/TL specifically: a department-level (STL) grant can span several teams (e.g. Education's
  // Team-A/Team-B) that otherwise never show up anywhere — the department number alone hides
  // that split. Give scoped roles a team-wise count alongside the department one.
  let teamBreakdown = null;
  if (scoped) {
    const teamNameById = {};
    db.prepare('SELECT id, name FROM teams').all().forEach((t) => { teamNameById[t.id] = t.name; });
    const teamMap = {};
    employees.forEach((e) => {
      const label = e.team_id ? (teamNameById[e.team_id] || `Team #${e.team_id}`) : 'No team';
      teamMap[label] = (teamMap[label] || 0) + 1;
    });
    teamBreakdown = Object.entries(teamMap).map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count);
  }

  // Real trend data grouped by year of date_of_joining (the seed/demo data spans multiple
  // years, not recent months, so a monthly window would be misleadingly flat — year buckets
  // reflect the actual shape of the data instead of a smoother but fabricated curve).
  const yearCounts = {};
  employees.forEach((e) => {
    const year = e.date_of_joining ? Number(e.date_of_joining.slice(0, 4)) : null;
    if (year) yearCounts[year] = (yearCounts[year] || 0) + 1;
  });
  const sortedYears = Object.keys(yearCounts).map(Number).sort((a, b) => a - b);
  let cumulative = 0;
  const growthTrend = sortedYears.map((y) => { cumulative += yearCounts[y]; return { label: String(y), value: cumulative }; });
  const hiringTrend = sortedYears.map((y) => ({ label: String(y), value: yearCounts[y] }));

  const usersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

  const configRows = db.prepare('SELECT widget_key, visible FROM dashboard_config').all();
  const widgetVisibility = {};
  configRows.forEach((c) => { widgetVisibility[c.widget_key] = !!c.visible; });

  res.json({
    role: req.user.role,
    kpis,
    departmentBreakdown,
    teamBreakdown,
    growthTrend,
    hiringTrend,
    usersCount,
    widgetVisibility
  });
});

export default router;

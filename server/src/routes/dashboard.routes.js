import { Router } from 'express';
import ExcelJS from 'exceljs';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { isScopedRole, filterToScopeOrOwnDepartment, scopeDepartmentNamesOrOwn } from '../utils/scope.js';

const router = Router();
router.use(requireAuth);

const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

// Upcoming birthdays and work anniversaries. Deliberately NOT narrowed to an STL/TL's assigned
// departments or gated by role — these are a shared team-morale feature everyone should see the
// same version of, not a data-access concern. The optional `department` argument is the
// Dashboard's own filter bar, not a permission check: when the user narrows the whole dashboard
// to one department, this widget follows the same selection as every KPI and chart above it.
function upcomingCelebrations(windowDays = 14, department = '') {
  let rows = db.prepare(`
    SELECT id, name, employee_code, department, date_of_birth, date_of_joining
    FROM employees
    WHERE status = 'Active'
      AND ((date_of_birth IS NOT NULL AND date_of_birth != '') OR (date_of_joining IS NOT NULL AND date_of_joining != ''))
  `).all();
  if (department) rows = rows.filter((e) => e.department === department);

  const todayStr = db.prepare("SELECT date('now') AS d").get().d;
  const today = new Date(`${todayStr}T00:00:00`);
  const currentYear = today.getFullYear();

  function nextOccurrence(dateStr) {
    const [, mm, dd] = dateStr.split('-');
    let candidate = new Date(`${currentYear}-${mm}-${dd}T00:00:00`);
    if (candidate < today) candidate = new Date(`${currentYear + 1}-${mm}-${dd}T00:00:00`);
    return candidate;
  }
  const daysAway = (d) => Math.round((d - today) / 86400000);
  const mmdd = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const birthdays = [];
  const anniversaries = [];
  rows.forEach((e) => {
    if (e.date_of_birth) {
      const next = nextOccurrence(e.date_of_birth);
      const away = daysAway(next);
      if (away <= windowDays) {
        birthdays.push({ id: e.id, name: e.name, employee_code: e.employee_code, department: e.department, date: mmdd(next), daysAway: away });
      }
    }
    if (e.date_of_joining) {
      const joinYear = Number(e.date_of_joining.slice(0, 4));
      const next = nextOccurrence(e.date_of_joining);
      const away = daysAway(next);
      const years = next.getFullYear() - joinYear;
      // Only a real anniversary (1+ full year completed) — a hire whose join date falls in this
      // upcoming window during their own first year isn't "celebrating" yet.
      if (away <= windowDays && years >= 1) {
        anniversaries.push({ id: e.id, name: e.name, employee_code: e.employee_code, department: e.department, date: mmdd(next), daysAway: away, years });
      }
    }
  });
  birthdays.sort((a, b) => a.daysAway - b.daysAway);
  anniversaries.sort((a, b) => a.daysAway - b.daysAway);
  return { birthdays, anniversaries };
}

// Visible to every role, including plain 'employee' (whose /summary returns only {role, me} and
// skips all the HR-only aggregates) — no requireAuth gate beyond the router-wide one.
router.get('/celebrations', (req, res) => {
  res.json(upcomingCelebrations(14, req.query.department || ''));
});

// Every number, chart and export on this page is derived from ONE filtered+scoped employee list,
// so the Department/Branch/Status filter bar changes the entire dashboard consistently rather
// than only the KPI strip. Returned to both /summary (as JSON) and /export.xlsx (as sheets), so
// what you download is exactly what you were looking at — same filters, same scope, same totals.
function buildDashboard(req) {
  const department = (req.query.department || '').trim();
  const branch = (req.query.branch || '').trim();
  const status = (req.query.status || '').trim();
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

  const teamNameById = {};
  db.prepare('SELECT id, name FROM teams').all().forEach((t) => { teamNameById[t.id] = t.name; });

  const empIds = new Set(employees.map((e) => e.id));
  const todaysAttendance = db.prepare("SELECT employee_id, status FROM attendance WHERE date = date('now')")
    .all().filter((a) => empIds.has(a.employee_id));
  const presentToday = todaysAttendance.filter((a) => a.status === 'Present').length;
  const absentToday = todaysAttendance.filter((a) => a.status === 'Absent').length;
  const onLeaveToday = todaysAttendance.filter((a) => a.status === 'Leave').length;

  const payrollRun = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
  const payrollStatus = payrollRun ? payrollRun.status : 'Pending';

  const ninetyDaysAgo = db.prepare("SELECT date('now','-90 days') AS d").get().d;
  const newHires = employees.filter((e) => e.date_of_joining && e.date_of_joining >= ninetyDaysAgo).length;

  // Open Positions follows the same department selection as everything else: an "Education"
  // dashboard must not keep showing the company-wide requisition total in its KPI strip.
  let openPositionRows = db.prepare(`
    SELECT p.title, p.target_headcount, p.status, d.name AS department
    FROM positions p JOIN departments d ON d.id = p.department_id WHERE p.status = 'Open'
  `).all();
  if (department) openPositionRows = openPositionRows.filter((p) => p.department === department);
  if (scoped) {
    const names = scopeDepartmentNamesOrOwn(req.user.role, myEmployeeId);
    openPositionRows = openPositionRows.filter((p) => names.includes(p.department));
  }
  const openPositions = openPositionRows.reduce((sum, p) => sum + p.target_headcount, 0);

  // The `approvals` table records the requester by name only (no employee_id/department column)
  // — same convention as approvals.routes.js/attendance.routes.js. Enrich with the requester's
  // department/team so this count matches the (already-scoped) Pending Approvals widget below it
  // for STL/TL, and so the Department filter narrows it the same way it narrows the KPIs.
  const employeeByName = (name) => db.prepare('SELECT department, team_id FROM employees WHERE name = ?').get(name);
  let pendingApprovalRows = db.prepare("SELECT id, type, requester, detail, created_at FROM approvals WHERE status = 'Pending' ORDER BY created_at DESC")
    .all().map((r) => ({ ...r, ...(employeeByName(r.requester) || {}) }));
  if (department) pendingApprovalRows = pendingApprovalRows.filter((r) => r.department === department);
  pendingApprovalRows = filterToScopeOrOwnDepartment(pendingApprovalRows, req.user.role, myEmployeeId);
  const pendingApprovals = pendingApprovalRows.length;

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

  // Team-wise counts. Previously computed only for STL/TL; now also produced whenever a single
  // department is selected, because that is exactly when the department bar collapses to one
  // column and the interesting split (Team-A vs Team-B within Education) becomes the team one.
  let teamBreakdown = null;
  if (scoped || department) {
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

  return {
    role: req.user.role,
    filters: { department, branch, status },
    kpis,
    departmentBreakdown,
    teamBreakdown,
    growthTrend,
    hiringTrend,
    usersCount,
    widgetVisibility,
    // Underscore-prefixed: the underlying rows, needed only by the export — /summary strips them
    // rather than shipping the whole employee table to the browser on every dashboard load.
    _employees: employees,
    _teamNameById: teamNameById,
    _attendanceToday: todaysAttendance,
    _openPositions: openPositionRows,
    _pendingApprovals: pendingApprovalRows,
    _celebrations: upcomingCelebrations(14, department),
    _counts: { total, active, inactive, presentToday, absentToday, onLeaveToday }
  };
}

router.get('/summary', (req, res) => {
  if (req.user.role === 'employee') {
    const me = myEmployee(req.user.sub);
    return res.json({ role: 'employee', me: me || null });
  }
  const d = buildDashboard(req);
  res.json({
    role: d.role,
    filters: d.filters,
    kpis: d.kpis,
    departmentBreakdown: d.departmentBreakdown,
    teamBreakdown: d.teamBreakdown,
    growthTrend: d.growthTrend,
    hiringTrend: d.hiringTrend,
    usersCount: d.usersCount,
    widgetVisibility: d.widgetVisibility
  });
});

// One global export for the whole dashboard, honouring the exact filters and role scope in force
// on screen. The per-chart "Export" buttons stay where they are — each still gives you that one
// chart as a two-column CSV; this is the multi-sheet version of the entire page, with a record of
// which filters produced it. Deliberately excludes bank/Aadhaar/PAN and other sensitive columns:
// those are masked on screen for non-Super-Admin roles, and an export must not become the way
// around that.
router.get('/export.xlsx', async (req, res) => {
  if (req.user.role === 'employee') return res.status(403).json({ error: 'Insufficient permissions' });
  const d = buildDashboard(req);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'HRMS';
  wb.created = new Date();

  const head = (sheet, cols) => {
    const row = sheet.addRow(cols);
    row.font = { bold: true };
    row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F8' } }; });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return row;
  };
  const autoWidth = (sheet) => {
    // ExcelJS returns null (not []) for `columns` on a sheet that has no rows yet — every sheet
    // here writes a header first so that shouldn't happen, but a crash mid-stream would send a
    // truncated .xlsx the browser still saves, so fail soft rather than throw.
    if (!sheet.columns) return;
    sheet.columns.forEach((col) => {
      let max = 10;
      col.eachCell({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
      col.width = Math.min(48, max);
    });
  };

  const stamp = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
  const filterLabel = [
    d.filters.department ? `Department: ${d.filters.department}` : 'Department: All',
    d.filters.branch ? `Branch: ${d.filters.branch}` : 'Branch: All',
    d.filters.status ? `Status: ${d.filters.status}` : 'Status: All'
  ].join('  |  ');

  // --- Sheet 1: Overview (what was filtered + every KPI exactly as shown on screen) ---
  const overview = wb.addWorksheet('Overview');
  overview.addRow(['HRMS - Dashboard Export']).font = { bold: true, size: 14 };
  overview.addRow(['Generated at', stamp]);
  overview.addRow(['Generated by', `${req.user.name || ''} (${req.user.role})`]);
  overview.addRow(['Filters applied', filterLabel]);
  if (isScopedRole(req.user.role)) overview.addRow(['Data scope', 'Limited to your assigned department(s)/team(s)']);
  overview.addRow([]);
  overview.addRow(['KPI', 'Value']).font = { bold: true };
  d.kpis.forEach((k) => overview.addRow([k.label, k.value]));
  overview.addRow([]);
  overview.addRow(['On Leave Today', d._counts.onLeaveToday]);
  autoWidth(overview);

  // --- Sheet 2: Employees (the exact filtered population every number above is built from) ---
  const emps = wb.addWorksheet('Employees');
  head(emps, ['Employee Code', 'Name', 'Department', 'Team', 'Designation', 'Branch', 'Status', 'Date of Joining', 'Reporting Manager', 'Email', 'Phone']);
  d._employees.forEach((e) => emps.addRow([
    e.employee_code, e.name, e.department,
    e.team_id ? (d._teamNameById[e.team_id] || `Team #${e.team_id}`) : '',
    e.designation, e.branch || '', e.status, e.date_of_joining || '', e.reporting_manager || '', e.email || '', e.phone || ''
  ]));
  autoWidth(emps);

  // --- Sheet 3: Department Breakdown ---
  const deptSheet = wb.addWorksheet('Department Breakdown');
  head(deptSheet, ['Department', 'Employees', '% of Total']);
  const totalForPct = d._counts.total || 1;
  d.departmentBreakdown.forEach((r) => deptSheet.addRow([r.department, r.count, `${((r.count / totalForPct) * 100).toFixed(1)}%`]));
  autoWidth(deptSheet);

  // --- Sheet 4: Team Breakdown (only when there is a team split to show) ---
  if (d.teamBreakdown && d.teamBreakdown.length) {
    const teamSheet = wb.addWorksheet('Team Breakdown');
    head(teamSheet, ['Team', 'Employees']);
    d.teamBreakdown.forEach((r) => teamSheet.addRow([r.team, r.count]));
    autoWidth(teamSheet);
  }

  // --- Sheet 5: Trends (the numbers behind both charts, aligned on the same year axis) ---
  const trends = wb.addWorksheet('Trends');
  head(trends, ['Year', 'Cumulative Headcount', 'New Hires']);
  d.growthTrend.forEach((g, i) => trends.addRow([g.label, g.value, d.hiringTrend[i]?.value ?? 0]));
  autoWidth(trends);

  // --- Sheet 6: Attendance Today ---
  const att = wb.addWorksheet('Attendance Today');
  head(att, ['Employee Code', 'Name', 'Department', 'Status']);
  const statusByEmp = new Map(d._attendanceToday.map((a) => [a.employee_id, a.status]));
  d._employees.forEach((e) => att.addRow([e.employee_code, e.name, e.department, statusByEmp.get(e.id) || 'Not Marked']));
  autoWidth(att);

  // --- Sheet 7: Pending Approvals ---
  const appr = wb.addWorksheet('Pending Approvals');
  head(appr, ['Type', 'Requester', 'Department', 'Detail', 'Raised On']);
  d._pendingApprovals.forEach((a) => appr.addRow([a.type, a.requester, a.department || '', a.detail || '', a.created_at || '']));
  autoWidth(appr);

  // --- Sheet 8: Open Positions ---
  const pos = wb.addWorksheet('Open Positions');
  head(pos, ['Department', 'Title', 'Target Headcount']);
  d._openPositions.forEach((p) => pos.addRow([p.department, p.title || '', p.target_headcount]));
  autoWidth(pos);

  // --- Sheet 9: Celebrations (next 14 days) ---
  const cel = wb.addWorksheet('Celebrations');
  head(cel, ['Occasion', 'Employee Code', 'Name', 'Department', 'Date (MM-DD)', 'Days Away', 'Years']);
  d._celebrations.birthdays.forEach((b) => cel.addRow(['Birthday', b.employee_code, b.name, b.department, b.date, b.daysAway, '']));
  d._celebrations.anniversaries.forEach((a) => cel.addRow(['Work Anniversary', a.employee_code, a.name, a.department, a.date, a.daysAway, a.years]));
  autoWidth(cel);

  const slug = d.filters.department ? d.filters.department.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() : 'all-departments';
  const fileDate = db.prepare("SELECT date('now','localtime') AS d").get().d;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="hrms-dashboard-${slug}-${fileDate}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;

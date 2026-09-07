import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';
import { monthlyAttendanceSummary } from '../utils/attendanceCore.js';
import { notifyEmployee } from '../utils/notify.js';
import { REQUIRED_IDEAS_PER_WEEK } from './ideas.routes.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '10' (Performance Management / PMS). A Senior Team
// Lead/Team Lead/Assistant Manager also passes — but ONLY for the read-only /overview and
// /reports below, which explicitly scope every list they return; every write endpoint in this
// file (create/edit/progress/manager-assessment/competency/plan/complete) still checks isHR
// directly, so scoped roles stay view-only here, matching Super Admin policy.
const isHR = (role) => canModuleAdmin(role, '10');
const canViewPerformance = (role) => canModuleAdmin(role, '10') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const SCOPE_BANNER = {
  super_admin: 'Full Access — configure performance cycles, KPIs/KRAs/OKRs, appraisal templates, rating scales; approve final ratings. Rule: a review cannot be marked complete until both self- and manager-assessment are submitted.',
  hr_admin: 'Company-wide performance — configure cycles and templates, review ratings.',
  manager: 'Team/organization performance — submit manager assessments, mark reviews complete.',
  assistant_manager: 'Team/organization performance — submit manager assessments, mark reviews complete.'
};

const FIELD_ACCESS = [
  { field: 'Record Owner / Assigned-To', access: 'Editable' },
  { field: 'Internal Notes / Remarks', access: 'Editable' }
];

function withFeedback(review) {
  const feedback = db.prepare('SELECT * FROM performance_feedback WHERE review_id = ? ORDER BY created_at DESC').all(review.id);
  return { ...review, feedback };
}

const DEFAULT_TARGETS_PER_MONTH = 4;
function targetsPerMonthFor(departmentId) {
  if (!departmentId) return DEFAULT_TARGETS_PER_MONTH;
  const row = db.prepare('SELECT targets_per_month FROM department_target_policies WHERE department_id = ?').get(departmentId);
  return row?.targets_per_month ?? DEFAULT_TARGETS_PER_MONTH;
}

const currentMonth = () => db.prepare("SELECT strftime('%Y-%m','now') AS m").get().m;
// A target counts as "completed" once its progress bar reaches 100 — a lighter-weight signal
// than the formal review-closing `status` (which also requires both assessments submitted via
// /reviews/:id/complete). Department-wise rollups care about the target itself being done, not
// whether the paperwork around it has been formally closed yet.
const isTargetComplete = (r) => r.status === 'Completed' || r.progress_pct >= 100;

// Nudges for a review sitting with a pending assessment — same lazy, no-background-scheduler
// idiom as Helpdesk's 24h auto-escalation: runs at the top of every review-list read, and only
// actually sends once every REMINDER_COOLDOWN_DAYS per review (via last_reminded_at) so loading
// the dashboard repeatedly doesn't spam the same reminder. Self-assessment pending → nudge the
// employee directly; manager-assessment pending → a 'staff' broadcast, same audience every other
// "someone needs to act on this" alert in the app already uses (New Helpdesk Ticket, etc.).
const REMINDER_COOLDOWN_DAYS = 3;
function sendPendingAssessmentReminders() {
  const stale = db.prepare(`
    SELECT * FROM performance_reviews
    WHERE status != 'Completed' AND (self_assessment_status = 'Pending' OR manager_assessment_status = 'Pending')
      AND (last_reminded_at IS NULL OR last_reminded_at <= datetime('now', ?))
  `).all(`-${REMINDER_COOLDOWN_DAYS} days`);
  stale.forEach((r) => {
    if (r.self_assessment_status === 'Pending' && r.employee_id) {
      notifyEmployee(r.employee_id, 'Self-assessment pending', `Your self-assessment for "${r.goal_text}"${r.month ? ` (${r.month})` : ''} is still pending — please submit it.`);
    }
    if (r.manager_assessment_status === 'Pending') {
      db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)')
        .run('Manager Assessment Pending', `"${r.goal_text}" for ${r.employee_name}${r.month ? ` (${r.month})` : ''} is still waiting on a manager assessment.`, 'staff');
    }
    db.prepare("UPDATE performance_reviews SET last_reminded_at = datetime('now') WHERE id = ?").run(r.id);
  });
}

// Department-wise target progress + each department's top performer for one month, across every
// active employee with a department on file (not just those with reviews — an employee with zero
// targets this month still shows up at 0%, rather than silently vanishing). `deptFilter`, when
// given, narrows to a scoped supervisor's own assigned department(s).
function departmentProgressFor(month, deptFilter) {
  let employees = db.prepare(`
    SELECT e.id AS id, e.name AS name, e.employee_code AS employee_code, e.department AS department, d.id AS department_id
    FROM employees e LEFT JOIN departments d ON d.name = e.department
    WHERE e.status = 'Active' AND e.department IS NOT NULL
  `).all();
  if (deptFilter) employees = employees.filter((e) => deptFilter.has(e.department));
  const targets = db.prepare('SELECT employee_id, progress_pct, status FROM performance_reviews WHERE month = ? AND employee_id IS NOT NULL').all(month);
  const byEmployee = {};
  targets.forEach((t) => { (byEmployee[t.employee_id] ||= []).push(t); });

  const byDept = {};
  employees.forEach((e) => {
    const myTargets = byEmployee[e.id] || [];
    const completed = myTargets.filter(isTargetComplete).length;
    const avgProgress = myTargets.length ? Math.round(myTargets.reduce((s, t) => s + t.progress_pct, 0) / myTargets.length) : 0;
    (byDept[e.department] ||= { departmentId: e.department_id, emps: [] }).emps.push({ employee_id: e.id, name: e.name, employee_code: e.employee_code, targetsAssigned: myTargets.length, targetsCompleted: completed, avgProgress });
  });

  return Object.entries(byDept).map(([department, { departmentId, emps }]) => {
    const withTargets = emps.filter((e) => e.targetsAssigned > 0);
    const avgProgress = withTargets.length ? Math.round(withTargets.reduce((s, e) => s + e.avgProgress, 0) / withTargets.length) : 0;
    const top = [...withTargets].sort((a, b) => b.avgProgress - a.avgProgress || b.targetsCompleted - a.targetsCompleted)[0] || null;
    return {
      department,
      targetsPerMonth: targetsPerMonthFor(departmentId),
      avgProgress,
      employeesWithTargets: withTargets.length,
      fullyCompletedCount: withTargets.filter((e) => e.targetsAssigned > 0 && e.targetsCompleted === e.targetsAssigned).length,
      topPerformer: top ? { name: top.name, employee_code: top.employee_code, avgProgress: top.avgProgress, targetsCompleted: top.targetsCompleted, targetsAssigned: top.targetsAssigned } : null
    };
  }).sort((a, b) => b.avgProgress - a.avgProgress);
}

// Per-employee disciplinary standing: starts at 100 and deducts per case, scaled by how serious
// the category is (a Termination case costs far more than a Warning) and halved once a case is
// Resolved rather than still Open — a settled matter shouldn't weigh as heavily as an active one,
// but a clean-now record that had real history still isn't treated as if nothing ever happened.
const DISCIPLINARY_SEVERITY = { Warning: 10, Suspension: 30, Termination: 100, Other: 10 };
function disciplinaryScoreFor(employeeId) {
  const cases = db.prepare('SELECT category, status FROM disciplinary_cases WHERE employee_id = ?').all(employeeId);
  const openCases = cases.filter((c) => c.status === 'Open').length;
  const deduction = cases.reduce((sum, c) => sum + (DISCIPLINARY_SEVERITY[c.category] || DISCIPLINARY_SEVERITY.Other) * (c.status === 'Open' ? 1 : 0.5), 0);
  return { score: Math.max(0, Math.round(100 - deduction)), openCases, resolvedCases: cases.length - openCases };
}

// Every Monday (as 'YYYY-MM-DD') whose week falls inside `month` — capped at today if `month` is
// the current month, since a week that hasn't happened yet can't be judged. Empty for a month
// that hasn't started. Shared by knowledgeTransferScoreFor below and Knowledge Transfer's own
// week-bucketing (ideas.routes.js's weekStartOf), so "which weeks count" agrees everywhere.
function mondaysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const today = new Date();
  const isCurrentMonth = month === today.toISOString().slice(0, 7);
  const end = isCurrentMonth ? today : new Date(Date.UTC(y, m, 0));
  const mondays = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCMonth() === m - 1 && d <= end) {
    if (d.getUTCDay() === 1) mondays.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return mondays;
}

// Knowledge Transfer component: 70% weekly-compliance rate (landed REQUIRED_IDEAS_PER_WEEK
// unique/Approved ideas every week this month) + 30% average idea quality for ideas submitted
// that month. Null (excluded, not scored 0) for a month with no weeks reached yet — same "don't
// penalize for something not yet possible" reasoning as goals below.
function knowledgeTransferScoreFor(employeeId, month) {
  const weeks = mondaysInMonth(month);
  if (!weeks.length) return null;
  const ideas = db.prepare(`
    SELECT week_start, overall_score FROM idea_contributions
    WHERE employee_id = ? AND status = 'Approved' AND week_start >= ? AND week_start <= ?
  `).all(employeeId, weeks[0], weeks[weeks.length - 1]);
  const countsByWeek = {};
  ideas.forEach((i) => { countsByWeek[i.week_start] = (countsByWeek[i.week_start] || 0) + 1; });
  const compliedWeeks = Object.values(countsByWeek).filter((c) => c >= REQUIRED_IDEAS_PER_WEEK).length;
  const complianceRate = Math.min(1, compliedWeeks / weeks.length);
  const avgQuality = ideas.length ? ideas.reduce((s, i) => s + (i.overall_score || 0), 0) / ideas.length : 0;
  const score = Math.round(complianceRate * 70 + (avgQuality / 100) * 30);
  return { score, weeksExpected: weeks.length, weeksComplied: compliedWeeks, avgIdeaScore: ideas.length ? Math.round(avgQuality) : null };
}

// Learning component: % of enrolled courses actually completed. Null (excluded) if not enrolled
// in anything — course enrollment isn't always self-initiated (HR can assign it), so someone with
// zero enrollments hasn't failed at anything, there's just nothing to measure yet.
function learningScoreFor(employeeId) {
  const enrollments = db.prepare('SELECT completed FROM course_enrollments WHERE employee_id = ?').all(employeeId);
  if (!enrollments.length) return null;
  const completed = enrollments.filter((e) => e.completed).length;
  return { score: Math.round((completed / enrollments.length) * 100), coursesEnrolled: enrollments.length, coursesCompleted: completed };
}

// The Employee Progress Score: one 0-100 number blending five independent signals — how much of
// this month's assigned goals are done (40%), attendance reliability (20%), disciplinary record
// (15%), Knowledge Transfer weekly idea contribution (15%), and Learning course completion (10%).
// Goals still matter most, but the other four all pull real weight now — a strong all-round
// contributor (shows up, stays out of trouble, contributes ideas every week, completes training)
// can score well even with modest goal completion, and vice versa. Any component with nothing to
// measure yet (no goals assigned, no course enrollments, month not yet started) is excluded
// entirely rather than scored 0, and the remaining weights are renormalized so they still sum to
// 100% — same reasoning already applied to goals before this expansion.
const PROGRESS_WEIGHTS = { goals: 0.40, attendance: 0.20, disciplinary: 0.15, knowledgeTransfer: 0.15, learning: 0.10 };
export function progressScoreFor(employeeId, month) {
  const targets = db.prepare('SELECT progress_pct FROM performance_reviews WHERE employee_id = ? AND month = ?').all(employeeId, month);
  const goalsScore = targets.length ? Math.round(targets.reduce((s, t) => s + t.progress_pct, 0) / targets.length) : null;
  const attendanceScore = monthlyAttendanceSummary(employeeId, month).attendancePct;
  const { score: disciplinaryScore, openCases, resolvedCases } = disciplinaryScoreFor(employeeId);
  const kt = knowledgeTransferScoreFor(employeeId, month);
  const learning = learningScoreFor(employeeId);

  const parts = [
    goalsScore != null ? { score: goalsScore, weight: PROGRESS_WEIGHTS.goals } : null,
    { score: attendanceScore, weight: PROGRESS_WEIGHTS.attendance },
    { score: disciplinaryScore, weight: PROGRESS_WEIGHTS.disciplinary },
    kt ? { score: kt.score, weight: PROGRESS_WEIGHTS.knowledgeTransfer } : null,
    learning ? { score: learning.score, weight: PROGRESS_WEIGHTS.learning } : null
  ].filter(Boolean);
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const overall = Math.round(parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight);
  const band = overall >= 75 ? 'High' : overall >= 50 ? 'Medium' : 'Low';

  // Salary Increase Recommendation — purely advisory, exactly like Employees' Attrition Risk: a
  // banded signal for HR to weigh, never an instruction and never wired into Payroll's actual
  // pay computation anywhere. An open disciplinary case overrides straight to "Not Recommended"
  // regardless of how high the overall score is — a live conduct issue shouldn't be outweighed by
  // a good goals/attendance month.
  const salaryRecommendation = openCases > 0 ? 'Not Recommended' : overall >= 80 ? 'Recommended' : overall >= 60 ? 'Review at Next Cycle' : 'Not Yet';

  return {
    overall, band, salaryRecommendation,
    goalsScore, targetsAssigned: targets.length, targetsCompleted: targets.filter(isTargetComplete).length,
    attendanceScore, disciplinaryScore, openCases, resolvedCases,
    knowledgeTransferScore: kt?.score ?? null, weeksComplied: kt?.weeksComplied ?? null, weeksExpected: kt?.weeksExpected ?? null,
    learningScore: learning?.score ?? null, coursesCompleted: learning?.coursesCompleted ?? null, coursesEnrolled: learning?.coursesEnrolled ?? null
  };
}

// Flat, sorted list (highest first) of every active employee's Progress Score for one month —
// the HR-facing rollup, same active+has-department employee set as departmentProgressFor above.
function employeeProgressList(month, deptFilter) {
  let employees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' AND department IS NOT NULL").all();
  if (deptFilter) employees = employees.filter((e) => deptFilter.has(e.department));
  return employees
    .map((e) => ({ employee_id: e.id, name: e.name, employee_code: e.employee_code, department: e.department, ...progressScoreFor(e.id, month) }))
    .sort((a, b) => b.overall - a.overall);
}

router.get('/overview', (req, res) => {
  if (!canViewPerformance(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  sendPendingAssessmentReminders();
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  const month = /^\d{4}-\d{2}$/.test(req.query?.month) ? req.query.month : currentMonth();

  let reviews = db.prepare(`
    SELECT pr.*, e.department AS employee_department, e.employee_code AS employee_code, e.designation AS employee_designation
    FROM performance_reviews pr LEFT JOIN employees e ON e.id = pr.employee_id
    ORDER BY (pr.status = 'Completed'), pr.created_at DESC
  `).all().map(withFeedback);
  // A review not yet linked to a real employee record can't be attributed to a department —
  // fail closed (hide it) for a scoped role rather than showing an unattributed, unscoped record.
  if (scoped) reviews = reviews.filter((r) => r.employee_department && scopeDeptNames.has(r.employee_department));
  // Automatic attendance/check-in-check-out reporting, right alongside each review — the same
  // present-days-÷-days-in-month figure Attendance itself reports, for that review's own month
  // (not necessarily the current one, since past reviews are shown here too).
  reviews = reviews.map((r) => (r.employee_id ? { ...r, attendance: monthlyAttendanceSummary(r.employee_id, r.month || month) } : r));
  // Per-review "Overall Score" (0-100) for the review card: once a manager rating exists, blend
  // goal progress with the rating (scaled ×20 to a 0-100 base) so both count; before a rating
  // exists, goal progress is the only signal there is.
  reviews = reviews.map((r) => ({ ...r, overallScore: r.rating != null ? Math.round((r.progress_pct + r.rating * 20) / 2) : r.progress_pct }));

  // Dashboard Summary: Total/Pending/Completed reviews + org-wide average performance score —
  // averaged from each review's own 0-100 Overall Score, so the summary card and every review
  // card's "Overall Score" are the same scale (previously this KPI averaged the raw 1-5 manager
  // rating while cards showed a 0-100 score — two different scales for the same idea).
  const totalReviews = reviews.length;
  const completedReviews = reviews.filter((r) => r.status === 'Completed').length;
  const pendingReviews = totalReviews - completedReviews;
  const avgOverallScore = totalReviews ? Math.round(reviews.reduce((t, r) => t + r.overallScore, 0) / totalReviews) : 0;

  const departmentProgress = departmentProgressFor(month, scoped ? scopeDeptNames : null);
  const employeeProgress = employeeProgressList(month, scoped ? scopeDeptNames : null);
  const avgProgressScore = employeeProgress.length ? Math.round(employeeProgress.reduce((s, e) => s + e.overall, 0) / employeeProgress.length) : 0;
  // A scoped supervisor's own standing blends their personal target progress with their
  // department's average this month — completing targets (their own, or their team's) directly
  // improves this number, which is the point: "when targets are completed, the TL/STL's own
  // department-wise progress improves too," not just the raw employee's.
  let mySupervisorProgress = null;
  if (scoped) {
    const me = myEmployee(req.user.sub);
    const myTargets = me ? db.prepare('SELECT progress_pct, status FROM performance_reviews WHERE employee_id = ? AND month = ?').all(me.id, month) : [];
    const personalAvgProgress = myTargets.length ? Math.round(myTargets.reduce((s, t) => s + t.progress_pct, 0) / myTargets.length) : 0;
    const departmentAvgProgress = departmentProgress.length ? Math.round(departmentProgress.reduce((s, d) => s + d.avgProgress, 0) / departmentProgress.length) : 0;
    mySupervisorProgress = { month, personalAvgProgress, departmentAvgProgress, combined: Math.round((personalAvgProgress + departmentAvgProgress) / 2) };
  }

  res.json({
    banner: scoped ? 'Team/organization performance — view your assigned department(s)/team(s) only; no create, edit, or approval actions here.' : SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Total Reviews', value: totalReviews, color: 'blue' },
      { label: 'Pending Reviews', value: pendingReviews, color: 'gold' },
      { label: 'Completed Reviews', value: completedReviews, color: 'green' },
      { label: 'Average Performance Score', value: totalReviews ? `${avgOverallScore}/100` : '—', color: 'blue' },
      { label: 'Average Progress Score', value: employeeProgress.length ? `${avgProgressScore}%` : '—', color: 'green' }
    ],
    month,
    departmentProgress,
    employeeProgress,
    mySupervisorProgress,
    reviews,
    fieldAccess: FIELD_ACCESS
  });
});

// Self-service: an employee's own reviews (for the Self-Appraisal feature), plus their own
// attendance and this-month target-completion standing (out of their department's configured
// targets-per-month policy).
router.get('/my-reviews', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ reviews: [], attendance: null, thisMonthTargets: { assigned: 0, completed: 0, target: DEFAULT_TARGETS_PER_MONTH }, progressScore: null });
  sendPendingAssessmentReminders();
  const reviews = db.prepare('SELECT * FROM performance_reviews WHERE employee_id = ? ORDER BY created_at DESC').all(me.id).map(withFeedback);
  const month = currentMonth();
  const thisMonth = reviews.filter((r) => r.month === month);
  const dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(me.department);
  res.json({
    reviews,
    attendance: monthlyAttendanceSummary(me.id, month),
    thisMonthTargets: { assigned: thisMonth.length, completed: thisMonth.filter(isTargetComplete).length, target: targetsPerMonthFor(dept?.id) },
    progressScore: progressScoreFor(me.id, month)
  });
});

// Single-review detail, used by the dedicated Appraisal / 360° Feedback / Competency / Plan screens.
router.get('/reviews/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  res.json({ review: withFeedback(review) });
});

// Goal Assignment & Tracking: create a new goal/target (employee, goal text, due date, and the
// calendar month it's a target for). Monthly target count is capped per the employee's
// department (department_target_policies, Super-Admin-configurable — see /target-policy below;
// defaults to 4 for any department without an explicit override), enforced here rather than a DB
// constraint, matching how other soft business rules (e.g. Leave's notice period) are validated.
router.post('/reviews', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, employee_name, team, goal_text, kpi_text, due_date, month, target_value, unit } = req.body || {};
  if (!employee_name || !goal_text) return res.status(400).json({ error: 'employee_name and goal_text are required' });
  const emp = employee_id ? db.prepare('SELECT id, department FROM employees WHERE id = ?').get(employee_id) : null;
  const targetMonth = /^\d{4}-\d{2}$/.test(month) ? month : currentMonth();
  if (emp) {
    const dept = db.prepare('SELECT id FROM departments WHERE name = ?').get(emp.department);
    const cap = targetsPerMonthFor(dept?.id);
    const existing = db.prepare('SELECT COUNT(*) AS c FROM performance_reviews WHERE employee_id = ? AND month = ?').get(emp.id, targetMonth).c;
    if (existing >= cap) return res.status(400).json({ error: `${employee_name.trim()} already has ${cap} target${cap === 1 ? '' : 's'} set for ${targetMonth} — that's ${emp.department || 'their department'}'s monthly limit.` });
  }
  // A measurable target (e.g. "20 deals") starts at 0 achieved, not blank — so its progress bar
  // reads 0% from the start instead of falling back to the legacy manual-percent path.
  const targetVal = target_value !== undefined && target_value !== '' ? Number(target_value) : null;
  const info = db.prepare(`
    INSERT INTO performance_reviews (employee_id, employee_name, team, goal_text, kpi_text, due_date, month, target_value, achieved_value, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(emp ? emp.id : null, employee_name.trim(), team || null, goal_text.trim(), kpi_text || null, due_date || null, targetMonth,
    Number.isFinite(targetVal) ? targetVal : null, Number.isFinite(targetVal) ? 0 : null, unit?.trim() || null);
  res.status(201).json({ review: db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(info.lastInsertRowid) });
});

// Goal Assignment & Tracking / KPI-KRA-OKR Management: edit the goal + KPI text + due date.
router.put('/reviews/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const { goal_text, kpi_text, team, due_date } = req.body || {};
  db.prepare('UPDATE performance_reviews SET goal_text = COALESCE(?, goal_text), kpi_text = COALESCE(?, kpi_text), team = COALESCE(?, team), due_date = COALESCE(?, due_date) WHERE id = ?')
    .run(goal_text?.trim() || null, kpi_text ?? null, team ?? null, due_date ?? null, req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Goal Assignment & Tracking: update progress. A measurable target (target_value set) is driven
// by achieved_value — progress_pct is computed from it, not typed in, so it's a real number
// instead of a guess. A qualitative goal (no target_value) keeps the old manual progress_pct entry.
router.put('/reviews/:id/progress', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.target_value != null) {
    const achieved = Math.max(0, Number(req.body?.achieved_value) || 0);
    const pct = review.target_value > 0 ? Math.round(Math.min(achieved / review.target_value, 1) * 100) : 0;
    db.prepare('UPDATE performance_reviews SET achieved_value = ?, progress_pct = ? WHERE id = ?').run(achieved, pct, req.params.id);
  } else {
    const pct = Math.max(0, Math.min(100, parseInt(req.body?.progress_pct, 10) || 0));
    db.prepare('UPDATE performance_reviews SET progress_pct = ? WHERE id = ?').run(pct, req.params.id);
  }
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Self-Appraisal: HR/manager, or the employee whose review this is, can submit it.
router.put('/reviews/:id/self-assessment', (req, res) => {
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && (!me || me.id !== review.employee_id)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare("UPDATE performance_reviews SET self_assessment_status = 'Submitted' WHERE id = ?").run(req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Performance Reviews & Appraisals: the manager's write-up (achievements this cycle, areas
// for development) plus the 1-5 rating.
router.put('/reviews/:id/manager-assessment', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const rating = req.body?.rating != null ? Math.max(1, Math.min(5, parseInt(req.body.rating, 10) || 1)) : review.rating;
  const achievements = req.body?.achievements_text !== undefined ? (req.body.achievements_text?.trim() || null) : review.achievements_text;
  const development = req.body?.development_areas !== undefined ? (req.body.development_areas?.trim() || null) : review.development_areas;
  db.prepare("UPDATE performance_reviews SET manager_assessment_status = 'Submitted', rating = ?, achievements_text = ?, development_areas = ? WHERE id = ?")
    .run(rating, achievements, development, req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// 360° & Continuous Feedback: an append-only note thread on a review, labeled by relationship
// to the reviewee (Manager / Peer / Self).
router.post('/reviews/:id/feedback', (req, res) => {
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const note = req.body?.note?.trim();
  if (!note) return res.status(400).json({ error: 'note is required' });
  const authorType = ['Manager', 'Peer', 'Self', 'Other'].includes(req.body?.author_type) ? req.body.author_type : 'Other';
  db.prepare('INSERT INTO performance_feedback (review_id, author_name, author_type, note) VALUES (?, ?, ?, ?)').run(review.id, req.user.name || 'Anonymous', authorType, note);
  res.status(201).json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Competency & Skill Gap Assessment: free-text notes on a review.
router.put('/reviews/:id/competency', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  db.prepare('UPDATE performance_reviews SET competency_notes = ? WHERE id = ?').run(req.body?.notes?.trim() || null, req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Promotion & Improvement Plans (PIP): flag a review as leading to a promotion or a PIP.
router.put('/reviews/:id/plan', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const planType = ['None', 'Promotion', 'PIP'].includes(req.body?.plan_type) ? req.body.plan_type : 'None';
  db.prepare('UPDATE performance_reviews SET plan_type = ? WHERE id = ?').run(planType, req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Company rule: a review cannot be marked complete until both self- and manager-assessment
// are submitted (see the Super Admin banner above).
router.put('/reviews/:id/complete', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.self_assessment_status !== 'Submitted' || review.manager_assessment_status !== 'Submitted') {
    return res.status(400).json({ error: 'Both self- and manager-assessment must be submitted before this review can be marked complete.' });
  }
  db.prepare("UPDATE performance_reviews SET status = 'Completed' WHERE id = ?").run(req.params.id);
  res.json({ review: withFeedback(db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id)) });
});

// Performance Reports & Analytics: by-team averages, status split, rating distribution.
router.get('/reports', (req, res) => {
  if (!canViewPerformance(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  let reviews = db.prepare(`
    SELECT pr.*, e.department AS employee_department
    FROM performance_reviews pr LEFT JOIN employees e ON e.id = pr.employee_id
  `).all();
  if (scoped) reviews = reviews.filter((r) => r.employee_department && scopeDeptNames.has(r.employee_department));

  const byTeam = {};
  reviews.forEach((r) => {
    const key = r.team || 'Unassigned';
    byTeam[key] = byTeam[key] || { team: key, count: 0, ratingSum: 0, ratingCount: 0 };
    byTeam[key].count++;
    if (r.rating != null) { byTeam[key].ratingSum += r.rating; byTeam[key].ratingCount++; }
  });
  const teamStats = Object.values(byTeam).map((t) => ({
    team: t.team, count: t.count, avgRating: t.ratingCount ? Math.round((t.ratingSum / t.ratingCount) * 10) / 10 : null
  }));

  const distribution = [1, 2, 3, 4, 5].map((n) => ({ rating: n, count: reviews.filter((r) => r.rating === n).length }));
  const planCounts = { Promotion: reviews.filter((r) => r.plan_type === 'Promotion').length, PIP: reviews.filter((r) => r.plan_type === 'PIP').length };
  const statusCounts = { 'In Progress': reviews.filter((r) => r.status === 'In Progress').length, Completed: reviews.filter((r) => r.status === 'Completed').length };

  res.json({ teamStats, distribution, planCounts, statusCounts });
});

// --- Target Policy: how many monthly targets each department gets. Readable by any HR-tier/
// scoped role (same as /overview), editable by Super Admin only — matches Payroll's CTC Split
// Settings and Leave's notice-period pattern (a single company-wide default, overridable per
// department instead of per-employee).
router.get('/target-policy', (req, res) => {
  if (!canViewPerformance(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  let departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
  if (scoped) departments = departments.filter((d) => scopeDeptNames.has(d.name));
  res.json({
    defaultTargetsPerMonth: DEFAULT_TARGETS_PER_MONTH,
    departments: departments.map((d) => ({ department_id: d.id, department: d.name, targets_per_month: targetsPerMonthFor(d.id) }))
  });
});

router.put('/target-policy/:departmentId', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change target policy' });
  const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(req.params.departmentId);
  if (!dept) return res.status(404).json({ error: 'Department not found' });
  const n = parseInt(req.body?.targets_per_month, 10);
  if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'targets_per_month must be a positive number' });
  db.prepare(`
    INSERT INTO department_target_policies (department_id, targets_per_month, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(department_id) DO UPDATE SET targets_per_month = excluded.targets_per_month, updated_at = excluded.updated_at
  `).run(dept.id, n);
  res.json({ department_id: dept.id, department: dept.name, targets_per_month: n });
});

export default router;

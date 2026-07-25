import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const SCOPE_BANNER = {
  super_admin: 'Full Access — configure performance cycles, KPIs/KRAs/OKRs, appraisal templates, rating scales; approve final ratings. Rule: a review cannot be marked complete until both self- and manager-assessment are submitted.',
  hr_admin: 'Company-wide performance — configure cycles and templates, review ratings.',
  manager: 'Team/organization performance — submit manager assessments, mark reviews complete.',
  assistant_manager: 'Team/organization performance — submit manager assessments, mark reviews complete.'
};

const KEY_FEATURES = [
  { key: 'goals', label: 'Goal Assignment & Tracking', screen: 'goals' },
  { key: 'kpi', label: 'KPI / KRA / OKR Management', screen: 'goals' },
  { key: 'reviews', label: 'Performance Reviews & Appraisals', screen: 'dashboard' },
  { key: 'self', label: 'Self-Appraisal', screen: 'dashboard' },
  { key: 'feedback', label: '360° & Continuous Feedback', screen: 'dashboard' },
  { key: 'competency', label: 'Competency & Skill Gap Assessment', screen: 'dashboard' },
  { key: 'plan', label: 'Promotion & Improvement Plans (PIP)', screen: 'dashboard' },
  { key: 'reports', label: 'Performance Reports & Analytics', screen: 'reports' }
];
const FIELD_ACCESS = [
  { field: 'Record Owner / Assigned-To', access: 'Editable' },
  { field: 'Internal Notes / Remarks', access: 'Editable' }
];

function withFeedback(review) {
  const feedback = db.prepare('SELECT * FROM performance_feedback WHERE review_id = ? ORDER BY created_at DESC').all(review.id);
  return { ...review, feedback };
}

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const reviews = db.prepare("SELECT * FROM performance_reviews ORDER BY (status = 'Completed'), created_at DESC").all().map(withFeedback);
  const inProgress = reviews.filter((r) => r.status === 'In Progress').length;
  const rated = reviews.filter((r) => r.rating != null);
  const avgRating = rated.length ? Math.round((rated.reduce((t, r) => t + r.rating, 0) / rated.length) * 10) / 10 : 0;

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Reviews In Progress', value: inProgress, color: 'blue' },
      { label: 'Avg Rating (Org)', value: avgRating, color: 'green' }
    ],
    reviews,
    keyFeatures: KEY_FEATURES,
    fieldAccess: FIELD_ACCESS
  });
});

// Self-service: an employee's own reviews (for the Self-Appraisal feature).
router.get('/my-reviews', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ reviews: [] });
  const reviews = db.prepare('SELECT * FROM performance_reviews WHERE employee_id = ? ORDER BY created_at DESC').all(me.id).map(withFeedback);
  res.json({ reviews });
});

// Single-review detail, used by the dedicated Appraisal / 360° Feedback / Competency / Plan screens.
router.get('/reviews/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  res.json({ review: withFeedback(review) });
});

// Goal Assignment & Tracking: create a new goal (employee, goal text, due date).
router.post('/reviews', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, employee_name, team, goal_text, kpi_text, due_date } = req.body || {};
  if (!employee_name || !goal_text) return res.status(400).json({ error: 'employee_name and goal_text are required' });
  const emp = employee_id ? db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id) : null;
  const info = db.prepare('INSERT INTO performance_reviews (employee_id, employee_name, team, goal_text, kpi_text, due_date) VALUES (?, ?, ?, ?, ?, ?)')
    .run(emp ? emp.id : null, employee_name.trim(), team || null, goal_text.trim(), kpi_text || null, due_date || null);
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

// Goal Assignment & Tracking: update just the progress bar.
router.put('/reviews/:id/progress', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const pct = Math.max(0, Math.min(100, parseInt(req.body?.progress_pct, 10) || 0));
  db.prepare('UPDATE performance_reviews SET progress_pct = ? WHERE id = ?').run(pct, req.params.id);
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
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const reviews = db.prepare('SELECT * FROM performance_reviews').all();

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

export default router;

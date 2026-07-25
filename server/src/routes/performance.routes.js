import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

const SCOPE_BANNER = {
  super_admin: 'Full Access — configure performance cycles, KPIs/KRAs/OKRs, appraisal templates, rating scales; approve final ratings. Rule: a review cannot be marked complete until both self- and manager-assessment are submitted.',
  hr_admin: 'Company-wide performance — configure cycles and templates, review ratings.',
  manager: 'Team/organization performance — submit manager assessments, mark reviews complete.',
  assistant_manager: 'Team/organization performance — submit manager assessments, mark reviews complete.'
};

const KEY_FEATURES = [
  'Goal Assignment & Tracking', 'KPI / KRA / OKR Management', 'Performance Reviews & Appraisals', 'Self-Appraisal',
  '360° & Continuous Feedback', 'Competency & Skill Gap Assessment', 'Promotion & Improvement Plans (PIP)', 'Performance Reports & Analytics'
];
const FIELD_ACCESS = [
  { field: 'Record Owner / Assigned-To', access: 'Editable' },
  { field: 'Internal Notes / Remarks', access: 'Editable' }
];

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const reviews = db.prepare("SELECT * FROM performance_reviews ORDER BY (status = 'Completed'), created_at DESC").all();
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

router.post('/reviews', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_name, team, goal_text, kpi_text } = req.body || {};
  if (!employee_name || !goal_text) return res.status(400).json({ error: 'employee_name and goal_text are required' });
  const info = db.prepare('INSERT INTO performance_reviews (employee_name, team, goal_text, kpi_text) VALUES (?, ?, ?, ?)')
    .run(employee_name.trim(), team || null, goal_text.trim(), kpi_text || null);
  res.status(201).json({ review: db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/reviews/:id/self-assessment', (req, res) => {
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  db.prepare("UPDATE performance_reviews SET self_assessment_status = 'Submitted' WHERE id = ?").run(req.params.id);
  res.json({ review: db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id) });
});

router.put('/reviews/:id/manager-assessment', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const review = db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  const rating = req.body?.rating != null ? Math.max(1, Math.min(5, parseInt(req.body.rating, 10) || 1)) : review.rating;
  db.prepare("UPDATE performance_reviews SET manager_assessment_status = 'Submitted', rating = ? WHERE id = ?").run(rating, req.params.id);
  res.json({ review: db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id) });
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
  res.json({ review: db.prepare('SELECT * FROM performance_reviews WHERE id = ?').get(req.params.id) });
});

export default router;

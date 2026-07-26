import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '16' (Employee Engagement Surveys).
const isHR = (role) => canModuleAdmin(role, '16');
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function questionsOf(surveyId) {
  return db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order').all(surveyId);
}

// HR: every survey with response counts.
router.get('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const surveys = db.prepare('SELECT * FROM surveys ORDER BY created_at DESC').all().map((s) => ({
    ...s,
    questions: questionsOf(s.id),
    responseCount: db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?').get(s.id).c
  }));
  res.json({ surveys });
});

router.post('/', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, description, questions } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  const qs = Array.isArray(questions) ? questions.filter((q) => q?.trim()) : [];
  if (qs.length === 0) return res.status(400).json({ error: 'At least one question is required' });
  const info = db.prepare('INSERT INTO surveys (title, description) VALUES (?, ?)').run(title.trim(), description || null);
  const insQ = db.prepare('INSERT INTO survey_questions (survey_id, question_text, sort_order) VALUES (?, ?, ?)');
  qs.forEach((q, i) => insQ.run(info.lastInsertRowid, q.trim(), i));
  res.status(201).json({ survey: { ...db.prepare('SELECT * FROM surveys WHERE id = ?').get(info.lastInsertRowid), questions: questionsOf(info.lastInsertRowid) } });
});

// Activate / close a survey.
router.put('/:id', (req, res) => {
  // Feature-level gate: this is exactly the 'Activate / Deactivate Survey' feature.
  if (!canFeatureAction(req.user.role, '16', 'Activate / Deactivate Survey', 'Manage')) return res.status(403).json({ error: 'Insufficient permissions' });
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  const status = ['Draft', 'Active', 'Closed'].includes(req.body?.status) ? req.body.status : survey.status;
  db.prepare('UPDATE surveys SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ survey: db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id) });
});

// HR: aggregated per-question average rating + all free-text comments.
router.get('/:id/results', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey) return res.status(404).json({ error: 'Survey not found' });
  const questions = questionsOf(survey.id).map((q) => {
    const answers = db.prepare('SELECT rating FROM survey_answers WHERE question_id = ?').all(q.id);
    const avg = answers.length ? Math.round((answers.reduce((t, a) => t + a.rating, 0) / answers.length) * 10) / 10 : null;
    return { ...q, avgRating: avg, responseCount: answers.length };
  });
  const comments = db.prepare('SELECT comment, submitted_at FROM survey_responses WHERE survey_id = ? AND comment IS NOT NULL').all(survey.id);
  res.json({ survey, questions, comments, totalResponses: db.prepare('SELECT COUNT(*) c FROM survey_responses WHERE survey_id = ?').get(survey.id).c });
});

// Employee: surveys currently open for them (active, not yet answered) and ones they answered.
router.get('/active', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ surveys: [] });
  const all = db.prepare("SELECT * FROM surveys WHERE status = 'Active' ORDER BY created_at DESC").all();
  const surveys = all.map((s) => ({
    ...s,
    questions: questionsOf(s.id),
    answered: !!db.prepare('SELECT 1 FROM survey_responses WHERE survey_id = ? AND employee_id = ?').get(s.id, me.id)
  }));
  res.json({ surveys });
});

router.post('/:id/respond', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const survey = db.prepare('SELECT * FROM surveys WHERE id = ?').get(req.params.id);
  if (!survey || survey.status !== 'Active') return res.status(400).json({ error: 'This survey is not currently open.' });
  if (db.prepare('SELECT 1 FROM survey_responses WHERE survey_id = ? AND employee_id = ?').get(survey.id, me.id)) {
    return res.status(409).json({ error: 'You have already responded to this survey.' });
  }
  const { answers, comment } = req.body || {};
  const questions = questionsOf(survey.id);
  if (!Array.isArray(answers) || answers.length !== questions.length) return res.status(400).json({ error: 'An answer for every question is required.' });

  const insertAll = db.transaction(() => {
    const info = db.prepare('INSERT INTO survey_responses (survey_id, employee_id, comment) VALUES (?, ?, ?)').run(survey.id, me.id, comment?.trim() || null);
    const insA = db.prepare('INSERT INTO survey_answers (response_id, question_id, rating) VALUES (?, ?, ?)');
    answers.forEach((a) => {
      const rating = Math.max(1, Math.min(5, parseInt(a.rating, 10) || 1));
      insA.run(info.lastInsertRowid, a.question_id, rating);
    });
  });
  insertAll();
  res.status(201).json({ ok: true });
});

export default router;

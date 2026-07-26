import { Router } from 'express';
import db, { ONBOARDING_TASK_DEFAULTS, OFFBOARDING_TASK_DEFAULTS } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '05' (Recruitment Management).
const isHR = (role) => canModuleAdmin(role, '05');

const SCOPE_BANNER = {
  super_admin: 'Full Access — create & approve requisitions, manage postings, configure workflow, final hiring approval, onboarding through offboarding.',
  hr_admin: 'Company-wide recruitment — post requisitions, manage the candidate pipeline, onboarding and offboarding.',
  manager: 'Team/organization recruitment — request positions, review candidates, approve requisitions.',
  assistant_manager: 'Team/organization recruitment — review candidates and support onboarding/offboarding.'
};

const KEY_FEATURES = [
  { key: 'requisitions', label: 'Job Requisition Management' },
  { key: 'pipeline', label: 'Candidate Pipeline & Interview Scheduling' },
  { key: 'rounds', label: 'Interview Rounds Configuration' },
  { key: 'onboarding', label: 'Onboarding Checklist' },
  { key: 'offboarding', label: 'Offboarding & Clearance' },
  { key: 'vacancies', label: 'Department-wise Vacancies' }
];

// --- Interview rounds: a dynamic, orderable pipeline (add/edit/pause), replacing the old
// fixed 5-stage list so HR can tailor the process per requisition type.
function activeRounds() { return db.prepare('SELECT * FROM interview_rounds WHERE paused = 0 ORDER BY sort_order').all(); }
function allRounds() { return db.prepare('SELECT * FROM interview_rounds ORDER BY sort_order').all(); }
function nextRound(currentSortOrder) { return db.prepare('SELECT * FROM interview_rounds WHERE paused = 0 AND sort_order > ? ORDER BY sort_order LIMIT 1').get(currentSortOrder); }
function firstRound() { return activeRounds()[0] || null; }

router.get('/interview-rounds', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ rounds: allRounds() });
});

router.post('/interview-rounds', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM interview_rounds').get().m;
  try {
    const info = db.prepare('INSERT INTO interview_rounds (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
    res.status(201).json({ round: db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(info.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'A round with this name already exists' }); }
});

router.put('/interview-rounds/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const round = db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE interview_rounds SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ round: db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id) });
});

router.put('/interview-rounds/:id/pause', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const round = db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  db.prepare('UPDATE interview_rounds SET paused = ? WHERE id = ?').run(req.body?.paused ? 1 : 0, req.params.id);
  res.json({ round: db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id) });
});

function taskProgress(rows) {
  const total = rows.length;
  const completed = rows.filter((t) => t.completed).length;
  return { total, completed, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const openRequisitions = db.prepare("SELECT COUNT(*) c FROM positions WHERE status = 'Open' AND approval_status != 'Rejected'").get().c;
  const activeCandidates = db.prepare(`
    SELECT COUNT(*) c FROM candidates cd JOIN interview_rounds r ON r.id = cd.round_id WHERE r.is_final = 0
  `).get().c;
  const offersPending = db.prepare(`
    SELECT COUNT(*) c FROM candidates cd JOIN interview_rounds r ON r.id = cd.round_id WHERE r.name = 'Offer'
  `).get().c;
  const onboardingInProgress = db.prepare('SELECT COUNT(*) c FROM new_hires WHERE onboarding_pct < 100').get().c;
  const exiting = db.prepare("SELECT COUNT(*) c FROM exits WHERE status = 'Serving Notice'").get().c;

  const requisitions = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.approval_status != 'Rejected'
    ORDER BY p.approval_status = 'Pending Approval' DESC, p.created_at DESC
  `).all();

  const candidates = db.prepare(`
    SELECT cd.*, p.title AS position_title, r.name AS stage, r.sort_order AS stage_sort_order, r.is_final
    FROM candidates cd LEFT JOIN positions p ON p.id = cd.position_id LEFT JOIN interview_rounds r ON r.id = cd.round_id
    ORDER BY cd.created_at DESC
  `).all().map((c) => {
    const next = c.is_final ? null : nextRound(c.stage_sort_order);
    return { ...c, next_stage: next ? next.name : null };
  });

  const newHires = db.prepare('SELECT * FROM new_hires ORDER BY start_date').all().map((h) => {
    const tasks = db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ? ORDER BY sort_order').all(h.id);
    return { ...h, tasks, progress: taskProgress(tasks) };
  });
  const exits = db.prepare("SELECT * FROM exits WHERE status = 'Serving Notice' ORDER BY last_working_day").all().map((x) => {
    const tasks = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ? ORDER BY sort_order').all(x.id);
    return { ...x, tasks, progress: taskProgress(tasks) };
  });

  const departments = db.prepare('SELECT * FROM departments').all();
  const vacancies = departments.map((dept) => {
    const current = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE department = ? AND status = 'Active'").get(dept.name).c;
    const openVacancies = db.prepare("SELECT COALESCE(SUM(target_headcount), 0) AS c FROM positions WHERE department_id = ? AND status = 'Open' AND approval_status != 'Rejected'").get(dept.id).c;
    return { department_id: dept.id, department: dept.name, current, vacancies: openVacancies, target: current + openVacancies };
  }).filter((d) => d.vacancies > 0 || d.current > 0);

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Open Requisitions', value: openRequisitions, color: 'blue' },
      { label: 'Active Candidates', value: activeCandidates, color: 'blue' },
      { label: 'Offers Pending', value: offersPending, color: 'gold' },
      { label: 'Onboarding In Progress', value: onboardingInProgress, color: 'green' },
      { label: 'Exiting Employees', value: exiting, color: 'red' }
    ],
    requisitions,
    candidates,
    interviewRounds: allRounds(),
    newHires,
    exits,
    vacancies,
    keyFeatures: KEY_FEATURES
  });
});

router.post('/candidates', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, position_id, panel } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const start = firstRound();
  const info = db.prepare('INSERT INTO candidates (name, position_id, panel, round_id) VALUES (?, ?, ?, ?)')
    .run(name.trim(), position_id || null, panel || null, start ? start.id : null);
  res.status(201).json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid) });
});

// Advances a candidate to the next active round in the (dynamic, HR-configurable) pipeline.
router.put('/candidates/:id/advance', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const current = candidate.round_id ? db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(candidate.round_id) : null;
  if (current?.is_final) return res.status(400).json({ error: 'Candidate has already reached the final round.' });
  const next = nextRound(current ? current.sort_order : -1);
  if (!next) return res.status(400).json({ error: 'No further round is configured.' });
  db.prepare("UPDATE candidates SET round_id = ?, feedback_status = 'No feedback yet' WHERE id = ?").run(next.id, req.params.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) });
});

router.put('/candidates/:id/feedback', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  db.prepare("UPDATE candidates SET feedback_status = 'Feedback submitted' WHERE id = ?").run(req.params.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) });
});

router.post('/new-hires', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, designation, department, start_date } = req.body || {};
  if (!name || !start_date) return res.status(400).json({ error: 'name and start_date are required' });
  const info = db.prepare('INSERT INTO new_hires (name, designation, department, start_date) VALUES (?, ?, ?, ?)')
    .run(name.trim(), designation || null, department || null, start_date);
  const insTask = db.prepare('INSERT INTO onboarding_tasks (new_hire_id, task_name, sort_order) VALUES (?, ?, ?)');
  ONBOARDING_TASK_DEFAULTS.forEach((t, i) => insTask.run(info.lastInsertRowid, t, i));
  res.status(201).json({ newHire: db.prepare('SELECT * FROM new_hires WHERE id = ?').get(info.lastInsertRowid) });
});

// Toggles one onboarding responsibility; recomputes the overall onboarding_pct from the checklist.
router.put('/new-hires/:id/tasks/:taskId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const task = db.prepare('SELECT * FROM onboarding_tasks WHERE id = ? AND new_hire_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('UPDATE onboarding_tasks SET completed = ? WHERE id = ?').run(req.body?.completed ? 1 : 0, task.id);
  const tasks = db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ?').all(req.params.id);
  const { pct } = taskProgress(tasks);
  db.prepare('UPDATE new_hires SET onboarding_pct = ? WHERE id = ?').run(pct, req.params.id);
  res.json({ newHire: db.prepare('SELECT * FROM new_hires WHERE id = ?').get(req.params.id), tasks });
});

router.post('/exits', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, last_working_day } = req.body || {};
  const emp = employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) : null;
  if (!emp) return res.status(400).json({ error: 'A valid employee_id is required' });
  if (!last_working_day) return res.status(400).json({ error: 'last_working_day is required' });
  const total = OFFBOARDING_TASK_DEFAULTS.length;
  const info = db.prepare('INSERT INTO exits (employee_id, name, department, last_working_day, clearance_total) VALUES (?, ?, ?, ?, ?)')
    .run(emp.id, emp.name, emp.department, last_working_day, total);
  const insTask = db.prepare('INSERT INTO offboarding_tasks (exit_id, task_name, sort_order) VALUES (?, ?, ?)');
  OFFBOARDING_TASK_DEFAULTS.forEach((t, i) => insTask.run(info.lastInsertRowid, t, i));
  res.status(201).json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(info.lastInsertRowid) });
});

// Toggles one offboarding responsibility; recomputes clearance count and auto-marks Cleared.
router.put('/exits/:id/tasks/:taskId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const task = db.prepare('SELECT * FROM offboarding_tasks WHERE id = ? AND exit_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('UPDATE offboarding_tasks SET completed = ? WHERE id = ?').run(req.body?.completed ? 1 : 0, task.id);
  const tasks = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ?').all(req.params.id);
  const { total, completed } = taskProgress(tasks);
  const status = completed >= total ? 'Cleared' : 'Serving Notice';
  db.prepare('UPDATE exits SET clearance_current = ?, clearance_total = ?, status = ? WHERE id = ?').run(completed, total, status, req.params.id);
  res.json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(req.params.id), tasks });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

const SCOPE_BANNER = {
  super_admin: 'Full Access — create & approve requisitions, manage postings, configure workflow, final hiring approval, onboarding through offboarding.',
  hr_admin: 'Company-wide recruitment — post requisitions, manage the candidate pipeline, onboarding and offboarding.',
  manager: 'Team/organization recruitment — request positions, review candidates, approve requisitions.',
  assistant_manager: 'Team/organization recruitment — review candidates and support onboarding/offboarding.'
};

const STAGE_ORDER = ['Resume Screening', 'Technical Interview', 'HR Interview', 'Offer', 'Hired'];

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });

  const openRequisitions = db.prepare("SELECT COUNT(*) c FROM positions WHERE status = 'Open' AND approval_status != 'Rejected'").get().c;
  const activeCandidates = db.prepare("SELECT COUNT(*) c FROM candidates WHERE stage != 'Hired'").get().c;
  const offersPending = db.prepare("SELECT COUNT(*) c FROM candidates WHERE stage = 'Offer'").get().c;
  const onboardingInProgress = db.prepare('SELECT COUNT(*) c FROM new_hires WHERE onboarding_pct < 100').get().c;
  const exiting = db.prepare("SELECT COUNT(*) c FROM exits WHERE status = 'Serving Notice'").get().c;

  const requisitions = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.approval_status != 'Rejected'
    ORDER BY p.approval_status = 'Pending Approval' DESC, p.created_at DESC
  `).all();

  const candidates = db.prepare(`
    SELECT c.*, p.title AS position_title
    FROM candidates c LEFT JOIN positions p ON p.id = c.position_id
    ORDER BY c.created_at DESC
  `).all().map((c) => ({ ...c, next_stage: STAGE_ORDER[STAGE_ORDER.indexOf(c.stage) + 1] || null }));

  const newHires = db.prepare('SELECT * FROM new_hires ORDER BY start_date').all();
  const exits = db.prepare("SELECT * FROM exits WHERE status = 'Serving Notice' ORDER BY last_working_day").all();

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
    newHires,
    exits,
    vacancies
  });
});

router.post('/candidates', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, position_id, panel } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO candidates (name, position_id, panel) VALUES (?, ?, ?)').run(name.trim(), position_id || null, panel || null);
  res.status(201).json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid) });
});

// Advances a candidate to the next stage in the fixed pipeline (or marks Hired at the end).
router.put('/candidates/:id/advance', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const next = STAGE_ORDER[STAGE_ORDER.indexOf(candidate.stage) + 1];
  if (!next) return res.status(400).json({ error: 'Candidate is already Hired.' });
  db.prepare("UPDATE candidates SET stage = ?, feedback_status = 'No feedback yet' WHERE id = ?").run(next, req.params.id);
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
  res.status(201).json({ newHire: db.prepare('SELECT * FROM new_hires WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/new-hires/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const hire = db.prepare('SELECT * FROM new_hires WHERE id = ?').get(req.params.id);
  if (!hire) return res.status(404).json({ error: 'New hire not found' });
  const pct = Math.max(0, Math.min(100, parseInt(req.body?.onboarding_pct, 10) || 0));
  db.prepare('UPDATE new_hires SET onboarding_pct = ? WHERE id = ?').run(pct, req.params.id);
  res.json({ newHire: db.prepare('SELECT * FROM new_hires WHERE id = ?').get(req.params.id) });
});

router.post('/exits', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, last_working_day, clearance_total } = req.body || {};
  const emp = employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id) : null;
  if (!emp) return res.status(400).json({ error: 'A valid employee_id is required' });
  if (!last_working_day) return res.status(400).json({ error: 'last_working_day is required' });
  const total = Math.max(1, parseInt(clearance_total, 10) || 4);
  const info = db.prepare('INSERT INTO exits (employee_id, name, department, last_working_day, clearance_total) VALUES (?, ?, ?, ?, ?)')
    .run(emp.id, emp.name, emp.department, last_working_day, total);
  res.status(201).json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(info.lastInsertRowid) });
});

// Bumps the clearance checklist by one step; auto-marks Cleared once every step is done.
router.put('/exits/:id/clearance', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const exit = db.prepare('SELECT * FROM exits WHERE id = ?').get(req.params.id);
  if (!exit) return res.status(404).json({ error: 'Exit record not found' });
  const next = Math.min(exit.clearance_total, exit.clearance_current + 1);
  const status = next >= exit.clearance_total ? 'Cleared' : 'Serving Notice';
  db.prepare('UPDATE exits SET clearance_current = ?, status = ? WHERE id = ?').run(next, status, req.params.id);
  res.json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(req.params.id) });
});

export default router;

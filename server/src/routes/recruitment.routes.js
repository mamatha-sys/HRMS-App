import { Router } from 'express';
import db, { ONBOARDING_TASK_DEFAULTS, OFFBOARDING_TASK_DEFAULTS } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, filterToScope, scopeDepartmentNames } from '../utils/scope.js';
import { autoCompleteOnboardingTask, recomputeOnboardingPct } from '../utils/onboarding.js';
import { recomputeOffboardingClearance } from '../utils/offboarding.js';
import { sendEmail, sendWhatsapp } from '../utils/channels.js';

const router = Router();
router.use(requireAuth);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

// Dynamic RBAC via Manage Roles — module '05' (Recruitment Management). A Senior Team Lead/
// Team Lead/Assistant Manager also passes — but ONLY for the read-only /overview below, which
// explicitly scopes every list it returns; every write endpoint in this file (create/advance/
// add-hire/toggle-task/add-exit/interview-round management) still checks canModuleAdmin
// directly, so scoped roles stay view-only here, matching Super Admin policy.
const isHR = (role) => canModuleAdmin(role, '05');
const canViewRecruitment = (role) => canModuleAdmin(role, '05') || isScopedRole(role);

// Company-wide standard notice period, in days — used to auto-suggest Last Working Day when a
// resignation/exit is created (today + this many days), editable by Super Admin. Reuses the
// `policies` table (category 'setting'), same pattern as Payroll's CTC split % and Attendance's
// free-late-allowance policy. Missing row = the 45-day default this company actually runs on.
const NOTICE_PERIOD_POLICY_NAME = 'Notice Period (days)';
const NOTICE_PERIOD_DEFAULT_DAYS = 45;
function noticePeriodDays() {
  const row = db.prepare('SELECT value FROM policies WHERE name = ?').get(NOTICE_PERIOD_POLICY_NAME);
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NOTICE_PERIOD_DEFAULT_DAYS;
}

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
function prevRound(currentSortOrder) { return db.prepare('SELECT * FROM interview_rounds WHERE paused = 0 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(currentSortOrder); }
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

router.put('/interview-rounds/:id/pause', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const round = db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  db.prepare('UPDATE interview_rounds SET paused = ? WHERE id = ?').run(req.body?.paused ? 1 : 0, req.params.id);
  res.json({ round: db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(req.params.id) });
});

// --- Candidate sources: where each candidate came from (Referral/Naukri/LinkedIn/etc.) — a
// first-class, filterable catalog instead of overloaded text in candidates.panel. Same
// add/pause shape as interview rounds; read open to any authed user (needed for pipeline
// filters), write gated to isHR.
function activeSources() { return db.prepare('SELECT * FROM candidate_sources WHERE paused = 0 ORDER BY sort_order').all(); }
function allSources() { return db.prepare('SELECT * FROM candidate_sources ORDER BY sort_order').all(); }
function referralSourceId() { return db.prepare("SELECT id FROM candidate_sources WHERE label = 'Referral'").get()?.id || null; }

router.get('/candidate-sources', (req, res) => res.json({ sources: allSources() }));

router.post('/candidate-sources', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { label } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM candidate_sources').get().m;
  try {
    const info = db.prepare('INSERT INTO candidate_sources (label, sort_order) VALUES (?, ?)').run(label.trim(), maxOrder + 1);
    res.status(201).json({ source: db.prepare('SELECT * FROM candidate_sources WHERE id = ?').get(info.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'A source with this name already exists' }); }
});

router.put('/candidate-sources/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const source = db.prepare('SELECT * FROM candidate_sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Source not found' });
  if (source.label === 'Referral' && req.body?.paused) {
    return res.status(400).json({ error: '"Referral" is used automatically for employee referrals and cannot be paused.' });
  }
  db.prepare('UPDATE candidate_sources SET paused = ? WHERE id = ?').run(req.body?.paused ? 1 : 0, req.params.id);
  res.json({ source: db.prepare('SELECT * FROM candidate_sources WHERE id = ?').get(req.params.id) });
});

// --- Notice period: read by any authed user (both the self-service resignation form and HR's
// Add Exit form need it to suggest a Last Working Day), edited by Super Admin only ---
router.get('/notice-period', (req, res) => res.json({ days: noticePeriodDays() }));

router.put('/notice-period', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Only a Super Admin can change the notice period' });
  const days = parseInt(req.body?.days, 10);
  if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: 'A valid number of days is required' });
  const existing = db.prepare('SELECT id FROM policies WHERE name = ?').get(NOTICE_PERIOD_POLICY_NAME);
  if (existing) db.prepare('UPDATE policies SET value = ? WHERE id = ?').run(String(days), existing.id);
  else db.prepare("INSERT INTO policies (category, name, value) VALUES ('setting', ?, ?)").run(NOTICE_PERIOD_POLICY_NAME, String(days));
  res.json({ days: noticePeriodDays() });
});

function taskProgress(rows) {
  const total = rows.length;
  const completed = rows.filter((t) => t.completed).length;
  return { total, completed, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

router.get('/overview', (req, res) => {
  if (!canViewRecruitment(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scope = scoped ? getSupervisorScope(myEmployee(req.user.sub)?.id) : null;
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(scope)) : null;

  let requisitions = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.approval_status != 'Rejected'
    ORDER BY p.approval_status = 'Pending Approval' DESC, p.created_at DESC
  `).all();
  if (scoped) requisitions = requisitions.filter((r) => scopeDeptNames.has(r.department_name));

  let candidates = db.prepare(`
    SELECT cd.*, p.title AS position_title, p.department_id, d.name AS position_department, r.name AS stage, r.sort_order AS stage_sort_order, r.is_final, cs.label AS source_label, ref.name AS referred_by_name
    FROM candidates cd
    LEFT JOIN positions p ON p.id = cd.position_id LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN interview_rounds r ON r.id = cd.round_id LEFT JOIN candidate_sources cs ON cs.id = cd.source_id
    LEFT JOIN employees ref ON ref.id = cd.referred_by_employee_id
    ORDER BY cd.created_at DESC
  `).all().map((c) => {
    const next = c.is_final ? null : nextRound(c.stage_sort_order);
    const prev = c.round_id ? prevRound(c.stage_sort_order) : null;
    return { ...c, next_stage: next ? next.name : null, prev_stage: prev ? prev.name : null };
  });
  // A candidate not yet linked to a requisition can't be attributed to a department — fail
  // closed (hide it) for a scoped role rather than showing an unattributed, unscoped record.
  if (scoped) candidates = candidates.filter((c) => c.position_department && scopeDeptNames.has(c.position_department));

  // Once onboarding hits 100% it stays visible for a 2-day grace period (so HR can still see it
  // just finished), then auto-drops off the list — matches offboarding's "Cleared" rows
  // disappearing, just on a timer instead of a manual status flip.
  let newHires = db.prepare("SELECT * FROM new_hires WHERE completed_at IS NULL OR completed_at >= datetime('now', '-2 days') ORDER BY start_date").all();
  if (scoped) newHires = newHires.filter((h) => h.department && scopeDeptNames.has(h.department));
  newHires = newHires.map((h) => {
    const tasks = db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ? ORDER BY sort_order').all(h.id);
    return { ...h, tasks, progress: taskProgress(tasks) };
  });

  let exits = db.prepare("SELECT * FROM exits WHERE status = 'Serving Notice' ORDER BY last_working_day").all();
  if (scoped) exits = exits.filter((x) => x.department && scopeDeptNames.has(x.department));
  exits = exits.map((x) => {
    const tasks = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ? ORDER BY sort_order').all(x.id);
    // Days left on notice — today vs. Last Working Day. Negative once LWD has passed (still
    // shown so HR can see it's overdue, since the record only leaves this list on 'Cleared').
    const notice_days_remaining = db.prepare("SELECT CAST(julianday(?) - julianday(date('now')) AS INTEGER) AS d").get(x.last_working_day).d;
    return { ...x, tasks, progress: taskProgress(tasks), notice_days_remaining };
  });

  let departments = db.prepare('SELECT * FROM departments').all();
  if (scoped) departments = departments.filter((d) => scopeDeptNames.has(d.name));
  const vacancies = departments.map((dept) => {
    const current = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE department = ? AND status = 'Active'").get(dept.name).c;
    const openVacancies = db.prepare("SELECT COALESCE(SUM(target_headcount), 0) AS c FROM positions WHERE department_id = ? AND status = 'Open' AND approval_status != 'Rejected'").get(dept.id).c;
    // Team-wise current headcount within this department — job requisitions themselves aren't
    // tracked per-team (only per-department), so only "current" splits by team here, not
    // "vacancies". A TL's team-level grant only shows their own team(s); an STL's department-
    // level grant (or any unscoped HR-tier role) sees every team in the department.
    let teams = db.prepare('SELECT id, name FROM teams WHERE department_id = ? ORDER BY name').all(dept.id);
    if (scoped && !scope.departmentNames.includes(dept.name)) teams = teams.filter((t) => scope.teamIds.includes(t.id));
    teams = teams.map((t) => ({ team_id: t.id, name: t.name, current: db.prepare("SELECT COUNT(*) AS c FROM employees WHERE team_id = ? AND status = 'Active'").get(t.id).c }));
    return { department_id: dept.id, department: dept.name, current, vacancies: openVacancies, target: current + openVacancies, teams };
  }).filter((d) => d.vacancies > 0 || d.current > 0);

  res.json({
    banner: scoped ? 'Team/organization recruitment — view your assigned department(s)/team(s), and raise job requisitions for them; candidate/onboarding/offboarding actions stay HR-managed.' : SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Open Requisitions', value: requisitions.filter((r) => r.status === 'Open').length, color: 'blue' },
      { label: 'Active Candidates', value: candidates.filter((c) => !c.is_final).length, color: 'blue' },
      { label: 'Offers Pending', value: candidates.filter((c) => c.stage === 'Offer').length, color: 'gold' },
      { label: 'Onboarding In Progress', value: newHires.filter((h) => h.onboarding_pct < 100).length, color: 'green' },
      { label: 'Exiting Employees', value: exits.length, color: 'red' }
    ],
    requisitions,
    candidates,
    interviewRounds: allRounds(),
    candidateSources: allSources(),
    newHires,
    exits,
    vacancies,
    keyFeatures: KEY_FEATURES
  });
});

const CANDIDATE_PROFILE_FIELDS = ['email', 'phone', 'experience_years', 'current_ctc', 'expected_ctc', 'notice_period', 'resume_data_url', 'resume_name', 'linkedin_url', 'location'];

router.post('/candidates', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, position_id, panel, source_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const validSource = source_id && activeSources().some((s) => s.id === Number(source_id)) ? Number(source_id) : null;
  const start = firstRound();
  const profile = CANDIDATE_PROFILE_FIELDS.map((f) => req.body?.[f]?.toString().trim() || null);
  const info = db.prepare(`
    INSERT INTO candidates (name, position_id, panel, round_id, source_id, ${CANDIDATE_PROFILE_FIELDS.join(', ')})
    VALUES (?, ?, ?, ?, ?, ${CANDIDATE_PROFILE_FIELDS.map(() => '?').join(', ')})
  `).run(name.trim(), position_id || null, panel || null, start ? start.id : null, validSource, ...profile);
  res.status(201).json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid) });
});

// Edit a candidate's own profile fields (contact/experience/compensation/resume/links) — kept
// separate from advance/revert/feedback, which each have their own controlled-transition endpoint.
router.put('/candidates/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const sets = [];
  const values = [];
  CANDIDATE_PROFILE_FIELDS.forEach((f) => {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); values.push(req.body[f]?.toString().trim() || null); }
  });
  if (req.body?.name?.trim()) { sets.push('name = ?'); values.push(req.body.name.trim()); }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
  values.push(req.params.id);
  db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) });
});

// Manual "Send Update" — HR-composed Email/WhatsApp message straight to a candidate. Candidates
// aren't employees, so this calls the channel senders directly with the candidate's own
// email/phone instead of going through dispatchChannels() (which is keyed off employees.email/
// phone and logs to channel_deliveries, a table this doesn't participate in).
router.post('/candidates/:id/message', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const { channel, subject, message } = req.body || {};
  if (!['email', 'whatsapp'].includes(channel)) return res.status(400).json({ error: 'channel must be "email" or "whatsapp"' });
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    if (channel === 'email') {
      if (!candidate.email) throw new Error('This candidate has no email on file');
      await sendEmail(candidate.email, subject?.trim() || 'Update on your application', message.trim());
    } else {
      if (!candidate.phone) throw new Error('This candidate has no phone number on file');
      await sendWhatsapp(candidate.phone, subject?.trim() || 'Update on your application', message.trim());
    }
    res.json({ sent: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// Undoes a mistaken advance — moves the candidate back to the previous active round. Works even
// from the final round (e.g. accidentally moved to Hired), since it just walks sort_order
// backwards one step, same mechanics as advance but in reverse.
router.put('/candidates/:id/revert', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const current = candidate.round_id ? db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(candidate.round_id) : null;
  if (!current) return res.status(400).json({ error: 'Candidate has no current stage to move back from.' });
  const prev = prevRound(current.sort_order);
  if (!prev) return res.status(400).json({ error: 'Already at the first round — nothing to move back to.' });
  db.prepare("UPDATE candidates SET round_id = ?, feedback_status = 'No feedback yet' WHERE id = ?").run(prev.id, req.params.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) });
});

router.put('/candidates/:id/feedback', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  db.prepare("UPDATE candidates SET feedback_status = 'Feedback submitted' WHERE id = ?").run(req.params.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) });
});

// A new-hire onboarding record must link to a real, active employee — required so the checklist
// can actually be driven by real cross-module signals (see server/src/utils/onboarding.js)
// instead of being pure free-typed text with no way to correlate back to anything. Mirrors how
// /exits already requires a real employee_id.
router.post('/new-hires', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, start_date } = req.body || {};
  const emp = employee_id ? db.prepare("SELECT * FROM employees WHERE id = ? AND status = 'Active'").get(employee_id) : null;
  if (!emp) return res.status(400).json({ error: 'A valid, active employee_id is required' });
  if (!start_date) return res.status(400).json({ error: 'start_date is required' });
  if (db.prepare('SELECT id FROM new_hires WHERE employee_id = ? AND completed_at IS NULL').get(emp.id)) {
    return res.status(400).json({ error: 'This employee already has an onboarding checklist in progress.' });
  }
  const info = db.prepare('INSERT INTO new_hires (name, designation, department, start_date, employee_id) VALUES (?, ?, ?, ?, ?)')
    .run(emp.name, emp.designation || null, emp.department || null, start_date, emp.id);
  const insTask = db.prepare('INSERT INTO onboarding_tasks (new_hire_id, task_name, sort_order) VALUES (?, ?, ?)');
  ONBOARDING_TASK_DEFAULTS.forEach((t, i) => insTask.run(info.lastInsertRowid, t, i));

  // If any of the auto-tracked conditions are already true for this employee (e.g. they already
  // have a reporting manager on file from before onboarding was even started), reflect that
  // immediately instead of showing a false "not done yet" checkbox.
  let hasDocs = false;
  try { hasDocs = !!(emp.documents && JSON.parse(emp.documents).length > 0); } catch { hasDocs = false; }
  if (hasDocs) autoCompleteOnboardingTask(emp.id, 'Documents submitted');
  if (emp.reporting_manager?.trim()) autoCompleteOnboardingTask(emp.id, 'Reporting manager assigned');
  if (db.prepare('SELECT id FROM assets WHERE assigned_employee_id = ?').get(emp.id)) autoCompleteOnboardingTask(emp.id, 'Assets assigned');

  res.status(201).json({ newHire: db.prepare('SELECT * FROM new_hires WHERE id = ?').get(info.lastInsertRowid) });
});

// Toggles one onboarding responsibility; recomputes the overall onboarding_pct from the checklist.
router.put('/new-hires/:id/tasks/:taskId', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const task = db.prepare('SELECT * FROM onboarding_tasks WHERE id = ? AND new_hire_id = ?').get(req.params.taskId, req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('UPDATE onboarding_tasks SET completed = ? WHERE id = ?').run(req.body?.completed ? 1 : 0, task.id);
  recomputeOnboardingPct(req.params.id);
  const tasks = db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ?').all(req.params.id);
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
  recomputeOffboardingClearance(req.params.id);
  const tasks = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ?').all(req.params.id);
  res.json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(req.params.id), tasks });
});

// ---------- Employee self-service: Refer a Candidate + Submit Resignation ----------
// Both are plain self-service (no isHR/canModuleAdmin gate) — every employee can refer a
// colleague-of-a-friend for an open position, or submit their own resignation, the same way
// they can already apply for leave or raise an expense claim.

// My own referral count + list, the open positions to refer someone into, and my own
// in-progress resignation (if any).
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ referrals: [], openPositions: [], resignation: null, onboarding: null });
  const referrals = db.prepare(`
    SELECT cd.*, p.title AS position_title, r.name AS stage
    FROM candidates cd LEFT JOIN positions p ON p.id = cd.position_id LEFT JOIN interview_rounds r ON r.id = cd.round_id
    WHERE cd.referred_by_employee_id = ? ORDER BY cd.created_at DESC
  `).all(me.id);
  const openPositions = db.prepare(`
    SELECT p.id, p.title, d.name AS department_name FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.status = 'Open' AND p.approval_status = 'Approved' ORDER BY p.title
  `).all();

  // Read-only view of what's going on with their own onboarding/offboarding — HR still owns
  // ticking these off; the employee just gets to see the same checklist and progress HR sees,
  // so they know exactly what's done and what's still pending on their own hire/exit.
  const myNewHire = db.prepare('SELECT * FROM new_hires WHERE employee_id = ? AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(me.id);
  const onboarding = myNewHire
    ? { ...myNewHire, tasks: db.prepare('SELECT * FROM onboarding_tasks WHERE new_hire_id = ? ORDER BY sort_order').all(myNewHire.id) }
    : null;

  const resignation = db.prepare("SELECT * FROM exits WHERE employee_id = ? AND status = 'Serving Notice' ORDER BY created_at DESC LIMIT 1").get(me.id) || null;
  if (resignation) {
    resignation.tasks = db.prepare('SELECT * FROM offboarding_tasks WHERE exit_id = ? ORDER BY sort_order').all(resignation.id);
    resignation.notice_days_remaining = db.prepare("SELECT CAST(julianday(?) - julianday(date('now')) AS INTEGER) AS d").get(resignation.last_working_day).d;
  }

  res.json({ referrals, openPositions, resignation, onboarding });
});

router.post('/refer', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { name, position_id, contact } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Candidate name is required' });
  const start = firstRound();
  const info = db.prepare('INSERT INTO candidates (name, position_id, panel, round_id, referred_by_employee_id, source_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), position_id || null, contact?.trim() ? `Contact: ${contact.trim()}` : null, start ? start.id : null, me.id, referralSourceId());
  res.status(201).json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid) });
});

// Creates the same kind of record HR's own "Add Exit" does — just self-initiated, with a reason.
router.post('/resign', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { last_working_day, reason } = req.body || {};
  if (!last_working_day) return res.status(400).json({ error: 'Last working day is required' });
  if (db.prepare("SELECT id FROM exits WHERE employee_id = ? AND status = 'Serving Notice'").get(me.id)) {
    return res.status(400).json({ error: 'You already have a resignation in progress.' });
  }
  const total = OFFBOARDING_TASK_DEFAULTS.length;
  const info = db.prepare('INSERT INTO exits (employee_id, name, department, last_working_day, clearance_total, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(me.id, me.name, me.department, last_working_day, total, reason?.trim() || null);
  const insTask = db.prepare('INSERT INTO offboarding_tasks (exit_id, task_name, sort_order) VALUES (?, ?, ?)');
  OFFBOARDING_TASK_DEFAULTS.forEach((t, i) => insTask.run(info.lastInsertRowid, t, i));
  res.status(201).json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(info.lastInsertRowid) });
});

export default router;

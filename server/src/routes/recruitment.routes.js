import { Router } from 'express';
import db, { ONBOARDING_TASK_DEFAULTS, OFFBOARDING_TASK_DEFAULTS } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, filterToScope, scopeDepartmentNames } from '../utils/scope.js';
import { autoCompleteOnboardingTask, recomputeOnboardingPct } from '../utils/onboarding.js';
import { recomputeOffboardingClearance } from '../utils/offboarding.js';
import { sendEmail, sendWhatsapp } from '../utils/channels.js';
import { generateInterviewQuestions, generateOfferLetter } from '../utils/aiAssist.js';
import { extractResumeText, screenResume } from '../utils/resumeScreen.js';
import { getSetting, getSettings } from '../utils/integrationSettings.js';
import crypto from 'node:crypto';

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

// Marks an employee Exited the moment their Last Working Day arrives — login is deliberately
// NOT touched here. Access stays fully live past LWD (so they can still download their own
// payslips/offer letter, or finish handover work) until HR explicitly pauses the account from
// Employee Management, same as any other employee's login is revoked — LWD alone is not treated
// as an automatic security cutoff. Same "lazy check at the top of a list endpoint" idiom as
// sendPendingLeaveReminders/sendSlaBreachReminders — no cron/scheduler, just re-runs (cheaply,
// since the WHERE clause only matches rows that still need it) every time /overview loads.
function autoMarkExitedEmployees() {
  const due = db.prepare(`
    SELECT x.id AS exit_id, e.id AS employee_id, e.name
    FROM exits x
    JOIN employees e ON e.id = x.employee_id
    WHERE x.status = 'Serving Notice' AND x.last_working_day IS NOT NULL
      AND date(x.last_working_day) <= date('now') AND e.status != 'Exited'
  `).all();
  due.forEach((row) => {
    db.prepare("UPDATE employees SET status = 'Exited' WHERE id = ?").run(row.employee_id);
    db.prepare('INSERT INTO notifications (title, message, target_role) VALUES (?, ?, ?)')
      .run('Employee Exited', `${row.name}'s Last Working Day has arrived and they're now marked Exited. Their login stays active until you pause it from Employee Management.`, 'staff');
  });
}

router.get('/overview', (req, res) => {
  if (!canViewRecruitment(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  autoMarkExitedEmployees();
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

// Runs once, right after candidate creation, only when a resume was attached — reads it and asks
// the AI whether this looks like a fit worth auto-inviting to interview, or something a human
// should glance at first. Best-effort like everything else here: a screening failure defaults to
// "proceed" (see resumeScreen.js) so a flaky model never silently blocks a real candidate.
async function runResumeScreen(candidate) {
  if (!candidate.resume_data_url) return null;
  try {
    const position = candidate.position_id ? db.prepare('SELECT title, job_description FROM positions WHERE id = ?').get(candidate.position_id) : null;
    const text = await extractResumeText(candidate.resume_data_url, candidate.resume_name);
    const result = await screenResume(text, position?.title, position?.job_description);
    db.prepare('UPDATE candidates SET resume_screen_score = ?, resume_screen_recommendation = ?, resume_screen_summary = ? WHERE id = ?')
      .run(result.score, result.recommendation, result.summary, candidate.id);
    return result;
  } catch (err) {
    // Extraction failure (unsupported format, unreadable file) — same "don't block on a technical
    // hiccup" reasoning as a scoring failure, just record why for HR's benefit.
    db.prepare('UPDATE candidates SET resume_screen_recommendation = ?, resume_screen_summary = ? WHERE id = ?')
      .run('proceed', `Could not screen resume automatically (${err.message}).`, candidate.id);
    return { recommendation: 'proceed' };
  }
}

// After creating the candidate, an AI video-interview invite is generated and emailed
// automatically (no HR review step, per how this was scoped) — but neither AI question
// generation nor the email send can ever fail the candidate creation itself; both are wrapped and
// best-effort, since the candidate record is the source of truth and must always get created.
async function createInterviewInvite(candidate, customQuestions) {
  const position = candidate.position_id ? db.prepare('SELECT title, job_description FROM positions WHERE id = ?').get(candidate.position_id) : null;
  const jobTitle = position?.title || 'Open Position';

  // HR can supply their own question set instead of AI-generated ones — skips the AI call
  // entirely when provided, since there's nothing for it to generate.
  let questions = customQuestions?.length ? customQuestions : null;
  if (!questions) {
    try {
      questions = await generateInterviewQuestions(jobTitle, position?.job_description);
    } catch {
      questions = null; // generateInterviewQuestions already falls back internally; null only if it threw before reaching its own fallback
    }
  }
  if (!questions?.length) return;

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO candidate_interviews (candidate_id, token, questions) VALUES (?, ?, ?)')
    .run(candidate.id, token, JSON.stringify(questions));

  if (!candidate.email) return;
  const link = `${process.env.CLIENT_URL || 'http://localhost:5173'}/interview/${token}`;
  try {
    await sendEmail(
      candidate.email,
      `Interview invitation — ${jobTitle}`,
      `Hi ${candidate.name},\n\nThank you for applying for the ${jobTitle} position. Please complete a short video interview at your convenience using the link below:\n\n${link}\n\nYou'll need a working camera and microphone. It takes about 10-15 minutes.\n\nBest of luck!`
    );
  } catch {
    // Email not configured / send failed — the interview link still exists and works if shared
    // manually from the candidate's record; this just silently skips the auto-email step.
  }
}

const REAPPLY_COOLDOWN_DAYS = 90; // ~3 months

router.post('/candidates', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { name, position_id, panel, source_id, interview_questions } = req.body || {};
  const customQuestions = Array.isArray(interview_questions) ? interview_questions.map((q) => q?.toString().trim()).filter(Boolean) : null;
  if (!name) return res.status(400).json({ error: 'name is required' });

  // Same email applying again within the cooldown window isn't accepted — surfaced as a clear
  // validation error (with when they last applied) rather than silently creating a duplicate.
  const email = req.body?.email?.toString().trim();
  if (email) {
    const recent = db.prepare("SELECT created_at FROM candidates WHERE email = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 1")
      .get(email, `-${REAPPLY_COOLDOWN_DAYS} days`);
    if (recent) {
      return res.status(400).json({ error: `This email already applied on ${recent.created_at.slice(0, 10)} — reapplying within ${REAPPLY_COOLDOWN_DAYS} days (~3 months) of a previous application isn't accepted.` });
    }
  }

  const validSource = source_id && activeSources().some((s) => s.id === Number(source_id)) ? Number(source_id) : null;
  const start = firstRound();
  const profile = CANDIDATE_PROFILE_FIELDS.map((f) => req.body?.[f]?.toString().trim() || null);
  const info = db.prepare(`
    INSERT INTO candidates (name, position_id, panel, round_id, source_id, ${CANDIDATE_PROFILE_FIELDS.join(', ')})
    VALUES (?, ?, ?, ?, ?, ${CANDIDATE_PROFILE_FIELDS.map(() => '?').join(', ')})
  `).run(name.trim(), position_id || null, panel || null, start ? start.id : null, validSource, ...profile);
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ candidate });
  // Fire-and-forget, after responding — HR shouldn't wait on AI+email for the create call to
  // return. Resume screening (if a resume was attached) runs first; only a 'review' verdict holds
  // the auto-invite back for HR to send manually via POST /candidates/:id/send-interview-invite.
  (async () => {
    const screen = await runResumeScreen(candidate);
    if (screen?.recommendation === 'review') return;
    await createInterviewInvite(candidate, customQuestions);
  })().catch(() => {});
});

// Manual override for when resume screening recommended a human look first — HR reviewed and
// wants to send the AI interview invite anyway. Also works as a plain "(re)send invite" for any
// candidate that doesn't have one yet (e.g. no resume was attached, so screening never ran).
router.post('/candidates/:id/send-interview-invite', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  res.json({ ok: true });
  createInterviewInvite(candidate).catch(() => {});
});

// Deletes just the stored video for one interview answer (transcript/question/score are kept —
// this is for reclaiming storage or a privacy request, not undoing the interview itself). The
// candidate's own recorded video, once HR has reviewed it, doesn't need to stay forever.
router.delete('/candidates/interview-answers/:answerId/video', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const info = db.prepare('UPDATE candidate_interview_answers SET video_data_url = NULL WHERE id = ?').run(req.params.answerId);
  if (info.changes === 0) return res.status(404).json({ error: 'Answer not found' });
  res.json({ ok: true });
});

// AI video interview status/results for one candidate — the most recent invite if more than one
// ever existed (there shouldn't normally be more than one, but nothing prevents re-inviting).
router.get('/candidates/:id/interview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const interview = db.prepare('SELECT * FROM candidate_interviews WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id);
  if (!interview) return res.json({ interview: null });
  const answers = db.prepare('SELECT id, question_index, question, transcript, video_data_url FROM candidate_interview_answers WHERE interview_id = ? ORDER BY question_index').all(interview.id);
  res.json({
    interview: {
      status: interview.status,
      totalQuestions: JSON.parse(interview.questions).length,
      currentIndex: interview.current_index,
      score: interview.score,
      communicationScore: interview.communication_score,
      eligible: interview.eligible === null ? null : !!interview.eligible,
      summary: interview.summary,
      createdAt: interview.created_at,
      completedAt: interview.completed_at,
      link: `${process.env.CLIENT_URL || 'http://localhost:5173'}/interview/${interview.token}`,
      answers
    }
  });
});

// Interview Score Accuracy — the feedback loop the AI video interview never had: once scored, an
// eligibility recommendation was generated once and nobody ever came back to check whether it
// actually matched what happened to the candidate afterward. There's no explicit "Rejected" state
// in this pipeline (a candidate just stops progressing), so "outcome" is approximated from what IS
// tracked: reaching the final round (Hired), or sitting at the same non-final round for a long
// time without moving (Stalled — a proxy for having quietly fallen out of contention). A candidate
// still actively moving through rounds is "In Progress" — too early to judge, reported as pending,
// not folded into the accuracy percentage either way.
const STALL_DAYS = 30;

function interviewScoreAccuracy() {
  const interviews = db.prepare(`
    SELECT candidate_id, score, communication_score, eligible, summary, completed_at
    FROM candidate_interviews WHERE status = 'completed' AND score IS NOT NULL
    ORDER BY completed_at DESC
  `).all();

  return interviews.map((iv) => {
    const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(iv.candidate_id);
    if (!c) return null;
    const round = c.round_id ? db.prepare('SELECT name, is_final FROM interview_rounds WHERE id = ?').get(c.round_id) : null;
    const position = c.position_id ? db.prepare('SELECT title FROM positions WHERE id = ?').get(c.position_id) : null;
    const daysAtRound = Math.max(0, Math.floor((Date.now() - new Date(`${c.round_updated_at}Z`).getTime()) / 86400000));
    const eligible = iv.eligible === null ? null : !!iv.eligible;

    let outcome, verdict;
    if (round?.is_final) {
      outcome = 'Hired';
      verdict = eligible === false ? 'mismatch' : 'match';
    } else if (daysAtRound >= STALL_DAYS) {
      outcome = `Stalled ${daysAtRound}d at ${round?.name || 'this stage'}`;
      verdict = eligible === true ? 'mismatch' : 'match';
    } else {
      outcome = `In Progress — ${round?.name || 'stage unknown'}`;
      verdict = 'pending';
    }
    if (eligible === null) verdict = 'pending'; // no usable AI recommendation to check in the first place

    return {
      candidateId: c.id, name: c.name, position: position?.title || null,
      aiScore: iv.score, communicationScore: iv.communication_score, aiEligible: eligible, aiSummary: iv.summary,
      currentRound: round?.name || null, daysAtRound, outcome, verdict
    };
  }).filter(Boolean);
}

router.get('/interview-score-accuracy', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidates = interviewScoreAccuracy();
  const decided = candidates.filter((c) => c.verdict !== 'pending');
  const matches = decided.filter((c) => c.verdict === 'match').length;
  res.json({
    candidates,
    summary: {
      total: candidates.length,
      decided: decided.length,
      matches,
      mismatches: decided.length - matches,
      accuracyPct: decided.length ? Math.round((matches / decided.length) * 100) : null
    }
  });
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

// Builds the AI offer letter from HR-authoritative facts only (offered_ctc/joining_date are
// never guessed by the model — see generateOfferLetter's own doc comment) — shared by the
// advance-into-Offer flow below and the manual regenerate endpoint further down.
async function draftOfferLetter(candidateId, offeredCtc, joiningDate) {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  const position = candidate.position_id ? db.prepare('SELECT title, department_id FROM positions WHERE id = ?').get(candidate.position_id) : null;
  const department = position?.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(position.department_id)?.name : null;
  const text = await generateOfferLetter({
    candidateName: candidate.name,
    positionTitle: position?.title || 'the position',
    department,
    offeredCtc,
    joiningDate,
    companyName: getSetting('company_name')
  });
  // Regenerating (or the initial draft) always invalidates any earlier "sent" mark — the letter
  // on file just changed, so a stale sent-timestamp would wrongly tell HR the candidate already
  // has this version.
  db.prepare("UPDATE candidates SET offered_ctc = ?, joining_date = ?, offer_letter_text = ?, offer_letter_generated_at = datetime('now'), offer_letter_sent_at = NULL WHERE id = ?")
    .run(offeredCtc, joiningDate, text, candidateId);
  return text;
}

// Advances a candidate to the next active round in the (dynamic, HR-configurable) pipeline. If
// the next round is literally named "Offer", HR must supply the real offered CTC and joining
// date in the body — these save immediately and the stage moves right away; the AI offer letter
// drafts in the background afterward (fire-and-forget) rather than making HR wait 10-30s for the
// local model before the pipeline even updates. The client polls the candidate for
// offer_letter_text to know when it's ready.
router.put('/candidates/:id/advance', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const current = candidate.round_id ? db.prepare('SELECT * FROM interview_rounds WHERE id = ?').get(candidate.round_id) : null;
  if (current?.is_final) return res.status(400).json({ error: 'Candidate has already reached the final round.' });
  const next = nextRound(current ? current.sort_order : -1);
  if (!next) return res.status(400).json({ error: 'No further round is configured.' });

  let offerLetterPending = false;
  if (next.name === 'Offer') {
    const { offered_ctc, joining_date } = req.body || {};
    if (!offered_ctc?.trim() || !joining_date?.trim()) {
      return res.status(400).json({ error: 'Offered CTC and joining date are required to move a candidate to the Offer stage.' });
    }
    db.prepare('UPDATE candidates SET offered_ctc = ?, joining_date = ? WHERE id = ?').run(offered_ctc.trim(), joining_date.trim(), candidate.id);
    offerLetterPending = true;
  }

  db.prepare("UPDATE candidates SET round_id = ?, feedback_status = 'No feedback yet', round_updated_at = datetime('now') WHERE id = ?").run(next.id, req.params.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id), offerLetterPending });

  if (offerLetterPending) {
    const { offered_ctc, joining_date } = req.body || {};
    draftOfferLetter(candidate.id, offered_ctc.trim(), joining_date.trim()).catch(() => {
      // Flaky/unavailable local model — HR can hand-write the letter or hit Regenerate later;
      // the stage move itself has already gone through regardless.
    });
  }
});

// Everything a printable, letterheaded offer letter needs — candidate/position facts, the drafted
// text, and company branding — mirrors Payroll's GET /payslips/:id (payslip+employee+company)
// shape exactly, so the client can reuse the same letterhead HTML/CSS pattern.
router.get('/candidates/:id/offer-letter', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.offer_letter_text) return res.status(400).json({ error: 'No offer letter has been generated for this candidate yet.' });
  const position = candidate.position_id ? db.prepare('SELECT title, department_id FROM positions WHERE id = ?').get(candidate.position_id) : null;
  const department = position?.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(position.department_id)?.name : null;
  res.json({
    candidate: { name: candidate.name, position_title: position?.title, position_department: department, offered_ctc: candidate.offered_ctc, joining_date: candidate.joining_date, offer_letter_text: candidate.offer_letter_text },
    company: getSettings(['company_name', 'company_logo', 'company_address'])
  });
});

// HR hand-edits the AI draft before sending it.
router.put('/candidates/:id/offer-letter', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const text = req.body?.offer_letter_text;
  if (!text?.trim()) return res.status(400).json({ error: 'Letter text is required.' });
  // A hand-edit changes what was (or would be) sent, so an earlier "sent" mark no longer describes
  // what's on file — clear it rather than let HR believe the candidate already has this version.
  db.prepare('UPDATE candidates SET offer_letter_text = ?, offer_letter_sent_at = NULL WHERE id = ?').run(text.trim(), candidate.id);
  res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidate.id) });
});

// Regenerates the draft — reuses the stored offered_ctc/joining_date unless HR supplies updated
// ones in the body (e.g. the offer amount changed after a negotiation).
router.post('/candidates/:id/offer-letter/regenerate', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  const offeredCtc = req.body?.offered_ctc?.trim() || candidate.offered_ctc;
  const joiningDate = req.body?.joining_date?.trim() || candidate.joining_date;
  if (!offeredCtc || !joiningDate) return res.status(400).json({ error: 'Offered CTC and joining date are required.' });
  try {
    await draftOfferLetter(candidate.id, offeredCtc, joiningDate);
    res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidate.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The one explicit "actually send it" step — generating (or regenerating) the letter never
// emails it on its own; HR always clicks this deliberately, same "propose then human confirms"
// shape as everywhere else AI touches something external-facing in this app.
router.post('/candidates/:id/offer-letter/send', async (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!candidate.offer_letter_text) return res.status(400).json({ error: 'No offer letter has been generated for this candidate yet.' });
  if (!candidate.email) return res.status(400).json({ error: 'This candidate has no email on file.' });
  try {
    const companyName = getSetting('company_name') || 'the Company';
    const position = candidate.position_id ? db.prepare('SELECT title FROM positions WHERE id = ?').get(candidate.position_id) : null;
    await sendEmail(candidate.email, `Your Offer Letter — ${position?.title || 'Job Offer'} at ${companyName}`, candidate.offer_letter_text);
    db.prepare("UPDATE candidates SET offer_letter_sent_at = datetime('now') WHERE id = ?").run(candidate.id);
    res.json({ candidate: db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidate.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  db.prepare("UPDATE candidates SET round_id = ?, feedback_status = 'No feedback yet', round_updated_at = datetime('now') WHERE id = ?").run(prev.id, req.params.id);
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

  const hasOfferLetter = !!(me.email && db.prepare(
    'SELECT 1 FROM candidates WHERE email = ? AND offer_letter_text IS NOT NULL'
  ).get(me.email));

  res.json({ referrals, openPositions, resignation, onboarding, hasOfferLetter });
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

// Creates the same kind of record HR's own "Add Exit" does — just self-initiated, with a reason
// and an optional signed resignation letter attached.
router.post('/resign', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { last_working_day, reason, resignation_letter_data_url, resignation_letter_name } = req.body || {};
  if (!last_working_day) return res.status(400).json({ error: 'Last working day is required' });
  if (db.prepare("SELECT id FROM exits WHERE employee_id = ? AND status = 'Serving Notice'").get(me.id)) {
    return res.status(400).json({ error: 'You already have a resignation in progress.' });
  }
  const total = OFFBOARDING_TASK_DEFAULTS.length;
  const info = db.prepare(`
    INSERT INTO exits (employee_id, name, department, last_working_day, clearance_total, reason, resignation_letter_data_url, resignation_letter_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.id, me.name, me.department, last_working_day, total, reason?.trim() || null,
    resignation_letter_data_url || null, resignation_letter_data_url ? (resignation_letter_name || 'Resignation Letter') : null);
  const insTask = db.prepare('INSERT INTO offboarding_tasks (exit_id, task_name, sort_order) VALUES (?, ?, ?)');
  OFFBOARDING_TASK_DEFAULTS.forEach((t, i) => insTask.run(info.lastInsertRowid, t, i));
  res.status(201).json({ exit: db.prepare('SELECT * FROM exits WHERE id = ?').get(info.lastInsertRowid) });
});

// Self-service mirror of GET /candidates/:id/offer-letter, for an employee wanting their own
// original hiring offer letter — including after they've exited, since login/access isn't cut
// at Last Working Day (see autoMarkExitedEmployees above). There's no direct candidate->employee
// link in the schema, so this matches by email — the one field both records always share.
router.get('/my/offer-letter', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me?.email) return res.status(404).json({ error: 'No offer letter found for your account.' });
  const candidate = db.prepare(`
    SELECT * FROM candidates WHERE email = ? AND offer_letter_text IS NOT NULL ORDER BY created_at DESC LIMIT 1
  `).get(me.email);
  if (!candidate) return res.status(404).json({ error: 'No offer letter found for your account.' });
  const position = candidate.position_id ? db.prepare('SELECT title, department_id FROM positions WHERE id = ?').get(candidate.position_id) : null;
  const department = position?.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(position.department_id)?.name : null;
  res.json({
    candidate: { name: candidate.name, position_title: position?.title, position_department: department, offered_ctc: candidate.offered_ctc, joining_date: candidate.joining_date, offer_letter_text: candidate.offer_letter_text },
    company: getSettings(['company_name', 'company_logo', 'company_address'])
  });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModuleAdmin } from '../utils/rbac.js';
import { checkIdeaDuplicate, scoreIdea } from '../utils/aiAssist.js';

const router = Router();
router.use(requireAuth);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

// HR/admin-tier visibility only gates the compliance/full-feed views below — submitting your own
// idea and seeing your own history/the leaderboard is available to every employee regardless
// (same self-service shape as Leave/Expense elsewhere in this app), see POST / and GET /my below.
const isHR = (role) => canModuleAdmin(role, '23');

// Monday of the ISO week containing `date` (default: today), as YYYY-MM-DD. Shared week-boundary
// logic — every idea is bucketed into the week it was submitted in by this same rule, so the
// weekly quota and the weekly/monthly rollups all agree; timesheet.routes.js also imports this
// for its own Daily/Weekly/Monthly task filters, so "this week" means the same thing everywhere.
export function weekStartOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

const CAP_EXISTING_IDEAS = 150; // bounds the prompt sent for duplicate-checking, not a business rule

// Every employee must land 3 unique (non-duplicate, Approved) ideas per week — a Rejected
// duplicate never counts toward this, so the requirement is really "3 unique ideas", not just
// "3 submissions". Shared with performance.routes.js's knowledgeTransferScoreFor so the PMS
// weekly-compliance definition always agrees with what this module itself reports.
export const REQUIRED_IDEAS_PER_WEEK = 3;

// Deterministic near-exact-text safety net, checked BEFORE the AI semantic check. Verified during
// testing that the local model can miss even a near word-for-word duplicate once the comparison
// list has more than one existing idea in it (it reasons "conceptually similar" and then still
// answers false) — this catches that failure mode with 100% reliability for same-wording
// resubmissions, while the AI call afterward is what catches a genuinely different-wording
// paraphrase of the same idea (which it does catch sometimes, just not with full reliability —
// a real limitation of a small local model on nuanced semantic judgment, not something a prompt
// tweak fully fixes).
function wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}
function jaccardSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach((w) => { if (setB.has(w)) intersection++; });
  return intersection / (setA.size + setB.size - intersection);
}
const NEAR_DUPLICATE_THRESHOLD = 0.6;
function findNearTextDuplicate(title, description, existingIdeas) {
  const combined = `${title} ${description}`;
  for (const idea of existingIdeas) {
    if (jaccardSimilarity(combined, `${idea.title} ${idea.description}`) >= NEAR_DUPLICATE_THRESHOLD) return idea;
  }
  return null;
}

// Runs the actual AI review in the background (see POST / below, which responds the instant the
// row is inserted) — duplicate-check first, then only score it if it survives that check. Two
// sequential AI calls back to back, easily 20-40s combined on this hardware, which is exactly the
// kind of wait this app no longer makes anyone sit through synchronously (same non-blocking shape
// as Helpdesk's first-response and Recruitment's offer letter).
async function reviewIdea(ideaId, title, description) {
  const existingIdeas = db.prepare(`
    SELECT id, title, description FROM idea_contributions WHERE status = 'Approved' AND id != ? ORDER BY created_at DESC LIMIT ?
  `).all(ideaId, CAP_EXISTING_IDEAS);

  const textMatch = findNearTextDuplicate(title, description, existingIdeas);
  if (textMatch) {
    db.prepare("UPDATE idea_contributions SET status = 'Rejected', reject_reason = ?, duplicate_of_id = ? WHERE id = ?")
      .run(`This is worded almost identically to an existing idea ("${textMatch.title}").`, textMatch.id, ideaId);
    return;
  }

  const dup = await checkIdeaDuplicate(title, description, existingIdeas);
  if (dup.isDuplicate) {
    db.prepare("UPDATE idea_contributions SET status = 'Rejected', reject_reason = ?, duplicate_of_id = ? WHERE id = ?")
      .run(dup.reason || 'This idea appears to duplicate one already on file.', dup.duplicateOfId, ideaId);
    return;
  }
  const scores = await scoreIdea(title, description);
  db.prepare(`
    UPDATE idea_contributions SET status = 'Approved',
      originality_score = ?, usefulness_score = ?, impact_score = ?, clarity_score = ?, feasibility_score = ?, overall_score = ?, ai_feedback = ?
    WHERE id = ?
  `).run(scores.originality, scores.usefulness, scores.impact, scores.clarity, scores.feasibility, scores.overall, scores.feedback, ideaId);
}

// Employee: submit an idea toward this week's quota. Responds instantly (status starts 'Pending')
// — AI reviews it in the background; the client polls GET /my until it resolves. A submission AI
// judges a duplicate is stored as Rejected (with why + which idea it matched) rather than
// discarded — the employee sees the reason and is expected to try a different idea; a Rejected
// submission does NOT count toward the week's requirement, only an Approved one does. No cap on
// how many ideas someone can submit in a week — REQUIRED_IDEAS_PER_WEEK unique ones is the
// requirement, more is fine.
router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const title = req.body?.title?.toString().trim();
  const description = req.body?.description?.toString().trim();
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  if (!description) return res.status(400).json({ error: 'A description is required.' });

  const weekStart = weekStartOf();
  const info = db.prepare(`
    INSERT INTO idea_contributions (employee_id, week_start, title, description, status) VALUES (?, ?, ?, ?, 'Pending')
  `).run(me.id, weekStart, title, description);
  const idea = db.prepare('SELECT * FROM idea_contributions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ idea });

  reviewIdea(idea.id, title, description).catch(() => {
    // Local AI unavailable/flaky — leave it Pending rather than guessing; the employee (or HR)
    // can tell from the status indicator and the idea can be resubmitted/retried later.
  });
});

// Employee: retry a submission stuck in 'Pending' (AI was unavailable/flaky the first time) —
// only the employee who submitted it, and only while it's still genuinely unresolved.
router.post('/:id/retry', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const idea = db.prepare('SELECT * FROM idea_contributions WHERE id = ? AND employee_id = ?').get(req.params.id, me.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  if (idea.status !== 'Pending') return res.status(400).json({ error: 'This idea has already been reviewed.' });
  res.json({ ok: true });
  reviewIdea(idea.id, idea.title, idea.description).catch(() => {});
});

// Employee: my own submission history + this week's compliance status against the 3-unique
// -ideas quota.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ ideas: [], approvedThisWeek: 0, requiredPerWeek: REQUIRED_IDEAS_PER_WEEK, weeklyRequirementMet: false, hasPendingThisWeek: false, weekStart: weekStartOf() });
  const ideas = db.prepare('SELECT * FROM idea_contributions WHERE employee_id = ? ORDER BY created_at DESC').all(me.id);
  const weekStart = weekStartOf();
  const approvedThisWeek = ideas.filter((i) => i.week_start === weekStart && i.status === 'Approved').length;
  const hasPendingThisWeek = ideas.some((i) => i.week_start === weekStart && i.status === 'Pending');
  res.json({ ideas, approvedThisWeek, requiredPerWeek: REQUIRED_IDEAS_PER_WEEK, weeklyRequirementMet: approvedThisWeek >= REQUIRED_IDEAS_PER_WEEK, hasPendingThisWeek, weekStart });
});

// Company-wide leaderboard — visible to everyone (gamification only shows aggregate scores, not
// idea content, so this doesn't leak anything an employee couldn't already see about themselves).
// Ranked by total overall_score across all-time Approved ideas; ties broken by idea count. Also
// returns this-week and this-month totals per employee for the "weekly/monthly scores" requirement.
function leaderboardRows() {
  const weekStart = weekStartOf();
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const rows = db.prepare(`
    SELECT e.id AS employee_id, e.name, e.employee_code, e.department,
      COUNT(ic.id) AS ideaCount,
      COALESCE(SUM(ic.overall_score), 0) AS totalScore,
      COALESCE(AVG(ic.overall_score), 0) AS avgScore,
      COALESCE(SUM(CASE WHEN ic.week_start = ? THEN ic.overall_score ELSE 0 END), 0) AS weekScore,
      COALESCE(SUM(CASE WHEN ic.created_at >= ? THEN ic.overall_score ELSE 0 END), 0) AS monthScore
    FROM employees e
    JOIN idea_contributions ic ON ic.employee_id = e.id AND ic.status = 'Approved'
    WHERE e.status != 'Exited'
    GROUP BY e.id
    ORDER BY totalScore DESC, ideaCount DESC
  `).all(weekStart, monthStart);
  return rows.map((r) => ({ ...r, avgScore: Math.round(r.avgScore) }));
}

router.get('/leaderboard', (req, res) => {
  // `?department=` is the Dashboard's filter bar, not an access rule — the leaderboard is already
  // visible company-wide to everyone; this only narrows what is displayed so the widget follows
  // the same department selection as the rest of the dashboard.
  const department = (req.query.department || '').trim();
  const rows = leaderboardRows();
  res.json({
    leaderboard: department ? rows.filter((r) => r.department === department) : rows,
    weekStart: weekStartOf()
  });
});

// HR/manager-tier: weekly compliance against the 3-unique-ideas quota (who's hit it, and how many
// each employee has so far this week) + the full company-wide idea feed (Approved and Rejected) +
// the same leaderboard, all in one payload for the admin view.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const weekStart = weekStartOf();
  const activeEmployees = db.prepare("SELECT id, name, employee_code, department FROM employees WHERE status = 'Active' ORDER BY name").all();
  const countRows = db.prepare("SELECT employee_id, COUNT(*) AS c FROM idea_contributions WHERE week_start = ? AND status = 'Approved' GROUP BY employee_id").all(weekStart);
  const countsById = new Map(countRows.map((r) => [r.employee_id, r.c]));
  const compliance = activeEmployees.map((e) => {
    const approvedThisWeek = countsById.get(e.id) || 0;
    return { ...e, approvedThisWeek, submittedThisWeek: approvedThisWeek >= REQUIRED_IDEAS_PER_WEEK };
  });

  const feed = db.prepare(`
    SELECT ic.*, e.name AS employee_name, e.employee_code, e.department
    FROM idea_contributions ic JOIN employees e ON e.id = ic.employee_id
    ORDER BY ic.created_at DESC LIMIT 200
  `).all();

  res.json({
    weekStart,
    requiredPerWeek: REQUIRED_IDEAS_PER_WEEK,
    compliance,
    complianceSummary: { total: activeEmployees.length, submitted: compliance.filter((c) => c.submittedThisWeek).length },
    feed,
    leaderboard: leaderboardRows()
  });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModuleAdmin } from '../utils/rbac.js';
import { filterToScope } from '../utils/scope.js';
import { evaluateDecision } from '../utils/chain.js';
import { planAgentAction, checkAiStatus } from '../utils/aiAssist.js';

const router = Router();
router.use(requireAuth);

const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);
// Module '14' = Announcements — the only action here gated by a fixed module check; the other
// three actions (submit leave, approve/reject, request profile edit) are self-service and the
// real routes they call enforce their own permission/ownership/chain-seniority rules.
const canAnnounce = (role) => canModuleAdmin(role, '14');

const BASE_URL = `http://localhost:${process.env.PORT || 4000}`;

// The execute step never re-implements any HRMS business logic — it replays the confirmed action
// as one real HTTP request against this same server's own public routes, using the caller's own
// bearer token. That guarantees identical validation, RBAC, and side effects to a human clicking
// the equivalent button by hand, with zero duplicated logic that could drift out of sync.
async function callSelf(authHeader, method, path, body) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Pending leaves/approvals this user is senior enough (per the live role chain) and in-scope
// (per department/team assignment) to act on RIGHT NOW — the exact same two checks the real
// approve/reject routes perform, so the agent never offers to approve something it can't.
function actionableRequests(role, employeeId) {
  const pendingLeaves = db.prepare(`
    SELECT l.id, l.from_date, l.to_date, l.reason, l.current_stage_role_id, e.name AS employee_name, e.department, e.team_id
    FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE l.status = 'Pending' ORDER BY l.created_at DESC
  `).all();
  const empByName = (name) => db.prepare('SELECT department, team_id FROM employees WHERE name = ?').get(name);
  const pendingApprovals = db.prepare("SELECT * FROM approvals WHERE status = 'Pending' ORDER BY created_at DESC").all()
    .map((a) => ({ ...a, ...(empByName(a.requester) || {}) }));

  const canAct = (row) => !evaluateDecision(role, row.current_stage_role_id, false).error;

  const leaves = filterToScope(pendingLeaves, role, employeeId).filter(canAct)
    .map((l) => ({ kind: 'leave', id: l.id, label: `Leave — ${l.employee_name}, ${l.from_date} to ${l.to_date}${l.reason ? ` (${l.reason})` : ''}` }));
  const approvals = filterToScope(pendingApprovals, role, employeeId).filter(canAct)
    .map((a) => ({ kind: 'approval', id: a.id, label: `${a.type} — ${a.requester}${a.detail ? `: ${a.detail}` : ''}` }));

  return [...leaves, ...approvals];
}

function buildContext(req) {
  const me = myEmployee(req.user.sub);
  const leaveTypes = db.prepare('SELECT id, name FROM leave_types WHERE active = 1 ORDER BY id').all();
  const actionable = actionableRequests(req.user.role, me?.id);
  return { me, leaveTypes, actionable, canAnnounce: canAnnounce(req.user.role) };
}

function buildSystemPrompt(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const employeeLine = ctx.me
    ? `Employee: ${ctx.me.name} (their own employee id is ${ctx.me.id}), department ${ctx.me.department || 'unassigned'}.`
    : 'This account has no linked employee record — leave and profile-edit actions are unavailable to them.';
  const leaveTypesLine = ctx.leaveTypes.length ? ctx.leaveTypes.map((t) => `${t.id}=${t.name}`).join(', ') : 'none configured';
  const actionableLine = ctx.actionable.length
    ? ctx.actionable.map((a) => `- kind="${a.kind}" id=${a.id}: ${a.label}`).join('\n')
    : '(nothing pending that this user can act on right now)';

  return `You are the AI AGENT inside this company's HRMS. Unlike the separate AI Assistant (which only answers questions), you can propose real ACTIONS — but you never execute anything yourself. Your only job is to read the user's message and output ONE JSON object describing what they want done; a human always confirms it in a separate step before it actually happens.

Today's date: ${today}
${employeeLine}
Leave types (id=name): ${leaveTypesLine}
Requests this user can currently approve or reject:
${actionableLine}
This user ${ctx.canAnnounce ? 'IS' : 'is NOT'} allowed to post company announcements.

Respond with ONLY a single JSON object, no markdown, no explanation — exactly one of these shapes:

1. Submit a leave request for themself:
{"action":"submit_leave","params":{"leave_type_id":<int from the list above>,"leave_type_name":"<the matching name from the list>","from_date":"YYYY-MM-DD","to_date":"YYYY-MM-DD","reason":"<short reason, or empty string>"},"summary":"<one sentence a human will read before confirming: state the leave type, the exact dates, and the day count>"}

2. Approve or reject one of the pending requests listed above — you MUST copy an id that is actually in that list, never invent one:
{"action":"approve_request","params":{"kind":"leave"|"approval","id":<int from the list>,"label":"<copy the matching label from the list>"},"summary":"<one sentence stating exactly what will be approved>"}
{"action":"reject_request","params":{"kind":"leave"|"approval","id":<int from the list>,"label":"<copy the matching label from the list>"},"summary":"<one sentence stating exactly what will be rejected>"}

3. Request an edit to their OWN profile (only when they describe wanting to change their own info):
{"action":"request_profile_edit","params":{"reason":"<what they want changed and why, as one sentence>"},"summary":"<one sentence>"}

4. Post a company announcement (only if this user is allowed to, per above):
{"action":"post_announcement","params":{"title":"<short title>","body":"<announcement body text>","category":"General"|"Policy"|"Event"|"Holiday"},"summary":"<one sentence>"}

5. Anything unclear, missing required info (e.g. no dates given for a leave request), about something not covered above, or referring to a request that is NOT in the actionable list above:
{"action":"clarify","params":{},"summary":"<a short, specific question asking exactly what's missing or explaining what you can't do>"}

Resolve relative dates ("tomorrow", "next Monday") into real YYYY-MM-DD dates using today's date above. Never invent a leave_type_id, employee id, or request id that wasn't given to you above — if the user refers to something not in the lists, use "clarify" and say so.

Base your action ONLY on the user's latest message. Earlier turns in this conversation are for context (e.g. "yes" confirming something you just asked about) — never repeat an action from an earlier turn just because it's the most recent one in the history, and never propose an action a prior turn already says was confirmed, failed, or cancelled unless the user is clearly asking for it again.`;
}

// Polled by the Topbar (every page, always-on indicator) and the chat panel (banner when down) —
// the one place in the whole app that answers "is local AI actually reachable right now".
router.get('/status', async (req, res) => {
  const status = await checkAiStatus();
  res.json({ available: status.available, modelPulled: status.modelPulled, model: status.model });
});

router.get('/context', (req, res) => {
  const ctx = buildContext(req);
  res.json({ hasEmployee: !!ctx.me, canAnnounce: ctx.canAnnounce, actionableCount: ctx.actionable.length });
});

router.post('/plan', async (req, res) => {
  const message = req.body?.message?.toString().trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const trimmedHistory = rawHistory
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  try {
    const ctx = buildContext(req);
    const plan = await planAgentAction(buildSystemPrompt(ctx), [...trimmedHistory, { role: 'user', content: message }]);
    res.json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Only ever called after the user clicks Confirm on a proposal returned by /plan. Re-validates
// the action shape itself, then replays it as a real request via callSelf — the target route's
// own checks are the actual source of truth on whether it's allowed to happen.
router.post('/execute', async (req, res) => {
  const { action, params } = req.body || {};
  const authHeader = req.headers.authorization;
  const me = myEmployee(req.user.sub);

  try {
    if (action === 'submit_leave') {
      if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
      const { leave_type_id, from_date, to_date, reason } = params || {};
      const r = await callSelf(authHeader, 'POST', '/leaves', { leave_type_id, from_date, to_date, reason });
      if (!r.ok) return res.status(r.status).json({ error: r.data?.error || 'Could not submit the leave request.' });
      return res.json({ ok: true, message: 'Leave request submitted.' });
    }

    if (action === 'approve_request' || action === 'reject_request') {
      const { kind, id } = params || {};
      if (!id || (kind !== 'leave' && kind !== 'approval')) return res.status(400).json({ error: 'Missing or invalid request to act on.' });
      const decision = action === 'approve_request' ? 'approve' : 'reject';
      const path = kind === 'leave' ? `/leaves/${id}/${decision}` : `/approvals/${id}/${decision}`;
      const r = await callSelf(authHeader, 'POST', path, {});
      if (!r.ok) return res.status(r.status).json({ error: r.data?.error || `Could not ${decision} this request.` });
      return res.json({ ok: true, message: `Request ${decision}d.` });
    }

    if (action === 'request_profile_edit') {
      if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
      const reason = params?.reason?.toString().trim();
      if (!reason) return res.status(400).json({ error: 'A reason is required.' });
      const r = await callSelf(authHeader, 'POST', `/employees/${me.id}/request-edit`, { reason });
      if (!r.ok) return res.status(r.status).json({ error: r.data?.error || 'Could not submit the edit request.' });
      return res.json({ ok: true, message: 'Profile edit request submitted for approval.' });
    }

    if (action === 'post_announcement') {
      if (!canAnnounce(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions to post announcements.' });
      const { title, body, category } = params || {};
      const r = await callSelf(authHeader, 'POST', '/announcements', { title, body, category });
      if (!r.ok) return res.status(r.status).json({ error: r.data?.error || 'Could not post the announcement.' });
      return res.json({ ok: true, message: 'Announcement posted.' });
    }

    return res.status(400).json({ error: 'Unknown or unsupported action.' });
  } catch {
    return res.status(500).json({ error: 'Could not reach the server to perform this action — please try again.' });
  }
});

export default router;

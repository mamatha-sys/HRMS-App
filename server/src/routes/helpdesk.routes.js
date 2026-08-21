import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { notifyEmployee } from '../utils/notify.js';
import { notifyWebhooks } from '../utils/webhooks.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';
import { suggestTicketAnswer } from '../utils/aiAssist.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '13' (Helpdesk). A Senior Team Lead/Team Lead/
// Assistant Manager also passes — but ONLY for the read-only /overview below, which explicitly
// scopes the ticket list it returns; every write endpoint in this file (create/assign/resolve/
// escalate/KB-manage/routing) still checks canModuleAdmin directly, so scoped roles stay
// view-only here, matching Super Admin policy.
const isHR = (role) => canModuleAdmin(role, '13');
const canViewHelpdesk = (role) => canModuleAdmin(role, '13') || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const CATEGORIES = ['IT', 'HR', 'Admin', 'Grievance', 'Facilities', 'Payroll', 'Other'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
// Ticket Escalation: how many hours each priority has before its SLA is considered breached.
const SLA_HOURS = { Critical: 1, High: 4, Medium: 24, Low: 72 };
// Ticket Resolution, Closure & Reopening: a resolved ticket auto-clears for closure after this
// many days even if the requester never explicitly confirms.
const AUTO_CLOSE_DAYS = 3;

// SQLite's datetime('now') and every UTC timestamp this file writes (toISOString()-derived) are
// stored as UTC with no timezone marker (e.g. "2026-07-28 10:44:01"). Parsing that string with
// `new Date(str.replace(' ', 'T'))` — no trailing Z — makes JS treat it as local time instead,
// silently shifting every comparison by the server's UTC offset. Appending 'Z' fixes that.
function parseUtc(str) {
  return new Date(str.replace(' ', 'T') + 'Z');
}
function isBreached(t) {
  if (!t.sla_deadline || ['Resolved', 'Closed'].includes(t.status)) return false;
  return new Date() > parseUtc(t.sla_deadline);
}
function canClose(t) {
  if (t.requester_confirmed) return true;
  if (!t.resolved_at) return false;
  const days = (Date.now() - parseUtc(t.resolved_at).getTime()) / 86400000;
  return days >= AUTO_CLOSE_DAYS;
}

function withDetails(t, { includeInternal } = { includeInternal: false }) {
  const employee = db.prepare('SELECT name, employee_code FROM employees WHERE id = ?').get(t.employee_id);
  const assignee = t.assigned_to_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(t.assigned_to_employee_id) : null;
  const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(t.id)
    .filter((c) => includeInternal || !c.internal);
  return {
    ...t,
    employee_name: employee?.name, employee_code: employee?.employee_code,
    assignee_name: assignee?.name || null,
    slaBreached: isBreached(t),
    canClose: canClose(t),
    comments
  };
}

function logComment(ticketId, authorName, comment, { internal, attachment_data_url, attachment_name } = {}) {
  db.prepare('INSERT INTO ticket_comments (ticket_id, author_name, comment, internal, attachment_data_url, attachment_name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ticketId, authorName, comment, internal ? 1 : 0, attachment_data_url || null, attachment_name || null);
}

// Ticket Escalation (automatic 24h ratchet): independent of each priority's own SLA_HOURS
// deadline above, any ticket that sits open/unresolved for a full 24 hours — measured from
// creation, or from whenever it was last auto-escalated — has its priority bumped one level,
// with no HR approval needed. This repeats every further 24 hours of continued non-resolution
// until the ticket reaches Critical or is resolved/closed. There's no background scheduler in
// this app, so this runs lazily at the top of every ticket-list read (Overview/My Tickets/
// Escalations) — a bump lands the next time anyone loads one of those, not at the exact instant
// 24h elapses.
const AUTO_ESCALATE_HOURS = 24;
function runAutoEscalations() {
  const candidates = db.prepare("SELECT * FROM tickets WHERE status NOT IN ('Resolved','Closed') AND priority != 'Critical'").all();
  const now = Date.now();
  for (const t of candidates) {
    let priority = t.priority;
    let reference = parseUtc(t.last_escalated_at || t.created_at).getTime();
    let bumped = false;
    while (priority !== 'Critical' && (now - reference) >= AUTO_ESCALATE_HOURS * 3600000) {
      priority = PRIORITIES[PRIORITIES.indexOf(priority) + 1];
      reference += AUTO_ESCALATE_HOURS * 3600000;
      bumped = true;
    }
    if (!bumped) continue;
    const newDeadline = new Date(now + SLA_HOURS[priority] * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const referenceStr = new Date(reference).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE tickets SET priority = ?, escalated = 1, sla_deadline = ?, last_escalated_at = ? WHERE id = ?')
      .run(priority, newDeadline, referenceStr, t.id);
    logComment(t.id, 'System', `Auto-escalated — unresolved for 24+ hours, priority raised to ${priority}.`, { internal: true });
    const escDescSuffix = t.description?.trim() ? ` — "${t.description.trim()}"` : '';
    notifyEmployee(t.employee_id, 'Ticket priority escalated', `Your ticket "${t.subject}" has been unresolved for over 24 hours and was automatically escalated to ${priority} priority.${escDescSuffix}`, { priority, ticketId: t.id });
    // 'staff' (not 'all'): this is an operational alert about someone's ticket, not something a
    // plain employee should see on their own dashboard for other people's tickets. Their own
    // ticket already gets a personal notification via notifyEmployee above.
    db.prepare('INSERT INTO notifications (title, message, target_role, priority, ticket_id) VALUES (?, ?, ?, ?, ?)')
      .run('Helpdesk Ticket Auto-Escalated', `"${t.subject}" was unresolved for 24+ hours and auto-escalated to ${priority} priority.${escDescSuffix}`, 'staff', priority, t.id);
    notifyWebhooks('Helpdesk Ticket Auto-Escalated', `Ticket #${t.id} "${t.subject}" auto-escalated to ${priority} priority after 24+ hours unresolved.`).catch(() => {});
  }
}

// Ticket Escalation (SLA-breach reminder): distinct from the flat 24h auto-escalation ratchet
// above — this fires the moment a ticket crosses its OWN priority-specific SLA_HOURS deadline
// (Critical 1h, High 4h, Medium 24h, Low 72h), not a fixed 24h window regardless of priority. A
// Critical ticket left untouched gets nudged after 1 hour, not 24. Repeats every
// SLA_REMINDER_COOLDOWN_HOURS while still breached, via last_sla_reminded_at — same lazy,
// no-background-scheduler idiom as everything else here.
const SLA_REMINDER_COOLDOWN_HOURS = 2;
function sendSlaBreachReminders() {
  const candidates = db.prepare("SELECT * FROM tickets WHERE status NOT IN ('Resolved','Closed') AND sla_deadline IS NOT NULL").all();
  const now = Date.now();
  candidates.forEach((t) => {
    if (!isBreached(t)) return;
    const lastReminder = t.last_sla_reminded_at ? parseUtc(t.last_sla_reminded_at).getTime() : null;
    if (lastReminder && (now - lastReminder) < SLA_REMINDER_COOLDOWN_HOURS * 3600000) return;
    const overdueHours = Math.max(1, Math.round((now - parseUtc(t.sla_deadline).getTime()) / 3600000));
    if (t.assigned_to_employee_id) {
      notifyEmployee(t.assigned_to_employee_id, 'SLA deadline passed', `"${t.subject}" (${t.priority} priority) is ${overdueHours}h past its SLA deadline — please resolve or update it.`, { priority: t.priority, ticketId: t.id });
    }
    db.prepare('INSERT INTO notifications (title, message, target_role, priority, ticket_id) VALUES (?, ?, ?, ?, ?)')
      .run('Helpdesk SLA Breached', `"${t.subject}" (${t.priority} priority) is ${overdueHours}h past its SLA deadline and still ${t.status}.`, 'staff', t.priority, t.id);
    db.prepare("UPDATE tickets SET last_sla_reminded_at = datetime('now') WHERE id = ?").run(t.id);
  });
}

// HR: dashboard of every ticket, with KPIs by status.
router.get('/overview', (req, res) => {
  if (!canViewHelpdesk(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  runAutoEscalations();
  sendSlaBreachReminders();
  const hr = isHR(req.user.role);
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;

  // Internal notes (Internal Notes, Attachments & Screenshots) stay HR-only — a scoped viewer
  // sees the ticket and its public thread, but never internal-only comments.
  let tickets = db.prepare("SELECT * FROM tickets ORDER BY (status = 'Open') DESC, created_at DESC").all().map((t) => withDetails(t, { includeInternal: hr }));
  // Every ticket has a raiser (myEmployee() is required to create one), so unlike Assets/
  // Recruitment there's no "unattributed" case here — a scoped role sees only tickets raised
  // by an employee within their assigned department(s)/team(s). Grievance tickets are the one
  // exception: they route straight to HR/Super Admin and are hidden from every scoped supervisor
  // (STL/TL/Assistant Manager) regardless of department, since a grievance may well be about that
  // very supervisor — see the matching exclusion in notifications.routes.js for the ticket alert.
  if (scoped) {
    tickets = tickets.filter((t) => {
      if (t.category === 'Grievance') return false;
      const emp = db.prepare('SELECT department FROM employees WHERE id = ?').get(t.employee_id);
      return emp?.department && scopeDeptNames.has(emp.department);
    });
  }
  const count = (s) => tickets.filter((t) => t.status === s).length;
  res.json({
    banner: scoped ? 'Team/organization helpdesk — view your assigned department(s)/team(s) tickets only; no create, assign, resolve, or escalate actions here.' : undefined,
    kpis: [
      { label: 'Open', value: count('Open'), color: 'gold' },
      { label: 'In Progress', value: count('In Progress'), color: 'blue' },
      { label: 'Resolved', value: count('Resolved') + count('Closed'), color: 'green' }
    ],
    tickets,
    categories: CATEGORIES,
    priorities: PRIORITIES
  });
});

// Employee self-service: my own tickets.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ tickets: [], categories: CATEGORIES, priorities: PRIORITIES });
  runAutoEscalations();
  sendSlaBreachReminders();
  const tickets = db.prepare('SELECT * FROM tickets WHERE employee_id = ? ORDER BY created_at DESC').all(me.id).map((t) => withDetails(t));
  res.json({ tickets, categories: CATEGORIES, priorities: PRIORITIES });
});

router.get('/:id', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  const isOwner = ticket.employee_id === me?.id;
  if (!isHR(req.user.role) && !isOwner) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ ticket: withDetails(ticket, { includeInternal: isHR(req.user.role) }) });
});

// Ticket Creation, Assignment & Categorization: employee raises a ticket. SLA deadline is set
// automatically from priority, and Auto Routing assigns + notifies based on category if a
// routing rule exists.
router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { category, priority, subject, description, attachment_data_url, attachment_name } = req.body || {};
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  const prio = PRIORITIES.includes(priority) ? priority : 'Medium';
  const slaDeadline = new Date(Date.now() + SLA_HOURS[prio] * 3600000).toISOString().slice(0, 19).replace('T', ' ');

  const routing = db.prepare('SELECT assigned_to_employee_id FROM ticket_routing WHERE category = ?').get(category);
  const info = db.prepare(`
    INSERT INTO tickets (employee_id, category, priority, subject, description, sla_deadline, assigned_to_employee_id, attachment_data_url, attachment_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(me.id, category, prio, subject.trim(), description || null, slaDeadline, routing?.assigned_to_employee_id || null, attachment_data_url || null, attachment_name || null);

  // A dashboard alert fires for every new ticket, not just auto-routed ones — routing just
  // changes who it says the ticket landed with. The ticket's own description rides along too,
  // so the alert is useful on its own without a trip into Helpdesk to see what it's about.
  const assignee = routing ? db.prepare('SELECT name FROM employees WHERE id = ?').get(routing.assigned_to_employee_id) : null;
  const descSuffix = description?.trim() ? ` — "${description.trim()}"` : '';
  const routedMsg = routing
    ? `"${subject.trim()}" (${category}) auto-routed to ${assignee?.name || 'a staff member'}.${descSuffix}`
    : `${me.name} raised a "${subject.trim()}" (${category}) ticket.${descSuffix}`;
  // 'staff' (not 'all'): a plain employee shouldn't see a dashboard alert about someone else's
  // ticket — only HR/admin/managerial roles need this operational visibility.
  db.prepare('INSERT INTO notifications (title, message, target_role, priority, ticket_id) VALUES (?, ?, ?, ?, ?)')
    .run('New Helpdesk Ticket', routedMsg, 'staff', prio, info.lastInsertRowid);
  notifyWebhooks('New Helpdesk Ticket', `${me.name} raised a ${prio} priority ${category} ticket: "${subject.trim()}"`).catch(() => {});

  res.status(201).json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid)) });

  // AI first-response: fire-and-forget, grounded on this category's real KB articles (see
  // suggestTicketAnswer). Runs AFTER the response is already sent — the requester gets their
  // ticket back instantly instead of waiting 10-30s for the local model, and the AI comment
  // simply appears in the thread a little later. Never touches the ticket creation itself; a
  // slow/unavailable model just means no AI comment shows up, nothing else is affected.
  (async () => {
    try {
      const kbArticles = db.prepare('SELECT title, body FROM kb_articles WHERE category = ? ORDER BY created_at DESC LIMIT 5').all(category);
      const answer = await suggestTicketAnswer(category, subject.trim(), description, kbArticles);
      logComment(info.lastInsertRowid, 'AI Assistant', answer);
    } catch { /* Local AI unavailable or returned nothing — ticket still stands on its own, HR/assignee still has it. */ }
  })();
});

// HR: update status and/or assign to a staff member (SLA Tracking & Status / Assignment).
// Rule: a ticket cannot be closed until the requester confirms resolution or the auto-close
// window elapses.
router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status, assigned_to_employee_id } = req.body || {};
  const validStatus = status === undefined ? ticket.status : (['Open', 'In Progress', 'Resolved', 'Closed'].includes(status) ? status : ticket.status);
  if (validStatus === 'Closed' && ticket.status !== 'Closed' && !canClose(ticket)) {
    return res.status(400).json({ error: `This ticket cannot be closed until the requester confirms resolution, or ${AUTO_CLOSE_DAYS} days have passed since it was resolved.` });
  }
  const resolvedAt = (validStatus === 'Resolved' || validStatus === 'Closed') && !ticket.resolved_at ? new Date().toISOString().slice(0, 19).replace('T', ' ') : ticket.resolved_at;
  db.prepare('UPDATE tickets SET status = ?, assigned_to_employee_id = ?, resolved_at = ? WHERE id = ?')
    .run(validStatus, assigned_to_employee_id === undefined ? ticket.assigned_to_employee_id : (assigned_to_employee_id || null), resolvedAt, req.params.id);
  if (validStatus === 'Resolved' && ticket.status !== 'Resolved') {
    notifyEmployee(ticket.employee_id, 'Ticket resolved', `Your ticket "${ticket.subject}" was marked resolved. Please confirm or reopen it.`);
  }
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id), { includeInternal: true }) });
});

// Ticket Resolution, Closure & Reopening: requester confirms a Resolved ticket is genuinely
// fixed (unlocking Close before the auto-close window would otherwise allow it).
router.post('/:id/confirm', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  if (ticket.status !== 'Resolved') return res.status(400).json({ error: 'Only a Resolved ticket can be confirmed.' });
  db.prepare('UPDATE tickets SET requester_confirmed = 1 WHERE id = ?').run(ticket.id);
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id)) });
});

// The requester's response to the AI Assistant's first-response comment (see POST / above) — the
// two outcomes the ticket's own raiser can pick, no HR involvement needed either way:
//  - "Yes, that fixed it" resolves the ticket immediately, self-confirmed (same effect as a real
//    HR resolution the requester then confirms via POST /:id/confirm, but in one step).
//  - "No, still need help" escalates it via the exact same bump escalateTicket() uses for HR's
//    manual escalation — gets it faster/more senior attention rather than sitting at its
//    original priority waiting for the 24h auto-escalation ratchet to eventually catch it.
router.post('/:id/ai-resolve', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Only the requester can accept the AI suggestion.' });
  if (!['Open', 'In Progress'].includes(ticket.status)) return res.status(400).json({ error: 'This ticket is no longer open.' });
  const resolvedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("UPDATE tickets SET status = 'Resolved', resolved_at = ?, requester_confirmed = 1 WHERE id = ?").run(resolvedAt, ticket.id);
  logComment(ticket.id, req.user.name || 'Anonymous', 'Marked resolved — the AI-suggested answer solved it.');
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id)) });
});

router.post('/:id/ai-escalate', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Only the requester can escalate their own ticket.' });
  if (!['Open', 'In Progress'].includes(ticket.status)) return res.status(400).json({ error: 'This ticket is no longer open.' });
  const nextPriority = escalateTicket(ticket, req.user.name || 'Anonymous', "Requester said the AI-suggested answer above didn't resolve it — escalated for a staff member to take over.", false);
  db.prepare('INSERT INTO notifications (title, message, target_role, priority, ticket_id) VALUES (?, ?, ?, ?, ?)')
    .run('Helpdesk Ticket Escalated', `${me.name} said the AI suggestion on "${ticket.subject}" didn't help — escalated to ${nextPriority} priority.`, 'staff', nextPriority, ticket.id);
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id)) });
});

// Reopen a Resolved/Closed ticket that turned out not to actually be fixed.
router.post('/:id/reopen', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  if (!['Resolved', 'Closed'].includes(ticket.status)) return res.status(400).json({ error: 'Only a Resolved or Closed ticket can be reopened.' });
  db.prepare('UPDATE tickets SET status = ?, resolved_at = NULL, requester_confirmed = 0 WHERE id = ?').run('Open', ticket.id);
  logComment(ticket.id, req.user.name || 'Anonymous', 'Ticket reopened.');
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id), { includeInternal: isHR(req.user.role) }) });
});

// CSAT / Customer Satisfaction Feedback: requester rates a Resolved/Closed ticket 1-5.
router.post('/:id/csat', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Only the requester can rate this ticket.' });
  if (!['Resolved', 'Closed'].includes(ticket.status)) return res.status(400).json({ error: 'You can only rate a Resolved or Closed ticket.' });
  const rating = Math.max(1, Math.min(5, parseInt(req.body?.rating, 10) || 0));
  if (!rating) return res.status(400).json({ error: 'A rating from 1 to 5 is required.' });
  db.prepare('UPDATE tickets SET csat_rating = ? WHERE id = ?').run(rating, ticket.id);
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id)) });
});

// Both HR and the ticket's own employee can add a comment to the public thread; HR can also
// add an internal-only note (Internal Notes, Attachments & Screenshots), optionally with an
// attached file/screenshot.
router.post('/:id/comments', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  const hr = isHR(req.user.role);
  if (!hr && ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  const { comment, internal, attachment_data_url, attachment_name } = req.body || {};
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });
  if (internal && !hr) return res.status(403).json({ error: 'Only HR can add an internal note.' });
  logComment(ticket.id, req.user.name || 'Anonymous', comment.trim(), { internal: !!internal, attachment_data_url, attachment_name });
  res.status(201).json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id), { includeInternal: hr }) });
});

// Ticket Escalation: every SLA-breached, unresolved ticket, with a one-click approval that
// bumps its priority and flags it as escalated.
router.get('/escalations/list', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  runAutoEscalations();
  sendSlaBreachReminders();
  const tickets = db.prepare("SELECT * FROM tickets WHERE status NOT IN ('Resolved','Closed')").all().map((t) => withDetails(t, { includeInternal: true })).filter((t) => t.slaBreached);
  res.json({ tickets });
});

// Shared bump — one level up PRIORITIES, recomputed SLA deadline, escalated=1 — used by both the
// HR-manual escalate route below and the requester-triggered "AI suggestion didn't help" route,
// so there's exactly one place that defines what "escalate" does to a ticket.
function escalateTicket(ticket, actorName, note, internal = true) {
  const nextPriority = PRIORITIES[Math.min(PRIORITIES.indexOf(ticket.priority) + 1, PRIORITIES.length - 1)];
  const newDeadline = new Date(Date.now() + SLA_HOURS[nextPriority] * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE tickets SET escalated = 1, priority = ?, sla_deadline = ? WHERE id = ?').run(nextPriority, newDeadline, ticket.id);
  logComment(ticket.id, actorName, note || `Escalation approved — priority raised to ${nextPriority}.`, { internal });
  return nextPriority;
}

router.post('/:id/escalate', (req, res) => {
  // Feature-level gate: escalating a ticket is the 'Ticket Escalation' feature specifically.
  if (!canFeatureAction(req.user.role, '13', 'Ticket Escalation', 'Manage')) return res.status(403).json({ error: 'Insufficient permissions' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  escalateTicket(ticket, req.user.name || 'Anonymous');
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id), { includeInternal: true }) });
});

// Knowledge Base: everyone can browse; only HR can author articles.
router.get('/kb/articles', (req, res) => {
  res.json({ articles: db.prepare('SELECT * FROM kb_articles ORDER BY created_at DESC').all() });
});
router.post('/kb/articles', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, body, category } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Title and body are both required.' });
  const info = db.prepare('INSERT INTO kb_articles (title, body, category, created_by) VALUES (?, ?, ?, ?)')
    .run(title.trim(), body.trim(), category?.trim() || 'General', req.user.name || 'HR');
  res.status(201).json({ article: db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(info.lastInsertRowid) });
});
router.delete('/kb/articles/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM kb_articles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Auto Routing & Email Notifications: HR maps a category to a default assignee; new tickets
// in that category auto-assign and fire a notification (see POST / above).
router.get('/routing/rules', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rules = db.prepare(`
    SELECT r.category, r.assigned_to_employee_id, e.name AS assignee_name, e.employee_code
    FROM ticket_routing r JOIN employees e ON e.id = r.assigned_to_employee_id
  `).all();
  const employees = db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active'").all();
  res.json({ rules, categories: CATEGORIES, employees });
});
router.put('/routing/rules', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { category, assigned_to_employee_id } = req.body || {};
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(assigned_to_employee_id);
  if (!emp) return res.status(400).json({ error: 'A valid employee is required' });
  db.prepare('INSERT INTO ticket_routing (category, assigned_to_employee_id) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET assigned_to_employee_id = excluded.assigned_to_employee_id')
    .run(category, emp.id);
  res.json({ ok: true });
});
router.delete('/routing/rules/:category', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM ticket_routing WHERE category = ?').run(req.params.category);
  res.json({ ok: true });
});

// Helpdesk Dashboard, Reports & Analytics: counts by category + average CSAT.
router.get('/reports/summary', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const tickets = db.prepare('SELECT * FROM tickets').all();
  const byCategory = CATEGORIES.map((cat) => ({ category: cat, count: tickets.filter((t) => t.category === cat).length })).filter((c) => c.count > 0);
  const rated = tickets.filter((t) => t.csat_rating != null);
  const avgCsat = rated.length ? Math.round((rated.reduce((s, t) => s + t.csat_rating, 0) / rated.length) * 10) / 10 : null;
  res.json({
    byCategory,
    avgCsat,
    ratedCount: rated.length,
    totalTickets: tickets.length,
    openCount: tickets.filter((t) => t.status === 'Open').length,
    resolvedCount: tickets.filter((t) => ['Resolved', 'Closed'].includes(t.status)).length
  });
});

export default router;

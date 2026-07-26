import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

function withDetails(t) {
  const employee = db.prepare('SELECT name, employee_code FROM employees WHERE id = ?').get(t.employee_id);
  const assignee = t.assigned_to_employee_id ? db.prepare('SELECT name FROM employees WHERE id = ?').get(t.assigned_to_employee_id) : null;
  const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(t.id);
  return { ...t, employee_name: employee?.name, employee_code: employee?.employee_code, assignee_name: assignee?.name || null, comments };
}

// HR: dashboard of every ticket, with KPIs by status.
router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const tickets = db.prepare("SELECT * FROM tickets ORDER BY (status = 'Open') DESC, created_at DESC").all().map(withDetails);
  const count = (s) => tickets.filter((t) => t.status === s).length;
  res.json({
    kpis: [
      { label: 'Open', value: count('Open'), color: 'gold' },
      { label: 'In Progress', value: count('In Progress'), color: 'blue' },
      { label: 'Resolved', value: count('Resolved') + count('Closed'), color: 'green' }
    ],
    tickets
  });
});

// Employee self-service: my own tickets.
router.get('/my', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ tickets: [] });
  const tickets = db.prepare('SELECT * FROM tickets WHERE employee_id = ? ORDER BY created_at DESC').all(me.id).map(withDetails);
  res.json({ tickets });
});

router.get('/:id', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ ticket: withDetails(ticket) });
});

// Employee raises a new ticket.
router.post('/', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const { category, priority, subject, description } = req.body || {};
  if (!['IT', 'HR', 'Admin', 'Grievance', 'Other'].includes(category)) return res.status(400).json({ error: 'A valid category is required' });
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  const prio = ['Low', 'Medium', 'High'].includes(priority) ? priority : 'Medium';
  const info = db.prepare('INSERT INTO tickets (employee_id, category, priority, subject, description) VALUES (?, ?, ?, ?, ?)')
    .run(me.id, category, prio, subject.trim(), description || null);
  res.status(201).json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid)) });
});

// HR: update status and/or assign to a staff member.
router.put('/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status, assigned_to_employee_id } = req.body || {};
  const validStatus = status === undefined ? ticket.status : (['Open', 'In Progress', 'Resolved', 'Closed'].includes(status) ? status : ticket.status);
  const resolvedAt = (validStatus === 'Resolved' || validStatus === 'Closed') && !ticket.resolved_at ? new Date().toISOString().slice(0, 19).replace('T', ' ') : ticket.resolved_at;
  db.prepare('UPDATE tickets SET status = ?, assigned_to_employee_id = ?, resolved_at = ? WHERE id = ?')
    .run(validStatus, assigned_to_employee_id === undefined ? ticket.assigned_to_employee_id : (assigned_to_employee_id || null), resolvedAt, req.params.id);
  res.json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id)) });
});

// Both HR and the ticket's own employee can add a comment to the thread.
router.post('/:id/comments', (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const me = myEmployee(req.user.sub);
  if (!isHR(req.user.role) && ticket.employee_id !== me?.id) return res.status(403).json({ error: 'Insufficient permissions' });
  const { comment } = req.body || {};
  if (!comment?.trim()) return res.status(400).json({ error: 'Comment is required' });
  db.prepare('INSERT INTO ticket_comments (ticket_id, author_name, comment) VALUES (?, ?, ?)').run(ticket.id, req.user.name || 'Anonymous', comment.trim());
  res.status(201).json({ ticket: withDetails(db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id)) });
});

export default router;

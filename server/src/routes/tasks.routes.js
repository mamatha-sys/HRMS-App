import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.name AS assigned_to_name
    FROM tasks t JOIN users u ON u.id = t.assigned_to
    WHERE t.assigned_to = ? OR t.created_by = ?
    ORDER BY (t.status = 'Done'), t.due_date IS NULL, t.due_date ASC
  `).all(req.user.sub, req.user.sub);
  res.json({ tasks: rows });
});

router.post('/', (req, res) => {
  const { title, description, due_date, assigned_to } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  let assignee = req.user.sub;
  if (assigned_to && Number(assigned_to) !== req.user.sub) {
    if (req.user.role === 'employee') return res.status(403).json({ error: 'Employees can only create tasks for themselves' });
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(assigned_to);
    if (!target) return res.status(400).json({ error: 'assigned_to user not found' });
    assignee = target.id;
  }

  const info = db
    .prepare('INSERT INTO tasks (title, description, due_date, assigned_to, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(title, description || null, due_date || null, assignee, req.user.sub);
  res.status(201).json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.assigned_to !== req.user.sub && task.created_by !== req.user.sub && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const status = req.body?.status === 'Done' ? 'Done' : 'Pending';
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) });
});

export default router;

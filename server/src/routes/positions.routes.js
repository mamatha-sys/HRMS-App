import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

// Job requisitions: everything except already-rejected ones.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.approval_status != 'Rejected'
    ORDER BY p.status = 'Closed', p.created_at DESC
  `).all();
  res.json({ positions: rows });
});

router.post('/', requireRole('super_admin', 'manager'), (req, res) => {
  const { department_id, title, target_headcount } = req.body || {};
  if (!department_id || !title) return res.status(400).json({ error: 'department_id and title are required' });
  const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });

  const count = Math.max(1, parseInt(target_headcount, 10) || 1);
  const info = db
    .prepare("INSERT INTO positions (department_id, title, target_headcount, requested_by, approval_status) VALUES (?, ?, ?, ?, 'Pending Approval')")
    .run(department_id, title, count, req.user.name || null);
  res.status(201).json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', requireRole('super_admin', 'manager'), (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const status = req.body?.status === 'Closed' ? 'Closed' : 'Open';
  db.prepare('UPDATE positions SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Approve / reject a pending requisition.
router.put('/:id/decide', (req, res) => {
  if (!HR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  if (position.approval_status !== 'Pending Approval') return res.status(400).json({ error: 'This requisition has already been decided.' });
  const approve = req.body?.decision === 'approve';
  db.prepare("UPDATE positions SET approval_status = ?, status = ? WHERE id = ?")
    .run(approve ? 'Approved' : 'Rejected', approve ? 'Open' : 'Closed', req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Set which job boards an approved requisition is posted live on.
router.put('/:id/posting', (req, res) => {
  if (!HR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  if (position.approval_status !== 'Approved') return res.status(400).json({ error: 'Only an approved requisition can be posted.' });
  const boards = typeof req.body?.posted_boards === 'string' ? req.body.posted_boards.trim() : '';
  db.prepare('UPDATE positions SET posted_boards = ? WHERE id = ?').run(boards || null, req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Department-wise vacancies: current headcount (from employees) vs. open positions requested.
router.get('/vacancies', (req, res) => {
  const departments = db.prepare('SELECT * FROM departments').all();
  const vacancies = departments.map((dept) => {
    const current = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE department = ? AND status = 'Active'").get(dept.name).c;
    const openVacancies = db
      .prepare("SELECT COALESCE(SUM(target_headcount), 0) AS c FROM positions WHERE department_id = ? AND status = 'Open'")
      .get(dept.id).c;
    return {
      department_id: dept.id,
      department: dept.name,
      current,
      vacancies: openVacancies,
      target: current + openVacancies
    };
  }).filter((d) => d.vacancies > 0 || d.current > 0);

  res.json({ vacancies });
});

export default router;

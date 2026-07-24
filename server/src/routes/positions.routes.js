import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
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
    .prepare('INSERT INTO positions (department_id, title, target_headcount) VALUES (?, ?, ?)')
    .run(department_id, title, count);
  res.status(201).json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', requireRole('super_admin', 'manager'), (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const status = req.body?.status === 'Closed' ? 'Closed' : 'Open';
  db.prepare('UPDATE positions SET status = ? WHERE id = ?').run(status, req.params.id);
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

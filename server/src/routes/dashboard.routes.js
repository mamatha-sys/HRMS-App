import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

router.get('/summary', (req, res) => {
  if (req.user.role === 'employee') {
    const me = db.prepare('SELECT * FROM employees WHERE user_id = ?').get(req.user.sub);
    return res.json({ role: 'employee', me: me || null });
  }

  const total = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
  const active = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'Active'").get().c;
  const inactive = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'Inactive'").get().c;
  const departments = db.prepare('SELECT COUNT(DISTINCT department) AS c FROM employees').get().c;

  const kpis = [
    { label: 'Total Employees', value: total, color: 'blue' },
    { label: 'Active', value: active, color: 'green' },
    { label: 'Inactive', value: inactive, color: 'red' },
    { label: 'Departments', value: departments, color: 'gold' }
  ];

  const recentEmployees = db.prepare('SELECT * FROM employees ORDER BY id DESC LIMIT 5').all();
  const departmentBreakdown = db
    .prepare('SELECT department, COUNT(*) AS count FROM employees GROUP BY department ORDER BY count DESC')
    .all();

  res.json({ role: req.user.role, kpis, recentEmployees, departmentBreakdown });
});

export default router;

import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin', 'manager'));

const CSV_COLUMNS = [
  'employee_code', 'name', 'email', 'phone', 'department', 'branch', 'designation',
  'date_of_joining', 'reporting_manager', 'status'
];

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/employees.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM employees ORDER BY id').all();
  const lines = [CSV_COLUMNS.join(',')];
  rows.forEach((r) => lines.push(CSV_COLUMNS.map((c) => csvEscape(r[c])).join(',')));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.send(lines.join('\n'));
});

router.get('/summary', (req, res) => {
  const totalEmployees = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
  const byDepartment = db.prepare('SELECT department, COUNT(*) AS count FROM employees GROUP BY department').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS count FROM employees GROUP BY status').all();
  const openPositions = db.prepare("SELECT COALESCE(SUM(target_headcount),0) AS c FROM positions WHERE status = 'Open'").get().c;
  res.json({ totalEmployees, byDepartment, byStatus, openPositions });
});

export default router;

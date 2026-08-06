import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { CSV_FIELDS } from '../utils/employeeCsvFields.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin', 'manager'));

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Every built-in field (see employeeCsvFields.js) plus every active Super-Admin-defined custom
// field, appended as its own column keyed by the custom field's own key — so a full export round
// -trips cleanly back through bulk import without losing any data the form itself collects.
router.get('/employees.csv', (req, res) => {
  // ?id=<employee id> narrows this to a single employee — the same full-field export, just one
  // row — so "export this one employee" doesn't need a separate endpoint/column set to maintain.
  const employeeId = req.query.id ? Number(req.query.id) : null;
  const rows = employeeId
    ? db.prepare('SELECT * FROM employees WHERE id = ?').all(employeeId)
    : db.prepare('SELECT * FROM employees ORDER BY id').all();
  const customFields = db.prepare('SELECT * FROM employee_custom_fields WHERE active = 1 ORDER BY sort_order, id').all();
  const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);

  const headers = [...CSV_FIELDS.map((f) => f.key), ...customFields.map((f) => f.key)];
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    const customValues = db.prepare('SELECT field_id, value FROM employee_custom_field_values WHERE employee_id = ?').all(r.id);
    const byFieldId = {}; customValues.forEach((v) => { byFieldId[v.field_id] = v.value; });
    const rowValues = [
      ...CSV_FIELDS.map((f) => csvEscape(f.key === 'team' ? teamNameOf(r.team_id) : r[f.key])),
      ...customFields.map((f) => csvEscape(byFieldId[f.id]))
    ];
    lines.push(rowValues.join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `employee-${employeeId}` : 'employees'}.csv"`);
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

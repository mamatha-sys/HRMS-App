import { Router } from 'express';
import ExcelJS from 'exceljs';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { CSV_FIELDS } from '../utils/employeeCsvFields.js';

const router = Router();
router.use(requireAuth, requireRole('super_admin', 'manager', 'hr_admin'));

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

// Same field set as /employees.csv, plus photo and documents — a data URL and an array of
// {name, dataUrl} don't survive a CSV cell, so this is JSON instead. Shaped as {rows: [...]}, the
// exact input POST /api/employees/bulk expects, so exporting here and re-importing there round-
// trips an employee (or the whole roster) including their photo/documents without any conversion.
router.get('/employees.json', (req, res) => {
  const employeeId = req.query.id ? Number(req.query.id) : null;
  const rows = employeeId
    ? db.prepare('SELECT * FROM employees WHERE id = ?').all(employeeId)
    : db.prepare('SELECT * FROM employees ORDER BY id').all();
  const customFields = db.prepare('SELECT * FROM employee_custom_fields WHERE active = 1 ORDER BY sort_order, id').all();
  const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);

  const data = rows.map((r) => {
    const customValues = db.prepare('SELECT field_id, value FROM employee_custom_field_values WHERE employee_id = ?').all(r.id);
    const byFieldId = {}; customValues.forEach((v) => { byFieldId[v.field_id] = v.value; });
    const row = {};
    CSV_FIELDS.forEach((f) => { row[f.key] = f.key === 'team' ? teamNameOf(r.team_id) : r[f.key]; });
    row.photo = r.photo || null;
    row.documents = r.documents ? JSON.parse(r.documents) : [];
    customFields.forEach((f) => { row[f.key] = byFieldId[f.id] ?? null; });
    return row;
  });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `employee-${employeeId}` : 'employees'}-full.json"`);
  res.send(JSON.stringify({ rows: data }, null, 2));
});

// Same field set again, as an actual Excel workbook — a photo/document cell can't hold the real
// image/file data (see /employees.json above for that), so instead each becomes a clickable
// hyperlink cell pointing at the photo/document endpoints on this server (GET /api/employees/:id/
// photo and /:id/documents/:index). Those endpoints accept the token as a query param specifically
// so a link opened straight from Excel — no Authorization header attached — still works; it's the
// exporting user's own current token, reused as-is, so it's valid for exactly as long as their
// session already would be. Column headers are the same field keys as employees.csv/json, so a
// downloaded copy re-imports through Bulk Import's Excel option with no relabeling.
router.get('/employees.xlsx', async (req, res) => {
  const employeeId = req.query.id ? Number(req.query.id) : null;
  const rows = employeeId
    ? db.prepare('SELECT * FROM employees WHERE id = ?').all(employeeId)
    : db.prepare('SELECT * FROM employees ORDER BY id').all();
  const customFields = db.prepare('SELECT * FROM employee_custom_fields WHERE active = 1 ORDER BY sort_order, id').all();
  const teamNameOf = (id) => (id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(id)?.name : null);

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const origin = `${req.protocol}://${req.get('host')}`;

  const parsedRows = rows.map((r) => {
    let docs = [];
    try { docs = r.documents ? JSON.parse(r.documents) : []; } catch { docs = []; }
    return { r, docs };
  });
  const maxDocs = parsedRows.reduce((m, { docs }) => Math.max(m, docs.length), 0);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Employees');
  const headerKeys = [
    ...CSV_FIELDS.map((f) => f.key), ...customFields.map((f) => f.key),
    'photo', ...Array.from({ length: maxDocs }, (_, i) => `document_${i + 1}`)
  ];
  sheet.addRow(headerKeys).font = { bold: true };
  const photoCol = CSV_FIELDS.length + customFields.length + 1;
  const linkStyle = { font: { color: { argb: 'FF1155CC' }, underline: true } };

  parsedRows.forEach(({ r, docs }) => {
    const customValues = db.prepare('SELECT field_id, value FROM employee_custom_field_values WHERE employee_id = ?').all(r.id);
    const byFieldId = {}; customValues.forEach((v) => { byFieldId[v.field_id] = v.value; });
    const row = sheet.addRow([
      ...CSV_FIELDS.map((f) => (f.key === 'team' ? teamNameOf(r.team_id) : r[f.key])),
      ...customFields.map((f) => byFieldId[f.id] ?? null)
    ]);
    if (r.photo) {
      row.getCell(photoCol).value = { text: 'View Photo', hyperlink: `${origin}/api/employees/${r.id}/photo?token=${token}` };
      row.getCell(photoCol).font = linkStyle.font;
    }
    docs.forEach((d, i) => {
      const cell = row.getCell(photoCol + 1 + i);
      cell.value = { text: d.name || `Document ${i + 1}`, hyperlink: `${origin}/api/employees/${r.id}/documents/${i}?token=${token}` };
      cell.font = linkStyle.font;
    });
  });
  sheet.columns.forEach((col) => { col.width = 18; });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${employeeId ? `employee-${employeeId}` : 'employees'}-full.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

router.get('/summary', (req, res) => {
  const totalEmployees = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
  const byDepartment = db.prepare('SELECT department, COUNT(*) AS count FROM employees GROUP BY department').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS count FROM employees GROUP BY status').all();
  const openPositions = db.prepare("SELECT COALESCE(SUM(target_headcount),0) AS c FROM positions WHERE status = 'Open'").get().c;
  res.json({ totalEmployees, byDepartment, byStatus, openPositions });
});

export default router;

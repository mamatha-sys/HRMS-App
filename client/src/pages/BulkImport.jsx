import { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import api from '../api.js';

// Quote-aware CSV line splitter — handles a properly-quoted field containing a comma, an
// escaped "" inside a quoted field, and a whole line wrapped in one outer pair of quotes (a
// common export artifact from copying a spreadsheet column whose cells already contain commas —
// naive comma-splitting on that leaves stray quote characters stuck to the first/last header,
// so nothing matches the expected field names and every row looks empty/invalid).
function splitCsvLine(line) {
  let working = line.trim();
  if (working.length > 1 && working.startsWith('"') && working.endsWith('"')) {
    const inner = working.slice(1, -1);
    if (!inner.includes('"')) working = inner; // strip only the outer wrap, not a genuinely-quoted single field
  }
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < working.length; i++) {
    const ch = working[i];
    if (inQuotes) {
      if (ch === '"' && working[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else { cur += ch; }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

export default function BulkImport() {
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [scope, setScope] = useState(''); // '' = keep per-row / all departments
  const [defaultBranch, setDefaultBranch] = useState('');
  const [year, setYear] = useState('2026');
  const [month, setMonth] = useState('07');
  const [csv, setCsv] = useState('name,email,designation,department\nAsha Rao,asha.rao@example.com,Engineer,Engineering\nVikram Sen,vikram.sen@example.com,Analyst,QA');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [jsonFileRows, setJsonFileRows] = useState(null);
  const [jsonFileName, setJsonFileName] = useState('');

  useEffect(() => {
    api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {});
    api.get('/org/branches').then((r) => setBranches(r.data.branches)).catch(() => {});
  }, []);

  const rows = useMemo(() => parseCsv(csv), [csv]);

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result));
    reader.readAsText(file);
  }

  async function runImport() {
    setError(''); setResult(null);
    if (rows.length === 0) { setError('Nothing to import — add some CSV rows first.'); return; }
    try {
      const res = await api.post('/employees/bulk', {
        rows,
        defaultDepartment: scope || undefined,
        defaultBranch: defaultBranch || undefined,
        defaultJoiningDate: `${year}-${month}-01`
      });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed.');
    }
  }

  // A cell holding a hyperlink (Excel's "View Photo" / document-name links from Export (Excel))
  // comes back from ExcelJS as {text, hyperlink} rather than a plain value — pull the link out for
  // photo/document columns, and the plain text everywhere else.
  function cellPlainValue(cell) {
    const v = cell.value;
    if (v && typeof v === 'object' && 'hyperlink' in v) return { text: v.text ?? '', url: v.hyperlink };
    if (v && typeof v === 'object' && 'result' in v) return { text: v.result == null ? '' : String(v.result), url: null };
    if (v instanceof Date) return { text: v.toISOString().slice(0, 10), url: null };
    return { text: v == null ? '' : String(v), url: null };
  }

  // Mirrors Export (Excel)'s own column shape: field keys as headers, a 'photo' hyperlink column,
  // and 'document_1'..'document_N' hyperlink columns — reassembled back into the same
  // {photo, documents: [{name, dataUrl}]} shape the JSON path already produces, so both funnel
  // into the exact same POST /employees/bulk.
  async function parseXlsxRows(arrayBuffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => { headers[colNumber] = String(cell.value || '').trim(); });

    const parsedRows = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      if (row.cellCount === 0) continue;
      const obj = {};
      const documents = [];
      headers.forEach((header, colNumber) => {
        if (!header) return;
        const { text, url } = cellPlainValue(row.getCell(colNumber));
        if (header === 'photo') { obj.photo = url || text || null; return; }
        if (/^document_\d+$/.test(header)) { if (url || text) documents.push({ name: text || header, dataUrl: url || text }); return; }
        obj[header] = text || null;
      });
      if (documents.length) obj.documents = documents;
      if (Object.values(obj).some((v) => v)) parsedRows.push(obj);
    }
    return parsedRows;
  }

  // Employee Management's "Export (Full)" (JSON, {rows: [...]} or a bare array) or "Export
  // (Excel)" (.xlsx, photo/documents as clickable links) — either brings photo/documents back in,
  // which the plain CSV path above can't carry. Kept as its own file/rows source rather than
  // feeding the CSV textarea, since a data URL is far too long to usefully show or hand-edit as text.
  function onFullImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const isExcel = /\.xlsx$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        let parsedRows;
        if (isExcel) {
          parsedRows = await parseXlsxRows(reader.result);
        } else {
          const parsed = JSON.parse(String(reader.result));
          parsedRows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : null;
        }
        if (!parsedRows?.length) { setError('Could not find any employee rows in that file.'); return; }
        setJsonFileRows(parsedRows);
        setJsonFileName(file.name);
        setError('');
      } catch (err) {
        setError(`Could not parse that file — ${err.message || 'unknown error'}.`);
      }
    };
    if (isExcel) reader.readAsArrayBuffer(file); else reader.readAsText(file);
  }

  async function runJsonImport() {
    setError(''); setResult(null);
    if (!jsonFileRows || jsonFileRows.length === 0) { setError('Choose a Full Export JSON file first.'); return; }
    try {
      const res = await api.post('/employees/bulk', {
        rows: jsonFileRows,
        defaultDepartment: scope || undefined,
        defaultBranch: defaultBranch || undefined,
        defaultJoiningDate: `${year}-${month}-01`
      });
      setResult(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed.');
    }
  }

  async function downloadTemplate() {
    const res = await api.get('/employees/import-template.csv', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = 'employee-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Bulk Import Employees</h1>
      <div className="subtitle">
        Upload or paste a CSV — every employee field is supported (personal, address, employment, bank, education,
        plus any custom fields), not just the basics. Rows without a department/branch/joining date fall back to the
        defaults below.
      </div>

      {error && <div className="banner error">{error}</div>}

      <button style={{ marginBottom: 14 }} onClick={downloadTemplate}>⬇ Download Sample Template (all fields)</button>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Import options</div>
        <div className="grid2">
          <div>
            <label className="field-label">Department scope</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All departments (use each row's own)</option>
              {departments.map((d) => <option key={d.id} value={d.name}>Force all into: {d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">Default branch</label>
            <select value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)}>
              <option value="">— none —</option>
              {branches.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">Joining period — month</label>
            <select value={month} onChange={(e) => setMonth(e.target.value)}>
              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label">Joining period — year</label>
            <input value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>CSV data</div>
        <input type="file" accept=".csv,text/csv" onChange={onFile} style={{ marginBottom: 10 }} />
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12.5, padding: 10, borderRadius: 7, border: '1px solid #D7DBE2' }} />
        <div className="note" style={{ marginTop: 6 }}>{rows.length} row{rows.length === 1 ? '' : 's'} parsed.</div>
        <button className="primary" style={{ marginTop: 10 }} onClick={runImport}>Import {rows.length} employees</button>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 10 }}>Full Import (JSON or Excel) — includes photos &amp; documents</div>
        <div className="note" style={{ marginBottom: 8 }}>
          CSV above can't carry a photo or documents. Use a file from Employee Management's <strong>Export (Full)</strong> (JSON) or{' '}
          <strong>Export (Excel)</strong> button (all employees, or one) to bring those back in too — either format applies the same
          department scope/branch/joining defaults above. In Excel, Photo and Document columns are just clickable links, not embedded files.
        </div>
        <input type="file" accept=".json,application/json,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFullImportFile} />
        {jsonFileRows && <div className="note" style={{ marginTop: 6 }}>{jsonFileRows.length} employee{jsonFileRows.length === 1 ? '' : 's'} loaded from {jsonFileName}.</div>}
        <button className="primary" style={{ marginTop: 10 }} disabled={!jsonFileRows?.length} onClick={runJsonImport}>Import {jsonFileRows?.length || 0} employees (full)</button>
      </div>

      {result && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Import result</div>
          <div className="kpi-row">
            <div className="kpi-card green"><div className="kpi-label">Inserted</div><div className="kpi-value">{result.inserted}</div></div>
            <div className="kpi-card gold"><div className="kpi-label">Skipped (duplicate)</div><div className="kpi-value">{result.skipped}</div></div>
            <div className="kpi-card red"><div className="kpi-label">Errors</div><div className="kpi-value">{result.errors.length}</div></div>
            {result.payrollWarnings?.length > 0 && <div className="kpi-card gold"><div className="kpi-label">Payroll not configured</div><div className="kpi-value">{result.payrollWarnings.length}</div></div>}
          </div>
          {result.errors.length > 0 && result.errors.map((er, i) => <div key={i} className="feature-meta">• {er}</div>)}
          {result.payrollWarnings?.length > 0 && result.payrollWarnings.map((w, i) => <div key={i} className="feature-meta">• {w}</div>)}
        </div>
      )}
    </div>
  );
}

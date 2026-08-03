import { useEffect, useMemo, useState } from 'react';
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

  return (
    <div>
      <h1>Bulk Import Employees</h1>
      <div className="subtitle">Upload or paste a CSV (columns: name, email, designation, department, branch, phone). Rows without a department/branch/joining date fall back to the defaults below.</div>

      {error && <div className="banner error">{error}</div>}

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

      {result && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Import result</div>
          <div className="kpi-row">
            <div className="kpi-card green"><div className="kpi-label">Inserted</div><div className="kpi-value">{result.inserted}</div></div>
            <div className="kpi-card gold"><div className="kpi-label">Skipped (duplicate)</div><div className="kpi-value">{result.skipped}</div></div>
            <div className="kpi-card red"><div className="kpi-label">Errors</div><div className="kpi-value">{result.errors.length}</div></div>
          </div>
          {result.errors.length > 0 && result.errors.map((er, i) => <div key={i} className="feature-meta">• {er}</div>)}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function Payroll() {
  const { user } = useAuth();
  const canHR = HR_ROLES.includes(user?.role);
  return canHR ? <HRPayroll /> : <MyPayroll />;
}

function MyPayroll() {
  const [payslips, setPayslips] = useState([]);
  const [structure, setStructure] = useState(null);
  useEffect(() => {
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
    api.get('/payroll/structures').then((r) => setStructure(r.data.structures[0])).catch(() => {});
  }, []);

  function download(p) {
    const lines = [`Payslip — ${p.period}`, `Basic: ${p.basic}`, `HRA: ${p.hra}`, `Allowances: ${p.allowances}`, `Deductions: ${p.deductions}`, `Net: ${p.net}`];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `payslip-${p.period}.txt`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Payroll</h1>
      <div className="subtitle">Your salary structure and payslips.</div>
      {structure && (
        <div className="kpi-row">
          <div className="kpi-card blue"><div className="kpi-label">Basic</div><div className="kpi-value text">{inr(structure.basic)}</div></div>
          <div className="kpi-card green"><div className="kpi-label">HRA</div><div className="kpi-value text">{inr(structure.hra)}</div></div>
          <div className="kpi-card gold"><div className="kpi-label">Allowances</div><div className="kpi-value text">{inr(structure.allowances)}</div></div>
          <div className="kpi-card red"><div className="kpi-label">Net / month</div><div className="kpi-value text">{inr(structure.net)}</div></div>
        </div>
      )}
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My payslips</div>
        {payslips.length === 0 && <div className="empty">No payslips generated yet.</div>}
        {payslips.length > 0 && (
          <table>
            <thead><tr><th>Period</th><th>Basic</th><th>HRA</th><th>Allowances</th><th>Deductions</th><th>Net</th><th></th></tr></thead>
            <tbody>{payslips.map((p) => (
              <tr key={p.id}><td>{p.period}</td><td>{inr(p.basic)}</td><td>{inr(p.hra)}</td><td>{inr(p.allowances)}</td><td>{inr(p.deductions)}</td><td><strong>{inr(p.net)}</strong></td><td><button onClick={() => download(p)}>Download</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function HRPayroll() {
  const [structures, setStructures] = useState([]);
  const [payslips, setPayslips] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [period, setPeriod] = useState('July 2026');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});

  function load() {
    api.get('/payroll/structures').then((r) => setStructures(r.data.structures)).catch(() => setError('Could not load.'));
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
  }
  useEffect(load, []);

  function startEdit(s) { setEditing(s.employee_id); setDraft({ basic: s.basic, hra: s.hra, allowances: s.allowances, deductions: s.deductions }); }
  async function save(id) {
    setError('');
    try { await api.put(`/payroll/structures/${id}`, draft); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Save failed.'); }
  }
  async function runPayroll() {
    setError(''); setInfo('');
    try { const r = await api.post('/payroll/run', { period }); setInfo(`Payroll for ${period}: ${r.data.generated} payslip(s) generated, ${r.data.skipped} skipped.`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Run failed.'); }
  }

  return (
    <div>
      <h1>Payroll Management</h1>
      <div className="subtitle">Maintain salary structures and run payroll to generate payslips.</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="feature-name">Run payroll</div>
          <div style={{ flex: 1 }} />
          <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="e.g. July 2026" style={{ width: 'auto' }} />
          <button className="primary" onClick={runPayroll}>Run for period</button>
        </div>
        <div className="note" style={{ marginTop: 6 }}>Generates one payslip per Active employee from their current salary structure (skips periods already run).</div>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Salary structures</div>
        <div className="matrix-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Basic</th><th>HRA</th><th>Allowances</th><th>Deductions</th><th>Net</th><th></th></tr></thead>
            <tbody>{structures.map((s) => (
              <tr key={s.employee_id}>
                <td>{s.employee_code}</td><td>{s.name}</td>
                {editing === s.employee_id ? (
                  <>
                    {['basic', 'hra', 'allowances', 'deductions'].map((k) => (
                      <td key={k}><input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ width: 80 }} /></td>
                    ))}
                    <td>{inr((+draft.basic || 0) + (+draft.hra || 0) + (+draft.allowances || 0) - (+draft.deductions || 0))}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><button className="primary" onClick={() => save(s.employee_id)}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button></td>
                  </>
                ) : (
                  <>
                    <td>{inr(s.basic)}</td><td>{inr(s.hra)}</td><td>{inr(s.allowances)}</td><td>{inr(s.deductions)}</td>
                    <td><strong>{inr(s.net)}</strong></td>
                    <td><button onClick={() => startEdit(s)}>Edit</button></td>
                  </>
                )}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Generated payslips</div>
        {payslips.length === 0 && <div className="empty">No payslips yet — run payroll for a period.</div>}
        {payslips.length > 0 && (
          <table>
            <thead><tr><th>Period</th><th>Code</th><th>Name</th><th>Net</th></tr></thead>
            <tbody>{payslips.map((p) => (
              <tr key={p.id}><td>{p.period}</td><td>{p.employee_code}</td><td>{p.employee_name}</td><td><strong>{inr(p.net)}</strong></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

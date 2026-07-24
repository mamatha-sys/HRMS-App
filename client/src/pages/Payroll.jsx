import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

export default function Payroll() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRPayroll /> : <MyPayroll />;
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
      {structure && <SalaryBreakdown s={structure} />}
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

function SalaryBreakdown({ s, badge }) {
  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>{badge && <span className="widget-badge">{badge}</span>}Salary Structure</div>
      <div className="section-label" style={{ paddingLeft: 0, color: '#1E8E5A' }}>Earnings</div>
      <div className="rec-row"><span>Basic</span><span>{inr(s.basic)}</span></div>
      <div className="rec-row"><span>HRA</span><span>{inr(s.hra)}</span></div>
      <div className="rec-row"><span>Conveyance Allowance</span><span>{inr(s.conveyance)}</span></div>
      <div className="rec-row"><span>Special Allowance</span><span>{inr(s.special_allowance)}</span></div>
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Gross</span><span>{inr(s.gross)}</span></div>
      <div className="section-label" style={{ paddingLeft: 0, color: '#B3401E', marginTop: 6 }}>Deductions</div>
      <div className="rec-row"><span>PF (Provident Fund)</span><span>−{inr(s.pf)}</span></div>
      <div className="rec-row"><span>PT (Professional Tax)</span><span>−{inr(s.pt)}</span></div>
      <div className="rec-row"><span>TDS (Income Tax)</span><span>−{inr(s.tds)}</span></div>
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Total Deductions</span><span>−{inr(s.total_deductions)}</span></div>
      <div className="rec-row" style={{ fontWeight: 700, background: '#F2F4F8', borderRadius: 6, marginTop: 4 }}><span>Net Pay</span><span>{inr(s.net)}</span></div>
    </div>
  );
}

function HRPayroll() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [structures, setStructures] = useState([]);
  const [payslips, setPayslips] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [period, setPeriod] = useState('July 2026');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [showTable, setShowTable] = useState(false);

  function load() {
    api.get('/payroll/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load overview.'));
    api.get('/payroll/structures').then((r) => setStructures(r.data.structures)).catch(() => {});
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
  }
  useEffect(load, []);

  function startEdit(s) { setEditing(s.employee_id); setDraft({ basic: s.basic, hra: s.hra, conveyance: s.conveyance, special_allowance: s.special_allowance, pf: s.pf, pt: s.pt, tds: s.tds }); }
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
  async function exportCsv() {
    const lines = ['code,name,department,basic,hra,conveyance,special_allowance,pf,pt,tds,net', ...structures.map((s) => `${s.employee_code},${s.name},${s.department || ''},${s.basic},${s.hra},${s.conveyance},${s.special_allowance},${s.pf},${s.pt},${s.tds},${s.net}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'salary-structures.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Payroll Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="filter-bar">
        <select disabled><option>All Departments</option></select>
        <select disabled><option>Cycle</option></select>
        <div className="spacer" />
        <button className="primary" onClick={exportCsv}>Export</button>
      </div>

      {ov && (
        <div className="kpi-row">
          {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className={'kpi-value' + (typeof k.value === 'string' ? ' text' : '')}>{k.value}</div></div>)}
        </div>
      )}

      <div className="dashboard-grid">
        {ov && <SalaryBreakdown s={ov.structureTemplate} badge={1} />}
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>Quick Actions</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="e.g. July 2026" style={{ flex: '1 1 140px' }} />
            <button className="primary" onClick={runPayroll}>Run Payroll</button>
          </div>
          <button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowTable((v) => !v)}>
            {showTable ? '− Hide salary structures table' : '+ Configure salary structures'}
          </button>
          {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
        </div>
      </div>

      {showTable && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Salary structures</div>
          <div className="matrix-wrap">
            <table>
              <thead><tr><th>Code</th><th>Name</th><th>Basic</th><th>HRA</th><th>Conv.</th><th>Special</th><th>PF</th><th>PT</th><th>TDS</th><th>Net</th><th></th></tr></thead>
              <tbody>{structures.map((s) => (
                <tr key={s.employee_id}>
                  <td>{s.employee_code}</td><td>{s.name}</td>
                  {editing === s.employee_id ? (
                    <>
                      {['basic', 'hra', 'conveyance', 'special_allowance', 'pf', 'pt', 'tds'].map((k) => (
                        <td key={k}><input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ width: 70 }} /></td>
                      ))}
                      <td>{inr((+draft.basic || 0) + (+draft.hra || 0) + (+draft.conveyance || 0) + (+draft.special_allowance || 0) - (+draft.pf || 0) - (+draft.pt || 0) - (+draft.tds || 0))}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><button className="primary" onClick={() => save(s.employee_id)}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button></td>
                    </>
                  ) : (
                    <>
                      <td>{inr(s.basic)}</td><td>{inr(s.hra)}</td><td>{inr(s.conveyance)}</td><td>{inr(s.special_allowance)}</td>
                      <td>{inr(s.pf)}</td><td>{inr(s.pt)}</td><td>{inr(s.tds)}</td>
                      <td><strong>{inr(s.net)}</strong></td>
                      <td><button onClick={() => startEdit(s)}>Edit</button></td>
                    </>
                  )}
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

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

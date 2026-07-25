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
    const lines = [`Payslip — ${p.period}`, `Basic: ${p.basic}`, `HRA: ${p.hra}`, `Allowances: ${p.allowances}`, `Deductions: ${p.deductions}`, `Late-arrival half-day cut: ${p.late_deduction || 0}`, `Net: ${p.net}`];
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
            <thead><tr><th>Period</th><th>Basic</th><th>HRA</th><th>Allowances</th><th>Deductions</th><th>Late Cut</th><th>Net</th><th></th></tr></thead>
            <tbody>{payslips.map((p) => (
              <tr key={p.id}><td>{p.period}</td><td>{inr(p.basic)}</td><td>{inr(p.hra)}</td><td>{inr(p.allowances)}</td><td>{inr(p.deductions)}</td><td>{p.late_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.late_deduction)}</span> : inr(0)}</td><td><strong>{inr(p.net)}</strong></td><td><button onClick={() => download(p)}>Download</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Renders a breakdown built from dynamic components: s.earnings / s.deductions are
// [{component_id, key, label, amount}]. Works for both the overview's average template
// and a real per-employee structure.
function SalaryBreakdown({ s, badge }) {
  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>{badge && <span className="widget-badge">{badge}</span>}Salary Structure</div>
      <div className="section-label" style={{ paddingLeft: 0, color: '#1E8E5A' }}>Earnings</div>
      {s.earnings.map((e) => <div key={e.component_id || e.key} className="rec-row"><span>{e.label}</span><span>{inr(e.amount)}</span></div>)}
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Gross</span><span>{inr(s.gross)}</span></div>
      <div className="section-label" style={{ paddingLeft: 0, color: '#B3401E', marginTop: 6 }}>Deductions</div>
      {s.deductions.map((d) => <div key={d.component_id || d.key} className="rec-row"><span>{d.label}</span><span>−{inr(d.amount)}</span></div>)}
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Total Deductions</span><span>−{inr(s.totalDeductions)}</span></div>
      <div className="rec-row" style={{ fontWeight: 700, background: '#F2F4F8', borderRadius: 6, marginTop: 4 }}><span>Net Pay</span><span>{inr(s.net)}</span></div>
    </div>
  );
}

function HRPayroll() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [structures, setStructures] = useState([]);
  const [components, setComponents] = useState([]);
  const [payslips, setPayslips] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [month, setMonth] = useState('2026-07');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [showTable, setShowTable] = useState(false);
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [newComponent, setNewComponent] = useState({ label: '', type: 'earning' });
  const [tab, setTab] = useState('dashboard'); // dashboard | reports

  function load() {
    api.get('/payroll/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load overview.'));
    api.get('/payroll/structures').then((r) => { setStructures(r.data.structures); setComponents(r.data.components); }).catch(() => {});
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
  }
  useEffect(load, []);

  function startEdit(s) {
    setEditing(s.employee_id);
    const d = {};
    [...s.earnings, ...s.deductions].forEach((l) => { d[l.component_id] = l.amount; });
    setDraft(d);
  }
  async function save(id) {
    setError('');
    const lines = Object.entries(draft).map(([component_id, amount]) => ({ component_id: Number(component_id), amount }));
    try { await api.put(`/payroll/structures/${id}`, { lines }); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Save failed.'); }
  }
  async function runPayroll() {
    setError(''); setInfo('');
    try { const r = await api.post('/payroll/run', { month }); setInfo(`Payroll for ${r.data.period}: ${r.data.generated} payslip(s) generated, ${r.data.skipped} skipped.`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Run failed.'); }
  }
  async function addComponent(e) {
    e.preventDefault(); setError('');
    try { await api.post('/payroll/components', newComponent); setNewComponent({ label: '', type: 'earning' }); setShowAddComponent(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add component.'); }
  }
  async function toggleComponent(c) {
    setError('');
    try { await api.put(`/payroll/components/${c.id}`, { active: !c.active }); load(); } catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function exportCsv() {
    const header = ['code', 'name', ...components.map((c) => c.key), 'net'];
    const rows = structures.map((s) => {
      const byId = {}; [...s.earnings, ...s.deductions].forEach((l) => { byId[l.component_id] = l.amount; });
      return [s.employee_code, s.name, ...components.map((c) => byId[c.id] ?? 0), s.net].join(',');
    });
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
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

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? <PayrollReports /> : (
        <>
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
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ flex: '1 1 140px' }} />
                <button className="primary" onClick={runPayroll}>Run Payroll</button>
              </div>
              <div className="feature-meta" style={{ marginTop: 4 }}>Late arrivals beyond the free monthly allowance (see Configuration Policies) are auto-deducted as a half-day cut.</div>
              <button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowTable((v) => !v)}>
                {showTable ? '− Hide salary structures table' : '+ Configure salary structures'}
              </button>
              {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
            </div>
          </div>

          {showTable && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name">Salary structures</div>
                <button onClick={() => setShowAddComponent((v) => !v)}>{showAddComponent ? 'Cancel' : '+ Add salary component'}</button>
              </div>

              {showAddComponent && (
                <form onSubmit={addComponent} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                  <input placeholder="Component name (e.g. Bonus, LTA)" value={newComponent.label} onChange={(e) => setNewComponent({ ...newComponent, label: e.target.value })} required style={{ flex: '2 1 180px' }} />
                  <select value={newComponent.type} onChange={(e) => setNewComponent({ ...newComponent, type: e.target.value })}>
                    <option value="earning">Earning</option>
                    <option value="deduction">Deduction</option>
                  </select>
                  <button className="primary" type="submit">Add</button>
                </form>
              )}

              <div className="feature-meta" style={{ marginBottom: 8 }}>
                All components: {components.map((c) => (
                  <span key={c.id} className={'status-tag ' + (c.active ? (c.type === 'earning' ? 'present' : 'absent') : 'pending')} style={{ marginRight: 6, cursor: 'pointer' }} onClick={() => toggleComponent(c)} title="Click to pause/resume">
                    {c.label}{!c.active ? ' (paused)' : ''}
                  </span>
                ))}
              </div>

              <div className="matrix-wrap">
                <table>
                  <thead><tr><th>Code</th><th>Name</th>{components.map((c) => <th key={c.id}>{c.label}</th>)}<th>Net</th><th></th></tr></thead>
                  <tbody>{structures.map((s) => {
                    const byId = {}; [...s.earnings, ...s.deductions].forEach((l) => { byId[l.component_id] = l.amount; });
                    return (
                      <tr key={s.employee_id}>
                        <td>{s.employee_code}</td><td>{s.name}</td>
                        {editing === s.employee_id ? (
                          <>
                            {components.map((c) => (
                              <td key={c.id}><input value={draft[c.id] ?? 0} onChange={(e) => setDraft({ ...draft, [c.id]: e.target.value })} style={{ width: 70 }} /></td>
                            ))}
                            <td>{inr(components.reduce((t, c) => t + (c.type === 'earning' ? (+draft[c.id] || 0) : -(+draft[c.id] || 0)), 0))}</td>
                            <td style={{ whiteSpace: 'nowrap' }}><button className="primary" onClick={() => save(s.employee_id)}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button></td>
                          </>
                        ) : (
                          <>
                            {components.map((c) => <td key={c.id}>{inr(byId[c.id] ?? 0)}</td>)}
                            <td><strong>{inr(s.net)}</strong></td>
                            <td><button onClick={() => startEdit(s)}>Edit</button></td>
                          </>
                        )}
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Generated payslips</div>
            {payslips.length === 0 && <div className="empty">No payslips yet — run payroll for a period.</div>}
            {payslips.length > 0 && (
              <table>
                <thead><tr><th>Period</th><th>Code</th><th>Name</th><th>Late Cut</th><th>Net</th></tr></thead>
                <tbody>{payslips.map((p) => (
                  <tr key={p.id}><td>{p.period}</td><td>{p.employee_code}</td><td>{p.employee_name}</td><td>{p.late_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.late_deduction)}</span> : inr(0)}</td><td><strong>{inr(p.net)}</strong></td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PayrollReports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/payroll/reports').then((r) => setData(r.data)).catch(() => setError('Could not load reports.')); }, []);

  async function exportCsv() {
    const res = await api.get('/payroll/reports/export', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = url; a.download = 'payroll-report.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      {error && <div className="banner error">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}><button className="primary" onClick={exportCsv}>Export full report</button></div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Payroll by Period</div>
        {data && data.byPeriod.length === 0 && <div className="empty">No payroll runs yet.</div>}
        {data && data.byPeriod.length > 0 && (
          <table>
            <thead><tr><th>Period</th><th>Employees</th><th>Gross</th><th>Deductions</th><th>Late Cuts</th><th>Net Payout</th></tr></thead>
            <tbody>{data.byPeriod.map((p) => (
              <tr key={p.period}><td>{p.period}</td><td>{p.employees}</td><td>{inr(p.total_gross)}</td><td>{inr(p.total_deductions)}</td><td>{inr(p.total_late_deduction)}</td><td><strong>{inr(p.total_net)}</strong></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>Payout by Department (all-time)</div>
        {data && data.byDept.length === 0 && <div className="empty">No payslips yet.</div>}
        {data && data.byDept.length > 0 && (
          <table>
            <thead><tr><th>Department</th><th>Employees</th><th>Total Net</th></tr></thead>
            <tbody>{data.byDept.map((d) => (
              <tr key={d.department}><td>{d.department}</td><td>{d.employees}</td><td><strong>{inr(d.total_net)}</strong></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

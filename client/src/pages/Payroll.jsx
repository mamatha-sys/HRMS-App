import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own payslips.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin are employees too — they get their own payslips (MyPayroll)
// AND the company payroll admin view below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager'];
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
// Mirrors the server's splitCtc() exactly, so the CTC edit form can preview the breakdown live
// before HR saves — the server remains the source of truth (this is a preview only).
function splitCtcPreview(ctc, cfg) {
  const basic = Math.round(ctc * cfg['Basic % of CTC'] / 100);
  const hra = Math.round(basic * cfg['HRA % of Basic'] / 100);
  const employeePf = Math.min(Math.round(basic * cfg['Employee PF % of Basic'] / 100), cfg['Employee PF Monthly Cap']);
  const employerPf = Math.min(Math.round(basic * cfg['Employer PF % of Basic'] / 100), cfg['Employer PF Monthly Cap']);
  const gratuity = Math.round(basic * cfg['Gratuity % of Basic'] / 100);
  const pt = Math.round(cfg['Professional Tax (flat monthly)']);
  const bonus = Math.round(basic * cfg['Bonus % of Basic'] / 100);
  const fixedTotal = basic + hra + bonus + employerPf + gratuity;
  const specialAllowance = ctc - fixedTotal;
  return { basic, hra, bonus, special_allowance: specialAllowance, pf: employeePf, pt, employer_pf: employerPf, gratuity, valid: specialAllowance >= 0, minCtc: fixedTotal };
}
const inr2 = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (v) => (v == null || v === '' ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

// Open a blank tab FIRST (synchronously, inside the click handler) so the browser's popup
// blocker still sees this as a direct user action — filling it in only after the API call
// resolves would otherwise get it silently blocked in most browsers.
function openPayslip(payslipId) {
  const win = window.open('', '_blank');
  if (win) { win.document.write('<p style="font-family: sans-serif; padding: 24px;">Loading payslip…</p>'); win.document.close(); }
  api.get(`/payroll/payslips/${payslipId}`).then((r) => {
    if (!win) return;
    win.document.open();
    win.document.write(payslipHtml(r.data));
    win.document.close();
  }).catch(() => { if (win) win.document.body.innerHTML = '<p style="font-family: sans-serif; padding: 24px;">Could not load this payslip.</p>'; });
}

// A printable payslip matching a standard Indian payslip layout: company header, employee/
// statutory info grid, and itemized earnings/deductions (frozen at the time payroll ran — not
// today's live salary structure). Opens in a new tab; "Print / Save as PDF" uses the browser's
// own print dialog rather than a bundled PDF library.
function payslipHtml({ payslip, employee, company }) {
  const earnings = payslip.earnings || [];
  const deductionLines = [...(payslip.deductions || [])];
  if (payslip.late_deduction) deductionLines.push({ label: 'Late Arrival Half-day Cut', amount: payslip.late_deduction });
  if (payslip.lop_deduction) deductionLines.push({ label: `Loss of Pay (${payslip.lop_days} day${payslip.lop_days === 1 ? '' : 's'})`, amount: payslip.lop_deduction });
  const grossSalary = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductionLines.reduce((t, l) => t + l.amount, 0);
  const rowCount = Math.max(earnings.length, deductionLines.length, 1);

  const infoLeft = [
    ['Employee Code', employee?.employee_code],
    ['Employee Name', employee?.name],
    ['ESI Number', employee?.esi_number],
    ['Days Worked', payslip.days_worked ?? '—'],
    ['DOJ', employee?.date_of_joining],
    ['Department', employee?.department],
    ['Location', employee?.branch],
    ['Monthly Gross', '₹' + inr2(grossSalary)]
  ];
  const infoRight = [
    ['PAN Number', employee?.pan_number],
    ['UAN Number', employee?.uan_number],
    ['PF Number', employee?.pf_number],
    ['LOP Days', payslip.lop_days || 0],
    ['Month', payslip.period],
    ['Designation', employee?.designation],
    ['Bank A/C Number', employee?.bank_account_number],
    ['Bank Name', employee?.bank_name]
  ];

  const infoRowsHtml = infoLeft.map((l, i) => `
    <tr><td class="label">${esc(l[0])}</td><td>${esc(l[1]) || '—'}</td><td class="label">${esc(infoRight[i][0])}</td><td>${esc(infoRight[i][1]) || '—'}</td></tr>
  `).join('');

  const earnDedRowsHtml = Array.from({ length: rowCount }, (_, i) => {
    const e = earnings[i], d = deductionLines[i];
    return `<tr>
      <td>${e ? esc(e.label) : ''}</td><td>${e ? inr2(e.amount) : ''}</td>
      <td>${d ? esc(d.label) : ''}</td><td>${d ? inr2(d.amount) : ''}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Payslip — ${esc(employee?.name)} — ${esc(payslip.period)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 24px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 0; }
  td, th { border: 1px solid #333; padding: 6px 10px; font-size: 13px; vertical-align: top; text-align: left; }
  .label { font-weight: 600; width: 22%; }
  .logo-cell { width: 220px; text-align: center; }
  .logo-cell img { max-width: 200px; max-height: 90px; object-fit: contain; }
  .company-cell { font-size: 13px; line-height: 1.5; }
  .company-name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
  .section-title { text-align: center; font-weight: 700; background: #f2f2f2; }
  .totals td { font-weight: 700; }
  .footer { text-align: center; color: #2255aa; margin-top: 14px; font-size: 13px; }
  .toolbar { text-align: right; margin-bottom: 12px; }
  .toolbar button { padding: 8px 16px; font-size: 13px; cursor: pointer; }
  @media print { .toolbar { display: none; } body { margin: 0; } }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <table>
    <tr>
      <td class="logo-cell">${company?.company_logo ? `<img src="${company.company_logo}" alt="logo">` : ''}</td>
      <td class="company-cell">
        <div class="company-name">${esc(company?.company_name) || 'Company'}</div>
        <div>${esc(company?.company_address).replace(/\n/g, '<br>')}</div>
      </td>
    </tr>
  </table>
  <table>${infoRowsHtml}</table>
  <table>
    <tr><td class="section-title" colspan="2">EARNINGS</td><td class="section-title" colspan="2">DEDUCTIONS</td></tr>
    ${earnDedRowsHtml}
    <tr class="totals"><td>GROSS SALARY</td><td>${inr2(grossSalary)}</td><td>TOTAL DEDUCTIONS</td><td>${inr2(totalDeductions)}</td></tr>
    <tr class="totals"><td colspan="2"></td><td>NET SALARY<br><span style="font-weight:400;font-size:11px;">(Bank Transfer)</span></td><td>₹ ${inr2(payslip.net)}</td></tr>
  </table>
  <div class="footer">This is a computer generated payslip, needs no signature</div>
</body></html>`;
}

export default function Payroll() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRPayroll />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyPayroll compact /><HRPayroll compact sectionLabel="Company Payroll" /></>);
  return <MyPayroll />;
}

function MyPayroll({ compact }) {
  const [payslips, setPayslips] = useState([]);
  const [structure, setStructure] = useState(null);
  useEffect(() => {
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
    api.get('/payroll/structures').then((r) => setStructure(r.data.structures[0])).catch(() => {});
  }, []);

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Payroll</div> : <h1>Payroll</h1>}
      {!compact && <div className="subtitle">Your salary structure and payslips.</div>}
      {structure && <SalaryBreakdown s={structure} />}
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>My payslips</div>
        {payslips.length === 0 && <div className="empty">No payslips generated yet.</div>}
        {payslips.length > 0 && (
          <table>
            <thead><tr><th>Period</th><th>Basic</th><th>HRA</th><th>Allowances</th><th>Deductions</th><th>Late Cut</th><th>LOP</th><th>Net</th><th></th></tr></thead>
            <tbody>{payslips.map((p) => (
              <tr key={p.id}>
                <td>{p.period}</td><td>{inr(p.basic)}</td><td>{inr(p.hra)}</td><td>{inr(p.allowances)}</td><td>{inr(p.deductions)}</td>
                <td>{p.late_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.late_deduction)}</span> : inr(0)}</td>
                <td>{p.lop_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.lop_deduction)}</span> : inr(0)}</td>
                <td><strong>{inr(p.net)}</strong></td>
                <td><button onClick={() => openPayslip(p.id)}>View / Print</button></td>
              </tr>
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
function SalaryBreakdown({ s, badge, subtitle }) {
  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 8 }}>{badge && <span className="widget-badge">{badge}</span>}Salary Structure</div>
      {subtitle && <div className="feature-meta" style={{ marginBottom: 8 }}>{subtitle}</div>}
      <div className="section-label" style={{ paddingLeft: 0, color: '#1E8E5A' }}>Earnings</div>
      {s.earnings.map((e) => <div key={e.component_id || e.key} className="rec-row"><span>{e.label}</span><span>{inr(e.amount)}</span></div>)}
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Gross</span><span>{inr(s.gross)}</span></div>
      <div className="section-label" style={{ paddingLeft: 0, color: '#B3401E', marginTop: 6 }}>Deductions</div>
      {s.deductions.map((d) => <div key={d.component_id || d.key} className="rec-row"><span>{d.label}</span><span>−{inr(d.amount)}</span></div>)}
      <div className="rec-row" style={{ fontWeight: 700 }}><span>Total Deductions</span><span>−{inr(s.totalDeductions)}</span></div>
      <div className="rec-row" style={{ fontWeight: 700, background: '#F2F4F8', borderRadius: 6, marginTop: 4 }}><span>Net Pay</span><span>{inr(s.net)}</span></div>
      {s.employerCosts?.length > 0 && (
        <>
          <div className="section-label" style={{ paddingLeft: 0, marginTop: 6 }}>Employer Cost <span className="note">(not part of your take-home)</span></div>
          {s.employerCosts.map((e) => <div key={e.component_id} className="rec-row"><span>{e.label}</span><span>{inr(e.amount)}</span></div>)}
          <div className="rec-row" style={{ fontWeight: 700 }}><span>CTC</span><span>{inr(s.ctc)}</span></div>
        </>
      )}
    </div>
  );
}

function HRPayroll({ compact, sectionLabel }) {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [structures, setStructures] = useState([]);
  const [components, setComponents] = useState([]);
  const [payslips, setPayslips] = useState([]);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [month, setMonth] = useState('2026-07');
  const [editing, setEditing] = useState(null);
  const [ctcDraft, setCtcDraft] = useState('');
  const [showTable, setShowTable] = useState(false);
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [newComponent, setNewComponent] = useState({ label: '', type: 'earning' });
  const [tab, setTab] = useState('dashboard'); // dashboard | reports
  const [departments, setDepartments] = useState([]);
  const [filterDept, setFilterDept] = useState('');
  const [filterCycle, setFilterCycle] = useState('');
  const [splitConfig, setSplitConfig] = useState(null);
  const [showSplitConfig, setShowSplitConfig] = useState(false);
  const [splitDraft, setSplitDraft] = useState({});

  function load() {
    api.get('/payroll/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load overview.'));
    api.get('/payroll/structures').then((r) => { setStructures(r.data.structures); setComponents(r.data.components); }).catch(() => {});
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
    api.get('/payroll/split-config').then((r) => { setSplitConfig(r.data.config); setSplitDraft(r.data.config); }).catch(() => {});
  }
  useEffect(load, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);

  function startEdit(s) {
    setEditing(s.employee_id);
    setCtcDraft(s.enteredCtc || '');
  }
  async function save(id) {
    setError('');
    try { await api.put(`/payroll/structures/${id}/ctc`, { ctc: Number(ctcDraft) }); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Save failed.'); }
  }
  async function saveSplitConfig(e) {
    e.preventDefault(); setError(''); setInfo('');
    try {
      const r = await api.put('/payroll/split-config', splitDraft);
      setShowSplitConfig(false);
      setInfo(`Split settings saved${r.data.resplit ? ` — ${r.data.resplit} employee salary structure(s) recalculated` : ''}${r.data.skipped ? `, ${r.data.skipped} skipped (CTC too low for the new settings)` : ''}.`);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not save split settings.'); }
  }
  async function setPayType(employeeId, payType) {
    setError('');
    try { await api.put(`/payroll/structures/${employeeId}/pay-type`, { pay_type: payType }); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update pay type.'); }
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
  const filteredStructures = structures.filter((s) => !filterDept || s.department === filterDept);
  const filteredPayslips = payslips.filter((p) => !filterCycle || p.period === filterCycle);
  const cycleOptions = [...new Set(payslips.map((p) => p.period))];

  async function exportCsv() {
    const header = ['code', 'name', ...components.map((c) => c.key), 'net'];
    const rows = filteredStructures.map((s) => {
      const byId = {}; [...s.earnings, ...s.deductions].forEach((l) => { byId[l.component_id] = l.amount; });
      return [s.employee_code, s.name, ...components.map((c) => byId[c.id] ?? 0), s.net].join(',');
    });
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'salary-structures.csv'; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Payroll'}</div> : <h1>Payroll Management</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
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
            <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <select value={filterCycle} onChange={(e) => setFilterCycle(e.target.value)}>
              <option value="">Cycle</option>
              {cycleOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="spacer" />
            <button className="primary" onClick={exportCsv}>Export</button>
          </div>

          {ov && (
            <div className="kpi-row">
              {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className={'kpi-value' + (typeof k.value === 'string' ? ' text' : '')}>{k.value}</div></div>)}
            </div>
          )}

          <div className="dashboard-grid">
            {ov && (
              <SalaryBreakdown
                s={ov.structureTemplate}
                badge={1}
                subtitle="Standard Package reference structure — an illustrative example, not tied to any specific employee's actual pay."
              />
            )}
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
                  <span key={c.id} className={'status-tag ' + (c.active ? (c.type === 'earning' ? 'present' : c.type === 'deduction' ? 'absent' : 'info') : 'pending')} style={{ marginRight: 6, cursor: 'pointer' }} onClick={() => toggleComponent(c)} title="Click to pause/resume">
                    {c.label}{!c.active ? ' (paused)' : ''}
                  </span>
                ))}
              </div>

              <div className="feature-meta" style={{ marginBottom: 8 }}>
                Enter one CTC figure per employee — the system splits it into Basic, HRA, Bonus, Special Allowance, Employee PF, PT, Employer PF and Gratuity automatically, per the CTC Split Settings below. Components are no longer edited by hand.{' '}
                <strong>Stipend</strong>: a fixed {inr(10000)}/month, no deductions or add-ons.
              </div>

              <div className="matrix-wrap">
                <table>
                  <thead><tr><th>Code</th><th>Name</th><th>Pay Type</th>{components.map((c) => <th key={c.id}>{c.label}</th>)}<th>Net</th><th>CTC</th><th></th></tr></thead>
                  <tbody>{filteredStructures.map((s) => {
                    const byId = {}; [...s.earnings, ...s.deductions, ...(s.employerCosts || [])].forEach((l) => { byId[l.component_id] = l.amount; });
                    const isStipend = s.pay_type === 'Stipend';
                    const ctcNum = Number(ctcDraft) || 0;
                    const preview = splitConfig && ctcNum > 0 ? splitCtcPreview(ctcNum, splitConfig) : null;
                    return (
                      <tr key={s.employee_id}>
                        <td>{s.employee_code}</td><td>{s.name}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className={isStipend ? 'primary' : ''} onClick={() => setPayType(s.employee_id, 'Stipend')} style={{ marginRight: 4 }}>Stipend</button>
                          <button className={!isStipend ? 'primary' : ''} onClick={() => setPayType(s.employee_id, 'Package')}>Package</button>
                        </td>
                        {isStipend ? (
                          <>
                            <td colSpan={components.length} className="feature-meta">Fixed stipend — no components</td>
                            <td><strong>{inr(s.net)}</strong></td>
                            <td>{inr(s.ctc)}</td>
                            <td></td>
                          </>
                        ) : editing === s.employee_id ? (
                          <td colSpan={components.length + 2}>
                            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <span className="field-label" style={{ width: 'auto' }}>CTC (monthly)</span>
                              <input value={ctcDraft} onChange={(e) => setCtcDraft(e.target.value)} style={{ width: 100 }} />
                              <button className="primary" onClick={() => save(s.employee_id)} disabled={!preview?.valid}>Save</button>
                              <button onClick={() => setEditing(null)}>Cancel</button>
                              {preview && !preview.valid && <span className="feature-meta" style={{ color: '#B3401E' }}>Too low — minimum CTC is {inr(preview.minCtc)}</span>}
                            </div>
                            {preview?.valid && (
                              <div className="feature-meta" style={{ marginTop: 4 }}>
                                Preview — Basic {inr(preview.basic)} · HRA {inr(preview.hra)} · Bonus {inr(preview.bonus)} · Special Allowance {inr(preview.special_allowance)} · Employee PF {inr(preview.pf)} · PT {inr(preview.pt)} · Employer PF {inr(preview.employer_pf)} · Gratuity {inr(preview.gratuity)}
                              </div>
                            )}
                          </td>
                        ) : (
                          <>
                            {components.map((c) => <td key={c.id}>{inr(byId[c.id] ?? 0)}{c.withheld ? <span className="feature-meta"> (withheld)</span> : ''}</td>)}
                            <td><strong>{inr(s.net)}</strong></td>
                            <td>{inr(s.ctc)}</td>
                            <td><button onClick={() => startEdit(s)}>Edit CTC</button></td>
                          </>
                        )}
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </div>
          )}

          {user?.role === 'super_admin' && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name">CTC Split Settings</div>
                <button onClick={() => { setSplitDraft(splitConfig || {}); setShowSplitConfig((v) => !v); }}>{showSplitConfig ? 'Cancel' : 'Edit'}</button>
              </div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>How every employee's CTC is split into Basic/HRA/Bonus/Special Allowance/PF/PT/Gratuity. Special Allowance always absorbs whatever's left over, so the pieces reconcile exactly back to CTC.</div>
              {showSplitConfig ? (
                <form onSubmit={saveSplitConfig}>
                  <div className="grid2">
                    {Object.keys(splitDraft).map((name) => (
                      <div key={name}>
                        <label className="field-label">{name}</label>
                        <input value={splitDraft[name]} onChange={(e) => setSplitDraft({ ...splitDraft, [name]: e.target.value })} />
                      </div>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 12 }}><button className="primary" type="submit">Save split settings</button></div>
                </form>
              ) : splitConfig && (
                <div>
                  {Object.entries(splitConfig).map(([name, value]) => (
                    <div key={name} className="rec-row"><span>{name}</span><span>{value}{name.includes('%') ? '%' : ''}</span></div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Generated payslips</div>
            {payslips.length === 0 && <div className="empty">No payslips yet — run payroll for a period.</div>}
            {payslips.length > 0 && filteredPayslips.length === 0 && <div className="empty">No payslips match this filter.</div>}
            {filteredPayslips.length > 0 && (
              <table>
                <thead><tr><th>Period</th><th>Code</th><th>Name</th><th>Late Cut</th><th>LOP</th><th>Net</th><th></th></tr></thead>
                <tbody>{filteredPayslips.map((p) => (
                  <tr key={p.id}>
                    <td>{p.period}</td><td>{p.employee_code}</td><td>{p.employee_name}</td>
                    <td>{p.late_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.late_deduction)}</span> : inr(0)}</td>
                    <td>{p.lop_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.lop_deduction)}</span> : inr(0)}</td>
                    <td><strong>{inr(p.net)}</strong></td>
                    <td><button onClick={() => openPayslip(p.id)}>View</button></td>
                  </tr>
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

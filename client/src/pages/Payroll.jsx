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
// before HR saves — the server remains the source of truth (this is a preview only). Takes the
// same ANNUAL figure the input collects (matching Recruitment/Bulk Import's convention) and
// converts to monthly before splitting, just like the server does.
function splitCtcPreview(annualCtc, cfg) {
  const ctc = Math.round(annualCtc / 12);
  const basic = Math.round(ctc * cfg['Basic % of CTC'] / 100);
  const hra = Math.round(basic * cfg['HRA % of Basic'] / 100);
  const employeePf = Math.min(Math.round(basic * cfg['Employee PF % of Basic'] / 100), cfg['Employee PF Monthly Cap']);
  const employerPf = Math.min(Math.round(basic * cfg['Employer PF % of Basic'] / 100), cfg['Employer PF Monthly Cap']);
  const gratuity = Math.round(basic * cfg['Gratuity % of Basic'] / 100);
  const pt = Math.round(cfg['Professional Tax (flat monthly)']);
  const bonus = Math.round(basic * cfg['Bonus % of Basic'] / 100);
  const fixedTotal = basic + hra + bonus + employerPf + gratuity;
  const specialAllowance = ctc - fixedTotal;
  return { basic, hra, bonus, special_allowance: specialAllowance, pf: employeePf, pt, employer_pf: employerPf, gratuity, valid: specialAllowance >= 0, minCtc: fixedTotal * 12 };
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
  if (payslip.late_deduction) {
    const cuts = payslip.half_day_count || 0;
    deductionLines.push({
      label: `Late Arrival Half-day Cut${cuts ? ` (${cuts} day${cuts === 1 ? '' : 's'})` : ''}`,
      amount: payslip.late_deduction
    });
  }
  if (payslip.lop_deduction) {
    // Split the cause out on the payslip itself — "8 days LOP" reads as a payroll error unless it
    // says that 6 of them were days with no attendance record at all.
    const unmarked = payslip.unmarked_lop_days || 0;
    const marked = Math.max(0, (payslip.lop_days || 0) - unmarked);
    const causes = [marked && `${marked} absent`, unmarked && `${unmarked} not marked present`].filter(Boolean).join(', ');
    deductionLines.push({
      label: `Loss of Pay (${payslip.lop_days} day${payslip.lop_days === 1 ? '' : 's'}${causes ? ` — ${causes}` : ''})`,
      amount: payslip.lop_deduction
    });
  }
  if (payslip.sandwich_lop_deduction) deductionLines.push({ label: `Weekend Loss of Pay — Sandwich Rule (${payslip.sandwich_lop_days} day${payslip.sandwich_lop_days === 1 ? '' : 's'})`, amount: payslip.sandwich_lop_deduction });
  if (payslip.short_day_deduction) deductionLines.push({ label: `Short Day — hours worked below a full day (${payslip.short_days} day${payslip.short_days === 1 ? '' : 's'})`, amount: payslip.short_day_deduction });
  const grossSalary = earnings.reduce((t, l) => t + l.amount, 0);
  const totalDeductions = deductionLines.reduce((t, l) => t + l.amount, 0);
  const rowCount = Math.max(earnings.length, deductionLines.length, 1);
  // payslip.month is YYYY-MM; day 0 of the next month is the last day of this one.
  const daysInMonth = payslip.month ? new Date(Number(payslip.month.slice(0, 4)), Number(payslip.month.slice(5, 7)), 0).getDate() : null;
  // days_worked already carries the short-day fraction from the server; the late-arrival cut is
  // charged separately, so take that off here to get the honest days-paid figure (22.5, not 23).
  const effectiveDays = Math.max(0, (payslip.days_worked || 0) - 0.5 * (payslip.half_day_count || 0));

  const infoLeft = [
    ['Employee Code', employee?.employee_code],
    ['Employee Name', employee?.name],
    ['ESI Number', employee?.esi_number],
    ['Days Paid', payslip.days_worked != null ? `${effectiveDays}${daysInMonth ? ` of ${daysInMonth}` : ''}` : '—'],
    ['Late Arrivals', payslip.late_days || 0],
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
    ['Half-day Cuts', payslip.half_day_count || 0],
    ['Short Days', payslip.short_days || 0],
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
  const [attConfig, setAttConfig] = useState(null);
  const [attBooleans, setAttBooleans] = useState([]);
  const [attTimes, setAttTimes] = useState([]);
  const [preview, setPreview] = useState(null);
  // One set of filters for both Preview and Run Payroll, so a run always covers exactly the set
  // that was previewed rather than quietly generating for everyone.
  const [payFilters, setPayFilters] = useState({ employeeCode: '', name: '', department: '' });
  const payFilterParams = () => {
    const p = {};
    if (payFilters.employeeCode.trim()) p.employeeCode = payFilters.employeeCode.trim();
    if (payFilters.name.trim()) p.name = payFilters.name.trim();
    if (payFilters.department) p.department = payFilters.department;
    return p;
  };
  const [previewing, setPreviewing] = useState(false);
  const [splitConfig, setSplitConfig] = useState(null);
  const [showSplitConfig, setShowSplitConfig] = useState(false);
  const [splitDraft, setSplitDraft] = useState({});

  function load() {
    api.get('/payroll/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load overview.'));
    api.get('/payroll/structures').then((r) => { setStructures(r.data.structures); setComponents(r.data.components); }).catch(() => {});
    api.get('/payroll/payslips').then((r) => setPayslips(r.data.payslips)).catch(() => {});
    api.get('/payroll/split-config').then((r) => { setSplitConfig(r.data.config); setSplitDraft(r.data.config); }).catch(() => {});
    api.get('/payroll/attendance-pay-config').then((r) => { setAttConfig(r.data.config); setAttBooleans(r.data.booleans || []); setAttTimes(r.data.times || []); }).catch(() => {});
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
  async function loadPreview() {
    setError(''); setInfo(''); setPreviewing(true);
    try { const r = await api.get('/payroll/run-preview', { params: { month, ...payFilterParams() } }); setPreview(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not preview this run.'); }
    finally { setPreviewing(false); }
  }
  async function toggleAttendancePolicy(name, value) {
    setError(''); setInfo('');
    try {
      const r = await api.put('/payroll/attendance-pay-config', { ...attConfig, [name]: value });
      setAttConfig(r.data.config);
      setAttBooleans(r.data.booleans || attBooleans);
      setAttTimes(r.data.times || attTimes);
      if (preview) loadPreview();
    } catch (err) { setError(err.response?.data?.error || 'Could not save that setting.'); }
  }
  async function runPayroll() {
    setError(''); setInfo('');
    const filters = payFilterParams();
    const scope = Object.keys(filters).length
      ? ` (${[filters.employeeCode && `ID ~ ${filters.employeeCode}`, filters.name && `name ~ ${filters.name}`, filters.department].filter(Boolean).join(', ')})`
      : '';
    try { const r = await api.post('/payroll/run', { month, ...filters }); setPreview(null); setInfo(`Payroll for ${r.data.period}${scope}: ${r.data.generated} payslip(s) generated, ${r.data.skipped} skipped.`); load(); }
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
                <button onClick={loadPreview} disabled={previewing}>{previewing ? 'Checking…' : 'Preview'}</button>
                <button className="primary" onClick={runPayroll}>Run Payroll</button>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                <input placeholder="Employee ID…" value={payFilters.employeeCode}
                  onChange={(e) => setPayFilters({ ...payFilters, employeeCode: e.target.value })} style={{ flex: '1 1 110px' }} />
                <input placeholder="Employee name…" value={payFilters.name}
                  onChange={(e) => setPayFilters({ ...payFilters, name: e.target.value })} style={{ flex: '1 1 120px' }} />
                <select value={payFilters.department}
                  onChange={(e) => setPayFilters({ ...payFilters, department: e.target.value })} style={{ flex: '1 1 130px' }}>
                  <option value="">All Departments</option>
                  {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select>
                {(payFilters.employeeCode || payFilters.name || payFilters.department) && (
                  <button onClick={() => setPayFilters({ employeeCode: '', name: '', department: '' })}>Clear</button>
                )}
              </div>
              <div className="feature-meta" style={{ marginTop: 4 }}>
                Both Preview and Run Payroll use these filters — leave them blank to cover everyone.
                A run skips anyone already generated for the month, so you can run department by department.
              </div>
              <div className="feature-meta" style={{ marginTop: 4 }}>
                Pay follows attendance: days marked Present or on approved Leave are paid, days marked
                Absent are deducted, and each check-in later than the shift's grace period beyond the free
                monthly allowance (see Configuration Policies) costs half a day's pay. Someone who arrived on
                time may also leave early once a month without losing pay, provided they stayed past the
                earliest excusable hour — both of those are Configuration Policies too.
              </div>

              {attConfig && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #EEF0F3' }}>
                  <div className="feature-meta" style={{ marginBottom: 4 }}>How attendance affects pay{user?.role === 'super_admin' ? '' : ' (Super Admin can change these)'}</div>
                  {Object.keys(attConfig).map((name) => (
                    attBooleans.includes(name) ? (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 2 }}>
                        <input
                          type="checkbox"
                          checked={attConfig[name] === 1}
                          disabled={user?.role !== 'super_admin'}
                          onChange={(e) => toggleAttendancePolicy(name, e.target.checked)}
                          style={{ width: 'auto' }}
                        />
                        {name}
                      </label>
                    ) : attTimes.includes(name) ? (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 2 }}>
                        <input
                          type="time"
                          value={attConfig[name]}
                          disabled={user?.role !== 'super_admin'}
                          onChange={(e) => setAttConfig({ ...attConfig, [name]: e.target.value })}
                          onBlur={(e) => toggleAttendancePolicy(name, e.target.value)}
                          style={{ width: 110 }}
                        />
                        {name}
                      </label>
                    ) : (
                      <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginTop: 2 }}>
                        <input
                          type="number" min="0" step="0.5"
                          value={attConfig[name]}
                          disabled={user?.role !== 'super_admin'}
                          onChange={(e) => setAttConfig({ ...attConfig, [name]: e.target.value })}
                          onBlur={(e) => toggleAttendancePolicy(name, e.target.value)}
                          style={{ width: 70 }}
                        />
                        {name}
                      </label>
                    )
                  ))}
                  {attConfig['Unmarked working days are unpaid'] === 1 && (
                    <div className="feature-meta" style={{ marginTop: 4 }}>
                      A working day with no attendance record counts as Loss of Pay — so someone who
                      attended two days is paid for two days. Preview before running.
                    </div>
                  )}
                  <div className="feature-meta" style={{ marginTop: 4 }}>
                    {attConfig['Paid leave days per month']} approved leave day(s) a month are paid — the monthly
                    sick leave. Further approved leave that month is deducted, as is any leave type marked unpaid
                    in Leave Types.
                  </div>
                  {attConfig['Half day is measured by session'] === 1 && (
                    <div className="feature-meta" style={{ marginTop: 4 }}>
                      The day is two sessions split at {attConfig['Session split time']}, each worth half a day.
                      Working across the split earns the morning half; staying to shift end earns the afternoon half.
                      Lateness is not judged here — it has its own free monthly allowance.
                    </div>
                  )}
                  {attConfig['Pay by hours worked'] === 1 && attConfig['Half day is measured by session'] !== 1 && (
                    <div className="feature-meta" style={{ marginTop: 4 }}>
                      A full day worked earns one full day's salary. Under {attConfig['Minimum hours for a full day']}h
                      earns half a day, under {attConfig['Minimum hours for a half day']}h earns nothing for that day.
                      A day with no check-out is never docked — the hours are unknown, not zero.
                    </div>
                  )}
                </div>
              )}
              <button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowTable((v) => !v)}>
                {showTable ? '− Hide salary structures table' : '+ Configure salary structures'}
              </button>
              {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', marginTop: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
            </div>
          </div>

          {preview && (
            <div className="card">
              <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div className="feature-name">Preview — {preview.period}</div>
                  <div className="feature-meta">
                    Nothing has been saved yet. This is what Run Payroll would generate, using the attendance
                    on record for this month. Anyone already generated for this period is skipped by the run.
                  </div>
                </div>
                <div style={{ flex: 1 }} />
                <button onClick={() => setPreview(null)}>Close</button>
              </div>

              {preview.employees.some((p) => p.future_days > 0) && (
                <div className="banner info">
                  This month is not over yet — {Math.max(...preview.employees.map((p) => p.future_days || 0))} day(s)
                  have not happened, and are counted as paid rather than deducted. Run payroll after the month ends
                  for a final figure.
                </div>
              )}

              {preview.employees.some((p) => p.missing_checkout_days > 0) && (
                <div className="banner info">
                  {preview.employees.reduce((t, p) => t + (p.missing_checkout_days || 0), 0)} day(s) have a check-in but
                  no check-out, so the hours worked are unknown. Those days are paid in full and never docked — fix the
                  records in Attendance if any should have been short days.
                </div>
              )}

              {preview.employees.some((p) => p.days_worked === 0) && (
                <div className="banner error">
                  <strong>{preview.employees.filter((p) => p.days_worked === 0).length} employee(s) would be paid nothing</strong> — no attendance
                  is recorded for them this month. Check that attendance was actually marked before running payroll.
                </div>
              )}

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th><th>Name</th><th>Department</th><th>Days Paid</th><th>Absent</th><th>Not Marked</th>
                      <th title="Days checked in after the shift's grace period">Late</th>
                      <th title="Late days beyond the free monthly allowance — each cut half a day's pay">½-day Cuts</th>
                      <th title="Days worked below a full day — paid pro-rata from hours">Short</th>
                      <th title="On-time days that finished early but are excused by the monthly early-logout allowance — paid in full">Early Out (free)</th>
                      <th title="Approved leave paid under the monthly allowance">Leave (paid)</th>
                      <th title="Approved leave beyond the monthly allowance, or an unpaid leave type — deducted">Leave (unpaid)</th>
                      <th>Gross</th><th>LOP Cut</th><th>Late Cut</th><th>Short Cut</th><th>Net</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.employees.map((p) => (
                      <tr key={p.employee_id}>
                        <td>{p.employee_code}</td>
                        <td>{p.name}</td>
                        <td>{p.department}</td>
                        <td><strong>{p.days_worked}</strong> <span className="feature-meta">/ {p.total_days}</span></td>
                        <td>{p.absent_days || '—'}</td>
                        <td>{p.unmarked_days ? <span style={{ color: '#B3401E' }}>{p.unmarked_days}</span> : '—'}</td>
                        <td>{p.late_days || '—'}</td>
                        <td>{p.half_day_count ? <span style={{ color: '#B3401E' }}>{p.half_day_count}</span> : '—'}</td>
                        <td>{p.short_days ? <span style={{ color: '#B3401E' }} title={p.zero_hour_days ? `${p.zero_hour_days} of these earned nothing` : undefined}>{p.short_days}</span> : '—'}</td>
                        <td>{p.excused_early_logouts ? <span style={{ color: '#1E8E5A' }} title="Excused — paid in full">{p.excused_early_logouts}</span> : '—'}</td>
                        <td>{p.paid_leave_days ? <span style={{ color: '#1E8E5A' }}>{p.paid_leave_days}</span> : '—'}</td>
                        <td>{p.unpaid_leave_days ? <span style={{ color: '#B3401E' }}>{p.unpaid_leave_days}</span> : '—'}</td>
                        <td>{inr(p.gross)}</td>
                        <td>{p.lop_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.lop_deduction)}</span> : inr(0)}</td>
                        <td>{p.late_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.late_deduction)}</span> : inr(0)}</td>
                        <td>{p.short_day_deduction ? <span style={{ color: '#B3401E' }}>−{inr(p.short_day_deduction)}</span> : inr(0)}</td>
                        <td><strong>{inr(p.net)}</strong></td>
                        <td>{p.already_generated && <span className="status-tag info">already run</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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
                Enter one annual CTC figure per employee — the system splits it into monthly Basic, HRA, Bonus, Special Allowance, Employee PF, PT, Employer PF and Gratuity automatically, per the CTC Split Settings below. Components are no longer edited by hand.{' '}
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
                              <span className="field-label" style={{ width: 'auto' }}>CTC (annual)</span>
                              <input value={ctcDraft} onChange={(e) => setCtcDraft(e.target.value)} style={{ width: 100 }} />
                              <button className="primary" onClick={() => save(s.employee_id)} disabled={!preview?.valid}>Save</button>
                              <button onClick={() => setEditing(null)}>Cancel</button>
                              {preview && !preview.valid && <span className="feature-meta" style={{ color: '#B3401E' }}>Too low — minimum annual CTC is {inr(preview.minCtc)}</span>}
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

function PayrollComparison() {
  const [cmp, setCmp] = useState(null);
  const [error, setError] = useState('');
  const [explanation, setExplanation] = useState('');
  const [explaining, setExplaining] = useState(false);

  useEffect(() => { api.get('/payroll/monthly-comparison').then((r) => setCmp(r.data)).catch(() => setError('Could not load monthly comparison.')); }, []);

  async function explain() {
    setExplaining(true);
    setExplanation('');
    try {
      const res = await api.post('/payroll/monthly-comparison/explain', {
        current: cmp.current, previous: cmp.previous, newHires: cmp.newHires, exited: cmp.exited, biggestChanges: cmp.biggestChanges
      });
      setExplanation(res.data.explanation);
    } catch {
      setExplanation('Could not generate an AI explanation right now — the numbers above are still accurate.');
    } finally {
      setExplaining(false);
    }
  }

  if (error) return <div className="card"><div className="banner error">{error}</div></div>;
  if (!cmp) return null;

  if (!cmp.available) {
    return (
      <div className="card">
        <div className="feature-name" style={{ marginBottom: 8 }}>AI Monthly Comparison</div>
        <div className="empty">{cmp.message}</div>
      </div>
    );
  }

  const netDelta = cmp.current.totalNet - cmp.previous.totalNet;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="feature-name">AI Monthly Comparison — {cmp.current.month} vs {cmp.previous.month}</div>
        <button onClick={explain} disabled={explaining}>{explaining ? 'Thinking…' : 'AI Assist: Explain change'}</button>
      </div>
      <table>
        <thead><tr><th>Month</th><th>Employees</th><th>Total Net</th><th>Deductions</th><th>LOP</th><th>Late</th></tr></thead>
        <tbody>
          <tr><td>{cmp.previous.month}</td><td>{cmp.previous.headcount}</td><td>{inr(cmp.previous.totalNet)}</td><td>{inr(cmp.previous.totalDeductions)}</td><td>{inr(cmp.previous.totalLop)}</td><td>{inr(cmp.previous.totalLate)}</td></tr>
          <tr><td>{cmp.current.month}</td><td>{cmp.current.headcount}</td><td>{inr(cmp.current.totalNet)}</td><td>{inr(cmp.current.totalDeductions)}</td><td>{inr(cmp.current.totalLop)}</td><td>{inr(cmp.current.totalLate)}</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        Net payout change: <strong style={{ color: netDelta >= 0 ? 'var(--green, #16a34a)' : 'var(--red, #dc2626)' }}>{netDelta >= 0 ? '+' : ''}{inr(netDelta)}</strong>
      </div>
      {(cmp.newHires.length > 0 || cmp.exited.length > 0) && (
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--muted, #666)' }}>
          {cmp.newHires.length > 0 && <div>New hires: {cmp.newHires.join(', ')}</div>}
          {cmp.exited.length > 0 && <div>No longer on payroll: {cmp.exited.join(', ')}</div>}
        </div>
      )}
      {explanation && <div className="banner" style={{ marginTop: 10 }}>{explanation}</div>}
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

      <PayrollComparison />

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

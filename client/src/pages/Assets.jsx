import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Super Admin is a pure system-administrator account — admin overview only, no own assets.
const FULL_HR_ROLES = ['super_admin'];
// Manager/Assistant Manager/HR Admin/STL/TL are employees too — they get their own assigned
// assets (MyAssets) AND the asset admin view below it, rather than one replacing the other.
const SELF_AND_ADMIN_ROLES = ['manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];
const APPROVAL_AUTHORITY = ['super_admin', 'hr_admin'];
// Assistant Manager/STL/TL are limited to viewing their assigned department(s)/team(s) — per
// Super Admin policy, no create/edit/approve/manage actions here unless explicitly granted.
const CAN_MANAGE_ROLES = ['super_admin', 'manager', 'hr_admin'];
const STATUS_CLASS = { Assigned: 'present', 'In Store': 'info', 'Under Repair': 'pending', Disposed: 'absent' };

export default function Assets() {
  const { user } = useAuth();
  if (FULL_HR_ROLES.includes(user?.role)) return <HRAssets />;
  if (SELF_AND_ADMIN_ROLES.includes(user?.role)) return (<><MyAssets compact /><HRAssets compact sectionLabel="Company Assets" /></>);
  return <MyAssets />;
}

// Employee self-service: assets currently assigned to me, with Return / Damage / Regularization
// requests against them, plus a self-service "Request Asset" flow (New Asset — for when you
// don't have one, or need a replacement/loaner) that routes to HR's Asset Approval queue.
function MyAssets({ compact }) {
  const [screen, setScreen] = useState('dashboard');
  const [assets, setAssets] = useState([]);
  const [requests, setRequests] = useState([]);
  const [rules, setRules] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [requestFor, setRequestFor] = useState(null);
  const [requestType, setRequestType] = useState('Return');
  const [detail, setDetail] = useState('');

  function load() { api.get('/assets/my-assets').then((r) => { setAssets(r.data.assets); setRequests(r.data.requests); }).catch(() => {}); }
  useEffect(load, []);
  useEffect(() => { api.get('/assets/responsibility-rules').then((r) => setRules(r.data.rules)).catch(() => {}); }, []);

  // "Return" and "Damage" are separate, dedicated actions now — each opens straight to its own
  // reason field, rather than one shared form where you first have to pick a type from a dropdown.
  function openRequest(assetId, type) { setRequestFor(assetId); setRequestType(type); setDetail(''); }
  async function submitRequest(assetId) {
    setError(''); setInfo('');
    try {
      await api.post('/assets/requests', { asset_id: assetId, type: requestType, detail });
      setRequestFor(null); setDetail(''); setInfo('Request submitted to HR.'); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not submit request.'); }
  }

  if (screen === 'requestAsset') return <RequestNewAssetScreen onDone={() => { load(); setScreen('dashboard'); }} onBack={() => setScreen('dashboard')} />;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0 }}>My Assets</div> : <h1>Asset Management</h1>}
      {!compact && <div className="subtitle">Signed in as: Employee (Self-Service)</div>}
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">My Assets</div><div className="kpi-value">{assets.length}</div></div>
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">1</span>Asset Inventory</div>
          {assets.length === 0 && <div className="empty">No assets are currently assigned to you.</div>}
          {assets.map((a) => (
            <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{a.name}{a.category ? ` (${a.category})` : ''} <span className="feature-meta">{a.asset_tag}{a.serial_number ? ` · S/N: ${a.serial_number}` : ''}</span></strong>
                <span className={'status-tag ' + (STATUS_CLASS[a.status] || 'info')}>{a.status}</span>
              </div>
              {a.warranty_expiry && <div className="feature-meta">Warranty until {a.warranty_expiry}</div>}
              {requestFor === a.id ? (
                <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                  <span className="field-label" style={{ width: 'auto' }}>{requestType === 'Return' ? 'Request Return' : 'Report Damage'}:</span>
                  <input placeholder="Reason / details" value={detail} onChange={(e) => setDetail(e.target.value)} style={{ flex: '2 1 200px' }} />
                  <button className="primary" onClick={() => submitRequest(a.id)}>Submit</button>
                  <button onClick={() => setRequestFor(null)}>Cancel</button>
                </div>
              ) : (
                <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                  <button className="pill" onClick={() => openRequest(a.id, 'Return')}>Request Return</button>
                  <button className="pill" onClick={() => openRequest(a.id, 'Damage')}>Report Damage</button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>My Asset Requests</div>
          {requests.length === 0 && <div className="empty">You haven't submitted any asset requests yet.</div>}
          {requests.map((r) => (
            <div key={r.id} className="rec-row">
              <span>
                <strong>{r.type}</strong>
                {r.asset_name ? ` — ${r.asset_name} (${r.asset_tag})` : (r.category ? ` — ${r.category} · Urgency: ${r.urgency}` : '')}
                {r.detail ? `: ${r.detail}` : ''}
              </span>
              <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : (r.status === 'Rejected' ? 'absent' : 'pending'))}>{r.status}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Quick Actions</div>
          <button className="pill" style={{ width: '100%', textAlign: 'left' }} onClick={() => setScreen('requestAsset')}>Request Asset</button>
        </div>

        <div className="card" style={{ borderLeft: '4px solid #B3401E' }}>
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">4</span>Asset Responsibility Rules</div>
          {rules.split('\n').filter(Boolean).map((line, i) => <div key={i} className="feature-meta" style={{ marginBottom: 4 }}>• {line}</div>)}
        </div>
      </div>
    </div>
  );
}

// --- Employee's "Request Asset" Quick Action screen (a New Asset request — no asset_id yet,
// reviewed by HR via Asset Approval). ---
function RequestNewAssetScreen({ onDone, onBack }) {
  const [category, setCategory] = useState('');
  const [urgency, setUrgency] = useState('Medium');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!category.trim()) { setError('What kind of asset (category) is required.'); return; }
    setSaving(true);
    try { await api.post('/assets/requests', { type: 'New Asset', category, urgency, detail }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit request.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Request Asset</h1>
      <div className="subtitle">Ask HR to allocate you a new or replacement asset.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <form onSubmit={submit} className="card" style={{ maxWidth: 480 }}>
        <label className="field-label">Asset Type / Category *</label>
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Laptop" required style={{ marginBottom: 14 }} />
        <label className="field-label">Urgency</label>
        <select value={urgency} onChange={(e) => setUrgency(e.target.value)} style={{ marginBottom: 14 }}>
          <option value="Low">Low</option>
          <option value="Medium">Medium</option>
          <option value="High">High</option>
        </select>
        <label className="field-label">Reason</label>
        <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="e.g. Existing laptop under repair, need a loaner for daily work" style={{ marginBottom: 14 }} />
        <button className="primary" type="submit" disabled={saving}>Submit Request</button>
      </form>
    </div>
  );
}

function HRAssets({ compact, sectionLabel }) {
  const { user } = useAuth();
  const canManage = CAN_MANAGE_ROLES.includes(user?.role);
  const [screen, setScreen] = useState('dashboard');
  const [activeAsset, setActiveAsset] = useState(null);
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [requests, setRequests] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', category: '', cost: '', warranty_expiry: '', serial_number: '' });
  const [transferring, setTransferring] = useState(null);
  const [transferTo, setTransferTo] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [rules, setRules] = useState('');
  const [rulesDraft, setRulesDraft] = useState('');
  const [editingRules, setEditingRules] = useState(false);

  function load() { api.get('/assets/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load asset overview.')); }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { api.get('/org/departments').then((r) => setDepartments(r.data.departments)).catch(() => {}); }, []);
  useEffect(() => { if (screen === 'reports') api.get('/assets/reports').then((r) => setReports(r.data)).catch(() => {}); }, [screen]);
  useEffect(() => { if (screen === 'requests') api.get('/assets/requests').then((r) => setRequests(r.data.requests)).catch(() => {}); }, [screen]);
  useEffect(() => { api.get('/assets/responsibility-rules').then((r) => setRules(r.data.rules)).catch(() => {}); }, []);

  async function saveRules() {
    setError('');
    try { const r = await api.put('/assets/responsibility-rules', { rules: rulesDraft }); setRules(r.data.rules); setEditingRules(false); }
    catch (err) { setError(err.response?.data?.error || 'Could not save rules.'); }
  }

  function goto(target) { setScreen(target); }

  async function decide(id, decision) {
    setError('');
    try { await api.put(`/assets/${id}/decide`, { decision }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide.'); }
  }
  async function saveEdit(id) {
    setError('');
    try { await api.put(`/assets/${id}`, editDraft); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save asset.'); }
  }
  async function pauseAsset(a) {
    setError('');
    try { await api.put(`/assets/${a.id}/pause`, { paused: !!a.active }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update asset.'); }
  }
  async function transfer(id) {
    if (!transferTo) return;
    setError('');
    try { await api.put(`/assets/${id}/transfer`, { employee_id: transferTo }); setTransferring(null); setTransferTo(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not transfer asset.'); }
  }
  async function returnAsset(id) {
    setError('');
    try { await api.put(`/assets/${id}/return`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not return asset.'); }
  }
  async function toggleRepair(id, underRepair) {
    setError('');
    try { await api.put(`/assets/${id}/repair`, { under_repair: underRepair }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update asset.'); }
  }
  async function dispose(id) {
    if (!window.confirm('Mark this asset as disposed? This cannot be undone.')) return;
    setError('');
    try { await api.put(`/assets/${id}/dispose`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not dispose asset.'); }
  }

  const assetTypes = [...new Set((ov?.assets || []).map((a) => a.category).filter(Boolean))];
  const q = search.trim().toLowerCase();
  const filteredAssets = (ov?.assets || []).filter((a) =>
    (!filterDept || a.assigned_employee_department === filterDept) &&
    (!filterStatus || a.status === filterStatus) &&
    (!filterType || a.category === filterType) &&
    (!q || [a.name, a.asset_tag, a.serial_number, a.category, a.assigned_employee_name].filter(Boolean).some((v) => v.toLowerCase().includes(q)))
  );
  const SORTERS = {
    name: (a, b) => a.name.localeCompare(b.name),
    newest: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    status: (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name)
  };
  const sortedAssets = [...filteredAssets].sort(SORTERS[sortBy] || SORTERS.name);
  const totalPages = Math.max(1, Math.ceil(sortedAssets.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageAssets = sortedAssets.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filterDept, filterStatus, filterType, search, sortBy]);

  function exportAssetsCsv() {
    const lines = ['name,category,asset_tag,status,assigned_to,department,cost',
      ...filteredAssets.map((a) => `${a.name},${a.category || ''},${a.asset_tag || ''},${a.status},${a.assigned_employee_name || ''},${a.assigned_employee_department || ''},${a.cost || ''}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'asset-inventory.csv'; a.click(); URL.revokeObjectURL(url);
  }
  async function audit(id) {
    setError('');
    try { await api.post(`/assets/${id}/audit`, {}); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not log audit.'); }
  }
  async function decideRequest(id, decision) {
    setError('');
    try { await api.put(`/assets/requests/${id}/decide`, { decision }); api.get('/assets/requests').then((r) => setRequests(r.data.requests)); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not decide request.'); }
  }

  if (screen === 'newAsset') return <NewAssetScreen onDone={() => { load(); goto('dashboard'); }} onCancel={() => goto('dashboard')} />;
  if (screen === 'assign' && activeAsset) return <AssignAssetScreen asset={activeAsset} employees={employees} onDone={() => { load(); goto('dashboard'); }} onCancel={() => goto('dashboard')} />;
  if (screen === 'transfer') return <TransferReturnScreen assets={ov?.assets || []} employees={employees} onChanged={load} onBack={() => goto('dashboard')} />;
  if (screen === 'return') return <ReturnScreen assets={ov?.assets || []} onChanged={load} onBack={() => goto('dashboard')} />;
  if (screen === 'maintenance') return <MaintenanceScreen assets={ov?.assets || []} onChanged={load} onBack={() => goto('dashboard')} />;
  if (screen === 'tracking') return <TrackingScreen assets={ov?.assets || []} onBack={() => goto('dashboard')} />;
  if (screen === 'disposal') return <DisposalScreen assets={ov?.assets || []} onChanged={load} onBack={() => goto('dashboard')} />;
  if (screen === 'audit') return <AuditScreen onBack={() => goto('dashboard')} />;

  return (
    <div>
      {compact ? <div className="section-label" style={{ paddingLeft: 0, marginTop: 18 }}>{sectionLabel || 'Company Assets'}</div> : <h1>Asset Management</h1>}
      {!compact && <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>}
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={screen === 'dashboard' ? 'primary' : ''} onClick={() => goto('dashboard')}>Dashboard</button>
        {canManage && <button className={screen === 'requests' ? 'primary' : ''} onClick={() => goto('requests')}>Asset Requests</button>}
        {canManage && <button className={screen === 'reports' ? 'primary' : ''} onClick={() => goto('reports')}>Reports</button>}
      </div>

      {screen === 'requests' ? (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Asset Approval — Return / Damage / Regularization / New Asset</div>
          {!requests && <div className="empty">Loading…</div>}
          {requests && requests.length === 0 && <div className="empty">No requests yet.</div>}
          {requests && requests.map((r) => (
            <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{r.type}</strong> — {r.asset_name ? `${r.asset_name} (${r.asset_tag})` : `${r.category} · Urgency: ${r.urgency}`} · {r.employee_name} ({r.employee_code})
                </span>
                <span className={'status-tag ' + (r.status === 'Approved' ? 'present' : (r.status === 'Rejected' ? 'absent' : 'pending'))}>{r.status}</span>
              </div>
              {r.detail && <div className="feature-meta">{r.detail}</div>}
              {r.status === 'Pending' && (
                <div style={{ marginTop: 6 }}>
                  <button className="btn-approve" onClick={() => decideRequest(r.id, 'approve')}>Approve</button>
                  <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decideRequest(r.id, 'reject')}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : screen === 'reports' ? (
        <>
          {reports && (
            <div className="kpi-row">
              <div className="kpi-card blue"><div className="kpi-label">Total Assets</div><div className="kpi-value">{reports.totalAssets}</div></div>
              <div className="kpi-card green"><div className="kpi-label">Total Value</div><div className="kpi-value text">₹{reports.totalValue.toLocaleString('en-IN')}</div></div>
            </div>
          )}
          <div className="dashboard-grid">
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>By Category</div>
              {!reports && <div className="empty">Loading…</div>}
              {reports && (
                <table>
                  <thead><tr><th>Category</th><th>Count</th><th>Total Cost</th></tr></thead>
                  <tbody>{reports.byCategory.map((c) => (
                    <tr key={c.category}><td>{c.category}</td><td>{c.count}</td><td>₹{c.totalCost.toLocaleString('en-IN')}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}>By Status</div>
              {reports && reports.byStatus.map((s) => (
                <div key={s.status} className="rec-row"><span>{s.status}</span><span>{s.count}</span></div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="filter-bar">
            <input placeholder="Search name, tag, serial…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '1 1 180px' }} />
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All Asset Types</option>
              {assetTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="Assigned">Assigned</option>
              <option value="In Store">In Store</option>
              <option value="Under Repair">Under Repair</option>
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">Sort: Name (A–Z)</option>
              <option value="newest">Sort: Newest First</option>
              <option value="status">Sort: Status</option>
            </select>
            <div className="spacer" />
            {canManage && <button className="primary" onClick={exportAssetsCsv}>Export</button>}
          </div>

          {ov && (
            <div className="kpi-row">
              {ov.kpis.map((k) => <div key={k.label} className={'kpi-card ' + k.color}><div className="kpi-label">{k.label}</div><div className="kpi-value">{k.value}</div></div>)}
            </div>
          )}

          <div className="dashboard-grid">
            <div className="card" id="section-inventory">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name"><span className="widget-badge">1</span>Asset Inventory</div>
                {canManage && <button className="primary" onClick={() => goto('newAsset')}>+ Add Asset</button>}
              </div>
              {canManage && !APPROVAL_AUTHORITY.includes(user?.role) && <div className="feature-meta" style={{ marginBottom: 8 }}>Assets you add require Super Admin/HR Admin approval before they can be assigned.</div>}
              {filteredAssets.length > 0 && (
                <div className="feature-meta" style={{ marginBottom: 6 }}>
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredAssets.length)} of {filteredAssets.length}
                </div>
              )}
              {filteredAssets.length === 0 && <div className="empty">No assets{ov?.assets.length ? ' match this filter.' : ' yet.'}</div>}
              {pageAssets.map((a) => (
                <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0', opacity: a.active ? 1 : 0.55 }}>
                  {editing === a.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); saveEdit(a.id); }} className="row" style={{ flexWrap: 'wrap' }}>
                      <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} style={{ flex: '2 1 160px' }} />
                      <input value={editDraft.category} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })} placeholder="Category" style={{ flex: '1 1 100px' }} />
                      <input value={editDraft.serial_number} onChange={(e) => setEditDraft({ ...editDraft, serial_number: e.target.value })} placeholder="Serial Number" style={{ flex: '1 1 120px' }} />
                      <input type="number" value={editDraft.cost} onChange={(e) => setEditDraft({ ...editDraft, cost: e.target.value })} placeholder="Cost" style={{ flex: '1 1 90px' }} />
                      <input type="date" value={editDraft.warranty_expiry} onChange={(e) => setEditDraft({ ...editDraft, warranty_expiry: e.target.value })} style={{ flex: '1 1 140px' }} />
                      <button className="primary" type="submit">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                        <strong>{a.name}{a.category ? ` (${a.category})` : ''} <span className="feature-meta">{a.asset_tag}{a.serial_number ? ` · S/N: ${a.serial_number}` : ''}</span></strong>
                        <span style={{ display: 'flex', gap: 6 }}>
                          {a.approval_status === 'Pending Approval' && <span className="status-tag pending">Pending Approval</span>}
                          {!a.active && <span className="status-tag absent">Paused</span>}
                          <span className={'status-tag ' + (STATUS_CLASS[a.status] || 'info')}>{a.status}</span>
                        </span>
                      </div>
                      <div className="feature-meta">
                        Assigned to: {a.assigned_employee_name ? `${a.assigned_employee_name} (${a.assigned_employee_code})` : '—'}
                        {a.cost != null ? ` · Cost: ₹${Number(a.cost).toLocaleString('en-IN')}` : ''}
                        {a.warranty_expiry ? ` · Warranty until ${a.warranty_expiry}` : ''}
                      </div>

                      {a.approval_status === 'Pending Approval' && canManage && APPROVAL_AUTHORITY.includes(user?.role) && (
                        <div style={{ marginTop: 6 }}>
                          <button className="btn-approve" onClick={() => decide(a.id, 'approve')}>Approve</button>
                          <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(a.id, 'reject')}>Reject</button>
                        </div>
                      )}

                      {a.approval_status !== 'Pending Approval' && a.status !== 'Disposed' && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {canManage && (
                            <>
                              <button onClick={() => { setEditing(a.id); setEditDraft({ name: a.name, category: a.category || '', cost: a.cost ?? '', warranty_expiry: a.warranty_expiry || '', serial_number: a.serial_number || '' }); }}>Edit</button>
                              <button onClick={() => pauseAsset(a)}>{a.active ? 'Pause' : 'Resume'}</button>
                              {a.status === 'Assigned' && <button onClick={() => returnAsset(a.id)}>Return</button>}
                              {a.status === 'Assigned' && (
                                transferring === a.id ? (
                                  <span className="row" style={{ display: 'inline-flex' }}>
                                    <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} style={{ width: 'auto' }}>
                                      <option value="">Transfer to…</option>
                                      {employees.filter((e) => e.id !== a.assigned_employee_id).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                                    </select>
                                    <button className="primary" onClick={() => transfer(a.id)}>Transfer</button>
                                    <button onClick={() => setTransferring(null)}>Cancel</button>
                                  </span>
                                ) : <button onClick={() => setTransferring(a.id)}>Transfer</button>
                              )}
                              {a.status === 'In Store' && a.active && <button onClick={() => { setActiveAsset(a); goto('assign'); }}>Assign</button>}
                              {a.status !== 'Under Repair' && <button onClick={() => toggleRepair(a.id, true)}>Send for Repair</button>}
                              {a.status === 'Under Repair' && <button onClick={() => toggleRepair(a.id, false)}>Back In Store</button>}
                              {a.status !== 'Assigned' && <button onClick={() => dispose(a.id)}>Dispose</button>}
                              <button onClick={() => audit(a.id)}>Log Audit</button>
                            </>
                          )}
                          <button onClick={() => setExpanded(expanded === a.id ? null : a.id)}>{expanded === a.id ? 'Hide history' : 'History'}</button>
                        </div>
                      )}

                      {expanded === a.id && (
                        <div style={{ marginTop: 8, paddingLeft: 8 }}>
                          {a.history.length === 0 && <div className="feature-meta">No history yet.</div>}
                          {a.history.map((h) => <div key={h.id} className="feature-meta">— <strong>{h.action}</strong>{h.detail ? `: ${h.detail}` : ''} ({h.created_at})</div>)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {totalPages > 1 && (
                <div className="row" style={{ justifyContent: 'center', gap: 10, marginTop: 10 }}>
                  <button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>← Prev</button>
                  <span className="feature-meta">Page {currentPage} of {totalPages}</span>
                  <button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Next →</button>
                </div>
              )}
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Each feature opens its own screen.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {/* Non-canManage (Assistant Manager/STL/TL) only get view-safe screens — every
                    other screen here drives a write endpoint (add/transfer/maintain/dispose/
                    approve/report) that's now blocked server-side for them. */}
                {ov?.keyFeatures.filter((f) => canManage || ['dashboard', 'tracking'].includes(f.screen)).map((f) => <button key={f.key} className="pill" onClick={() => goto(f.screen)}>{f.label}</button>)}
              </div>
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Field-Level Access</div>
              {ov?.fieldAccess.map((f) => (
                <div key={f.field} className="rec-row"><span>{f.field}</span><span className="status-tag present">{f.access}</span></div>
              ))}
            </div>

            <div className="card" style={{ borderLeft: '4px solid #B3401E' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div className="feature-name"><span className="widget-badge">4</span>Asset Responsibility Rules</div>
                {user?.role === 'super_admin' && !editingRules && <button onClick={() => { setRulesDraft(rules); setEditingRules(true); }}>Edit</button>}
              </div>
              {editingRules ? (
                <div>
                  <textarea value={rulesDraft} onChange={(e) => setRulesDraft(e.target.value)} rows={7}
                    style={{ width: '100%', fontSize: 13, padding: 8, borderRadius: 7, border: '1px solid #D7DBE2' }} />
                  <div className="feature-meta" style={{ marginTop: 4, marginBottom: 8 }}>One rule per line.</div>
                  <button className="primary" onClick={saveRules}>Save</button>
                  <button style={{ marginLeft: 6 }} onClick={() => setEditingRules(false)}>Cancel</button>
                </div>
              ) : (
                rules.split('\n').filter(Boolean).map((line, i) => <div key={i} className="feature-meta" style={{ marginBottom: 4 }}>• {line}</div>)
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Dedicated "Add Asset" screen. ---
function NewAssetScreen({ onDone, onCancel }) {
  const [form, setForm] = useState({ name: '', category: '', cost: '', warranty_expiry: '', serial_number: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!form.name.trim()) { setError('Asset name is required'); return; }
    setSaving(true);
    try { await api.post('/assets', form); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add asset.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Add Asset</h1>
      <div className="subtitle">Register a new asset into the inventory.</div>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={submit} className="card" style={{ maxWidth: 480 }}>
        <label className="field-label">Asset Name *</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dell Latitude 5440" required style={{ marginBottom: 14 }} />
        <label className="field-label">Category</label>
        <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Laptop" style={{ marginBottom: 14 }} />
        <label className="field-label">Serial Number</label>
        <input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} placeholder="e.g. SN-8842-XJ" style={{ marginBottom: 14 }} />
        <label className="field-label">Cost</label>
        <input type="number" min="0" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} style={{ marginBottom: 14 }} />
        <label className="field-label">Warranty Expiry</label>
        <input type="date" value={form.warranty_expiry} onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })} style={{ marginBottom: 14 }} />
        <div className="row">
          <button type="submit" className="primary" disabled={saving} style={{ flex: 1 }}>Add Asset</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// --- Dedicated "Assign Asset" screen. ---
function AssignAssetScreen({ asset, employees, onDone, onCancel }) {
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!employeeId) { setError('Select an employee'); return; }
    setSaving(true);
    try { await api.put(`/assets/${asset.id}/assign`, { employee_id: employeeId }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign asset.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Assign Asset</h1>
      <div className="subtitle">{asset.name}{asset.category ? ` (${asset.category})` : ''} · {asset.asset_tag}{asset.serial_number ? ` · S/N: ${asset.serial_number}` : ''}</div>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={submit} className="card" style={{ maxWidth: 480 }}>
        <label className="field-label">Assign to *</label>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required style={{ marginBottom: 14 }}>
          <option value="">Select an active employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code}) · {e.department}</option>)}
        </select>
        <div className="row">
          <button type="submit" className="primary" disabled={saving} style={{ flex: 1 }}>Assign</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// --- Dedicated "Asset Transfer" screen (handover from one employee to another). Return is its
// own separate screen — see ReturnScreen below. ---
function TransferReturnScreen({ assets, employees, onChanged, onBack }) {
  const [error, setError] = useState('');
  const [transferring, setTransferring] = useState(null);
  const [transferTo, setTransferTo] = useState('');

  async function transfer(id) {
    if (!transferTo) return;
    setError('');
    try { await api.put(`/assets/${id}/transfer`, { employee_id: transferTo }); setTransferring(null); setTransferTo(''); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not transfer asset.'); }
  }
  async function reportDamage(id) {
    setError('');
    try { await api.put(`/assets/${id}/repair`, { under_repair: true, note: 'Reported by HR via Asset Transfer' }); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update asset.'); }
  }

  const lastTransfer = (a) => a.history.find((h) => h.action === 'Transferred' || h.action === 'Assigned') || null;

  return (
    <div>
      <h1>Asset Transfer</h1>
      <div className="subtitle">Hand an assigned asset over from one employee to another. To return an asset to the store, use Asset Return instead.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <div className="card">
        {assets.length === 0 && <div className="empty">No assets yet.</div>}
        {assets.filter((a) => a.status !== 'Disposed').map((a) => {
          const lt = lastTransfer(a);
          return (
            <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{a.name}{a.category ? ` (${a.category})` : ''} <span className="feature-meta">{a.asset_tag}{a.serial_number ? ` · S/N: ${a.serial_number}` : ''}</span></strong>
                <span className={'status-tag ' + (STATUS_CLASS[a.status] || 'info')}>{a.status}</span>
              </div>
              <div className="feature-meta">{lt ? `Last transfer: ${lt.detail} on ${lt.created_at.slice(0, 10)}` : 'No transfer history yet.'}</div>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {a.status === 'Assigned' && (
                  transferring === a.id ? (
                    <span className="row" style={{ display: 'inline-flex' }}>
                      <select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} style={{ width: 'auto' }}>
                        <option value="">Transfer to…</option>
                        {employees.filter((e) => e.id !== a.assigned_employee_id).map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                      </select>
                      <button className="primary" onClick={() => transfer(a.id)}>Transfer</button>
                      <button onClick={() => setTransferring(null)}>Cancel</button>
                    </span>
                  ) : <button className="pill" onClick={() => setTransferring(a.id)}>Transfer To…</button>
                )}
                {a.status !== 'Under Repair' && <button className="pill" onClick={() => reportDamage(a.id)}>Report Damage</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Dedicated "Asset Return" screen — separate from Transfer, per policy: an asset must be
// formally returned to the store (not just handed to HR informally) before it can be reassigned,
// sent for repair reassignment, or disposed. ---
function ReturnScreen({ assets, onChanged, onBack }) {
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function returnAsset(id) {
    setError(''); setInfo('');
    try { await api.put(`/assets/${id}/return`); setInfo('Asset returned to store.'); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not return asset.'); }
  }

  const assigned = assets.filter((a) => a.status === 'Assigned');

  return (
    <div>
      <h1>Asset Return</h1>
      <div className="subtitle">Record an assigned asset being handed back to the store.</div>
      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <div className="card">
        {assigned.length === 0 && <div className="empty">No assets are currently assigned out.</div>}
        {assigned.map((a) => (
          <div key={a.id} className="rec-row">
            <span>
              <strong>{a.name}{a.category ? ` (${a.category})` : ''}</strong>
              <div className="feature-meta">{a.asset_tag}{a.serial_number ? ` · S/N: ${a.serial_number}` : ''} · Assigned to: {a.assigned_employee_name} ({a.assigned_employee_code})</div>
            </span>
            <button className="primary" onClick={() => returnAsset(a.id)}>Return</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Dedicated "Asset Maintenance & Repair" screen. ---
function MaintenanceScreen({ assets, onChanged, onBack }) {
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function logMaintenance(e) {
    e.preventDefault(); setError('');
    if (!assetId) { setError('Select an asset.'); return; }
    setSaving(true);
    try { await api.put(`/assets/${assetId}/repair`, { under_repair: true, note: note.trim() || undefined }); setShowForm(false); setAssetId(''); setNote(''); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not log maintenance request.'); }
    finally { setSaving(false); }
  }
  async function backInStore(id) {
    setError('');
    try { await api.put(`/assets/${id}/repair`, { under_repair: false }); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update asset.'); }
  }

  const underRepair = assets.filter((a) => a.status === 'Under Repair');
  const eligible = assets.filter((a) => a.status !== 'Under Repair' && a.status !== 'Disposed');

  return (
    <div>
      <h1>Asset Maintenance &amp; Repair</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <div className="card">
        {underRepair.length === 0 && <div className="empty">No assets currently under repair.</div>}
        {underRepair.map((a) => {
          const latest = a.history.find((h) => h.action === 'Sent for Repair');
          return (
            <div key={a.id} className="rec-row" style={{ alignItems: 'flex-start' }}>
              <span>
                <strong>{a.name} <span className="feature-meta">({a.asset_tag})</span></strong>
                {latest?.detail && <div className="feature-meta">{latest.detail}</div>}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <span className="status-tag pending">Under Repair</span>
                <button onClick={() => backInStore(a.id)}>Back In Store</button>
              </span>
            </div>
          );
        })}
        {showForm ? (
          <form onSubmit={logMaintenance} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)} required style={{ flex: '1 1 160px' }}>
              <option value="">Select asset…</option>
              {eligible.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.asset_tag})</option>)}
            </select>
            <input placeholder="Issue description" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: '2 1 200px' }} />
            <button className="primary" type="submit" disabled={saving}>Log Request</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>+ Log Maintenance Request</button>
        )}
      </div>
    </div>
  );
}

// --- Dedicated "Barcode / QR Code Tracking" screen. ---
function QrIcon() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 6px)', gridTemplateRows: 'repeat(4, 6px)', gap: 1, flexShrink: 0 }}>
      {[1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0].map((v, i) => (
        <div key={i} style={{ background: v ? '#161E33' : 'transparent' }} />
      ))}
    </div>
  );
}
function TrackingScreen({ assets, onBack }) {
  return (
    <div>
      <h1>Barcode / QR Code Tracking</h1>
      {onBack && <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>}
      <div className="card">
        {assets.length === 0 && <div className="empty">No assets yet.</div>}
        {assets.filter((a) => a.status !== 'Disposed').map((a) => (
          <div key={a.id} className="rec-row">
            <span className="row" style={{ gap: 8, alignItems: 'center' }}>
              <QrIcon />
              <span style={{ fontFamily: 'monospace' }}>{a.asset_tag}</span>
            </span>
            <span>{a.name}{a.category ? ` (${a.category})` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Dedicated "Asset Disposal & History" screen. ---
function DisposalScreen({ assets, onChanged, onBack }) {
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);

  async function dispose(id) {
    if (!window.confirm('Mark this asset as disposed? This cannot be undone.')) return;
    setError('');
    try { await api.put(`/assets/${id}/dispose`); onChanged(); }
    catch (err) { setError(err.response?.data?.error || 'Could not dispose asset.'); }
  }

  return (
    <div>
      <h1>Asset Disposal &amp; History</h1>
      <div className="subtitle">A currently-assigned asset must be returned before it can be disposed of.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <div className="card">
        {assets.length === 0 && <div className="empty">No assets yet.</div>}
        {assets.map((a) => (
          <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
              <strong>{a.name}{a.category ? ` (${a.category})` : ''} <span className="feature-meta">{a.asset_tag}</span></strong>
              <span className={'status-tag ' + (STATUS_CLASS[a.status] || 'info')}>{a.status}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {a.status !== 'Assigned' && a.status !== 'Disposed' && <button onClick={() => dispose(a.id)}>Dispose</button>}
              <button onClick={() => setExpanded(expanded === a.id ? null : a.id)}>{expanded === a.id ? 'Hide history' : 'History'}</button>
            </div>
            {expanded === a.id && (
              <div style={{ marginTop: 8, paddingLeft: 8 }}>
                {a.history.length === 0 && <div className="feature-meta">No history yet.</div>}
                {a.history.map((h) => <div key={h.id} className="feature-meta">— <strong>{h.action}</strong>{h.detail ? `: ${h.detail}` : ''} ({h.created_at})</div>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Dedicated "Asset Audit" screen. ---
function AuditScreen({ onBack }) {
  const [audits, setAudits] = useState(null);
  const [error, setError] = useState('');
  const [discrepancies, setDiscrepancies] = useState('0');
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);

  function load() { api.get('/assets/audits').then((r) => setAudits(r.data.audits)).catch(() => setError('Could not load audits.')); }
  useEffect(load, []);

  async function runAudit(e) {
    e.preventDefault(); setError(''); setRunning(true);
    try { await api.post('/assets/audits', { discrepancies, note: note.trim() || undefined }); setNote(''); setDiscrepancies('0'); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not run audit.'); }
    finally { setRunning(false); }
  }

  const latest = audits?.[0];

  return (
    <div>
      <h1>Asset Audit</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Asset Management</button>
      <div className="card" style={{ marginBottom: 14 }}>
        {!audits ? <div className="empty">Loading…</div> : !latest ? <div className="empty">No audits have been run yet.</div> : (
          <div>Last full audit: {latest.created_at.slice(0, 10)} — {latest.accounted_for}/{latest.total} assets accounted for, {latest.discrepancies} discrepanc{latest.discrepancies === 1 ? 'y' : 'ies'}.</div>
        )}
      </div>
      <form onSubmit={runAudit} className="card" style={{ maxWidth: 480, marginBottom: 14 }}>
        <label className="field-label">Discrepancies found (if any)</label>
        <input type="number" min="0" value={discrepancies} onChange={(e) => setDiscrepancies(e.target.value)} style={{ marginBottom: 14 }} />
        <label className="field-label">Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" style={{ marginBottom: 14 }} />
        <button className="primary" type="submit" disabled={running}>Run Full Audit</button>
      </form>
      {audits && audits.length > 0 && (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Audit History</div>
          {audits.map((a) => (
            <div key={a.id} className="rec-row">
              <span>{a.created_at.slice(0, 10)}{a.note ? ` — ${a.note}` : ''}</span>
              <span>{a.accounted_for}/{a.total}{a.discrepancies > 0 ? ` · ${a.discrepancies} discrepanc${a.discrepancies === 1 ? 'y' : 'ies'}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

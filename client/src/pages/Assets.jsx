import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const APPROVAL_AUTHORITY = ['super_admin', 'hr_admin'];
const STATUS_CLASS = { Assigned: 'present', 'In Store': 'info', 'Under Repair': 'pending', Disposed: 'absent' };

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.style.transition = 'box-shadow 0.2s';
  el.style.boxShadow = '0 0 0 3px #2E5CB8';
  setTimeout(() => { el.style.boxShadow = ''; }, 1200);
}

export default function Assets() {
  const { user } = useAuth();
  if (!HR_ROLES.includes(user?.role)) {
    return (
      <div>
        <h1>Asset Management</h1>
        <div className="subtitle">This module is managed by HR.</div>
      </div>
    );
  }
  return <HRAssets />;
}

function HRAssets() {
  const { user } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', category: '', cost: '', warranty_expiry: '' });
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', category: '', cost: '', warranty_expiry: '' });
  const [assigning, setAssigning] = useState(null);
  const [assignTo, setAssignTo] = useState('');
  const [transferring, setTransferring] = useState(null);
  const [transferTo, setTransferTo] = useState('');
  const [expanded, setExpanded] = useState(null);

  function load() {
    api.get('/assets/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load asset overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'reports') api.get('/assets/reports').then((r) => setReports(r.data)).catch(() => {}); }, [tab]);

  async function addAsset(e) {
    e.preventDefault(); setError('');
    try { await api.post('/assets', form); setForm({ name: '', category: '', cost: '', warranty_expiry: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add asset.'); }
  }
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
  async function assign(id) {
    if (!assignTo) return;
    setError('');
    try { await api.put(`/assets/${id}/assign`, { employee_id: assignTo }); setAssigning(null); setAssignTo(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign asset.'); }
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
  async function audit(id) {
    setError('');
    try { await api.post(`/assets/${id}/audit`, {}); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not log audit.'); }
  }

  return (
    <div>
      <h1>Asset Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? (
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
            <select disabled><option>All Departments</option></select>
            <select disabled><option>All Statuses</option></select>
            <div className="spacer" />
            <button className="primary">Export</button>
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
              </div>
              {showForm && (
                <form onSubmit={addAsset} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                  <input placeholder="Asset name (e.g. Dell Latitude 5440)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ flex: '2 1 180px' }} />
                  <input placeholder="Category (e.g. Laptop)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ flex: '1 1 120px' }} />
                  <input type="number" min="0" placeholder="Cost" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} style={{ flex: '1 1 100px' }} />
                  <input type="date" placeholder="Warranty expiry" value={form.warranty_expiry} onChange={(e) => setForm({ ...form, warranty_expiry: e.target.value })} style={{ flex: '1 1 140px' }} />
                  <button className="primary" type="submit">Add</button>
                </form>
              )}
              {!APPROVAL_AUTHORITY.includes(user?.role) && <div className="feature-meta" style={{ marginBottom: 8 }}>Assets you add require Super Admin/HR Admin approval before they can be assigned.</div>}
              {ov?.assets.length === 0 && <div className="empty">No assets yet.</div>}
              {ov?.assets.map((a) => (
                <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0', opacity: a.active ? 1 : 0.55 }}>
                  {editing === a.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); saveEdit(a.id); }} className="row" style={{ flexWrap: 'wrap' }}>
                      <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} style={{ flex: '2 1 160px' }} />
                      <input value={editDraft.category} onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })} placeholder="Category" style={{ flex: '1 1 100px' }} />
                      <input type="number" value={editDraft.cost} onChange={(e) => setEditDraft({ ...editDraft, cost: e.target.value })} placeholder="Cost" style={{ flex: '1 1 90px' }} />
                      <input type="date" value={editDraft.warranty_expiry} onChange={(e) => setEditDraft({ ...editDraft, warranty_expiry: e.target.value })} style={{ flex: '1 1 140px' }} />
                      <button className="primary" type="submit">Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                        <strong>{a.name}{a.category ? ` (${a.category})` : ''} <span className="feature-meta">{a.asset_tag}</span></strong>
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

                      {a.approval_status === 'Pending Approval' && APPROVAL_AUTHORITY.includes(user?.role) && (
                        <div style={{ marginTop: 6 }}>
                          <button className="btn-approve" onClick={() => decide(a.id, 'approve')}>Approve</button>
                          <button className="btn-reject" style={{ marginLeft: 6 }} onClick={() => decide(a.id, 'reject')}>Reject</button>
                        </div>
                      )}

                      {a.approval_status !== 'Pending Approval' && a.status !== 'Disposed' && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button onClick={() => { setEditing(a.id); setEditDraft({ name: a.name, category: a.category || '', cost: a.cost ?? '', warranty_expiry: a.warranty_expiry || '' }); }}>Edit</button>
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
                          {a.status === 'In Store' && a.active && (
                            assigning === a.id ? (
                              <span className="row" style={{ display: 'inline-flex' }}>
                                <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ width: 'auto' }}>
                                  <option value="">Select employee</option>
                                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                                </select>
                                <button className="primary" onClick={() => assign(a.id)}>Assign</button>
                                <button onClick={() => setAssigning(null)}>Cancel</button>
                              </span>
                            ) : <button onClick={() => setAssigning(a.id)}>Assign</button>
                          )}
                          {a.status !== 'Under Repair' && <button onClick={() => toggleRepair(a.id, true)}>Send for Repair</button>}
                          {a.status === 'Under Repair' && <button onClick={() => toggleRepair(a.id, false)}>Back In Store</button>}
                          {a.status !== 'Assigned' && <button onClick={() => dispose(a.id)}>Dispose</button>}
                          <button onClick={() => audit(a.id)}>Log Audit</button>
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
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Click a feature to jump to it.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Inventory &amp; Allocation</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Transfer &amp; Return</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Maintenance &amp; Repair</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Warranty Management</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Disposal &amp; History</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Barcode / QR Code Tracking</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Approval</button>
                <button className="pill" onClick={() => setTab('reports')}>Asset Reports &amp; Analytics</button>
                <button className="pill" onClick={() => scrollToSection('section-inventory')}>Asset Audit</button>
              </div>
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Field-Level Access</div>
              {ov?.fieldAccess.map((f) => (
                <div key={f.field} className="rec-row"><span>{f.field}</span><span className="status-tag present">{f.access}</span></div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">4</span>Quick Actions</div>
            <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowForm((v) => !v); scrollToSection('section-inventory'); }}>{showForm ? '− Hide add asset form' : '+ Add Asset'}</button>
            {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
          </div>
        </>
      )}
    </div>
  );
}

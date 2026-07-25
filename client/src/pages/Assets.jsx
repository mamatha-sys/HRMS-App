import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const STATUS_CLASS = { Assigned: 'present', 'In Store': 'info', 'Under Repair': 'pending' };

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
  const [ov, setOv] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', category: '', cost: '' });
  const [assigning, setAssigning] = useState(null);
  const [assignTo, setAssignTo] = useState('');

  function load() {
    api.get('/assets/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load asset overview.'));
  }
  useEffect(load, []);
  useEffect(() => { api.get('/employees').then((r) => setEmployees(r.data.employees.filter((e) => e.status === 'Active'))).catch(() => {}); }, []);

  async function addAsset(e) {
    e.preventDefault(); setError('');
    try { await api.post('/assets', form); setForm({ name: '', category: '', cost: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add asset.'); }
  }
  async function assign(id) {
    if (!assignTo) return;
    setError('');
    try { await api.put(`/assets/${id}/assign`, { employee_id: assignTo }); setAssigning(null); setAssignTo(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not assign asset.'); }
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

  return (
    <div>
      <h1>Asset Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

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
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="feature-name"><span className="widget-badge">1</span>Asset Inventory</div>
          </div>
          {showForm && (
            <form onSubmit={addAsset} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Asset name (e.g. Dell Latitude 5440)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ flex: '2 1 180px' }} />
              <input placeholder="Category (e.g. Laptop)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ flex: '1 1 120px' }} />
              <input type="number" min="0" placeholder="Cost" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} style={{ flex: '1 1 100px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.assets.length === 0 && <div className="empty">No assets yet.</div>}
          {ov?.assets.map((a) => (
            <div key={a.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{a.name}{a.category ? ` (${a.category})` : ''}</strong>
                <span className={'status-tag ' + (STATUS_CLASS[a.status] || 'info')}>{a.status}</span>
              </div>
              <div className="feature-meta">
                Assigned to: {a.assigned_employee_name ? `${a.assigned_employee_name} (${a.assigned_employee_code})` : '—'}
                {a.cost != null ? ` · Cost: ₹${Number(a.cost).toLocaleString('en-IN')}` : ''}
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {a.status === 'Assigned' && <button onClick={() => returnAsset(a.id)}>Return</button>}
                {a.status === 'In Store' && (
                  assigning === a.id ? (
                    <span className="row" style={{ display: 'inline-flex' }}>
                      <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ width: 'auto' }}>
                        <option value="">Select employee</option>
                        {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                      </select>
                      <button className="primary" onClick={() => assign(a.id)}>Assign</button>
                      <button onClick={() => setAssigning(null)}>Cancel</button>
                    </span>
                  ) : <button onClick={() => setAssigning(a.id)}>Edit</button>
                )}
                {a.status !== 'Under Repair' && <button onClick={() => toggleRepair(a.id, true)}>Send for Repair</button>}
                {a.status === 'Under Repair' && <button onClick={() => toggleRepair(a.id, false)}>Back In Store</button>}
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
          <div className="feature-meta" style={{ marginBottom: 8 }}>{ov?.keyFeatures.length || 0} features in this module — configured by Super Admin.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {ov?.keyFeatures.map((f) => <div key={f} className="pill" style={{ textAlign: 'center' }}>{f}</div>)}
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
        <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowForm((v) => !v)}>{showForm ? '− Hide add asset form' : '+ Add Asset'}</button>
        {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
      </div>
    </div>
  );
}

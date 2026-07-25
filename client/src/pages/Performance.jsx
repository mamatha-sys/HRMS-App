import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

export default function Performance() {
  const { user } = useAuth();
  if (!HR_ROLES.includes(user?.role)) {
    return (
      <div>
        <h1>Performance Management</h1>
        <div className="subtitle">This module is managed by HR and your manager.</div>
      </div>
    );
  }
  return <HRPerformance />;
}

function HRPerformance() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ employee_name: '', team: '', goal_text: '', kpi_text: '' });
  const [ratingFor, setRatingFor] = useState(null);
  const [rating, setRating] = useState(5);

  function load() {
    api.get('/performance/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load performance overview.'));
  }
  useEffect(load, []);

  async function submitReview(e) {
    e.preventDefault(); setError('');
    try { await api.post('/performance/reviews', form); setForm({ employee_name: '', team: '', goal_text: '', kpi_text: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not create review.'); }
  }
  async function submitManagerAssessment(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/manager-assessment`, { rating }); setRatingFor(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit assessment.'); }
  }
  async function markComplete(id) {
    setError('');
    try { await api.put(`/performance/reviews/${id}/complete`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not mark complete.'); }
  }

  return (
    <div>
      <h1>Performance Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="filter-bar">
        <select disabled><option>All Departments</option></select>
        <select disabled><option>Cycle</option></select>
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
            <div className="feature-name"><span className="widget-badge">1</span>Performance Reviews</div>
            <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add Review'}</button>
          </div>
          {showForm && (
            <form onSubmit={submitReview} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Employee name" value={form.employee_name} onChange={(e) => setForm({ ...form, employee_name: e.target.value })} required style={{ flex: '1 1 140px' }} />
              <input placeholder="Team (optional)" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} style={{ flex: '1 1 100px' }} />
              <input placeholder="Goal" value={form.goal_text} onChange={(e) => setForm({ ...form, goal_text: e.target.value })} required style={{ flex: '2 1 200px' }} />
              <input placeholder="KPI" value={form.kpi_text} onChange={(e) => setForm({ ...form, kpi_text: e.target.value })} style={{ flex: '1 1 160px' }} />
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.reviews.length === 0 && <div className="empty">No performance reviews yet.</div>}
          {ov?.reviews.map((r) => {
            const bothSubmitted = r.self_assessment_status === 'Submitted' && r.manager_assessment_status === 'Submitted';
            return (
              <div key={r.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <span><strong>{r.employee_name}</strong>{r.team && <span className="status-tag info" style={{ marginLeft: 6 }}>{r.team}</span>}</span>
                  <span className={'status-tag ' + (r.status === 'Completed' ? 'present' : (r.manager_assessment_status === 'Pending' ? 'pending' : 'absent'))}>
                    {r.status === 'Completed' ? 'Completed' : (r.self_assessment_status === 'Pending' ? 'Self-Assessment Pending' : 'Manager Assessment Pending')}
                  </span>
                </div>
                <div className="feature-meta">{r.goal_text}{r.kpi_text ? ` · KPI: ${r.kpi_text}` : ''}</div>
                <div className="feature-meta">Self-Assessment: {r.self_assessment_status} · Manager Assessment: {r.manager_assessment_status}{r.rating ? ` · Rating: ${r.rating}/5` : ''}</div>
                {r.status !== 'Completed' && (
                  <div style={{ marginTop: 6 }}>
                    {ratingFor === r.id ? (
                      <span className="row" style={{ display: 'inline-flex' }}>
                        <select value={rating} onChange={(e) => setRating(e.target.value)} style={{ width: 'auto' }}>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <button className="primary" onClick={() => submitManagerAssessment(r.id)}>Save</button>
                        <button onClick={() => setRatingFor(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button onClick={() => { setRatingFor(r.id); setRating(r.rating || 5); }}>Submit Manager Assessment</button>
                    )}
                    <button style={{ marginLeft: 6 }} disabled={!bothSubmitted} onClick={() => markComplete(r.id)} title={!bothSubmitted ? 'Both self- and manager-assessment must be submitted first' : ''}>
                      Mark Review Complete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
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
        {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

export default function Learning() {
  const { user } = useAuth();
  if (!HR_ROLES.includes(user?.role)) {
    return (
      <div>
        <h1>Learning Management</h1>
        <div className="subtitle">This module is managed by HR.</div>
      </div>
    );
  }
  return <HRLearning />;
}

function HRLearning() {
  const { user } = useAuth();
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', mandatory: false, pass_mark: '' });
  const [managing, setManaging] = useState(null);
  const [enr, setEnr] = useState(null);
  const [addEmployeeId, setAddEmployeeId] = useState('');

  function load() {
    api.get('/learning/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load learning overview.'));
  }
  useEffect(load, []);

  async function addCourse(e) {
    e.preventDefault(); setError('');
    try { await api.post('/learning/courses', form); setForm({ title: '', mandatory: false, pass_mark: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add course.'); }
  }
  async function openEnrollments(courseId) {
    setManaging(courseId); setError('');
    try { const r = await api.get(`/learning/courses/${courseId}/enrollments`); setEnr(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not load enrollments.'); }
  }
  async function enroll(courseId) {
    if (!addEmployeeId) return;
    setError('');
    try { await api.post(`/learning/courses/${courseId}/enrollments`, { employee_id: addEmployeeId }); setAddEmployeeId(''); openEnrollments(courseId); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not enroll.'); }
  }
  async function toggleCompleted(enrollmentId, completed, courseId) {
    setError('');
    try { await api.put(`/learning/enrollments/${enrollmentId}`, { completed }); openEnrollments(courseId); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }

  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="filter-bar">
        <select disabled><option>All Departments</option></select>
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
            <div className="feature-name"><span className="widget-badge">1</span>Training Courses</div>
          </div>
          {showForm && (
            <form onSubmit={addCourse} className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <input placeholder="Course title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required style={{ flex: '2 1 180px' }} />
              <input type="number" min="0" max="100" placeholder="Pass mark % (blank = no assessment)" value={form.pass_mark} onChange={(e) => setForm({ ...form, pass_mark: e.target.value })} style={{ flex: '1 1 140px' }} />
              <label className="row" style={{ alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={form.mandatory} onChange={(e) => setForm({ ...form, mandatory: e.target.checked })} style={{ width: 16, height: 16 }} /> Mandatory
              </label>
              <button className="primary" type="submit">Add</button>
            </form>
          )}
          {ov?.courses.length === 0 && <div className="empty">No courses yet.</div>}
          {ov?.courses.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{c.title}</strong>
                {!!c.mandatory && <span className="status-tag pending">Mandatory</span>}
              </div>
              <div className="feature-meta">
                {c.completed} / {c.enrolled} completed ({c.completionPct}%) · {c.pass_mark != null ? `Pass mark: ${c.pass_mark}%` : 'No assessment'}
              </div>
              <button style={{ marginTop: 6 }} onClick={() => openEnrollments(c.id)}>Manage Enrollments</button>

              {managing === c.id && enr && (
                <div className="card" style={{ marginTop: 8, background: '#F7F8FA' }}>
                  <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                    <select value={addEmployeeId} onChange={(e) => setAddEmployeeId(e.target.value)} style={{ flex: '1 1 160px' }}>
                      <option value="">Enroll an employee…</option>
                      {enr.availableEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
                    </select>
                    <button className="primary" onClick={() => enroll(c.id)}>Enroll</button>
                  </div>
                  {enr.enrollments.length === 0 && <div className="empty">No one enrolled yet.</div>}
                  {enr.enrollments.map((e) => (
                    <div key={e.id} className="rec-row">
                      <span>{e.name} ({e.employee_code})</span>
                      <label className="row" style={{ alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={!!e.completed} onChange={(ev) => toggleCompleted(e.id, ev.target.checked, c.id)} style={{ width: 16, height: 16 }} /> Completed
                      </label>
                    </div>
                  ))}
                </div>
              )}
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
        <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => setShowForm((v) => !v)}>{showForm ? '− Hide add course form' : '+ Add Course'}</button>
        {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
      </div>
    </div>
  );
}

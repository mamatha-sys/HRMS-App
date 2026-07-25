import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const MATERIAL_MAX_BYTES = 8 * 1024 * 1024;

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.style.transition = 'box-shadow 0.2s';
  el.style.boxShadow = '0 0 0 3px #2E5CB8';
  setTimeout(() => { el.style.boxShadow = ''; }, 1200);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fileTypeOf(file) {
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('video/')) return 'video';
  return 'other';
}

// Renders a course material inline without offering a download/copy path, unless the course
// explicitly allows it. This deters casual copying via the browser UI — it isn't cryptographic
// DRM (a determined user can still access dev tools), but it removes the obvious escape hatches.
function ProtectedMaterial({ material, allowDownload }) {
  const guard = allowDownload ? {} : { onContextMenu: (e) => e.preventDefault(), style: { userSelect: 'none' } };
  return (
    <div style={{ marginBottom: 10 }} {...guard}>
      <div className="feature-meta" style={{ marginBottom: 4 }}>{material.title}{!allowDownload && <span className="status-tag pending" style={{ marginLeft: 6 }}>View only</span>}</div>
      {material.file_type === 'video' ? (
        <video src={material.data_url} controls controlsList={allowDownload ? undefined : 'nodownload noremoteplayback'} disablePictureInPicture={!allowDownload} style={{ width: '100%', maxWidth: 480, borderRadius: 6 }} />
      ) : material.file_type === 'pdf' ? (
        <iframe src={material.data_url} title={material.title} style={{ width: '100%', height: 380, border: '1px solid #E2E5EA', borderRadius: 6 }} />
      ) : (
        <a href={material.data_url} target="_blank" rel="noreferrer">{material.title}</a>
      )}
      {allowDownload && <div style={{ marginTop: 4 }}><a className="pill" href={material.data_url} download={material.title}>Download</a></div>}
    </div>
  );
}

export default function Learning() {
  const { user } = useAuth();
  return HR_ROLES.includes(user?.role) ? <HRLearning /> : <MyLearning />;
}

// Employee self-service: enrolled courses + protected material viewer.
function MyLearning() {
  const [enrollments, setEnrollments] = useState([]);
  useEffect(() => { api.get('/learning/my-courses').then((r) => setEnrollments(r.data.enrollments)).catch(() => {}); }, []);
  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Your assigned courses.</div>
      {enrollments.length === 0 && <div className="card"><div className="empty">You aren't enrolled in any courses yet.</div></div>}
      {enrollments.map((e) => (
        <div key={e.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="feature-name">{e.title}{!!e.mandatory && <span className="status-tag pending" style={{ marginLeft: 8 }}>Mandatory</span>}</div>
            <span className={'status-tag ' + (e.certificate_issued ? 'present' : (e.completed ? 'pending' : 'info'))}>
              {e.certificate_issued ? 'Certified' : (e.completed ? 'Completed — pending pass mark' : 'In Progress')}
            </span>
          </div>
          {e.pass_mark != null && <div className="feature-meta" style={{ marginBottom: 8 }}>Pass mark: {e.pass_mark}%{e.score != null ? ` · Your score: ${e.score}%` : ''}</div>}
          {e.materials.length === 0 && <div className="empty">No materials uploaded yet.</div>}
          {e.materials.map((m) => <ProtectedMaterial key={m.id} material={m} allowDownload={!!e.allow_download} />)}
        </div>
      ))}
    </div>
  );
}

function HRLearning() {
  const { user } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', mandatory: false, pass_mark: '' });
  const [managing, setManaging] = useState(null);
  const [enr, setEnr] = useState(null);
  const [addEmployeeId, setAddEmployeeId] = useState('');
  const [materialTitle, setMaterialTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [scoreDrafts, setScoreDrafts] = useState({});

  function load() {
    api.get('/learning/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load learning overview.'));
  }
  useEffect(load, []);
  useEffect(() => { if (tab === 'reports') api.get('/learning/reports').then((r) => setReports(r.data)).catch(() => {}); }, [tab]);

  async function addCourse(e) {
    e.preventDefault(); setError('');
    try { await api.post('/learning/courses', form); setForm({ title: '', mandatory: false, pass_mark: '' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add course.'); }
  }
  async function toggleAllowDownload(course) {
    setError('');
    try { await api.put(`/learning/courses/${course.id}`, { allow_download: !course.allow_download }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
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
  async function saveEnrollment(enrollmentId, courseId, patch) {
    setError('');
    try { await api.put(`/learning/enrollments/${enrollmentId}`, patch); openEnrollments(courseId); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function uploadMaterial(courseId, file) {
    if (file.size > MATERIAL_MAX_BYTES) { setError(`"${file.name}" is too large (max 8 MB).`); return; }
    if (!materialTitle.trim()) { setError('Give the material a title first.'); return; }
    setUploading(true); setError('');
    try {
      const data_url = await readFileAsDataUrl(file);
      await api.post(`/learning/courses/${courseId}/materials`, { title: materialTitle.trim(), file_type: fileTypeOf(file), data_url });
      setMaterialTitle('');
      load();
    } catch (err) { setError(err.response?.data?.error || 'Could not upload material.'); }
    finally { setUploading(false); }
  }
  async function deleteMaterial(id) {
    setError('');
    try { await api.delete(`/learning/materials/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not delete material.'); }
  }

  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={tab === 'dashboard' ? 'primary' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={tab === 'reports' ? 'primary' : ''} onClick={() => setTab('reports')}>Reports</button>
      </div>

      {tab === 'reports' ? (
        <>
          <div className="kpi-row">
            {reports && (
              <>
                <div className="kpi-card blue"><div className="kpi-label">Total Enrolled</div><div className="kpi-value">{reports.totals.totalEnrolled}</div></div>
                <div className="kpi-card green"><div className="kpi-label">Completed</div><div className="kpi-value">{reports.totals.totalCompleted}</div></div>
                <div className="kpi-card gold"><div className="kpi-label">Certified</div><div className="kpi-value">{reports.totals.totalCertified}</div></div>
                <div className="kpi-card blue"><div className="kpi-label">Overall Completion</div><div className="kpi-value">{reports.totals.overallCompletionPct}%</div></div>
              </>
            )}
          </div>
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Training Reports &amp; Analytics — by course</div>
            {!reports && <div className="empty">Loading…</div>}
            {reports && (
              <table>
                <thead><tr><th>Course</th><th>Enrolled</th><th>Completed</th><th>Certified</th><th>Completion %</th></tr></thead>
                <tbody>{reports.byCourse.map((c) => (
                  <tr key={c.title}><td>{c.title}</td><td>{c.enrolled}</td><td>{c.completed}</td><td>{c.certified}</td><td>{c.completionPct}%</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
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
            <div className="card" id="section-courses">
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
                    <span style={{ display: 'flex', gap: 6 }}>
                      {!!c.mandatory && <span className="status-tag pending">Mandatory</span>}
                      <span className={'status-tag ' + (c.allow_download ? 'present' : 'info')}>{c.allow_download ? 'Download allowed' : 'View only'}</span>
                    </span>
                  </div>
                  <div className="feature-meta">
                    {c.completed} / {c.enrolled} completed ({c.completionPct}%) · {c.certified} certified · {c.pass_mark != null ? `Pass mark: ${c.pass_mark}%` : 'No assessment'}
                  </div>

                  {user?.role === 'super_admin' && (
                    <button style={{ marginTop: 6 }} onClick={() => toggleAllowDownload(c)}>{c.allow_download ? 'Disable download/copy' : 'Allow download/copy'}</button>
                  )}
                  <button style={{ marginTop: 6, marginLeft: 6 }} onClick={() => openEnrollments(c.id)}>Manage Enrollments</button>

                  <div style={{ marginTop: 8 }}>
                    <div className="feature-meta">Materials ({c.materials.length})</div>
                    {c.materials.map((m) => (
                      <div key={m.id} className="rec-row"><span>{m.title} ({m.file_type})</span><button onClick={() => deleteMaterial(m.id)}>Remove</button></div>
                    ))}
                    <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                      <input placeholder="Material title" value={managing === c.id ? materialTitle : ''} onFocus={() => setManaging(c.id)} onChange={(e) => setMaterialTitle(e.target.value)} style={{ flex: '1 1 140px' }} />
                      <input type="file" accept="application/pdf,video/*" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadMaterial(c.id, f); }} />
                    </div>
                  </div>

                  {managing === c.id && enr && enr.course.id === c.id && (
                    <div className="card" style={{ marginTop: 8, background: '#F7F8FA' }}>
                      <div className="feature-name" style={{ marginBottom: 8 }}>Course details &amp; enrollments</div>
                      <div className="feature-meta" style={{ marginBottom: 8 }}>{c.title} · {c.mandatory ? 'Mandatory' : 'Optional'} · {c.pass_mark != null ? `Pass mark ${c.pass_mark}%` : 'No assessment'} · {c.materials.length} material(s)</div>
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
                          <span>{e.name} ({e.employee_code}){e.certificate_issued ? <span className="status-tag present" style={{ marginLeft: 6 }}>Certified</span> : null}</span>
                          <span className="row" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {c.pass_mark != null && (
                              <input type="number" min="0" max="100" placeholder="Score %" value={scoreDrafts[e.id] ?? e.score ?? ''} onChange={(ev) => setScoreDrafts({ ...scoreDrafts, [e.id]: ev.target.value })} style={{ width: 70 }} />
                            )}
                            <label className="row" style={{ alignItems: 'center', gap: 4 }}>
                              <input type="checkbox" checked={!!e.completed} onChange={(ev) => saveEnrollment(e.id, c.id, { completed: ev.target.checked, score: scoreDrafts[e.id] })} style={{ width: 16, height: 16 }} /> Completed
                            </label>
                            {c.pass_mark != null && <button onClick={() => saveEnrollment(e.id, c.id, { score: scoreDrafts[e.id] ?? e.score })}>Save score</button>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 4 }}><span className="widget-badge">2</span>Key Features</div>
              <div className="feature-meta" style={{ marginBottom: 8 }}>Click a feature to jump to it.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Course &amp; Program Management</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Course Enrollment</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Training Delivery &amp; Scheduling</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Assessments &amp; Assignments</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Certifications</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Skill Development &amp; Competency Mapping</button>
                <button className="pill" onClick={() => scrollToSection('section-courses')}>Progress, Attendance &amp; Feedback</button>
                <button className="pill" onClick={() => setTab('reports')}>Training Reports &amp; Analytics</button>
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
            <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => { setShowForm((v) => !v); scrollToSection('section-courses'); }}>{showForm ? '− Hide add course form' : '+ Add Course'}</button>
            {user?.role === 'super_admin' && <Link to="/policies"><button style={{ width: '100%', textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>+ Configure Policies</button></Link>}
          </div>
        </>
      )}
    </div>
  );
}

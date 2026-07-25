import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const MATERIAL_MAX_BYTES = 8 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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

// Employee self-service: enrolled courses, protected material viewer, and a real shuffled
// MCQ assessment (server-graded, server-shuffled — the correct answer is never sent down).
function MyLearning() {
  const [enrollments, setEnrollments] = useState([]);
  const [error, setError] = useState('');
  const [quizFor, setQuizFor] = useState(null);
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);

  function load() { api.get('/learning/my-courses').then((r) => setEnrollments(r.data.enrollments)).catch(() => {}); }
  useEffect(load, []);

  async function startAssessment(courseId) {
    setError(''); setResult(null); setAnswers({});
    try { const r = await api.get(`/learning/my-courses/${courseId}/assessment`); setQuiz(r.data); setQuizFor(courseId); }
    catch (err) { setError(err.response?.data?.error || 'Could not load assessment.'); }
  }
  async function submitAssessment() {
    setError('');
    const payload = { answers: Object.entries(answers).map(([question_id, selected_option]) => ({ question_id: Number(question_id), selected_option })) };
    try { const r = await api.post(`/learning/my-courses/${quizFor}/assessment`, payload); setResult(r.data); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit assessment.'); }
  }

  if (quizFor && quiz) {
    return (
      <div>
        <h1>Assessment — {quiz.course.title}</h1>
        <div className="subtitle">Questions are shuffled for you. {quiz.course.pass_mark != null ? `Pass mark: ${quiz.course.pass_mark}%.` : ''}</div>
        {error && <div className="banner error">{error}</div>}
        {result ? (
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Result</div>
            <div className="feature-meta">Score: {result.score}% ({result.correctCount}/{result.total} correct)</div>
            <div className="feature-meta">{result.passed ? 'Passed' : 'Not passed'}{result.certificateIssued ? ' — Certificate issued!' : ''}</div>
            <button style={{ marginTop: 10 }} onClick={() => { setQuizFor(null); setQuiz(null); setResult(null); }}>Back to My Courses</button>
          </div>
        ) : (
          <div className="card">
            {quiz.questions.map((q, i) => (
              <div key={q.id} style={{ marginBottom: 16 }}>
                <div className="feature-name" style={{ marginBottom: 6 }}>{i + 1}. {q.question_text}</div>
                {['A', 'B', 'C', 'D'].map((opt) => (
                  <label key={opt} className="row" style={{ alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <input type="radio" name={`q-${q.id}`} checked={answers[q.id] === opt} onChange={() => setAnswers({ ...answers, [q.id]: opt })} style={{ width: 16, height: 16 }} />
                    <span>{q[`option_${opt.toLowerCase()}`]}</span>
                  </label>
                ))}
              </div>
            ))}
            <button className="primary" onClick={submitAssessment} disabled={Object.keys(answers).length < quiz.questions.length}>Submit Assessment</button>
            <button style={{ marginLeft: 6 }} onClick={() => { setQuizFor(null); setQuiz(null); }}>Cancel</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Your assigned courses.</div>
      {error && <div className="banner error">{error}</div>}
      {enrollments.length === 0 && <div className="card"><div className="empty">You aren't enrolled in any courses yet.</div></div>}
      {enrollments.map((e) => (
        <div key={e.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="feature-name">{e.title}{!!e.mandatory && <span className="status-tag pending" style={{ marginLeft: 8 }}>Mandatory</span>}</div>
            <span className={'status-tag ' + (e.certificate_issued ? 'present' : (e.completed ? 'pending' : 'info'))}>
              {e.certificate_issued ? 'Certified' : (e.completed ? 'Completed — did not pass' : 'In Progress')}
            </span>
          </div>
          {e.pass_mark != null && <div className="feature-meta" style={{ marginBottom: 8 }}>Pass mark: {e.pass_mark}%{e.score != null ? ` · Your last score: ${e.score}%` : ''}</div>}
          {e.materials.length === 0 && <div className="empty">No materials uploaded yet.</div>}
          {e.materials.map((m) => <ProtectedMaterial key={m.id} material={m} allowDownload={!!e.allow_download} />)}
          {e.hasAssessment && !e.certificate_issued && <button style={{ marginTop: 6 }} onClick={() => startAssessment(e.course_id)}>Take Assessment</button>}
          {e.certificate_issued && <div className="status-tag present" style={{ marginTop: 6, display: 'inline-block' }}>🎓 Certificate earned — score {e.score}%</div>}
        </div>
      ))}
    </div>
  );
}

function HRLearning() {
  const { user } = useAuth();
  const [screen, setScreen] = useState('dashboard');
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [ov, setOv] = useState(null);
  const [reports, setReports] = useState(null);
  const [certifications, setCertifications] = useState(null);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(null);
  const [enr, setEnr] = useState(null);
  const [addEmployeeId, setAddEmployeeId] = useState('');
  const [materialTitle, setMaterialTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [scoreDrafts, setScoreDrafts] = useState({});

  function load() { api.get('/learning/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load learning overview.')); }
  useEffect(load, []);
  useEffect(() => { if (screen === 'reports') api.get('/learning/reports').then((r) => setReports(r.data)).catch(() => {}); }, [screen]);
  useEffect(() => { if (screen === 'certifications') api.get('/learning/certifications').then((r) => setCertifications(r.data.certifications)).catch(() => {}); }, [screen]);

  function goto(target) { setScreen(target); }

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
      const file_type = file.type === 'application/pdf' ? 'pdf' : (file.type.startsWith('video/') ? 'video' : 'other');
      await api.post(`/learning/courses/${courseId}/materials`, { title: materialTitle.trim(), file_type, data_url });
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

  if (screen === 'newCourse') return <NewCourseScreen onDone={() => { load(); goto('dashboard'); }} onCancel={() => goto('dashboard')} setGlobalError={setError} />;
  if (screen === 'assessment') return <AssessmentScreen courseId={activeCourseId} onBack={() => { load(); goto('dashboard'); }} />;

  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>
      {ov?.banner && <div className="banner info">{ov.banner}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={screen === 'dashboard' ? 'primary' : ''} onClick={() => goto('dashboard')}>Dashboard</button>
        <button className={screen === 'certifications' ? 'primary' : ''} onClick={() => goto('certifications')}>Certifications</button>
        <button className={screen === 'reports' ? 'primary' : ''} onClick={() => goto('reports')}>Reports</button>
      </div>

      {screen === 'certifications' ? (
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}>Certifications</div>
          {!certifications && <div className="empty">Loading…</div>}
          {certifications && certifications.length === 0 && <div className="empty">No certificates issued yet.</div>}
          {certifications && certifications.length > 0 && (
            <table>
              <thead><tr><th>Employee</th><th>Course</th><th>Score</th><th>Date</th></tr></thead>
              <tbody>{certifications.map((c) => (
                <tr key={c.id}><td>{c.name} ({c.employee_code})</td><td>{c.course_title}</td><td>{c.score}%</td><td>{c.created_at}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ) : screen === 'reports' ? (
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
                <button className="primary" onClick={() => goto('newCourse')}>+ Add Course</button>
              </div>
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
                    {c.completed} / {c.enrolled} completed ({c.completionPct}%) · {c.certified} certified · {c.pass_mark != null ? `Pass mark: ${c.pass_mark}%` : 'No assessment'} · {c.questionCount} question(s)
                  </div>

                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {user?.role === 'super_admin' && <button onClick={() => toggleAllowDownload(c)}>{c.allow_download ? 'Disable download/copy' : 'Allow download/copy'}</button>}
                    <button onClick={() => openEnrollments(c.id)}>Manage Enrollments</button>
                    <button onClick={() => { setActiveCourseId(c.id); goto('assessment'); }}>Manage Assessment ({c.questionCount})</button>
                  </div>

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
              <div className="feature-meta" style={{ marginBottom: 8 }}>Each feature opens its own screen.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {ov?.keyFeatures.map((f) => <button key={f.key} className="pill" onClick={() => goto(f.screen)}>{f.label}</button>)}
              </div>
            </div>

            <div className="card">
              <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">3</span>Field-Level Access</div>
              {ov?.fieldAccess.map((f) => (
                <div key={f.field} className="rec-row"><span>{f.field}</span><span className="status-tag present">{f.access}</span></div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Dedicated "Create Course" screen (matches the prototype form). ---
function NewCourseScreen({ onDone, onCancel, setGlobalError }) {
  const [name, setName] = useState('');
  const [mandatory, setMandatory] = useState('No');
  const [hasAssessment, setHasAssessment] = useState('Yes');
  const [passMark, setPassMark] = useState('70');
  const [materials, setMaterials] = useState([{ kind: 'pdf', title: '', file: null }, { kind: 'video', title: '', file: null }]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function setMaterialFile(i, file) {
    const next = [...materials]; next[i] = { ...next[i], file, title: next[i].title || file.name }; setMaterials(next);
  }
  function addRow(kind) { setMaterials([...materials, { kind, title: '', file: null }]); }

  async function submit(e) {
    e.preventDefault(); setError('');
    if (hasAssessment !== 'Yes') { setError('Selecting "No" is rejected — every course needs at least one assessment or completion criterion.'); return; }
    if (!name.trim()) { setError('Course Name is required'); return; }
    setSaving(true);
    try {
      const materialPayload = [];
      for (const m of materials) {
        if (!m.file) continue;
        const data_url = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(m.file);
        });
        materialPayload.push({ title: m.title || m.file.name, file_type: m.kind, data_url });
      }
      await api.post('/learning/courses', { title: name, mandatory: mandatory === 'Yes', has_assessment: hasAssessment === 'Yes', pass_mark: passMark, materials: materialPayload });
      onDone();
    } catch (err) {
      const msg = err.response?.data?.error || 'Could not create course.';
      setError(msg); setGlobalError?.(msg);
    } finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Create Course</h1>
      <div className="subtitle">Add a new training course, its assessment and its materials.</div>
      {error && <div className="banner error">{error}</div>}
      <form onSubmit={submit} className="card" style={{ maxWidth: 520 }}>
        <label className="field-label">Course Name *</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Privacy Fundamentals" required style={{ marginBottom: 14 }} />

        <label className="field-label">Mandatory / Compliance Training?</label>
        <select value={mandatory} onChange={(e) => setMandatory(e.target.value)} style={{ marginBottom: 14 }}>
          <option value="No">No</option>
          <option value="Yes">Yes</option>
        </select>

        <label className="field-label">Has Assessment / Completion Criterion? *</label>
        <select value={hasAssessment} onChange={(e) => setHasAssessment(e.target.value)} style={{ marginBottom: 4 }}>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
        <div className="feature-meta" style={{ color: '#B3401E', marginBottom: 14 }}>
          Selecting "No" will be rejected — every course needs at least one assessment or completion criterion.
        </div>

        {hasAssessment === 'Yes' && (
          <>
            <label className="field-label">Assessment Pass Mark (%)</label>
            <input type="number" min="0" max="100" value={passMark} onChange={(e) => setPassMark(e.target.value)} style={{ marginBottom: 14 }} />
          </>
        )}

        {materials.map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <label className="field-label">{m.kind === 'video' ? 'Training Video' : 'Course Material (PDF / Slides)'}</label>
            <div className="row" style={{ alignItems: 'center' }}>
              <input type="file" accept={m.kind === 'video' ? 'video/*' : 'application/pdf'} onChange={(e) => { const f = e.target.files?.[0]; if (f) setMaterialFile(i, f); }} />
            </div>
            {m.file && <div className="feature-meta">{m.file.name}</div>}
          </div>
        ))}
        <button type="button" style={{ width: '100%', marginBottom: 14, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }} onClick={() => addRow('other')}>+ Add Another File/Video</button>

        <div className="row">
          <button type="submit" disabled={saving} style={{ background: '#1E8E5A', color: '#fff', borderColor: '#1E8E5A', flex: 1 }}>Create Course</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// --- Dedicated "Manage Assessment" screen: HR's MCQ question bank per course. ---
function AssessmentScreen({ courseId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ question_text: '', option_a: '', option_b: '', option_c: '', option_d: '', correct_option: 'A' });
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  function load() { api.get(`/learning/courses/${courseId}/questions`).then((r) => setData(r.data)).catch(() => setError('Could not load assessment.')); }
  useEffect(load, [courseId]);

  async function addQuestion(e) {
    e.preventDefault(); setError('');
    try { await api.post(`/learning/courses/${courseId}/questions`, form); setForm({ question_text: '', option_a: '', option_b: '', option_c: '', option_d: '', correct_option: 'A' }); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not add question.'); }
  }
  async function saveQuestion(id) {
    setError('');
    try { await api.put(`/learning/questions/${id}`, editDraft); setEditing(null); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not save question.'); }
  }
  async function deleteQuestion(id) {
    setError('');
    try { await api.delete(`/learning/questions/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not delete question.'); }
  }

  return (
    <div>
      <h1>Manage Assessment{data ? ` — ${data.course.title}` : ''}</h1>
      <div className="subtitle">Questions are shuffled for each employee attempt; the correct answer is never sent to the browser.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="feature-name">Question Bank ({data?.questions.length || 0})</div>
          <button className="primary" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ Add Question'}</button>
        </div>
        {showForm && (
          <form onSubmit={addQuestion} style={{ marginTop: 10, marginBottom: 10 }}>
            <input placeholder="Question text" value={form.question_text} onChange={(e) => setForm({ ...form, question_text: e.target.value })} required style={{ marginBottom: 8 }} />
            {['a', 'b', 'c', 'd'].map((k) => (
              <input key={k} placeholder={`Option ${k.toUpperCase()}`} value={form[`option_${k}`]} onChange={(e) => setForm({ ...form, [`option_${k}`]: e.target.value })} required style={{ marginBottom: 8 }} />
            ))}
            <label className="field-label">Correct option</label>
            <select value={form.correct_option} onChange={(e) => setForm({ ...form, correct_option: e.target.value })} style={{ marginBottom: 8 }}>
              {['A', 'B', 'C', 'D'].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <button className="primary" type="submit">Save Question</button>
          </form>
        )}

        {data?.questions.length === 0 && <div className="empty">No questions yet — employees can't take this course's assessment until you add at least one.</div>}
        {data?.questions.map((q, i) => (
          <div key={q.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            {editing === q.id ? (
              <>
                <input value={editDraft.question_text} onChange={(e) => setEditDraft({ ...editDraft, question_text: e.target.value })} style={{ marginBottom: 8 }} />
                {['a', 'b', 'c', 'd'].map((k) => (
                  <input key={k} value={editDraft[`option_${k}`]} onChange={(e) => setEditDraft({ ...editDraft, [`option_${k}`]: e.target.value })} style={{ marginBottom: 8 }} />
                ))}
                <select value={editDraft.correct_option} onChange={(e) => setEditDraft({ ...editDraft, correct_option: e.target.value })} style={{ marginBottom: 8 }}>
                  {['A', 'B', 'C', 'D'].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <div className="row"><button className="primary" onClick={() => saveQuestion(q.id)}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></div>
              </>
            ) : (
              <>
                <div className="feature-name">{i + 1}. {q.question_text}</div>
                {['A', 'B', 'C', 'D'].map((o) => (
                  <div key={o} className="feature-meta" style={{ fontWeight: q.correct_option === o ? 700 : 400, color: q.correct_option === o ? '#1E8E5A' : 'inherit' }}>
                    {o}. {q[`option_${o.toLowerCase()}`]}{q.correct_option === o ? ' ✓' : ''}
                  </div>
                ))}
                <div className="row" style={{ marginTop: 6 }}>
                  <button onClick={() => { setEditing(q.id); setEditDraft({ ...q }); }}>Edit</button>
                  <button onClick={() => deleteQuestion(q.id)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

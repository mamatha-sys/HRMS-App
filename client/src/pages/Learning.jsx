import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const MATERIAL_MAX_BYTES = 100 * 1024 * 1024;

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

// Employee self-service: a Training-Courses-catalog dashboard (own KPIs + browse every
// course + self-enroll), each course opening its own detail screen with the protected
// material viewer and a real shuffled MCQ assessment (server-graded, server-shuffled — the
// correct answer is never sent down).
function MyLearning() {
  const [screen, setScreen] = useState('dashboard');
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [error, setError] = useState('');

  function load() {
    api.get('/learning/my-courses').then((r) => setEnrollments(r.data.enrollments)).catch(() => {});
    api.get('/learning/catalog').then((r) => setCatalog(r.data.courses)).catch(() => setError('Could not load courses.'));
  }
  useEffect(load, []);

  function goto(target) { setScreen(target); }

  if (screen === 'courseDetail') {
    const course = catalog.find((c) => c.id === activeCourseId);
    const enrollment = enrollments.find((e) => e.course_id === activeCourseId);
    return <MyCourseDetailScreen course={course} enrollment={enrollment} onEnrolled={load} onBack={() => { load(); goto('dashboard'); }} />;
  }
  if (screen === 'selfEnroll') return <SelfEnrollScreen catalog={catalog} enrollments={enrollments} onDone={() => { load(); goto('dashboard'); }} onBack={() => goto('dashboard')} />;

  const certifiedCount = enrollments.filter((e) => e.certificate_issued).length;

  return (
    <div>
      <h1>Learning Management</h1>
      <div className="subtitle">Signed in as: Employee (Self-Service)</div>
      {error && <div className="banner error">{error}</div>}

      <div className="kpi-row">
        <div className="kpi-card blue"><div className="kpi-label">My Enrolled Courses</div><div className="kpi-value">{enrollments.length}</div></div>
        <div className="kpi-card blue"><div className="kpi-label">Certificates Earned</div><div className="kpi-value">{certifiedCount}</div></div>
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">1</span>Training Courses</div>
          {catalog.length === 0 && <div className="empty">No courses available yet.</div>}
          {catalog.map((c) => (
            <div key={c.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <strong>{c.title}</strong>
                {!!c.mandatory && <span className="status-tag pending">Mandatory</span>}
              </div>
              <div className="feature-meta">
                {c.completed} / {c.enrolled} completed ({c.completionPct}%) · {c.pass_mark != null ? `Pass mark: ${c.pass_mark}%` : 'No assessment'}
              </div>
              <button style={{ marginTop: 6 }} onClick={() => { setActiveCourseId(c.id); goto('courseDetail'); }}>{c.enrolledByMe ? 'View Course' : 'View & Enroll'}</button>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="feature-name" style={{ marginBottom: 8 }}><span className="widget-badge">2</span>Quick Actions</div>
          <button className="pill" style={{ width: '100%', textAlign: 'left' }} onClick={() => goto('selfEnroll')}>Enroll in Course</button>
        </div>
      </div>
    </div>
  );
}

// --- Employee's own "Course Detail" screen: materials, Take Assessment (shuffled, own
// score/certificate result), or a self-enroll prompt if not yet enrolled. ---
function MyCourseDetailScreen({ course, enrollment, onEnrolled, onBack }) {
  const [error, setError] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [taking, setTaking] = useState(false);
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);

  async function selfEnroll() {
    setError(''); setEnrolling(true);
    try { await api.post('/learning/my-enroll', { course_id: course.id }); onEnrolled(); }
    catch (err) { setError(err.response?.data?.error || 'Could not enroll.'); }
    finally { setEnrolling(false); }
  }
  async function requestAccess() {
    setError(''); setRequesting(true);
    try { await api.post(`/learning/my-courses/${course.id}/request-access`); onEnrolled(); }
    catch (err) { setError(err.response?.data?.error || 'Could not send request.'); }
    finally { setRequesting(false); }
  }
  async function startAssessment() {
    setError(''); setResult(null); setAnswers({});
    try { const r = await api.get(`/learning/my-courses/${course.id}/assessment`); setQuiz(r.data); setTaking(true); }
    catch (err) { setError(err.response?.data?.error || 'Could not load assessment.'); }
  }
  async function submitAssessment() {
    setError('');
    const payload = { answers: Object.entries(answers).map(([question_id, selected_option]) => ({ question_id: Number(question_id), selected_option })) };
    try { const r = await api.post(`/learning/my-courses/${course.id}/assessment`, payload); setResult(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not submit assessment.'); }
  }

  if (!course) return <div className="empty">Loading…</div>;

  if (taking) {
    return (
      <div>
        <h1>Assessment — {course.title}</h1>
        <div className="subtitle">Questions are shuffled for you. {course.pass_mark != null ? `Pass mark: ${course.pass_mark}%.` : ''}</div>
        {error && <div className="banner error">{error}</div>}
        {!result && <button onClick={() => { setTaking(false); setQuiz(null); }} style={{ marginBottom: 14 }}>← Back to Course</button>}
        {result ? (
          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Result</div>
            <div className="feature-meta">Score: {result.score}% ({result.correctCount}/{result.total} correct)</div>
            <div className="feature-meta">{result.passed ? 'Passed' : 'Not passed'}{result.certificateIssued ? ' — Certificate issued!' : ''}</div>
            <button style={{ marginTop: 10 }} onClick={() => { setTaking(false); setQuiz(null); setResult(null); onEnrolled(); }}>Back to Course</button>
          </div>
        ) : !quiz ? <div className="empty">Loading…</div> : (
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
            <button style={{ marginLeft: 6 }} onClick={() => { setTaking(false); setQuiz(null); }}>Cancel</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>{course.title}</h1>
      <div className="subtitle">
        {course.mandatory ? 'Mandatory training' : 'Optional training'}
        {course.pass_mark != null ? ` — Pass mark: ${course.pass_mark}%. A certificate is only issued after the assessment is passed.` : ' — No assessment defined.'}
      </div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>

      {!enrollment ? (
        <div className="card">
          <div className="empty">You are not enrolled in this course yet.</div>
          <button className="primary" style={{ marginTop: 8 }} disabled={enrolling} onClick={selfEnroll}>Enroll in this Course</button>
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className={'status-tag ' + (enrollment.certificate_issued ? 'present' : (enrollment.completed ? 'pending' : 'info'))}>
              {enrollment.certificate_issued ? 'Certified' : (enrollment.completed ? 'Completed — did not pass' : 'In Progress')}
            </span>
            {enrollment.score != null && <span className="feature-meta">Your last score: {enrollment.score}%</span>}
          </div>
          {enrollment.materials.length === 0 && <div className="empty">No materials uploaded yet.</div>}
          {enrollment.materials.map((m) => <ProtectedMaterial key={m.id} material={m} allowDownload={!!enrollment.allow_download} />)}
          {!enrollment.allow_download && enrollment.materials.length > 0 && (
            enrollment.accessRequestStatus === 'Pending' ? (
              <div className="status-tag pending" style={{ marginTop: 6, display: 'inline-block' }}>Download access requested — awaiting Super Admin</div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {enrollment.accessRequestStatus === 'Rejected' && <div className="feature-meta" style={{ marginBottom: 4 }}>Your last request was rejected.</div>}
                <button disabled={requesting} onClick={requestAccess}>Request Download Access</button>
              </div>
            )
          )}
          {enrollment.hasAssessment && !enrollment.certificate_issued && <button style={{ marginTop: 6 }} onClick={startAssessment}>Take Assessment</button>}
          {enrollment.certificate_issued && <div className="status-tag present" style={{ marginTop: 6, display: 'inline-block' }}>🎓 Certificate earned — score {enrollment.score}%</div>}
        </div>
      )}
    </div>
  );
}

// --- Employee's "Enroll in Course" Quick Action screen. ---
function SelfEnrollScreen({ catalog, enrollments, onDone, onBack }) {
  const [courseId, setCourseId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const enrolledIds = new Set(enrollments.map((e) => e.course_id));
  const available = catalog.filter((c) => !enrolledIds.has(c.id));

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!courseId) return;
    setSaving(true);
    try { await api.post('/learning/my-enroll', { course_id: courseId }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not enroll.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Enroll in Course</h1>
      <div className="subtitle">Choose a course to enroll yourself in.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back</button>
      {available.length === 0 ? (
        <div className="card"><div className="empty">You're already enrolled in every available course.</div></div>
      ) : (
        <form onSubmit={submit} className="card" style={{ maxWidth: 480 }}>
          <label className="field-label">Course *</label>
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)} required style={{ marginBottom: 14 }}>
            <option value="">Select…</option>
            {available.map((c) => <option key={c.id} value={c.id}>{c.title}{c.mandatory ? ' (Mandatory)' : ''}</option>)}
          </select>
          <button className="primary" type="submit" disabled={saving}>Enroll</button>
        </form>
      )}
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

  function load() { api.get('/learning/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load learning overview.')); }
  useEffect(load, []);
  useEffect(() => { if (screen === 'reports') api.get('/learning/reports').then((r) => setReports(r.data)).catch(() => {}); }, [screen]);
  useEffect(() => { if (screen === 'certifications') api.get('/learning/certifications').then((r) => setCertifications(r.data.certifications)).catch(() => {}); }, [screen]);

  function goto(target) { setScreen(target); }

  if (screen === 'newCourse') return <NewCourseScreen onDone={(newCourseId) => { load(); setActiveCourseId(newCourseId); goto('assessment'); }} onCancel={() => goto('dashboard')} setGlobalError={setError} />;
  if (screen === 'assessment') return <AssessmentScreen courseId={activeCourseId} onBack={() => { load(); goto('dashboard'); }} />;
  if (screen === 'courseDetail') return <CourseDetailScreen courseId={activeCourseId} isSuperAdmin={user?.role === 'super_admin'} onManageAssessment={() => goto('assessment')} onBack={() => { load(); goto('dashboard'); }} />;
  if (screen === 'courses') return <CoursesScreen onBack={() => goto('dashboard')} onAdd={() => goto('newCourse')} />;
  if (screen === 'enrollment') return <EnrollmentScreen onBack={() => goto('dashboard')} />;
  if (screen === 'assessmentsList') return <AssessmentsListScreen onBack={() => goto('dashboard')} />;
  if (screen === 'delivery') return <DeliveryScreen onBack={() => goto('dashboard')} onSchedule={() => goto('scheduleSession')} />;
  if (screen === 'scheduleSession') return <ScheduleSessionScreen onDone={() => goto('delivery')} onBack={() => goto('delivery')} />;
  if (screen === 'competency') return <CompetencyMappingScreen onBack={() => goto('dashboard')} />;
  if (screen === 'progress') return <ProgressFeedbackScreen onBack={() => goto('dashboard')} />;

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
                    {!!c.mandatory && <span className="status-tag pending">Mandatory</span>}
                  </div>
                  <div className="feature-meta">
                    {c.completed} / {c.enrolled} completed ({c.completionPct}%) · {c.pass_mark != null ? `Pass mark: ${c.pass_mark}%` : 'No assessment'}
                  </div>
                  <button style={{ marginTop: 6 }} onClick={() => { setActiveCourseId(c.id); goto('courseDetail'); }}>View Course</button>
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
    const oversized = materials.find((m) => m.file && m.file.size > MATERIAL_MAX_BYTES);
    if (oversized) { setError(`"${oversized.file.name}" is too large (max 100 MB). Create the course first, then add it afterward via the course's detail screen, or use a smaller file.`); return; }
    setSaving(true);
    try {
      const materialPayload = [];
      for (const m of materials) {
        if (!m.file) continue;
        const data_url = await readFileAsDataUrl(m.file);
        materialPayload.push({ title: m.title || m.file.name, file_type: m.kind, data_url });
      }
      const res = await api.post('/learning/courses', { title: name, mandatory: mandatory === 'Yes', has_assessment: hasAssessment === 'Yes', pass_mark: passMark, materials: materialPayload });
      onDone(res.data.course.id);
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

// --- Dedicated "Course Detail" screen: materials + per-employee score/certificate actions,
// replacing the inline "Manage Enrollments" panel that used to clutter the main course list. ---
function CourseDetailScreen({ courseId, isSuperAdmin, onManageAssessment, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [addEmployeeId, setAddEmployeeId] = useState('');
  const [materialTitle, setMaterialTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [scoreDrafts, setScoreDrafts] = useState({});
  const [accessRequests, setAccessRequests] = useState([]);

  function load() { api.get(`/learning/courses/${courseId}/enrollments`).then((r) => setData(r.data)).catch(() => setError('Could not load course.')); }
  function loadRequests() {
    if (!isSuperAdmin) return;
    api.get('/learning/access-requests').then((r) => setAccessRequests(r.data.requests.filter((req) => req.course_id === Number(courseId) && req.status === 'Pending'))).catch(() => {});
  }
  useEffect(load, [courseId]);
  useEffect(loadRequests, [courseId]);

  async function toggleAllowDownload() {
    setError('');
    try { await api.put(`/learning/courses/${courseId}`, { allow_download: !data.course.allow_download }); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function decideAccessRequest(id, status) {
    setError('');
    try { await api.put(`/learning/access-requests/${id}`, { status }); loadRequests(); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update request.'); }
  }
  async function enroll(e) {
    e.preventDefault();
    if (!addEmployeeId) return;
    setError('');
    try { await api.post(`/learning/courses/${courseId}/enrollments`, { employee_id: addEmployeeId }); setAddEmployeeId(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not enroll.'); }
  }
  async function saveEnrollment(enrollmentId, patch) {
    setError('');
    try { await api.put(`/learning/enrollments/${enrollmentId}`, patch); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not update.'); }
  }
  async function uploadMaterial(file) {
    if (file.size > MATERIAL_MAX_BYTES) { setError(`"${file.name}" is too large (max 100 MB).`); return; }
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

  const course = data?.course;
  return (
    <div>
      <h1>{course ? course.title : 'Course Detail'}</h1>
      {course && (
        <div className="subtitle">
          {course.mandatory ? 'Mandatory training' : 'Optional training'}
          {course.pass_mark != null ? ` — Assessment pass mark: ${course.pass_mark}%. A certificate is only issued after the assessment is passed.` : ' — No assessment defined.'}
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {course && course.pass_mark != null && course.questionCount === 0 && (
        <div className="banner error">This course has a pass mark ({course.pass_mark}%) but no questions yet — employees will not see a Take Assessment button until you add at least one via Manage Assessment.</div>
      )}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>

      {!data ? <div className="empty">Loading…</div> : (
        <div className="dashboard-grid">
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div className="feature-name">Course Materials</div>
              <div className="row" style={{ gap: 6 }}>
                {isSuperAdmin && <button onClick={toggleAllowDownload}>{course.allow_download ? 'Disable download/copy' : 'Allow download/copy'}</button>}
                <button onClick={onManageAssessment}>Manage Assessment ({course.questionCount})</button>
              </div>
            </div>
            {isSuperAdmin && !course.allow_download && accessRequests.length > 0 && (
              <div style={{ marginBottom: 10, background: '#F7F8FA', borderRadius: 8, padding: 8 }}>
                <div className="feature-meta" style={{ marginBottom: 4 }}>Download Access Requests ({accessRequests.length})</div>
                {accessRequests.map((r) => (
                  <div key={r.id} className="rec-row">
                    <span>{r.employee_name} ({r.employee_code})</span>
                    <span className="row" style={{ gap: 6 }}>
                      <button className="primary" onClick={() => decideAccessRequest(r.id, 'Approved')}>Approve</button>
                      <button onClick={() => decideAccessRequest(r.id, 'Rejected')}>Reject</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {course.materials.length === 0 && <div className="empty">No materials uploaded yet.</div>}
            {course.materials.map((m) => (
              <div key={m.id} className="rec-row">
                <span>{m.file_type === 'video' ? '🎬' : '📄'} {m.title}</span>
                <span className="row" style={{ gap: 6 }}>
                  <a className="pill" href={m.data_url} target="_blank" rel="noreferrer">{m.file_type === 'video' ? 'Watch Video' : 'View Document'}</a>
                  <button onClick={() => deleteMaterial(m.id)}>Remove</button>
                </span>
              </div>
            ))}
            <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              <input placeholder="Material title" value={materialTitle} onChange={(e) => setMaterialTitle(e.target.value)} style={{ flex: '1 1 140px' }} />
              <input type="file" accept="application/pdf,video/*" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadMaterial(f); }} />
            </div>
          </div>

          <div className="card">
            <div className="feature-name" style={{ marginBottom: 8 }}>Enrolled Employees</div>
            {data.enrollments.length === 0 && <div className="empty">No one enrolled yet.</div>}
            {data.enrollments.map((e) => (
              <div key={e.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{e.name}</strong>
                  <span className={'status-tag ' + (e.certificate_issued ? 'present' : 'info')}>{e.certificate_issued ? 'Certified' : 'Not certified'}</span>
                </div>
                {e.score != null && <div className="feature-meta">Assessment score: {e.score}%</div>}
                {course.pass_mark != null && (
                  <div className="row" style={{ marginTop: 4, gap: 6 }}>
                    <input type="number" min="0" max="100" placeholder="Score %" value={scoreDrafts[e.id] ?? e.score ?? ''} onChange={(ev) => setScoreDrafts({ ...scoreDrafts, [e.id]: ev.target.value })} style={{ width: 80 }} />
                    <button onClick={() => saveEnrollment(e.id, { score: scoreDrafts[e.id] ?? e.score })}>Record Score</button>
                    {!e.certificate_issued && <button onClick={() => saveEnrollment(e.id, { completed: true, score: scoreDrafts[e.id] ?? e.score })}>Issue Certificate</button>}
                  </div>
                )}
              </div>
            ))}
            <form onSubmit={enroll} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
              <select value={addEmployeeId} onChange={(e) => setAddEmployeeId(e.target.value)} style={{ flex: '1 1 160px' }}>
                <option value="">Enroll an employee…</option>
                {data.availableEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
              </select>
              <button className="primary" type="submit">Enroll</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Dedicated "Course & Program Management" screen. ---
function CoursesScreen({ onBack, onAdd }) {
  const [ov, setOv] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/learning/overview').then((r) => setOv(r.data)).catch(() => setError('Could not load courses.')); }, []);

  return (
    <div>
      <h1>Course & Program Management</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card">
        {!ov && <div className="empty">Loading…</div>}
        {ov && (
          <table>
            <thead><tr><th>Course</th><th>Enrolled</th><th>Mandatory</th><th>Assessment</th><th>Materials</th></tr></thead>
            <tbody>{ov.courses.map((c) => (
              <tr key={c.id}>
                <td>{c.title}</td>
                <td>{c.enrolled}</td>
                <td>{c.mandatory ? 'Yes' : 'No'}</td>
                <td>{c.pass_mark != null ? `Pass ${c.pass_mark}%` : 'None'}</td>
                <td>{c.materials.length} file(s)</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <button className="primary" style={{ marginTop: 10 }} onClick={onAdd}>+ Add Course</button>
      </div>
    </div>
  );
}

// --- Dedicated "Course Enrollment — who has access to what" screen. ---
function EnrollmentScreen({ onBack }) {
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [courseId, setCourseId] = useState('');

  function load() { api.get('/learning/enrollments').then((r) => setData(r.data)).catch(() => setError('Could not load enrollments.')); }
  useEffect(() => { load(); api.get('/learning/employees').then((r) => setEmployees(r.data.employees)).catch(() => {}); }, []);

  async function enroll(e) {
    e.preventDefault(); setError('');
    try { await api.post('/learning/enrollments', { employee_id: employeeId, course_id: courseId }); setEmployeeId(''); setCourseId(''); setShowForm(false); load(); }
    catch (err) { setError(err.response?.data?.error || 'Could not enroll.'); }
  }

  const statusClass = (s) => (s === 'Certified' ? 'present' : (s === 'Assessed' ? 'pending' : 'info'));

  return (
    <div>
      <h1>Course Enrollment — who has access to what</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card">
        {!data && <div className="empty">Loading…</div>}
        {data && data.enrollments.length === 0 && <div className="empty">No enrollments yet.</div>}
        {data && data.enrollments.length > 0 && (
          <table>
            <thead><tr><th>Employee</th><th>Course</th><th>Status</th></tr></thead>
            <tbody>{data.enrollments.map((e) => (
              <tr key={e.id}><td>{e.employee_name}</td><td>{e.course_title}</td><td><span className={'status-tag ' + statusClass(e.status)}>{e.status}</span></td></tr>
            ))}</tbody>
          </table>
        )}
        {showForm ? (
          <form onSubmit={enroll} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required style={{ flex: '1 1 160px' }}>
              <option value="">Select employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
            </select>
            <select value={courseId} onChange={(e) => setCourseId(e.target.value)} required style={{ flex: '1 1 160px' }}>
              <option value="">Select course…</option>
              {data?.courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <button className="primary" type="submit">Enroll</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        ) : (
          <button className="primary" style={{ marginTop: 10 }} onClick={() => setShowForm(true)}>+ Enroll Employee</button>
        )}
      </div>
    </div>
  );
}

// --- Dedicated "Assessments & Assignments" screen. ---
function AssessmentsListScreen({ onBack }) {
  const [assessments, setAssessments] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/learning/assessments').then((r) => setAssessments(r.data.assessments)).catch(() => setError('Could not load assessments.')); }, []);

  return (
    <div>
      <h1>Assessments & Assignments</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card">
        {!assessments && <div className="empty">Loading…</div>}
        {assessments && assessments.map((a) => (
          <div key={a.course_id} className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <span>{a.course_title} — Final Assessment</span>
            <span className="feature-meta">{a.pass_mark != null ? `Pass mark ${a.pass_mark}%` : 'No assessment defined'}</span>
          </div>
        ))}
        <div className="feature-meta" style={{ marginTop: 10, color: '#8A6D00' }}>
          A course cannot be published without at least one assessment or completion criterion defined.
        </div>
      </div>
    </div>
  );
}

// --- Dedicated "Training Delivery & Scheduling" screen. ---
function DeliveryScreen({ onBack, onSchedule }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/learning/sessions').then((r) => setSessions(r.data.sessions)).catch(() => setError('Could not load sessions.')); }, []);

  return (
    <div>
      <h1>Training Delivery & Scheduling</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card">
        {!sessions && <div className="empty">Loading…</div>}
        {sessions && sessions.length === 0 && <div className="empty">No training sessions scheduled yet.</div>}
        {sessions && sessions.map((s) => (
          <div key={s.id} style={{ borderTop: '1px solid #EEF0F3', padding: '10px 0' }}>
            <strong>{s.course_title}</strong>
            <div className="feature-meta">{s.mode} · {s.scheduled_at}</div>
          </div>
        ))}
        <button className="primary" style={{ marginTop: 10 }} onClick={onSchedule}>+ Schedule Session</button>
      </div>
    </div>
  );
}

// --- Dedicated "Schedule Training Session" screen. ---
function ScheduleSessionScreen({ onDone, onBack }) {
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState('');
  const [mode, setMode] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.get('/learning/sessions').then((r) => setCourses(r.data.courses)).catch(() => {}); }, []);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!courseId || !mode.trim() || !scheduledAt.trim()) { setError('Course, mode and date & time are all required.'); return; }
    setSaving(true);
    try { await api.post('/learning/sessions', { course_id: courseId, mode, scheduled_at: scheduledAt }); onDone(); }
    catch (err) { setError(err.response?.data?.error || 'Could not schedule session.'); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <h1>Schedule Training Session</h1>
      <div className="subtitle">Appears immediately in Training Delivery &amp; Scheduling.</div>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back</button>
      <form onSubmit={submit} className="card" style={{ maxWidth: 480 }}>
        <label className="field-label">Course *</label>
        <select value={courseId} onChange={(e) => setCourseId(e.target.value)} required style={{ marginBottom: 14 }}>
          <option value="">Select…</option>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <label className="field-label">Mode *</label>
        <input value={mode} onChange={(e) => setMode(e.target.value)} placeholder="e.g. Classroom — Head Office, or Online — Live Session" required style={{ marginBottom: 14 }} />
        <label className="field-label">Date &amp; Time *</label>
        <input value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} placeholder="e.g. 28 Jul, 11:00 AM" required style={{ marginBottom: 14 }} />
        <button className="primary" type="submit" disabled={saving}>Schedule Session</button>
      </form>
    </div>
  );
}

// --- Dedicated "Skill Development & Competency Mapping — <Name>" screen. ---
function CompetencyMappingScreen({ onBack }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ skill_name: '', current_level: 3, required_level: 4 });
  const [error, setError] = useState('');
  useEffect(() => { api.get('/learning/employees').then((r) => setEmployees(r.data.employees)).catch(() => {}); }, []);
  useEffect(() => { if (employeeId) api.get(`/learning/employees/${employeeId}/skills`).then((r) => setData(r.data)).catch(() => setError('Could not load skills.')); else setData(null); }, [employeeId]);

  async function addSkill(e) {
    e.preventDefault(); setError('');
    try { await api.post(`/learning/employees/${employeeId}/skills`, form); setForm({ skill_name: '', current_level: 3, required_level: 4 }); const r = await api.get(`/learning/employees/${employeeId}/skills`); setData(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not add skill.'); }
  }

  return (
    <div>
      <h1>Skill Development &amp; Competency Mapping{data ? ` — ${data.employee.name}` : ''}</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card" style={{ marginBottom: 14 }}>
        <label className="field-label">Employee</label>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
        </select>
      </div>
      {employeeId && (
        <div className="card">
          {!data && <div className="empty">Loading…</div>}
          {data && data.skills.length === 0 && <div className="empty">No skills mapped yet.</div>}
          {data && data.skills.length > 0 && (
            <table>
              <thead><tr><th>Skill</th><th>Current</th><th>Required</th><th>Gap</th></tr></thead>
              <tbody>{data.skills.map((s) => (
                <tr key={s.id}>
                  <td>{s.skill_name}</td><td>{s.current_level}/5</td><td>{s.required_level}/5</td>
                  <td style={{ color: s.gap > 0 ? '#B3401E' : '#1E8E5A' }}>{s.gap > 0 ? s.gap : 'None'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <form onSubmit={addSkill} className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
            <input placeholder="Skill name" value={form.skill_name} onChange={(e) => setForm({ ...form, skill_name: e.target.value })} required style={{ flex: '2 1 160px' }} />
            <input type="number" min="0" max="5" placeholder="Current" value={form.current_level} onChange={(e) => setForm({ ...form, current_level: e.target.value })} style={{ width: 80 }} />
            <input type="number" min="0" max="5" placeholder="Required" value={form.required_level} onChange={(e) => setForm({ ...form, required_level: e.target.value })} style={{ width: 80 }} />
            <button className="primary" type="submit">+ Add Skill</button>
          </form>
        </div>
      )}
    </div>
  );
}

// --- Dedicated "Progress, Attendance & Feedback — <Name>" screen. ---
function ProgressFeedbackScreen({ onBack }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.get('/learning/employees').then((r) => setEmployees(r.data.employees)).catch(() => {}); }, []);
  useEffect(() => { if (employeeId) api.get(`/learning/employees/${employeeId}/feedback`).then((r) => setData(r.data)).catch(() => setError('Could not load feedback.')); else setData(null); }, [employeeId]);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!note.trim()) return;
    try { await api.post(`/learning/employees/${employeeId}/feedback`, { note, author_type: 'Manager' }); setNote(''); const r = await api.get(`/learning/employees/${employeeId}/feedback`); setData(r.data); }
    catch (err) { setError(err.response?.data?.error || 'Could not add feedback.'); }
  }

  return (
    <div>
      <h1>Progress, Attendance &amp; Feedback{data ? ` — ${data.employee.name}` : ''}</h1>
      {error && <div className="banner error">{error}</div>}
      <button onClick={onBack} style={{ marginBottom: 14 }}>← Back to Learning Management</button>
      <div className="card" style={{ marginBottom: 14 }}>
        <label className="field-label">Employee</label>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}
        </select>
      </div>
      {employeeId && (
        <div className="card" style={{ maxWidth: 560 }}>
          {!data && <div className="empty">Loading…</div>}
          {data && data.feedback.length === 0 && <div className="empty">No feedback yet.</div>}
          {data && data.feedback.map((f) => (
            <div key={f.id} style={{ borderTop: '1px solid #EEF0F3', padding: '8px 0' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{f.author_name} ({f.author_type})</strong>
                <span className="feature-meta">{f.created_at.slice(0, 10)}</span>
              </div>
              <div className="feature-meta">{f.note}</div>
            </div>
          ))}
          <form onSubmit={submit} style={{ marginTop: 10 }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add feedback..." rows={3} style={{ width: '100%', marginBottom: 8 }} />
            <button className="primary" type="submit">Submit Feedback</button>
          </form>
        </div>
      )}
    </div>
  );
}

import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const SCOPE_BANNER = {
  super_admin: 'Full Access — manage courses, categories, learning paths, instructors, certifications, org-wide. Rule: a certificate is only issued after the associated assessment is passed.',
  hr_admin: 'Company-wide learning — manage courses, enrollments and certifications.',
  manager: 'Team/organization learning — enroll employees, track progress.',
  assistant_manager: 'Team/organization learning — enroll employees, track progress.'
};

const KEY_FEATURES = [
  { key: 'courses', label: 'Course & Program Management' },
  { key: 'enrollment', label: 'Course Enrollment' },
  { key: 'delivery', label: 'Training Delivery & Scheduling' },
  { key: 'assessments', label: 'Assessments & Assignments' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'competency', label: 'Skill Development & Competency Mapping' },
  { key: 'progress', label: 'Progress, Attendance & Feedback' },
  { key: 'reports', label: 'Training Reports & Analytics' }
];
const FIELD_ACCESS = [
  { field: 'Record Owner / Assigned-To', access: 'Editable' },
  { field: 'Internal Notes / Remarks', access: 'Editable' }
];

function courseSummary() {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at').all();
  return courses.map((c) => {
    const enrolled = db.prepare('SELECT COUNT(*) c FROM course_enrollments WHERE course_id = ?').get(c.id).c;
    const completed = db.prepare('SELECT COUNT(*) c FROM course_enrollments WHERE course_id = ? AND completed = 1').get(c.id).c;
    const certified = db.prepare('SELECT COUNT(*) c FROM course_enrollments WHERE course_id = ? AND certificate_issued = 1').get(c.id).c;
    const materials = db.prepare('SELECT id, title, file_type, created_at FROM course_materials WHERE course_id = ? ORDER BY created_at').all(c.id);
    return { ...c, enrolled, completed, certified, completionPct: enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0, materials };
  });
}

router.get('/overview', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const courses = courseSummary();
  const totalEnrolled = courses.reduce((t, c) => t + c.enrolled, 0);

  res.json({
    banner: SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Active Courses', value: courses.length, color: 'blue' },
      { label: 'Total Enrolled', value: totalEnrolled, color: 'green' }
    ],
    courses,
    keyFeatures: KEY_FEATURES,
    fieldAccess: FIELD_ACCESS
  });
});

// Self-service: an employee's own enrolled courses + materials, gated by each course's
// allow_download flag (Super Admin only can grant download/copy access).
router.get('/my-courses', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ enrollments: [] });
  const rows = db.prepare(`
    SELECT ce.*, c.title, c.mandatory, c.pass_mark, c.allow_download
    FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
    WHERE ce.employee_id = ? ORDER BY c.created_at
  `).all(me.id);
  const enrollments = rows.map((r) => ({
    ...r,
    materials: db.prepare('SELECT id, title, file_type, created_at, data_url FROM course_materials WHERE course_id = ? ORDER BY created_at').all(r.course_id)
  }));
  res.json({ enrollments });
});

router.post('/courses', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, mandatory, pass_mark } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const mark = pass_mark === '' || pass_mark == null ? null : Math.max(0, Math.min(100, parseInt(pass_mark, 10) || 0));
  const info = db.prepare('INSERT INTO courses (title, mandatory, pass_mark) VALUES (?, ?, ?)').run(title.trim(), mandatory ? 1 : 0, mark);
  res.status(201).json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/courses/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { title, mandatory, pass_mark, allow_download } = req.body || {};
  if (allow_download !== undefined && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only Super Admin can change download/copy access.' });
  }
  const mark = pass_mark === undefined ? course.pass_mark : (pass_mark === '' || pass_mark == null ? null : Math.max(0, Math.min(100, parseInt(pass_mark, 10) || 0)));
  db.prepare('UPDATE courses SET title = COALESCE(?, title), mandatory = COALESCE(?, mandatory), pass_mark = ?, allow_download = COALESCE(?, allow_download) WHERE id = ?')
    .run(title?.trim() || null, mandatory === undefined ? null : (mandatory ? 1 : 0), mark, allow_download === undefined ? null : (allow_download ? 1 : 0), req.params.id);
  res.json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id) });
});

// Training Delivery — upload a PDF/video/other material (base64 data URL, same pattern as
// employee documents). Viewing is always allowed to enrolled employees; download/copy in the
// UI is gated by the course's allow_download flag (Super Admin only can enable it).
router.post('/courses/:id/materials', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { title, file_type, data_url } = req.body || {};
  if (!title || !data_url) return res.status(400).json({ error: 'title and data_url are required' });
  const type = ['pdf', 'video', 'other'].includes(file_type) ? file_type : 'other';
  const info = db.prepare('INSERT INTO course_materials (course_id, title, file_type, data_url) VALUES (?, ?, ?, ?)').run(course.id, title.trim(), type, data_url);
  res.status(201).json({ material: db.prepare('SELECT id, title, file_type, created_at FROM course_materials WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/materials/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM course_materials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Employees enrolled in a course, with completion/score/certificate state — used by "Manage Enrollments".
router.get('/courses/:id/enrollments', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const enrollments = db.prepare(`
    SELECT ce.*, e.name, e.employee_code, e.department
    FROM course_enrollments ce JOIN employees e ON e.id = ce.employee_id
    WHERE ce.course_id = ? ORDER BY e.name
  `).all(req.params.id);
  const enrolledIds = new Set(enrollments.map((e) => e.employee_id));
  const employees = db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active' ORDER BY name").all()
    .filter((e) => !enrolledIds.has(e.id));
  res.json({ course, enrollments, availableEmployees: employees });
});

router.post('/courses/:id/enrollments', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const employeeId = req.body?.employee_id;
  const emp = employeeId ? db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId) : null;
  if (!emp) return res.status(400).json({ error: 'A valid employee_id is required' });
  try {
    db.prepare('INSERT INTO course_enrollments (course_id, employee_id) VALUES (?, ?)').run(course.id, emp.id);
    res.status(201).json({ ok: true });
  } catch {
    res.status(409).json({ error: 'That employee is already enrolled.' });
  }
});

// Assessments & Certifications: completion + an optional score. Company rule: a certificate
// is only issued once completed AND (no pass mark required, or score >= pass mark).
router.put('/enrollments/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const enrollment = db.prepare('SELECT * FROM course_enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(enrollment.course_id);

  const completed = req.body?.completed !== undefined ? (req.body.completed ? 1 : 0) : enrollment.completed;
  const score = req.body?.score !== undefined ? (req.body.score === '' || req.body.score == null ? null : Math.max(0, Math.min(100, parseInt(req.body.score, 10) || 0))) : enrollment.score;
  const passed = course.pass_mark == null || (score != null && score >= course.pass_mark);
  const certificateIssued = completed && passed ? 1 : 0;

  db.prepare('UPDATE course_enrollments SET completed = ?, score = ?, certificate_issued = ? WHERE id = ?').run(completed, score, certificateIssued, req.params.id);
  res.json({ ok: true, certificateIssued: !!certificateIssued });
});

// Training Reports & Analytics.
router.get('/reports', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const courses = courseSummary();
  const totalEnrolled = courses.reduce((t, c) => t + c.enrolled, 0);
  const totalCompleted = courses.reduce((t, c) => t + c.completed, 0);
  const totalCertified = courses.reduce((t, c) => t + c.certified, 0);
  res.json({
    byCourse: courses.map((c) => ({ title: c.title, enrolled: c.enrolled, completed: c.completed, certified: c.certified, completionPct: c.completionPct })),
    totals: { totalEnrolled, totalCompleted, totalCertified, overallCompletionPct: totalEnrolled > 0 ? Math.round((totalCompleted / totalEnrolled) * 100) : 0 }
  });
});

export default router;

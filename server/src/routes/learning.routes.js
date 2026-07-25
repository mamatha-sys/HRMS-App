import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
router.use(requireAuth);

const HR_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];
const isHR = (role) => HR_ROLES.includes(role);

const SCOPE_BANNER = {
  super_admin: 'Full Access — manage courses, categories, learning paths, instructors, certifications, org-wide. Rule: a certificate is only issued after the associated assessment is passed.',
  hr_admin: 'Company-wide learning — manage courses, enrollments and certifications.',
  manager: 'Team/organization learning — enroll employees, track progress.',
  assistant_manager: 'Team/organization learning — enroll employees, track progress.'
};

const KEY_FEATURES = [
  'Course & Program Management', 'Course Enrollment', 'Training Delivery & Scheduling', 'Assessments & Assignments',
  'Certifications', 'Skill Development & Competency Mapping', 'Progress, Attendance & Feedback', 'Training Reports & Analytics'
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
    return { ...c, enrolled, completed, completionPct: enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0 };
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

router.post('/courses', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, mandatory, pass_mark } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  const mark = pass_mark === '' || pass_mark == null ? null : Math.max(0, Math.min(100, parseInt(pass_mark, 10) || 0));
  const info = db.prepare('INSERT INTO courses (title, mandatory, pass_mark) VALUES (?, ?, ?)').run(title.trim(), mandatory ? 1 : 0, mark);
  res.status(201).json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(info.lastInsertRowid) });
});

// Employees enrolled in a course, with completion state — used by "Manage Enrollments".
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

router.put('/enrollments/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const enrollment = db.prepare('SELECT * FROM course_enrollments WHERE id = ?').get(req.params.id);
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });
  db.prepare('UPDATE course_enrollments SET completed = ? WHERE id = ?').run(req.body?.completed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

export default router;

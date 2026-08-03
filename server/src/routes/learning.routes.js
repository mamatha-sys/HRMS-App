import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { canModule, canModuleAdmin } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';
import * as googleCalendar from '../utils/googleCalendar.js';
import { getSettings } from '../utils/integrationSettings.js';

const router = Router();
router.use(requireAuth);

// Dynamic RBAC via Manage Roles — module '11' (Learning Management System / LMS). A Senior
// Team Lead/Team Lead/Assistant Manager also passes — but ONLY for the read-only /overview,
// /reports, /certifications and /enrollments below, which explicitly scope every list they
// return, PLUS Training Delivery & Scheduling (/sessions GET+POST — see canManageTrainingDelivery
// below), which they can both view and create sessions on, same as Manager. Every other write
// endpoint (course/material/question CRUD, enroll, skills, feedback) still checks isHR
// directly, so scoped roles stay view-only there, matching Super Admin policy. Note that even
// isHR/Super Admin can no longer manually set a score or issue a certificate — that's exclusively
// driven by the employee's own completed assessment now (see POST /my-courses/:courseId/
// assessment). Those remaining course-level management screens (materials, per-course
// enrollment scoring, question banks, competency mapping, progress feedback) stay isHR-only end
// to end — like Recruitment's /interview-rounds, they're configuration/management tooling, not
// a scoped "view my department" surface.
const isHR = (role) => canModuleAdmin(role, '11');
const canViewLearning = (role) => canModuleAdmin(role, '11') || isScopedRole(role);
// Training sessions aren't tied to a department (only to a course, which can span many
// departments), so unlike Recruitment's job requisitions there's no meaningful per-department
// restriction to apply here — Assistant Manager/STL/TL get the same view+schedule access
// Manager already has, company-wide.
const canManageTrainingDelivery = (role) => isHR(role) || isScopedRole(role);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

const SCOPE_BANNER = {
  super_admin: 'Full Access — manage courses, categories, learning paths, instructors, certifications, org-wide. Rule: a certificate is only issued after the associated assessment is passed.',
  hr_admin: 'Company-wide learning — manage courses, enrollments and certifications.',
  manager: 'Team/organization learning — enroll employees, track progress.',
  assistant_manager: 'Team/organization learning — enroll employees, track progress.'
};

const KEY_FEATURES = [
  { key: 'courses', label: 'Course & Program Management', screen: 'courses' },
  { key: 'enrollment', label: 'Course Enrollment', screen: 'enrollment' },
  { key: 'delivery', label: 'Training Delivery & Scheduling', screen: 'delivery' },
  { key: 'assessments', label: 'Assessments & Assignments', screen: 'assessmentsList' },
  { key: 'certifications', label: 'Certifications', screen: 'certifications' },
  { key: 'competency', label: 'Skill Development & Competency Mapping', screen: 'competency' },
  { key: 'progress', label: 'Progress, Attendance & Feedback', screen: 'progress' },
  { key: 'reports', label: 'Training Reports & Analytics', screen: 'reports' }
];
const FIELD_ACCESS = [
  { field: 'Record Owner / Assigned-To', access: 'Editable' },
  { field: 'Internal Notes / Remarks', access: 'Editable' }
];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// scopeDeptNames: null for unscoped roles (full company counts, unchanged behavior); a Set of
// department names for a scoped role, so enrolled/completed/certified counts only reflect
// enrollments belonging to employees inside that role's assigned department(s)/team(s). An
// enrollment whose employee has no department on file is excluded when scoped (fail closed).
function courseSummary(scopeDeptNames) {
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at').all();
  return courses.map((c) => {
    let enrollRows = db.prepare(`
      SELECT ce.completed, ce.certificate_issued, e.department
      FROM course_enrollments ce JOIN employees e ON e.id = ce.employee_id
      WHERE ce.course_id = ?
    `).all(c.id);
    if (scopeDeptNames) enrollRows = enrollRows.filter((r) => r.department && scopeDeptNames.has(r.department));
    const enrolled = enrollRows.length;
    const completed = enrollRows.filter((r) => r.completed).length;
    const certified = enrollRows.filter((r) => r.certificate_issued).length;
    const materials = db.prepare('SELECT id, title, file_type, created_at FROM course_materials WHERE course_id = ? ORDER BY created_at').all(c.id);
    const questionCount = db.prepare('SELECT COUNT(*) c FROM course_questions WHERE course_id = ?').get(c.id).c;
    return { ...c, enrolled, completed, certified, completionPct: enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0, materials, questionCount };
  });
}

router.get('/overview', (req, res) => {
  if (!canViewLearning(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  const courses = courseSummary(scopeDeptNames);
  const totalEnrolled = courses.reduce((t, c) => t + c.enrolled, 0);

  res.json({
    banner: scoped ? 'Team/organization learning — view your assigned department(s)/team(s) only; no create, edit, or enrollment-management actions here.' : SCOPE_BANNER[req.user.role],
    kpis: [
      { label: 'Active Courses', value: courses.length, color: 'blue' },
      { label: 'Total Enrolled', value: totalEnrolled, color: 'green' }
    ],
    courses,
    keyFeatures: KEY_FEATURES,
    fieldAccess: FIELD_ACCESS
  });
});

// Self-service: an employee's own enrolled courses + materials. Every material is always
// view-only by default — no download/copy option — unless this specific employee has an
// Approved download request for that specific material.
router.get('/my-courses', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ enrollments: [] });
  const rows = db.prepare(`
    SELECT ce.*, c.title, c.mandatory, c.pass_mark
    FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id
    WHERE ce.employee_id = ? ORDER BY c.created_at
  `).all(me.id);
  const enrollments = rows.map((r) => ({
    ...r,
    materials: db.prepare('SELECT id, title, file_type, created_at, data_url FROM course_materials WHERE course_id = ? ORDER BY created_at').all(r.course_id).map((m) => {
      const reqRow = db.prepare('SELECT status FROM material_download_requests WHERE material_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT 1').get(m.id, me.id);
      return { ...m, downloadRequestStatus: reqRow ? reqRow.status : null };
    }),
    hasAssessment: db.prepare('SELECT COUNT(*) c FROM course_questions WHERE course_id = ?').get(r.course_id).c > 0
  }));
  res.json({ enrollments });
});

// Employee: ask Super Admin/HR Admin to lift view-only on one specific file/video. Only for
// materials belonging to a course the employee is actually enrolled in.
router.post('/download-requests', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee record linked to your account.' });
  const material = db.prepare('SELECT id, course_id FROM course_materials WHERE id = ?').get(req.body?.material_id);
  if (!material) return res.status(400).json({ error: 'A valid material is required.' });
  const enrolled = db.prepare('SELECT 1 FROM course_enrollments WHERE course_id = ? AND employee_id = ?').get(material.course_id, me.id);
  if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in that course.' });
  const pending = db.prepare("SELECT 1 FROM material_download_requests WHERE material_id = ? AND employee_id = ? AND status = 'Pending'").get(material.id, me.id);
  if (pending) return res.status(409).json({ error: 'You already have a pending request for this file.' });
  db.prepare('INSERT INTO material_download_requests (material_id, employee_id, reason) VALUES (?, ?, ?)')
    .run(material.id, me.id, req.body?.reason?.trim() || null);
  res.status(201).json({ ok: true });
});

// Employee: my own download requests, with material/course titles, for status tracking.
router.get('/my-download-requests', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.json({ requests: [] });
  const requests = db.prepare(`
    SELECT r.*, cm.title AS material_title, cm.file_type, c.title AS course_title
    FROM material_download_requests r
    JOIN course_materials cm ON cm.id = r.material_id
    JOIN courses c ON c.id = cm.course_id
    WHERE r.employee_id = ? ORDER BY r.created_at DESC
  `).all(me.id);
  res.json({ requests });
});

// HR: every employee's download request, for the approval queue.
router.get('/download-requests', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const requests = db.prepare(`
    SELECT r.*, cm.title AS material_title, cm.file_type, c.title AS course_title, e.name AS employee_name, e.employee_code
    FROM material_download_requests r
    JOIN course_materials cm ON cm.id = r.material_id
    JOIN courses c ON c.id = cm.course_id
    JOIN employees e ON e.id = r.employee_id
    ORDER BY (r.status = 'Pending') DESC, r.created_at DESC
  `).all();
  res.json({ requests });
});

router.put('/download-requests/:id/decide', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const request = db.prepare('SELECT * FROM material_download_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'Pending') return res.status(400).json({ error: 'This request has already been decided.' });
  const approve = req.body?.decision === 'approve';
  db.prepare("UPDATE material_download_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
    .run(approve ? 'Approved' : 'Rejected', req.user.name || 'HR', req.params.id);
  res.json({ ok: true });
});

// Employee-facing course catalog for the self-service "Training Courses" browse list:
// every course with company-wide completion stats, plus whether the current employee is
// already enrolled (so the dashboard can offer "View Course" vs "View & Enroll").
router.get('/catalog', (req, res) => {
  const me = myEmployee(req.user.sub);
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at').all();
  const result = courses.map((c) => {
    const enrolled = db.prepare('SELECT COUNT(*) c FROM course_enrollments WHERE course_id = ?').get(c.id).c;
    const completed = db.prepare('SELECT COUNT(*) c FROM course_enrollments WHERE course_id = ? AND completed = 1').get(c.id).c;
    const mine = me ? db.prepare('SELECT id FROM course_enrollments WHERE course_id = ? AND employee_id = ?').get(c.id, me.id) : null;
    return {
      id: c.id, title: c.title, mandatory: c.mandatory, pass_mark: c.pass_mark,
      enrolled, completed, completionPct: enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0,
      enrolledByMe: !!mine
    };
  });
  res.json({ courses: result });
});

// Employee self-enrollment (Quick Action / course-detail "Enroll" button) — unlike HR's
// POST /courses/:id/enrollments, this always enrolls the calling user's own employee record.
router.post('/my-enroll', (req, res) => {
  const me = myEmployee(req.user.sub);
  if (!me) return res.status(400).json({ error: 'No employee profile is linked to this account.' });
  const course = db.prepare('SELECT id FROM courses WHERE id = ?').get(req.body?.course_id);
  if (!course) return res.status(400).json({ error: 'A valid course is required.' });
  try {
    db.prepare('INSERT INTO course_enrollments (course_id, employee_id) VALUES (?, ?)').run(course.id, me.id);
    res.status(201).json({ ok: true });
  } catch {
    res.status(409).json({ error: 'You are already enrolled in that course.' });
  }
});

// Every course needs a completion criterion — this form requires a real assessment (a
// question bank with a pass mark), matching the "Has Assessment / Completion Criterion?"
// rule shown on the Create Course screen. Materials (PDF/video) can be attached at creation.
router.post('/courses', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { title, mandatory, has_assessment, pass_mark, materials } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Course Name is required' });
  if (has_assessment !== true && has_assessment !== 'Yes') {
    return res.status(400).json({ error: 'Selecting "No" is rejected — every course needs at least one assessment or completion criterion.' });
  }
  const mark = pass_mark === '' || pass_mark == null ? 70 : Math.max(0, Math.min(100, parseInt(pass_mark, 10) || 0));

  const info = db.prepare('INSERT INTO courses (title, mandatory, pass_mark) VALUES (?, ?, ?)').run(title.trim(), mandatory ? 1 : 0, mark);
  const courseId = info.lastInsertRowid;

  if (Array.isArray(materials)) {
    const insMat = db.prepare('INSERT INTO course_materials (course_id, title, file_type, data_url) VALUES (?, ?, ?, ?)');
    materials.forEach((m) => {
      if (!m?.data_url) return;
      const type = ['pdf', 'video', 'other'].includes(m.file_type) ? m.file_type : 'other';
      insMat.run(courseId, (m.title || 'Untitled').trim(), type, m.data_url);
    });
  }
  res.status(201).json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId) });
});

router.put('/courses/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { title, mandatory, pass_mark } = req.body || {};
  const mark = pass_mark === undefined ? course.pass_mark : (pass_mark === '' || pass_mark == null ? null : Math.max(0, Math.min(100, parseInt(pass_mark, 10) || 0)));
  db.prepare('UPDATE courses SET title = COALESCE(?, title), mandatory = COALESCE(?, mandatory), pass_mark = ? WHERE id = ?')
    .run(title?.trim() || null, mandatory === undefined ? null : (mandatory ? 1 : 0), mark, req.params.id);
  res.json({ course: db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id) });
});

// Training Delivery — upload a PDF/video/other material (base64 data URL, same pattern as
// employee documents). Materials are always view-only — there is no download/copy option.
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

// --- Assessments & Assignments: HR manages a real MCQ question bank per course. ---
router.get('/courses/:id/questions', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const questions = db.prepare('SELECT * FROM course_questions WHERE course_id = ? ORDER BY sort_order').all(req.params.id);
  res.json({ course, questions });
});

// Same question text (trimmed, case-insensitive) already in this course's bank — the question
// bank is a flat list with no other identity, so text is the only sensible duplicate key.
function isDuplicateQuestion(courseId, text, excludeId) {
  const row = db.prepare('SELECT id FROM course_questions WHERE course_id = ? AND LOWER(TRIM(question_text)) = LOWER(TRIM(?))').get(courseId, text);
  return !!row && row.id !== excludeId;
}

router.post('/courses/:id/questions', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body || {};
  if (![question_text, option_a, option_b, option_c, option_d].every((v) => v && v.trim())) {
    return res.status(400).json({ error: 'The question and all four options are required' });
  }
  if (!['A', 'B', 'C', 'D'].includes(correct_option)) return res.status(400).json({ error: 'correct_option must be A, B, C or D' });
  if (isDuplicateQuestion(course.id, question_text)) {
    return res.status(409).json({ error: 'This question already exists in this course\'s question bank.' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM course_questions WHERE course_id = ?').get(req.params.id).m;
  const info = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(course.id, question_text.trim(), option_a.trim(), option_b.trim(), option_c.trim(), option_d.trim(), correct_option, maxOrder + 1);
  res.status(201).json({ question: db.prepare('SELECT * FROM course_questions WHERE id = ?').get(info.lastInsertRowid) });
});

// Bulk import — same {inserted, skipped, errors} shape as employees.routes.js's POST /bulk, so
// the client can reuse the exact same CSV-paste/upload UI and result card. 'skipped' counts
// duplicates — either a question that already exists in this course's bank, or a repeat within
// the CSV itself (e.g. pasted twice by mistake) — checked case-insensitively on trimmed text.
router.post('/courses/:id/questions/bulk', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows must be a non-empty array' });

  const results = { inserted: 0, skipped: 0, errors: [] };
  let nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM course_questions WHERE course_id = ?').get(course.id).m;
  const insertOne = db.prepare('INSERT INTO course_questions (course_id, question_text, option_a, option_b, option_c, option_d, correct_option, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const seenInBatch = new Set();
  const tx = db.transaction((list) => {
    list.forEach((raw, i) => {
      const row = {
        question_text: raw.question_text?.trim(),
        option_a: raw.option_a?.trim(), option_b: raw.option_b?.trim(), option_c: raw.option_c?.trim(), option_d: raw.option_d?.trim(),
        correct_option: raw.correct_option?.trim().toUpperCase()
      };
      if (![row.question_text, row.option_a, row.option_b, row.option_c, row.option_d].every(Boolean)) {
        results.errors.push(`Row ${i + 1}: missing question text or an option`);
        return;
      }
      if (!['A', 'B', 'C', 'D'].includes(row.correct_option)) {
        results.errors.push(`Row ${i + 1}: correct_option must be A, B, C or D`);
        return;
      }
      const dupeKey = row.question_text.toLowerCase();
      if (seenInBatch.has(dupeKey) || isDuplicateQuestion(course.id, row.question_text)) {
        results.skipped++;
        return;
      }
      seenInBatch.add(dupeKey);
      nextOrder += 1;
      insertOne.run(course.id, row.question_text, row.option_a, row.option_b, row.option_c, row.option_d, row.correct_option, nextOrder);
      results.inserted++;
    });
  });
  tx(rows);
  res.status(201).json(results);
});

router.put('/questions/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const question = db.prepare('SELECT * FROM course_questions WHERE id = ?').get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Question not found' });
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body || {};
  if (correct_option !== undefined && !['A', 'B', 'C', 'D'].includes(correct_option)) return res.status(400).json({ error: 'correct_option must be A, B, C or D' });
  db.prepare(`UPDATE course_questions SET
    question_text = COALESCE(?, question_text), option_a = COALESCE(?, option_a), option_b = COALESCE(?, option_b),
    option_c = COALESCE(?, option_c), option_d = COALESCE(?, option_d), correct_option = COALESCE(?, correct_option)
    WHERE id = ?`)
    .run(question_text?.trim() || null, option_a?.trim() || null, option_b?.trim() || null, option_c?.trim() || null, option_d?.trim() || null, correct_option || null, req.params.id);
  res.json({ question: db.prepare('SELECT * FROM course_questions WHERE id = ?').get(req.params.id) });
});

router.delete('/questions/:id', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  db.prepare('DELETE FROM course_questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Employee-facing assessment: both question order AND each question's option order are
// reshuffled on every fetch, so no two employees (or even the same employee retaking it) see the
// correct answer sitting in the same visual position — makes "the answer is B" comparisons
// useless. Each option keeps its real DB letter (key) under the hood; only the display order in
// the `options` array changes, so submitting still sends back the original key and grading
// below (POST) needs no changes at all. The correct answer itself is still never sent. ---
router.get('/my-courses/:courseId/assessment', (req, res) => {
  const me = myEmployee(req.user.sub);
  const enrollment = me ? db.prepare('SELECT * FROM course_enrollments WHERE course_id = ? AND employee_id = ?').get(req.params.courseId, me.id) : null;
  if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this course.' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.courseId);
  const questions = db.prepare('SELECT id, question_text, option_a, option_b, option_c, option_d FROM course_questions WHERE course_id = ?').all(req.params.courseId);
  if (questions.length === 0) return res.status(400).json({ error: 'This course has no assessment questions yet.' });
  const withShuffledOptions = shuffled(questions).map((q) => ({
    id: q.id,
    question_text: q.question_text,
    options: shuffled([
      { key: 'A', text: q.option_a },
      { key: 'B', text: q.option_b },
      { key: 'C', text: q.option_c },
      { key: 'D', text: q.option_d }
    ])
  }));
  res.json({ course: { id: course.id, title: course.title, pass_mark: course.pass_mark }, questions: withShuffledOptions });
});

router.post('/my-courses/:courseId/assessment', (req, res) => {
  const me = myEmployee(req.user.sub);
  const enrollment = me ? db.prepare('SELECT * FROM course_enrollments WHERE course_id = ? AND employee_id = ?').get(req.params.courseId, me.id) : null;
  if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this course.' });
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.courseId);
  const questions = db.prepare('SELECT * FROM course_questions WHERE course_id = ?').all(req.params.courseId);
  if (questions.length === 0) return res.status(400).json({ error: 'This course has no assessment questions yet.' });

  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const answerMap = {}; answers.forEach((a) => { answerMap[a.question_id] = a.selected_option; });
  const correctCount = questions.filter((q) => answerMap[q.id] === q.correct_option).length;
  const score = Math.round((correctCount / questions.length) * 100);
  const passed = course.pass_mark == null || score >= course.pass_mark;
  const certificateIssued = passed ? 1 : 0;

  db.prepare(`
    UPDATE course_enrollments SET completed = 1, score = ?, certificate_issued = ?,
      certified_at = CASE WHEN ? = 1 THEN COALESCE(certified_at, datetime('now')) ELSE certified_at END
    WHERE id = ?
  `).run(score, certificateIssued, certificateIssued, enrollment.id);
  res.json({ score, correctCount, total: questions.length, passed, certificateIssued: !!certificateIssued, passMark: course.pass_mark });
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
  const materials = db.prepare('SELECT id, title, file_type, created_at, data_url FROM course_materials WHERE course_id = ? ORDER BY created_at').all(course.id);
  const questionCount = db.prepare('SELECT COUNT(*) c FROM course_questions WHERE course_id = ?').get(course.id).c;
  res.json({ course: { ...course, materials, questionCount }, enrollments, availableEmployees: employees });
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

// Score, completion, and certificate issuance are no longer manually settable by HR/Super
// Admin (previously PUT /enrollments/:id let HR type in any score and flip completed/
// certificate_issued directly, which meant a certificate could be issued without the employee
// ever taking the real assessment). They now come exclusively from the employee's own
// completed attempt — see POST /my-courses/:courseId/assessment, which grades server-side and
// auto-issues the certificate the moment a passing score is submitted.

// The actual certificate document's data — the employee it belongs to, or anyone with view
// access to Learning, can fetch it; company branding is bundled the same way payslips are.
router.get('/certificate/:enrollmentId', (req, res) => {
  const row = db.prepare(`
    SELECT ce.*, c.title AS course_title, c.pass_mark, e.name AS employee_name, e.employee_code, e.department, e.designation
    FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id JOIN employees e ON e.id = ce.employee_id
    WHERE ce.id = ?
  `).get(req.params.enrollmentId);
  if (!row) return res.status(404).json({ error: 'Certificate not found' });
  if (!row.certificate_issued) return res.status(400).json({ error: 'No certificate has been issued for this course yet.' });
  const me = myEmployee(req.user.sub);
  const isOwner = me && me.id === row.employee_id;
  if (!isOwner && !canViewLearning(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ enrollment: row, company: getSettings(['company_name', 'company_logo', 'company_address']) });
});

// Certifications: every certified employee across every course.
router.get('/certifications', (req, res) => {
  if (!canViewLearning(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  let rows = db.prepare(`
    SELECT ce.id, ce.score, ce.created_at, ce.certified_at, c.title AS course_title, c.pass_mark, e.name, e.employee_code, e.department
    FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id JOIN employees e ON e.id = ce.employee_id
    WHERE ce.certificate_issued = 1 ORDER BY ce.created_at DESC
  `).all();
  if (scoped) rows = rows.filter((r) => r.department && scopeDeptNames.has(r.department));
  res.json({ certifications: rows });
});

// Training Reports & Analytics.
router.get('/reports', (req, res) => {
  if (!canViewLearning(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  const courses = courseSummary(scopeDeptNames);
  const totalEnrolled = courses.reduce((t, c) => t + c.enrolled, 0);
  const totalCompleted = courses.reduce((t, c) => t + c.completed, 0);
  const totalCertified = courses.reduce((t, c) => t + c.certified, 0);
  res.json({
    byCourse: courses.map((c) => ({ title: c.title, enrolled: c.enrolled, completed: c.completed, certified: c.certified, completionPct: c.completionPct })),
    totals: { totalEnrolled, totalCompleted, totalCertified, overallCompletionPct: totalEnrolled > 0 ? Math.round((totalCompleted / totalEnrolled) * 100) : 0 }
  });
});

// Active employees, for the picker dropdowns on Enrollment/Competency/Progress screens.
router.get('/employees', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json({ employees: db.prepare("SELECT id, name, employee_code FROM employees WHERE status = 'Active' ORDER BY name").all() });
});

// "Course Enrollment — who has access to what": every enrollment across every course.
router.get('/enrollments', (req, res) => {
  if (!canViewLearning(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const scoped = isScopedRole(req.user.role);
  const scopeDeptNames = scoped ? new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id))) : null;
  let rows = db.prepare(`
    SELECT ce.id, ce.completed, ce.score, ce.certificate_issued, e.name AS employee_name, e.id AS employee_id, e.department, c.title AS course_title
    FROM course_enrollments ce JOIN employees e ON e.id = ce.employee_id JOIN courses c ON c.id = ce.course_id
    ORDER BY ce.created_at DESC
  `).all();
  if (scoped) rows = rows.filter((r) => r.department && scopeDeptNames.has(r.department));
  const status = (r) => (r.certificate_issued ? 'Certified' : (r.completed ? 'Assessed' : 'In Progress'));
  res.json({ enrollments: rows.map((r) => ({ ...r, status: status(r) })), courses: db.prepare('SELECT id, title FROM courses ORDER BY title').all() });
});

router.post('/enrollments', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { employee_id, course_id } = req.body || {};
  const emp = employee_id ? db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id) : null;
  const course = course_id ? db.prepare('SELECT id FROM courses WHERE id = ?').get(course_id) : null;
  if (!emp || !course) return res.status(400).json({ error: 'A valid employee and course are required' });
  try {
    db.prepare('INSERT INTO course_enrollments (course_id, employee_id) VALUES (?, ?)').run(course.id, emp.id);
    res.status(201).json({ ok: true });
  } catch {
    res.status(409).json({ error: 'That employee is already enrolled in that course.' });
  }
});

// "Assessments & Assignments": every course's final assessment / completion criterion.
router.get('/assessments', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const courses = db.prepare('SELECT * FROM courses ORDER BY created_at').all();
  const assessments = courses.map((c) => ({
    course_id: c.id,
    course_title: c.title,
    pass_mark: c.pass_mark,
    questionCount: db.prepare('SELECT COUNT(*) c FROM course_questions WHERE course_id = ?').get(c.id).c
  }));
  res.json({ assessments });
});

// "Training Delivery & Scheduling": booked training sessions per course.
router.get('/sessions', (req, res) => {
  if (!canManageTrainingDelivery(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT ts.*, c.title AS course_title FROM training_sessions ts JOIN courses c ON c.id = ts.course_id ORDER BY ts.created_at DESC
  `).all();
  res.json({ sessions: rows, courses: db.prepare('SELECT id, title FROM courses ORDER BY title').all() });
});

router.post('/sessions', async (req, res) => {
  if (!canManageTrainingDelivery(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { course_id, mode, scheduled_at } = req.body || {};
  const course = course_id ? db.prepare('SELECT id, title FROM courses WHERE id = ?').get(course_id) : null;
  if (!course || !mode?.trim() || !scheduled_at?.trim()) return res.status(400).json({ error: 'Course, mode and date & time are all required' });
  const info = db.prepare('INSERT INTO training_sessions (course_id, mode, scheduled_at) VALUES (?, ?, ?)').run(course.id, mode.trim(), scheduled_at.trim());

  // Best-effort: if Google Calendar is connected (Integrations > Calendar Sync), also create a
  // real calendar event for this session. Never blocks or fails the session creation itself.
  if (googleCalendar.isConnected()) {
    try {
      const eventId = await googleCalendar.createCalendarEvent({
        summary: `Training: ${course.title}`,
        description: `Mode: ${mode.trim()}`,
        startsAt: scheduled_at.trim()
      });
      db.prepare('UPDATE training_sessions SET calendar_event_id = ? WHERE id = ?').run(eventId, info.lastInsertRowid);
    } catch { /* calendar push is best-effort — session is already saved either way */ }
  }
  res.status(201).json({ ok: true });
});

// "Skill Development & Competency Mapping — <Name>": per-employee skill/current/required/gap.
router.get('/employees/:id/skills', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const employee = db.prepare('SELECT id, name, employee_code FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const skills = db.prepare('SELECT * FROM employee_skills WHERE employee_id = ? ORDER BY created_at').all(employee.id)
    .map((s) => ({ ...s, gap: Math.max(0, s.required_level - s.current_level) }));
  res.json({ employee, skills });
});

router.post('/employees/:id/skills', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const { skill_name, current_level, required_level } = req.body || {};
  if (!skill_name?.trim()) return res.status(400).json({ error: 'Skill name is required' });
  const cur = Math.max(0, Math.min(5, parseInt(current_level, 10) || 0));
  const req_ = Math.max(0, Math.min(5, parseInt(required_level, 10) || 0));
  db.prepare('INSERT INTO employee_skills (employee_id, skill_name, current_level, required_level) VALUES (?, ?, ?, ?)').run(employee.id, skill_name.trim(), cur, req_);
  res.status(201).json({ ok: true });
});

// "Progress, Attendance & Feedback — <Name>": a Manager/Peer/Self feedback thread per employee.
router.get('/employees/:id/feedback', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const employee = db.prepare('SELECT id, name, employee_code FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const feedback = db.prepare('SELECT * FROM learning_feedback WHERE employee_id = ? ORDER BY created_at DESC').all(employee.id);
  res.json({ employee, feedback });
});

router.post('/employees/:id/feedback', (req, res) => {
  if (!isHR(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const { note, author_type } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: 'Feedback note is required' });
  const type = ['Manager', 'Peer', 'Self', 'Other'].includes(author_type) ? author_type : 'Other';
  db.prepare('INSERT INTO learning_feedback (employee_id, author_name, author_type, note) VALUES (?, ?, ?, ?)').run(employee.id, req.user.name || 'Anonymous', type, note.trim());
  res.status(201).json({ ok: true });
});

export default router;

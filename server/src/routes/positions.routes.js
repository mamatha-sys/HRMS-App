import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { canModuleAdmin, canFeatureAction } from '../utils/rbac.js';
import { isScopedRole, getSupervisorScope, scopeDepartmentNames } from '../utils/scope.js';
import { isJobBoardConnected, listJobBoards, jobBoardKeys } from '../utils/jobBoards.js';
import { suggestJobDescription } from '../utils/aiAssist.js';

const router = Router();
router.use(requireAuth);
const myEmployee = (sub) => db.prepare('SELECT * FROM employees WHERE user_id = ?').get(sub);

// The fixed job-board catalog + which ones Super Admin has connected in Integrations, for the
// Manage Posting checkboxes. Non-sensitive (no credentials), so no extra permission gate beyond
// being signed in.
router.get('/job-boards', (req, res) => {
  res.json({ boards: listJobBoards() });
});

// Job requisitions: everything except already-rejected ones. Scoped roles (assistant_manager/
// stl/tl) only see their own assigned department(s), same as Vacancies below — Manager/HR
// Admin/Super Admin keep company-wide visibility.
router.get('/', (req, res) => {
  let rows = db.prepare(`
    SELECT p.*, d.name AS department_name
    FROM positions p JOIN departments d ON d.id = p.department_id
    WHERE p.approval_status != 'Rejected'
    ORDER BY p.status = 'Closed', p.created_at DESC
  `).all();
  if (isScopedRole(req.user.role)) {
    const names = new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id)));
    rows = rows.filter((r) => names.has(r.department_name));
  }
  res.json({ positions: rows });
});

// Department list for the requisition-creation form's dropdown — scoped the same way as the
// list above, so an Assistant Manager/STL/TL only ever sees departments they can actually raise
// a requisition for (the write check below is the real enforcement; this just avoids offering
// choices that would 403).
router.get('/my-departments', (req, res) => {
  let departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
  if (isScopedRole(req.user.role)) {
    const names = new Set(scopeDepartmentNames(getSupervisorScope(myEmployee(req.user.sub)?.id)));
    departments = departments.filter((d) => names.has(d.name));
  }
  res.json({ departments });
});

// Job requisitions can be raised by Manager (company-wide, unchanged) and now also by
// Assistant Manager/STL/TL — but only for their own assigned department(s), matching every
// other scoped feature in this app (Leave, Attendance, Vacancies). Approval/posting stay
// HR-tier-only (see /:id/decide and /:id/posting below) — this only affects who can create one.
const REQUISITION_ROLES = ['super_admin', 'manager', 'assistant_manager', 'stl', 'tl'];

router.post('/ai-assist', async (req, res) => {
  if (!REQUISITION_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  try {
    const dept = req.body?.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(req.body.department_id) : null;
    const suggestion = await suggestJobDescription(req.body?.title, dept?.name);
    res.json(suggestion);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Drafts the JD from the position's own title/department, and stamps jd_date to today (matching
// what a human filling in "JD (date)" by hand would do) — shared by the auto-draft-on-create path
// below and the manual regenerate endpoint further down.
async function draftJobDescription(positionId, title, departmentName) {
  const { job_description } = await suggestJobDescription(title, departmentName);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('UPDATE positions SET job_description = ?, jd_date = ? WHERE id = ?').run(job_description, today, positionId);
  return job_description;
}

router.post('/', (req, res) => {
  if (!REQUISITION_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { department_id, title, target_headcount, is_replacement, replacement_for, replacement_target_date, job_description, jd_date } = req.body || {};
  if (!department_id || !title) return res.status(400).json({ error: 'department_id and title are required' });
  const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });

  if (isScopedRole(req.user.role)) {
    const scope = getSupervisorScope(myEmployee(req.user.sub)?.id);
    if (!scopeDepartmentNames(scope).includes(dept.name)) {
      return res.status(403).json({ error: 'You can only raise a requisition for your own assigned department.' });
    }
  }
  const replacing = !!is_replacement;
  if (replacing && !replacement_for?.trim()) return res.status(400).json({ error: 'Replacement requisitions need the departing employee\'s name.' });

  const count = Math.max(1, parseInt(target_headcount, 10) || 1);
  const info = db
    .prepare(`
      INSERT INTO positions (department_id, title, target_headcount, requested_by, approval_status, is_replacement, replacement_for, replacement_target_date, job_description, jd_date)
      VALUES (?, ?, ?, ?, 'Pending Approval', ?, ?, ?, ?, ?)
    `)
    .run(department_id, title, count, req.user.name || null, replacing ? 1 : 0, replacing ? replacement_for.trim() : null,
      replacing ? (replacement_target_date || null) : null, job_description?.trim() || null, jd_date || null);

  const positionId = info.lastInsertRowid;
  // HR left the JD blank — respond with the requisition already created (never make requisition
  // creation itself wait 10-30s on the model), then draft the JD in the background exactly like
  // the Offer Letter flow: the client polls and shows a "drafting" placeholder in the meantime.
  const jdPending = !job_description?.trim();
  res.status(201).json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId), jdPending });

  if (jdPending) {
    draftJobDescription(positionId, title, dept.name).catch(() => {
      // Local AI unavailable/flaky — requisition itself is unaffected; HR can still write the JD
      // by hand or hit the manual AI Assist / Regenerate button later.
    });
  }
});

// Manual re-draft — same helper the auto-draft-on-create path uses, for when HR wants a fresh
// attempt (a flaky/empty first draft) or just wants the AI to try again after editing the title.
router.post('/:id/job-description/regenerate', async (req, res) => {
  if (!REQUISITION_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  try {
    const dept = db.prepare('SELECT name FROM departments WHERE id = ?').get(position.department_id);
    await draftJobDescription(position.id, position.title, dept?.name);
    res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(position.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// HR hand-edits the AI draft (or writes their own from scratch).
router.put('/:id/job-description', (req, res) => {
  if (!REQUISITION_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const text = req.body?.job_description;
  if (!text?.trim()) return res.status(400).json({ error: 'Job description text is required.' });
  db.prepare('UPDATE positions SET job_description = ? WHERE id = ?').run(text.trim(), position.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(position.id) });
});

router.put('/:id', requireRole('super_admin', 'manager'), (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const status = req.body?.status === 'Closed' ? 'Closed' : 'Open';
  db.prepare('UPDATE positions SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Approve / reject a pending requisition.
router.put('/:id/decide', (req, res) => {
  // Feature-level gate: this is exactly the 'Department Vacancies' feature.
  if (!canFeatureAction(req.user.role, '05', 'Department Vacancies', 'Approve')) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  if (position.approval_status !== 'Pending Approval') return res.status(400).json({ error: 'This requisition has already been decided.' });
  const approve = req.body?.decision === 'approve';
  // Approving a requisition immediately posts it live on every currently-connected job board
  // (e.g. Naukri) — no separate manual step needed. HR can still open Manage Posting afterward
  // to add the Company Careers Page or drop a board.
  const autoBoards = approve ? jobBoardKeys().filter(isJobBoardConnected) : [];
  db.prepare("UPDATE positions SET approval_status = ?, status = ?, posted_boards = ? WHERE id = ?")
    .run(approve ? 'Approved' : 'Rejected', approve ? 'Open' : 'Closed', autoBoards.length ? JSON.stringify(autoBoards) : null, req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Set which job boards an approved requisition is posted live on — a fixed checkbox list
// (Naukri/LinkedIn/Shine/Indeed, gated by whether Super Admin has connected that board in
// Integrations, plus the always-available Company Careers Page), stored as a JSON array.
router.put('/:id/posting', (req, res) => {
  if (!canModuleAdmin(req.user.role, '05')) return res.status(403).json({ error: 'Insufficient permissions' });
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  if (position.approval_status !== 'Approved') return res.status(400).json({ error: 'Only an approved requisition can be posted.' });
  const requested = Array.isArray(req.body?.boards) ? req.body.boards : [];
  const boards = requested.filter((key) => key === 'careers' || isJobBoardConnected(key));
  db.prepare('UPDATE positions SET posted_boards = ? WHERE id = ?').run(boards.length ? JSON.stringify(boards) : null, req.params.id);
  res.json({ position: db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id) });
});

// Department-wise vacancies: current headcount (from employees) vs. open positions requested.
// STL/TL only ever see their own supervisor-assigned department(s) here, same as every other
// Dashboard widget — a department-level (STL) grant already covers every team within it.
router.get('/vacancies', (req, res) => {
  let departments = db.prepare('SELECT * FROM departments').all();
  const scoped = isScopedRole(req.user.role);
  const scope = scoped ? getSupervisorScope(myEmployee(req.user.sub)?.id) : null;
  if (scoped) {
    const names = new Set(scopeDepartmentNames(scope));
    departments = departments.filter((d) => names.has(d.name));
  }
  const vacancies = departments.map((dept) => {
    const current = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE department = ? AND status = 'Active'").get(dept.name).c;
    const openVacancies = db
      .prepare("SELECT COALESCE(SUM(target_headcount), 0) AS c FROM positions WHERE department_id = ? AND status = 'Open'")
      .get(dept.id).c;
    // Team-wise current headcount within the department — requisitions aren't tracked per-team,
    // only "current" splits by team. A TL's team-level grant only shows their own team(s); an
    // STL's department-level grant (or any unscoped role) sees every team in the department.
    let teams = db.prepare('SELECT id, name FROM teams WHERE department_id = ? ORDER BY name').all(dept.id);
    if (scoped && !scope.departmentNames.includes(dept.name)) teams = teams.filter((t) => scope.teamIds.includes(t.id));
    teams = teams.map((t) => ({ team_id: t.id, name: t.name, current: db.prepare("SELECT COUNT(*) AS c FROM employees WHERE team_id = ? AND status = 'Active'").get(t.id).c }));
    return {
      department_id: dept.id,
      department: dept.name,
      current,
      vacancies: openVacancies,
      target: current + openVacancies,
      teams
    };
  }).filter((d) => d.vacancies > 0 || d.current > 0);

  res.json({ vacancies });
});

export default router;

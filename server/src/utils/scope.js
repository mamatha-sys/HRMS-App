import db from '../db.js';

// Roles whose HR/admin access to Attendance, Leave, and Approvals is confined to whatever
// specific departments (STL) or teams (TL) Super Admin has assigned them in User Management,
// rather than the company-wide access every other HR-tier role (manager/hr_admin/etc.) gets.
// A single place to extend this list later if another role needs the same treatment.
//
// Assistant Manager was previously listed here, but is now company-wide per Super Admin policy:
// they need org-wide KPIs and the Department/Branch filters on the Dashboard. This also removes a
// long-standing inconsistency — Employee Management and Integrations already treated Assistant
// Manager as HR-tier (company-wide), while Attendance/Leave/Approvals/Dashboard scoped them, so
// the same role saw different populations depending on the screen.
//
// This governs only WHICH employees they can see. What they may DO is still decided separately by
// their Manage Roles grants (see rbac.js) — widening visibility here does not grant any
// create/edit/delete action they didn't already have.
export function isScopedRole(role) {
  return role === 'stl' || role === 'tl';
}

// The departments/teams a given employee (identified by their own employees.id, not user id)
// supervises, per supervisor_scopes. Unassigned by default — an STL/TL with no rows here sees
// nothing (fail-closed), rather than accidentally falling back to company-wide.
export function getSupervisorScope(employeeId) {
  if (!employeeId) return { departmentNames: [], teamIds: [] };
  const rows = db.prepare(`
    SELECT ss.department_id, ss.team_id, d.name AS department_name
    FROM supervisor_scopes ss
    LEFT JOIN departments d ON d.id = ss.department_id
    WHERE ss.employee_id = ?
  `).all(employeeId);
  return {
    departmentNames: rows.filter((r) => r.department_id).map((r) => r.department_name),
    teamIds: rows.filter((r) => r.team_id).map((r) => r.team_id)
  };
}

// Does this scope cover the given target employee record (must include at least
// `department` and `team_id`)? A department-level grant (STL) covers every team within it
// plus any teamless employee in that department; a team-level grant (TL) covers only that
// team's members.
export function isEmployeeInScope(scope, targetEmployee) {
  if (!targetEmployee) return false;
  if (scope.departmentNames.includes(targetEmployee.department)) return true;
  if (targetEmployee.team_id && scope.teamIds.includes(targetEmployee.team_id)) return true;
  return false;
}

// Convenience: filter a list of rows (each with `department` + `team_id`) down to what this
// role/employee is allowed to see. Non-scoped roles (or missing employee record) pass through
// unfiltered — scoping only ever narrows stl/tl, never widens or restricts anyone else.
export function filterToScope(rows, role, employeeId) {
  if (!isScopedRole(role)) return rows;
  const scope = getSupervisorScope(employeeId);
  return rows.filter((r) => isEmployeeInScope(scope, r));
}

// Same as filterToScope, but for a scoped employee with no explicit supervisor_scopes rows yet,
// falls back to their own department instead of failing closed to nothing — lets a freshly
// assigned STL/TL see useful data (their own department peers) before Super Admin has configured
// User Management, matching Employee Management's own "My Team"/scopedTeamRows precedent.
// Non-scoped roles (or a missing employee record) behave exactly like filterToScope.
export function filterToScopeOrOwnDepartment(rows, role, employeeId) {
  if (!isScopedRole(role)) return rows;
  if (!employeeId) return [];
  const hasExplicitScope = !!db.prepare('SELECT 1 FROM supervisor_scopes WHERE employee_id = ?').get(employeeId);
  if (hasExplicitScope) return filterToScope(rows, role, employeeId);
  const me = db.prepare('SELECT department FROM employees WHERE id = ?').get(employeeId);
  return me ? rows.filter((r) => r.department === me.department) : [];
}

// Single-target convenience wrapper around filterToScopeOrOwnDepartment, for the many call sites
// (Leave/Regularization approve/reject/reassign/cancel-decisions) that check one specific target
// employee rather than filtering a list — e.g. "is this leave requester within my reach?"
export function isEmployeeInScopeOrOwnDepartment(role, employeeId, targetEmployee) {
  if (!targetEmployee) return false;
  return filterToScopeOrOwnDepartment([targetEmployee], role, employeeId).length > 0;
}

// The full set of department NAMES this scope should be treated as covering — its direct
// department-level grants, plus the parent department of every team-level grant. Needed for
// content that's only ever targeted by department name (Notifications/Announcements have no
// per-team targeting of their own), where a TL's team-level grant must still resolve to "their
// team's department" to match anything.
export function scopeDepartmentNames(scope) {
  const names = new Set(scope.departmentNames);
  if (scope.teamIds.length) {
    const placeholders = scope.teamIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT DISTINCT d.name FROM teams t JOIN departments d ON d.id = t.department_id WHERE t.id IN (${placeholders})`).all(...scope.teamIds);
    rows.forEach((r) => names.add(r.name));
  }
  return [...names];
}

// Same own-department fallback as filterToScopeOrOwnDepartment, but for callers that need
// department names rather than filtered rows (e.g. matching Open Positions by department).
export function scopeDepartmentNamesOrOwn(role, employeeId) {
  if (!isScopedRole(role) || !employeeId) return [];
  const hasExplicitScope = !!db.prepare('SELECT 1 FROM supervisor_scopes WHERE employee_id = ?').get(employeeId);
  if (hasExplicitScope) return scopeDepartmentNames(getSupervisorScope(employeeId));
  const me = db.prepare('SELECT department FROM employees WHERE id = ?').get(employeeId);
  return me ? [me.department] : [];
}

import db from '../db.js';

// Roles whose HR/admin access to Attendance, Leave, and Approvals is confined to whatever
// specific departments (STL) or teams (TL) Super Admin has assigned them in User Management,
// rather than the company-wide access every other HR-tier role (manager/hr_admin/etc.) gets.
// A single place to extend this list later if another role needs the same treatment.
// Assistant Manager joined this list per Super Admin policy: Assistant Manager/STL/TL are all
// limited to viewing their own + assigned department/team's records and performing workflow
// approvals only — no create/edit/delete/configure/manage anywhere unless explicitly granted.
export function isScopedRole(role) {
  return role === 'stl' || role === 'tl' || role === 'assistant_manager';
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

import db from '../db.js';

// Roles whose HR/admin access to Attendance, Leave, and Approvals is confined to whatever
// specific departments (STL) or teams (TL) Super Admin has assigned them in User Management,
// rather than the company-wide access every other HR-tier role (manager/hr_admin/etc.) gets.
// A single place to extend this list later if another role needs the same treatment.
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

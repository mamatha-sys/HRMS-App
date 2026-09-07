// Shared Employee ID / Name / Department / Designation narrowing for any screen that lists
// employees. Extracted from attendance.routes.js, where it was already serving the Biometric
// List, Punch Log and Monthly Report, so Payroll's preview and run can filter the same way rather
// than growing a second, subtly different copy.
//
// This narrows what an ALREADY-AUTHORISED caller is looking at. It is not an access check: every
// call site must still have run its own scope filtering (filterToScopeOrOwnDepartment) first, so
// passing a department outside your scope can only ever return fewer rows, never more.
//
// Employee code and name match on a case-insensitive substring — these back "filter as you type"
// boxes. Department and designation are exact, since they come from dropdowns of real values.
export function applyEmployeeFilters(employees, query = {}) {
  let rows = employees;
  if (query.employeeCode) {
    const q = String(query.employeeCode).toLowerCase();
    rows = rows.filter((e) => e.employee_code?.toLowerCase().includes(q));
  }
  if (query.name) {
    const q = String(query.name).toLowerCase();
    rows = rows.filter((e) => e.name?.toLowerCase().includes(q));
  }
  if (query.department) rows = rows.filter((e) => e.department === query.department);
  if (query.designation) rows = rows.filter((e) => e.designation === query.designation);
  return rows;
}

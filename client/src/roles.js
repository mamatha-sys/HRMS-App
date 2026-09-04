// Roles whose view of Attendance, Leave, Approvals and the Dashboard is confined to their
// assigned department(s)/team(s) rather than being company-wide.
//
// This MUST stay in step with isScopedRole() in server/src/utils/scope.js — the server is the
// authority and already enforces the narrowing; this list only controls what the UI offers, so
// drift between the two shows up as a screen promising data the API will never return.
// Assistant Manager is deliberately NOT here: they are company-wide, so they keep the
// Department/Branch filter bar and org-wide KPIs. Only STL/TL are narrowed to an assigned
// department/team.
export const SCOPED_ROLES = ['stl', 'tl'];

export const isScopedRole = (role) => SCOPED_ROLES.includes(role);

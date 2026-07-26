import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

// Every business-module NavLink, mapped to its Manage Roles permission-matrix module code.
// A role only sees a link here if it has been granted at least one permission on that module
// — dynamically driven by /api/my-access, not hardcoded.
const MODULES = [
  { path: '/employees', label: 'Employee Management', code: '02' },
  { path: '/attendance', label: 'Attendance', code: '07' },
  { path: '/leave', label: 'Leave Management', code: '08' },
  { path: '/payroll', label: 'Payroll', code: '09' },
  { path: '/recruitment', label: 'Recruitment', code: '05' },
  { path: '/performance', label: 'Performance Management', code: '10' },
  { path: '/learning', label: 'Learning Management', code: '11' },
  { path: '/assets', label: 'Asset Management', code: '12' },
  { path: '/helpdesk', label: 'Helpdesk', code: '13' },
  { path: '/announcements', label: 'Announcements', code: '14' },
  { path: '/expenses', label: 'Expense & Travel Claims', code: '15' },
  { path: '/surveys', label: 'Engagement Surveys', code: '16' },
  { path: '/documents', label: 'Document Management', code: '17' },
  { path: '/shift-roster', label: 'Shift & Roster', code: '18' },
  { path: '/recognition', label: 'Rewards & Recognition', code: '19' },
  { path: '/projects', label: 'Project & Resource Management', code: '20' },
  { path: '/timesheet', label: 'Timesheet', code: '21' },
  { path: '/disciplinary', label: 'Disciplinary Action Tracking', code: '22' }
];
const DASHBOARD_CODE = '01';

export default function Sidebar() {
  const { user } = useAuth();
  const [access, setAccess] = useState(null);
  const item = ({ isActive }) => 'nav-item' + (isActive ? ' active' : '');

  useEffect(() => { api.get('/my-access').then((r) => setAccess(r.data)).catch(() => {}); }, []);

  // While loading (or if the call fails), fall back to showing everything rather than
  // flashing an empty sidebar — access is enforced server-side regardless.
  const canSee = (code) => !access || access.isSuperAdmin || !!access.modules[code];

  return (
    <div className="sidebar">
      <div className="section-label">Menu</div>
      {canSee(DASHBOARD_CODE) && (
        <NavLink to="/dashboard" className={item}>
          <span className="dot" />Dashboard
        </NavLink>
      )}

      <div className="section-label">Modules</div>
      {MODULES.filter((m) => canSee(m.code)).map((m) => (
        <NavLink key={m.path} to={m.path} className={item}>
          <span className="dot" />{m.label}
        </NavLink>
      ))}

      {user?.role === 'super_admin' && (
        <>
          <div className="section-label">Admin (Super Admin only)</div>
          <NavLink to="/configurations" className={item}>
            <span className="dot" />Configurations
          </NavLink>
          <NavLink to="/policies" className={item}>
            <span className="dot" />Configuration Policies
          </NavLink>
          <NavLink to="/roles" className={item}>
            <span className="dot" />Manage Roles
          </NavLink>
          <NavLink to="/org-structure" className={item}>
            <span className="dot" />Organization Structure
          </NavLink>
          <NavLink to="/integrations" className={item}>
            <span className="dot" />Integrations
          </NavLink>
        </>
      )}
    </div>
  );
}

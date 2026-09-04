import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';
import { ICONS } from './NavIcons.jsx';

// Every business-module NavLink, mapped to its Manage Roles permission-matrix module code.
// A role only sees a link here if it has been granted at least one permission on that module
// — dynamically driven by /api/my-access, not hardcoded.
const MODULES = [
  { path: '/employees', label: 'Employee Management', code: '02', icon: 'employees' },
  { path: '/attendance', label: 'Attendance', code: '07', icon: 'attendance' },
  { path: '/leave', label: 'Leave Management', code: '08', icon: 'leave' },
  { path: '/payroll', label: 'Payroll', code: '09', icon: 'payroll' },
  { path: '/recruitment', label: 'Recruitment', code: '05', icon: 'recruitment' },
  { path: '/performance', label: 'Performance Management', code: '10', icon: 'performance' },
  { path: '/learning', label: 'Learning Management', code: '11', icon: 'learning' },
  { path: '/assets', label: 'Asset Management', code: '12', icon: 'assets' },
  { path: '/helpdesk', label: 'Helpdesk', code: '13', icon: 'helpdesk' },
  { path: '/announcements', label: 'Announcements', code: '14', icon: 'announcements' },
  { path: '/expenses', label: 'Expense & Travel Claims', code: '15', icon: 'expenses' },
  { path: '/surveys', label: 'Engagement Surveys', code: '16', icon: 'surveys' },
  { path: '/documents', label: 'Document Management', code: '17', icon: 'documents' },
  { path: '/shift-roster', label: 'Shift & Roster', code: '18', icon: 'shiftRoster' },
  { path: '/recognition', label: 'Rewards & Recognition', code: '19', icon: 'recognition' },
  { path: '/projects', label: 'Project & Resource Management', code: '20', icon: 'projects' },
  { path: '/timesheet', label: 'Timesheet', code: '21', icon: 'timesheet' },
  { path: '/disciplinary', label: 'Disciplinary Action Tracking', code: '22', icon: 'disciplinary' },
  { path: '/knowledge-transfer', label: 'Knowledge Transfer', code: '23', icon: 'knowledgeTransfer' }
];
const DASHBOARD_CODE = '01';

const ADMIN_LINKS = [
  { path: '/configurations', label: 'Configurations', icon: 'configurations' },
  { path: '/policies', label: 'Configuration Policies', icon: 'policies' },
  { path: '/roles', label: 'Manage Roles', icon: 'roles' },
  { path: '/org-structure', label: 'Organization Structure', icon: 'orgStructure' },
  { path: '/integrations', label: 'Integrations', icon: 'integrations' }
];

export default function Sidebar({ collapsed, mobileOpen, onToggle, onCloseMobile }) {
  const { user } = useAuth();
  const [access, setAccess] = useState(null);

  // Permissions are changed by someone ELSE (Super Admin in Manage Roles), so fetching once on
  // mount left this menu stale until a full page reload or re-login — a revoked module kept
  // showing, which reads as "removing the permission did nothing". Re-fetch whenever this tab
  // regains focus, the same self-refresh idiom the Dashboard already uses.
  useEffect(() => {
    const refresh = () => api.get('/my-access').then((r) => setAccess(r.data)).catch(() => {});
    refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // While loading (or if the call fails), fall back to showing everything rather than
  // flashing an empty sidebar — access is enforced server-side regardless.
  const canSee = (code) => !access || access.isSuperAdmin || !!access.modules[code];
  const itemClass = ({ isActive }) => 'nav-item' + (isActive ? ' active' : '');

  const Item = ({ to, label, icon }) => (
    <NavLink to={to} className={itemClass} data-tooltip={label} onClick={onCloseMobile}>
      <span className="nav-icon" aria-hidden="true">{ICONS[icon]}</span>
      <span className="nav-label">{label}</span>
    </NavLink>
  );

  const sidebarClass = 'sidebar' + (collapsed ? ' collapsed' : '') + (mobileOpen ? ' mobile-open' : '');

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <div className={sidebarClass}>
        <button type="button" className="hamburger-btn" onClick={onToggle} aria-label="Toggle sidebar menu">☰</button>

        <div className="section-label">Menu</div>
        {canSee(DASHBOARD_CODE) && <Item to="/dashboard" label="Dashboard" icon="dashboard" />}

        <div className="section-label">Modules</div>
        {MODULES.filter((m) => canSee(m.code)).map((m) => (
          <Item key={m.path} to={m.path} label={m.label} icon={m.icon} />
        ))}

        {user?.role === 'super_admin' && (
          <>
            <div className="section-label">Admin (Super Admin only)</div>
            {ADMIN_LINKS.map((a) => (
              <Item key={a.path} to={a.path} label={a.label} icon={a.icon} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

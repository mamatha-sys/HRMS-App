import { Link } from 'react-router-dom';

const ACTIONS = [
  { to: '/employees', label: '+ Add Employee', roles: ['super_admin', 'manager'] },
  { to: '/bulk-import', label: '+ Bulk Import', roles: ['super_admin', 'manager'] },
  { to: '/organization', label: '+ Add Departments', roles: ['super_admin'] },
  { to: '/organization', label: '+ Add Branch', roles: ['super_admin'] },
  { to: '/policies', label: '+ Configuration Policies', roles: ['super_admin'] },
  { to: '/org-structure', label: '+ Organization Structure', roles: ['super_admin'] },
  { to: '/configurations', label: '+ Configure Dashboard', roles: ['super_admin'] },
  { to: '/roles', label: '+ Manage Roles', roles: ['super_admin'] },
  { to: '/manage-modules', label: '+ Add Module / Features', roles: ['super_admin'] }
];

export default function QuickActionsWidget({ role, badge }) {
  const visible = ACTIONS.filter((a) => a.roles.includes(role));
  if (visible.length === 0) return null;

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>
        {badge && <span className="widget-badge">{badge}</span>}Quick Actions
      </div>
      {visible.map((a, i) => (
        <Link key={a.label + i} to={a.to} style={{ display: 'block', textDecoration: 'none' }}>
          <button style={{ width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' }}>
            {a.label}
          </button>
        </Link>
      ))}
    </div>
  );
}

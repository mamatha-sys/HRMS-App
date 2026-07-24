import { Link } from 'react-router-dom';

const ACTIONS = [
  { to: '/employees', label: '+ Add Employee', roles: ['super_admin', 'manager'] },
  { to: '/permissions', label: '+ Configure permissions', roles: ['super_admin'] },
  { to: '/users', label: '+ Manage Roles', roles: ['super_admin'] },
  { to: '/manage-modules', label: '+ Add Module', roles: ['super_admin'] },
  { to: '/manage-modules', label: '+ Add Features', roles: ['super_admin'] }
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

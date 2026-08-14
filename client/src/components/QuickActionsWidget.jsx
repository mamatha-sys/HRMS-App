import { Link } from 'react-router-dom';

// `roles: null` means visible to every role (used for the AI Assistant shortcut, which isn't an
// admin action) — every other entry stays opt-in per role like before.
const ACTIONS = [
  { label: '💬 Ask AI Assistant', action: 'open-chat', roles: null },
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
  const visible = ACTIONS.filter((a) => a.roles === null || a.roles.includes(role));
  if (visible.length === 0) return null;

  const buttonStyle = { width: '100%', marginBottom: 6, textAlign: 'left', background: '#FBF2DE', borderColor: '#F0DDB5', color: '#8A5A0A' };

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>
        {badge && <span className="widget-badge">{badge}</span>}Quick Actions
      </div>
      {visible.map((a, i) => (
        a.action === 'open-chat' ? (
          <button key={a.label + i} style={buttonStyle} onClick={() => window.dispatchEvent(new CustomEvent('hrms:open-assistant'))}>
            {a.label}
          </button>
        ) : (
          <Link key={a.label + i} to={a.to} style={{ display: 'block', textDecoration: 'none' }}>
            <button style={buttonStyle}>{a.label}</button>
          </Link>
        )
      ))}
    </div>
  );
}

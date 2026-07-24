import { useAuth } from '../context/AuthContext.jsx';

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  employee: 'Employee'
};

export default function Topbar() {
  const { user, logout } = useAuth();

  return (
    <div className="topbar">
      <div className="brand">HRMS <span>Employee &amp; Attendance Console</span></div>
      <div className="role-switch">
        <span>{user?.name} · {ROLE_LABELS[user?.role] || user?.role}</span>
        <button onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

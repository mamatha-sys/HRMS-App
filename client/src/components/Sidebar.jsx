import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Sidebar() {
  const { user } = useAuth();
  const item = ({ isActive }) => 'nav-item' + (isActive ? ' active' : '');

  return (
    <div className="sidebar">
      <div className="section-label">Menu</div>
      <NavLink to="/dashboard" className={item}>
        <span className="dot" />Dashboard
      </NavLink>

      <div className="section-label">Modules</div>
      <NavLink to="/employees" className={item}>
        <span className="dot" />Employee Management
      </NavLink>

      {user?.role === 'super_admin' && (
        <>
          <div className="section-label">Admin (Super Admin only)</div>
          <NavLink to="/configurations" className={item}>
            <span className="dot" />Configurations
          </NavLink>
          <NavLink to="/roles" className={item}>
            <span className="dot" />Manage Roles
          </NavLink>
        </>
      )}
    </div>
  );
}

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
      <NavLink to="/attendance" className={item}>
        <span className="dot" />Attendance
      </NavLink>
      <NavLink to="/leave" className={item}>
        <span className="dot" />Leave Management
      </NavLink>
      <NavLink to="/payroll" className={item}>
        <span className="dot" />Payroll
      </NavLink>
      <NavLink to="/recruitment" className={item}>
        <span className="dot" />Recruitment
      </NavLink>
      <NavLink to="/performance" className={item}>
        <span className="dot" />Performance Management
      </NavLink>
      <NavLink to="/learning" className={item}>
        <span className="dot" />Learning Management
      </NavLink>
      <NavLink to="/assets" className={item}>
        <span className="dot" />Asset Management
      </NavLink>

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
        </>
      )}
    </div>
  );
}

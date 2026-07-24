import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

export default function Sidebar() {
  const { user } = useAuth();
  const item = ({ isActive }) => 'nav-item' + (isActive ? ' active' : '');
  const [customModules, setCustomModules] = useState([]);

  useEffect(() => {
    api.get('/modules').then((res) => setCustomModules(res.data.modules)).catch(() => {});
  }, []);

  const isManagerUp = user?.role === 'super_admin' || user?.role === 'manager';

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
      <NavLink to="/recruitment" className={item}>
        <span className="dot" />Recruitment
      </NavLink>
      {isManagerUp && (
        <NavLink to="/reports" className={item}>
          <span className="dot" />Reports
        </NavLink>
      )}

      {customModules.length > 0 && (
        <>
          <div className="section-label">Custom Modules</div>
          {customModules.map((m) => (
            <div key={m.id}>
              <div className="nav-item" style={{ cursor: 'default', fontWeight: 600, color: '#8A93A6' }}>{m.name}</div>
              {m.features.map((f) => (
                <NavLink key={f.id} to={`/custom/${m.id}/${f.id}`} className={item} style={{ paddingLeft: 20 }}>
                  <span className="dot" />{f.name}
                </NavLink>
              ))}
            </div>
          ))}
        </>
      )}

      {user?.role === 'super_admin' && (
        <>
          <div className="section-label">Admin (Super Admin only)</div>
          <NavLink to="/organization" className={item}>
            <span className="dot" />Organization Structure
          </NavLink>
          <NavLink to="/permissions" className={item}>
            <span className="dot" />Manage Permissions
          </NavLink>
          <NavLink to="/users" className={item}>
            <span className="dot" />Role &amp; User Management
          </NavLink>
          <NavLink to="/manage-modules" className={item}>
            <span className="dot" />Manage Modules &amp; Features
          </NavLink>
        </>
      )}
    </div>
  );
}

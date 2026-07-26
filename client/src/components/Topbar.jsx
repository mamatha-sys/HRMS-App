import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api.js';

const ROLE_LABELS = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  employee: 'Employee'
};

export default function Topbar() {
  const { user, logout } = useAuth();
  const [branding, setBranding] = useState(null);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  return (
    <div className="topbar">
      <div className="brand">
        {branding?.company_logo && <img src={branding.company_logo} alt="" className="brand-logo" />}
        {branding?.company_name || 'HRMS'} <span>Employee &amp; Attendance Console</span>
      </div>
      <div className="role-switch">
        <span>{user?.name} · {ROLE_LABELS[user?.role] || user?.role}</span>
        <button onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

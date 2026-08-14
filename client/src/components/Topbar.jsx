import { useEffect, useRef, useState } from 'react';
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
  const rootRef = useRef(null);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  // The sidebar's mobile drawer needs to start exactly below the topbar, but the topbar's own
  // height varies (branding logo size). Publish it as a CSS var so the drawer/backdrop never
  // have to hardcode a pixel value that could drift out of sync.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const setVar = () => document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="topbar" ref={rootRef}>
      <div className="brand">
        {branding?.company_logo && <img src={branding.company_logo} alt="" className="brand-logo" />}
        {branding?.company_name || 'HRMS'}
      </div>
      <div className="role-switch">
        <span>{user?.name} · {ROLE_LABELS[user?.role] || user?.role}</span>
        <button onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

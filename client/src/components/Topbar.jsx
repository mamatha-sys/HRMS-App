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
  const [aiStatus, setAiStatus] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => { api.get('/branding').then((r) => setBranding(r.data)).catch(() => {}); }, []);

  // The only always-visible signal that local AI (Ollama) is actually reachable — every AI
  // feature elsewhere in the app otherwise degrades silently (a background draft that never
  // lands, a chat reply that just errors) with no way to tell "it's down" from "it's slow".
  useEffect(() => {
    let cancelled = false;
    const check = () => api.get('/agent/status').then((r) => { if (!cancelled) setAiStatus(r.data); }).catch(() => { if (!cancelled) setAiStatus({ available: false }); });
    check();
    const id = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

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
        {aiStatus && (
          <span
            className={'ai-status-badge' + (aiStatus.available ? ' online' : ' offline')}
            title={aiStatus.available ? 'Local AI (Ollama) is running — AI features are available.' : 'Local AI (Ollama) is not reachable — AI-powered features (assistant, offer letters, ticket suggestions, etc.) will not work until it is started on the server.'}
          >
            {aiStatus.available ? '🟢 AI' : '🔴 AI Offline'}
          </span>
        )}
        <span>{user?.name} · {ROLE_LABELS[user?.role] || user?.role}</span>
        <button onClick={logout}>Logout</button>
      </div>
    </div>
  );
}

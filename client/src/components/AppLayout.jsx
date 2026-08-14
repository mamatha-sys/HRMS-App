import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Topbar from './Topbar.jsx';
import Sidebar from './Sidebar.jsx';
import ChatAssistant from './ChatAssistant.jsx';

const MOBILE_BREAKPOINT = 768;

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // One hamburger, two meanings: a narrow icon-rail toggle on desktop/tablet where the sidebar
  // stays in-flow, vs. a slide-in/out drawer on mobile where it doesn't have room to live in-flow.
  const toggleSidebar = () => {
    if (window.innerWidth <= MOBILE_BREAKPOINT) setMobileOpen((v) => !v);
    else setCollapsed((v) => !v);
  };

  return (
    <div className="app-shell">
      <Topbar />
      <div className="layout">
        <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onToggle={toggleSidebar} onCloseMobile={() => setMobileOpen(false)} />
        <div className="main">
          <Outlet />
        </div>
        {/* Lives outside the sidebar's own box on purpose: the mobile drawer is translated fully
            off-screen when closed, so a trigger placed inside it would have no way to open it. */}
        {!mobileOpen && (
          <button type="button" className="mobile-menu-fab" onClick={toggleSidebar} aria-label="Open sidebar menu">☰</button>
        )}
      </div>
      <ChatAssistant />
    </div>
  );
}

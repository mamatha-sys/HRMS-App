import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';

// Reuses GET /announcements as-is — same audience scoping (company-wide, department-targeted,
// or individually-targeted) an employee already gets on the full Announcements page, and the
// same feed an AI Agent post_announcement lands in (it's just a normal POST /announcements under
// the hood — see agent.routes.js), so nothing here needs to special-case who/what created it.
const CATEGORY_CLASS = { General: 'info', Policy: 'pending', Event: 'present', Holiday: 'present' };
const PREVIEW_COUNT = 5;
const DASHBOARD_AGE_MS = 24 * 60 * 60 * 1000;

export default function AnnouncementsWidget({ badge, department = '' }) {
  const [announcements, setAnnouncements] = useState([]);

  useEffect(() => {
    api.get('/announcements', { params: department ? { department } : {} })
      .then((r) => setAnnouncements(r.data.announcements)).catch(() => {});
  }, [department]);

  // The Dashboard is "what's fresh," not a permanent archive — that's what the full Announcements
  // page is for (this same feed, unfiltered). A pinned notice (e.g. a standing policy) stays
  // visible here regardless of age since HR pinned it specifically to keep it in view; anything
  // unpinned (a meeting reminder, a one-off notice) drops off the Dashboard after one day.
  const now = Date.now();
  const recentOrPinned = announcements.filter((a) => a.pinned || (now - new Date(`${a.created_at}Z`).getTime()) < DASHBOARD_AGE_MS);
  const preview = recentOrPinned.slice(0, PREVIEW_COUNT);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="feature-name">{badge && <span className="widget-badge">{badge}</span>}Announcements &amp; Meeting Notices</div>
        <Link to="/announcements"><button>View all</button></Link>
      </div>

      {preview.length === 0 && <div className="empty">No announcements yet.</div>}
      {preview.map((a) => (
        <div key={a.id} className="rec-row" style={{ alignItems: 'flex-start' }}>
          <span>
            <span className={'status-tag ' + (CATEGORY_CLASS[a.category] || 'info')} style={{ marginRight: 6 }}>{a.category}</span>
            {!!a.pinned && <span className="status-tag pending" style={{ marginRight: 6 }}>Pinned</span>}
            <strong>{a.title}</strong>
            {a.body && <div className="feature-meta">{a.body.length > 140 ? `${a.body.slice(0, 140)}…` : a.body}</div>}
            <div className="feature-meta">{a.created_at?.slice(0, 10)}</div>
          </span>
        </div>
      ))}
    </div>
  );
}

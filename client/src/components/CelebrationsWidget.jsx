import { useEffect, useState } from 'react';
import api from '../api.js';

// Upcoming birthdays and work anniversaries — same GET /dashboard/celebrations for every role
// (see dashboard.routes.js), so a Super Admin and a plain employee see the identical list. No
// department/team *scoping*, unlike the rest of the Dashboard — this is a shared team-morale
// feature, not a data-access concern. The `department` prop is different: it is the Dashboard's
// own filter bar, so when the whole page is narrowed to one department this list follows it.
function whenLabel(daysAway) {
  if (daysAway === 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  return `In ${daysAway} days`;
}
const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
};

export default function CelebrationsWidget({ badge, department = '' }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/dashboard/celebrations', { params: department ? { department } : {} })
      .then((r) => setData(r.data)).catch(() => {});
  }, [department]);

  const birthdays = data?.birthdays || [];
  const anniversaries = data?.anniversaries || [];

  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 10 }}>{badge && <span className="widget-badge">{badge}</span>}Birthdays &amp; Work Anniversaries</div>

      {data && birthdays.length === 0 && anniversaries.length === 0 && <div className="empty">Nothing coming up in the next 2 weeks.</div>}

      {birthdays.length > 0 && (
        <>
          <div className="feature-meta" style={{ marginBottom: 6 }}>🎂 Birthdays</div>
          {birthdays.map((b) => (
            <div key={b.id} className="rec-row">
              <span>{b.name}{b.department ? <span className="feature-meta"> — {b.department}</span> : null}</span>
              <span className="status-tag pending">{whenLabel(b.daysAway)}</span>
            </div>
          ))}
        </>
      )}

      {anniversaries.length > 0 && (
        <>
          <div className="feature-meta" style={{ margin: birthdays.length ? '10px 0 6px' : '0 0 6px' }}>🎉 Work Anniversaries</div>
          {anniversaries.map((a) => (
            <div key={a.id} className="rec-row">
              <span>{a.name}{a.department ? <span className="feature-meta"> — {a.department}</span> : null}<div className="feature-meta">{ordinal(a.years)} year{a.years === 1 ? '' : 's'}</div></span>
              <span className="status-tag present">{whenLabel(a.daysAway)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';

const TOP_N = 5;

export default function IdeaLeaderboardWidget({ badge, department = '' }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/ideas/leaderboard', { params: department ? { department } : {} })
      .then((r) => setData(r.data)).catch(() => {});
  }, [department]);

  const top = data?.leaderboard.slice(0, TOP_N) || [];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="feature-name">{badge && <span className="widget-badge">{badge}</span>}Weekly Idea Contribution Leaderboard</div>
        <Link to="/knowledge-transfer"><button>Submit / View all</button></Link>
      </div>

      {!data && <div className="empty">Loading…</div>}
      {data && top.length === 0 && <div className="empty">No approved ideas yet — be the first to contribute this week.</div>}
      {top.map((l, i) => (
        <div key={l.employee_id} className="rec-row">
          <span><strong>#{i + 1}</strong> {l.name} <span className="feature-meta">({l.ideaCount} idea{l.ideaCount === 1 ? '' : 's'})</span></span>
          <span className="feature-meta">Total: {Math.round(l.totalScore)} · This week: {Math.round(l.weekScore)}</span>
        </div>
      ))}
    </div>
  );
}

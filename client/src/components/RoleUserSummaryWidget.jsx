import { Link } from 'react-router-dom';

export default function RoleUserSummaryWidget({ usersCount, badge }) {
  return (
    <div className="card">
      <div className="feature-name" style={{ marginBottom: 6 }}>
        {badge && <span className="widget-badge">{badge}</span>}Role &amp; User Management
      </div>
      <div className="feature-meta" style={{ marginBottom: 10 }}>{usersCount} users · 3 roles (Super Admin, Manager, Employee)</div>
      <Link to="/users"><button className="primary">Manage Users →</button></Link>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import DonutChart from '../components/DonutChart.jsx';
import NotificationsWidget from '../components/NotificationsWidget.jsx';
import EventsWidget from '../components/EventsWidget.jsx';
import TasksWidget from '../components/TasksWidget.jsx';

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/dashboard/summary')
      .then((res) => setSummary(res.data))
      .catch(() => setError('Could not load dashboard data.'));
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="subtitle">Viewing as <strong>{user?.name}</strong>.</div>

      {error && <div className="banner error">{error}</div>}
      {!summary && !error && <div className="empty">Loading dashboard...</div>}

      {summary && (
        <>
          <NotificationsWidget canCreate={user?.role === 'super_admin' || user?.role === 'manager'} />
          <EventsWidget canCreate={user?.role === 'super_admin' || user?.role === 'manager'} />
          <TasksWidget canAssignOthers={user?.role === 'super_admin' || user?.role === 'manager'} />
        </>
      )}

      {summary && summary.role === 'employee' && (
        <div className="card">
          {summary.me ? (
            <>
              <div className="feature-name">{summary.me.name}</div>
              <div className="feature-meta">
                {summary.me.designation} · {summary.me.department} · Joined {summary.me.date_of_joining}
              </div>
              <span className={'status-tag ' + (summary.me.status === 'Active' ? 'present' : 'absent')} style={{ marginTop: 10, display: 'inline-block' }}>
                {summary.me.status}
              </span>
            </>
          ) : (
            <div className="empty">No employee record is linked to your account yet.</div>
          )}
        </div>
      )}

      {summary && summary.role !== 'employee' && (
        <>
          <div className="kpi-row">
            {summary.kpis.map((k) => (
              <div key={k.label} className={'kpi-card ' + k.color}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
              </div>
            ))}
          </div>

          {summary.departmentBreakdown.length > 0 && (
            <DonutChart
              title="Department distribution"
              data={summary.departmentBreakdown.map((d) => ({ label: d.department, value: d.count }))}
            />
          )}

          <div className="section-label" style={{ paddingLeft: 0, marginTop: 10 }}>Quick links</div>
          <div className="grid2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginTop: 8, marginBottom: 20 }}>
            <Link to="/employees" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="feature-name">Employee Management</div>
              <div className="feature-meta">View and manage employee records</div>
            </Link>
          </div>

          <div className="section-label" style={{ paddingLeft: 0 }}>Recently added employees</div>
          <div className="card">
            {summary.recentEmployees.length === 0 && <div className="empty">No employees yet.</div>}
            {summary.recentEmployees.map((e) => (
              <div key={e.id} className="rec-row">
                <span>{e.name} — {e.designation}</span>
                <span className={'status-tag ' + (e.status === 'Active' ? 'present' : 'absent')}>{e.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import api from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';
import LineChart from '../components/LineChart.jsx';
import BarChart from '../components/BarChart.jsx';
import NotificationsWidget from '../components/NotificationsWidget.jsx';
import EventsWidget from '../components/EventsWidget.jsx';
import TasksWidget from '../components/TasksWidget.jsx';
import VacanciesWidget from '../components/VacanciesWidget.jsx';
import QuickActionsWidget from '../components/QuickActionsWidget.jsx';
import RoleUserSummaryWidget from '../components/RoleUserSummaryWidget.jsx';

const BANNERS = {
  super_admin: 'Full, unrestricted access — every widget below, organization-wide, no scope restriction.',
  manager: 'Team/organization view — bank and identity fields are masked on records that are not your own, per Manage Permissions.',
  employee: 'You see only your own information — no organization-wide or team data on this screen.'
};

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [filters, setFilters] = useState({ department: '', branch: '', status: '' });

  function load(f) {
    const params = {};
    if (f.department) params.department = f.department;
    if (f.branch) params.branch = f.branch;
    if (f.status) params.status = f.status;
    api.get('/dashboard/summary', { params }).then((res) => setSummary(res.data)).catch(() => setError('Could not load dashboard data.'));
  }

  useEffect(() => { load(filters); }, [filters]);
  useEffect(() => {
    if (user?.role === 'employee') return;
    api.get('/org/departments').then((res) => setDepartments(res.data.departments)).catch(() => {});
    api.get('/org/branches').then((res) => setBranches(res.data.branches)).catch(() => {});
  }, [user]);

  async function downloadCsv() {
    const res = await api.get('/reports/employees.csv', { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = 'employees.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="subtitle">Signed in as: <strong>{user?.name}</strong></div>

      {user?.role && BANNERS[user.role] && <div className="banner info">{BANNERS[user.role]}</div>}
      {error && <div className="banner error">{error}</div>}
      {!summary && !error && <div className="empty">Loading dashboard...</div>}

      {summary && summary.role !== 'employee' && (
        <>
          <div className="filter-bar">
            <select value={filters.department} onChange={(e) => setFilters({ ...filters, department: e.target.value })}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
            <select value={filters.branch} onChange={(e) => setFilters({ ...filters, branch: e.target.value })}>
              <option value="">All Branches</option>
              {branches.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            <div className="spacer" />
            {(user?.role === 'super_admin' || user?.role === 'manager') && (
              <button className="primary" onClick={downloadCsv}>Export</button>
            )}
          </div>

          <div className="kpi-row">
            {summary.kpis.map((k) => (
              <div key={k.label} className={'kpi-card ' + k.color}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
              </div>
            ))}
          </div>

          <div className="dashboard-grid">
            <div>
              <LineChart title="Employee / Organization Growth" data={summary.growthTrend} exportFilename="growth.csv" />
              <BarChart title="New Hires by Year" data={summary.hiringTrend} exportFilename="hiring.csv" />
              <BarChart title="Department Strength & Distribution" data={summary.departmentBreakdown.map((d) => ({ label: d.department, value: d.count }))} exportFilename="departments.csv" />
            </div>
            <div>
              <TasksWidget badge={1} canAssignOthers={user?.role === 'super_admin' || user?.role === 'manager'} />
            </div>
            <div>
              <NotificationsWidget badge={2} canCreate={user?.role === 'super_admin' || user?.role === 'manager'} />
            </div>
          </div>

          <div className="dashboard-grid">
            <QuickActionsWidget badge={3} role={user?.role} />
            <VacanciesWidget badge={4} />
            <EventsWidget badge={5} canCreate={user?.role === 'super_admin' || user?.role === 'manager'} />
          </div>

          {user?.role === 'super_admin' && (
            <div className="dashboard-grid">
              <RoleUserSummaryWidget badge={6} usersCount={summary.usersCount} />
            </div>
          )}
        </>
      )}

      {summary && summary.role === 'employee' && (
        <>
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

          <div className="dashboard-grid">
            <TasksWidget badge={1} canAssignOthers={false} />
            <NotificationsWidget badge={2} canCreate={false} />
            <EventsWidget badge={3} canCreate={false} />
          </div>
        </>
      )}
    </div>
  );
}

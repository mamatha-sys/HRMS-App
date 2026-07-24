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
import ApprovalsWidget from '../components/ApprovalsWidget.jsx';

const BANNERS = {
  super_admin: 'Full, unrestricted access — every widget below, organization-wide, no scope restriction.',
  manager: 'Team/organization view — bank and identity fields are masked on records that are not your own, per Manage Roles.',
  employee: 'You see only your own information — no organization-wide or team data on this screen.'
};

const DECIDER_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager'];

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [filters, setFilters] = useState({ department: '', branch: '', status: '' });

  const canManage = user?.role === 'super_admin' || user?.role === 'manager';
  const canDecide = DECIDER_ROLES.includes(user?.role);

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

  const vis = summary?.widgetVisibility || {};
  const show = (key) => vis[key] !== false;

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
              <option value="On Probation">On Probation</option>
              <option value="Exited">Exited</option>
            </select>
            <div className="spacer" />
            {canManage && <button className="primary" onClick={downloadCsv}>Export</button>}
          </div>

          {show('kpis') && (
            <div className="kpi-row">
              {summary.kpis.map((k) => (
                <div key={k.label} className={'kpi-card ' + k.color}>
                  <div className="kpi-label">{k.label}</div>
                  <div className={'kpi-value' + (typeof k.value === 'string' ? ' text' : '')}>{k.value}</div>
                </div>
              ))}
            </div>
          )}

          <div className="dashboard-grid">
            <div>
              {show('growth_chart') && <LineChart title="Employee / Organization Growth" data={summary.growthTrend} exportFilename="growth.csv" />}
              {show('hiring_chart') && <BarChart title="New Hires by Year" data={summary.hiringTrend} exportFilename="hiring.csv" />}
              {show('department_chart') && <BarChart title="Department Strength & Distribution" data={summary.departmentBreakdown.map((d) => ({ label: d.department, value: d.count }))} exportFilename="departments.csv" />}
            </div>
            <div>
              {show('approvals') && <ApprovalsWidget badge={1} canDecide={canDecide} />}
              {show('tasks') && <TasksWidget badge={2} canAssignOthers={canManage} />}
            </div>
            <div>
              {show('notifications') && <NotificationsWidget badge={3} canCreate={canManage} />}
              {show('calendar') && <EventsWidget badge={4} canCreate={canManage} />}
            </div>
          </div>

          <div className="dashboard-grid">
            {show('quick_actions') && <QuickActionsWidget badge={5} role={user?.role} />}
            {show('vacancies') && <VacanciesWidget badge={6} />}
            {show('role_user') && user?.role === 'super_admin' && <RoleUserSummaryWidget badge={7} usersCount={summary.usersCount} />}
          </div>
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

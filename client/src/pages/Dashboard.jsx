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
import MyAttendanceLeaveWidget from '../components/MyAttendanceLeaveWidget.jsx';
import AnnouncementsWidget from '../components/AnnouncementsWidget.jsx';
import IdeaLeaderboardWidget from '../components/IdeaLeaderboardWidget.jsx';
import CelebrationsWidget from '../components/CelebrationsWidget.jsx';
import { SCOPED_ROLES } from '../roles.js';

const BANNERS = {
  super_admin: 'Full, unrestricted access — every widget below, organization-wide, no scope restriction.',
  manager: 'Team/organization view — bank and identity fields are masked on records that are not your own, per Manage Roles.',
  employee: 'You see only your own information — no organization-wide or team data on this screen.'
};

const DECIDER_ROLES = ['super_admin', 'manager', 'hr_admin', 'assistant_manager', 'stl', 'tl'];

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [branches, setBranches] = useState([]);
  const [filters, setFilters] = useState({ department: '', branch: '', status: '' });

  const canManage = user?.role === 'super_admin' || user?.role === 'manager';
  const canDecide = DECIDER_ROLES.includes(user?.role);
  const isScoped = SCOPED_ROLES.includes(user?.role);

  function load(f) {
    const params = {};
    if (f.department) params.department = f.department;
    if (f.branch) params.branch = f.branch;
    if (f.status) params.status = f.status;
    api.get('/dashboard/summary', { params }).then((res) => setSummary(res.data)).catch(() => setError('Could not load dashboard data.'));
  }

  useEffect(() => { load(filters); }, [filters]);
  // A scoped role (STL/TL/Assistant Manager) only ever sees their own assigned
  // department(s)/team(s) here, so the Department/Branch/Status filter bar has nothing else for
  // them to filter into — it's just noise, and picking a department outside their scope would
  // silently return nothing. Don't render it, and don't fetch its options either.
  useEffect(() => {
    if (user?.role === 'employee' || isScoped) return;
    api.get('/org/departments').then((res) => setDepartments(res.data.departments)).catch(() => {});
    api.get('/org/branches').then((res) => setBranches(res.data.branches)).catch(() => {});
  }, [user]);

  // Changes made elsewhere (check in/out, approvals, a new ticket, etc.) only reach this page's
  // own state on mount — if the Dashboard tab is left open and you make a change on another tab
  // or come back to it later, it stays stale until you navigate away and back. Refetch the
  // summary and force every widget below to remount (they each manage their own data) whenever
  // this tab regains focus or becomes visible again, so it self-updates instead.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    function refresh() {
      load(filters);
      setRefreshKey((k) => k + 1);
    }
    function onVisibility() { if (document.visibilityState === 'visible') refresh(); }
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [filters]);

  // One export for the whole page, not per chart: sends the same filters the screen is showing so
  // the workbook matches what you are looking at (Overview + Employees + breakdowns + trends +
  // attendance + approvals + positions + celebrations, one sheet each).
  const [exporting, setExporting] = useState(false);
  async function exportDashboard() {
    setError('');
    setExporting(true);
    try {
      const params = {};
      if (filters.department) params.department = filters.department;
      if (filters.branch) params.branch = filters.branch;
      if (filters.status) params.status = filters.status;
      const res = await api.get('/dashboard/export.xlsx', { params, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hrms-dashboard-${filters.department ? filters.department.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() : 'all-departments'}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not export the dashboard.');
    } finally {
      setExporting(false);
    }
  }

  // The department selection drives every widget below too, not just the KPI strip — each widget
  // fetches its own data, so the choice has to be handed down rather than applied centrally.
  const dept = filters.department;
  const activeFilters = [
    filters.department && `Department: ${filters.department}`,
    filters.branch && `Branch: ${filters.branch}`,
    filters.status && `Status: ${filters.status}`
  ].filter(Boolean);

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
          {/* The bar renders even for a scoped role, which has no selects to show but still gets
              the export button — their workbook is simply pre-narrowed to their assigned scope. */}
          <div className="filter-bar">
            {!isScoped && (
              <>
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
                {activeFilters.length > 0 && (
                  <button onClick={() => setFilters({ department: '', branch: '', status: '' })}>Clear</button>
                )}
              </>
            )}
            <span className="spacer" />
            <button className="primary" onClick={exportDashboard} disabled={exporting}>
              {exporting ? 'Preparing…' : 'Export Dashboard (Excel)'}
            </button>
          </div>

          {activeFilters.length > 0 && (
            <div className="banner info">
              Showing <strong>{activeFilters.join(' · ')}</strong> — every KPI, chart and widget on this page is narrowed to this selection, and so is the export.
            </div>
          )}

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
              {summary.teamBreakdown && summary.teamBreakdown.length > 0 && (
                <BarChart title={dept ? `Team-wise Distribution — ${dept}` : 'Team-wise Distribution'} data={summary.teamBreakdown.map((t) => ({ label: t.team, value: t.count }))} exportFilename="teams.csv" />
              )}
            </div>
            <div>
              {show('approvals') && <ApprovalsWidget key={'approvals' + refreshKey} badge={1} canDecide={canDecide} department={dept} />}
              {show('tasks') && <TasksWidget key={'tasks' + refreshKey} badge={2} canAssignOthers={canManage} department={dept} />}
            </div>
            <div>
              {/* Notifications and Calendar are deliberately NOT department-filtered: the first is
                  your own personal inbox and the second is the shared company calendar — neither
                  is a per-department dataset, so narrowing them would just hide your own items. */}
              {show('notifications') && <NotificationsWidget key={'notifications' + refreshKey} badge={3} canCreate={canManage} />}
              {show('calendar') && <EventsWidget key={'calendar' + refreshKey} badge={4} canCreate={canManage} />}
              {show('announcements') && <AnnouncementsWidget key={'announcements' + refreshKey} badge={5} department={dept} />}
              {show('celebrations') && <CelebrationsWidget key={'celebrations' + refreshKey} badge={10} department={dept} />}
            </div>
          </div>

          <div className="dashboard-grid">
            {show('quick_actions') && <QuickActionsWidget badge={6} role={user?.role} />}
            {show('vacancies') && <VacanciesWidget key={'vacancies' + refreshKey} badge={7} department={dept} />}
            {show('idea_leaderboard') && <IdeaLeaderboardWidget key={'idea_leaderboard' + refreshKey} badge={8} department={dept} />}
            {show('role_user') && user?.role === 'super_admin' && <RoleUserSummaryWidget badge={9} usersCount={summary.usersCount} />}
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

          {summary.me && <MyAttendanceLeaveWidget key={'attendance' + refreshKey} />}

          <div className="dashboard-grid">
            <TasksWidget key={'tasks' + refreshKey} badge={1} canAssignOthers={false} />
            <NotificationsWidget key={'notifications' + refreshKey} badge={2} canCreate={false} />
            <EventsWidget key={'calendar' + refreshKey} badge={3} canCreate={false} />
            <AnnouncementsWidget key={'announcements' + refreshKey} badge={4} />
            <IdeaLeaderboardWidget key={'idea_leaderboard' + refreshKey} badge={5} />
            <CelebrationsWidget key={'celebrations' + refreshKey} badge={6} />
          </div>
        </>
      )}
    </div>
  );
}

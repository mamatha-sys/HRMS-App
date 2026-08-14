import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import CandidateInterview from './pages/CandidateInterview.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Employees from './pages/Employees.jsx';
import Recruitment from './pages/Recruitment.jsx';
import Reports from './pages/Reports.jsx';
import ManageModules from './pages/ManageModules.jsx';
import CustomFeature from './pages/CustomFeature.jsx';
import Organization from './pages/Organization.jsx';
import Permissions from './pages/Permissions.jsx';
import UserManagement from './pages/UserManagement.jsx';
import ManageRoles from './pages/ManageRoles.jsx';
import Configurations from './pages/Configurations.jsx';
import ConfigurationPolicies from './pages/ConfigurationPolicies.jsx';
import OrgStructure from './pages/OrgStructure.jsx';
import BulkImport from './pages/BulkImport.jsx';
import Attendance from './pages/Attendance.jsx';
import Leave from './pages/Leave.jsx';
import Payroll from './pages/Payroll.jsx';
import Performance from './pages/Performance.jsx';
import Learning from './pages/Learning.jsx';
import Assets from './pages/Assets.jsx';
import Helpdesk from './pages/Helpdesk.jsx';
import Announcements from './pages/Announcements.jsx';
import Expenses from './pages/Expenses.jsx';
import Surveys from './pages/Surveys.jsx';
import Documents from './pages/Documents.jsx';
import Integrations from './pages/Integrations.jsx';
import ShiftRoster from './pages/ShiftRoster.jsx';
import Recognition from './pages/Recognition.jsx';
import Projects from './pages/Projects.jsx';
import Timesheet from './pages/Timesheet.jsx';
import Disciplinary from './pages/Disciplinary.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequireSuperAdmin from './components/RequireSuperAdmin.jsx';
import AppLayout from './components/AppLayout.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/interview/:token" element={<CandidateInterview />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/payroll" element={<Payroll />} />
        <Route path="/recruitment" element={<Recruitment />} />
        <Route path="/performance" element={<Performance />} />
        <Route path="/learning" element={<Learning />} />
        <Route path="/assets" element={<Assets />} />
        <Route path="/helpdesk" element={<Helpdesk />} />
        <Route path="/announcements" element={<Announcements />} />
        <Route path="/expenses" element={<Expenses />} />
        <Route path="/surveys" element={<Surveys />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/shift-roster" element={<ShiftRoster />} />
        <Route path="/recognition" element={<Recognition />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/timesheet" element={<Timesheet />} />
        <Route path="/disciplinary" element={<Disciplinary />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/custom/:moduleId/:featureId" element={<CustomFeature />} />
        <Route path="/configurations" element={<RequireSuperAdmin><Configurations /></RequireSuperAdmin>} />
        <Route path="/policies" element={<RequireSuperAdmin><ConfigurationPolicies /></RequireSuperAdmin>} />
        <Route path="/org-structure" element={<RequireSuperAdmin><OrgStructure /></RequireSuperAdmin>} />
        <Route path="/bulk-import" element={<BulkImport />} />
        <Route path="/roles" element={<RequireSuperAdmin><ManageRoles /></RequireSuperAdmin>} />
        <Route path="/organization" element={<RequireSuperAdmin><Organization /></RequireSuperAdmin>} />
        <Route path="/permissions" element={<RequireSuperAdmin><Permissions /></RequireSuperAdmin>} />
        <Route path="/users" element={<RequireSuperAdmin><UserManagement /></RequireSuperAdmin>} />
        <Route path="/manage-modules" element={<RequireSuperAdmin><ManageModules /></RequireSuperAdmin>} />
        <Route path="/integrations" element={<RequireSuperAdmin><Integrations /></RequireSuperAdmin>} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

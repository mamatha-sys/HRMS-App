import { Navigate, Route, Routes } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Employees from './pages/Employees.jsx';
import Recruitment from './pages/Recruitment.jsx';
import Reports from './pages/Reports.jsx';
import ManageModules from './pages/ManageModules.jsx';
import CustomFeature from './pages/CustomFeature.jsx';
import Organization from './pages/Organization.jsx';
import Permissions from './pages/Permissions.jsx';
import UserManagement from './pages/UserManagement.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequireSuperAdmin from './components/RequireSuperAdmin.jsx';
import AppLayout from './components/AppLayout.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/recruitment" element={<Recruitment />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/custom/:moduleId/:featureId" element={<CustomFeature />} />
        <Route path="/organization" element={<RequireSuperAdmin><Organization /></RequireSuperAdmin>} />
        <Route path="/permissions" element={<RequireSuperAdmin><Permissions /></RequireSuperAdmin>} />
        <Route path="/users" element={<RequireSuperAdmin><UserManagement /></RequireSuperAdmin>} />
        <Route path="/manage-modules" element={<RequireSuperAdmin><ManageModules /></RequireSuperAdmin>} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

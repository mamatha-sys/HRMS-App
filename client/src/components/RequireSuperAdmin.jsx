import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function RequireSuperAdmin({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'super_admin') return <Navigate to="/dashboard" replace />;
  return children;
}

import { Outlet } from 'react-router-dom';
import Topbar from './Topbar.jsx';
import Sidebar from './Sidebar.jsx';

export default function AppLayout() {
  return (
    <>
      <Topbar />
      <div className="layout">
        <Sidebar />
        <div className="main">
          <Outlet />
        </div>
      </div>
    </>
  );
}

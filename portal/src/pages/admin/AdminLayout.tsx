import { Outlet } from 'react-router';
import { KBHealthBadge } from '../../components/kb/KBHealthBadge.js';

// No rail of its own. The global shell's "Operate" group already lists every
// admin destination, so a second identical rail here only pushed the page
// content into a third column and made the app read as nested dashboards.
// What survives is the KB health badge — a live signal, not navigation.
function AdminLayout() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex justify-end px-6 pt-4">
        <KBHealthBadge />
      </div>
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}

export default AdminLayout;

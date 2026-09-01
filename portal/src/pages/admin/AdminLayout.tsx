import { Outlet, useLocation } from 'react-router';
import { KBHealthBadge } from '../../components/kb/KBHealthBadge.js';

// No rail of its own. The global shell's "Operate" group already lists every
// admin destination, so a second identical rail here only pushed the page
// content into a third column and made the app read as nested dashboards.
//
// The KB health badge survives, but only over the knowledge pages. Mounted
// layout-wide it floated a "1 KB broken" alarm over Computers, Codebases and
// Changes — surfaces that have nothing to do with the KB registry — and for
// an SME (who cannot even open /admin/knowledge) it was a dead-end alarm:
// a warning about a thing you can neither see nor fix. Signals live next to
// what they measure.
function AdminLayout() {
  const { pathname } = useLocation();
  const onKnowledge = pathname.startsWith('/admin/knowledge');
  return (
    <div className="flex flex-col h-full min-h-0">
      {onKnowledge && (
        <div className="flex justify-end px-6 pt-4">
          <KBHealthBadge />
        </div>
      )}
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}

export default AdminLayout;

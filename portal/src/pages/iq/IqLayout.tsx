import { Outlet, useLocation } from 'react-router';
import { SubNavLayout } from '../../components/shell/SubNavLayout';
import { useIqSubNav } from './iqSubNavCatalog';

// IqLayout is route-aware: it renders page-contextual SubNav items pulled
// from iqSubNavCatalog, instead of duplicating the global Layout sidebar.
// Routes with no contextual catalog render their content directly without
// the rail (rare — the catalog should cover every /iq/* page).

function IqLayout() {
  const { pathname } = useLocation();
  const spec = useIqSubNav(pathname);

  if (!spec) {
    return <Outlet />;
  }

  return (
    <SubNavLayout
      title={spec.title}
      items={spec.items}
      storageKey={spec.storageKey}
      secondaryTitle={spec.secondaryTitle}
      secondaryItems={spec.secondaryItems}
      secondaryStorageKey={spec.secondaryStorageKey}
    />
  );
}

export default IqLayout;

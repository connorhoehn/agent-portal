import { Link, Outlet, useLocation } from 'react-router';
import { SubNavLayout, activeNavItemStyle } from '@connorhoehnslalom/ui-components/shared';
import { useIqSubNav } from './iqSubNavCatalog';

function IqLayout() {
  const { pathname, search } = useLocation();
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
      renderNavItem={(item, children, baseStyle) => {
        const href = item.path.startsWith('/') ? item.path : `/iq/${item.path}`;
        const [linkPath, linkSearch] = href.split('?');
        const isActive = linkPath === pathname && (linkSearch ? search === `?${linkSearch}` : !search);
        return (
          <Link
            to={item.path}
            style={isActive ? { ...baseStyle, ...activeNavItemStyle } : baseStyle}
          >
            {children}
          </Link>
        );
      }}
    >
      <Outlet />
    </SubNavLayout>
  );
}

export default IqLayout;

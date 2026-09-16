import { Link, Outlet, useLocation } from 'react-router';
import { SubNavLayout, activeNavItemClassName, inactiveNavItemClassName } from '@connorhoehnslalom/ui-components/shared';
import { useIqSubNav } from './iqSubNavCatalog';

// Reproduces SubNavLayout's own default active/inactive nav-item look (see
// the library's `renderNavItem` doc comment, and its `activeNavItemStyle`
// export) as Tailwind classes instead of a computed `style` object.

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
      // The canary secondary rail was eating the library defaults (220 +
      // 200 = 420px on top of the 200px shell rail — 620px of chrome before
      // 1280px). Narrowing both here leaves more room for the live graph at
      // 1024–1279px.
      railWidth={200}
      secondaryRailWidth={160}
      contentAs="section"
      contentLabel={spec.title}
      renderNavItem={(item, children) => {
        const href = item.path.startsWith('/') ? item.path : `/iq/${item.path}`;
        const [linkPath, linkSearch] = href.split('?');
        // Match on the item's OWN param, not the whole query: Explore writes
        // `layout=` and `focus=` beside `entities=`, and its default view
        // carries no `entities` at all — exact-string equality lit nothing
        // on `/iq/explore` and nothing once a second param appeared.
        const current = new URLSearchParams(search);
        const wanted = new URLSearchParams(linkSearch ?? '');
        const isActive = linkPath === pathname && (
          wanted.size === 0
            ? true
            : [...wanted.entries()].every(([k, v]) => (current.get(k) ?? (k === 'entities' ? 'all' : null)) === v)
        );
        return (
          <Link
            to={item.path}
            className={isActive ? activeNavItemClassName : inactiveNavItemClassName}
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

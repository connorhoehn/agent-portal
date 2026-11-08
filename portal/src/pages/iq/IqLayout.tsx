import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { activeNavItemClassName, inactiveNavItemClassName } from '@connorhoehn/ui-components/shared';
import { useIqSubNav } from './iqSubNavCatalog';

// Reproduces SubNavLayout's own default active/inactive nav-item look (see
// the library's `renderNavItem` doc comment, and its `activeNavItemStyle`
// export) as Tailwind classes instead of a computed `style` object.

// See Layout.tsx for why these come from the library rather than local copies.

// The authenticated Layout owns calls across /iq, /admin and Settings.
function IqLayout() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const spec = useIqSubNav(pathname);

  if (!spec) {
    return <Outlet />;
  }

  if (pathname.startsWith('/iq/work') || pathname.startsWith('/iq/local-compute')) {
    // A run page docks its conversation composer across the whole content
    // column (docs/layout-cascade.md), so it owns its own gutter.
    const runPage = /^\/iq\/work\/(?!(?:queue|findings|changes)\/?$)[^/]+\/?$/.test(pathname);
    return <BuildSectionLayout title={spec.title} items={spec.items} storageKey={spec.storageKey}
      {...(runPage ? { contentPadding: 'none' as const } : {})}><Outlet /></BuildSectionLayout>;
  }

  if (pathname === '/iq/explore') {
    const entities = new URLSearchParams(search).get('entities') ?? 'all';
    const view = spec.items.find((item) => new URLSearchParams(item.path.split('?')[1]).get('entities') === entities);
    return <BuildSectionLayout title={spec.title} items={spec.items} storageKey={spec.storageKey} contentPadding="none"
      breadcrumbs={[
        { label: 'Engage' },
        { label: 'Explore', href: '/iq/explore', onClick: (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          navigate('/iq/explore');
        } },
        { label: view?.label ?? 'All' },
      ]}>
      <Outlet key={entities} />
    </BuildSectionLayout>;
  }

  // Flush workspaces (a version timeline, a diff, the canary graph) own their
  // toolbars and gutters; they sit straight under the trail.
  const flush = ['/iq/history', '/iq/diff', '/iq/canary'].some((p) => pathname.startsWith(p));
  return (
    <BuildSectionLayout
      contentPadding={flush ? 'none' : 'md'}
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
    </BuildSectionLayout>
  );
}

export default IqLayout;

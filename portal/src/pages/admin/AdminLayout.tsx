import { NavLink, Outlet, useLocation } from 'react-router';
import { Inline, Stack, SubNavLayout } from '@connorhoehnslalom/ui-components/shared';
import { KBHealthBadge } from '../../components/kb/KBHealthBadge.js';
import { useAutomateSpec } from '../work/automateNav';

// Reproduces SubNavLayout's own default active/inactive nav-item look (see
// the library's `renderNavItem` doc comment, and its `activeNavItemStyle`
// export) as Tailwind classes instead of a computed `style` object.
function navItemClassName(isActive: boolean): string {
  return isActive
    ? 'block px-[14px] py-2 border-l-[3px] border-l-primary bg-surface-hover text-text-primary no-underline cursor-pointer'
    : 'block px-[14px] py-2 border-l-[3px] border-transparent text-text-secondary no-underline cursor-pointer';
}

// Mostly no rail of its own — the global shell already lists the admin
// destinations. The exception is the Automate family: Bots and Changes are
// CHILDREN of Automate (they left the top-level rail when it existed), so
// these two paths render the same Automate sub-rail the /iq/work pages use.
// Without it, clicking Bots from the rail dropped you out of the hierarchy —
// exactly the breadcrumb break the old Workers item was removed for.
//
// The KB health badge survives, but only over the knowledge pages — mounted
// layout-wide it floated a "1 KB broken" alarm over surfaces that have
// nothing to do with the KB registry.
function AdminLayout() {
  const { pathname } = useLocation();
  const automate = useAutomateSpec();
  const onKnowledge = pathname.startsWith('/admin/knowledge');
  const inAutomate = pathname.startsWith('/admin/bots') || pathname.startsWith('/admin/changes');

  if (inAutomate) {
    return (
      <SubNavLayout
        title={automate.title}
        items={automate.items}
        storageKey={automate.storageKey}
        contentAs="section"
        contentLabel="Automate"
        renderNavItem={(item, children) => {
          // startsWith matching (unlike IqLayout's exact match) so
          // /admin/bots/:id and /admin/changes/:id keep their parent lit —
          // but '/iq/work' itself must stay exact or it would swallow
          // /iq/work/queue and /iq/work/findings.
          const isActive = item.path === '/iq/work'
            ? pathname === '/iq/work'
            : pathname.startsWith(item.path);
          return (
            <NavLink
              to={item.path}
              className={navItemClassName(isActive)}
            >
              {children}
            </NavLink>
          );
        }}
      >
        <Outlet />
      </SubNavLayout>
    );
  }

  return (
    <Stack gap="none" className="h-full min-h-0">
      {onKnowledge && (
        <Inline justify="end" className="px-6 pt-4">
          <KBHealthBadge />
        </Inline>
      )}
      <Stack gap="none" className="min-h-0 flex-1">
        <Outlet />
      </Stack>
    </Stack>
  );
}

export default AdminLayout;

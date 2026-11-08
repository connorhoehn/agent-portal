import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';
import { Outlet, useLocation } from 'react-router';
import { Stack } from '@connorhoehn/ui-components/shared';
import { useAutomateSpec } from '../work/automateNav';

// Reproduces SubNavLayout's own default active/inactive nav-item look (see
// the library's `renderNavItem` doc comment, and its `activeNavItemStyle`
// export) as Tailwind classes instead of a computed `style` object.

// Mostly no rail of its own — the global shell already lists the admin
// destinations. The exception is the Automate family: Bots and Changes are
// CHILDREN of Automate (they left the top-level rail when it existed), so
// these two paths render the same Automate sub-rail the /iq/work pages use.
// Without it, clicking Bots from the rail dropped you out of the hierarchy —
// exactly the breadcrumb break the old Workers item was removed for.
//
// The KB health badge lives in the knowledge pages' own headers (Knowledge,
// Registry). Mounted layout-wide it floated a "1 KB broken" alarm over
// surfaces that have nothing to do with the KB registry; mounted here as a row
// above the knowledge pages it pushed their titles 42px further under the
// trail than every other Org title.
function AdminLayout() {
  const { pathname } = useLocation();
  const automate = useAutomateSpec();
  const inAutomate = pathname.startsWith('/admin/bots') || pathname.startsWith('/admin/changes');

  if (inAutomate) {
    // The Bots and Changes lists are CollectionCommandPages: they own their
    // reading gutters and dock the command composer across the whole content
    // column (docs/layout-cascade.md), so they sit flush like IqLayout's run
    // page. A bot or change detail keeps the section's gutter.
    const collectionPage = /^\/admin\/(?:bots|changes)\/?$/.test(pathname);
    return <BuildSectionLayout title={automate.title} items={automate.items} storageKey={automate.storageKey}
      {...(collectionPage ? { contentPadding: 'none' as const } : {})}><Outlet /></BuildSectionLayout>;
  }

  return (
    <Stack gap="none" className="h-full min-h-0">
      <Stack gap="none" className="min-h-0 flex-1">
        <Outlet />
      </Stack>
    </Stack>
  );
}

export default AdminLayout;

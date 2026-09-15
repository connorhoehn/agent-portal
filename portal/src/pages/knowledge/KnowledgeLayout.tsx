// Rail for the Knowledge surface. The Knowledge home and registry had no
// sub-nav, so the pipeline stages (Sources, Runs, Storage, KB sync, Schedule)
// were only reachable by knowing they lived under /admin/ingest — you had to
// drill for them. This grouped rail surfaces the whole subject in one place:
// KNOWLEDGE (overview + registry) and the PIPELINE stages, so Sources is one
// click from the Knowledge home.

import { NavLink, Outlet } from 'react-router';
import { SubNavLayout } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { knowledgeItemsFor } from './knowledgeNav';

export default function KnowledgeLayout() {
  const { session } = useSession();
  // One spec with IngestLayout (knowledgeNav.ts), so the pipeline pages keep
  // this exact rail instead of swapping in a second one.
  const items = knowledgeItemsFor(session?.role);
  return (
    <SubNavLayout
      title="Knowledge"
      storageKey="knowledge"
      items={items}
      renderNavItem={(item, children) => (
        <NavLink
          to={item.path}
          // Overview must match exactly, or it stays active on /registry too.
          end={item.path === '/admin/knowledge'}
          className={({ isActive }) => navItemClassName(isActive)}
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

// Reproduces SubNavLayout's own default active/inactive nav-item look
// (see the library's `renderNavItem` doc comment) as Tailwind classes on
// NavLink's `className` prop instead of a computed `style` object — a real
// router integration still needs `renderNavItem`, but nothing here needs an
// inline style to get it.
function navItemClassName(isActive: boolean): string {
  return isActive
    ? 'block px-[14px] py-2 border-l-[3px] border-l-primary bg-surface-hover text-text-primary no-underline cursor-pointer'
    : 'block px-[14px] py-2 border-l-[3px] border-transparent text-text-secondary no-underline cursor-pointer';
}

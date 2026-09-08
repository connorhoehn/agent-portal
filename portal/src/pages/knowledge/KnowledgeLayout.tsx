// Rail for the Knowledge surface. The Knowledge home and registry had no
// sub-nav, so the pipeline stages (Sources, Runs, Storage, KB sync, Schedule)
// were only reachable by knowing they lived under /admin/ingest — you had to
// drill for them. This grouped rail surfaces the whole subject in one place:
// KNOWLEDGE (overview + registry) and the PIPELINE stages, so Sources is one
// click from the Knowledge home.

import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';

const KNOWLEDGE_ITEMS: SubNavItem[] = [
  { path: '/admin/knowledge',          label: 'Overview', hint: 'Health & recent activity', group: 'Knowledge' },
  { path: '/admin/knowledge/registry', label: 'Registry', hint: 'Knowledge bases',          group: 'Knowledge' },
];

// The ingest pipeline, in run order — same stages IngestLayout shows, hoisted
// here so they're discoverable from Knowledge. hr-admin only: /admin/ingest/*
// routes are hr-admin-gated, so showing these to an org-leader gave them five
// links that all silently bounced to /.
const PIPELINE_ITEMS: SubNavItem[] = [
  { path: '/admin/ingest/crawl',       label: 'Sources',  hint: 'What content is pulled in', group: 'Pipeline' },
  { path: '/admin/ingest/history',     label: 'Runs',     hint: 'What each pull did',        group: 'Pipeline' },
  { path: '/admin/ingest/storage',     label: 'Storage',  hint: 'Where documents land',      group: 'Pipeline' },
  { path: '/admin/ingest/sources',     label: 'KB sync',  hint: 'Storage → knowledge base',  group: 'Pipeline' },
  { path: '/admin/ingest/schedules',   label: 'Schedule', hint: 'How often it re-syncs',     group: 'Pipeline' },
];

export default function KnowledgeLayout() {
  const { session } = useSession();
  const canIngest = session?.role === 'hr-admin' || session?.role === 'admin';
  const items = canIngest ? [...KNOWLEDGE_ITEMS, ...PIPELINE_ITEMS] : KNOWLEDGE_ITEMS;
  return (
    <SubNavLayout
      title="Knowledge"
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

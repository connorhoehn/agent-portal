// Rail for the Knowledge surface. The Knowledge home and registry had no
// sub-nav, so the pipeline stages (Sources, Runs, Storage, KB sync, Schedule)
// were only reachable by knowing they lived under /admin/ingest — you had to
// drill for them. This grouped rail surfaces the whole subject in one place:
// KNOWLEDGE (overview + registry) and the PIPELINE stages, so Sources is one
// click from the Knowledge home.

import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';

const items: SubNavItem[] = [
  { path: '/admin/knowledge',          label: 'Overview', hint: 'Health & recent activity', group: 'Knowledge' },
  { path: '/admin/knowledge/registry', label: 'Registry', hint: 'Knowledge bases',          group: 'Knowledge' },
  // The ingest pipeline, in run order — same stages IngestLayout shows, hoisted
  // here so they're discoverable from Knowledge.
  { path: '/admin/ingest/crawl',       label: 'Sources',  hint: 'What content is pulled in', group: 'Pipeline' },
  { path: '/admin/ingest/history',     label: 'Runs',     hint: 'What each pull did',        group: 'Pipeline' },
  { path: '/admin/ingest/storage',     label: 'Storage',  hint: 'Where documents land',      group: 'Pipeline' },
  { path: '/admin/ingest/sources',     label: 'KB sync',  hint: 'Storage → knowledge base',  group: 'Pipeline' },
  { path: '/admin/ingest/schedules',   label: 'Schedule', hint: 'How often it re-syncs',     group: 'Pipeline' },
];

export default function KnowledgeLayout() {
  return (
    <SubNavLayout
      title="Knowledge"
      items={items}
      renderNavItem={(item, children, baseStyle) => (
        <NavLink
          to={item.path}
          // Overview must match exactly, or it stays active on /registry too.
          end={item.path === '/admin/knowledge'}
          style={({ isActive }) =>
            isActive
              ? { ...baseStyle, borderLeft: '3px solid var(--color-primary)', background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }
              : baseStyle
          }
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

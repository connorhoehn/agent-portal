import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlTarget } from '../../components/ingest/types';

function IngestLayout() {
  // Lightweight polling for nav badges. Same endpoints the sub-pages use,
  // so React Query / browser cache de-dupes — no extra network cost.
  const { data: targetsData } = useFetch<{ targets: CrawlTarget[] }>(
    '/api/ingest/crawl-targets',
    30_000,
  );
  const { data: crawlsData } = useFetch<{ crawls: CrawlSession[] }>(
    '/api/ingest/crawls',
    10_000,
  );

  const targetCount = targetsData?.targets.length;
  const crawlCount = crawlsData?.crawls.length;

  // Ordered as the pipeline runs, not alphabetically and not by how the pages
  // happened to be built: content is pulled from a source, the run is recorded,
  // the result lands in storage, storage is registered as a knowledge-base data
  // source, and a schedule keeps it current. The old first item was "Summary",
  // which put a dashboard at the head of a sequence of steps; the summary is
  // now the Knowledge home, linked back to from the top.
  const items: SubNavItem[] = [
    { path: '/admin/knowledge', label: '← Knowledge', hint: 'Overview & health' },
    { path: 'crawl',     label: '1 · Sources',      hint: 'What content is pulled in', count: targetCount },
    { path: 'history',   label: '2 · Runs',         hint: 'What each pull did',        count: crawlCount },
    { path: 'storage',   label: '3 · Storage',      hint: 'Where documents land' },
    { path: 'sources',   label: '4 · KB sync',      hint: 'Storage → knowledge base' },
    { path: 'schedules', label: '5 · Schedule',     hint: 'How often it re-syncs' },
  ];

  return (
    <SubNavLayout
      title="Knowledge pipeline"
      items={items}
      renderNavItem={(item, children, baseStyle) => (
        <NavLink
          to={item.path}
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

export default IngestLayout;

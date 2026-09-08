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
      renderNavItem={(item, children) => (
        <NavLink
          to={item.path}
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

export default IngestLayout;

import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import type { CrawlSession, CrawlTarget } from '../../components/ingest/types';
import { knowledgeItemsFor } from '../knowledge/knowledgeNav';

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
  const { session } = useSession();

  // The SAME rail the Knowledge home shows (knowledgeNav.ts) — Overview and
  // Registry stay in view, the pipeline stages keep the words the Knowledge
  // rail used for them, and the two live counts ride on their rows. A second
  // rail titled "Knowledge pipeline" with "1 · Sources" and a back-link used
  // to replace it the moment a pipeline page opened.
  const counts: Record<string, number | undefined> = {
    '/admin/ingest/crawl': targetCount,
    '/admin/ingest/history': crawlCount,
  };
  const items: SubNavItem[] = knowledgeItemsFor(session?.role).map((i) =>
    counts[i.path] !== undefined ? { ...i, count: counts[i.path] } : i,
  );

  return (
    <SubNavLayout
      title="Knowledge"
      storageKey="knowledge"
      items={items}
      contentAs="section"
      contentLabel="Ingest"
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

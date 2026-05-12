import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';
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

  const items: SubNavItem[] = [
    { path: 'summary',   label: 'Summary',       hint: 'KB & quick stats' },
    { path: 'crawl',     label: 'Crawl Targets', hint: 'Saved + live runs', count: targetCount },
    { path: 'history',   label: 'Run History',   hint: 'Past crawls',       count: crawlCount },
    { path: 'sources',   label: 'Data Sources',  hint: 'KB ingest jobs' },
    { path: 'storage',   label: 'Storage',       hint: 'S3 + KB chunks' },
    { path: 'schedules', label: 'Schedules',     hint: 'KB sync cron' },
  ];

  return <SubNavLayout title="Ingest" items={items} />;
}

export default IngestLayout;

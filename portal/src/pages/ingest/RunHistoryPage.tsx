import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, CollectionToolbar, PageSection, Stack } from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { crawlRunsAdapter, filterRuns } from './ingestCommands';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlStatus, CrawlTarget } from '../../components/ingest/types';
import { RunHistoryTable } from '../../components/ingest/RunHistoryTable';
import { RunDetailDrawer } from '../../components/ingest/RunDetailDrawer';
import { EmptyState } from '../../components/ingest/ui';
import { UnavailableNotice } from '../../components/UnavailableNotice';

function RunHistoryPage() {
  const navigate = useNavigate();
  // Same URL + interval as IngestLayout's nav-badge poll and
  // CrawlTargetsPage — `share: true` collapses the three into one request.
  const { data: targetsData } = useFetch<{ targets: CrawlTarget[] }>(
    '/api/ingest/crawl-targets',
    30_000,
    { share: true },
  );
  const {
    data: crawlsData, error: crawlsError, degraded: crawlsDegraded, refresh: refreshCrawls, isLoading: crawlsLoading,
  } = useFetch<{ crawls: CrawlSession[] }>(
    '/api/ingest/crawls',
    10_000,
    { share: true },
  );
  // A failed read is not an empty one. Without this the page answered "No
  // crawl runs yet" to a 500 from /api/ingest/crawls — the most confident
  // possible claim, made from no data at all.
  const crawlsFailure = crawlsError ?? crawlsDegraded;

  const targets = targetsData?.targets ?? [];
  const crawls = crawlsData?.crawls ?? [];

  const [runFilter, setRunFilter] = useState<'all' | CrawlStatus>('all');
  const [query, setQuery] = useState('');
  const [drawerCrawlId, setDrawerCrawlId] = useState<string | null>(null);
  const [drawerInitial, setDrawerInitial] = useState<CrawlSession | null>(null);

  const historyCrawls = useMemo(
    () => [...crawls].sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)),
    [crawls],
  );

  const targetsById = useMemo(() => new Map(targets.map(t => [t.id, t] as const)), [targets]);
  const shownCrawls = filterRuns(historyCrawls, targetsById, runFilter, query);
  const adapter = crawlRunsAdapter({
    setQuery, refresh: refreshCrawls, setStatus: setRunFilter, rows: () => shownCrawls, targetsById, openRun: openCrawl,
  });

  function openCrawl(id: string) {
    const initial = crawls.find(c => c.id === id) ?? null;
    setDrawerInitial(initial);
    setDrawerCrawlId(id);
  }

  return (
    <PageSection
      title="Crawl runs"
      description="What each crawl run actually did — pages fetched, documents produced, and where it stopped. Refreshes every 10s."
    >
      <Stack gap="md" className="min-w-0" data-collection-command-boundary="embedded">
        <CollectionToolbar label="Crawl run filters"
          search={{ value: query, onChange: setQuery, placeholder: 'Search crawl runs', 'aria-label': 'Search crawl runs' }}
          summary={crawlsData ? `${shownCrawls.length} of ${historyCrawls.length} runs` : undefined}
          onRefresh={refreshCrawls} refreshing={crawlsLoading} />
        <Card padding="md">
          {crawlsFailure && !crawlsData ? (
            <UnavailableNotice
              error={crawlsFailure}
              what="crawl runs"
              source="Run history is read from the ingest service"
              onRetry={refreshCrawls}
            />
          ) : historyCrawls.length === 0 ? (
            <EmptyState
              title="No crawl runs yet"
              body={targets.length > 0
                ? 'Crawl runs appear here once you start one — trigger it from the Sources page.'
                : 'Nothing is configured to pull content in yet — add a crawl target on the Sources page first.'}
              actionLabel="Open Sources"
              onAction={() => void navigate('/admin/ingest/crawl')}
            />
          ) : (
            <RunHistoryTable
              sessions={shownCrawls}
              targets={targets}
              filter={runFilter}
              onFilter={setRunFilter}
              onOpen={openCrawl}
              emptyMessage="No crawl run matches this search and status."
            />
          )}
        </Card>
        <CollectionCommandHost adapter={adapter} />
      </Stack>

      <RunDetailDrawer
        crawlId={drawerCrawlId}
        initialSession={drawerInitial}
        onClose={() => { setDrawerCrawlId(null); setDrawerInitial(null); }}
      />
    </PageSection>
  );
}

export default RunHistoryPage;

// /admin/ingest/history — what each crawl run did. A row opens the run as a
// page, `/admin/ingest/history/:crawlId` (`crawlRunHref`), the run list as the
// flush list rail beside it (docs/layout-cascade.md, "Records open as pages;
// selections stay put") — never a drawer.
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Card, CollectionToolbar, PageSection, Stack } from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { crawlRunHref, crawlRunsAdapter, filterRuns, runTitle } from './ingestCommands';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import type { CrawlSession, CrawlStatus, CrawlTarget } from '../../components/ingest/types';
import { RunHistoryTable } from '../../components/ingest/RunHistoryTable';
import { RunRecord } from '../../components/ingest/RunRecord';
import { EmptyState } from '../../components/ingest/ui';
import { UnavailableNotice } from '../../components/UnavailableNotice';

const STATUS_ORDER: CrawlStatus[] = ['running', 'failed', 'completed', 'cancelled'];
const STATUS_TITLE: Record<CrawlStatus, string> = { running: 'Running', failed: 'Failed', completed: 'Completed', cancelled: 'Cancelled' };

function RunHistoryPage() {
  const navigate = useNavigate();
  const { crawlId } = useParams<{ crawlId?: string }>();
  const openId = crawlId ?? null;
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

  const historyCrawls = useMemo(
    () => [...crawls].sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)),
    [crawls],
  );

  const targetsById = useMemo(() => new Map(targets.map(t => [t.id, t] as const)), [targets]);
  const shownCrawls = filterRuns(historyCrawls, targetsById, runFilter, query);
  const openCrawl = (id: string) => void navigate(crawlRunHref(id));
  const adapter = crawlRunsAdapter({
    setQuery, refresh: refreshCrawls, setStatus: setRunFilter, rows: () => shownCrawls, targetsById, openRun: openCrawl,
  });

  const openRun = openId ? crawls.find(c => c.id === openId) ?? null : null;
  const openTitle = openRun ? runTitle(openRun, targetsById) : null;
  useCrumbLabel(openId ?? undefined, openTitle);

  if (openId) {
    return (
      <CollectionRecordFrame
        title="Crawl runs"
        listTitle="Runs"
        listLabel="crawl runs"
        {...(crawlsData ? { count: shownCrawls.length } : {})}
        search={{ value: query, onChange: setQuery, placeholder: 'Find a crawl run' }}
        groups={STATUS_ORDER.map(st => ({ id: st, title: STATUS_TITLE[st], count: shownCrawls.filter(c => c.status === st).length }))}
        rows={shownCrawls.map(c => ({
          id: c.id, groupId: c.status, title: runTitle(c, targetsById),
          subline: `${relativeTime(c.startedAt)} · ${c.pages.length} / ${c.maxPages} pages`,
        }))}
        currentId={openId}
        onOpen={openCrawl}
        loading={crawlsLoading && !crawlsData}
        error={crawlsFailure && !crawlsData ? crawlsFailure : null}
        onRetry={refreshCrawls}
        footer={<CollectionCommandHost adapter={adapter} />}
        data-testid="ingest-run-explorer"
      >
        <RunRecord
          key={openId}
          crawlId={openId}
          title={openTitle}
          initialSession={openRun}
          onBack={() => void navigate('/admin/ingest/history')}
        />
      </CollectionRecordFrame>
    );
  }

  return (
    <PageSection
      title="Crawl runs"
      description="What each crawl run actually did — pages fetched, documents produced, and where it stopped. Refreshes every 10s."
    >
      <Stack gap="md" className="min-w-0">
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
    </PageSection>
  );
}

export default RunHistoryPage;

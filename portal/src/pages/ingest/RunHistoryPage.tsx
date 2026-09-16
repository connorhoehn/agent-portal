import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, PageSection } from '@connorhoehnslalom/ui-components/shared';
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
    data: crawlsData, error: crawlsError, degraded: crawlsDegraded, refresh: refreshCrawls,
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
  const [drawerCrawlId, setDrawerCrawlId] = useState<string | null>(null);
  const [drawerInitial, setDrawerInitial] = useState<CrawlSession | null>(null);

  const historyCrawls = useMemo(
    () => [...crawls].sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)),
    [crawls],
  );

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
            sessions={historyCrawls}
            targets={targets}
            filter={runFilter}
            onFilter={setRunFilter}
            onOpen={openCrawl}
          />
        )}
      </Card>

      <RunDetailDrawer
        crawlId={drawerCrawlId}
        initialSession={drawerInitial}
        onClose={() => { setDrawerCrawlId(null); setDrawerInitial(null); }}
      />
    </PageSection>
  );
}

export default RunHistoryPage;

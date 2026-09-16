import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlStatus, CrawlTarget } from '../../components/ingest/types';
import { RunHistoryTable } from '../../components/ingest/RunHistoryTable';
import { RunDetailDrawer } from '../../components/ingest/RunDetailDrawer';
import { EmptyState } from '../../components/ingest/ui';

function RunHistoryPage() {
  const navigate = useNavigate();
  // Same URL + interval as IngestLayout's nav-badge poll and
  // CrawlTargetsPage — `share: true` collapses the three into one request.
  const { data: targetsData } = useFetch<{ targets: CrawlTarget[] }>(
    '/api/ingest/crawl-targets',
    30_000,
    { share: true },
  );
  const { data: crawlsData } = useFetch<{ crawls: CrawlSession[] }>(
    '/api/ingest/crawls',
    10_000,
    { share: true },
  );

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
      title="Runs"
      description="What each pull actually did — pages fetched, documents produced, and where a run stopped. Refreshes every 10s."
    >
      <Card padding="md">
        {historyCrawls.length === 0 ? (
          <EmptyState
            title="No crawl runs yet"
            body={targets.length > 0
              ? 'Runs appear here after a crawl — trigger one from the Sources page.'
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

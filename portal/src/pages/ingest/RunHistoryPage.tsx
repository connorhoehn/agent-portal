import { useMemo, useState } from 'react';
import { Card, PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type { CrawlSession, CrawlStatus, CrawlTarget } from '../../components/ingest/types';
import { RunHistoryTable } from '../../components/ingest/RunHistoryTable';
import { RunDetailDrawer } from '../../components/ingest/RunDetailDrawer';
import { EmptyState } from '../../components/ingest/ui';

function RunHistoryPage() {
  const { data: targetsData } = useFetch<{ targets: CrawlTarget[] }>(
    '/api/ingest/crawl-targets',
    30_000,
  );
  const { data: crawlsData } = useFetch<{ crawls: CrawlSession[] }>(
    '/api/ingest/crawls',
    10_000,
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
    <PageSection title="Crawl Run History" description="10s refresh">
      <Card padding="md">
        {historyCrawls.length === 0 ? (
          <EmptyState title="No crawl runs yet" body="Trigger one from a target above." />
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

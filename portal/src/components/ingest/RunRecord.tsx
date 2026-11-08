// One crawl run, opened as a page (`/admin/ingest/history/:crawlId`) beside the
// run list rail (docs/layout-cascade.md, "Records open as pages; selections
// stay put"). A running crawl streams its pages in over SSE; a finished one is
// read once. A crawled page opens in place below the page table, its index in
// the query (`?page=<n>`), so the table never moves and nothing pops out.
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  Chip,
  DataTable,
  DetailHeader,
  DetailSection,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  Stack,
  StatStrip,
  T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { durationLabel } from '../../lib/relativeTime';
import { RecordNotFound, UnavailableNotice } from '../UnavailableNotice';
import {
  CRAWL_STATUS_TONE,
  PAGE_STATUS_TONE,
  durationOf,
  formatBytes,
  formatCost,
} from './types';
import type { CrawlPage, CrawlSession } from './types';
import { useCrawlStream } from './useCrawlStream';
import { PageDetail } from './PageDetail';

type PageRow = CrawlPage & { idx: number };

const PAGE_COLUMNS: DataTableColumn<PageRow>[] = [
  { key: 'idx', header: '#', width: '3rem', numeric: true, render: (p) => p.idx + 1 },
  {
    key: 'title', header: 'Page',
    render: (p) => <T as="span" size="sm" title={p.url} className="block max-w-[28rem] truncate">{p.title || p.url}</T>,
  },
  { key: 'status', header: 'Status', width: '112px', render: (p) => <Chip tone={PAGE_STATUS_TONE[p.status]} size="xs">{p.status}</Chip> },
  { key: 'depth', header: 'Depth', numeric: true, render: (p) => p.depth },
  { key: 'contentLength', header: 'Content', numeric: true, render: (p) => formatBytes(p.contentLength) },
];

export function RunRecord({
  crawlId,
  title,
  initialSession,
  onBack,
}: {
  crawlId: string;
  /** The run's name as the list shows it (its target's label, or its start URL). */
  title: string | null;
  initialSession?: CrawlSession | null;
  onBack: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // The stream replays the final snapshot and closes for a finished run, so it
  // is safe to attach for every run; the cold read covers the gap before it.
  const { session: streamed } = useCrawlStream(crawlId);
  const { data, failure, error, refresh } = useFetch<{ session: CrawlSession }>(
    `/api/ingest/crawl/${encodeURIComponent(crawlId)}`,
  );
  const session = streamed ?? data?.session ?? initialSession ?? null;

  const pageParam = params.get('page');
  const pageIdx = pageParam !== null && /^\d+$/.test(pageParam) ? Number(pageParam) : null;
  const openPage = (idx: number | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (idx === null) next.delete('page'); else next.set('page', String(idx));
    return next;
  });

  async function triggerKbSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch(`/api/ingest/crawl/${encodeURIComponent(crawlId)}/sync`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await r.json() as { ok?: boolean; error?: string; jobId?: string };
      if (!r.ok || !body.ok) {
        setSyncMsg({ tone: 'err', text: body.error ?? 'KB sync failed' });
      } else {
        setSyncMsg({ tone: 'ok', text: `KB sync started${body.jobId ? ` (${body.jobId.slice(0, 12)}…)` : ''}` });
      }
    } catch (e) {
      setSyncMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  }

  if (!session) {
    if (failure?.status === 404) {
      return (
        <RecordNotFound heading="Crawl run" title="Crawl run not found"
          body={`No crawl run has the id "${crawlId}" — the ingest service keeps only recent runs.`}
          backLabel="Crawl runs" onBack={onBack} />
      );
    }
    if (error) {
      return <UnavailableNotice error={error} what="this crawl run" source="Run history is read from the ingest service" onRetry={refresh} />;
    }
    return <LoadingState label="Loading crawl run…" />;
  }

  const rows: PageRow[] = session.pages.map((p, idx) => ({ ...p, idx }));
  const selected = pageIdx !== null ? session.pages[pageIdx] ?? null : null;
  const completed = session.status === 'completed';

  return (
    <Stack gap="md" data-testid="ingest-run-record">
      <DetailHeader
        title={title ?? session.startUrl}
        badge={<Chip tone={CRAWL_STATUS_TONE[session.status]} size="xs">{session.status}</Chip>}
        description={`${session.mode} · ${session.startUrl}`}
        aside={(
          <Inline gap="sm" align="center" justify="end">
            <Button
              variant="primary" size="sm"
              onClick={() => void triggerKbSync()}
              disabled={syncing || !completed}
              title={completed ? undefined : 'Available after the crawl completes'}
            >
              {syncing ? 'Syncing…' : 'Trigger KB sync'}
            </Button>
          </Inline>
        )}
        asideWidth={180}
      />

      <StatStrip
        variant="line"
        items={[
          { label: 'pages', value: `${session.pages.length} / ${session.maxPages}` },
          { label: 'duration', value: durationLabel(durationOf(session)) },
          { label: 'cost', value: formatCost(session.estimatedCostUsd) },
          { label: 'stored', value: formatBytes(session.totalScreenshotBytes + session.totalMarkdownBytes) },
        ]}
      />

      {session.error && <InlineAlert tone="error">{session.error}</InlineAlert>}
      {syncMsg && <InlineAlert tone={syncMsg.tone === 'ok' ? 'success' : 'error'}>{syncMsg.text}</InlineAlert>}

      <DetailSection first title="Pages" hint={`${session.pages.length}`}>
        <DataTable
          frameless
          data={rows}
          columns={PAGE_COLUMNS}
          keyField={(p) => `${p.idx}`}
          onRowClick={(p) => openPage(p.idx)}
          emptyMessage={session.status === 'running' ? 'No pages yet — they appear as the crawler reaches them.' : 'This run fetched no pages.'}
          data-testid="ingest-run-pages"
        />
      </DetailSection>

      {pageIdx !== null && (
        <DetailSection title={`Page ${pageIdx + 1}`}>
          {selected ? (
            <PageDetail
              key={pageIdx}
              crawlId={session.id}
              pageIdx={pageIdx}
              fallback={selected}
              onClose={() => openPage(null)}
            />
          ) : (
            <MetaLine size="sm" tone="secondary" items={[`This run has no page ${pageIdx + 1}.`]} />
          )}
        </DetailSection>
      )}
    </Stack>
  );
}

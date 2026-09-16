import { useEffect, useState } from 'react';
import {
  Chip,
  Drawer,
  EmptyState,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  SectionLabel,
  Stack,
  StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { durationLabel } from '../../lib/relativeTime';
import {
  CRAWL_STATUS_TONE,
  PAGE_STATUS_TONE,
  durationOf,
  formatBytes,
  formatCost,
} from './types';
import type { CrawlPage, CrawlSession } from './types';
import { useCrawlStream } from './useCrawlStream';
import { Thumbnail } from './Thumbnail';
import { PageDetailModal } from './PageDetailModal';
import { Button } from './ui';

/**
 * Right-side slide-in drawer showing a single CrawlSession in detail.
 *
 * For running sessions we attach to the SSE stream so the timeline updates as
 * pages stream in. For completed sessions we fetch the snapshot once.
 */
export function RunDetailDrawer({
  crawlId,
  initialSession,
  onClose,
}: {
  crawlId: string | null;
  initialSession?: CrawlSession | null;
  onClose: () => void;
}) {
  const open = !!crawlId;
  const [snapshot, setSnapshot] = useState<CrawlSession | null>(initialSession ?? null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [activePageIdx, setActivePageIdx] = useState<number | null>(null);

  // Decide whether to subscribe to the SSE stream. We always attach when the
  // drawer is open; if the session is already terminal the stream will close
  // almost immediately after replaying the final snapshot.
  const { session: streamed } = useCrawlStream(open ? crawlId : null);

  // Cold fetch on open (covers the case where there's no initialSession passed
  // in and the stream hasn't pushed yet).
  useEffect(() => {
    if (!open || !crawlId) {
      setSnapshot(initialSession ?? null);
      setSyncMsg(null);
      setActivePageIdx(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/ingest/crawl/${encodeURIComponent(crawlId)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ session: CrawlSession }> : Promise.reject(r.statusText))
      .then(body => { if (!cancelled) setSnapshot(body.session); })
      .catch(() => { /* drawer can render from stream once it arrives */ });
    return () => { cancelled = true; };
  }, [open, crawlId, initialSession]);

  const session = streamed ?? snapshot ?? initialSession ?? null;

  async function triggerKbSync() {
    if (!crawlId) return;
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

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Crawl run"
        subtitle={session?.startUrl}
        width={720}
      >
        {!session ? (
          <LoadingState label="Loading…" />
        ) : (
          <Stack gap="none" className="h-full">
            {/* Header */}
            <Stack gap="sm" className="p-4 border-b border-border">
              <Inline gap="sm" align="center">
                <Chip tone={CRAWL_STATUS_TONE[session.status]} size="xs">{session.status}</Chip>
                <Chip tone="neutral" size="xs">{session.mode}</Chip>
              </Inline>

              <StatStrip
                frameless
                items={[
                  { label: 'Pages', value: `${session.pages.length} / ${session.maxPages}` },
                  { label: 'Duration', value: durationLabel(durationOf(session)) },
                  { label: 'Cost', value: formatCost(session.estimatedCostUsd) },
                  { label: 'Stored', value: formatBytes(session.totalScreenshotBytes + session.totalMarkdownBytes) },
                ]}
              />

              {session.error && (
                <InlineAlert tone="error">{session.error}</InlineAlert>
              )}

              <Inline gap="sm" align="center">
                <Button
                  variant="primary"
                  onClick={triggerKbSync}
                  disabled={syncing || session.status !== 'completed'}
                  title={session.status !== 'completed' ? 'Available after the crawl completes' : ''}
                >
                  {syncing ? 'Syncing…' : 'Trigger KB Sync'}
                </Button>
                {syncMsg && (
                  <MetaLine
                    size="xs"
                    className={syncMsg.tone === 'ok' ? 'text-success' : 'text-danger'}
                    items={[syncMsg.text]}
                  />
                )}
              </Inline>
            </Stack>

            {/* Timeline */}
            <Stack gap="sm" className="flex-1 overflow-auto p-4">
              <SectionLabel as="div">Pages ({session.pages.length})</SectionLabel>
              {session.pages.length === 0 ? (
                <EmptyState title="No pages yet." />
              ) : (
                <Stack gap="md">
                  {session.pages.map((p, idx) => (
                    <TimelineRow
                      key={`${p.url}-${idx}`}
                      page={p}
                      idx={idx}
                      crawlId={session.id}
                      onOpen={() => setActivePageIdx(idx)}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          </Stack>
        )}
      </Drawer>

      {/* Page detail modal nested above the drawer */}
      {open && session && activePageIdx != null && session.pages[activePageIdx] && (
        <PageDetailModal
          crawlId={session.id}
          pageIdx={activePageIdx}
          fallback={session.pages[activePageIdx]!}
          onClose={() => setActivePageIdx(null)}
        />
      )}
    </>
  );
}

function TimelineRow({
  page,
  idx,
  crawlId,
  onOpen,
}: {
  page: CrawlPage;
  idx: number;
  crawlId: string;
  onOpen: () => void;
}) {
  return (
    <Inline gap="none"
      className="flex gap-3 p-2 rounded-md border border-border bg-surface items-start"
    >
      <Thumbnail
        crawlId={crawlId}
        pageIdx={idx}
        hasScreenshot={!!page.s3ScreenshotKey}
        width={120}
        onClick={onOpen}
      />
      <Inline gap="none" className="flex-1 min-w-0">
        <Inline gap="none" className="flex items-center gap-2 mb-1">
          <Inline as="span" gap="none"
            className="text-[12px] font-semibold truncate cursor-pointer"
            onClick={onOpen}
            title={page.title || page.url}
          >
            {page.title || page.url}
          </Inline>
          <Chip tone={PAGE_STATUS_TONE[page.status]} size="xs">{page.status}</Chip>
          {page.depth > 0 && (
            <Inline as="span" gap="none" className="text-[10px] text-text-tertiary">depth {page.depth}</Inline>
          )}
        </Inline>
        <Inline gap="none"
          className="text-[11px] font-mono text-text-tertiary overflow-hidden truncate whitespace-nowrap mb-1"
          title={page.url}
        >
          {page.url}
        </Inline>
        {page.summary && (
          <Inline gap="none"
            className="text-[12px] text-text-secondary overflow-hidden [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]"
          >
            {page.summary}
          </Inline>
        )}
        {page.error && (
          <Inline gap="none" className="text-[11px] text-danger mt-1">
            {page.error}
          </Inline>
        )}
        <Inline gap="none" className="flex gap-2.5 mt-1.5">
          <Button variant="secondary" size="sm" onClick={onOpen}>Details</Button>
        </Inline>
      </Inline>
    </Inline>
  );
}

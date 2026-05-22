import { useEffect, useState } from 'react';
import { Chip, Drawer } from '@connorhoehnslalom/ui-components/shared';
import {
  CRAWL_STATUS_TONE,
  PAGE_STATUS_TONE,
  durationOf,
  formatBytes,
  formatCost,
  formatDuration,
} from './types';
import type { CrawlPage, CrawlSession } from './types';
import { useCrawlStream } from './useCrawlStream';
import { Thumbnail } from './Thumbnail';
import { PageDetailModal } from './PageDetailModal';
import { primaryBtnStyle, smallBtnStyle } from './ui';

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
    fetch(`/api/ingest/crawl/${encodeURIComponent(crawlId)}`)
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
          <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            Loading…
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <div style={{ padding: 16, borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Chip tone={CRAWL_STATUS_TONE[session.status]} size="xs">{session.status}</Chip>
                <Chip tone="neutral" size="xs">{session.mode}</Chip>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 10,
                  marginTop: 10,
                }}
              >
                <Metric label="Pages" value={`${session.pages.length} / ${session.maxPages}`} />
                <Metric label="Duration" value={formatDuration(durationOf(session))} />
                <Metric label="Cost" value={formatCost(session.estimatedCostUsd)} mono />
                <Metric label="Stored" value={formatBytes(session.totalScreenshotBytes + session.totalMarkdownBytes)} />
              </div>

              {session.error && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 8,
                    borderRadius: 4,
                    background: '#fef2f2',
                    color: '#991b1b',
                    fontSize: 11,
                  }}
                >
                  {session.error}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                <button
                  onClick={triggerKbSync}
                  disabled={syncing || session.status !== 'completed'}
                  style={primaryBtnStyle(syncing || session.status !== 'completed')}
                  title={session.status !== 'completed' ? 'Available after the crawl completes' : ''}
                >
                  {syncing ? 'Syncing…' : 'Trigger KB Sync'}
                </button>
                {syncMsg && (
                  <span
                    style={{
                      fontSize: 11,
                      color: syncMsg.tone === 'ok' ? 'var(--color-success)' : 'var(--color-danger)',
                    }}
                  >
                    {syncMsg.text}
                  </span>
                )}
              </div>
            </div>

            {/* Timeline */}
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 600,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: 10,
                }}
              >
                Pages ({session.pages.length})
              </div>
              {session.pages.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  No pages yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {session.pages.map((p, idx) => (
                    <TimelineRow
                      key={`${p.url}-${idx}`}
                      page={p}
                      idx={idx}
                      crawlId={session.id}
                      onOpen={() => setActivePageIdx(idx)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
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
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 8,
        borderRadius: 6,
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        alignItems: 'flex-start',
      }}
    >
      <Thumbnail
        crawlId={crawlId}
        pageIdx={idx}
        hasScreenshot={!!page.s3ScreenshotKey}
        width={120}
        onClick={onOpen}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
            onClick={onOpen}
            title={page.title || page.url}
          >
            {page.title || page.url}
          </span>
          <Chip tone={PAGE_STATUS_TONE[page.status]} size="xs">{page.status}</Chip>
          {page.depth > 0 && (
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>depth {page.depth}</span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: 'var(--color-text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: 4,
          }}
          title={page.url}
        >
          {page.url}
        </div>
        {page.summary && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--color-text-secondary)',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {page.summary}
          </div>
        )}
        {page.error && (
          <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>
            {page.error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button onClick={onOpen} style={smallBtnStyle(false)}>Details</button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          marginTop: 2,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

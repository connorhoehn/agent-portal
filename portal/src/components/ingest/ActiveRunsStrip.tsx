import {
  Card, Chip, EntityCell, Inline, MetaLine, ProgressBar, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { CRAWL_STATUS_TONE, durationOf, formatDuration } from './types';
import type { CrawlSession } from './types';
import { useCrawlStream } from './useCrawlStream';
import { Thumbnail } from './Thumbnail';
import { Button, StatusDot } from './ui';

export function ActiveRunsStrip({
  sessions,
  onCancel,
  onOpen,
}: {
  sessions: CrawlSession[];
  onCancel: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sessions.map(s => (
        <ActiveRunCard key={s.id} initial={s} onCancel={onCancel} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ActiveRunCard({
  initial,
  onCancel,
  onOpen,
}: {
  initial: CrawlSession;
  onCancel: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  // Live snapshot via SSE; fall back to the initial snapshot until first event.
  const { session: live } = useCrawlStream(initial.id);
  const session = live ?? initial;
  // Cancelling a crawl is a DELETE on /api/ingest (ManageIngest).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');

  const pagesDone = session.pages.length;
  const pct = session.maxPages > 0
    ? Math.min(100, Math.round((pagesDone / session.maxPages) * 100))
    : 0;
  const latestPage = session.pages[session.pages.length - 1] ?? null;
  const latestPageIdx = pagesDone - 1;

  const isRunning = session.status === 'running';
  const tone = CRAWL_STATUS_TONE[session.status];

  return (
    <Card padding="md" style={{ borderLeft: '3px solid var(--color-warning)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        {/* Thumbnail of latest page */}
        {latestPage ? (
          <Thumbnail
            crawlId={session.id}
            pageIdx={latestPageIdx}
            hasScreenshot={!!latestPage.s3ScreenshotKey}
            width={140}
            onClick={() => onOpen(session.id)}
          />
        ) : (
          <div
            style={{
              width: 140,
              height: 88,
              borderRadius: 4,
              border: '1px solid var(--color-border)',
              background: 'var(--color-surface-raised)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              color: 'var(--color-text-tertiary)',
            }}
          >
            warming up…
          </div>
        )}

        {/* Body */}
        <Stack gap="sm" className="flex-1 min-w-0">
          <Inline gap="md" align="center" className="min-w-0">
            <StatusDot pulse={isRunning} color="var(--color-warning)" />
            <EntityCell label={session.startUrl} className="min-w-0" />
            <Chip tone={tone} size="xs">{session.status}</Chip>
            <Chip tone="neutral" size="xs">{session.mode}</Chip>
          </Inline>

          <MetaLine
            size="xs"
            className="font-mono"
            items={[`${session.id.slice(0, 12)}… · started ${formatDuration(durationOf(session))} ago`]}
          />

          {/* The bar was two nested divs with a percentage width literal. */}
          <ProgressBar value={pct} max={100} size="sm" showRatio={false} aria-label="Crawl progress" />

          <MetaLine
            size="xs"
            tone="secondary"
            items={[
              `${pagesDone} / ${session.maxPages} pages`,
              session.queued > 0 ? `${session.queued} queued` : null,
              latestPage ? `current: ${latestPage.status}` : null,
            ]}
          />

          {latestPage?.summary && (
            <MetaLine
              size="sm"
              tone="secondary"
              className="italic line-clamp-2"
              items={[<span key="s" title={latestPage.summary}>{latestPage.summary}</span>]}
            />
          )}
        </Stack>

        {/* Actions */}
        <Stack gap="xs" align="end">
          <Button variant="secondary" size="sm" onClick={() => onOpen(session.id)}>Open</Button>
          {isRunning && canManage && (
            <Button variant="danger" onClick={() => onCancel(session.id)}>
              Cancel
            </Button>
          )}
        </Stack>
      </div>
    </Card>
  );
}

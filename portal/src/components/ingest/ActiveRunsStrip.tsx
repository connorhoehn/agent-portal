import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import { CRAWL_STATUS_TONE, durationOf, formatDuration } from './types';
import type { CrawlSession } from './types';
import { useCrawlStream } from './useCrawlStream';
import { Thumbnail } from './Thumbnail';
import { PulseDot, dangerBtnStyle } from './ui';

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <PulseDot active={isRunning} color="var(--color-warning)" />
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={session.startUrl}
            >
              {session.startUrl}
            </span>
            <Chip tone={tone} size="xs">{session.status}</Chip>
            <Chip tone="neutral" size="xs">{session.mode}</Chip>
          </div>

          <div
            style={{
              fontSize: 11,
              color: 'var(--color-text-tertiary)',
              marginBottom: 8,
              fontFamily: 'monospace',
            }}
          >
            {session.id.slice(0, 12)}… · started {formatDuration(durationOf(session))} ago
          </div>

          {/* Progress bar */}
          <div
            style={{
              height: 5,
              background: 'rgba(0,0,0,.08)',
              borderRadius: 3,
              overflow: 'hidden',
              marginBottom: 6,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${pct}%`,
                background: 'var(--color-warning)',
                transition: 'width 0.5s ease',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {pagesDone} / {session.maxPages} pages
            {session.queued > 0 && (
              <span style={{ color: 'var(--color-text-tertiary)' }}> · {session.queued} queued</span>
            )}
            {latestPage && (
              <span style={{ color: 'var(--color-text-tertiary)' }}>
                {' · current: '}<span style={{ fontFamily: 'monospace' }}>{latestPage.status}</span>
              </span>
            )}
          </div>

          {latestPage?.summary && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                fontStyle: 'italic',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
              title={latestPage.summary}
            >
              {latestPage.summary}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <button onClick={() => onOpen(session.id)} style={{
            fontSize: 11, padding: '4px 10px', background: 'var(--color-surface-raised)',
            color: 'var(--color-text-primary)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)', cursor: 'pointer',
          }}>
            Open
          </button>
          {isRunning && (
            <button onClick={() => onCancel(session.id)} style={dangerBtnStyle(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ActivityFeedPanel — displays live activity events from a gateway channel.
// Props: events (newest-first array from useActivity), isLoading.

import type { ActivityEvent } from '@connorhoehnslalom/realtime-modules/client';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// Derive a stable key from an ActivityEvent.  userId+eventType+timestamp is
// unique enough for list rendering; library doesn't carry eventId.
function eventKey(e: ActivityEvent, idx: number): string {
  return `${e.userId ?? 'anon'}-${e.eventType}-${e.timestamp}-${idx}`;
}

interface Props {
  events: ActivityEvent[];
  isLoading?: boolean;
  maxItems?: number;
}

export function ActivityFeedPanel({ events, isLoading = false, maxItems = 10 }: Props) {
  // Library accumulates oldest-first; reverse slice so newest shows at top.
  const visible = events.slice(-maxItems).reverse();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary, #9ca3af)',
        textTransform: 'uppercase', letterSpacing: '0.05em',
        padding: '8px 12px', borderBottom: '1px solid var(--color-border, #e5e7eb)',
      }}>
        Live Activity
      </div>
      {isLoading && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)' }}>
          Loading…
        </div>
      )}
      {!isLoading && visible.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-text-tertiary, #9ca3af)' }}>
          No recent activity
        </div>
      )}
      {visible.map((e, idx) => (
        <div key={eventKey(e, idx)} style={{
          display: 'flex', alignItems: 'baseline', gap: 6,
          padding: '5px 12px', borderBottom: '1px solid var(--color-border, #e5e7eb)',
          fontSize: 12,
        }}>
          <span style={{ color: 'var(--color-text-tertiary, #9ca3af)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {relativeTime(e.timestamp)}
          </span>
          <span style={{ fontWeight: 500, color: 'var(--color-text-secondary, #6b7280)', whiteSpace: 'nowrap' }}>
            {e.displayName}
          </span>
          <span style={{ color: 'var(--color-text, #111827)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.eventType}
          </span>
        </div>
      ))}
    </div>
  );
}

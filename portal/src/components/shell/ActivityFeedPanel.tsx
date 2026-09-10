// ActivityFeedPanel — displays live activity events from a gateway channel.
// Props: events (newest-first array from useActivity), isLoading.

import type { ActivityEvent } from '@connorhoehnslalom/realtime-modules/client';
import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

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
    <Stack gap="none" className="flex flex-col gap-0">
      <Inline gap="none" className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide px-3 py-2 border-b border-border">
        Live Activity
      </Inline>
      {isLoading && (
        <Inline gap="none" className="px-3 py-2 text-[12px] text-text-tertiary">
          Loading…
        </Inline>
      )}
      {!isLoading && visible.length === 0 && (
        <Inline gap="none" className="px-3 py-2 text-[12px] text-text-tertiary">
          No recent activity
        </Inline>
      )}
      {visible.map((e, idx) => (
        <Inline gap="none" key={eventKey(e, idx)} className="flex items-baseline gap-1.5 px-3 py-[5px] border-b border-border text-[12px]">
          <Inline as="span" gap="none" className="text-text-tertiary whitespace-nowrap shrink-0">
            {relativeTime(e.timestamp)}
          </Inline>
          <Inline as="span" gap="none" className="font-medium text-text-secondary whitespace-nowrap">
            {e.displayName}
          </Inline>
          <Inline as="span" gap="none" className="text-text-primary flex-1 overflow-hidden truncate whitespace-nowrap">
            {e.eventType}
          </Inline>
        </Inline>
      ))}
    </Stack>
  );
}

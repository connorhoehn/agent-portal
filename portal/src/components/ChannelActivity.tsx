// The library's `activity()` feed for one gateway channel: `useActivity` into
// the installed WrappedActivityPanel (ui-components integrations/realtime), the
// way realtime-examples shows its activity panel. The BFF is the only producer
// (middleware lib/gateway-run-feed.ts) and admits only the tenant channel
// families, so pass an `orgiq:initiative:<id>` or `pipelines:run:<id>` name.
//
// With `graph`, the section leads with the activity/work graph for that
// subject (components/work-graph/WorkGraphActivity.tsx — `useWorkGraph` into
// ui-components' `WorkGraph`; docs/activity-graph-migration.md) and keeps the
// channel's feed beneath it. The graph is a REST snapshot, so it renders
// without a gateway; the feed and the graph's live refresh need one.
// Without `graph`, nothing changes: no gateway, no section.

import { useActivity, useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { WrappedActivityPanel } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { useMemo, type ComponentProps } from 'react';
import { mergeActivity, type FeedEvent } from '../pages/pipelines/recordedEvents';
import { DetailSection, Stack } from '@connorhoehnslalom/ui-components/shared';
import { WorkGraphActivity } from './work-graph/WorkGraphActivity';
import type { WorkGraphSubject } from '../lib/workGraph';

function Feed({ channel, recorded, visibleCount }: { channel: string; recorded?: ReadonlyArray<FeedEvent> | undefined; visibleCount?: number | undefined }) {
  const activity = useActivity(channel);
  // Recorded history (the run's stored steps) sits under the live rows: the
  // gateway's history ring only fills as a subject moves.
  const merged = useMemo(
    () => (recorded?.length ? mergeActivity(recorded, activity.events) : activity.events),
    [recorded, activity.events],
  );
  return <WrappedActivityPanel activity={recorded?.length ? { ...activity, events: merged } : activity} {...(visibleCount ? { visibleCount } : {})} />;
}

type SectionProps = Pick<ComponentProps<typeof DetailSection>, 'variant' | 'size' | 'className' | 'description'>;

export function ChannelActivity({ channel, title = 'Activity', graph, onPopOutGraph, recorded, visibleCount, ...rest }: {
  channel: string; title?: string; 'data-testid'?: string;
  /** Lead with the activity/work graph for this subject. */
  graph?: WorkGraphSubject;
  /** Offers the graph's pop-out control (e.g. to /iq/activity). */
  onPopOutGraph?: () => void;
  /** The subject's stored history, merged under the live rows (oldest first). */
  recorded?: ReadonlyArray<FeedEvent>;
  /** Rows the ticker shows at once (the library default is three). */
  visibleCount?: number;
} & SectionProps) {
  const gateway = useGatewayOptional();
  const connected = !!gateway && gateway.connectionState === 'connected';
  if (graph) {
    return (
      <DetailSection title={title} {...rest}>
        <Stack gap="md">
          <WorkGraphActivity subject={graph} cursorChannel={channel} className="h-[560px]" {...(onPopOutGraph ? { onPopOut: onPopOutGraph } : {})} />
          {connected && <Feed key={channel} channel={channel} recorded={recorded} visibleCount={visibleCount} />}
        </Stack>
      </DetailSection>
    );
  }
  if (!connected) return null;
  return (
    <DetailSection title={title} {...rest}>
      <Feed key={channel} channel={channel} recorded={recorded} visibleCount={visibleCount} />
    </DetailSection>
  );
}

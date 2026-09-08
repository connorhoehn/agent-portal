// The xl-only per-page activity rail (docs/assessment-tenant.md's Workspace
// three-pane layout: "activity bar (xl+) — per-page activity, only for
// synced Confluence pages"). Its own `useChannel` call, activity-feature-only
// — DocPane already owns the same channel's chat/presence/reactions; a
// second consumer subscribing only to `activity` on the identical channel
// string is the intended multi-consumer shape for these hooks (like two
// components both calling usePresence on the same channel elsewhere in this
// app), not a duplicate connection.
//
// Renders via the plain `ActivityFeed` (shared), not `WrappedActivityPanel`
// — that wrapper lives in the library's realtime-modules integrations
// subpath (see docs/ui-components-queue.md), whose bundle statically drags
// in TiptapEditor's `@tiptap/react` import (an uninstalled optional peer)
// and breaks `vite build` on every named export, confirmed by isolating
// each one. `knowledgeFormat.activityEventToFeedItem` reproduces the
// wrapper's own event-to-feed-item mapping by hand.
//
// Feeds the feed from two sources merged by knowledgeFormat's mergeFeeds:
// the channel's own activity events (peer-originated — another viewer's
// presence/edit pings) and the assessment-broker SSE stream
// (server-originated — a save, a publish, a comment, a section pull),
// filtered down to what's relevant to this one document.

import { ActivityFeed, InlinePlaceholder, RailSection } from '@connorhoehnslalom/ui-components/shared';
import { useChannel } from '@connorhoehnslalom/realtime-modules/client';
import { activityEventToFeedItem, channelForDoc, mergeFeeds, sseEventToActivityEvent, sseEventsForDoc } from './knowledgeFormat';
import type { AssessmentSSEEvent, KnowledgeNode } from './types';

export function ActivityBar({ node, sectionKey, sseEvents }: { node: KnowledgeNode; sectionKey: string | null; sseEvents: AssessmentSSEEvent[] }) {
  const { activity } = useChannel(channelForDoc(node.id), {
    features: { chat: false, presence: false, reactions: false, activity: true },
  });

  const relevant = sseEventsForDoc(sseEvents, node.id, sectionKey).map(sseEventToActivityEvent);
  const merged = mergeFeeds(relevant, activity?.events ?? []);

  return (
    <RailSection title="Activity">
      {merged.length > 0 ? (
        <ActivityFeed items={merged.map(activityEventToFeedItem)} rotateMs={0} />
      ) : (
        <InlinePlaceholder>No recent activity for this page.</InlinePlaceholder>
      )}
    </RailSection>
  );
}

export default ActivityBar;

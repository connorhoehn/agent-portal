// Merge durable BFF activity and optional gateway events for the current
// document. The containing ContextColumn controls when the feed is visible.

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

// Merge durable BFF activity and optional gateway events for the current
// document. The rail's Activity panel and the editor's History tab read the
// same feed, so neither invents an in-memory history of its own.

import { ActivityFeed, InlinePlaceholder, RailSection } from '@connorhoehnslalom/ui-components/shared';
import { useChannel } from '@connorhoehnslalom/realtime-modules/client';
import { activityEventToFeedItem, channelForDoc, mergeFeeds, sseEventToActivityEvent, sseEventsForDoc } from './knowledgeFormat';
import type { AssessmentSSEEvent, KnowledgeNode } from './types';

interface Props { node: KnowledgeNode; sectionKey: string | null; sseEvents: AssessmentSSEEvent[] }

export function DocumentActivityFeed({ node, sectionKey, sseEvents }: Props) {
  const { activity } = useChannel(channelForDoc(node.id), {
    features: { chat: false, presence: false, reactions: false, activity: true },
  });
  const relevant = sseEventsForDoc(sseEvents, node.id, sectionKey).map(sseEventToActivityEvent);
  const merged = mergeFeeds(relevant, activity?.events ?? []);
  return merged.length > 0
    ? <ActivityFeed items={merged.map(activityEventToFeedItem)} rotateMs={0} />
    : <InlinePlaceholder>No recent activity for this page.</InlinePlaceholder>;
}

export function ActivityBar(props: Props) {
  return <RailSection title="Activity"><DocumentActivityFeed {...props} /></RailSection>;
}

export default ActivityBar;

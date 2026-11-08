// Presence and a scoped discussion for a pipelines run or definition, composed
// the way realtime-examples does it: `usePresence` -> PresenceAvatars, `useChat`
// -> WrappedChatPanel (integrations/realtime). Both run on the BFF gateway
// (`/ws`, via OptionalGatewayProvider); with no gateway the discussion shows an
// explicit unavailable notice instead of a dead composer.

import { useRef } from 'react';
import { PresenceAvatars, Stack } from '@connorhoehn/ui-components/shared';
import { usePresence } from '@connorhoehn/realtime-modules/client';
import { useCapabilities } from '../../lib/capabilities';
import { ConversationThread, useConversation } from '../../components/chat/ConversationThread';
import { useCallBlock } from '../../lib/conversationCall';
import { rosterUsers } from './pipelinesRealtime';

/** Who else has this run or definition open. Renders nothing when nobody is. */
export function PipelinePresence({ channel }: { channel: string }) {
  const { roster } = usePresence(channel, { join: true });
  const users = rosterUsers(roster);
  if (users.length === 0) return null;
  return <PresenceAvatars users={users} maxVisible={5} size={28} />;
}

/**
 * The run- or definition-scoped discussion thread: chat, read receipts,
 * quote-reply, reactions, shared pins and `/summarize` (ConversationThread, the
 * same composition as every tenant discussion), with the run's huddle — its
 * lobby is this channel — as the composer's call block.
 * `focusTarget`: the footer's Message lands in this composer (the run page).
 */
export function PipelineDiscussion({ channel, focusTarget = false }: { channel: string; focusTarget?: boolean }) {
  const { can } = useCapabilities();
  // The run/definition families publish under ViewPipelines, the same authority as reading.
  const conversation = useConversation(channel, { maySend: can('ViewPipelines') });
  const { block } = useCallBlock(channel);
  const anchor = useRef<HTMLDivElement | null>(null);
  return (
    <Stack gap="sm" ref={anchor} data-testid="pipeline-discussion">
      <ConversationThread conversation={conversation} title="Discussion" pins={{ canPin: true }} attachments reactions fill={false} notices
        composer={{ callBlock: block, answersFocus: focusTarget, onReveal: () => anchor.current?.scrollIntoView({ block: 'nearest' }) }}
        data-testid="pipeline-discussion-panel" />
    </Stack>
  );
}

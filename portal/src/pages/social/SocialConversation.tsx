// One open social conversation — a channel or a DM — on the BFF's realtime
// gateway: the header (name, who is here, the page's actions), the thread and
// its composer. The same pair the document conversation uses
// (pages/assessment/knowledge/DocumentConversation.tsx): `useChat` from
// realtime-modules, the library's hook-bound `WrappedChatPanel` from the
// scope-agnostic `integrations/realtime` entry, and `ContextComposer` in chat
// mode as its composer.
//
// Mounted only for a conversation the caller may read: the gateway admits a
// `social:ch:*` subscribe only from a member and a `social:dm:*` one only from
// someone the lobby names, so a page mounts this after a join, never before.

import { useEffect, useState, type ReactNode } from 'react';
import { ContextComposer } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { WrappedChatPanel } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { ChannelHeader, InlineAlert, Inline, PresenceAvatars, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useChat, useGatewayOptional, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat';

const OFFLINE_REASON = 'The realtime gateway is not connected, so this conversation is unavailable.';

export interface SocialConversationProps {
  /** `social:ch:<slug>` or `social:dm:<ids>`. */
  channel: string;
  /** The header's name — `#slug` for a channel, the other people for a DM. */
  name: string;
  description?: string;
  memberCount?: number;
  /** The page's own controls for this conversation (Leave, …). */
  actions?: ReactNode;
  userId: string;
  displayName: string;
  placeholder: string;
  /** Called with the thread's message count whenever it changes (a page marks the conversation read). */
  onMessages?: (count: number) => void;
}

export default function SocialConversation({ channel, name, description, memberCount, actions, userId, displayName, placeholder, onMessages }: SocialConversationProps) {
  const chat = useChat(channel);
  const { roster } = usePresence(channel, { join: true });
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const [error, setError] = useState<string | null>(null);
  const here = presenceAvatarUsers(roster);
  const count = chat.messages.length;
  useEffect(() => { onMessages?.(count); }, [count, onMessages]);

  const send = (text: string): boolean => {
    if (!connected || !text.trim()) return false;
    try {
      // The gateway stamps the sender from the token; the name travels too so
      // an older peer still renders it (WrappedChatPanel's own rule).
      chat.sendMessage(text.trim(), { displayName });
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
      return false;
    }
  };

  return (
    <Stack gap="sm" className="min-h-0 min-w-0 flex-1" data-testid="social-chat-panel">
      <ChannelHeader
        name={name}
        {...(description ? { description } : {})}
        {...(memberCount !== undefined ? { memberCount } : {})}
        actions={(
          <Inline gap="sm" align="center">
            {here.length > 0 && <PresenceAvatars size={24} maxVisible={5} users={here} />}
            {actions}
          </Inline>
        )}
      />
      {!connected && <InlineAlert tone="warning">{OFFLINE_REASON}</InlineAlert>}
      {error && <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert>}
      <WrappedChatPanel key={channel} chat={chat} currentUserId={userId} displayName={displayName}
        fill showHeader={false} disabled={!connected}
        composer={<ContextComposer context={{ kind: 'conversation', id: channel, title: name }} modes={['chat']}
          chatAvailable={connected} {...(connected ? {} : { modeUnavailableReasons: { chat: OFFLINE_REASON } })}
          modePlaceholders={{ chat: placeholder }} allowAttachments={false} draftKey={`social:${channel}`}
          onSend={(message) => send(message.text)}
          label={`Message ${name}`}
          data-testid="social-chat-composer-dock" composerTestId="social-chat-composer" />} />
    </Stack>
  );
}

// One open social conversation — a channel, a DM or a team channel — on the
// BFF's realtime gateway, drawn as the library's conversation surface
// (`WrappedConversationSurface`, the one realtime-examples' MessagesPage uses):
// the header (name, description, the view tabs Chat | Documents | Pinned |
// Calls, the audio/video call actions, who is here, the page's ⋯ menu) over the
// view. Chat is the pair the document conversation uses
// (pages/assessment/knowledge/DocumentConversation.tsx): `useChat` from
// realtime-modules, the hook-bound `WrappedChatPanel` from the scope-agnostic
// `integrations/realtime` entry, and `ContextComposer` in chat mode.
//
//   - Documents: the documents this conversation carries — a document card
//     posted in it (`documentRefFromMetadata`) and a `#document` reference in a
//     message (`documentRefsFromMetadata`), newest first.
//   - Pinned: the library's PinnedMessagesPanel. The pin store is
//     realtime-modules' `usePins`, which asks the gateway's REST half
//     (`/api/chat/pins`); the BFF does not serve that route yet, so the hook is
//     not bound here (it would 404 on every open) and the view says nothing
//     is pinned. Bind `usePins(channel)` to `pins` (and to WrappedChatPanel's
//     `pins`, which adds the message ⋯ Pin) once the route exists.
//   - Calls: the recordings made in this conversation's lobby
//     (`GET /api/social/recordings`, filtered by the page).
//
// Mounted only for a conversation the caller may read: the gateway admits a
// `social:ch:*` subscribe only from a member and a `social:dm:*` one only from
// someone the lobby names, so a page mounts this after a join, never before.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ContextComposer } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { WrappedChatPanel, WrappedConversationSurface } from '@connorhoehnslalom/ui-components/integrations/realtime';
import {
  documentRefFromMetadata, documentRefsFromMetadata,
  type ChannelDocumentItem, type ChannelRecordingItem, type ConversationFeature,
} from '@connorhoehnslalom/ui-components/social';
import { DropdownMenu, InlineAlert, Inline, MoreIcon, PresenceAvatars, type DropdownMenuItem } from '@connorhoehnslalom/ui-components/shared';
import { useChat, useGatewayOptional, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat';

const OFFLINE_REASON = 'The realtime gateway is not connected, so this conversation is unavailable.';
/** The views the header offers, in the reference's order. */
export const CONVERSATION_VIEWS: readonly ConversationFeature[] = ['chat', 'documents', 'pins', 'calls'];

export function conversationView(value: string | null | undefined): ConversationFeature {
  return (CONVERSATION_VIEWS as readonly string[]).includes(value ?? '') ? value as ConversationFeature : 'chat';
}

export interface SocialConversationProps {
  /** `social:ch:<slug>`, `social:dm:<ids>` or `social:team:<team>:<channel>`. */
  channel: string;
  /** The header's name — `#slug` for a channel, the other people for a DM. */
  name: string;
  description?: string;
  /** A DM: whether the other person is in the workspace now (the header's dot). */
  online?: boolean;
  /** The ⋯ menu's items (Leave, Members, …). */
  menu?: DropdownMenuItem[];
  /** Controls beside the call actions. */
  headerActions?: ReactNode;
  /** Start (or join) this conversation's call; absent when calls are unavailable. */
  onStartCall?: (audioOnly: boolean) => void;
  callInProgress?: boolean;
  /** Recordings made in this conversation's lobby (the Calls view). */
  recordings?: readonly ChannelRecordingItem[];
  onOpenRecording?: (recordingId: string) => void;
  view: ConversationFeature;
  onViewChange: (view: ConversationFeature) => void;
  userId: string;
  displayName: string;
  placeholder: string;
  /** Called with the thread's message count whenever it changes (a page marks the conversation read). */
  onMessages?: (count: number) => void;
}

type ChatMessage = { id?: string; timestamp?: string; userId?: string; metadata?: Record<string, unknown> };

/** Documents carried by the thread: cards posted in it and `#` references, newest first, one row each. */
function threadDocuments(messages: readonly ChatMessage[]): ChannelDocumentItem[] {
  const byId = new Map<string, ChannelDocumentItem>();
  for (const m of messages) {
    const card = documentRefFromMetadata(m.metadata);
    const refs = documentRefsFromMetadata(m.metadata).map((r) => ({ documentId: r.id, title: r.label, ...(r.icon ? { icon: r.icon } : {}) }));
    for (const doc of [...(card ? [card] : []), ...refs]) {
      byId.set(doc.documentId, { ...byId.get(doc.documentId), ...doc, ...(m.timestamp ? { updatedAt: m.timestamp } : {}) });
    }
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export default function SocialConversation({
  channel, name, description, online, menu, headerActions, onStartCall, callInProgress, recordings, onOpenRecording,
  view, onViewChange, userId, displayName, placeholder, onMessages,
}: SocialConversationProps) {
  const chat = useChat(channel);
  const { roster } = usePresence(channel, { join: true });
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const [error, setError] = useState<string | null>(null);
  const here = presenceAvatarUsers(roster);
  const count = chat.messages.length;
  useEffect(() => { onMessages?.(count); }, [count, onMessages]);
  const documents = useMemo(() => threadDocuments(chat.messages as readonly ChatMessage[]), [chat.messages]);

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

  const actions = (
    <Inline gap="sm" align="center" wrap={false}>
      {here.length > 0 && <PresenceAvatars size={24} maxVisible={5} users={here} />}
      {headerActions}
      {menu && menu.length > 0 && (
        <DropdownMenu trigger={<MoreIcon size={16} />} triggerLabel={`More for ${name}`} triggerTitle="More"
          triggerTestId="social-conversation-menu" triggerClassName="h-8 w-8 border-transparent px-0 py-0 text-text-secondary"
          align="end" sections={[{ items: menu }]} />
      )}
    </Inline>
  );

  return (
    <WrappedConversationSurface
      className="min-h-0 min-w-0 flex-1"
      name={name}
      {...(description ? { description } : {})}
      {...(online !== undefined ? { online } : {})}
      declare={CONVERSATION_VIEWS}
      view={view}
      onViewChange={onViewChange}
      documents={documents}
      pins={[]}
      recordings={recordings ?? []}
      {...(onOpenRecording ? { onOpenRecording } : {})}
      {...(onStartCall ? { onStartCall } : {})}
      callInProgress={!!callInProgress}
      headerActions={actions}
      canvas={!connected || error ? (
        <>
          {!connected && <InlineAlert tone="warning">{OFFLINE_REASON}</InlineAlert>}
          {error && <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert>}
        </>
      ) : undefined}
      data-testid="social-chat-panel"
    >
      <WrappedChatPanel key={channel} chat={chat} currentUserId={userId} displayName={displayName}
        fill showHeader={false} disabled={!connected}
        composer={<ContextComposer context={{ kind: 'conversation', id: channel, title: name }} modes={['chat']}
          chatAvailable={connected} {...(connected ? {} : { modeUnavailableReasons: { chat: OFFLINE_REASON } })}
          modePlaceholders={{ chat: placeholder }} allowAttachments={false} draftKey={`social:${channel}`}
          onSend={(message) => send(message.text)}
          label={`Message ${name}`}
          data-testid="social-chat-composer-dock" composerTestId="social-chat-composer" />} />
    </WrappedConversationSurface>
  );
}

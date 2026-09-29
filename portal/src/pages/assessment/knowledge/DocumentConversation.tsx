// A document's conversation — the composer dock under the page and the Chat
// panel beside it, the way realtime-examples' page editor pairs its
// `ContextComposer` ("Chat · <title> ×", "Message this document's
// conversation…") with DocumentChatPanel.
//
// The conversation is a gateway chat channel on the BFF's own realtime
// gateway (`/ws`, authenticated with the HS256 realtime token by
// OptionalGatewayProvider) — NOT the document gateway the canvas talks to with
// its document grant. So the hook here must run OUTSIDE the canvas's
// `GatewaySocketProvider`; CanvasDocumentPane calls it at the pane level and
// hands the dock and the panel into both frames. One `useChat` join per page:
// the dock and the panel read and write the same thread.
//
// The thread is the library `ChatPanel` fed through the portal's own message
// adapter, not `WrappedChatPanel`: the library's realtime-modules
// integrations entry imports the canonical `@connorhoehn/realtime-modules`
// scope, which this portal keys as `@connorhoehnslalom/realtime-modules`, so
// importing it fails at runtime ("does not provide an export named
// 'useLVSLiveHls'") — and validate-component-discipline.sh bans the import.
// Queued in docs/ui-components-queue.md.

import { useState } from 'react';
import { ContextComposer } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { WrappedChatPanel } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { InlineAlert, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useChat, useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { DocumentContextPanel, useDocumentContext } from './ExplorerFrame';
import { conversationChannelForDoc } from './knowledgeFormat';

const OFFLINE_REASON = 'The realtime gateway is not connected, so this document’s conversation is unavailable.';

export function useDocumentConversation(docId: string, displayName: string) {
  const channel = conversationChannelForDoc(docId);
  const chat = useChat(channel);
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const [error, setError] = useState<string | null>(null);
  const send = (text: string): boolean => {
    if (!connected || !text.trim()) return false;
    try {
      // The gateway does not invent a display name; without it the message
      // reaches everyone else nameless (WrappedChatPanel's own rule).
      chat.sendMessage(text.trim(), { displayName });
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
      return false;
    }
  };
  return { channel, chat, connected, displayName, send, error, clearError: () => setError(null) };
}

export type DocumentConversation = ReturnType<typeof useDocumentConversation>;

/** The composer dock: the EditorShell footer on the Editor tab. */
export function DocumentComposerDock({ docId, title, conversation }: { docId: string; title: string; conversation: DocumentConversation }) {
  const context = useDocumentContext();
  const [chip, setChip] = useState(true);
  return <ContextComposer
    context={{ kind: 'document', id: docId, title }}
    defaultMode="chat"
    disabledModes={['agent', 'terminal']}
    modeUnavailableReasons={{
      agent: 'No agent edits assessment documents — say it in the conversation, or edit the draft.',
      terminal: 'Terminal sends lines to a running agent loop, and none is attached to a document.',
      ...(conversation.connected ? {} : { chat: OFFLINE_REASON }),
    }}
    chatAvailable={conversation.connected}
    modePlaceholders={{ chat: 'Message this document’s conversation…' }}
    contextChip={chip}
    onRemoveContext={() => setChip(false)}
    allowAttachments={false}
    draftKey={`assessment-document:${docId}`}
    {...(conversation.error ? { above: <InlineAlert tone="error" onDismiss={conversation.clearError}>{conversation.error}</InlineAlert> } : {})}
    onSend={(message, { mode }) => {
      if (mode !== 'chat') return false;
      const sent = conversation.send(message.text);
      // Show where it went: the thread opens beside the page.
      if (sent) context?.open('chat');
      return sent;
    }}
    label="Document conversation composer"
    data-testid="page-composer-dock"
    composerTestId="page-composer" />;
}

/** The thread, in the context column's Chat panel. */
export function DocumentChatPanel({ title, userId, conversation }: { title: string; userId: string; conversation: DocumentConversation }) {
  // The library's own hook-bound wrapper (ui-components 2.407.20,
  // `integrations/realtime` — the scope-agnostic entry): it takes the
  // `useChat` result and adapts the thread itself, the way the initiative
  // and search pages do, so this page composes no message adapter of its own.
  return <DocumentContextPanel id="chat">
    <Stack gap="sm" className="min-h-0 flex-1" data-testid="document-chat-panel">
      {!conversation.connected && <InlineAlert tone="warning">{OFFLINE_REASON}</InlineAlert>}
      <WrappedChatPanel key={conversation.channel} chat={conversation.chat} currentUserId={userId} displayName={conversation.displayName}
        fill showHeader={false} disabled={!conversation.connected}
        composer={<ContextComposer context={{ kind: 'conversation', id: conversation.channel, title }} modes={['chat']}
          chatAvailable={conversation.connected} {...(conversation.connected ? {} : { modeUnavailableReasons: { chat: OFFLINE_REASON } })}
          modePlaceholders={{ chat: 'Write a message…' }} allowAttachments={false} draftKey={`${conversation.channel}:panel`}
          onSend={message => conversation.send(message.text)}
          data-testid="document-chat-composer-dock" composerTestId="document-chat-composer" />} />
    </Stack>
  </DocumentContextPanel>;
}

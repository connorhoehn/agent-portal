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
import { useDocumentAgentEdit, type DocumentAgentEdit } from './useDocumentAgentEdit';

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

/**
 * The composer dock: the EditorShell footer on the Editor tab.
 *
 * Agent mode is on and the default (parity goal, decision 8): an instruction
 * goes to the assessment drafter with the page as context, and its reply comes
 * back as a proposed edit (`useDocumentAgentEdit`). Chat stays a mode and
 * posts to the document's conversation as before; Terminal stays off.
 *
 * The pane owns the agent edit when it can: it calls `useDocumentAgentEdit`
 * beside `useDocumentConversation`, passes the result here as `agentEdit`, and
 * hands `agentEdit.strip` to the shell's `proposal` slot so the strip sits in
 * the editor frame. Without one the dock runs its own and, having no frame
 * slot to reach, carries the strip above its composer row.
 *
 * `agentEditable` is whether the ROLE may edit this document. A reader (the
 * assessor) used to get Agent mode by default, a real drafter run, and an
 * Apply that refused only after the click (assessment journeys, defect #17);
 * for a role that cannot edit, Agent mode is offered-but-off with the reason,
 * the dock opens in Chat, and an agent send is refused before it leaves.
 */
export function DocumentComposerDock(props: { docId: string; title: string; conversation: DocumentConversation; agentEdit?: DocumentAgentEdit; agentEditable: boolean }) {
  return props.agentEdit
    ? <ComposerDock {...props} agentEdit={props.agentEdit} stripInDock={false} />
    : <DockWithOwnAgentEdit {...props} />;
}

function DockWithOwnAgentEdit(props: { docId: string; title: string; conversation: DocumentConversation; agentEditable: boolean }) {
  const agentEdit = useDocumentAgentEdit(props.docId, props.title);
  return <ComposerDock {...props} agentEdit={agentEdit} stripInDock />;
}

export const READER_AGENT_REASON = 'Your current role can read this document; ask an editor to make changes.';

function ComposerDock({ docId, title, conversation, agentEdit, stripInDock, agentEditable }: { docId: string; title: string; conversation: DocumentConversation; agentEdit: DocumentAgentEdit; stripInDock: boolean; agentEditable: boolean }) {
  const context = useDocumentContext();
  const [chip, setChip] = useState(true);
  const error = agentEdit.error ?? conversation.error;
  const clearError = () => { agentEdit.clearError(); conversation.clearError(); };
  const above = (error || (stripInDock && agentEdit.strip)) ? <Stack gap="xs">
    {error && <InlineAlert tone="error" onDismiss={clearError} data-testid="page-composer-error">{error}</InlineAlert>}
    {stripInDock && agentEdit.strip}
  </Stack> : null;
  return <ContextComposer
    context={{ kind: 'document', id: docId, title }}
    defaultMode={agentEditable ? 'agent' : 'chat'}
    disabledModes={agentEditable ? ['terminal'] : ['terminal', 'agent']}
    modeUnavailableReasons={{
      terminal: 'Terminal sends lines to a running agent loop, and none is attached to a document.',
      ...(agentEditable ? {} : { agent: READER_AGENT_REASON }),
      ...(conversation.connected ? {} : { chat: OFFLINE_REASON }),
    }}
    chatAvailable={conversation.connected}
    modePlaceholders={{
      agent: 'Ask the drafter to edit this page — select text to rewrite it…',
      chat: 'Message this document’s conversation…',
    }}
    contextChip={chip}
    onRemoveContext={() => setChip(false)}
    allowAttachments={false}
    draftKey={`assessment-document:${docId}`}
    working={agentEdit.working}
    task={agentEdit.task}
    {...(above ? { above } : {})}
    onSend={(message, { mode }) => {
      if (mode === 'agent') return agentEditable ? agentEdit.send(message.text) : false;
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

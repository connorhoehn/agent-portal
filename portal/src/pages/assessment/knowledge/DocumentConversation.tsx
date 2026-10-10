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
// The dock is the library `ConversationComposer` (Agent → the drafter's
// proposed edit, Chat → this conversation); the thread is ConversationThread
// over the library `WrappedChatPanel` (the scope-agnostic
// `integrations/realtime` entry).

import { offlineReason } from '../../../components/chat/chatConnection';
import { useState } from 'react';
import { InlineAlert, Stack } from '@connorhoehnslalom/ui-components/shared';
import { DocumentContextPanel, useDocumentContext } from './ExplorerFrame';
import { conversationChannelForDoc } from './knowledgeFormat';
import { useDocumentAgentEdit, type DocumentAgentEdit } from './useDocumentAgentEdit';
import { routeDockSend } from './documentComposerRoute';
import { ConversationThread, useConversation } from '../../../components/chat/ConversationThread';
import { ConversationComposer } from '../../../lib/conversationComposer';
import { useCallBlock, useCallHost } from '../../../lib/conversationCall';
import { lobbyPrefix } from '../../../lib/conversationCallModel';
import { documentCallLobby } from './documentCommentsModel';

const OFFLINE_REASON = offlineReason('this document’s conversation');

/**
 * The page's ONE conversation (`useConversation` on the document's channel):
 * the dock under the page and the Chat panel beside it share it. The doc family
 * publishes under ViewAssessment, the authority that already lets this reader
 * open the page, so every reader may post.
 */
export function useDocumentConversation(docId: string) {
  const conversation = useConversation(conversationChannelForDoc(docId), { maySend: true });
  const [error, setError] = useState<string | null>(null);
  /** A Chat send: the composer has landed the files and stamped the quote. */
  const send = (text: string, metadata: Record<string, unknown>): boolean => {
    try {
      conversation.chat.sendMessage(text, metadata);
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
      return false;
    }
  };
  return { ...conversation, send, error, clearError: () => setError(null) };
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
 * `agentEditable` is whether the ROLE may edit this document. For a role that
 * cannot edit, Agent mode is offered-but-off with the reason, the dock opens
 * in Chat, and an agent send is refused before it leaves (assessment
 * journeys, defect #17).
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
  // This document's huddle (useDocumentCall's lobby): the call bar and tiles above the input,
  // naming the document as its chip (the mockup's "Auth architecture review · Auth architecture").
  const tenant = useCallHost()?.tenant ?? null;
  const { block } = useCallBlock(tenant ? documentCallLobby(lobbyPrefix(tenant), conversation.channel) : null, { documents: [{ id: docId, title }] });
  const error = agentEdit.error ?? conversation.error;
  const clearError = () => { agentEdit.clearError(); conversation.clearError(); };
  const above = (error || (stripInDock && agentEdit.strip)) ? <Stack gap="xs">
    {error && <InlineAlert tone="error" onDismiss={clearError} data-testid="page-composer-error">{error}</InlineAlert>}
    {stripInDock && agentEdit.strip}
  </Stack> : null;
  return <ConversationComposer
    channel={conversation.channel}
    chat={conversation.chat}
    context={{ kind: 'document', id: docId, title }}
    // The role decides Agent (a reader's is off with the reason); the doc family lets every reader post.
    capabilities={{ maySend: conversation.maySend, mayAttach: true, agent: { allowed: agentEditable, reason: READER_AGENT_REASON } }}
    offModes={{ terminal: 'Terminal sends lines to a running agent loop, and none is attached to a document.' }}
    offline={conversation.connected ? null : OFFLINE_REASON}
    identity={{ userId: conversation.userId, displayName: conversation.displayName }}
    defaultMode={agentEditable ? 'agent' : 'chat'}
    // A quote-reply started in the thread beside the page travels with a Chat send.
    reply={conversation.quote}
    // Agent → the drafter (a reader's Agent is off); Chat → this conversation, and the thread opens beside the page.
    onAgent={text => routeDockSend('agent', { agentEditable, agent: () => agentEdit.send(text), chat: () => false })}
    recipients={[{ id: 'discussion', label: title, channel: conversation.channel, attachments: true,
      send: out => routeDockSend('chat', { agentEditable, agent: () => false, chat: () => {
        const sent = conversation.send(out.text, out.metadata);
        if (sent) context?.open('chat');
        return sent;
      } }) }]}
    // One input per conversation: while this dock is mounted it owns the conversation's input,
    // so the Chat panel beside the page shows the thread only and its Write/Reply land here.
    claim={{ label: 'the document composer', replies: true }}
    answersFocus
    callBlock={block}
    modePlaceholders={{
      agent: 'Ask the drafter to edit this page — select text to rewrite it…',
      chat: 'Message this document’s conversation…',
    }}
    contextChip={chip}
    onRemoveContext={() => setChip(false)}
    draftKey={`assessment-document:${docId}`}
    working={agentEdit.working}
    task={agentEdit.task}
    {...(above ? { above } : {})}
    label="Document conversation composer"
    data-testid="page-composer-dock"
    composerTestId="page-composer" />;
}

/**
 * The thread, in the context column's Chat panel: ConversationThread
 * (`/summarize`, shared pins, attachments) over the page's own conversation.
 * The doc family publishes under ViewAssessment, so every reader may pin. While
 * the dock is mounted (the Editor tab) it owns this conversation's input: the
 * panel is then the thread only, and Write/Reply put the caret in the dock.
 */
export function DocumentChatPanel({ title, conversation }: { title: string; conversation: DocumentConversation }) {
  return <DocumentContextPanel id="chat">
    <Stack gap="sm" className="min-h-0 flex-1" data-testid="document-chat-panel">
      {!conversation.connected && <InlineAlert tone="warning">{OFFLINE_REASON}</InlineAlert>}
      <ConversationThread conversation={conversation} title={title} pins={{ canPin: true }} attachments reactions
        placeholder="Write a message…"
        composer={{ draftKey: `${conversation.channel}:panel`,
          recipients: [{ id: 'discussion', label: title, channel: conversation.channel, attachments: true, send: out => conversation.send(out.text, out.metadata) }] }}
        data-testid="document-chat" />
    </Stack>
  </DocumentContextPanel>;
}

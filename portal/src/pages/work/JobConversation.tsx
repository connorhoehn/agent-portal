import { ComposerSurface } from '@connorhoehn/ui-components/shared';
import type { RichChatDraft } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { DeckAssistantPane } from '../../components/decks/DeckAssistantPane';
import { useHuddleComposerRecipient } from '../../components/shell/HuddleComposerDock';
import { useSession } from '../../lib/auth';
import type { CallPageDescriptor } from '../../lib/callPages';
import { useCapabilities } from '../../lib/capabilities';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { ConversationComposer } from '../../lib/conversationComposer';
import { InitiativeAgentPanel, type InitiativeAgentHandle } from '../projects/InitiativeAgentPanel';
import { jobAgentRequest, type JobQuestionContext } from './jobAgentRequest';

/** Keep the existing run and native call visible while the agent answers. */
export function JobConversation({ job }: { job: JobQuestionContext }) {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const navigate = useNavigate();
  const host = useCallHost();
  const [withReference, setWithReference] = useState(true);
  const [mode, setMode] = useState<'agent' | 'chat'>('agent');
  const [draft, setDraft] = useState<RichChatDraft>({ html: '', files: [] });
  const [request, setRequest] = useState(0);
  const questions = useRef<InitiativeAgentHandle | null>(null);
  const projectId = typeof job.payload.initiativeId === 'string' ? job.payload.initiativeId : '';
  const itemId = typeof job.payload.workItemId === 'string' ? job.payload.workItemId : '';
  const page = useMemo<CallPageDescriptor | null>(() => !withReference ? null : itemId
    ? { kind: 'work-item', id: itemId } : projectId ? { kind: 'initiative', id: projectId } : null,
  [withReference, itemId, projectId]);
  const { chat, recipient } = useHuddleComposerRecipient(page);
  const call = useCallBlock(chat?.callId ? host?.lobby?.channel ?? null : null, { compact: true });
  const canAsk = session?.tenant === 'orgiq' && ready && can('Search');
  const chatting = mode === 'chat' && !!recipient;
  const unavailable = ready ? 'Agent questions are not included in your current access.' : 'Access is still loading.';
  return <>
    <DeckAssistantPane deckTitle={job.title} assistantTitle="Run assistant" composerTestId="job-composer-dock" questionRequest={request}
      question={<InitiativeAgentPanel key={`${session?.sub}:${canAsk}`} ref={questions} projectId={projectId}
        assistantTitle="Run assistant" emptyTitle="Ask about this computer job"
        onOpenWorkItem={id => navigate(projectId ? `/iq/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ tab: 'work', item: id })}` : '/iq/projects')} />} />
    <ComposerSurface className="sticky bottom-0 z-10" data-testid="job-composer-dock">
      <ConversationComposer channel={null}
        context={{ kind: 'conversation', id: `job:${job.id}`, title: '', reference: withReference ? { id: job.id, label: job.title, ...(page ? { page } : {}) } : null }}
        capabilities={{ maySend: !!chat?.canSend, agent: { allowed: canAsk, reason: unavailable } }}
        recipients={recipient ? [recipient] : []} recipient={chatting ? recipient!.id : null}
        defaultMode="agent" mode={mode} onModeChange={value => { if (value === 'agent' || value === 'chat') setMode(value); }}
        draft={chatting ? chat!.draft : draft} onDraftChange={chatting ? chat!.setDraft : setDraft} persistDraft={false}
        onAgent={text => {
          if (!canAsk) return unavailable;
          const captured = jobAgentRequest(text, job, withReference);
          if (!captured) return false;
          const result = questions.current?.submit(captured) ?? 'The run assistant is still loading.';
          if (result === true) setRequest(value => value + 1);
          return result;
        }}
        onRemoveReference={() => setWithReference(false)}
        callBlock={chat?.callId ? call.block : null} claim={{ label: 'the computer job composer' }} answersFocus
        modePlaceholders={{ agent: 'Ask about this run…' }} inputLabel="Run message" label="Computer job conversation"
        presentation="document" data-testid="job-conversation" composerTestId="job-composer"
        maxInputHeight="min(8rem, 20dvh)" className="@container" />
    </ComposerSurface>
  </>;
}

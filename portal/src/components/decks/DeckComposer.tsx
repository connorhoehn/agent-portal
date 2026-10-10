// The deck's footer composer: the library's ConversationComposer with a
// `document` context and no conversation, the way realtime-examples'
// PresentationEditorPage does
// (PresentationEditorPage.tsx:212-225, 560-575 + usePresentationComposer.tsx).
// The deck's access decides whether Ask, Edit, or both are offered. A joined
// huddle enables Chat in this same input. Edit uses the tenant's existing
// saved-version revise route; Ask uses the host's read-only agent stream.

import { useCallback, useMemo, useState } from 'react';
import type { ComposerStatus, RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { DropdownMenu, Inline, T } from '@connorhoehnslalom/ui-components/shared';
import { ConversationComposer } from '../../lib/conversationComposer';
import { useHuddleComposerRecipient } from '../shell/HuddleComposerDock';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { initiativeFromChannel } from '../../lib/conversationCallModel';
import type { PresentationInstructContext, PresentationInstructResult } from '@connorhoehnslalom/ui-components/doc-editor';

export interface DeckComposerProps {
  deckId: string;
  deckTitle: string;
  /** The slide on the stage; the instruction targets it unless scope is the whole deck. */
  selectedSlideId?: string;
  slideNumber?: number;
  hints: readonly string[];
  instruct: (instruction: string, ctx: PresentationInstructContext) => Promise<PresentationInstructResult>;
  onChanged: (slideIds: string[]) => void;
  canInstruct?: boolean;
  canAsk?: boolean;
  askUnavailableReason?: string;
  onAsk?: (question: string, ctx: PresentationInstructContext, withReference: boolean) => boolean | string;
  generatedSlideTitle?: string;
}

export function DeckComposer({ deckId, deckTitle, selectedSlideId, slideNumber, hints, instruct, onChanged,
  canInstruct = true, canAsk = false, askUnavailableReason = 'Agent questions are not included in your current access.', onAsk, generatedSlideTitle,
}: DeckComposerProps) {
  const host = useCallHost();
  const channel = host?.lobby?.channel;
  const [withReference, setWithReference] = useState(true);
  const page = useMemo(() => {
    const projectId = initiativeFromChannel(channel);
    return !withReference ? null : projectId ? { kind: 'initiative' as const, id: projectId } : undefined;
  }, [channel, withReference]);
  const { chat: huddle, recipient } = useHuddleComposerRecipient(page);
  const call = useCallBlock(huddle?.callId ? channel ?? null : null, { compact: true });
  const [mode, setMode] = useState<'agent' | 'chat'>('agent');
  const [intent, setIntent] = useState<'ask' | 'edit'>('ask');
  const asking = !canInstruct || (canAsk && intent === 'ask');
  const [agentDraft, setAgentDraft] = useState<RichChatDraft>({ html: '', files: [] });
  const chatting = mode === 'chat' && !!recipient;
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<ComposerStatus | null>(null);

  const run = useCallback(async (text: string): Promise<boolean> => {
    const instruction = text.replace(/^\s*\/agent\b\s*/i, '').trim();
    if (!instruction) return false;
    setWorking(true);
    setStatus(null);
    try {
      const ctx: PresentationInstructContext = selectedSlideId
        ? { scope: 'slide', slideId: selectedSlideId }
        : { scope: 'deck' };
      if (asking) {
        const accepted = canAsk && onAsk ? onAsk(instruction, ctx, withReference) : askUnavailableReason;
        if (accepted !== true) throw new Error(typeof accepted === 'string' ? accepted : 'The presentation assistant is still loading.');
        return true;
      }
      if (!canInstruct) throw new Error('This presentation is read-only.');
      const result = await instruct(instruction, ctx);
      onChanged(result.changedSlideIds ?? []);
      setStatus({ text: result.summary, tone: 'success', onDismiss: () => setStatus(null), 'data-testid': 'deck-composer-status' });
      return true;
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'The agent could not revise the deck.',
        tone: 'danger',
        onDismiss: () => setStatus(null),
        'data-testid': 'deck-composer-status',
      });
      return false;
    } finally {
      setWorking(false);
    }
  }, [instruct, onChanged, selectedSlideId, asking, canAsk, onAsk, askUnavailableReason, canInstruct, withReference]);

  const scope = selectedSlideId || generatedSlideTitle ? `slide ${slideNumber ?? ''}`.trim() : 'this presentation';
  const modeRow = chatting ? <Inline gap="xs" wrap={false}><T size="xs" tone="secondary">To:</T><T size="xs" weight="medium">Huddle</T></Inline>
    : canAsk && canInstruct ? <DropdownMenu trigger={<T as="span" size="xs" weight="medium">{asking ? 'Ask' : 'Edit'}</T>}
      triggerLabel="Presentation agent action" triggerVariant="default" sections={[{ items: [
        { label: 'Ask about this presentation', description: 'Explain the selected slide without changing the deck.', active: asking, onSelect: () => { setIntent('ask'); setStatus(null); } },
        { label: 'Edit saved slides', description: 'Revise the saved presentation with the agent.', active: !asking, onSelect: () => { setIntent('edit'); setStatus(null); } },
      ] }]} /> : <T as="span" size="xs" tone="secondary">{asking ? 'Ask' : 'Edit'}</T>;

  return (
    <div className="initiative-composer-dock deck-composer-backdrop shrink-0">
    <ConversationComposer
      channel={null}
      context={chatting && huddle ? { kind: 'conversation', id: huddle.callId!, title: '',
        reference: page ? { id: `initiative:${page.id}`, label: 'Initiative context', page } : null,
      } : { kind: 'document', id: deckId, title: deckTitle,
        reference: withReference ? { id: `document:${deckId}`, label: `${deckTitle}${selectedSlideId || generatedSlideTitle ? ` · Slide ${slideNumber ?? ''}` : ''}` } : null }}
      capabilities={{ maySend: !!huddle?.canSend, agent: { allowed: canAsk || canInstruct, reason: askUnavailableReason } }}
      recipients={recipient ? [recipient] : []} recipient={recipient?.id ?? null}
      claim={{ label: 'the presentation composer' }} answersFocus
      mode={chatting ? 'chat' : 'agent'} onModeChange={next => {
        if (next === 'agent' || next === 'chat') { setMode(next); setStatus(null); if (next === 'chat') huddle?.openPane(); }
      }}
      draft={chatting ? huddle!.draft : agentDraft} onDraftChange={next => chatting ? huddle?.setDraft(next) : setAgentDraft(next)}
      onRemoveReference={() => setWithReference(false)}
      callBlock={huddle?.callId ? call.block : null}
      modeRowStart={modeRow}
      defaultMode="agent"
      onAgent={text => run(text)}
      persistDraft={false}
      // Use the shared document composer and its theme-aware particle dock.
      console={false}
      working={!chatting && working}
      status={chatting ? null : status}
      suggestions={chatting ? [] : asking ? ['Summarize this slide', 'Explain the figures', 'What should we discuss next?'] : hints}
      onSuggestion={(suggestion) => { void run(suggestion); }}
      modePlaceholders={{ agent: asking ? `Ask about ${scope}…` : selectedSlideId ? `Tell the agent what to change on slide ${slideNumber ?? ''}…`.replace(' …', '…') : 'Tell the agent what to change across the whole deck…' }}
      presentation="document" label="Presentation conversation" inputLabel="Presentation message"
      maxInputHeight="min(8rem, 20dvh)" className="@container bg-surface pt-0 [--dock-inset:0px]"
      data-testid="deck-composer-dock"
      composerTestId="deck-composer"
    />
    </div>
  );
}

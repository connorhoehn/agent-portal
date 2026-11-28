import { ComposerSurface } from '@connorhoehn/ui-components/shared';
// The deck's footer composer: the library's ConversationComposer with a
// `document` context and no conversation, the way realtime-examples'
// PresentationEditorPage does
// (PresentationEditorPage.tsx:212-225, 560-575 + usePresentationComposer.tsx).
// The deck's access decides whether Ask, Edit, or both are offered. A joined
// huddle enables Chat in this same input. Edit uses the tenant's existing
// saved-version revise route; Ask uses the host's read-only agent stream.
// An Edit that changes structure, layout, style, decoration, emphasis or a
// chart (deckEditIntent.ts) asks for typed operations instead: the proposal
// shows as a confirm card above the input (the voice's card, its wording), and
// nothing is saved until Apply. Discard drops it.

import type { PresentationInstructContext, PresentationInstructResult } from '@connorhoehn/ui-components/doc-editor';
import { DropdownMenu, Inline, T } from '@connorhoehn/ui-components/shared';
import { VoiceConfirmCard } from '@connorhoehn/ui-components/voice';
import type { ComposerStatus, RichChatDraft } from '@connorhoehn/ui-components/social/rich-composer';
import { useCallback, useMemo, useState } from 'react';
import { useCallBlock, useCallHost } from '../../lib/conversationCall';
import { initiativeFromChannel } from '../../lib/conversationCallModel';
import { ConversationComposer } from '../../lib/conversationComposer';
import { useHuddleComposerRecipient } from '../shell/HuddleComposerDock';
import type { DeckOperationsProposal } from './deckApi';
import { deckEditIntent } from './deckEditIntent';
import { plainDeckRefusal } from './deckRefusal';
import { proposalDetail, proposalOutcome, proposalTitle } from './deckProposal';
import './deckReviewLayout.css';

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
  /** Edit's operations mode: ask the agent for typed operations on the saved head (nothing is saved). */
  propose?: (instruction: string, ctx: PresentationInstructContext) => Promise<DeckOperationsProposal>;
  /** Apply a proposal as this person, through the deck's operations route. */
  applyProposal?: (proposal: DeckOperationsProposal) => Promise<PresentationInstructResult>;
}

export function DeckComposer({ deckId, deckTitle, selectedSlideId, slideNumber, hints, instruct, onChanged,
  canInstruct = true, canAsk = false, askUnavailableReason = 'Agent questions are not included in your current access.', onAsk, generatedSlideTitle, propose, applyProposal,
}: DeckComposerProps) {
  const host = useCallHost();
  const channel = host?.lobby?.channel;
  const [withReference, setWithReference] = useState(true);
  const page = useMemo(() => {
    const projectId = initiativeFromChannel(channel);
    return !withReference ? null : projectId ? { kind: 'initiative' as const, id: projectId } : undefined;
  }, [channel, withReference]);
  const { chat: huddle, recipient } = useHuddleComposerRecipient(page);
  const compactReview = !!huddle?.callId;
  const call = useCallBlock(huddle?.callId ? channel ?? null : null, { compact: true });
  const [mode, setMode] = useState<'agent' | 'chat'>('agent');
  const [intent, setIntent] = useState<'ask' | 'edit'>('ask');
  const asking = !canInstruct || (canAsk && intent === 'ask');
  const [agentDraft, setAgentDraft] = useState<RichChatDraft>({ html: '', files: [] });
  const chatting = mode === 'chat' && !!recipient;
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<ComposerStatus | null>(null);
  // The agent's proposed operations, waiting for Apply or Discard. Every proposal waits for the click,
  // a removal included (first version: no operation is applied without it).
  const [proposal, setProposal] = useState<{ key: number; value: DeckOperationsProposal } | null>(null);
  const show = useCallback((text: string, tone: ComposerStatus['tone']) => {
    setStatus({ text, tone, onDismiss: () => setStatus(null), 'data-testid': 'deck-composer-status' });
  }, []);

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
      if (propose && applyProposal && deckEditIntent(instruction) === 'operations') {
        const p = await propose(instruction, ctx);
        const outcome = proposalOutcome(p);
        setProposal(prev => (outcome.kind === 'card' ? { key: (prev?.key ?? 0) + 1, value: p } : null));
        show(outcome.status, outcome.kind === 'refused' ? 'danger' : 'info');
        return true;
      }
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
  }, [instruct, onChanged, selectedSlideId, asking, canAsk, onAsk, askUnavailableReason, canInstruct, withReference, propose, applyProposal, show]);

  const apply = useCallback(async (p: DeckOperationsProposal) => {
    if (!applyProposal) return;
    setWorking(true);
    try {
      const result = await applyProposal(p);
      setProposal(null);
      onChanged(result.changedSlideIds ?? []);
      show(result.summary, 'success');
    } catch (err) {
      // A stale head drops the card (the page reloads to the newer version); any other refusal keeps it to retry or discard.
      if (err instanceof Error && err.name === 'DeckRevisionConflictError') setProposal(null);
      show(err instanceof Error ? `The deck was not changed: ${plainDeckRefusal(err.message)}` : 'The deck was not changed.', 'danger');
    } finally {
      setWorking(false);
    }
  }, [applyProposal, onChanged, show]);

  const card = proposal && !asking && !chatting ? (
    <VoiceConfirmCard
      pending={{
        title: proposalTitle(deckTitle), requestId: proposal.key, detail: proposalDetail(proposal.value),
        confirmLabel: 'Apply', cancelLabel: 'Discard', clickOnly: true,
        onConfirm: () => { void apply(proposal.value); },
        onCancel: () => { setProposal(null); show('Discarded; the deck was not changed.', 'info'); },
      }}
      hint="Nothing changes until you click Apply." autoFocus={false}
      data-testid="deck-composer-proposal"
    />
  ) : null;

  const scope = selectedSlideId || generatedSlideTitle ? `slide ${slideNumber ?? ''}`.trim() : 'this presentation';
  const modeRow = chatting ? <Inline gap="xs" wrap={false}><T size="xs" tone="secondary">To:</T><T size="xs" weight="medium">Huddle</T></Inline>
    : canAsk && canInstruct ? <DropdownMenu trigger={<T as="span" size="xs" weight="medium">{asking ? 'Ask' : 'Edit'}</T>}
      triggerLabel="Presentation agent action" triggerVariant="default" sections={[{ items: [
        { label: 'Ask about this presentation', description: 'Explain the selected slide without changing the deck.', active: asking, onSelect: () => { setIntent('ask'); setStatus(null); } },
        { label: 'Edit saved slides', description: 'Change or reword the saved presentation with the agent.', active: !asking, onSelect: () => { setIntent('edit'); setStatus(null); } },
      ] }]} /> : <T as="span" size="xs" tone="secondary">{asking ? 'Ask' : 'Edit'}</T>;

  return (
    <ComposerSurface compact={compactReview} data-review-density={compactReview ? 'compact' : 'comfortable'}>
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
      above={card}
      modeRowStart={modeRow}
      defaultMode="agent"
      onAgent={text => run(text)}
      persistDraft={false}
      // Use the shared document composer and its theme-aware particle dock.
      console={false}
      working={!chatting && working}
      status={chatting ? null : status}
      suggestions={chatting || compactReview ? [] : asking ? ['Summarize this slide', 'Explain the figures', 'What should we discuss next?'] : hints}
      onSuggestion={(suggestion) => { void run(suggestion); }}
      modePlaceholders={{ agent: asking ? `Ask about ${scope}…` : selectedSlideId ? `Tell the agent what to change on slide ${slideNumber ?? ''}…`.replace(' …', '…') : 'Tell the agent what to change across the whole deck…' }}
      presentation={compactReview ? 'compact' : 'document'} {...(compactReview ? { responsive: 'pane' as const } : {})} label="Presentation conversation" inputLabel="Presentation message"
      maxInputHeight={compactReview ? 'min(4rem, 10dvh)' : 'min(8rem, 20dvh)'} className="@container"
      data-testid="deck-composer-dock"
      composerTestId="deck-composer"
    />
    </ComposerSurface>
  );
}

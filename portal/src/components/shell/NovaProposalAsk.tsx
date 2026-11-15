// A proposal, asked in the deck above the footer row (docs/meeting-consent-design.md, "The flow at 1440 px"), beside the budget
// prompt. The rules kept here:
//   - Answers are given here; the card in the call chat shows the proposal and carries the quiet actions (Answer opens this deck,
//     withdrawing an answer, Undo of a dismissal, Raise it again).
//   - One proposal at a time: first those waiting on this person (needed and not yet answered, or theirs to run now), then those
//     where their answer is optional. The footer count is the waiting ones only.
//   - A prompt never interrupts: it arrives without moving keyboard focus (`focusOnArrive: false`, announced politely instead), and
//     its keys act only while focus is in the deck (`keypad: 'deck'`), so a stray digit or Enter on the call never answers.
//   - 1 Consent (the executor's consent runs it only when it is the last one needed: "Consent and record" / "Consent and run"),
//     2 Object… (a one-line reason, labelled as shared before it is sent), 3 "Not a decision" (or "Not needed") on a proposal Nova
//     raised from what it heard, "Drop it" for the asker of one they asked for. Someone not needed is told their answer is optional.
//   - Once everyone needed has consented, the executor is asked "Ready: run it now"; only their click starts it. After a hand-back,
//     the server's `you.canRun` offers "Run it myself" to whoever may take it over.
//   - Esc hides it; the footer count or the card's "Answer" reopens it, and a NEW proposal waiting on this person reopens it too.
//   - Once Nova has left, the footer asks no more: unfinished proposals move to the meeting page, which asks with the same prompt
//     (`inCall: false`) and without the dismiss option, which needs a seat.

import { useEffect, useMemo } from 'react';
import { ComposerPromptDeck, useComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useFetch } from '../../hooks/useFetch';
import { answerProposal, useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  blockedLine, consentLabel, deckQueue, dismissLabel, eyebrowOf, heardText, isNeeded, keptKey, mayTakeOver, needsLine, OBJECTION_SHARED, OPTIONAL_LINE, outcomeLine,
  proposalCountWords, recordsLine, RUN_HERE, RUN_NOW, waitingCount, waitingOnYou, type ProposalView,
} from '../../lib/meetingProposals';
import { assistantPresent } from '../../lib/meetingAssistantModel';
import { keepProposalAnswer, noteWaitingProposals, setProposalDeckHidden, useProposalDeck } from '../../lib/proposalDeckState';
import { useLiveCallId } from '../../lib/liveCallId';

/** The proposals this person's deck would ask about in the live call: those waiting on them first. */
export function useProposalQueue(): { callId: string | null; queue: ProposalView[] } {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { kept } = useProposalDeck(callId);
  const present = assistantPresent(nova.view);
  const queue = useMemo(() => (present ? deckQueue(nova.proposals, kept) : []), [present, nova.proposals, kept]);
  return { callId, queue };
}

/** "1 proposal" on Nova's footer mark: only proposals waiting on this person; it reopens the deck Esc hid. Null at none. */
export function proposalCountOf(queue: readonly ProposalView[]): string | null {
  return proposalCountWords(waitingCount(queue));
}

const reply = (error: string | null, receipt: string) => (error ? { error } : { receipt });

export interface ProposalPromptOptions {
  /** In the call (the footer deck) or after it (the meeting page): dismissing needs a seat, so only in the call. */
  inCall: boolean;
  /** "Not now" / "Skip": remembered so the queue moves on. */
  keep: (key: string) => void;
  scope: string;
}

/** The deck prompt for one proposal, for the footer deck in the call and for the meeting page after it. */
export function proposalPrompt(callId: string, p: ProposalView, initiativeName: string | null, opts: ProposalPromptOptions): ComposerPrompt {
  const { scope } = opts;
  const outcome = outcomeLine(p.outcome, initiativeName);
  const heard = p.heard.at(-1);
  const fields = [{ label: 'Outcome', value: outcome }, ...(heard ? [{ label: 'Heard', value: heardText(heard) }] : [])];
  const base = { scope, eyebrow: eyebrowOf(p), title: p.statement, keypad: 'deck' as const, focusOnArrive: false };

  if (p.state === 'consented' && p.you.canRun) {
    // The executor's own click is the last step; after a hand-back, whoever the server allows may run it instead.
    const takeOver = mayTakeOver(p);
    const question = !takeOver ? (p.run?.note ? `${p.run.note} Ready: run it now.` : 'Everyone needed has consented. Ready: run it now.')
      : p.you.response === 'consent' ? `${p.run?.note ?? `${p.executor.name} cannot run it now.`} You consented, so you can run it yourself.`
        : `${p.run?.note ?? `${p.executor.name} cannot run it now.`} You can consent and run it yourself.`;
    return {
      ...base, id: `${scope}:${p.id}:run-${p.run?.at ?? 0}`, kind: 'choice', question, fields,
      options: [
        { id: 'run', label: takeOver ? (p.you.response === 'consent' ? RUN_HERE : 'Consent and run it myself') : RUN_NOW, emphasis: 'primary' },
        { id: 'later', label: 'Not now' },
      ],
      onAnswer: async (a) => {
        const choice = 'optionId' in a ? a.optionId : null;
        if (choice !== 'run') { opts.keep(keptKey(p)); return { receipt: 'Not now' }; }
        return reply(await answerProposal(callId, p.id, 'consent', undefined, { asExecutor: true }), 'Running it');
      },
    };
  }

  if (p.you.response !== null) {
    // Answered ones are not queued (withdrawing is on the card); a host that asks anyway gets the quiet withdraw question.
    return {
      ...base, id: `${scope}:${p.id}:answered-${p.you.response}`, kind: 'choice', fields,
      question: p.you.response === 'consent' ? 'You consented. You can withdraw it until it runs.' : 'You objected. Withdrawing reopens it.',
      options: [{ id: 'withdraw', label: p.you.response === 'consent' ? 'Withdraw consent' : 'Withdraw objection' }, { id: 'keep', label: 'Keep my answer', emphasis: 'primary' }],
      onAnswer: async (a) => {
        if (!('optionId' in a) || a.optionId !== 'withdraw') { opts.keep(keptKey(p)); return { receipt: 'Kept' }; }
        return reply(await answerProposal(callId, p.id, 'withdraw'), 'Withdrawn');
      },
    };
  }

  const object: ComposerPrompt = {
    ...base, id: `${scope}:${p.id}:object`, kind: 'text', question: OBJECTION_SHARED, placeholder: 'Your reason, in one line', fields,
    onAnswer: async (a) => {
      const reason = a.kind === 'text' ? a.text.trim() : '';
      if (!reason) return { error: 'Say why in one line.' };
      return reply(await answerProposal(callId, p.id, 'object', reason), 'Objected');
    },
  };
  const needed = isNeeded(p);
  const question = [`${outcome}.`, blockedLine(p) ?? needsLine(p), recordsLine(p), needed ? null : OPTIONAL_LINE].filter(Boolean).join(' ');
  const dismiss = opts.inCall && p.you.canDismiss ? [{ id: 'dismiss', label: dismissLabel(p) }] : [];
  return {
    ...base, id: `${scope}:${p.id}:ask`, kind: 'choice', question,
    ...(heard ? { fields: [{ label: 'Heard', value: heardText(heard) }] } : {}),
    options: [
      { id: 'consent', label: consentLabel(p), emphasis: 'primary' },
      { id: 'object', label: 'Object…' },
      ...dismiss,
      ...(needed ? [] : [{ id: 'skip', label: 'Skip' }]),
    ],
    onAnswer: async (a) => {
      const choice = 'optionId' in a ? a.optionId : null;
      if (choice === 'object') return { next: object };
      if (choice === 'skip') { opts.keep(keptKey(p)); return { receipt: 'Skipped' }; }
      if (choice === 'dismiss') return reply(await answerProposal(callId, p.id, 'not-a-decision'), p.source === 'asked' ? 'Dropped' : 'Marked not a decision');
      return reply(await answerProposal(callId, p.id, 'consent'), 'Consented');
    },
  };
}

export function NovaProposalAsk() {
  const { callId, queue } = useProposalQueue();
  const { hidden } = useProposalDeck(callId);
  const head = queue[0] ?? null;
  const initiativeId = head?.outcome.kind === 'decision' ? head.outcome.initiativeId : null;
  const named = useFetch<{ name?: string }>(initiativeId ? `/api/graph/projects/${encodeURIComponent(initiativeId)}` : null);
  const initiativeName = named.data?.name?.trim() || null;
  const prompts = useMemo<ComposerPrompt[]>(() => (callId && head
    ? [proposalPrompt(callId, head, initiativeName, { inCall: true, scope: `nova-proposal:${callId}`, keep: (key) => keepProposalAnswer(callId, key) })] : []), [callId, head, initiativeName]);
  const deck = useComposerPromptDeck(prompts, { scope: callId ? `nova-proposal:${callId}` : null });
  // A new proposal waiting on this person shows the deck again, even after Esc (without taking focus).
  const waitingIds = queue.filter(waitingOnYou).map((p) => p.id).join(' ');
  useEffect(() => { if (callId && waitingIds) noteWaitingProposals(callId, waitingIds.split(' ')); }, [callId, waitingIds]);
  // Esc collapses the deck; here that hides it, and the footer count or the card's Answer is the way back.
  useEffect(() => { if (callId && deck.collapsed && deck.active) setProposalDeckHidden(callId, true); }, [callId, deck.collapsed, deck.active]);
  useEffect(() => { if (!hidden && deck.collapsed) deck.setCollapsed(false); }, [hidden, deck]);
  // Only a question is drawn: the card in the chat already shows what an answer changed, so no receipt row stays behind.
  if (!callId || !deck.active || deck.collapsed || hidden) return null;
  return <ComposerPromptDeck deck={deck} className="mx-4 my-1" data-testid="nova-proposal-ask" />;
}

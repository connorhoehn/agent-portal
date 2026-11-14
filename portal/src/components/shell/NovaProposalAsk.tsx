// A proposal Nova noticed, asked in the deck above the footer row (docs/meeting-consent-design.md, "The flow at 1440 px"), beside
// the budget prompt. The rules kept here:
//   - Answers are given only here; the card in the call chat shows and never asks.
//   - One proposal at a time, oldest first: first those still waiting for this person, then those they answered (to withdraw).
//   - 1 Consent (the executor's consent is the one that records or runs it), 2 Object… (a one-line reason, labelled as shared with
//     everyone in the call before it is sent), 3 Not a decision. Digits work from anywhere on the page outside a text field.
//   - Esc hides it; the count on Nova's footer mark reopens it. The server judges every answer; a refusal shows on the card.
//   - A consenter who is not the executor is offered "Run it in my browser" while it waits consented (the server's `you.canRun`);
//     choosing it consents again as executor, so the run moves to their browser.
//   - Once Nova has left, the footer asks no more: unfinished proposals move to the meeting page, which asks with the same prompt
//     (`inCall: false`) and without "Not a decision", which needs a seat. One place asks at a time, so a digit answers once.

import { useEffect, useMemo } from 'react';
import { ComposerPromptDeck, useComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useFetch } from '../../hooks/useFetch';
import { answerProposal, useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  consentLabel, deckQueue, keptKey, mayTakeOver, needsLine, OBJECTION_SHARED, outcomeLine, proposalCountWords, RUN_HERE, type ProposalView,
} from '../../lib/meetingProposals';
import { assistantPresent } from '../../lib/meetingAssistantModel';
import { keepProposalAnswer, setProposalDeckHidden, useProposalDeck } from '../../lib/proposalDeckState';
import { useLiveCallId } from '../../lib/liveCallId';

const EYEBROW = 'Nova · Proposal';

/** The proposals this person's deck would ask about in the live call, oldest first. */
export function useProposalQueue(): { callId: string | null; queue: ProposalView[] } {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { kept } = useProposalDeck(callId);
  const present = assistantPresent(nova.view);
  const queue = useMemo(() => (present ? deckQueue(nova.proposals, kept) : []), [present, nova.proposals, kept]);
  return { callId, queue };
}

/** "1 proposal" on Nova's footer mark: reopens the deck prompt Esc hid. Nothing while there is nothing to answer. */
export function proposalCountOf(queue: readonly ProposalView[]): string | null {
  return proposalCountWords(queue.length);
}

const reply = (error: string | null, receipt: string) => (error ? { error } : { receipt });

export interface ProposalPromptOptions {
  /** In the call (the footer deck) or after it (the meeting page): "Not a decision" needs a seat, so only in the call. */
  inCall: boolean;
  /** "Keep my answer": remembered so the queue moves on. */
  keep: (key: string) => void;
  scope: string;
}

/** The deck prompt for one proposal, for the footer deck in the call and for the meeting page after it. */
export function proposalPrompt(callId: string, p: ProposalView, initiativeName: string | null, opts: ProposalPromptOptions): ComposerPrompt {
  const { scope } = opts;
  const outcome = outcomeLine(p.outcome, initiativeName);
  const base = { scope, eyebrow: EYEBROW, title: p.statement, keypad: 'page' as const };
  if (p.you.response !== null) {
    const objection = p.responses.find((r) => r.userId === p.you.userId && r.response === 'object');
    const takeOver = p.you.response === 'consent' && mayTakeOver(p);
    const question = p.you.response === 'consent'
      ? takeOver ? `${p.run?.note ?? `It is waiting for ${p.executor.name} to run it.`} You consented, so you can run it in your browser.` : 'You consented. You can withdraw it until it runs.'
      : `You objected${objection?.reason ? `: ${objection.reason}` : ''}. Withdrawing reopens it.`;
    return {
      ...base, // Its own id: the objection's reason prompt is `:object`, and a reused id would read as already answered.
      id: `${scope}:${p.id}:answered-${p.you.response}${takeOver ? `-run-${p.run?.at ?? 0}` : ''}`, kind: 'choice', question,
      fields: [{ label: 'Outcome', value: outcome }],
      options: [
        { id: 'withdraw', label: p.you.response === 'consent' ? 'Withdraw consent' : 'Withdraw objection' },
        takeOver ? { id: 'keep', label: 'Keep my answer' } : { id: 'keep', label: 'Keep my answer', emphasis: 'primary' as const },
        ...(takeOver ? [{ id: 'run-here', label: RUN_HERE, emphasis: 'primary' as const }] : []),
      ],
      onAnswer: async (a) => {
        const choice = 'optionId' in a ? a.optionId : null;
        if (choice === 'run-here') return reply(await answerProposal(callId, p.id, 'consent', undefined, { asExecutor: true }), 'Running in your browser');
        if (choice !== 'withdraw') { opts.keep(keptKey(p)); return { receipt: 'Kept' }; }
        return reply(await answerProposal(callId, p.id, 'withdraw'), 'Withdrawn');
      },
    };
  }
  const object: ComposerPrompt = {
    ...base, id: `${scope}:${p.id}:object`, kind: 'text', question: OBJECTION_SHARED, placeholder: 'Your reason, in one line',
    fields: [{ label: 'Outcome', value: outcome }],
    onAnswer: async (a) => {
      const reason = a.kind === 'text' ? a.text.trim() : '';
      if (!reason) return { error: 'Say why in one line.' };
      return reply(await answerProposal(callId, p.id, 'object', reason), 'Objected');
    },
  };
  const needs = needsLine(p);
  return {
    ...base, id: `${scope}:${p.id}:ask`, kind: 'choice', question: needs ? `${outcome}. ${needs}` : `${outcome}.`,
    options: [
      { id: 'consent', label: consentLabel(p), emphasis: 'primary' },
      { id: 'object', label: 'Object…' },
      ...(opts.inCall ? [{ id: 'not-a-decision', label: 'Not a decision' }] : []),
    ],
    onAnswer: async (a) => {
      const choice = 'optionId' in a ? a.optionId : null;
      if (choice === 'object') return { next: object };
      if (choice === 'not-a-decision') return reply(await answerProposal(callId, p.id, 'not-a-decision'), 'Marked not a decision');
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
  // Esc collapses the deck; here that hides it, and the footer count is the way back.
  useEffect(() => { if (callId && deck.collapsed && deck.active) setProposalDeckHidden(callId, true); }, [callId, deck.collapsed, deck.active]);
  useEffect(() => { if (!hidden && deck.collapsed) deck.setCollapsed(false); }, [hidden, deck]);
  // Only a question is drawn: the card in the chat already shows what an answer changed, so no receipt row stays behind.
  if (!callId || !deck.active || deck.collapsed || hidden) return null;
  return <ComposerPromptDeck deck={deck} className="mx-4 my-1" data-testid="nova-proposal-ask" />;
}

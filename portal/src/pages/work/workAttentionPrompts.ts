// What needs a person on the Automate inbox, as the docked composer's prompt
// deck (ui-components ComposerPromptDeck): agent questions first (a RUNNING
// computer blocked on a person), then finished work awaiting review, then
// proposed graph changes. One prompt per item, paged with the keyboard; the
// answers call the page's existing write handlers — the deck never posts.
// Pure: every rule here is a node test.
import type { ComposerPrompt, ComposerPromptResult } from '@connorhoehn/ui-components/social/rich-composer';
import type { Job, LabConsult, Proposal } from './workShared';

export interface AttentionHandlers {
  answerConsult(id: string, answer: string): Promise<void>;
  reviewJob(job: Job, decision: 'accept' | 'reject'): Promise<void>;
  decideProposal(p: Proposal, decision: 'approve' | 'reject'): Promise<void>;
}

/** Why a consult's Answer is off (ui-components 2.515.6 `ComposerPrompt.disabledReason`): drawn, not hidden. */
export const ANSWER_ROLE_REASON = 'Your role cannot answer agent questions: answering directs a running agent (Dispatch agent runs).';
export const ANSWER_NOT_WAITING: Record<Exclude<LabConsult['status'], 'pending'>, string> = {
  answered: 'No question is waiting: this one was already answered.',
  expired: 'No question is waiting: this one expired before an answer.',
  withdrawn: 'No question is waiting: the agent withdrew it.',
};
const REVIEW_READ_ONLY = 'Your access allows you to read this review, but not decide it.';

/** How many items wait on a person. */
export function attentionCount(consults: readonly LabConsult[], jobs: readonly Job[], proposals: readonly Proposal[]): number {
  return consults.length + jobs.filter((j) => j.status === 'awaiting_review').length + proposals.length;
}

const done = async (run: () => Promise<void>): Promise<ComposerPromptResult> => {
  try { await run(); return undefined; } catch (err) { return { error: (err as Error).message || 'The answer could not be saved.' }; }
};

/**
 * Why this reader cannot answer this agent question, or null when they can.
 * An empty answer box is not a reason. ("Not your item" has no rule: a consult
 * carries no owner, and anyone who may dispatch runs may answer it.)
 */
export function consultAnswerReason(consult: Pick<LabConsult, 'status'>, canAnswer: boolean): string | null {
  if (consult.status !== 'pending') return ANSWER_NOT_WAITING[consult.status];
  if (!canAnswer) return ANSWER_ROLE_REASON;
  return null;
}
const withReason = (reason: string | null) => reason ? { disabledReason: reason } : {};

export function attentionPrompts(
  { consults, jobs, proposals, canAnswerConsults, canReview, money, label }: {
    consults: readonly LabConsult[]; jobs: readonly Job[]; proposals: readonly Proposal[]; canAnswerConsults: boolean; canReview: boolean;
    money: (usd: number | undefined) => string; label: (kind: string) => string;
  },
  handlers: AttentionHandlers,
): ComposerPrompt[] {
  const reviewAccess = canReview ? {} : { readOnlyReason: REVIEW_READ_ONLY };
  const out: ComposerPrompt[] = [];
  for (const c of consults) out.push({
    id: `consult:${c.id}`, eyebrow: 'Agent question', title: c.repo ?? 'A running agent', question: c.question, kind: 'text',
    placeholder: 'Type the answer the agent should act on…',
    fields: [
      ...(c.context ? [{ label: 'Context', value: c.context }] : []),
      ...(c.repo ? [{ label: 'Repo', value: c.repo, mono: true }] : []),
      ...(c.boxId ? [{ label: 'Box', value: c.boxId, mono: true }] : []),
    ],
    ...withReason(consultAnswerReason(c, canAnswerConsults)),
    onAnswer: (answer) => answer.kind === 'text' ? done(() => handlers.answerConsult(c.id, answer.text)) : { error: 'Type an answer.' },
  });
  for (const j of jobs.filter((x) => x.status === 'awaiting_review')) out.push({
    id: `review:${j.id}`, eyebrow: 'Finished work to review', title: j.title, question: 'Accept this work?', kind: 'choice',
    options: [{ id: 'accept', label: 'Accept', emphasis: 'primary' }, { id: 'reject', label: 'Reject', emphasis: 'danger' }],
    fields: [
      { label: 'Summary', value: j.result?.summary ?? 'No summary reported.' },
      ...(j.payload?.workItemTitle ? [{ label: 'Serves', value: [j.payload.workItemTitle, j.payload.initiativeName].filter(Boolean).join(' · ') }] : []),
      { label: 'Cost', value: money(j.result?.costUsd) },
    ],
    ...reviewAccess,
    onAnswer: (answer) => answer.kind === 'choice' && (answer.optionId === 'accept' || answer.optionId === 'reject')
      ? done(() => handlers.reviewJob(j, answer.optionId as 'accept' | 'reject')) : { error: 'Pick Accept or Reject.' },
  });
  for (const p of proposals) out.push({
    id: `proposal:${p.id}`, eyebrow: `Proposed graph change for ${p.targetId}`, title: label(p.kind), question: 'Apply this change to the graph?', kind: 'choice',
    options: [{ id: 'approve', label: 'Approve', emphasis: 'primary' }, { id: 'reject', label: 'Reject', emphasis: 'danger' }],
    fields: [
      ...(p.rationale ? [{ label: 'Why', value: p.rationale }] : []),
      ...(typeof p.evidence?.['quote'] === 'string' ? [{ label: 'Quote', value: `“${String(p.evidence['quote'])}”` }] : []),
      { label: 'Source', value: p.source, mono: true },
      ...(p.confidence != null ? [{ label: 'Confidence', value: `${(p.confidence * 100).toFixed(0)}%` }] : []),
    ],
    ...reviewAccess,
    onAnswer: (answer) => answer.kind === 'choice' && (answer.optionId === 'approve' || answer.optionId === 'reject')
      ? done(() => handlers.decideProposal(p, answer.optionId as 'approve' | 'reject')) : { error: 'Pick Approve or Reject.' },
  });
  return out;
}

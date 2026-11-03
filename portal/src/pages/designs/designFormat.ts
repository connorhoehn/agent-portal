// Pure derivations for the design-review pages. No React — testable under
// node:test like the other format modules.

import type { DesignPost, DesignReview, DesignSignoff, DesignStatus, PostKind } from './types';

/** Resolve only the recorded identity. Legacy snapshots can display their own
 * photo, but a name alone never borrows an identified contributor's portrait. */
export function designParticipantPortrait(
  name: string,
  thread: {
    posts: Pick<DesignPost, 'authorKind' | 'authorName' | 'authorId' | 'avatarUrl'>[];
    signoffs: Pick<DesignSignoff, 'personName' | 'signerId' | 'avatarUrl'>[];
  },
  contributors: Array<{ personId?: string; name: string; avatarUrl?: string | null }>,
  identity?: string,
): string | undefined {
  const snapshots = [...thread.posts.filter(p => p.authorKind === 'human' && (identity ? p.authorId === identity : !p.authorId && p.authorName === name)),
    ...thread.signoffs.filter(s => identity ? s.signerId === identity : !s.signerId && s.personName === name)].filter(p => p.avatarUrl !== undefined);
  if (snapshots.length) {
    const urls = new Set(snapshots.map(p => p.avatarUrl ?? null));
    return urls.size === 1 ? snapshots[0]?.avatarUrl ?? undefined : undefined;
  }
  return identity ? contributors.find(person => person.personId === identity)?.avatarUrl ?? undefined : undefined;
}

export function designParticipants(posts: DesignPost[]): DesignPost[] {
  const people = new Map<string, DesignPost>();
  for (const post of posts) people.set(`${post.authorKind}:${post.authorId ?? `legacy:${post.authorName}`}`, post);
  return [...people.values()];
}

export const STATUS_LABEL: Record<DesignStatus, string> = {
  ideating: 'Ideating',
  awaiting_input: 'Needs input',
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

export const STATUS_TONE: Record<DesignStatus, 'info' | 'warning' | 'accent' | 'success' | 'danger' | 'neutral'> = {
  ideating: 'info',
  awaiting_input: 'warning',
  proposed: 'accent',
  approved: 'success',
  rejected: 'danger',
  superseded: 'neutral',
};

export const KIND_LABEL: Record<PostKind, string> = {
  problem: 'problem statement',
  analysis: 'analysis',
  option: 'options',
  question: 'question',
  answer: 'answer',
  artifact: 'artifact',
  revision: 'revision',
  decision: 'decision',
};

export const KIND_TONE: Record<PostKind, 'info' | 'warning' | 'success' | 'accent' | 'purple' | 'neutral'> = {
  problem: 'info',
  analysis: 'neutral',
  option: 'info',
  question: 'warning',
  answer: 'success',
  artifact: 'purple',
  revision: 'info',
  decision: 'accent',
};

/** "2 of 3 approvals · 1 open question" — the list row's one-line state. */
export function reviewStateLine(r: DesignReview, approvalsRequired = 2): string {
  if (r.status === 'approved') {
    return `${latestSignoffs(r.signoffs).filter((s) => s.signerId && s.decision === 'approve').length} sign-offs${r.kbSynced ? ' · in the knowledge base' : ''}`;
  }
  if (r.openQuestions > 0) {
    return `${r.openQuestions} question${r.openQuestions === 1 ? '' : 's'} waiting on a human`;
  }
  if (r.status === 'proposed') {
    const have = latestSignoffs(r.signoffs).filter((s) => s.signerId && s.decision === 'approve').length;
    return `${have}/${approvalsRequired} sign-offs`;
  }
  return `${r.postCount} post${r.postCount === 1 ? '' : 's'}`;
}

/** The Status filter row's predicate — `'all'` keeps everything, any other
 *  value keeps only reviews whose status matches exactly. Pulled out pure so
 *  the filter row's wiring can be tested without mounting the page — the bug
 *  this exists to catch shipped as a filter row that rendered `aria-pressed`
 *  correctly but never touched the list at all. */
export function filterDesigns(reviews: DesignReview[], status: string): DesignReview[] {
  return status === 'all' ? reviews : reviews.filter((r) => r.status === status);
}

/** Standing decision per person, latest wins — mirrors the server's tally. */
export function latestSignoffs(signoffs: DesignSignoff[]): DesignSignoff[] {
  const latest = new Map<string, DesignSignoff>();
  for (const s of signoffs) latest.set(s.signerId ? `id:${s.signerId}` : `legacy:${s.personName}`, s);
  return [...latest.values()];
}

/** The one line that says what happens next — the summary band's verdict.
 *  `canAnswer` is the viewer's own `DispatchAgentRun` capability — the answer
 *  control in `DesignThreadPage` only mounts for that capability, so telling
 *  every other viewer to "👉 Answer …" pointed at a control they can't see
 *  (DEFECTS.md #12). Defaults to `true` so existing callers keep today's
 *  wording until they pass the viewer's capability explicitly. */
export function nextStep(
  r: Pick<DesignReview, 'status' | 'openQuestions' | 'signoffs'>,
  approvalsRequired = 2,
  canAnswer = true,
): string {
  switch (r.status) {
    case 'awaiting_input': {
      const questionWord = r.openQuestions === 1 ? 'open question' : `${r.openQuestions} open questions`;
      return canAnswer
        ? `Answer the ${questionWord} below — the agents continue from your answer.`
        : `An owner or SME will answer the ${questionWord} below.`;
    }
    case 'proposed': {
      const have = latestSignoffs(r.signoffs).filter((s) => s.signerId && s.decision === 'approve').length;
      const need = Math.max(approvalsRequired - have, 0);
      return need > 0
        ? `Decision proposed — ${need} more sign-off${need === 1 ? '' : 's'} ratifies it and logs it to the knowledge base.`
        : 'Decision ratified — finalizing.';
    }
    case 'approved':
      return 'Approved and logged — this ADR now binds the designs built on it.';
    case 'rejected':
      return 'Rejected — a new thread supersedes this direction.';
    case 'superseded':
      return 'Superseded — see the successor design.';
    default:
      return 'Agents are iterating — nothing needs you yet.';
  }
}

/** Where design reviews are read from, as the clause UnavailableNotice joins
 *  to "…, so this is unknown rather than empty." — not a bare noun. */
export const DESIGNS_SOURCE = 'The design review service is unavailable';

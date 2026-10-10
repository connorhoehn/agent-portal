// Pure derivations for the promotions inbox. No React — testable under
// node:test like the other format modules.

import type { PromotionCandidate, PromotionStatus, ProposedKind } from './types';

export const PROPOSED_LABEL: Record<ProposedKind, string> = {
  insight: 'Insight',
  runbook: 'Runbook',
  skill: 'Skill',
};

/** Mirrors libraryFormat's KIND_TONE — insight/skill read the same here as
 *  they will once they land in the library, so the inbox does not teach a
 *  second color vocabulary the reader has to unlearn on arrival. */
export const KIND_TONE: Record<ProposedKind, 'success' | 'info' | 'purple'> = {
  insight: 'success',
  runbook: 'info',
  skill: 'purple',
};

export const STATUS_LABEL: Record<PromotionStatus, string> = {
  candidate: 'Candidate',
  approved: 'Approved',
  dismissed: 'Dismissed',
  promoted: 'Promoted',
};

export const STATUS_TONE: Record<PromotionStatus, 'neutral' | 'warning' | 'danger' | 'success'> = {
  candidate: 'neutral',
  approved: 'warning',
  dismissed: 'danger',
  promoted: 'success',
};

/** Chip tone → StatusPill state: a straight rename of the same four buckets,
 *  not a second judgment. `STATUS_PILL_STATE` used to be its own parallel
 *  table and disagreed with `STATUS_TONE` on `approved` (warning vs the
 *  StatusPill-only 'pending') — the row's Chip and the drawer's header badge
 *  read different colours for the exact same status. Deriving one from the
 *  other makes that impossible. */
const CHIP_TONE_TO_PILL_STATE: Record<'neutral' | 'warning' | 'danger' | 'success', 'neutral' | 'warning' | 'error' | 'success'> = {
  neutral: 'neutral',
  warning: 'warning',
  danger: 'error',
  success: 'success',
};

/** Same statuses, mapped to the library StatusPill's own state vocabulary —
 *  used for the drawer's header badge, which is the one place a reader
 *  checks "did my click actually land" after Approve/Dismiss. */
export const STATUS_PILL_STATE: Record<PromotionStatus, 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'pending'> =
  Object.fromEntries(
    Object.entries(STATUS_TONE).map(([status, tone]) => [status, CHIP_TONE_TO_PILL_STATE[tone]]),
  ) as Record<PromotionStatus, 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'pending'>;

export function isTerminalStatus(status: PromotionStatus): boolean {
  return status === 'promoted' || status === 'dismissed';
}

export type PromoteIntent = 'approve' | 'promote';

export interface PrimaryAction {
  /** What the click asks the server for — the same POST either way, but the
   *  page reports a recorded approval differently from a promotion. */
  intent: PromoteIntent;
  label: string;
  /** The button's tooltip: what the click will and will not do. */
  hint?: string;
}

export interface AllowedActions {
  /** The one approve/promote button, or null when there is nothing to ask. */
  primary: PrimaryAction | null;
  canDismiss: boolean;
}

/**
 * Which drawer actions are worth showing right now, labelled for what the
 * server's `decidePromotion` gate (middleware/src/providers/promotions.ts)
 * will actually do with the click.
 *
 * A skill graduates only on a completed dry-run RUN of its own runbook
 * definition — a client cannot assert one, so there is no "record a passing
 * dry run" button (that label once promised exactly that and recorded only
 * the approval, sme DEFECTS #19). What a reviewer here CAN do for an unready
 * skill is record the human half: the server keeps that approval even while
 * it refuses promotion for the missing run, so the button says "Record
 * approval". Once approved, "Promote" re-asks the gate, which looks for the
 * newest completed dry-run itself — one may have finished since this
 * candidate was read.
 */
export function allowedActions(c: Pick<PromotionCandidate, 'status' | 'proposedKind' | 'dryRunPassed'>): AllowedActions {
  if (isTerminalStatus(c.status)) return { primary: null, canDismiss: false };
  if (c.proposedKind === 'skill' && c.dryRunPassed !== true) {
    return {
      primary: c.status === 'candidate'
        ? { intent: 'approve', label: 'Record approval', hint: 'Records your approval. Promotion also needs a completed dry-run of this runbook; the approval is kept until one is recorded.' }
        : { intent: 'promote', label: 'Promote', hint: 'Promotes only if a completed dry-run of this runbook is recorded; otherwise the reason is shown and the approval stays.' },
      canDismiss: true,
    };
  }
  return { primary: { intent: 'promote', label: 'Promote' }, canDismiss: true };
}

/** The Status filter row's predicate — `'all'` keeps everything, any other
 *  value keeps only candidates whose status matches exactly. Pulled out pure
 *  (same shape as `designs/designFormat.ts`'s `filterDesigns`) so the filter
 *  row's wiring is covered by a test instead of only by eyes on a click. */
export function filterPromotions(candidates: PromotionCandidate[], status: string): PromotionCandidate[] {
  return status === 'all' ? candidates : candidates.filter((c) => c.status === status);
}

/** "11 observations across 6 sessions" — the whole basis for trusting the
 *  cluster, in one line. Singular forms matter here: a pattern can legitimately
 *  sit at the floor (3 observations, 2 sessions). */
export function supportLine(c: Pick<PromotionCandidate, 'supportCount' | 'sessionCount'>): string {
  const obs = `${c.supportCount} observation${c.supportCount === 1 ? '' : 's'}`;
  const sess = `${c.sessionCount} session${c.sessionCount === 1 ? '' : 's'}`;
  return `${obs} across ${sess}`;
}

/** Would clicking Promote right now actually complete the graduation, or
 *  just record approval and wait? A skill with no passing dry run is the one
 *  case those two things differ — mirrors decidePromotion's skill branch
 *  without needing the server's approvedBy, because the click itself is the
 *  approval. */
export function readyToPromote(c: Pick<PromotionCandidate, 'status' | 'proposedKind' | 'dryRunPassed'>): boolean {
  if (c.status === 'promoted' || c.status === 'dismissed') return false;
  if (c.proposedKind === 'skill') return c.dryRunPassed === true;
  return true;
}

/** The one line that says what happens next — mirrors designFormat's
 *  nextStep, same job: tell the reader what THEY do, not what the record
 *  says about itself. */
export function nextStep(c: Pick<PromotionCandidate, 'status' | 'proposedKind' | 'dryRunPassed' | 'driftedFrom'>): string {
  if (c.status === 'dismissed') return 'Dismissed — not going forward.';
  if (c.status === 'promoted') {
    return c.proposedKind === 'skill'
      ? 'Promoted — review release readiness in Agent library before enabling execution.'
      : `Promoted — approved for Agent library as ${c.proposedKind === 'insight' ? 'an insight' : 'a runbook'}.`;
  }
  if (c.driftedFrom && c.status === 'candidate') {
    return 'Sent back from a skill by drift detection — review what changed before re-promoting.';
  }
  if (c.proposedKind !== 'skill') {
    return `Approve to promote — ${PROPOSED_LABEL[c.proposedKind].toLowerCase()}s need no dry run.`;
  }
  if (c.dryRunPassed === false) return 'Dry run failed — fix the procedure and rerun before promoting.';
  if (c.dryRunPassed === true) return 'Dry run passed — promote to ship it as a skill.';
  return c.status === 'approved'
    ? 'Approved — promotion waits for a completed dry-run of this runbook.'
    : 'Record approval — a skill also needs a completed dry-run of its runbook before promotion.';
}

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

export interface AllowedActions {
  /** The plain Approve/Promote button. */
  canApprove: boolean;
  /** "Approve + record a passing dry run" — the one-shot skill path. */
  canApproveWithDryRun: boolean;
  canDismiss: boolean;
}

/**
 * Which drawer actions are worth showing right now — mirrors the server's
 * `decidePromotion` gate (middleware/src/providers/promotions.ts) so the UI
 * never presents a button whose click is guaranteed to 409. A skill with no
 * passing dry run fails that gate on a plain Approve every time, but the
 * mock provider still flips status candidate→approved as a side effect of
 * the failed call — which is exactly how DEFECTS.md #1 happened: a plain
 * "Approve" button sat there looking clickable, always 409'd, and silently
 * mutated status underneath the stale drawer. The fix is to never show that
 * button for an unready skill in the first place; only the dry-run-carrying
 * action can actually clear the gate.
 */
export function allowedActions(c: Pick<PromotionCandidate, 'status' | 'proposedKind' | 'dryRunPassed'>): AllowedActions {
  if (isTerminalStatus(c.status)) {
    return { canApprove: false, canApproveWithDryRun: false, canDismiss: false };
  }
  if (c.proposedKind === 'skill' && c.dryRunPassed !== true) {
    return { canApprove: false, canApproveWithDryRun: true, canDismiss: true };
  }
  return { canApprove: true, canApproveWithDryRun: false, canDismiss: true };
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
    ? 'Approved — waiting on a passing dry run before promotion.'
    : 'Approve, then run a dry run — a skill needs both before promotion.';
}

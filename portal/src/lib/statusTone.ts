// One tone/label per status concept, so the same job, severity, bot or
// presence reads the same colour everywhere it appears. A consistency audit
// found several of these maps duplicated — sometimes verbatim, sometimes
// disagreeing — across the Automate, observability, bots and local-compute
// surfaces. Pure, no React, so every mapping here is unit-tested directly
// (see __tests__/statusTone.test.ts) rather than only exercised through a
// rendered Chip.

import type { ChipTone } from '@connorhoehn/ui-components/shared';

// ─── Run / job state ─────────────────────────────────────────────────────────
//
// Canonical source: pages/work/workShared.tsx's STATUS_CHIP — the work lane
// owns job state, and it was already the majority definition.
// pages/local-compute/localComputeFormat.ts disagreed on two states:
//   running:         read 'info' there,  now reads the same loud/solid
//                     accent tone as the work lane — the state that's
//                     actually in flight right now should read louder than
//                     everything merely queued.
//   awaiting_review:  read 'info' there,  now reads 'warning' — it is a
//                     state that needs someone's attention, not a neutral
//                     status update.
// Both are visible colour changes on the Local Compute pages' job tables.

export type RunState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting_review'
  | 'waiting-approval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface RunStateChip {
  tone: ChipTone;
  label: string;
  solid?: boolean;
}

const RUN_STATE_CHIP: Record<RunState, RunStateChip> = {
  queued: { tone: 'neutral', label: 'queued' },
  claimed: { tone: 'accent', label: 'claimed' },
  running: { tone: 'accent', label: 'running', solid: true },
  awaiting_review: { tone: 'warning', label: 'awaiting review' },
  'waiting-approval': { tone: 'warning', label: 'waiting for approval' },
  done: { tone: 'success', label: 'done' },
  failed: { tone: 'danger', label: 'failed' },
  cancelled: { tone: 'neutral', label: 'cancelled' },
  skipped: { tone: 'neutral', label: 'skipped' },
};

/** Tone + display label for a job/run status string. Unknown statuses fall
 *  back to a neutral chip labelled with the raw (space-separated) status
 *  rather than throwing or rendering blank. */
export function runStateChip(state: string): RunStateChip {
  const known = RUN_STATE_CHIP[state as RunState];
  if (known) return known;
  return { tone: 'neutral', label: state.replace(/_/g, ' ') };
}

// ─── Severity ─────────────────────────────────────────────────────────────────
//
// Canonical source: pages/work/workShared.tsx's SEVERITY_TONE
// (critical/warning/info). Folded in alongside it: OnCallPage's three inline
// maps (alarm severity adds 'ok'/'unknown'; event severity is
// critical/warning/info) and GuardrailRuleBadge's HIGH/MEDIUM/LOW scale.
// Matching is case-insensitive so both vocabularies resolve through the same
// table without each call site re-lowercasing first.
const SEVERITY_TONE: Record<string, ChipTone> = {
  critical: 'danger',
  high: 'danger',
  warning: 'warning',
  medium: 'warning',
  info: 'neutral',
  low: 'neutral',
  unknown: 'neutral',
  ok: 'success',
  success: 'success',
};

/** Tone for a severity value from any of the app's severity vocabularies
 *  (critical/warning/info/ok/unknown, or HIGH/MEDIUM/LOW). Null/undefined
 *  and anything unrecognized read neutral — the same "say nothing alarming"
 *  default OnCallPage's guardrail badge already used for a missing severity. */
export function severityTone(severity: string | null | undefined): ChipTone {
  if (!severity) return 'neutral';
  return SEVERITY_TONE[severity.toLowerCase()] ?? 'neutral';
}

// ─── Bot status ───────────────────────────────────────────────────────────────
//
// Canonical shape: BotsPage.tsx and BotDetailPage.tsx already agreed
// (paused → warning, else → success "enabled"). QueuePulse.tsx adds a third,
// live-only state: a bot that is not paused but isn't pulling a job *right
// now* reads 'idle' (neutral), not the evergreen green "enabled". The same
// bot therefore reads green on the roster and grey on the queue pulse — that
// is not a bug, it is two different questions ("is this bot on?" vs "is this
// bot doing something at this instant?") that only QueuePulse has the live
// signal to answer. Passing `isPulling` opts into the three-state read;
// omitting it (BotsPage, BotDetailPage) keeps the original two-state read.
export interface BotStatusInput {
  enabled: boolean;
  pausedReason?: string | null;
}

export interface BotStatusChip {
  tone: ChipTone;
  label: string;
  title?: string;
}

export function botStatusChip(bot: BotStatusInput, isPulling?: boolean): BotStatusChip {
  const paused = !bot.enabled || bot.pausedReason != null;
  if (isPulling) return { tone: 'success', label: 'processing' };
  if (paused) return { tone: 'warning', label: 'paused', title: bot.pausedReason ?? undefined };
  if (isPulling === false) return { tone: 'neutral', label: 'idle' };
  return { tone: 'success', label: 'enabled' };
}

// ─── Local-compute presence ────────────────────────────────────────────────────
//
// From pages/local-compute/LocalComputePage.tsx's node-status Chip.
export type PresenceStatus = 'connected' | 'stale' | 'offline';

export interface PresenceChip {
  tone: ChipTone;
  dot: 'pulse' | 'static';
  label: string;
}

export function presenceChip(status: PresenceStatus): PresenceChip {
  if (status === 'connected') return { tone: 'success', dot: 'pulse', label: 'connected' };
  if (status === 'stale') return { tone: 'warning', dot: 'static', label: 'stale' };
  return { tone: 'neutral', dot: 'static', label: 'offline' };
}

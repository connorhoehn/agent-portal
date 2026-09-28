// The Review queue (spec §1 "Review"): samples → queue rows, the Pending /
// Reviewed counts, which sample opens after a verdict, and the optimistic
// verdict + rollback pair.
//
// A row never shows a bare target id (`cl-022`): it shows the server-joined
// `target.title`, or — when the server could not resolve the target — says so,
// and the page offers Retry. Pure: no React.

import { pgTimestampMs } from '../../lib/pgTimestamp.ts';
import type { ReviewSampleWithTarget, ReviewVerdict } from './types.ts';

export type QueueTab = 'pending' | 'decided';

export interface ReviewQueueRow {
  id: string;
  /** The target's title, or "Target could not be loaded". */
  title: string;
  /** false → the page renders the unresolved state with Retry. */
  resolved: boolean;
  /** The server's reason when unresolved. */
  error: string | null;
  /** "Pattern" · "Guide" · "Runbook" … */
  typeLabel: string;
  repo: string | null;
  /** null = the server did not say. */
  sourceCount: number | null;
  sampledAt: string;
  verdict: ReviewVerdict;
  reviewer: string | null;
  targetId: string;
}

export interface QueueCounts {
  pending: number;
  decided: number;
}

const TYPE_LABEL: Record<string, string> = {
  cluster: 'Pattern',
  artifact: 'Guide',
  observation: 'Run note',
  runbook: 'Runbook',
  insight: 'Insight',
  convention: 'Convention',
  decision: 'Decision',
  procedure: 'Procedure',
  finding: 'Finding',
  library_item: 'Agent library asset',
};

export function reviewTypeLabel(kind: string | null | undefined): string {
  if (!kind) return 'Item';
  return TYPE_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
}

export const UNRESOLVED_TITLE = 'Target could not be loaded';

export function toQueueRow(s: ReviewSampleWithTarget): ReviewQueueRow {
  const t = s.target ?? null;
  const resolved = !!t && !s.target_error && !!t.title;
  return {
    id: s.id,
    title: resolved ? t!.title : UNRESOLVED_TITLE,
    resolved,
    error: resolved ? null : (s.target_error ?? 'The server returned no target for this sample.'),
    typeLabel: reviewTypeLabel(t?.kind ?? s.target_kind),
    repo: t?.repo ?? null,
    sourceCount: typeof t?.source_count === 'number' ? t.source_count : null,
    sampledAt: s.sampled_at,
    verdict: s.verdict,
    reviewer: s.reviewer,
    targetId: t?.id ?? s.target_id,
  };
}

export function isPending(s: { verdict: ReviewVerdict }): boolean {
  return s.verdict === 'pending';
}

export function queueCounts(samples: ReviewSampleWithTarget[]): QueueCounts {
  let pending = 0;
  for (const s of samples) if (isPending(s)) pending += 1;
  return { pending, decided: samples.length - pending };
}

/** Pending oldest-first (the one waiting longest is next); Reviewed newest-first. */
function order(tab: QueueTab) {
  return (a: ReviewSampleWithTarget, b: ReviewSampleWithTarget) => {
    const ta = pgTimestampMs(tab === 'decided' ? (a.reviewed_at ?? a.sampled_at) : a.sampled_at);
    const tb = pgTimestampMs(tab === 'decided' ? (b.reviewed_at ?? b.sampled_at) : b.sampled_at);
    const d = (tab === 'pending' ? ta - tb : tb - ta) || 0;
    return d !== 0 ? d : a.id.localeCompare(b.id);
  };
}

function matches(row: ReviewQueueRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [row.title, row.typeLabel, row.repo ?? '', row.targetId]
    .some((f) => f.toLowerCase().includes(needle));
}

/** The rows for one tab, ordered and filtered by the search box. */
export function queueRows(samples: ReviewSampleWithTarget[], tab: QueueTab, q: string | null = null): ReviewQueueRow[] {
  return samples
    .filter((s) => (tab === 'pending' ? isPending(s) : !isPending(s)))
    .sort(order(tab))
    .map(toQueueRow)
    .filter((r) => matches(r, q ?? ''));
}

/**
 * Which sample opens after a verdict on `decidedId`: the next pending sample
 * after it in queue order, wrapping to the first; null when none remain.
 * `samples` is the list BEFORE the verdict was applied (the decided sample's
 * position is what "next" is measured from).
 */
export function nextSampleAfterVerdict(samples: ReviewSampleWithTarget[], decidedId: string): string | null {
  const pending = samples.filter(isPending).sort(order('pending'));
  const idx = pending.findIndex((s) => s.id === decidedId);
  const rest = idx === -1 ? pending : [...pending.slice(idx + 1), ...pending.slice(0, idx)];
  return rest.find((s) => s.id !== decidedId)?.id ?? null;
}

export interface OptimisticVerdict {
  samples: ReviewSampleWithTarget[];
  /** The sample as it was — hand to `rollbackVerdict` on failure. null when
   *  `id` was not in the list (nothing changed). */
  previous: ReviewSampleWithTarget | null;
}

export function applyOptimisticVerdict(
  samples: ReviewSampleWithTarget[],
  id: string,
  verdict: Exclude<ReviewVerdict, 'pending'>,
  opts: { note?: string | null; reviewer?: string | null; nowIso?: string } = {},
): OptimisticVerdict {
  const previous = samples.find((s) => s.id === id) ?? null;
  if (!previous) return { samples, previous: null };
  const next: ReviewSampleWithTarget = {
    ...previous,
    verdict,
    note: opts.note ?? previous.note,
    reviewer: opts.reviewer ?? previous.reviewer,
    reviewed_at: opts.nowIso ?? new Date().toISOString(),
  };
  return { samples: samples.map((s) => (s.id === id ? next : s)), previous };
}

/** Put `previous` back exactly as it was. A no-op when previous is null. */
export function rollbackVerdict(
  samples: ReviewSampleWithTarget[],
  previous: ReviewSampleWithTarget | null,
): ReviewSampleWithTarget[] {
  if (!previous) return samples;
  return samples.map((s) => (s.id === previous.id ? previous : s));
}

/** "3 sources" / "1 source" / "" when unknown. */
export function sourceCountLabel(n: number | null): string {
  if (n == null) return '';
  return `${n} ${n === 1 ? 'source' : 'sources'}`;
}

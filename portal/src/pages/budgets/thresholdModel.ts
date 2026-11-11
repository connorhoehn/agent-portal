// How a budget row reads against its thresholds (learning loop, lane B).
//
// The middleware sends each row's mark (`threshold: { percent, reached }`, by
// lib/budget-threshold-rules.ts) and the configured thresholds (default 50, 80,
// 100); this turns them into the one status the row shows and the filter
// "Near or at cap" keys on. Pure, so the rule is testable without React.

import type { ThresholdMark } from './types';

export const DEFAULT_THRESHOLDS: readonly number[] = [50, 80, 100];

export type ThresholdTone = 'neutral' | 'info' | 'warning' | 'danger';

export interface ThresholdView {
  /** "under 50%", "50%", "80%", "at cap"; null when there is no budget to measure. */
  label: string | null;
  tone: ThresholdTone;
  /** "83% of the budget spent or held". */
  meta: string | null;
  /** At or past the near line (the highest threshold under 100), or at cap. */
  near: boolean;
  atCap: boolean;
}

/** The line "near cap" starts at: the highest threshold under 100 (80 by default). */
export function nearLine(thresholds: readonly number[] = DEFAULT_THRESHOLDS): number {
  const under = thresholds.filter((t) => t < 100);
  return under.length > 0 ? Math.max(...under) : 100;
}

export function thresholdView(mark: ThresholdMark | null | undefined, thresholds: readonly number[] = DEFAULT_THRESHOLDS): ThresholdView {
  if (!mark || mark.percent == null) return { label: null, tone: 'neutral', meta: null, near: false, atCap: false };
  const meta = `${Math.round(mark.percent)}% spent or held`;
  const first = thresholds.length > 0 ? Math.min(...thresholds) : 50;
  if (mark.reached >= 100) return { label: 'at cap', tone: 'danger', meta, near: true, atCap: true };
  if (mark.reached <= 0) return { label: `under ${first}%`, tone: 'neutral', meta, near: false, atCap: false };
  const near = mark.reached >= nearLine(thresholds);
  return { label: `${mark.reached}%`, tone: near ? 'warning' : 'info', meta, near, atCap: false };
}

/** The "Show" filter on every Budgets table. */
export type ThresholdFilter = 'all' | 'near';

export const THRESHOLD_FILTER_OPTIONS: ReadonlyArray<{ value: ThresholdFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'near', label: 'Near or at cap' },
];

export function parseThresholdFilter(raw: string | null): ThresholdFilter {
  return raw === 'near' ? 'near' : 'all';
}

export function passesThresholdFilter(mark: ThresholdMark | null | undefined, filter: ThresholdFilter, thresholds: readonly number[] = DEFAULT_THRESHOLDS): boolean {
  return filter === 'all' || thresholdView(mark, thresholds).near;
}

// Budget threshold rules, pure (lib/budget-thresholds.ts is the announcing half).
//
// Their own module so a route can mark a row by the same rule the bell uses
// without loading config, a provider or the mock clock (routes/budgets.ts's
// CommonJS test build mocks providers/budgets and nothing else).

export const DEFAULT_THRESHOLDS: readonly number[] = [50, 80, 100];

/** BUDGET_THRESHOLDS, e.g. "50,80,100": whole percentages 1..1000, sorted, unique. Anything unreadable is the default. */
export function configuredThresholds(raw: string | undefined = process.env['BUDGET_THRESHOLDS']): number[] {
  if (!raw || !raw.trim()) return [...DEFAULT_THRESHOLDS];
  const parts = raw.split(',').map((x) => Number(x.trim()));
  if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) return [...DEFAULT_THRESHOLDS];
  return [...new Set(parts)].sort((a, b) => a - b);
}

export type ThresholdSubjectKind = 'initiative' | 'user' | 'grant';

export interface ThresholdSubject {
  kind: ThresholdSubjectKind;
  id: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Where a budget stands: the percentage used (spent + held over the budget,
 * one decimal) and the highest threshold reached (0 = under the first). Null
 * percent = no budget to measure against. Pure.
 */
export function thresholdState(
  usedUsd: number, budgetUsd: number | null | undefined, thresholds: readonly number[] = configuredThresholds(),
): { percent: number | null; reached: number } {
  if (budgetUsd == null || !(budgetUsd > 0)) return { percent: null, reached: 0 };
  const pct = (Math.max(0, usedUsd) / budgetUsd) * 100;
  let reached = 0;
  // A float hair under the line still counts as at it ($80.00 of $100 is 80 %).
  for (const t of thresholds) if (pct + 1e-9 >= t) reached = t;
  return { percent: round1(pct), reached };
}

/** Every threshold `used` has reached of `budget`, lowest first. Pure. */
export function thresholdsReached(usedUsd: number, budgetUsd: number | null | undefined, thresholds: readonly number[] = configuredThresholds()): number[] {
  const { reached } = thresholdState(usedUsd, budgetUsd, thresholds);
  return thresholds.filter((t) => t <= reached);
}

// ─── Where the bell links ────────────────────────────────────────────────────

/** The Budgets row a threshold item opens. */
export function budgetsRowHref(subject: ThresholdSubject): string {
  const id = encodeURIComponent(subject.id);
  if (subject.kind === 'initiative') return `/admin/budgets?row=${id}`;
  if (subject.kind === 'user') return `/admin/budgets?report=people&row=${id}`;
  return `/admin/budgets?report=sprints&row=${id}`;
}

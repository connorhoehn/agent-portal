// Pure derivations for the eval panel. No React — testable under node:test,
// same split as libraryFormat.ts.

export type AssertionKind = 'contains' | 'not_contains' | 'matches' | 'json_has' | 'max_tokens';

export interface Assertion {
  kind: AssertionKind;
  value: string;
  description?: string;
}

export interface EvalCase {
  id: string;
  assetId: string;
  name: string;
  variables: Record<string, string>;
  assertions: Assertion[];
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  output?: string;
}

export interface EvalRun {
  id: string;
  assetId: string;
  version: string;
  ranAt: string;
  ranBy: string;
  passRate: number | null;
  total: number;
  passed: number;
  results: EvalCaseResult[];
}

/** Mirrors evalLabel() in libraryFormat.ts, but "no runs yet" is a more
 *  precise claim here than "never evaluated" — this panel is looking at run
 *  history directly, not the cached column on the asset. */
export function formatPassRate(rate: number | null): string {
  return rate == null ? 'no runs yet' : `${Math.round(rate * 100)}%`;
}

export function assertionSummary(count: number): string {
  return `${count} assertion${count === 1 ? '' : 's'}`;
}

/** Runs arrive newest-first from the API, but the panel should not silently
 *  trust that ordering forever — defensive against a future caller that
 *  hands back an unsorted page. */
export function latestRun(runs: EvalRun[]): EvalRun | null {
  if (runs.length === 0) return null;
  return runs.reduce((a, b) => (a.ranAt >= b.ranAt ? a : b));
}

export function caseResultFor(run: EvalRun | null, caseId: string): EvalCaseResult | null {
  if (!run) return null;
  return run.results.find((r) => r.caseId === caseId) ?? null;
}

/** Same red-below-80% rule the drawer's health panel already renders — kept
 *  here instead of imported so this panel does not reach into libraryFormat
 *  for one constant and drag its whole surface along. */
export function progressColor(rate: number | null): string | undefined {
  return rate != null && rate < 0.8 ? 'var(--color-danger)' : undefined;
}

// Pure derivations for the library. No React — testable under node:test.

import type { AssetKind, AssetTier, LibraryAsset, VarSource } from './types';

export const KIND_LABEL: Record<AssetKind, string> = {
  system: 'System prompt',
  prompt: 'Prompt',
  evaluator: 'Evaluator',
  skill: 'Skill',
  insight: 'Insight',
};

/** What each kind means, in the terms that decide where it belongs: who
 *  invokes it. Shown as the facet's hint so the taxonomy teaches itself. */
export const KIND_HINT: Record<AssetKind, string> = {
  system: 'an agent’s identity',
  prompt: 'a person runs it with inputs',
  evaluator: 'a pipeline runs it, no human',
  skill: 'the model discovers and loads it',
  insight: 'a fact injected, never run',
};

export const KIND_TONE: Record<AssetKind, 'neutral' | 'info' | 'warning' | 'purple' | 'success'> = {
  system: 'neutral', prompt: 'info', evaluator: 'warning', skill: 'purple', insight: 'success',
};

export const TIER_LABEL: Record<AssetTier, string> = {
  sandbox: 'Sandbox', internal: 'Internal', endpoint: 'Endpoint',
};

/** The tier is the ceremony, so its hint states the gate rather than the name. */
export const TIER_HINT: Record<AssetTier, string> = {
  sandbox: 'Studio only — no gates',
  internal: 'callable by the fleet — owner + green eval',
  endpoint: 'reachable outside — guardrail + 2 sign-offs',
};

export const TIER_TONE: Record<AssetTier, 'neutral' | 'info' | 'danger'> = {
  sandbox: 'neutral', internal: 'info', endpoint: 'danger',
};

/** Trust tone for a variable's source — the fenced ones read as hazardous
 *  because that is exactly what they are. */
export const SOURCE_TONE: Record<VarSource, 'neutral' | 'info' | 'warning' | 'danger'> = {
  literal: 'neutral', caller: 'info', retrieved: 'warning', untrusted: 'danger',
};

export const SOURCE_HINT: Record<VarSource, string> = {
  literal: 'baked in — trusted, inlined',
  caller: 'supplied by the caller — validated, inlined',
  retrieved: 'fetched content — fenced',
  untrusted: 'end-user text — fenced and defanged',
};

export function isFenced(source: VarSource): boolean {
  return source === 'retrieved' || source === 'untrusted';
}

/** "3 variables · 1 fenced" — the contract at a glance. Says nothing when the
 *  asset takes no input, rather than "0 variables". */
export function contractLine(a: LibraryAsset): string | null {
  const vars = a.contract?.variables ?? [];
  if (vars.length === 0) return null;
  const fenced = vars.filter((v) => isFenced(v.source)).length;
  const base = `${vars.length} variable${vars.length === 1 ? '' : 's'}`;
  return fenced > 0 ? `${base} · ${fenced} fenced` : base;
}

/** Who actually calls it. "nothing yet" is a real answer — the old library
 *  labelled these "unused · not wired to anything", which read as broken
 *  rather than as new. */
export function usageLine(a: LibraryAsset): string {
  if (a.usedBy.length === 0) return 'nothing calls it yet';
  return a.usedBy.length <= 2 ? a.usedBy.join(', ') : `${a.usedBy[0]} +${a.usedBy.length - 1} more`;
}

export function evalLabel(rate: number | null): string {
  return rate == null ? 'never evaluated' : `${Math.round(rate * 100)}%`;
}

/** Facet options ordered by the catalog, not hardcoded — a kind with nothing
 *  in it is not offered. */
export function facetOptions<T extends string>(
  counts: Record<string, number>, order: readonly T[],
): Array<{ value: T; count: number }> {
  return order.filter((k) => (counts[k] ?? 0) > 0).map((k) => ({ value: k, count: counts[k] ?? 0 }));
}

export const KIND_ORDER: readonly AssetKind[] = ['system', 'prompt', 'evaluator', 'skill', 'insight'];
export const TIER_ORDER: readonly AssetTier[] = ['sandbox', 'internal', 'endpoint'];

/**
 * Which empty state a zero-result library read is, so the page never shows a
 * dead "Clear filters" button when there was nothing to clear.
 *
 * `'filtered'` — a search or facet narrowed a real catalog to nothing; the
 * fix is to loosen the query, so "Clear filters" is a real action.
 * `'catalog-empty'` — no kind/tier facet and no search text were applied and
 * the catalog still came back empty: the library itself has no assets yet,
 * which is a different fact and points to where assets come from
 * (Distillation › Artifacts) rather than at filters that were never set.
 */
export type LibraryEmptyKind = 'filtered' | 'catalog-empty';

export function libraryEmptyKind(filtersApplied: boolean, count: number): LibraryEmptyKind | null {
  if (count > 0) return null;
  return filtersApplied ? 'filtered' : 'catalog-empty';
}

// ─── Release readiness ───────────────────────────────────────────────────────

export interface ReadinessRow { label: string; met: boolean; detail?: string }

/**
 * The gate as a checklist rather than a verdict.
 *
 * "Not shippable" tells someone nothing they can act on; "never evaluated"
 * tells them what to go do. Rows are only shown when the tier actually
 * requires them — a sandbox asset answers to nobody, so listing five unmet
 * requirements against it would be noise inviting cargo-cult compliance.
 */
export function readinessRows(r: {
  tier: AssetTier;
  checks: {
    contractComplete: boolean; undeclared: string[]; hasOwner: boolean;
    evaluated: boolean; evalPassRate: number | null; guardrailBound: boolean; signoffs: number;
  };
}): ReadinessRow[] {
  if (r.tier === 'sandbox') return [];
  const c = r.checks;
  const rows: ReadinessRow[] = [
    {
      label: 'Contract complete',
      met: c.contractComplete,
      ...(c.undeclared.length > 0
        ? { detail: `${c.undeclared.join(', ')} would render as untrusted` }
        : {}),
    },
    { label: 'Owner', met: c.hasOwner },
    {
      label: 'Eval baseline ≥ 80%',
      met: c.evaluated && (c.evalPassRate ?? 0) >= 0.8,
      detail: c.evalPassRate == null ? 'never evaluated' : `${Math.round(c.evalPassRate * 100)}%`,
    },
  ];
  if (r.tier === 'endpoint') {
    rows.push(
      { label: 'Guardrail bound', met: c.guardrailBound },
      { label: '2 sign-offs', met: c.signoffs >= 2, detail: `${c.signoffs} recorded` },
    );
  }
  return rows;
}

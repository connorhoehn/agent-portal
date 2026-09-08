// Pure helpers extracted out of ScoresPage.tsx and SkillFilter.tsx so the
// re-weighting math and the skill-suggestion filter can be unit tested
// without mounting a page. No React, no fetch — just data in, data out.

// ── One scale for every score on this page (DEFECTS.md org-leader #11) ─────
//
// The wire contract is not internally consistent: `middleware/src/mock/
// scores.ts`'s influence/expertise are fractions in [0,1] while its composite
// is already 0-100 (`Math.round(avg * 100)`), and the same is true of the
// `influenceScore` field `/api/graph/people/:id` returns (`clamp01` — always
// [0,1], both mock and real). The real Aurora leaderboard path is *also*
// inconsistent with the mock: `pagerank_score * 100` and `expertise_score` are
// both already 0-100 there. So a raw field can arrive as a fraction or as a
// percentage depending on which of those three paths served it, and the only
// value that is NEVER ambiguous in practice is a real percentage of exactly 0
// or >= 1 (nobody's tracked score is a fraction that rounds to "1 out of
// 100"). `formatScore` is the one place that decides which it is, and every
// display of a score-like number in this page's components must go through
// it (or through `computeReweighted`, which uses it internally) rather than
// re-deriving its own rounding.
function toPercent(raw: number): number {
  return raw > 0 && raw < 1 ? raw * 100 : raw;
}

/** Render any score-like value (composite, influence, expertise, PageRank) as a 0-100 integer. */
export function formatScore(raw: number): number {
  return Math.round(toPercent(raw));
}

export interface ReweighableEntry {
  influence: number;
  expertise: number;
}

/**
 * Blend influence/expertise into a composite score at `weight` (0..1, share
 * given to influence) and sort descending by that composite. Normalizes each
 * input through `formatScore`'s same fraction-vs-percent rule first, so the
 * result is always 0-100 regardless of which scale the two inputs arrived on
 * — see the comment above `formatScore`.
 */
export function computeReweighted<T extends ReweighableEntry>(
  entries: T[],
  weight: number,
): Array<T & { composite: number }> {
  const list = entries.map(e => ({
    ...e,
    composite: formatScore(weight * toPercent(e.influence) + (1 - weight) * toPercent(e.expertise)),
  }));
  list.sort((a, b) => b.composite - a.composite);
  return list;
}

export interface SkillSummaryLike {
  name: string;
}

/**
 * Suggestions for the skill-search combobox. An empty query returns the
 * first `limit` skills (so the popover has something useful to show on
 * focus, before the user types); a non-empty query is a case-insensitive
 * substring match. Never throws on an empty/undefined skill list.
 */
export function filterSkillSuggestions<T extends SkillSummaryLike>(
  skills: T[],
  query: string,
  limit = 8,
): T[] {
  if (query.length === 0) return skills.slice(0, limit);
  const q = query.toLowerCase();
  return skills.filter(s => s.name.toLowerCase().includes(q)).slice(0, limit);
}

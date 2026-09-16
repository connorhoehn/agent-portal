// Pure derivations for "short-circuiting rediscovery" — see
// docs/asset-library-and-promotion.md § Not built yet: short-circuiting
// rediscovery. Wire contract: POST /api/rediscovery/check.
//
// The retrieval key is problem shape, not repo — so the top hit is often
// `crossProject: true`, which is the entire payoff ("someone already hit this,
// four months ago, on a different project"). Everything here exists to render
// that moment without ever asserting more than the match actually earned:
// a stale match rendered as confidently as a fresh one just trades a slow
// rediscovery for a fast wrong turn.

import { usd as formatUsd } from '../../lib/format.ts';

export type ExperienceKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';
export type Verdict = 'applies' | 'partial' | 'stale';

export interface RediscoveryMatch {
  experienceId: string;
  title: string;
  body: string;
  kind: ExperienceKind;
  repo: string | null;
  sessionId: string;
  ageDays: number;
  score: number;
  crossProject: boolean;
  verdict: Verdict;
  why: string;
}

// ─── Tone tables ─────────────────────────────────────────────────────────────

/** applies=success (acted on it), partial=warning (read the evidence first),
 *  stale=neutral (this is a filed match, not a live one). */
export const VERDICT_TONE: Record<Verdict, 'success' | 'warning' | 'neutral'> = {
  applies: 'success',
  partial: 'warning',
  stale: 'neutral',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  applies: 'applies',
  partial: 'partial match',
  stale: 'stale',
};

// ─── Formatting ──────────────────────────────────────────────────────────────

/** "3 months ago" / "yesterday" — the unit a human reaches for, not a raw
 *  day count. Anything a year+ old rounds to years; nobody reads "412 days
 *  ago" as meaningfully different from "410 days ago". */
export function ageLabel(days: number): string {
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.round(days)} days ago`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return months <= 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.round(days / 365);
  return years <= 1 ? '1 year ago' : `${years} years ago`;
}

/** "gotcha · orgiq-observability · 4 months ago" — and cross-project gets
 *  called out in the same line, not left for a reader to notice on their own,
 *  because "this came from somewhere else entirely" is the fact that makes
 *  the match worth a second look. */
export function provenanceLine(m: RediscoveryMatch): string {
  const repo = m.repo ?? 'unspecified repo';
  const base = `${m.kind} · ${repo} · ${ageLabel(m.ageDays)}`;
  return m.crossProject ? `${base} — different project` : base;
}

/** "~$4.80 and ~35 min not spent". Returns null when either half is missing
 *  rather than rendering half a sentence or inventing the other number — an
 *  estimate is only honest when it's the same estimator the marketplace
 *  already uses, computed at the moment of the short-circuit. */
export function savingsLine(usd: number | null, minutes: number | null): string | null {
  if (usd == null || minutes == null) return null;
  return `~${formatUsd(usd)} and ~${Math.round(minutes)} min not spent`;
}

/** Score floor below which a match is noise, not a lead. Kept as one
 *  constant so "worth showing at all" and "worth rendering this row" can
 *  never disagree with each other. */
/**
 * Is this match worth a human's attention at a spend moment?
 *
 * Sourced from the SERVER'S verdict rather than a threshold of our own. The
 * server already applies its score floor when it decides a verdict — anything
 * under it comes back `stale` — so re-deciding here with a second number
 * duplicates the ranking policy across two repos, where it would drift
 * silently the first time either side was tuned. One authority: the verdict.
 */
export function matchQualifies(m: RediscoveryMatch): boolean {
  return m.verdict === 'applies' || m.verdict === 'partial';
}

/** Gates the whole panel. A spend moment is exactly the place a weak "maybe
 *  this is related" match trains people to stop reading the panel — so
 *  silence beats a low-confidence guess, every time. */
export function worthShowing(matches: RediscoveryMatch[]): boolean {
  return matches.some(matchQualifies);
}

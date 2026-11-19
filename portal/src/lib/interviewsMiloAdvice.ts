// What the scorecard shows at a glance (docs/interviews-tenant-plan.md, "Milo's recommendation on the scorecard"):
// each rating as stars on the kit's own 1 to 4 scale, each piece of Milo's evidence as the quote itself, and Milo's
// recommendation (Advance, Inconclusive, Don't advance) as a deterministic rule over the interviewers' ratings and how much of
// the round the recap's evidence covers. No model is asked: the rule reads what the people rated and what the
// transcript holds, and the panel decides.

import type { RecapBody, RecapClaim } from './interviewsScorecard.ts';

/** The kit's scale: every competency is rated 1 to 4 (lib/interviewsScorecard.ts `Rating`). */
export const SCALE_MAX = 4;

/** The rating as stars, filled then empty: 3 → "★★★☆". Out-of-range values are clamped. */
export function starsOf(rating: number, of: number = SCALE_MAX): string {
  const n = Math.max(0, Math.min(of, Math.round(rating)));
  return '★'.repeat(n) + '☆'.repeat(of - n);
}

/** "3 of 4", or "3.5 of 4" for a pooled average. */
export const ratingWords = (rating: number, of: number = SCALE_MAX): string => `${oneDecimal(rating)} of ${of}`;

const oneDecimal = (n: number): string => (Math.round(n * 10) / 10).toString();

// ── the evidence rows ───────────────────────────────────────────────────────

/**
 * The stand-in recap's reporting sentences (middleware lib/interviews/recap model.ts ANSWER_TEXT and parse.ts
 * SAME_ANSWER_TEXT): they say only that the line was an answer, so a row never repeats them.
 */
const GENERIC = /^the candidate (also )?said this( in answer to the question| in the same answer)?\.?$/i;

export const isGenericClaim = (text: string): boolean => GENERIC.test(text.replace(/\s+/g, ' ').trim());

/** How long the one-line quote in a row may be before it is cut. */
export const ROW_QUOTE_CHARS = 110;

export interface EvidenceRow {
  /** The quote, cut to one line at a word boundary with "…" when longer. */
  quote: string;
  /** "Line 12": where the quote sits in the transcript. */
  where: string;
  seq: number;
  /** The whole quote, only when the row had to cut it. */
  fullQuote: string | null;
  /** Milo's own statement, only when it says more than that the line was an answer. */
  context: string | null;
  /** True when there is anything to expand. */
  expandable: boolean;
}

export function evidenceRow(claim: RecapClaim, max: number = ROW_QUOTE_CHARS): EvidenceRow {
  const full = claim.source.quote.replace(/\s+/g, ' ').trim();
  let quote = full;
  if (full.length > max) {
    const cut = full.slice(0, max);
    const space = cut.lastIndexOf(' ');
    quote = `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
  }
  const text = claim.text.replace(/\s+/g, ' ').trim();
  const context = text && !isGenericClaim(text) && text.toLowerCase() !== full.toLowerCase() ? text : null;
  const fullQuote = quote === full ? null : full;
  return { quote, where: `Line ${claim.source.seq}`, seq: claim.source.seq, fullQuote, context, expandable: fullQuote !== null || context !== null };
}

// ── Milo's recommendation ───────────────────────────────────────────────────

export type MiloAdviceOutcome = 'advance' | 'hold' | 'dont-advance' | 'not-enough';

export const MILO_ADVICE_LABELS: Readonly<Record<MiloAdviceOutcome, string>> = {
  advance: 'Advance', hold: 'Inconclusive', 'dont-advance': 'Don\'t advance', 'not-enough': 'Not enough evidence to recommend',
};

/** The library Banner variant for each outcome: green, yellow, red, and a neutral note when there is none. */
export const MILO_ADVICE_TONES: Readonly<Record<MiloAdviceOutcome, 'success' | 'warning' | 'error' | 'info'>> = {
  advance: 'success', hold: 'warning', 'dont-advance': 'error', 'not-enough': 'info',
};

export interface MiloAdvice { outcome: MiloAdviceOutcome; label: string; tone: 'success' | 'warning' | 'error' | 'info'; reasons: string[] }

/** Each competency's ratings across the scorecards given (one per interviewer, latest version). */
export function pooledRatings(cards: ReadonlyArray<{ ratings: ReadonlyArray<{ competencyId: string; rating: number }> }>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const card of cards) for (const r of card.ratings) (out[r.competencyId] ??= []).push(r.rating);
  return out;
}

/** A single draft's ratings in the same shape. */
export function draftRatings(ratings: Readonly<Record<string, number | null>>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(ratings).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, [v as number]]));
}

/** Below this average a competency is under the bar (1 is "does not meet", 2 "partly meets"). */
export const LOW_BELOW = 2;
/** At or above this overall average, with nothing under the bar and every competency evidenced, Milo says Advance. */
export const ADVANCE_FROM = 3;
/** Below this overall average, or with two or more competencies under the bar, Milo says Don't advance. */
export const DONT_ADVANCE_BELOW = 2.25;

const names = (xs: ReadonlyArray<{ name: string }>): string => xs.length <= 2 ? xs.map((x) => x.name).join(' and ') : `${xs.slice(0, -1).map((x) => x.name).join(', ')} and ${xs[xs.length - 1]!.name}`;

/**
 * Is the lead's scorecard in? Their submitted card among `cards` (this round's), or, while someone fills the form,
 * their own draft when the one drafting holds the lead's seat. A panelist's card or draft alone never is.
 */
export function leadCardIn(input: { leadId: string; draftingSeat: 'lead' | 'panel' | null; cards: ReadonlyArray<{ interviewer: { id: string } }> }): boolean {
  return input.draftingSeat === 'lead' || input.cards.some((c) => c.interviewer.id === input.leadId);
}

/**
 * The rule, in order:
 * 0. The lead's scorecard not in yet (leadCardIn): no recommendation.
 * 1. No ready recap, a required competency nobody rated, or evidence for fewer than half the required competencies:
 *    not enough evidence, and no recommendation.
 * 2. Each competency's score is the average of its ratings; the overall score is the average of those.
 * 3. Don't advance: overall under 2.25, or two or more competencies under 2.
 * 4. Advance: overall 3 or more, no competency under 2, and evidence for every required competency.
 * 5. Otherwise Inconclusive.
 * At most two reasons, the deciding one first.
 */
export function miloAdvice(input: {
  required: ReadonlyArray<{ id: string; name: string }>;
  ratings: Readonly<Record<string, readonly number[]>>;
  recap: Pick<RecapBody, 'state' | 'competencies'> | null;
  /** Whether the lead's scorecard is in (leadCardIn). */
  leadIn: boolean;
}): MiloAdvice {
  const out = (outcome: MiloAdviceOutcome, reasons: string[]): MiloAdvice => ({ outcome, label: MILO_ADVICE_LABELS[outcome], tone: MILO_ADVICE_TONES[outcome], reasons: reasons.slice(0, 2) });
  const { required, ratings, recap } = input;
  if (required.length === 0) return out('not-enough', ['This round has no competencies to weigh.']);
  if (!input.leadIn) return out('not-enough', ['The lead interviewer\'s scorecard is not in yet.']);
  if (!recap || recap.state !== 'ready') return out('not-enough', ['Milo has no recap of the transcript for this round, so there is no evidence to weigh.']);
  const unrated = required.filter((c) => !(ratings[c.id]?.length));
  if (unrated.length) return out('not-enough', [`${names(unrated)} ${unrated.length === 1 ? 'is' : 'are'} not rated yet.`]);
  const evidenced = (id: string) => (recap.competencies.find((c) => c.id === id)?.evidence.length ?? 0) > 0;
  const uncovered = required.filter((c) => !evidenced(c.id));
  const covered = required.length - uncovered.length;
  if (covered * 2 < required.length) {
    return out('not-enough', [`The transcript has evidence for only ${covered} of ${required.length} competencies.`]);
  }
  const scored = required.map((c) => { const rs = ratings[c.id]!; return { ...c, score: rs.reduce((a, b) => a + b, 0) / rs.length }; });
  const overall = scored.reduce((a, c) => a + c.score, 0) / scored.length;
  const low = scored.filter((c) => c.score < LOW_BELOW);
  const average = `Rated ${ratingWords(overall)} on average across ${scored.length} ${scored.length === 1 ? 'competency' : 'competencies'}.`;
  if (overall < DONT_ADVANCE_BELOW || low.length >= 2) {
    return out('dont-advance', low.length ? [`Below the bar on ${names(low)}.`, average] : [average]);
  }
  if (overall >= ADVANCE_FROM && low.length === 0 && uncovered.length === 0) {
    const best = [...scored].sort((a, b) => b.score - a.score)[0]!;
    return out('advance', [average, `Strongest on ${best.name} (${ratingWords(best.score)}), with evidence for every competency.`]);
  }
  const why: string[] = [];
  if (low.length) why.push(`Below the bar on ${names(low)}.`);
  if (uncovered.length) why.push(`No evidence in the transcript for ${names(uncovered)}.`);
  why.push(average);
  return out('hold', why);
}

// How Milo's recap is read (docs/interviews-tenant-plan.md decisions 6 and 14; row I5.2).
//
// The answer is strict JSON, exactly `{ competencies: [{ id, evidence: [{ text, seq, quote }] }], notCovered: [id] }`.
// Any other shape anywhere in it is `malformed` and the whole answer is dropped.
//
// The row's bar, in code:
//   every claim has a source   a claim is DROPPED (and counted) when its `seq` is not a line it was given, when that line
//                              is not the candidate's (stricter reading: evidence of what the candidate said rests on
//                              the candidate's own words, not on a question), when `quotedFrom` does not find its quote
//                              in THAT line (stricter than "in the given lines"), when it is empty or too long, or when
//                              its quote touches a personal trait (PERSONAL: the candidate's own words about their
//                              family or health are kept out of the recap). A competency left with no claim moves to
//                              "not covered". A competency id not in the kit is dropped with its claims.
//   no rating, no recommendation   every claim's text, with its own verified quote taken out, is run through the coach's
//                              `guardSuggestion` (JUDGES, PERSONAL) and through RECAP_JUDGES below. ONE claim that trips
//                              any of them rejects the WHOLE recap (`judges` or `personal`): a writer that judged once is
//                              not trusted for the rest. The rejection is counted by code; its text is never stored.
// The quote is taken out before the guard because it is the candidate's own words, already proved to be in their line:
// a candidate saying "I recommended we roll back" must not reject the recap. Milo's words around it are what is guarded.
//
// What the guard catches: the listed words and phrases, in English, as whole words, case-insensitive. What it cannot
// catch, said plainly: a judgement in other words ("the candidate covered every case the kit lists"), a slant carried by
// WHICH statements were chosen or left out, emphasis by repetition, a paraphrase that drifts from its quote while still
// citing it, and any other language. The quote check proves the source exists, not that the statement is a fair reading
// of it: that is why every statement is shown beside its quote, and why the person rates before they read it.
import { extractJson } from '../../meeting-assistant/decision-prompt.js';
import { guardSuggestion, PERSONAL, quotedFrom } from '../coach/parse.js';
import type { CoachLine } from '../coach/prompt.js';
import { MAX_CLAIM_CHARS, MAX_CLAIMS_PER_COMPETENCY, MAX_QUOTE_CHARS } from './prompt.js';

export interface RecapClaim { text: string; seq: number; quote: string }
export interface RecapCompetency { id: string; evidence: RecapClaim[] }
/** What a recap holds: evidence per competency (kit order, only those with evidence) and the ids nothing bore on. */
export interface RecapContent { competencies: RecapCompetency[]; notCovered: string[] }

/** Why a whole attempt left no recap. */
export type RecapRejectCode = 'malformed' | 'judges' | 'personal';
export type RecapParseResult =
  | { ok: true; recap: RecapContent; droppedClaims: number }
  | { ok: false; code: RecapRejectCode };

/**
 * Judging words the coach's JUDGES leave to context, because a suggestion never needs them but a recap's statements
 * might drift into them: scores and levels, verdict and praise words, comparison, doubt and speculation, and words that
 * describe the person rather than what they said. Narrow where a word has a technical sense ("strong consistency",
 * "weak reference", "a good first step" is still refused: Milo says what was said, not whether it was good).
 */
export const RECAP_JUDGES: readonly RegExp[] = [
  // scores and levels ("rate limiter", "error rate" and "refill rate" are the work, and pass)
  /\b(?:rated|scored|graded)\b|\b(?:rating|score|grade|level)\s+(?:of|for|is|was|would be)\b|\b(?:their|the candidate'?s?)\s+(?:rating|score|grade|level)\b/i,
  /\b[1-4]\s*(?:out of|of|\/)\s*(?:4|four)\b|\b(?:one|two|three|four)\s+out of\s+four\b|\blevel\s*[1-4]\b|\banchors?\b/i,
  /\b(?:meets?|met|below|above|raises?|raised|clears?|cleared)\s+the bar\b|\bbar[- ]raiser\b|\bon the rubric\b/i,
  // verdicts and hiring
  /\b(?:hire|hireable|hiring decision|no[- ]hire|go\/no-go|no-go)\b/i,
  /\b(?:strong|strongly|stronger|strongest)\b(?!\s+(?:consistency|consistent|reference|references|typing|types?|ordering|isolation))/i,
  /\b(?:weak|weakly|weaker|weakest|weakness|weaknesses|strength|strengths)\b(?!\s+(?:consistency|consistent|reference|references|typing|types?|ordering|isolation))/i,
  /\b(?:excellent|outstanding|impressive|impressed|exceptional|good|great|poor|bad(?!\s+requests?\b)|mediocre|adequate|competent|proficient|solid(?!\s+principles?\b)|insightful|thoughtful|convincing|unconvincing|compelling|superficial|shallow|vague|thorough|thoroughly|lacking|lacked|lacks|failed to|struggled|struggles|struggling)\b/i,
  // comparison and ranking
  /\b(?:better|worse|worst)\b|\bbest\b(?!\s+practices?\b)|\bcompared (?:to|with)\b|\bthan (?:other|most|the average|average|expected)\b|\btop (?:candidate|performer)\b/i,
  // doubt and speculation
  /\b(?:seemed|seems|appeared|appears|apparently|doubt\w*|questionable|unclear whether|may have|might have|probably|likely|presumably)\b/i,
  // the person rather than the words
  /\b(?:he|she|him|her|his|hers|himself|herself)\b/i,
  /\b(?:smart|intelligent|bright|talented|gifted|passionate|confident|confidence|arrogant|humble|friendly|likeable|likable|charismatic|articulate|eloquent|experienced|inexperienced|senior-level|junior-level)\b/i,
];

/** The first rule a recap statement breaks, or null. */
export function guardRecapText(text: string): 'judges' | 'personal' | null {
  const coach = guardSuggestion(text);
  if (coach) return coach;
  return RECAP_JUDGES.some((r) => r.test(text)) ? 'judges' : null;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The statement with its own quote taken out (case and spacing aside), so only Milo's words are guarded. */
export function withoutQuote(text: string, quote: string): string {
  const q = squash(quote);
  if (!q) return text;
  const loose = q.split(' ').map(escape).join('\\s+');
  return text.replace(new RegExp(loose, 'gi'), ' ');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

/** The model's text read as one recap, checked against the kit's competencies and the transcript it was given. */
export function parseRecapAnswer(raw: string | null, ctx: { competencyIds: readonly string[]; lines: readonly CoachLine[] }): RecapParseResult {
  const json = raw === null ? null : extractJson(raw);
  if (!isPlainObject(json) || !exactKeys(json, ['competencies', 'notCovered'])) return { ok: false, code: 'malformed' };
  const { competencies, notCovered } = json;
  if (!Array.isArray(competencies) || !Array.isArray(notCovered) || !notCovered.every((x) => typeof x === 'string')) return { ok: false, code: 'malformed' };

  const bySeq = new Map(ctx.lines.map((l) => [l.seq, l]));
  const kit = new Set(ctx.competencyIds);
  const found = new Map<string, RecapClaim[]>();
  let droppedClaims = 0;

  for (const c of competencies) {
    if (!isPlainObject(c) || !exactKeys(c, ['id', 'evidence']) || typeof c['id'] !== 'string' || !Array.isArray(c['evidence'])) return { ok: false, code: 'malformed' };
    for (const e of c['evidence'] as unknown[]) {
      if (!isPlainObject(e) || !exactKeys(e, ['text', 'seq', 'quote']) || typeof e['text'] !== 'string' || typeof e['quote'] !== 'string'
        || typeof e['seq'] !== 'number' || !Number.isInteger(e['seq'])) return { ok: false, code: 'malformed' };
    }
  }

  for (const c of competencies as Array<{ id: string; evidence: Array<{ text: string; seq: number; quote: string }> }>) {
    // Judging is checked on every statement, even those dropped for other reasons: one judging statement rejects all.
    for (const e of c.evidence) {
      const text = squash(e.text);
      const quote = squash(e.quote);
      const line = bySeq.get(e.seq);
      const sourced = !!line && line.side === 'candidate' && quote.length > 0 && quotedFrom(quote, [line]);
      const guard = guardRecapText(sourced ? withoutQuote(text, quote) : text);
      if (guard) return { ok: false, code: guard };
    }
    if (!kit.has(c.id)) { droppedClaims += c.evidence.length; continue; }
    for (const e of c.evidence) {
      const text = squash(e.text);
      const quote = squash(e.quote);
      const line = bySeq.get(e.seq);
      const keep = text.length > 0 && text.length <= MAX_CLAIM_CHARS && quote.length > 0 && quote.length <= MAX_QUOTE_CHARS
        && !!line && line.side === 'candidate' && quotedFrom(quote, [line]) && !PERSONAL.some((r) => r.test(quote));
      const list = found.get(c.id) ?? [];
      if (!keep || list.length >= MAX_CLAIMS_PER_COMPETENCY) { droppedClaims += 1; continue; }
      list.push({ text, seq: e.seq, quote });
      found.set(c.id, list);
    }
  }

  // Kit order; a competency with no claim left is not covered, whatever the model said.
  const out: RecapCompetency[] = [];
  const uncovered: string[] = [];
  for (const id of ctx.competencyIds) {
    const evidence = found.get(id);
    if (evidence?.length) out.push({ id, evidence });
    else uncovered.push(id);
  }
  return { ok: true, recap: { competencies: out, notCovered: uncovered }, droppedClaims };
}

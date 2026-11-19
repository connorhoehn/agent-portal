// How the coach's answer is read (docs/interviews-tenant-plan.md decisions 6 and 8; row I3.3).
//
// The answer is strict JSON, exactly `{ text, competencyId, basedOn }`. Anything else is `malformed` and dropped whole.
// A well-formed answer is still dropped when:
//   off-kit        its competency is not one of the kit's;
//   too-long       its text is longer than a spoken question should be (MAX_SUGGESTION_CHARS), or its quote is too long;
//   unsourced      it quotes something that is not in the transcript it was given, nor (in a technical round, row I4.5)
//                  in one line of the pad or of the last run's output it was shown (decision 6: a source for every claim);
//   judges         it rates, scores, ranks, compares or recommends, or calls an answer good or bad;
//   personal       it speaks of the candidate's face, looks, voice, tone, accent, age, health, family, origin, beliefs or
//                  another personal trait rather than of what was said.
// A dropped answer is logged as its code only; its text is never kept or logged.
//
// What the guard (`guardSuggestion`) catches: the words and phrases in JUDGES and PERSONAL below, then the judgement
// detector (../judgement.ts): paraphrased ratings, rankings and verdicts on normalised text (pronouns, contractions,
// case), readings of the manner, and any text that does not read as English (dropped, never translated). What it
// cannot catch, said plainly: a judgement in English words none of the rules name, a question that is fair in words but
// leading in effect, and bias that lives in which competency is probed rather than how. The system prompt asks for none
// of these; the guard is the floor under it, not proof. The person decides (decision 6).
import { extractJson } from '../../meeting-assistant/decision-prompt.js';
import { judgeOutput } from '../judgement.js';
import { MAX_BASED_ON_CHARS, MAX_SUGGESTION_CHARS, type CoachLine } from './prompt.js';

export interface CoachSuggestion { text: string; competencyId: string; basedOn: string | null }
export type DropCode = 'malformed' | 'off-kit' | 'too-long' | 'unsourced' | 'judges' | 'personal';
export type ParseResult = { ok: true; suggestion: CoachSuggestion } | { ok: false; code: DropCode };

/**
 * Rating, ranking, comparing, recommending, or judging an answer. Narrow on purpose: the kits themselves say "rate
 * limiter", "who did you hire first" and "compare the two approaches", which are about the work and must pass.
 */
export const JUDGES: readonly RegExp[] = [
  /\b(?:rate|score|rank|grade|place)\s+(?:him|her|them|the candidate|this answer|that answer|their answer|the answer)\b/i,
  /\b(?:i'?d|i would|i'?ll|we should|you should|would)\s+(?:rate|score|rank|grade)\b/i,
  /\b(?:rating|score|ranking|grade|level)\s+(?:of|for)\s+(?:the candidate|them|him|her)\b/i,
  /\b(?:a|an|at)\s+(?:[1-4]|one|two|three|four)\s+on\b|\bon the rubric\b|\bout of (?:10|ten|5|five|4|four)\b|\b\d+\s*\/\s*(?:4|5|10)\b/i,
  /\b(?:recommend|recommends|recommended|recommendation)\b/i,
  /\b(?:should|would|i'?d)\s+(?:not\s+)?(?:hire|advance|reject|pass on)\b|\bworth hiring\b|\bmove (?:them|him|her) forward\b|\bno-go\b|\bgo\/no-go\b|\bstrong (?:yes|no)\b/i,
  /\b(?:other candidates?|than the other candidate|the best candidate|best of the candidates)\b/i,
  /\b(?:strong|weak|poor|great|good|bad|excellent|impressive|disappointing|solid|mediocre|vague|shallow)\s+(?:answer|response|candidate|fit|performance|showing)\b/i,
  /\b(?:red flag|green flag|culture fit|cultural fit|not a fit|good fit|bad fit)\b/i,
];

/**
 * The candidate's person rather than their words: looks, voice, manner, and protected or private traits. Also narrow
 * where a word has a technical sense ("race condition", "health check", "regular expression", "code generation").
 */
export const PERSONAL: readonly RegExp[] = [
  /\b(?:face|facial|appearance|body language|eye contact|smile|smiled|smiling|dressed|clothes|outfit|looks? (?:nervous|tired|young|old|confident|unsure))\b/i,
  /\b(?:voice|tone|accent|stutter\w*|stammer\w*|mumble\w*|(?:sounds?|sounded) (?:nervous|unsure|confident|hesitant|tired))\b/i,
  /\b(?:nervous|nervousness|anxious|hesitant|hesitation|enthusias\w*|personality|demeanou?r|attitude|seems? (?:confident|unsure|tired))\b/i,
  /\b(?:age|aged|how old|young|elderly|born in)\b/i,
  /\b(?:gender|male|female|pregnan\w*|maternity|paternity|married|marital|spouse|husband|wife|your (?:kids|children|family)|have (?:kids|children))\b/i,
  /\brace\b(?!\s+conditions?)|\b(?:racial|ethnic\w*|nationality|native speaker|where are you (?:originally )?from|citizenship|religio\w*|church|mosque|synagogue|faith)\b/i,
  /\b(?:your health|health (?:condition|issue|problem)s?|illness|disabilit\w*|disabled|medical|diagnos\w*|sick leave)\b/i,
];

export type GuardCode = 'judges' | 'personal';

/**
 * The first rule the text breaks, or null when it breaks none: the lists above, then the judgement detector
 * (judgement.ts `judgeOutput`: the wider rules on normalised text, and text that does not read as English).
 */
export function guardSuggestion(text: string): GuardCode | null {
  if (JUDGES.some((r) => r.test(text))) return 'judges';
  if (PERSONAL.some((r) => r.test(text))) return 'personal';
  return judgeOutput(text);
}

const KEYS = ['text', 'competencyId', 'basedOn'];
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** For finding a quote: lower case, quotes and dashes unified, punctuation at the ends and ellipses removed. */
const norm = (s: string): string => squash(s.toLowerCase().replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…|\.\.\./g, ' '))
  .replace(/^["'\s]+|["'\s.,;:!?]+$/g, '');

/** Is `quote` a piece of one of the lines (whitespace, case and quotation marks aside)? */
export function quotedFrom(quote: string, lines: readonly CoachLine[]): boolean {
  const q = norm(quote);
  return q.length > 0 && lines.some((l) => norm(l.text).includes(q));
}

/** Is `quote` a piece of one line of the code the coach was shown (the pad's or the output's)? */
export function quotedFromCode(quote: string, codeLines: readonly string[]): boolean {
  const q = norm(quote);
  return q.length > 0 && codeLines.some((l) => norm(l).includes(q));
}

/**
 * The model's text read as one suggestion, checked against the kit's competencies and the transcript it was given, and
 * in a technical round the lines of code it was shown (`codeLines`, prompt.ts `codeLinesOf`).
 */
export function parseCoachAnswer(raw: string | null, ctx: { competencyIds: readonly string[]; lines: readonly CoachLine[]; codeLines?: readonly string[] }): ParseResult {
  const json = raw === null ? null : extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'malformed' };
  const o = json as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return { ok: false, code: 'malformed' };
  const { text, competencyId, basedOn } = o;
  if (typeof text !== 'string' || typeof competencyId !== 'string' || (basedOn !== null && typeof basedOn !== 'string')) return { ok: false, code: 'malformed' };
  const t = squash(text);
  if (!t) return { ok: false, code: 'malformed' };
  if (!ctx.competencyIds.includes(competencyId)) return { ok: false, code: 'off-kit' };
  if (t.length > MAX_SUGGESTION_CHARS) return { ok: false, code: 'too-long' };
  // A quote with no word in it (".", "…") is no quote; leading punctuation is trimmed.
  const trimmed = basedOn === null ? '' : squash(basedOn).replace(/^[\s"'.,;:!?…-]+/, '');
  const quote = /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : null;
  if (quote !== null && quote.length > MAX_BASED_ON_CHARS) return { ok: false, code: 'too-long' };
  if (quote && !quotedFrom(quote, ctx.lines) && !quotedFromCode(quote, ctx.codeLines ?? [])) return { ok: false, code: 'unsourced' };
  const guard = guardSuggestion(t);
  if (guard) return { ok: false, code: guard };
  return { ok: true, suggestion: { text: t, competencyId, basedOn: quote || null } };
}

// How Milo's private answer is read (docs/interviews-tenant-plan.md decisions 6 and 8; row I3.6; contract E0).
//
// The answer is strict JSON, exactly `{ answer, sources: [{ seq, quote }] }`. Anything else is `malformed` and dropped
// whole. A well-formed answer is still dropped when:
//   too-long    the answer is longer than MAX_ANSWER_CHARS or MAX_ANSWER_SENTENCES sentences, there are more than
//               MAX_SOURCES sources, or a quote is longer than MAX_QUOTE_CHARS;
//   unsourced   a source names a line that was not given, its quote is not found in THAT line (`quotedFrom` over the one
//               line: stricter than anywhere in the transcript), an answer other than NOT_SAID has no source, or NOT_SAID
//               comes with sources;
//   judges      the answer rates, scores, ranks, compares or recommends, or calls an answer good or bad (the coach's
//               `guardSuggestion`, JUDGES);
//   personal    the answer speaks of the candidate's person rather than their words (PERSONAL).
// The guard reads the answer, not the quotes: a quote is the candidate's own words, already found in the transcript.
// A dropped answer is logged as its code only; its text is never kept or logged.
import { extractJson } from '../../meeting-assistant/decision-prompt.js';
import { guardSuggestion, quotedFrom } from '../coach/parse.js';
import type { CoachLine } from '../coach/prompt.js';
import { MAX_ANSWER_CHARS, MAX_ANSWER_SENTENCES, MAX_QUOTE_CHARS, MAX_SOURCES, NOT_SAID } from './prompt.js';

export interface AskSource { seq: number; quote: string }
export interface AskAnswer { answer: string; sources: AskSource[] }
export type AskDropCode = 'malformed' | 'too-long' | 'unsourced' | 'judges' | 'personal';
export type AskParseResult = { ok: true; value: AskAnswer } | { ok: false; code: AskDropCode };

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const same = (a: string, b: string): boolean => squash(a).toLowerCase() === squash(b).toLowerCase();

/** Sentences, counted by their ending marks (a trailing piece without one counts too). */
export function sentenceCount(text: string): number {
  const t = squash(text);
  if (!t) return 0;
  return t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0).length;
}

export function parseAskAnswer(raw: string | null, lines: readonly CoachLine[]): AskParseResult {
  const json = raw === null ? null : extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'malformed' };
  const o = json as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('answer') || !keys.includes('sources')) return { ok: false, code: 'malformed' };
  if (typeof o['answer'] !== 'string' || !Array.isArray(o['sources'])) return { ok: false, code: 'malformed' };
  const answer = squash(o['answer']);
  if (!answer) return { ok: false, code: 'malformed' };
  const sources: AskSource[] = [];
  for (const s of o['sources'] as unknown[]) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, code: 'malformed' };
    const r = s as Record<string, unknown>;
    const k = Object.keys(r);
    if (k.length !== 2 || !Number.isInteger(r['seq']) || typeof r['quote'] !== 'string') return { ok: false, code: 'malformed' };
    sources.push({ seq: r['seq'] as number, quote: squash(r['quote'] as string) });
  }
  if (answer.length > MAX_ANSWER_CHARS || sentenceCount(answer) > MAX_ANSWER_SENTENCES || sources.length > MAX_SOURCES) return { ok: false, code: 'too-long' };
  if (sources.some((s) => s.quote.length > MAX_QUOTE_CHARS)) return { ok: false, code: 'too-long' };
  const notSaid = same(answer, NOT_SAID);
  if (notSaid) return sources.length ? { ok: false, code: 'unsourced' } : { ok: true, value: { answer: NOT_SAID, sources: [] } };
  if (!sources.length) return { ok: false, code: 'unsourced' };
  for (const s of sources) {
    const line = lines.find((l) => l.seq === s.seq);
    if (!line || !quotedFrom(s.quote, [line])) return { ok: false, code: 'unsourced' };
  }
  const guard = guardSuggestion(answer);
  if (guard) return { ok: false, code: guard };
  return { ok: true, value: { answer, sources } };
}

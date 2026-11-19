// `pad_add_tests`: the cases a call carries, checked, rendered and placed at the end of the pad (docs/interviews-tenant-plan.md,
// "Milo's interview tools"). Pure.
//
// The live session's background agent writes the cases (each one's arguments and expected value as JSON). Here they are read as
// data (testcases/parse.ts: bounded, deduplicated, not already in the pad), checked against the question's hidden reference
// (references.ts: a case whose expected value the reference disagrees with is dropped, never written), and written as code by
// the server (testcases/render.ts) in the pad's language at the moment of writing. A question with no reference gets inputs
// only: the expected values are the coder's to fill in, and Milo's line says so.
import type { KitQuestion, PadLanguage } from '../types.js';
import { parseToolCases } from '../testcases/parse.js';
import { functionOf, renderTestCases, type TestCase } from '../testcases/render.js';
import { referenceFor } from './references.js';

/** At most this many cases in one call (the catalogue's schema says the same). */
export const MAX_TEST_CASES = 20;
/** At most this many cases are read from one call: the number asked for and a few spares (the first `count` that pass are kept). */
export const MAX_OFFERED_CASES = 24;

/**
 * The question the pad is working on: the round's question whose starter function the pad defines in its language, else the
 * one whose starter function the pad names in any language, else the round's first coding question.
 */
export function questionForPad(questions: readonly KitQuestion[], pad: string, language: PadLanguage): KitQuestion | null {
  const fnOf = (q: KitQuestion, lang: PadLanguage) => (q.starter?.[lang] ? functionOf(q.starter[lang]!, lang) : null);
  const here = functionOf(pad, language);
  const exact = here ? questions.find((q) => fnOf(q, language) === here) : undefined;
  if (exact) return exact;
  const named = questions.find((q) => Object.keys(q.starter ?? {}).some((l) => { const f = fnOf(q, l as PadLanguage); return !!f && pad.includes(`${f}(`); }));
  return named ?? questions[0] ?? null;
}

export type TestCasesMade = { ok: true; block: string; count: number; checked: boolean; dropped: number; needsVerdict: boolean } | { ok: false };

/** A string longer than this in a case could describe the algorithm: the batch then goes to the solution check (index.ts). */
export const MAX_PLAIN_CASE_STRING = 24;
/** More than this many characters of strings across a batch could spell it out in short pieces (review 2, item 3). */
export const MAX_PLAIN_BATCH_CHARS = 48;

/** Every string in a case value (at any depth, keys too), into `out`. */
function stringsIn(v: unknown, out: string[], depth = 0): void {
  if (typeof v === 'string') { out.push(v); return; }
  if (depth > 6 || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) stringsIn(x, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); stringsIn(x, out, depth + 1); }
}

/**
 * Could the batch's strings carry the algorithm? Yes when any string is longer than MAX_PLAIN_CASE_STRING or has whitespace in
 * it (words), or when the batch's strings total more than MAX_PLAIN_BATCH_CHARS: six short phrases spell it out as well as one
 * long one (review 2, item 3). Such a batch goes to the solution check.
 */
export function needsVerdict(cases: readonly TestCase[]): boolean {
  const strings: string[] = [];
  for (const c of cases) { stringsIn(c.args, strings); stringsIn(c.expected, strings); }
  let total = 0;
  for (const t of strings) {
    if (t.length > MAX_PLAIN_CASE_STRING || /\s/.test(t)) return true;
    total += t.length;
  }
  return total > MAX_PLAIN_BATCH_CHARS;
}

/** The block for the call's `cases` against the pad as it is: checked cases when the question has a reference, else inputs only. */
export function testCasesFor(cases: unknown, at: { pad: string; language: PadLanguage; question: KitQuestion | null; fn: string | null; count?: unknown }): TestCasesMade {
  // The number asked for (the call's `count`), within 1 and MAX_TEST_CASES; none said: up to MAX_TEST_CASES.
  const count = typeof at.count === 'number' && Number.isInteger(at.count) ? Math.max(1, Math.min(MAX_TEST_CASES, at.count)) : MAX_TEST_CASES;
  const parsed = parseToolCases(cases, { pad: at.pad, max: MAX_OFFERED_CASES });
  if (!parsed.ok) return { ok: false };
  const reference = at.question ? referenceFor(at.question.id) : null;
  const kept: TestCase[] = reference
    ? parsed.cases.filter((c) => reference.agrees(c.args, c.expected) === true)
    : parsed.cases.map((c) => ({ args: c.args }));
  // The spares fill in for any dropped (already in the pad, or not what the reference returns): the first `count` stay.
  kept.splice(count);
  if (!kept.length) return { ok: false };
  return { ok: true, block: renderTestCases(kept, at.language, at.fn), count: kept.length, checked: reference !== null, dropped: parsed.cases.length - kept.length, needsVerdict: needsVerdict(kept) };
}

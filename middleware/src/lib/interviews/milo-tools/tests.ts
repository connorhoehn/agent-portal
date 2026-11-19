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

export type TestCasesMade = { ok: true; block: string; count: number; checked: boolean; dropped: number; longStrings: boolean } | { ok: false };

/** A string longer than this in a case could describe the algorithm: the batch then goes to the solution check (index.ts). */
export const MAX_PLAIN_CASE_STRING = 24;

/** Does a case value carry a string longer than MAX_PLAIN_CASE_STRING (at any depth, keys too)? */
export function hasLongString(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.length > MAX_PLAIN_CASE_STRING;
  if (depth > 6 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasLongString(x, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.length > MAX_PLAIN_CASE_STRING || hasLongString(x, depth + 1));
}

/** The block for the call's `cases` against the pad as it is: checked cases when the question has a reference, else inputs only. */
export function testCasesFor(cases: unknown, at: { pad: string; language: PadLanguage; question: KitQuestion | null; fn: string | null }): TestCasesMade {
  const parsed = parseToolCases(cases, { pad: at.pad, max: MAX_TEST_CASES });
  if (!parsed.ok) return { ok: false };
  const reference = at.question ? referenceFor(at.question.id) : null;
  const kept: TestCase[] = reference
    ? parsed.cases.filter((c) => reference.agrees(c.args, c.expected) === true)
    : parsed.cases.map((c) => ({ args: c.args }));
  if (!kept.length) return { ok: false };
  return { ok: true, block: renderTestCases(kept, at.language, at.fn), count: kept.length, checked: reference !== null, dropped: parsed.cases.length - kept.length, longStrings: kept.some((c) => hasLongString(c.args) || hasLongString(c.expected)) };
}

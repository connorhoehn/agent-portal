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

export type TestCasesMade = { ok: true; block: string; count: number; checked: boolean; unchecked: number; dropped: number; needsVerdict: boolean; missing: string[]; assumed: boolean } | { ok: false };

/** At most this many asked-for kinds of case are read from one call. */
export const MAX_REQUESTED = 6;
const sameKind = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
/**
 * Kinds of case found in the request's own words, checked by the shape of a case, not by the writer's labels (film 5, take 1:
 * the writer asked for "an empty array and duplicates" wrote neither label nor an empty case). `make`: the kind built from
 * another case's arguments when the writer wrote none (the first list argument emptied, or its first item repeated).
 */
interface ShapeKind { label: string; said: RegExp; has: (args: unknown[]) => boolean; make: (args: unknown[]) => unknown[] | null }
const listAt = (args: unknown[]): number => args.findIndex((x) => Array.isArray(x));
export const SHAPE_KINDS: readonly ShapeKind[] = [
  { label: 'an empty input', said: /\bempty\b/i,
    has: (a) => a.some((x) => (Array.isArray(x) && x.length === 0) || x === ''),
    make: (a) => { const i = listAt(a); return i < 0 ? null : a.map((x, j) => (j === i ? [] : x)); } },
  { label: 'duplicates', said: /\bduplicat|\brepeated\b|\bsame (?:number|value)/i,
    has: (a) => a.some((x) => Array.isArray(x) && new Set(x.map((v) => JSON.stringify(v))).size < x.length),
    make: (a) => { const i = listAt(a); const l = i < 0 ? [] : (a[i] as unknown[]); return l.length ? a.map((x, j) => (j === i ? [...l, l[0]] : x)) : null; } },
];

/** The kinds of case the asker named (the call's `requested`): bounded, trimmed, deduplicated. */
export function requestedOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim() || out.some((o) => sameKind(o, x))) continue;
    out.push(x.trim().slice(0, 60));
    if (out.length >= MAX_REQUESTED) break;
  }
  return out;
}

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
export function testCasesFor(cases: unknown, at: { pad: string; language: PadLanguage; question: KitQuestion | null; fn: string | null; count?: unknown; requested?: unknown; request?: unknown }): TestCasesMade {
  // The number asked for (the call's `count`), within 1 and MAX_TEST_CASES; none said: up to MAX_TEST_CASES.
  const count = typeof at.count === 'number' && Number.isInteger(at.count) ? Math.max(1, Math.min(MAX_TEST_CASES, at.count)) : MAX_TEST_CASES;
  const parsed = parseToolCases(cases, { pad: at.pad, max: MAX_OFFERED_CASES });
  if (!parsed.ok) return { ok: false };
  const reference = at.question ? referenceFor(at.question.id) : null;
  const requested = requestedOf(at.requested);
  const said = typeof at.request === 'string' ? at.request : '';
  const requestedCase = (args: unknown[], covers: string): TestCase => {
    const extension = reference?.assumption?.(args);
    // Do not override an explicitly different requested no-pair convention.
    const conflicts = /\b(?:return|expect|use|throw|raise)\s+(?:null|none|false|-1|an?\s+(?:error|exception))\b/i.test(said);
    return extension && !conflicts
      ? { args, covers, expected: extension.expected, assumption: extension.note }
      : { args, covers, edge: true };
  };
  const asked = (c: TestCase): string | null => (c.covers ? requested.find((r) => sameKind(r, c.covers!)) ?? null : null);
  // Named out-of-contract inputs get an explicit assumption where supported, otherwise an unresolved edge input.
  // A wrong expected value for an in-contract case is still dropped.
  const all: TestCase[] = [];
  for (const c of parsed.cases) {
    const kind = asked(c);
    const verdict = reference ? reference.agrees(c.args, c.expected) : null;
    if (!reference) all.push({ args: c.args, ...(kind ? { covers: kind } : {}) });
    else if (verdict === true) all.push({ args: c.args, expected: c.expected, ...(kind ? { covers: kind } : {}) });
    else if (kind && verdict === null) all.push(requestedCase(c.args, kind));
  }
  // The first case for each asked-for kind stays whatever the count; the spares fill the rest (the first `count` in all).
  const firsts = requested.map((r) => all.find((c) => c.covers === r)).filter((c): c is TestCase => !!c);
  // The kinds the request's own words name, by shape: a kept case of that shape, else one the reference set aside (an edge
  // input), else one built from the first case's arguments (an edge input).
  for (const k of SHAPE_KINDS.filter((x) => x.said.test(said))) {
    if (firsts.some((c) => k.has(c.args))) continue;
    const kept = all.find((c) => !firsts.includes(c) && k.has(c.args));
    if (kept) { firsts.push(kept); continue; }
    const args = parsed.cases.find((c) => k.has(c.args))?.args ?? (parsed.cases[0] ? k.make(parsed.cases[0].args) : null);
    if (!args || all.some((c) => JSON.stringify(c.args) === JSON.stringify(args))) continue;
    const edge = requestedCase(args, k.label);
    all.push(edge); firsts.push(edge);
  }
  const kept = [...firsts, ...all.filter((c) => !firsts.includes(c)).slice(0, Math.max(0, count - firsts.length))];
  if (!kept.length) return { ok: false };
  const missing = requested.filter((r) => !firsts.some((c) => c.covers === r));
  const unchecked = kept.filter((c) => c.edge || c.expected === undefined).length;
  return { ok: true, block: renderTestCases(kept, at.language, at.fn), count: kept.length, checked: reference !== null && unchecked === 0, unchecked, dropped: Math.max(0, parsed.cases.length - kept.length), needsVerdict: needsVerdict(kept), missing, assumed: kept.some((c) => !!c.assumption) };
}

// Reading the test cases a `pad_add_tests` call carries (docs/interviews-tenant-plan.md, "Milo's interview tools"). Pure. What
// is kept is data of bounded size and nothing else; the rest is dropped without a word.
//
//   * a case is `{ args: '<JSON array>', expected: '<JSON>' }`, each readable JSON: at most MAX_ARGS arguments of JSON values, no
//     value deeper than MAX_DEPTH, no list longer than MAX_LIST, no string longer than MAX_STRING characters (room for an input,
//     not for prose), and the case written out at most MAX_CASE_CHARS characters;
//   * a case whose call is already in the pad (the candidate's own, or Milo's earlier) and a repeat within the call are
//     dropped; the first `max` of the rest are kept. None left is `empty`.
import { pythonLiteral, scriptLiteral, type TestCase } from './render.js';

export const MAX_ARGS = 6;
export const MAX_DEPTH = 3;
export const MAX_LIST = 50;
export const MAX_STRING = 80;
export const MAX_CASE_CHARS = 400;

export type TestCaseParse = { ok: true; cases: TestCase[] } | { ok: false; code: 'unreadable' | 'empty' };

function boundedValue(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= MAX_STRING;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.length <= MAX_LIST && v.every((x) => boundedValue(x, depth + 1));
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length <= MAX_LIST && entries.every(([k, x]) => k.length <= MAX_STRING && boundedValue(x, depth + 1));
  }
  return false;
}

/** The arguments as each notation writes them, so a call already in the pad is found whatever the language. */
const callForms = (args: readonly unknown[]): string[] => [args.map(pythonLiteral).join(', '), args.map(scriptLiteral).join(', ')];
const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * The cases a `pad_add_tests` call carries (`[{ args: '<JSON array>', expected: '<JSON>' }]`, catalogue.ts), as data: each
 * readable, bounded, not a duplicate and not a call the pad already makes; at most `max`. Unreadable ones are dropped.
 */
export function parseToolCases(list: unknown, opts: { pad: string; max: number }): TestCaseParse {
  if (!Array.isArray(list)) return { ok: false, code: 'unreadable' };
  const json = (v: unknown): { ok: true; value: unknown } | { ok: false } => {
    if (typeof v !== 'string' || v.length > MAX_CASE_CHARS) return { ok: false };
    try { return { ok: true, value: JSON.parse(v) }; } catch { return { ok: false }; }
  };
  const pad = squash(opts.pad);
  const seen = new Set<string>();
  const kept: TestCase[] = [];
  for (const c of list) {
    if (kept.length >= opts.max) break;
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const a = json((c as Record<string, unknown>)['args']);
    const e = json((c as Record<string, unknown>)['expected']);
    if (!a.ok || !e.ok) continue;
    const args = a.value;
    const expected = e.value;
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((x) => boundedValue(x)) || !boundedValue(expected)) continue;
    const key = JSON.stringify(args);
    if (seen.has(key) || key.length + JSON.stringify(expected).length > MAX_CASE_CHARS) continue;
    // A call `f(<args>)` in any notation, or a block's row `[[<args>], …]` / `[<args>],`, is already in the pad.
    if (args.length && (callForms(args).some((f) => pad.includes(`(${squash(f)})`)) || pad.includes(`[[${squash(callForms(args)[1]!)}],`))) continue;
    seen.add(key);
    const covers = (c as Record<string, unknown>)['covers'];
    kept.push({ args, expected, ...(typeof covers === 'string' && covers.trim() ? { covers: covers.trim().slice(0, 60) } : {}) });
  }
  return kept.length ? { ok: true, cases: kept } : { ok: false, code: 'empty' };
}

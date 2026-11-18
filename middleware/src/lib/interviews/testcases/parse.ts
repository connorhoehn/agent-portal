// Reading the model's test cases (docs/interviews-tenant-plan.md, "Milo writes test cases"). Pure. The same for the model and
// the stand-in. What is kept is data of bounded size and nothing else; the rest is dropped without a word.
//
//   * the answer is one JSON object `{ cases: [...] }` (a code fence around it is allowed); anything else is `unreadable`;
//   * a case is `{ args: [...], expected }` with at most MAX_ARGS arguments of JSON values: no value deeper than MAX_DEPTH,
//     no list longer than MAX_LIST, no string longer than MAX_STRING characters (room for an input, not for prose), and the
//     case written out at most MAX_CASE_CHARS characters;
//   * a case whose call is already in the pad (the candidate's own, or Milo's earlier) and a repeat within the answer are
//     dropped; the first `count` of the rest are kept. None left is `empty`.
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

export function parseTestCases(raw: string | null, opts: { pad: string; count: number }): TestCaseParse {
  if (!raw) return { ok: false, code: 'unreadable' };
  const body = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, code: 'unreadable' }; }
  const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)['cases'] : undefined;
  if (!Array.isArray(list)) return { ok: false, code: 'unreadable' };
  const pad = squash(opts.pad);
  const seen = new Set<string>();
  const kept: TestCase[] = [];
  for (const c of list) {
    if (kept.length >= opts.count) break;
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const { args, expected } = c as Record<string, unknown>;
    if (!Array.isArray(args) || args.length > MAX_ARGS || !('expected' in (c as object))) continue;
    if (!args.every((a) => boundedValue(a)) || !boundedValue(expected)) continue;
    const key = JSON.stringify(args);
    if (seen.has(key) || key.length + JSON.stringify(expected).length > MAX_CASE_CHARS) continue;
    // A call `f(<args>)` in any notation, or a scripted block's row `[[<args>], …]`, is already in the pad.
    if (args.length && (callForms(args).some((f) => pad.includes(`(${squash(f)})`)) || pad.includes(`[[${squash(callForms(args)[1]!)}],`))) continue;
    seen.add(key);
    kept.push({ args: structuredClone(args), expected: structuredClone(expected) });
  }
  return kept.length ? { ok: true, cases: kept } : { ok: false, code: 'empty' };
}

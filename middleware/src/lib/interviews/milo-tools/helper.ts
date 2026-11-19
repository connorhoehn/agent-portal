// `pad_add_helper`: a helper someone asked for, at the top of the pad (docs/interviews-tenant-plan.md, "Milo's interview tools").
//
// The owner, 18 November: "Milo can use AI to write it in any language." The live session's background agent writes the code
// and passes it as the call's arguments; this module decides what reaches the pad:
//
//   1. a standard-library import when the pad's language has one for what was asked (an LRU cache in Python is
//      `from functools import lru_cache`): the import, not the code (`builtinFor`);
//   2. otherwise the code, when it passes the checks here, all of them deterministic: bounded (MAX_HELPER_LINES lines,
//      MAX_HELPER_CHARS characters), written in the pad's language AT THE MOMENT OF WRITING (never the model's idea of it), and
//      not defining the question's own function (its name from the kit's starter in that language);
//   3. for a CANDIDATE's request, one more check: is this helper the kit question's answer? A yes/no verdict from the
//      interviews text model against the question (verdict.ts), failing closed. The lead runs the interview, so the lead's
//      request needs no verdict; the deterministic checks still apply.
//
// The line Milo must not cross is the question's own answer, not "logic". The block is marked as Milo's at both ends, so the
// candidate, the panel and the record can tell it from the candidate's own code.
import { lineTooLong } from '../pad-text.js';
import type { KitQuestion, PadLanguage } from '../types.js';
import { COMMENT, functionOf } from '../testcases/render.js';
import { afterImports, checkedImportLines } from './imports.js';

export const MAX_HELPER_LINES = 60;
export const MAX_HELPER_CHARS = 6000;


/** Standard-library imports that ARE what was asked for, by language: the import goes in instead of written code. */
const BUILTINS: Readonly<Partial<Record<PadLanguage, ReadonlyArray<{ asked: RegExp; line: string }>>>> = {
  python: [
    { asked: /\blru\b|least recently used|memoi[sz]/i, line: 'from functools import lru_cache' },
    { asked: /\b(?:heap|priority queue|min-?heap|max-?heap)\b/i, line: 'import heapq' },
    { asked: /\bdeque\b|double-?ended queue/i, line: 'from collections import deque' },
    { asked: /\bcounter\b|count(?:ing)? (?:map|dict)/i, line: 'from collections import Counter' },
    { asked: /\bdefault ?dict\b/i, line: 'from collections import defaultdict' },
    { asked: /\bbisect\b|binary search/i, line: 'import bisect' },
  ],
  java: [
    { asked: /\b(?:heap|priority queue)\b/i, line: 'import java.util.PriorityQueue;' },
    { asked: /\bdeque\b|double-?ended queue/i, line: 'import java.util.ArrayDeque;' },
  ],
  cpp: [
    { asked: /\b(?:heap|priority queue)\b/i, line: '#include <queue>' },
    { asked: /\bdeque\b/i, line: '#include <deque>' },
  ],
  go: [{ asked: /\b(?:heap|priority queue)\b/i, line: 'import "container/heap"' }],
};

/** The standard-library import that is what was asked for in `language`, or null when there is none (the code is written). */
export function builtinFor(what: string, language: PadLanguage): string | null {
  const hit = (BUILTINS[language] ?? []).find((b) => b.asked.test(what));
  return hit && checkedImportLines([hit.line], language) ? hit.line : null;
}

/** Signs a piece of code is NOT in a language (another language's tell): one is enough to refuse it. Whitespace here is spaces
 * and tabs only, so no run crosses a newline (review 2, item 1). */
const FOREIGN: Readonly<Record<PadLanguage, RegExp>> = {
  // A line ending in `;` is not Python; one ending in `{` may open a dict, so it is not counted (review 1, minor).
  python: /^[ \t]*(?:function[ \t]|const[ \t]|let[ \t]|var[ \t]|public[ \t]|private[ \t]|func[ \t]|#include|import[ \t]+java)|;[ \t]*$/m,
  // A Python block opener (`if x:`, `def f():`) is not JavaScript; a switch's `case 1:` and `default:` are.
  javascript: /^[ \t]*(?:def[ \t]|public[ \t]+class|private[ \t]|func[ \t]|#include|from[ \t]+\w+[ \t]+import|(?:if|elif|else|for|while|try|except|with)\b[^{\n]*:[ \t]*$)|\bself\./m,
  typescript: /^[ \t]*(?:def[ \t]|public[ \t]+class|func[ \t]|#include|from[ \t]+\w+[ \t]+import)|\bself\./m,
  java: /^[ \t]*(?:def[ \t]|function[ \t]|func[ \t]|#include|const[ \t]|let[ \t])/m,
  go: /^[ \t]*(?:def[ \t]|function[ \t]|class[ \t]|public[ \t]|#include|const[ \t]+\w+[ \t]*=[ \t]*require)/m,
  swift: /^[ \t]*(?:def[ \t]|function[ \t]|public[ \t]+static[ \t]+void|#include|package[ \t])/m,
  cpp: /^[ \t]*(?:def[ \t]|function[ \t]|func[ \t]|package[ \t]|import[ \t])/m,
};
/** A sign the code IS in the language: something it declares. */
const NATIVE: Readonly<Record<PadLanguage, RegExp>> = {
  python: /^[ \t]*(?:def|class)[ \t]+\w+/m,
  javascript: /^[ \t]*(?:class[ \t]+\w+|function[ \t]+\w+|(?:const|let)[ \t]+\w+[ \t]*=)/m,
  typescript: /^[ \t]*(?:(?:export[ \t]+)?class[ \t]+\w+|function[ \t]+\w+|(?:const|let)[ \t]+\w+[ \t]*[:=]|interface[ \t]+\w+|type[ \t]+\w+[ \t]*=)/m,
  java: /^[ \t]*(?:(?:public|private|protected|static|final)[ \t]+)*(?:class|interface|record)[ \t]+\w+/m,
  go: /^[ \t]*(?:type[ \t]+\w+|func[ \t]+)/m,
  swift: /^[ \t]*(?:(?:final[ \t]+)?class|struct|func|enum)[ \t]+\w+/m,
  cpp: /^[ \t]*(?:template[ \t]*<|class[ \t]+\w+|struct[ \t]+\w+|[\w:<>]+[ \t]+\w+[ \t]*\()/m,
};

/**
 * Does `code` name the question's function `fn` at all? A helper has no reason to: any mention (a definition, an alias such as
 * `two_sum = find_pair` or `const twoSum = findPair;`, an export) is refused (review 1, item 3).
 */
function defines(code: string, fn: string): boolean {
  const n = fn.replace(/[^\w$]/g, '');
  if (!n) return false;
  return code.split(/[^\w$]+/).includes(n);
}

export type HelperCheck =
  | { ok: true; kind: 'import'; line: string }
  | { ok: true; kind: 'code'; code: string }
  | { ok: false; why: 'size' | 'language' | 'entry' | 'empty' };

/**
 * The deterministic checks: an import when one is what was asked, else the code when it is bounded, in `language`, and does not
 * name any of the round's functions (`entry`: one name, every name the starters declare, or null when the round has none).
 */
export function checkHelper(what: string, code: unknown, language: PadLanguage, entry: string | null | readonly string[]): HelperCheck {
  const entries = entry === null ? [] : typeof entry === 'string' ? [entry] : entry;
  const builtin = builtinFor(typeof what === 'string' ? what : '', language);
  if (builtin) return { ok: true, kind: 'import', line: builtin };
  // The size first: no pattern runs over code longer than the bound (a trailing-space pattern alone was quadratic).
  if (typeof code === 'string' && code.length > MAX_HELPER_CHARS) return { ok: false, why: 'size' };
  const text = typeof code === 'string' ? code.replace(/\r\n?/g, '\n').trimEnd() : '';
  if (!text.trim()) return { ok: false, why: 'empty' };
  if (text.split('\n').length > MAX_HELPER_LINES || text.split('\n').some(lineTooLong)) return { ok: false, why: 'size' };
  if (FOREIGN[language].test(text) || !NATIVE[language].test(text)) return { ok: false, why: 'language' };
  if (entries.some((e) => defines(text, e))) return { ok: false, why: 'entry' };
  return { ok: true, kind: 'code', code: text };
}

/** Every function the questions' starters declare, in any language (a round of two questions has two; review 2, item 2). */
export function entriesOf(questions: readonly KitQuestion[]): string[] {
  const out = new Set<string>();
  for (const q of questions) for (const [lang, s] of Object.entries(q.starter ?? {})) { const f = s ? functionOf(s, lang as PadLanguage) : null; if (f) out.add(f); }
  return [...out];
}

/** The question's function in `language`: the one its starter declares there, else null. */
export function entryOf(starter: Partial<Record<PadLanguage, string>> | undefined, language: PadLanguage): string | null {
  const s = starter?.[language];
  return s ? functionOf(s, language) : null;
}

export const HELPER_TITLE = 'Added by Milo';

/** The marked block: Milo's name and what it is at the top, an end marker at the bottom. `what` is cut to a short plain label. */
export function helperBlock(code: string, what: string, language: PadLanguage): string {
  const c = COMMENT[language];
  const label = (typeof what === 'string' ? what : '').replace(/[^\p{L}\p{N} .,'()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'a helper';
  return `${c} --- ${HELPER_TITLE}: ${label} ---\n${code}\n${c} --- end of Milo's helper ---\n`;
}

/** Where the helper goes: after the pad's leading imports (or at the very top), with a blank line after it. */
export function placeHelper(current: string, block: string, language: PadLanguage): { index: number; text: string } {
  const index = afterImports(current, language);
  const lead = index > 0 && !current.slice(0, index).endsWith('\n\n') ? '\n' : '';
  const tail = current.slice(index).startsWith('\n') || index >= current.length ? '' : '\n';
  return { index, text: `${lead}${block}${tail}` };
}

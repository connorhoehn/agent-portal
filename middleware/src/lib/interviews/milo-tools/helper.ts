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
import type { PadLanguage } from '../types.js';
import { functionOf } from '../testcases/render.js';
import { afterImports, checkedImportLines } from './imports.js';

export const MAX_HELPER_LINES = 60;
export const MAX_HELPER_CHARS = 6000;

const COMMENT: Readonly<Record<PadLanguage, string>> = { python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//' };

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

/** Signs a piece of code is NOT in a language (another language's tell): one is enough to refuse it. */
const FOREIGN: Readonly<Record<PadLanguage, RegExp>> = {
  python: /^\s*(?:function\s|const\s|let\s|var\s|public\s|private\s|func\s|#include|import\s+java)|[;{]\s*$/m,
  javascript: /^\s*(?:def\s|public\s+class|private\s|func\s|#include|from\s+\w+\s+import)|\bself\.|:\s*$/m,
  typescript: /^\s*(?:def\s|public\s+class|func\s|#include|from\s+\w+\s+import)|\bself\./m,
  java: /^\s*(?:def\s|function\s|func\s|#include|const\s|let\s)/m,
  go: /^\s*(?:def\s|function\s|class\s|public\s|#include|const\s+\w+\s*=\s*require)/m,
  swift: /^\s*(?:def\s|function\s|public\s+static\s+void|#include|package\s)/m,
  cpp: /^\s*(?:def\s|function\s|func\s|package\s|import\s)/m,
};
/** A sign the code IS in the language: something it declares. */
const NATIVE: Readonly<Record<PadLanguage, RegExp>> = {
  python: /^\s*(?:def|class)\s+\w+/m,
  javascript: /^\s*(?:class\s+\w+|function\s+\w+|(?:const|let)\s+\w+\s*=)/m,
  typescript: /^\s*(?:(?:export\s+)?class\s+\w+|function\s+\w+|(?:const|let)\s+\w+\s*[:=]|interface\s+\w+|type\s+\w+\s*=)/m,
  java: /^\s*(?:(?:public|private|protected|static|final)\s+)*(?:class|interface|record)\s+\w+/m,
  go: /^\s*(?:type\s+\w+|func\s+)/m,
  swift: /^\s*(?:(?:final\s+)?class|struct|func|enum)\s+\w+/m,
  cpp: /^\s*(?:template\s*<|class\s+\w+|struct\s+\w+|[\w:<>]+\s+\w+\s*\()/m,
};

/** Does `code` define a function or method named `fn`? (any language's declaration form). */
function defines(code: string, fn: string): boolean {
  const n = fn.replace(/[^\w]/g, '');
  if (!n) return false;
  return new RegExp(String.raw`(?:\bdef\s+${n}\s*\(|\bfunction\s+${n}\s*\(|\bfunc\s+${n}\s*\(|\b${n}\s*=\s*(?:function|\()|\b${n}\s*\([^)]*\)\s*(?:->[^:{]*)?[{:]|\b[\w<>\[\]]+\s+${n}\s*\([^)]*\)\s*\{)`).test(code);
}

export type HelperCheck =
  | { ok: true; kind: 'import'; line: string }
  | { ok: true; kind: 'code'; code: string }
  | { ok: false; why: 'size' | 'language' | 'entry' | 'empty' };

/**
 * The deterministic checks: an import when one is what was asked, else the code when it is bounded, in `language`, and does not
 * define the question's function (`entry`, from the kit's starter in that language; null when the round has none).
 */
export function checkHelper(what: string, code: unknown, language: PadLanguage, entry: string | null): HelperCheck {
  const builtin = builtinFor(typeof what === 'string' ? what : '', language);
  if (builtin) return { ok: true, kind: 'import', line: builtin };
  const text = typeof code === 'string' ? code.replace(/\r\n?/g, '\n').replace(/\s+$/, '') : '';
  if (!text.trim()) return { ok: false, why: 'empty' };
  if (text.length > MAX_HELPER_CHARS || text.split('\n').length > MAX_HELPER_LINES) return { ok: false, why: 'size' };
  if (FOREIGN[language].test(text) || !NATIVE[language].test(text)) return { ok: false, why: 'language' };
  if (entry && defines(text, entry)) return { ok: false, why: 'entry' };
  return { ok: true, kind: 'code', code: text };
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

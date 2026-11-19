// `pad_add_import`, and the import half of `pad_add_helper`: standard-library imports at the top of the pad
// (docs/interviews-tenant-plan.md, "Milo's interview tools"). Pure.
//
// The policy is enforced here, on the text, not in the prompt. Each line a call carries is read by the pad language's import
// grammar (`parseImportLine`) into a module and the names it takes; the module must be in that language's standard library
// (an allowlist below) and each name an identifier; then the server writes the import line itself in the language's own form
// (`importLines`). So whatever the model or the person asked for, what reaches the pad is import lines and nothing else: no
// logic, no third-party package, no comment. The language is the pad's at the moment of writing, never the model's idea of it.
//
// Where: at the top of the pad, after what already leads it (a Go package line, a shebang, the imports already there), so the
// new line sits with the others. A line the pad already has is not written again; nothing new means nothing is written.
import { lineTooLong } from '../pad-text.js';
import type { PadLanguage } from '../types.js';

/** At most this many imports in one request. */
export const MAX_IMPORTS = 5;
/** At most this many names from one module. */
export const MAX_NAMES = 8;

/** One import: a module, and the names to take from it (none: the module itself). */
export interface ImportRequest { module: string; names?: string[] }

const PYTHON_STDLIB = new Set(('abc argparse array asyncio base64 bisect builtins calendar cmath collections contextlib copy csv dataclasses '
  + 'datetime decimal enum fractions functools graphlib hashlib heapq io itertools json math numbers operator os pathlib pprint queue random '
  + 're secrets statistics string struct sys textwrap time timeit typing unicodedata uuid collections.abc').split(' '));
const NODE_BUILTINS = new Set('assert buffer crypto events fs os path perf_hooks querystring readline stream string_decoder timers url util zlib'.split(' '));
const JAVA_PACKAGE = /^java(?:x)?\.[a-z]+(?:\.[a-z]+){0,3}$/;
const GO_STDLIB = new Set(('bufio bytes container/heap container/list container/ring errors fmt math math/bits math/rand os sort strconv strings '
  + 'sync time unicode unicode/utf8 slices maps cmp').split(' '));
const SWIFT_MODULES = new Set(['Foundation', 'Dispatch']);
const CPP_HEADERS = new Set(('algorithm array bitset cassert climits cmath cstdint cstdio cstdlib cstring deque functional iomanip iostream '
  + 'iterator limits list map memory numeric optional queue set sstream stack string tuple unordered_map unordered_set utility vector').split(' '));

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const JAVA_CLASS = /^(?:[A-Z][A-Za-z0-9_]{0,63}|\*)$/;

/** The import lines for these requests in `language`, or null when any of them is not a standard-library import. */
export function importLines(requests: readonly ImportRequest[], language: PadLanguage): string[] | null {
  if (!requests.length || requests.length > MAX_IMPORTS) return null;
  const out: string[] = [];
  for (const r of requests) {
    const module = typeof r?.module === 'string' ? r.module.trim() : '';
    const names = Array.isArray(r?.names) ? r.names.map((n) => (typeof n === 'string' ? n.trim() : '')) : [];
    if (!module || names.length > MAX_NAMES) return null;
    const line = lineFor(module, names, language);
    if (!line) return null;
    out.push(line);
  }
  return [...new Set(out)];
}

function lineFor(module: string, names: string[], language: PadLanguage): string | null {
  switch (language) {
    case 'python':
      if (!PYTHON_STDLIB.has(module) || !names.every((n) => IDENT.test(n))) return null;
      return names.length ? `from ${module} import ${names.join(', ')}` : `import ${module}`;
    case 'javascript':
    case 'typescript': {
      const bare = module.replace(/^node:/, '');
      if (!NODE_BUILTINS.has(bare) || !names.every((n) => IDENT.test(n))) return null;
      const alias = bare.replace(/[^A-Za-z0-9_]/g, '_');
      if (language === 'javascript') return names.length ? `const { ${names.join(', ')} } = require("node:${bare}");` : `const ${alias} = require("node:${bare}");`;
      return names.length ? `import { ${names.join(', ')} } from "node:${bare}";` : `import * as ${alias} from "node:${bare}";`;
    }
    case 'java':
      if (!JAVA_PACKAGE.test(module) || !names.every((n) => JAVA_CLASS.test(n))) return null;
      return (names.length ? names : ['*']).map((n) => `import ${module}.${n};`).join('\n');
    case 'go':
      return GO_STDLIB.has(module) && !names.length ? `import "${module}"` : null;
    case 'swift':
      return SWIFT_MODULES.has(module) && !names.length ? `import ${module}` : null;
    case 'cpp':
      return CPP_HEADERS.has(module) && !names.length ? `#include <${module}>` : null;
    default:
      return null;
  }
}

const NAMES = String.raw`([A-Za-z_$][\w$]*(?: ?, ?[A-Za-z_$][\w$]*)*)`;

/**
 * One import line as a `pad_add_import` call carries it, read by `language`'s import grammar into a module and its names; null
 * when the line is not exactly one import in that language (anything after it, a second statement, a comment: null).
 */
export function parseImportLine(line: unknown, language: PadLanguage): ImportRequest | null {
  const t = typeof line === 'string' ? line.trim().replace(/\s+/g, ' ') : '';
  if (!t || t.length > 120) return null;
  const list = (s: string) => s.split(',').map((n) => n.trim());
  let m: RegExpExecArray | null;
  switch (language) {
    case 'python':
      if ((m = /^from ([A-Za-z_][\w.]*) import ([A-Za-z_]\w*(?: ?, ?[A-Za-z_]\w*)*)$/.exec(t))) return { module: m[1]!, names: list(m[2]!) };
      if ((m = /^import ([A-Za-z_][\w.]*)$/.exec(t))) return { module: m[1]! };
      return null;
    case 'javascript':
      if ((m = new RegExp(String.raw`^const \{ ?${NAMES} ?\} = require\((["'])(?:node:)?([\w/]+)\2\);?$`).exec(t))) return { module: m[3]!, names: list(m[1]!) };
      if ((m = /^const [A-Za-z_$][\w$]* = require\((["'])(?:node:)?([\w/]+)\1\);?$/.exec(t))) return { module: m[2]! };
      if ((m = new RegExp(String.raw`^import \{ ?${NAMES} ?\} from (["'])(?:node:)?([\w/]+)\2;?$`).exec(t))) return { module: m[3]!, names: list(m[1]!) };
      return null;
    case 'typescript':
      if ((m = new RegExp(String.raw`^import \{ ?${NAMES} ?\} from (["'])(?:node:)?([\w/]+)\2;?$`).exec(t))) return { module: m[3]!, names: list(m[1]!) };
      if ((m = /^import \* as [A-Za-z_$][\w$]* from (["'])(?:node:)?([\w/]+)\1;?$/.exec(t))) return { module: m[2]! };
      return null;
    case 'java':
      if ((m = /^import (java(?:x)?(?:\.[a-z]+)+)\.([A-Z]\w*|\*);$/.exec(t))) return { module: m[1]!, names: m[2] === '*' ? [] : [m[2]!] };
      return null;
    case 'go':
      if ((m = /^import "([\w/]+)"$/.exec(t))) return { module: m[1]! };
      return null;
    case 'swift':
      if ((m = /^import (\w+)$/.exec(t))) return { module: m[1]! };
      return null;
    case 'cpp':
      if ((m = /^#include ?<([\w.]+)>$/.exec(t))) return { module: m[1]! };
      return null;
    default:
      return null;
  }
}

/** The lines a call carries, checked and rewritten as the server's own; null when any one is not a standard-library import. */
export function checkedImportLines(lines: unknown, language: PadLanguage): string[] | null {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_IMPORTS) return null;
  const requests = lines.map((l) => parseImportLine(l, language));
  return requests.every((r): r is ImportRequest => r !== null) ? importLines(requests, language) : null;
}

/** A line that may lead the pad: blank, a shebang, a package clause, an import or include, or a comment. */
const LEADING: Readonly<Record<PadLanguage, RegExp>> = {
  python: /^(?:\s*$|#|from\s+\S+\s+import\b|import\s)/,
  javascript: /^(?:\s*$|\/\/|#!|import\s|const\s+\{?[\w\s,]*\}?\s*=\s*require\()/,
  typescript: /^(?:\s*$|\/\/|#!|import\s)/,
  java: /^(?:\s*$|\/\/|package\s|import\s)/,
  go: /^(?:\s*$|\/\/|package\s|import\s)/,
  swift: /^(?:\s*$|\/\/|import\s)/,
  cpp: /^(?:\s*$|\/\/|#include\s)/,
};
const IMPORT_LINE: Readonly<Record<PadLanguage, RegExp>> = {
  python: /^(?:from\s+\S+\s+import\b|import\s)/, javascript: /^(?:import\s|const\s.*=\s*require\()/, typescript: /^import\s/,
  java: /^(?:package|import)\s/, go: /^(?:package|import)\s/, swift: /^import\s/, cpp: /^#include\s/,
};

/** Where the pad's leading import (or package) lines end: the index just after the last one's newline, or 0 when there are none. */
export function afterImports(current: string, language: PadLanguage): number {
  const rows = current.split('\n');
  let after = -1;
  // An import that opens a bracket (Go's `import (`, Python's `from x import (`, a TypeScript `import {` over several lines)
  // runs until the bracket closes: nothing is placed inside the group (review 1, item 4). A Python line ending in `\` runs on
  // to the next (review 2, item 5). One never closed ends the scan.
  let depth = 0;
  let continued = false;
  const backslash = (row: string) => language === 'python' && /\\$/.test(row.replace(/[ \t\r]+$/, ''));
  for (let i = 0; i < rows.length && !lineTooLong(rows[i]!); i += 1) {
    const row = rows[i]!;
    if (depth > 0 || continued) {
      depth += bracketBalance(row, language);
      continued = backslash(row);
      if (depth <= 0 && !continued) { depth = 0; after = i; }
      continue;
    }
    if (!LEADING[language].test(row)) break;
    if (!IMPORT_LINE[language].test(row)) continue;
    const open = bracketBalance(row, language);
    continued = backslash(row);
    if (open > 0) depth = open; else if (!continued) after = i;
  }
  return after < 0 ? 0 : Math.min(rows.slice(0, after + 1).join('\n').length + 1, current.length);
}

/**
 * Opening minus closing round and curly brackets on a line, outside its strings and comments (a `)` in `// see (x)` or in
 * `")"` does not close a group; review 2, item 5). A comment is `#` in Python, else `//` or a `/* … *\/` on the line.
 */
function bracketBalance(row: string, language: PadLanguage): number {
  let n = 0;
  let quote: string | null = null;
  for (let k = 0; k < row.length; k += 1) {
    const ch = row[k]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') k += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (language === 'python' ? ch === '#' : ch === '/' && row[k + 1] === '/') break;
    if (language !== 'python' && ch === '/' && row[k + 1] === '*') {
      const end = row.indexOf('*/', k + 2);
      if (end < 0) break;
      k = end + 1;
      continue;
    }
    if (ch === '(' || ch === '{') n += 1; else if (ch === ')' || ch === '}') n -= 1;
  }
  return n;
}

/**
 * Where the import lines go in `current` and the text to insert there: after the last import (or package) line of the pad's
 * leading lines, else at the very top; lines the pad already has are left out. Null when there is nothing new to write.
 */
export function placeImports(current: string, lines: readonly string[], language: PadLanguage): { index: number; text: string } | null {
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const fresh = lines.flatMap((l) => l.split('\n')).filter((l) => !have.has(l.trim()));
  if (!fresh.length) return null;
  const index = afterImports(current, language);
  // A blank line after the imports unless the pad already starts with one (whitespace up to its first newline).
  const startsBlank = current.slice(0, current.length - current.trimStart().length).includes('\n');
  if (index === 0) return { index: 0, text: `${fresh.join('\n')}\n${current && !startsBlank ? '\n' : ''}` };
  // The last import line ended the pad with no newline after it.
  const lead = current.length < index || !current.slice(0, index).endsWith('\n') ? '\n' : '';
  return { index, text: `${lead}${fresh.join('\n')}\n` };
}

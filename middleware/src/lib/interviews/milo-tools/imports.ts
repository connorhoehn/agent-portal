// `pad_add_import`: Milo adds standard-library imports at the top of the pad (docs/interviews-tenant-plan.md, "Milo's
// interview tools"). Pure.
//
// The policy is enforced here, on the text, not in the prompt: the tool's arguments are a module and the names to import from
// it, never a line of code. Each module must be in the pad language's standard library (an allowlist below), each name an
// identifier, and the server writes the import line itself in the language's own form. So whatever the model or the person
// asked for, what reaches the pad is import lines and nothing else: no solution logic, no third-party package, no comment.
//
// Where: at the top of the pad, after what already leads it (a Go package line, a shebang, the imports already there), so the
// new line sits with the others. A line the pad already has is not written again; nothing new means nothing is written.
import type { PadLanguage } from '../types.js';

/** At most this many imports in one request. */
export const MAX_IMPORTS = 5;
/** At most this many names from one module. */
export const MAX_NAMES = 8;

/** One import as the tool takes it: a module, and the names to take from it (none: the module itself). */
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

/** Why a request was refused, in a sentence Milo can say. */
export const NOT_STANDARD = 'Milo only adds imports from the standard library, at the top of the pad.';

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
      if (language === 'javascript') return names.length ? `const { ${names.join(', ')} } = require("node:${bare}");` : `const ${bare.replace(/[^A-Za-z0-9_]/g, '_')} = require("node:${bare}");`;
      return names.length ? `import { ${names.join(', ')} } from "node:${bare}";` : `import * as ${bare.replace(/[^A-Za-z0-9_]/g, '_')} from "node:${bare}";`;
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

/** A line that already leads the pad: blank, a shebang, a package clause, an import or include, or a comment. */
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

/**
 * Where the import lines go in `current` and the text to insert there: after the last import (or package) line of the pad's
 * leading lines, else at the very top; lines the pad already has are left out. Null when there is nothing new to write.
 */
export function placeImports(current: string, lines: readonly string[], language: PadLanguage): { index: number; text: string } | null {
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const fresh = lines.flatMap((l) => l.split('\n')).filter((l) => !have.has(l.trim()));
  if (!fresh.length) return null;
  const rows = current.split('\n');
  let after = -1;
  for (let i = 0; i < rows.length && LEADING[language].test(rows[i]!); i += 1) if (IMPORT_LINE[language].test(rows[i]!)) after = i;
  if (after < 0) return { index: 0, text: `${fresh.join('\n')}\n${current && !/^\s*\n/.test(current) && language !== 'go' ? '\n' : ''}` };
  const index = rows.slice(0, after + 1).join('\n').length + 1;
  return { index: Math.min(index, current.length), text: `${current.length < index ? '\n' : ''}${fresh.join('\n')}\n` };
}

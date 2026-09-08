// The server's own vocabulary, read from the server's source.
//
// WHY A SECOND WITNESS. A captured response is a LOWER bound on what a field
// can hold, never an upper one. `GET /api/session/me` was captured as an admin,
// so its `role` reads `['admin']` — and a fixture saying `role: 'member'` is
// perfectly correct while sitting outside that set. Checking against the
// capture alone produced 219 findings, almost all of them that shape.
//
// So a value is only called invented when BOTH witnesses disagree with it:
//
//   * the server did not send it at that path in the captured response, AND
//   * the string appears nowhere in the middleware's own source.
//
// `member` fails the second test (the role registry names it), so it is not
// reported. `enterprise` passes both — no response carries it and no server
// file mentions it — which is exactly the state the real bug was in.
//
// TEST FILES ARE NOT WITNESSES. `src/**/__tests__/**` is excluded: a fixture
// that vouches for its own invented string is the failure mode this whole
// mechanism exists to close.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { middlewareRoot } from './paths.js';

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'snapshots']);
/** This directory documents the bug in prose; it must not vouch for it. */
const SKIP_PATH = 'src/mock/core/wire';

function sources(dir: string, rel: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const nextRel = rel ? `${rel}/${name}` : name;
    if (nextRel === SKIP_PATH) continue;
    if (statSync(full).isDirectory()) sources(full, nextRel, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
}

/** Crude but sufficient: drop `//…` and `/*…*\/` so prose cannot vouch. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export interface ServerCorpus {
  /** Every single- or double-quoted string literal in the middleware source. */
  strings: Set<string>;
  /** Every identifier-ish word, so a key name can be looked up. */
  words: Set<string>;
  fileCount: number;
}

let cached: ServerCorpus | null = null;

export function serverCorpus(): ServerCorpus {
  if (cached) return cached;
  const files: string[] = [];
  sources(join(middlewareRoot(), 'src'), 'src', files);

  const strings = new Set<string>();
  const words = new Set<string>();
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf8'));
    // Quoted literals. Template literals are deliberately excluded: an enum is
    // never spelled with backticks, and prose in this repo is.
    for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const value = m[1] ?? m[2];
      if (value !== undefined && value.length > 0) strings.add(value);
    }
    for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) words.add(m[0]);
  }
  return (cached = { strings, words, fileCount: files.length });
}

/** For tests that want a corpus without touching disk. */
export function corpusOf(texts: readonly string[]): ServerCorpus {
  const strings = new Set<string>();
  const words = new Set<string>();
  for (const raw of texts) {
    const text = stripComments(raw);
    for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
      const value = m[1] ?? m[2];
      if (value !== undefined && value.length > 0) strings.add(value);
    }
    for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) words.add(m[0]);
  }
  return { strings, words, fileCount: texts.length };
}

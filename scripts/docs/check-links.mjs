#!/usr/bin/env node
// Fails when a tracked text file names a doc that does not exist:
//   1. any `docs/<path>.md` mention (prose, code comments, Tiltfile), resolved
//      from the repository root, from the file's own directory, and from each
//      ancestor directory (a service's own docs/ folder);
//   2. any relative markdown link `[text](path)` in a tracked .md file.
// History docs quote paths that were true when written and are skipped.
// Docs that the 5 November handover sweep removed (their text is in the
// version history) are listed in removed-docs.txt: comments that cite them
// predate the sweep. A new reference to any other missing doc fails.
//
// The list only shrinks. Its size is pinned by MAX_REMOVED below: the check
// fails when the list holds more entries, and `--write-baseline` refuses to
// add a path that is not already listed unless `--allow-grow` is passed (and
// MAX_REMOVED is then raised in the same, reviewable commit). CI runs the
// check with neither flag.
//
// Run from anywhere: node scripts/docs/check-links.mjs
//   [--write-baseline [--allow-grow]]   rewrite removed-docs.txt
//   [--self-check]                      test the ceiling rules and exit
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Entries removed-docs.txt may hold (its count on 10 November 2026). */
const MAX_REMOVED = 104;

function ceilingError(size, max = MAX_REMOVED) {
  return size > max
    ? `removed-docs.txt lists ${size} paths, more than the ${max} MAX_REMOVED allows; fix the new references instead`
    : null;
}

/** Why `--write-baseline` must not write `missing` over `listed`, or null. */
function baselineRefusal(listed, missing, allowGrow) {
  if (allowGrow) return null;
  const added = [...missing].filter((p) => !listed.has(p)).sort();
  return added.length
    ? `--write-baseline would add ${added.length} path(s) not already listed (${added.join(', ')}); fix the references, or pass --allow-grow and raise MAX_REMOVED`
    : null;
}

if (process.argv.includes('--self-check')) {
  const eq = (a, b, what) => { if (a !== b) { console.error(`check-links self-check: ${what}: got ${a}, want ${b}`); process.exit(1); } };
  const s = (...p) => new Set(p);
  eq(ceilingError(104), null, 'at the ceiling');
  eq(typeof ceilingError(105), 'string', 'over the ceiling');
  eq(ceilingError(3, 2) !== null, true, 'a custom ceiling');
  eq(baselineRefusal(s('a', 'b'), s('a'), false), null, 'shrinking');
  eq(baselineRefusal(s('a', 'b'), s('a', 'b'), false), null, 'unchanged');
  eq(typeof baselineRefusal(s('a', 'b'), s('a', 'b', 'c'), false), 'string', 'growing');
  eq(typeof baselineRefusal(s('a', 'b'), s('a', 'c'), false), 'string', 'swapping one entry for a new one');
  eq(baselineRefusal(s('a'), s('a', 'c'), true), null, 'growing with --allow-grow');
  console.log('check-links self-check: ok');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEXT = /\.(md|mdx|ts|tsx|mjs|cjs|js|jsx|json|ya?ml|sh|py|toml|txt|tf)$|(^|\/)(Tiltfile|Dockerfile[^/]*)$/;
const SKIP_FILE = [
  /^docs\/(next-steps|repo-consolidation|release-order|fail-open-audit|voice-navigator-gaps)\.md$/,
  /^docs\/ux-audit-/,
  /^docs\/spend-map\.md$/,
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)package-lock\.json$/,
  /\/__snapshots__\//,
];
// Placeholders and globs are not real paths.
const ALLOW_TARGET = [/\*/, /<[^>]+>/, /\{[^}]+\}/, /\.\.\./, /YYYY/];

const REMOVED_LIST = join(root, 'scripts/docs/removed-docs.txt');
const removed = new Set(
  existsSync(REMOVED_LIST)
    ? readFileSync(REMOVED_LIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [],
);
const missing = new Set();

const all = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString().split('\0').filter(Boolean);
const files = all.filter((f) => TEXT.test(f) && !SKIP_FILE.some((r) => r.test(f)));

const bad = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
  const dir = dirname(join(root, f));
  text.split('\n').forEach((line, i) => {
    const seen = new Set();
    for (const m of line.matchAll(/(?<![\w./-])((?:\.\.?\/)*docs\/[\w@.\-/]+\.md)\b/g)) {
      const target = m[1];
      if (ALLOW_TARGET.some((r) => r.test(target)) || seen.has(target)) continue;
      seen.add(target);
      const candidates = [];
      for (let d = dir; d.startsWith(root); d = dirname(d)) candidates.push(join(d, target));
      candidates.push(join(root, target));
      if (!candidates.some((c) => existsSync(c))) {
        missing.add(target);
        if (!removed.has(target)) bad.push(`${f}:${i + 1}  ${target}`);
      }
    }
    if (f.endsWith('.md')) {
      for (const m of line.matchAll(/\]\(((?!https?:|mailto:|#|\/\/)[^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (ALLOW_TARGET.some((r) => r.test(target))) continue;
        if (!existsSync(resolve(dir, target))) bad.push(`${f}:${i + 1}  ${target}`);
      }
    }
  });
}

if (process.argv.includes('--write-baseline')) {
  const refusal = baselineRefusal(removed, missing, process.argv.includes('--allow-grow'));
  if (refusal) {
    console.error(`check-links: ${refusal}`);
    process.exit(1);
  }
  writeFileSync(REMOVED_LIST, `# Docs removed in the 5 November handover sweep; see the version history.\n${[...missing].sort().join('\n')}\n`);
  console.log(`check-links: wrote ${missing.size} paths to ${REMOVED_LIST}`);
  if (missing.size > MAX_REMOVED) console.log(`check-links: raise MAX_REMOVED in scripts/docs/check-links.mjs to ${missing.size} in the same commit`);
  process.exit(0);
}

const over = ceilingError(removed.size);
if (over) {
  console.error(`check-links: ${over}`);
  process.exit(1);
}

if (bad.length) {
  console.error(`check-links: ${bad.length} doc path(s) do not resolve:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log(`check-links: ${files.length} files, every doc path resolves`);

#!/usr/bin/env node
'use strict';
//
// Class 3 scanner for scripts/validate-honest-numbers.sh: "a failed read
// rendered as an empty one". See docs/research-honesty-checks-2026-09-16.md.
//
// Rule (deliberately narrow — see the doc for the false-positive story):
// flag a .tsx file that (a) calls useFetch(...) at least once, (b) renders a
// bare <EmptyState (not <SmartEmptyState, which already takes a `degraded`
// prop and does the right thing internally), and (c) destructures neither
// `error` nor `degraded` out of ANY of its useFetch calls — i.e. the file has
// no code path that could tell a failed read from a quiet one, anywhere.
//
// This is a file-level, not call-site-level, check: a file with several
// useFetch calls where only ONE is checked for error will not be flagged,
// even if the EmptyState shown belongs to an unchecked one. That is a
// deliberate precision-over-recall call — see the doc.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_ROOT = path.join(REPO, 'portal', 'src', 'pages');

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listFiles(p));
    } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

function destructuredKeys(braceContent) {
  const keys = [];
  // Split on top-level commas — destructuring here doesn't nest braces in
  // practice (no `{ data: { x } } = useFetch(...)` in this codebase), so a
  // plain split is safe and avoids a second bracket-depth tracker.
  for (const part of braceContent.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.split(':')[0].trim().replace(/^\.\.\./, '');
    if (key) keys.push(key);
  }
  return keys;
}

function scanFile(rel, text) {
  const useFetchRe = /const\s*\{([^}]*)\}\s*=\s*useFetch\s*[<(]/g;
  let hasUseFetch = false;
  let hasErrorOrDegraded = false;
  let m;
  while ((m = useFetchRe.exec(text))) {
    hasUseFetch = true;
    const keys = destructuredKeys(m[1]);
    if (keys.includes('error') || keys.includes('degraded')) hasErrorOrDegraded = true;
  }
  if (!hasUseFetch) return null;
  const hasBareEmptyState = /<EmptyState\b/.test(text);
  if (!hasBareEmptyState) return null;
  if (hasErrorOrDegraded) return null;
  return {
    class: 3,
    rule: 'emptystate-no-error-check',
    file: rel,
    detail: 'calls useFetch and renders <EmptyState, but destructures neither `error` nor `degraded` from any useFetch call in the file',
  };
}

function main() {
  const roots = process.argv.slice(2);
  const files = roots.length > 0 ? roots : listFiles(DEFAULT_ROOT);
  for (const abs of files) {
    const rel = path.relative(REPO, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const finding = scanFile(rel, text);
    if (finding) process.stdout.write(JSON.stringify(finding) + '\n');
  }
}

main();

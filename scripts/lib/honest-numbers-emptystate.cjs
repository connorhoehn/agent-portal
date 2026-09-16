#!/usr/bin/env node
'use strict';
//
// Class 3 scanner for scripts/validate-honest-numbers.sh: "a failed read
// rendered as an empty one". See docs/research-honesty-checks-2026-09-16.md.
//
// Rule A (deliberately narrow — see the doc for the false-positive story):
// flag a .tsx file that (a) calls useFetch(...) at least once, (b) renders a
// bare <EmptyState, and (c) destructures neither `error` nor `degraded` out of
// ANY of its useFetch calls — i.e. the file has no code path that could tell a
// failed read from a quiet one, anywhere.
//
// Rule B: flag any <SmartEmptyState …> ELEMENT that is not passed a `degraded`
// prop. This rule used to be an EXEMPTION — the original comment here read
// "not <SmartEmptyState, which already takes a `degraded` prop and does the
// right thing internally". It takes the prop; it does not conjure it. The prop
// is optional, so a page that never passes it is exactly as blind as one using
// a bare <EmptyState, while spending a whole file-level exemption to look
// disciplined. Two sites were hiding in that gap when this rule was added:
// InvocationSearchPage (a degraded search rendered "No invocations match") and
// ApprovalQueuePage, whose seed fetch swallowed every failure under the
// comment "empty state handles it" while the empty state said "Nothing is
// waiting on you" — on an approvals queue, from no data.
//
// Rule B is per-ELEMENT, not per-file: the prop belongs to a specific render
// site, so there is no precision argument for widening it to the file the way
// Rule A is widened.
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

/** Byte range of the opening tag `<Name …>` starting at `from`.
 *
 *  Naively scanning for the next `>` is wrong twice over, and the first way
 *  cost a false positive on ToolCallsPage before this was written: a prop
 *  whose value is a JSX expression containing a COMPARISON —
 *  `title={allErrors.length > 0 ? … }` — ends the tag early, so the real
 *  `degraded` prop further down was never seen. So: track `{}` depth and only
 *  accept a `>` at brace depth 0, and skip over string literals so a `>` or a
 *  brace inside copy text cannot move either counter.
 */
function openingTag(text, from) {
  let brace = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      j++;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j++;
        j++;
      }
      continue;
    }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === '>' && brace === 0) return text.slice(from, j + 1);
  }
  return text.slice(from);
}

function scanSmartEmptyStates(rel, text) {
  const out = [];
  const re = /<SmartEmptyState\b/g;
  let m;
  while ((m = re.exec(text))) {
    const el = openingTag(text, re.lastIndex);
    if (/\bdegraded\s*=/.test(el)) continue;
    out.push({
      class: 3,
      rule: 'smartemptystate-no-degraded-prop',
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      detail: 'renders <SmartEmptyState> without a `degraded` prop, so a read the server could not perform renders as a confident empty result',
    });
  }
  return out;
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
    for (const f of scanSmartEmptyStates(rel, text)) {
      process.stdout.write(JSON.stringify(f) + '\n');
    }
  }
}

main();

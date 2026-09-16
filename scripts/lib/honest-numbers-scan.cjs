#!/usr/bin/env node
'use strict';
//
// Static scanner behind scripts/validate-honest-numbers.sh, classes 1 and 2.
// See docs/research-honesty-checks-2026-09-16.md for what this catches and
// why, and its false-positive story. Two rules, one AST pass per file:
//
//   totalAfterCap   (class 1) — a `total` field computed as `<var>.length`
//                    where `<var>` was itself produced by a `.slice(...)`
//                    truncation in the same function, OR the function's only
//                    SQL query LIMITs its rows with no paired `count(`.
//                    This is the exact shape of the fixed
//                    realGetLeaderboard/mockGetLeaderboard/
//                    mockGetSkillLeaderboard bugs (commits 294822c, 85c00bd).
//
//   columnNeverSelected (class 2, server half only) — a mapper reads
//                    `r['some_col']` but no SQL SELECT list in reach of that
//                    mapper appears to produce `some_col` (or an alias of
//                    it). This is the exact shape of the Quality page's
//                    RATIONALE/COST bug (routes/quality.ts): the interface
//                    declared the field, the mapper read it, and the SELECT
//                    never fetched it.
//
// Deliberately NOT attempted here: matching a portal table column back to a
// middleware response type. The two are separate TypeScript projects with no
// shared type import, so that direction of class 2 needs a human, not a
// cross-repo type checker this script does not have. See the doc.
//
// Output: one JSON object per line on stdout, newline-delimited, so the
// caller (validate-honest-numbers.sh) can jq/count/budget it without a
// second parse pass.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ts = require(path.join(REPO, 'middleware', 'node_modules', 'typescript'));

const TARGET_DIRS = ['routes', 'providers', 'mock'].map((d) =>
  path.join(REPO, 'middleware', 'src', d));

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listFiles(p));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

function nearestRouteLabel(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur) && cur.arguments.length && ts.isStringLiteralLike(cur.arguments[0])) {
      return cur.arguments[0].text;
    }
    cur = cur.parent;
  }
  return null;
}

// Every named/anonymous function-with-a-block-body in the file, innermost
// included — route handlers are usually anonymous arrows passed straight to
// asyncHandler(...), so "named functions only" would miss most of routes/.
function collectFunctions(sourceFile) {
  const fns = [];
  function visit(node) {
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
    if (isFn && node.body && ts.isBlock(node.body)) {
      let name = null;
      if (node.name && ts.isIdentifier(node.name)) name = node.name.text;
      if (!name && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        name = node.parent.name.text;
      }
      if (!name) name = nearestRouteLabel(node) || '(anonymous)';
      fns.push({ node, name });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return fns;
}

function lineOf(sourceFile, absPos) {
  return sourceFile.getLineAndCharacterOfPosition(absPos).line + 1;
}

// ---- class 1: total-after-cap ---------------------------------------------

function findSlicedVars(text) {
  const set = new Set();
  const re = /\b(\w+)\s*=\s*([\s\S]*?);/g;
  let m;
  while ((m = re.exec(text))) {
    if (/\.slice\(/.test(m[2])) set.add(m[1]);
  }
  return set;
}

function scanTotalAfterCap(file, sourceFile, fnNode, fnName, fnText, fnStart) {
  const findings = [];
  const slicedVars = findSlicedVars(fnText);
  const hasSqlLimit = /`[^`]*\bLIMIT\b[^`]*`/is.test(fnText);
  const hasSqlCount = /\bcount\s*\(/i.test(fnText);
  const totalRe = /\btotal\s*[:=]\s*(\w+)\.length\b/g;
  let m;
  while ((m = totalRe.exec(fnText))) {
    const varName = m[1];
    const abs = fnStart + m.index;
    const line = lineOf(sourceFile, abs);
    if (slicedVars.has(varName)) {
      findings.push({
        class: 1, rule: 'sliced-then-counted', file, line, function: fnName,
        detail: `total: ${varName}.length, but "${varName}" was itself produced by a .slice(...) in this function`,
      });
    } else if (hasSqlLimit && !hasSqlCount) {
      findings.push({
        class: 1, rule: 'limit-no-count', file, line, function: fnName,
        detail: `total: ${varName}.length in a function whose only SQL has LIMIT and no paired count(...)`,
      });
    }
  }
  return findings;
}

// ---- class 2: column read but never selected -------------------------------

// Split a SELECT ... FROM column list on top-level commas only (depth 0
// parens) so `COALESCE(a, b) AS x, y` splits into 2, not 3.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Index of the first occurrence of `word` at PAREN DEPTH 0, scanning from
// `start`. A plain `\bFROM\b` regex stops at the first textual FROM, which is
// wrong the instant a subquery or `EXTRACT(EPOCH FROM ts)` appears before the
// real one — this is why the first cut of this scanner false-flagged
// traffic.ts's `to_timestamp(...EXTRACT(EPOCH FROM ts)...) AS bucket_start`:
// it read "FROM ts" as the query's FROM and truncated the column list before
// reaching `bucket_start` at all. Depth-tracking also does the right thing
// for `WITH cte AS (SELECT ...) SELECT ... FROM cte` — the CTE's inner
// SELECT sits at depth 1 and is skipped in favour of the outer one.
function indexOfTopLevelWord(text, word, start) {
  const wordRe = new RegExp('^' + word + '\\b', 'i');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0) {
      const prev = i === 0 ? '' : text[i - 1];
      if (!/\w/.test(prev) && wordRe.test(text.slice(i))) return i;
    }
  }
  return -1;
}

function columnKeysOf(selectSql) {
  // A query assembled from `${...}` fragments (this codebase does this a lot
  // — predicates, conditional JOIN clauses, whole column blocks toggled by a
  // flag) is not literally present in source: the interpolation placeholder
  // text would be parsed as if it were column names, and the real columns it
  // stands in for are invisible to a single-file regex scan. Bail rather
  // than guess — this is the dynamic-SQL gap the doc calls out; it is not
  // provable "safe", it is unprovable, which the caller must treat the same
  // as SELECT *. Deliberately checked on the COLUMN LIST only, not the whole
  // query — a `${...}`-built WHERE/JOIN clause (extremely common here, e.g.
  // `WHERE ${sinceClause}`) says nothing about whether the SELECT list itself
  // is literal, and bailing on the whole template blinded this to every
  // query in the codebase that filters dynamically but selects statically —
  // which was most of them.
  const selIdx = indexOfTopLevelWord(selectSql, 'SELECT', 0);
  if (selIdx === -1) return null;
  const fromIdx = indexOfTopLevelWord(selectSql, 'FROM', selIdx + 6);
  if (fromIdx === -1) return null;
  const colsText = selectSql.slice(selIdx + 6, fromIdx);
  if (/\$\{/.test(colsText)) return null;
  if (/^\s*(DISTINCT\s+)?\*/i.test(colsText)) return null; // SELECT [DISTINCT] * — can't know columns
  const cols = splitTopLevel(colsText);
  const keys = new Set();
  for (const raw of cols) {
    const col = raw.trim();
    if (!col) continue;
    const asMatch = /\bAS\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*$/i.exec(col);
    if (asMatch) {
      keys.add(asMatch[1].toLowerCase());
      continue;
    }
    // bare `table.column` or `column` with no alias
    const bare = /([a-zA-Z_][a-zA-Z0-9_]*)\s*$/.exec(col.replace(/::\w+$/, ''));
    if (bare) keys.add(bare[1].toLowerCase());
  }
  return keys;
}

// All backtick template literals in `text` that look like a SELECT query, in
// source order with their start offsets (relative to `text`).
function findSelectTemplates(text) {
  const out = [];
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(text))) {
    if (/\bSELECT\b/i.test(m[1])) out.push({ start: m.index, sql: m[1] });
  }
  return out;
}

function scanColumnNeverSelected(file, sourceFile, fnNode, fnName, fnText, fnStart) {
  const findings = [];
  const templates = findSelectTemplates(fnText);
  if (templates.length === 0) return findings;
  const anySelectStar = templates.some((t) => /\bSELECT\b\s*\*/i.test(t.sql));
  if (anySelectStar) return findings; // can't prove absence — bail, not a false "safe"

  // Union of columns across every SELECT in the function: a reference valid
  // against ANY of them is not flagged. This under-catches (a key selected by
  // query A but read off query B's rows won't be seen) in exchange for never
  // flagging a mapper that is reading the query actually beside it — see the
  // doc for why that tradeoff was made deliberately.
  const allKeys = new Set();
  for (const t of templates) {
    const keys = columnKeysOf(t.sql);
    if (keys) for (const k of keys) allKeys.add(k);
    else return findings; // one query in this function is unparseable — bail
  }

  const refRe = /\br\[['"]([a-zA-Z0-9_]+)['"]\]/g;
  let m;
  while ((m = refRe.exec(fnText))) {
    const key = m[1].toLowerCase();
    if (!allKeys.has(key)) {
      const abs = fnStart + m.index;
      const line = lineOf(sourceFile, abs);
      findings.push({
        class: 2, rule: 'column-never-selected', file, line, function: fnName,
        detail: `r['${m[1]}'] read, but no SELECT in this function appears to produce that column/alias`,
      });
    }
  }
  return findings;
}

function main() {
  // Explicit file args (used by the calibration check in
  // validate-honest-numbers.sh, which points this at an old blob checked out
  // to a temp path) override the default directory walk.
  const argFiles = process.argv.slice(2);
  const files = argFiles.length > 0 ? argFiles : TARGET_DIRS.flatMap(listFiles);
  const seen = new Set(); // dedupe by file:line:rule — nested fn scan double-visits outer text
  for (const abs of files) {
    const rel = path.relative(REPO, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
    const fns = collectFunctions(sourceFile);
    for (const { node, name } of fns) {
      const fnStart = node.getStart(sourceFile);
      const fnText = text.slice(fnStart, node.getEnd());
      const results = [
        ...scanTotalAfterCap(rel, sourceFile, node, name, fnText, fnStart),
        ...scanColumnNeverSelected(rel, sourceFile, node, name, fnText, fnStart),
      ];
      for (const f of results) {
        const key = `${f.file}:${f.line}:${f.rule}`;
        if (seen.has(key)) continue;
        seen.add(key);
        process.stdout.write(JSON.stringify(f) + '\n');
      }
    }
  }
}

main();

#!/usr/bin/env node
// The RDS Data API binds every `stringValue` as text, and Postgres refuses
// `uuid = text` and a text VALUES entry for a uuid column (every assessment
// draft creation answered 503 until `:document` was cast). The mocked-Aurora
// tests and the native harness never reach this, so this is the static check
// (docs/deployment-enhancements/DE-28-bug-class-lint.md, check 2).
//
// Rule: schema/*.sql CREATE TABLE blocks give table -> {uuid columns}. For each
// SQL template literal in middleware/src/**/*.ts (not __tests__, not mock/),
// resolve the tables it names (FROM, JOIN, UPDATE, INSERT INTO, with aliases)
// and fail when a uuid column is compared to, assigned from, or inserted
// positionally from a bare `:param` with no CAST(:p AS uuid) / :p::uuid and no
// `typeHint: 'UUID'` on that parameter near the statement. The column's TABLE
// matters: document_id is uuid on the assessment canvas tables and TEXT on
// work_item_documents.
//
//   node scripts/check-uuid-binds.mjs [--json] [--source file.ts ...] [--schema dir]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** `file:table.column:param` -> why a bare bind is correct there. */
const EXEMPT = {};

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; }
function args(name) { const out = []; process.argv.forEach((a, i) => { if (a === name) out.push(process.argv[i + 1]); }); return out; }

/** Split on top-level commas (parens and quotes respected). */
function splitTop(text) {
  const parts = []; let depth = 0, cur = '', q = null;
  for (const c of text) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '(') depth++; if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function matchParen(text, open) {
  let depth = 0, q = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'") { q = c; continue; }
    if (c === '(') depth++; else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

export function parseSchema(dir) {
  const tables = new Map(); // table -> { columns:Set, uuid:Set }
  const entry = (t) => { if (!tables.has(t)) tables.set(t, { columns: new Set(), uuid: new Set() }); return tables.get(t); };
  const addColumn = (t, col, type) => { const e = entry(t); e.columns.add(col); if (/^uuid\b(?!\[)/i.test(type)) e.uuid.add(col); else e.uuid.delete(col); };
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi;
    let m;
    while ((m = create.exec(sql))) {
      const open = m.index + m[0].length - 1, close = matchParen(sql, open);
      if (close < 0) continue;
      for (const item of splitTop(sql.slice(open + 1, close))) {
        const t = item.trim().replace(/\s+/g, ' ');
        if (!t || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(t)) continue;
        const cm = /^"?(\w+)"?\s+(\w+)/.exec(t);
        if (cm) addColumn(m[1], cm[1], cm[2] + (t.slice(cm[0].length).startsWith('[]') ? '[]' : ''));
      }
    }
    const alter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+([^;]*);/gi;
    while ((m = alter.exec(sql))) {
      for (const add of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+(\w+)(\[\])?/gi)) addColumn(m[1], add[1], add[2] + (add[3] ?? ''));
    }
  }
  return tables;
}

/** SQL-looking template literals: [{ text, index }]. */
export function sqlLiterals(src) {
  const out = [];
  const re = /`((?:[^`\\]|\\.)*)`/g; let m;
  while ((m = re.exec(src))) {
    const text = m[1];
    if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text) && /(^|[^:]):[a-zA-Z_]\w*/.test(text)) out.push({ text, index: m.index });
  }
  return out;
}

const KEYWORDS = new Set(['WHERE', 'SET', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'USING', 'GROUP', 'ORDER', 'LIMIT', 'VALUES', 'RETURNING', 'AND', 'OR', 'WITH', 'SELECT', 'FROM', 'HAVING', 'UNION', 'OFFSET', 'DO', 'NATURAL', 'LATERAL']);

export function checkStatement(text, tables) {
  const found = [];
  // Resolve tables and aliases.
  const aliasOf = new Map(); // alias or name -> table
  const named = new Set();
  const ref = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?(?:\s+(?:AS\s+)?(\w+))?/gi;
  let m;
  while ((m = ref.exec(text))) {
    const table = m[1];
    if (!tables.has(table)) continue;
    named.add(table); aliasOf.set(table, table);
    if (m[2] && !KEYWORDS.has(m[2].toUpperCase())) aliasOf.set(m[2], table);
  }
  if (!named.size) return found;
  const uuidIn = (qual, col) => {
    if (qual) { const t = aliasOf.get(qual); return t && tables.get(t).uuid.has(col) ? t : null; }
    const owners = [...named].filter((t) => tables.get(t).columns.has(col));
    return owners.length && owners.every((t) => tables.get(t).uuid.has(col)) ? owners[0] : null;
  };
  const bare = (after) => !/^\s*::\s*uuid/i.test(after);
  const flag = (table, col, param, kind) => found.push({ table, column: col, param, kind });
  // col <op> :param   and   :param <op> col
  const fwd = /(?:\b(\w+)\.)?\b(\w+)\s*(?:=|<>|!=|<=|>=|<|>|\bIN\s*\(|\bNOT\s+IN\s*\()\s*:([a-zA-Z_]\w*)/gi;
  while ((m = fwd.exec(text))) {
    if (text[m.index - 1] === ':') continue;
    const table = uuidIn(m[1], m[2]);
    if (table && bare(text.slice(m.index + m[0].length))) flag(table, m[2], m[3], 'compare');
  }
  const rev = /(?<![:\w]):([a-zA-Z_]\w*)\s*(?:=|<>|!=)\s*(?:\b(\w+)\.)?\b(\w+)\b/g;
  while ((m = rev.exec(text))) {
    const table = uuidIn(m[2], m[3]);
    if (table && bare(text.slice(m.index + m[1].length + 1))) flag(table, m[3], m[1], 'compare');
  }
  // INSERT INTO t (cols) VALUES (...), (...)
  const ins = /INSERT\s+INTO\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*/gi;
  while ((m = ins.exec(text))) {
    if (!tables.has(m[1])) continue;
    const cols = m[2].split(',').map((c) => c.trim().replace(/"/g, ''));
    let i = m.index + m[0].length;
    while (text[i] === '(') {
      const close = matchParen(text, i); if (close < 0) break;
      const values = splitTop(text.slice(i + 1, close));
      values.forEach((v, k) => {
        const pm = /^\s*:([a-zA-Z_]\w*)\s*$/.exec(v);
        if (pm && cols[k] && tables.get(m[1]).uuid.has(cols[k])) flag(m[1], cols[k], pm[1], 'insert');
      });
      i = close + 1; while (/[\s,]/.test(text[i] ?? '')) i++;
    }
  }
  // INSERT ... SELECT :p ... is not resolved (needs the select list); out of scope.
  return found;
}

export function checkSource(src, file, tables) {
  const failures = [];
  for (const { text, index } of sqlLiterals(src)) {
    const line = src.slice(0, index).split('\n').length;
    const tail = src.slice(index + text.length, index + text.length + 900);
    const seen = new Set();
    for (const f of checkStatement(text, tables)) {
      const key = `${file}:${f.table}.${f.column}:${f.param}`;
      if (seen.has(key)) continue; seen.add(key);
      if (new RegExp(`name\\s*:\\s*['"]${f.param}['"][^}]*typeHint\\s*:\\s*['"]UUID['"]`).test(tail)) continue;
      failures.push({ file, line, key, ...f, exempt: EXEMPT[key] ?? null });
    }
  }
  return failures;
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'mock' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (n.endsWith('.ts') && !n.endsWith('.d.ts') && !n.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function main() {
  const tables = parseSchema(resolve(arg('--schema') ?? join(ROOT, 'schema')));
  const sources = args('--source');
  const files = sources.length ? sources.map((s) => resolve(s)) : walk(join(ROOT, 'middleware/src'));
  const findings = files.flatMap((f) => checkSource(readFileSync(f, 'utf8'), sources.length ? f : relative(ROOT, f), tables));
  const failures = findings.filter((f) => !f.exempt);
  const used = new Set(findings.filter((f) => f.exempt).map((f) => f.key));
  const stale = sources.length ? [] : Object.keys(EXEMPT).filter((k) => !used.has(k));
  if (process.argv.includes('--json')) console.log(JSON.stringify({ uuidTables: [...tables].filter(([, v]) => v.uuid.size).length, findings, stale }, null, 1));
  else {
    console.log(`uuid binds: ${files.length} files, ${findings.length - failures.length} exempt, ${failures.length} failing`);
    for (const f of failures) console.log(`  FAIL ${f.file}:${f.line} ${f.table}.${f.column} <- bare :${f.param} (${f.kind}); wrap it in CAST(:${f.param} AS uuid)`);
    for (const k of stale) console.log(`  FAIL ${k} is exempt but no longer found; drop the exemption`);
  }
  process.exit(failures.length || stale.length ? 1 : 0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

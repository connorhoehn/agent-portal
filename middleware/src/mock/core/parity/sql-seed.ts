// Read the seed SQL, don't retype it.
//
// Every one of the nine hand-written parity tests this harness replaces began
// the same way: someone hand-copied a handful of ids out of `schema/*.sql`
// into a fixture, the seed moved, and the copy didn't. Hand-copying is the
// bug. So the harness never carries a list of expected rows — it parses the
// actual `INSERT` statements out of the .sql files the seed loader runs, and
// compares those to what the mock providers return in `dev:mock`.
//
// This is a deliberately small SQL reader, not a parser: it understands the
// one statement shape `schema/seeds/generate_program_seed.py` and
// `schema/seed.sql` emit —
//
//   INSERT INTO <table> (<cols>) VALUES (<literals>) [ON CONFLICT ...];
//
// including the awkward bits those files really contain: `''` escapes inside
// strings (`'Marcus O''Brien'`), `ARRAY['otel','infra']`, `NULL`, `TRUE`,
// `'{"json": 1}'::jsonb`, `(NOW() - INTERVAL '42 days')::date`, and nested
// parens inside a value. Anything it can't turn into a JS scalar it keeps as
// `{ raw }` so a field check can still match on the SQL text.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-root `schema/` directory — this file lives at middleware/src/mock/core/parity/. */
export const SCHEMA_DIR = join(__dirname, '../../../../../schema');

/** A parsed literal. `{ raw }` is the escape hatch for SQL expressions. */
export type SeedValue = string | number | boolean | null | string[] | { raw: string };

export interface SeedRow {
  table: string;
  /** Column name → parsed literal, in the order the INSERT declared them. */
  values: Record<string, SeedValue>;
  /** 1-based line in the .sql file, so a failure can point at the source. */
  line: number;
  /** The statement, for the rare check that wants the SQL text itself. */
  raw: string;
}

// ── literal parsing ───────────────────────────────────────────────────────────

/** Strip any trailing `::type` casts: `'{"a":1}'::jsonb`, `x::uuid::text`. */
function stripCasts(text: string): string {
  let out = text.trim();
  // Only strip a cast that trails the whole expression, never one inside it.
  for (;;) {
    const next = out.replace(/::\s*[A-Za-z_][A-Za-z0-9_]*(\s*\[\s*\])?$/, '').trim();
    if (next === out) return out;
    out = next;
  }
}

function unquote(text: string): string {
  return text.slice(1, -1).replace(/''/g, "'");
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

export function parseLiteral(text: string): SeedValue {
  const t = stripCasts(text);
  if (t === '') return null;
  const upper = t.toUpperCase();
  if (upper === 'NULL') return null;
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (NUMERIC.test(t)) return Number(t);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    // A single quoted string only — `'a' || 'b'` stays raw.
    const body = t.slice(1, -1);
    if (!/(^|[^'])'([^']|$)/.test(body)) return unquote(t);
    return { raw: t };
  }
  if (upper.startsWith('ARRAY[') && t.endsWith(']')) {
    const inner = t.slice('ARRAY['.length, -1);
    if (inner.trim() === '') return [];
    return splitTopLevel(inner).map((part) => {
      const v = parseLiteral(part);
      return typeof v === 'string' ? v : String(v);
    });
  }
  return { raw: t };
}

/**
 * Split on commas that are not inside quotes, parens or brackets. The whole
 * reason this exists rather than a `split(',')`: work_items rows carry
 * descriptions with commas, and `ARRAY['a','b']` carries its own.
 */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") { i += 1; continue; } // '' escape
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === ']') { depth -= 1; continue; }
    if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** Scan from `open` (index of the char after `VALUES (`) to its matching `)`. */
function readParenBody(sql: string, open: number): { body: string; end: number } | null {
  let depth = 1;
  let inString = false;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i += 1; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: sql.slice(open, i), end: i };
    }
  }
  return null;
}

// ── file reading ──────────────────────────────────────────────────────────────

const fileCache = new Map<string, string>();
const rowCache = new Map<string, SeedRow[]>();

/**
 * Blank out `-- …` line comments that are not inside a string literal,
 * preserving newlines so reported line numbers still match the file.
 *
 * Not cosmetic: `schema/identity_schema.sql` seeds its users and grants as one
 * multi-row `VALUES` with explanatory comments BETWEEN the tuples, so a reader
 * that doesn't skip comments stops after the first commented gap. That is why
 * the first run of this harness saw 4 of 14 `app_users` and 0 of 21
 * `user_tenant_roles`.
 */
function stripLineComments(sql: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 1; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return out;
      i = nl - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function readSchemaFile(fileName: string): string {
  const cached = fileCache.get(fileName);
  if (cached !== undefined) return cached;
  const text = stripLineComments(readFileSync(join(SCHEMA_DIR, fileName), 'utf8'));
  fileCache.set(fileName, text);
  return text;
}

const INSERT_HEAD = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*VALUES\s*\(/gi;

/** Every `INSERT INTO <table>` row in `schema/<fileName>`, in file order. */
export function seedRows(fileName: string, table: string): SeedRow[] {
  const cacheKey = `${fileName}:${table}`;
  const cached = rowCache.get(cacheKey);
  if (cached) return cached;

  const sql = readSchemaFile(fileName);
  const rows: SeedRow[] = [];
  INSERT_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INSERT_HEAD.exec(sql)) !== null) {
    if (m[1]!.toLowerCase() !== table.toLowerCase()) continue;
    const columns = m[2]!.split(',').map((c) => c.trim());
    // `VALUES (...), (...), (...)` — schema/identity_schema.sql seeds its
    // users and grants as one multi-row statement, so every tuple is a row.
    let cursor = INSERT_HEAD.lastIndex;
    for (;;) {
      const parsed = readParenBody(sql, cursor);
      if (!parsed) break;
      const literals = splitTopLevel(parsed.body);
      const values: Record<string, SeedValue> = {};
      columns.forEach((col, i) => { values[col] = parseLiteral(literals[i] ?? 'NULL'); });
      rows.push({
        table,
        values,
        line: sql.slice(0, cursor).split('\n').length,
        raw: sql.slice(m.index, parsed.end + 1),
      });
      const rest = /^\s*,\s*\(/.exec(sql.slice(parsed.end + 1));
      if (!rest) { cursor = parsed.end; break; }
      cursor = parsed.end + 1 + rest[0].length;
    }
    INSERT_HEAD.lastIndex = cursor;
  }

  rowCache.set(cacheKey, rows);
  return rows;
}

/**
 * Seed rows keyed by id, last write winning — the seed files use
 * `ON CONFLICT ... DO UPDATE`, so a later statement for the same id really is
 * the row the database ends up holding.
 */
export function seedRowsById(fileName: string, table: string, idColumn: string): Map<string, SeedRow> {
  const byId = new Map<string, SeedRow>();
  for (const row of seedRows(fileName, table)) {
    const id = row.values[idColumn];
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    byId.set(String(id), row);
  }
  return byId;
}

/** Render a parsed literal the way a failure message should show it. */
export function showValue(v: unknown): string {
  if (v === null) return 'NULL';
  if (v === undefined) return '(absent)';
  if (Array.isArray(v)) return `[${v.map(showValue).join(', ')}]`;
  if (typeof v === 'object' && 'raw' in (v as Record<string, unknown>)) {
    return `<sql ${(v as { raw: string }).raw}>`;
  }
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}

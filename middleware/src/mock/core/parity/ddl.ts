// Read the CREATE TABLE, don't retype it.
//
// `./sql-seed.ts` reads the seed's `INSERT` statements. That is the whole
// answer for `schema/seed_program.sql`, where the rows a fixture claims to
// mirror are literally in the file. It is no answer at all for the assessment
// tenant, which has **no seed at all**: `schema/assessment_schema.sql` is DDL
// and nothing else, and its header says so out loud —
//
//     Ids are the mock's: TEAM-0NN, EV-xxxx, PROV-xxxx, Q-xxxx, …
//
// The fixtures ARE the seed there. So "does the fixture still say what the SQL
// says" cannot be a row comparison; the only thing the SQL asserts is the
// SHAPE — which columns exist, which may not be null, and, where a `CHECK
// (col IN (…))` is written, the exact vocabulary the column accepts.
//
// That is not a weaker question. It is the question the canonical assessment
// bug was: the portal read its knowledge sections under `enterprise` while the
// server sent `enterprise_context`, and every unit test agreed with the
// fixture. A value outside the column's own vocabulary is the same defect in
// the shape the database can actually refuse. `assessment_evidence.status` is
// the live example: it defaulted to a lowercase `'pending'` no writer ever
// produced until the CHECK made `('PENDING','CLASSIFIED','SCORED')` the
// column's own vocabulary rather than a convention held only in TypeScript.
//
// It also closes a real gap on the identity side. `schema/identity_schema.sql`
// seeds `app_users (id, display_name, email, person_id)` and NOTHING else — so
// `session_epoch` and `external_sub` are invisible to a check that only reads
// INSERT statements, even though the row the database ends up holding carries
// the DDL default for both, and `providers/identity.ts` claims to mirror that
// row.
//
// Deliberately a small reader, not a parser. It understands the statement
// shapes `schema/*.sql` really contains:
//
//   CREATE TABLE [IF NOT EXISTS] <t> ( <col> <type> [NOT NULL] [DEFAULT <v>]
//                                      [CHECK (<col> IN (…))] [REFERENCES …],
//                                      …, PRIMARY KEY (…), CHECK (…) );
//   ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] <col> <type> …;
//
// Anything it cannot reduce it leaves as `{ raw }`, exactly as sql-seed.ts
// does, so a caller can still match on the SQL text.

import { parseLiteral, seedRows, type SeedValue } from './sql-seed.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_DIR } from './sql-seed.js';

export interface ColumnDef {
  /** Column name as the DDL spells it. */
  name: string;
  /** Declared type, lower-cased: `text`, `integer`, `jsonb`, `text[]`. */
  type: string;
  /** `NOT NULL` (a PRIMARY KEY column counts — Postgres makes it so). */
  notNull: boolean;
  /**
   * The `DEFAULT` literal, parsed. `undefined` when the column declares none;
   * `{ raw: 'NOW()' }` when the default is an expression with no fixed value.
   */
  defaultValue?: SeedValue;
  /** `CHECK (col IN ('a','b'))` — the values the column accepts, or null. */
  vocabulary: string[] | null;
  /** 1-based line in the .sql file, so a failure can point at the source. */
  line: number;
}

export interface TableShape {
  table: string;
  file: string;
  columns: ColumnDef[];
  /** 1-based line of the `CREATE TABLE`. */
  line: number;
}

// ── file reading ──────────────────────────────────────────────────────────────
//
// DDL is read WITHOUT sql-seed's comment stripping deliberately: every `--`
// comment in these files sits outside a statement, and keeping the raw text
// means the line numbers a failure prints are the line numbers in the editor.

const fileCache = new Map<string, string>();

function readSchemaFile(fileName: string): string {
  const cached = fileCache.get(fileName);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(SCHEMA_DIR, fileName), 'utf8');
  fileCache.set(fileName, text);
  return text;
}

/** Blank a `-- …` comment that is not inside a string, keeping the newlines. */
function stripComments(sql: string): string {
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
      out += ' '.repeat(nl - i);
      i = nl - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Scan from `open` (the index after an opening paren) to its matching close. */
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

/** Split on commas outside quotes, parens and brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") { i += 1; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === ']') { depth -= 1; continue; }
    if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Whitespace-separated tokens at paren depth 0, keeping `'{}'::jsonb` and
 * `NOW()` whole. This is what makes `DEFAULT <value>` readable without a
 * keyword list: the value is simply the token after `DEFAULT`.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") { current += "'"; i += 1; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === '(' || ch === '[') { depth += 1; current += ch; continue; }
    if (ch === ')' || ch === ']') { depth -= 1; current += ch; continue; }
    if (depth === 0 && /\s/.test(ch)) {
      if (current) { out.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** The vocabulary a `CHECK (<column> IN ('a','b'))` in `text` gives `column`. */
function vocabularyFor(text: string, column: string): string[] | null {
  const re = /\bCHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = readParenBody(text, m.index + m[0].length);
    if (!body) continue;
    re.lastIndex = body.end;
    const inMatch = new RegExp(`(^|[^A-Za-z0-9_])${column}\\s+IN\\s*\\(`, 'i').exec(body.body);
    if (!inMatch) continue;
    const list = readParenBody(body.body, inMatch.index + inMatch[0].length);
    if (!list) continue;
    const values = splitTopLevel(list.body)
      .map((v) => parseLiteral(v))
      .filter((v): v is string => typeof v === 'string');
    if (values.length > 0) return values;
  }
  return null;
}

const CONSTRAINT_START = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE)\b/i;

function parseColumn(definition: string, line: number, tableBody: string): ColumnDef | null {
  const trimmed = definition.trim();
  if (trimmed === '' || CONSTRAINT_START.test(trimmed)) return null;
  const tokens = tokenize(trimmed);
  const name = tokens[0];
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

  const rest = tokens.slice(1);
  const type = (rest[0] ?? '').toLowerCase() + (rest[1] === '[]' ? '[]' : '');
  const upper = rest.map((t) => t.toUpperCase());

  const notNull = /\bNOT\s+NULL\b/i.test(trimmed) || /\bPRIMARY\s+KEY\b/i.test(trimmed);

  const defaultAt = upper.indexOf('DEFAULT');
  const defaultValue = defaultAt >= 0 && rest[defaultAt + 1] !== undefined
    ? parseLiteral(rest[defaultAt + 1]!)
    : undefined;

  // An inline `CHECK (…)` on this column, or a table-level one naming it.
  const vocabulary = vocabularyFor(trimmed, name) ?? vocabularyFor(tableBody, name);

  return {
    name,
    type,
    notNull,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    vocabulary,
    line,
  };
}

const shapeCache = new Map<string, TableShape | null>();

/** The declared shape of `table` in `schema/<fileName>`, or null if absent. */
export function tableShape(fileName: string, table: string): TableShape | null {
  const cacheKey = `${fileName}:${table}`;
  if (shapeCache.has(cacheKey)) return shapeCache.get(cacheKey)!;

  const raw = readSchemaFile(fileName);
  const sql = stripComments(raw);
  const lineOf = (index: number): number => sql.slice(0, index).split('\n').length;

  let shape: TableShape | null = null;

  const create = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i',
  ).exec(sql);
  if (create) {
    const body = readParenBody(sql, create.index + create[0].length);
    if (body) {
      const columns: ColumnDef[] = [];
      let cursor = create.index + create[0].length;
      for (const part of splitTopLevel(body.body)) {
        const at = sql.indexOf(part.split('\n')[0]!.trim(), cursor);
        const col = parseColumn(part, at >= 0 ? lineOf(at) : lineOf(create.index), body.body);
        if (col) columns.push(col);
        if (at >= 0) cursor = at + 1;
      }
      shape = { table, file: fileName, columns, line: lineOf(create.index) };
    }
  }

  // `ALTER TABLE … ADD COLUMN` is how both schemas add a column to a table
  // that already exists in a deployed cluster (`app_users.session_epoch`,
  // `assessment_knowledge_nodes.version`). A reader that stops at CREATE TABLE
  // misses exactly the columns most likely to be newer than the fixture.
  const alter = new RegExp(
    `ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?([^;]+);`, 'gi',
  );
  let a: RegExpExecArray | null;
  while ((a = alter.exec(sql)) !== null) {
    const col = parseColumn(a[1]!, lineOf(a.index), a[1]!);
    if (!col) continue;
    if (!shape) shape = { table, file: fileName, columns: [], line: lineOf(a.index) };
    if (!shape.columns.some((c) => c.name === col.name)) shape.columns.push(col);
  }

  shapeCache.set(cacheKey, shape);
  return shape;
}

/**
 * Columns of `table` that no `INSERT` in the same file ever names. The row the
 * database ends up holding carries the DDL default for each of them, so a
 * fixture that claims to mirror the seed must carry that default too — and
 * nothing in `./columns.ts` can see these, because that check derives its
 * column set from the INSERT statements themselves.
 *
 * Empty when the file seeds no rows at all for the table: `assessment_*` has
 * no seed, so "the default the seed relies on" is not a thing there.
 *
 * `seedFile` names the file holding the INSERTs when it is not the DDL's own:
 * the demo sign-in cast lives in seed_demo_identities.sql, apart from the
 * identity_schema.sql DDL every deploy loads.
 */
export function defaultedColumns(fileName: string, table: string, seedFile: string = fileName): ColumnDef[] {
  const shape = tableShape(fileName, table);
  if (!shape) return [];
  const inserts = seedRows(seedFile, table);
  if (inserts.length === 0) return [];
  const named = new Set(inserts.flatMap((r) => Object.keys(r.values)));
  return shape.columns.filter((c) => !named.has(c.name) && c.defaultValue !== undefined);
}

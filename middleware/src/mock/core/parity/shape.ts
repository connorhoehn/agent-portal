// SHAPE PARITY — the check for a domain whose seed is the fixture itself.
//
// `./compare.ts` asks "does the mock row say what the seed row says". That
// question needs a seed row. The assessment tenant has none: there is no
// `INSERT INTO assessment_*` anywhere in the repo, and `assessment_schema.sql`
// says why in its own header — *"Ids are the mock's: TEAM-0NN, EV-xxxx,
// PROV-xxxx, Q-xxxx"*. The fixtures ARE the seed. So a row comparison there
// would be a fixture compared against itself, which is the shape of every bug
// this harness exists to stop, not a check.
//
// What the SQL still asserts, and what nothing checked before this module, is
// the SHAPE the database will actually enforce:
//
//   * which columns exist — a fixture that carries no `rubric_version` is a
//     fixture whose row cannot round-trip through the table it claims to
//     mirror, and the Aurora path will fill a value nobody chose;
//   * which may not be NULL;
//   * and, where the DDL writes `CHECK (col IN (…))`, the exact vocabulary
//     the column accepts.
//
// That last one is the canonical assessment defect in the one form a database
// can refuse. The portal read its knowledge sections under `enterprise` while
// the server sent `enterprise_context`; six documents were unreachable and
// every test was green, because the fixture had invented `enterprise` too. A
// status spelled `pending` against a column whose vocabulary is
// `('PENDING','CLASSIFIED','SCORED')` is the same defect — and unlike the
// section key, the SQL states the right answer out loud.
//
// It also covers a real blind spot on the identity side. `./columns.ts`
// derives its column set from the seed's own INSERTs, so a column NO insert
// names is invisible to it — `app_users.session_epoch` and `tenants.status`
// among them. The database still puts the DDL default in that row, and
// `providers/identity.ts` claims to mirror that row, so the default is a value
// with a right answer and nothing was comparing it.
//
// SAME CONTRACT AS THE REST OF THE HARNESS. Nothing here is hand-typed: the
// columns, the vocabularies, the NOT NULLs and the defaults are all parsed out
// of `schema/*.sql` by `./ddl.ts`. A column the fixture does not model must be
// declared in `unmodelledColumns` WITH A REASON; a key the fixture carries
// that is no column must be declared in `extraKeys` WITH A REASON; both are
// printed on every run, and a stale entry fails rather than lingering.

import { defaultedColumns, tableShape, type ColumnDef } from './ddl.js';
import { showValue, type SeedValue } from './sql-seed.js';
import { camelCase } from './columns.js';

export interface ShapeEntity<M> {
  /** Usually the table name; suffixed when one table has two fixtures. */
  name: string;
  /** One line for the registry listing. */
  describes: string;
  /** File under `schema/`, e.g. `assessment_schema.sql`. */
  sqlFile: string;
  /** The table whose DDL is canonical. */
  table: string;
  /** The registered fixture key this row covers, for the record. */
  fixture?: string;
  /** Rows in the table's own shape — flatten nested fixtures to get here. */
  mockRows: () => Promise<M[]> | M[];
  /** How a failure names the offending row. */
  mockId: (row: M) => string;
  /** Column → key on the mock row, when it is neither the column name nor its camelCase. */
  columnKey?: Record<string, string>;
  /** Column → how to lift its value off a row that stores it somewhere else. */
  columnValue?: Record<string, (row: M) => unknown>;
  /** Columns the fixture deliberately does not carry, column → reason. */
  unmodelledColumns?: Record<string, string>;
  /** Keys the fixture carries that are no column of this table, key → reason. */
  extraKeys?: Record<string, string>;
  /**
   * A shape disagreement that is understood and accepted, column → reason.
   * Same contract as `FieldCheck.knownDrift`: mandatory, printed, and a reason
   * beginning `DEFECT:` records a bug rather than an accepted difference.
   */
  knownDrift?: Record<string, string>;
}

export interface ShapeViolation {
  kind: 'vocabulary' | 'not-null' | 'seeded-default' | 'type';
  column: string;
  id: string;
  detail: string;
  line: number;
  knownDrift?: string;
}

export interface ShapeAudit {
  entity: string;
  table: string;
  columnCount: number;
  mockCount: number;
  /** Columns resolved to a key (or a lift) on the mock row. */
  modelled: string[];
  /** Declared in `unmodelledColumns`, with the reason that must be there. */
  documented: Array<{ column: string; reason: string }>;
  /** THE FINDING: the table has this column, the fixture models nothing for it. */
  unmodelled: Array<{ column: string; def: ColumnDef }>;
  /** THE OTHER FINDING: the fixture carries this key, the table has no such column. */
  inventedKeys: string[];
  /** `extraKeys` entries that carry their reason. */
  documentedKeys: Array<{ key: string; reason: string }>;
  /** Value-level violations of what the DDL guarantees. */
  violations: ShapeViolation[];
  /** Violations matched by a documented `knownDrift` — reported, not failed. */
  knownDrift: ShapeViolation[];
  /** Columns whose DDL default is an expression: no value to conform to. */
  expressionDefaults: string[];
  /** Exemptions that no longer describe anything true. */
  staleExemptions: string[];
}

const REASON_MIN = 20;

function sameLiteral(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameLiteral(v, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

const isExpression = (v: SeedValue | undefined): v is { raw: string } =>
  v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The Postgres literal for an empty array/object default, as a fixture would
 * hold it: `'{}'` on a `text[]` is `[]`, `'[]'`/`'{}'` on a jsonb is the parsed
 * value. Only used by the seeded-default check, and only for the identity
 * tables that have a seed at all.
 */
function asJsValue(v: SeedValue, type: string): unknown {
  if (typeof v !== 'string') return v;
  if (type.endsWith('[]')) return v === '{}' ? [] : v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  if (type === 'jsonb' || type === 'json') {
    try { return JSON.parse(v) as unknown; } catch { return v; }
  }
  return v;
}

/**
 * Whether a mock value could be stored in a column of this declared type —
 * the third thing the DDL asserts, after "the column exists" and "here is its
 * vocabulary", and the one that catches a value which is the right *shape* for
 * the wire and impossible for the table.
 *
 * `assessment_team_exceptions.approved_at` is the live example: the fixture
 * holds `''` for an exception nobody has approved yet, and `''` is not a
 * TIMESTAMPTZ any Postgres will accept. Only types whose spelling is
 * unambiguous are checked — `jsonb` deliberately is not, because a jsonb
 * column legitimately holds a scalar, an object or the JSON text of either.
 */
function typeMismatch(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type.endsWith('[]')) {
    return Array.isArray(value) ? null : 'is not an array';
  }
  if (/^(timestamptz|timestamp|date)$/.test(type)) {
    if (typeof value !== 'string') return 'is not a date string';
    return Number.isNaN(Date.parse(value)) ? 'is not a value this column could store' : null;
  }
  if (/^(integer|int|int4|int8|bigint|smallint|serial|bigserial)$/.test(type)) {
    return typeof value === 'number' && Number.isInteger(value) ? null : 'is not an integer';
  }
  if (/^(boolean|bool)$/.test(type)) {
    return typeof value === 'boolean' ? null : 'is not a boolean';
  }
  if (type === 'text') {
    return typeof value === 'string' ? null : 'is not a string';
  }
  return null;
}

export async function auditShape<M>(entity: ShapeEntity<M>): Promise<ShapeAudit> {
  const shape = tableShape(entity.sqlFile, entity.table);
  if (!shape) {
    throw new Error(
      `${entity.name}: schema/${entity.sqlFile} declares no table '${entity.table}'. ` +
      `A shape entity must name a real CREATE TABLE — that is the whole point of reading the DDL.`,
    );
  }

  const rows = await entity.mockRows();
  const keys = new Set(
    rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r as object) : [])),
  );
  const lifts = entity.columnValue ?? {};
  const overrides = entity.columnKey ?? {};
  const declaredColumns = entity.unmodelledColumns ?? {};
  const declaredKeys = entity.extraKeys ?? {};
  const drift = entity.knownDrift ?? {};

  const audit: ShapeAudit = {
    entity: entity.name,
    table: entity.table,
    columnCount: shape.columns.length,
    mockCount: rows.length,
    modelled: [],
    documented: [],
    unmodelled: [],
    inventedKeys: [],
    documentedKeys: [],
    violations: [],
    knownDrift: [],
    expressionDefaults: [],
    staleExemptions: [],
  };

  /** null when the fixture models nothing for this column. */
  const reader = (column: string): ((row: M) => unknown) | null => {
    if (lifts[column]) return lifts[column]!;
    const override = overrides[column];
    if (override !== undefined) {
      return keys.has(override) ? (row) => (row as Record<string, unknown>)[override] : null;
    }
    if (keys.has(column)) return (row) => (row as Record<string, unknown>)[column];
    const camel = camelCase(column);
    if (keys.has(camel)) return (row) => (row as Record<string, unknown>)[camel];
    return null;
  };

  const usedKeys = new Set<string>();
  // Columns the seed's INSERTs never name, so the DDL default is the value the
  // seeded row really holds. Empty for a table with no seed at all.
  const defaulted = new Map(defaultedColumns(entity.sqlFile, entity.table).map((c) => [c.name, c]));

  for (const col of shape.columns) {
    const read = reader(col.name);
    if (read === null) {
      const reason = declaredColumns[col.name];
      if (reason !== undefined) audit.documented.push({ column: col.name, reason });
      else audit.unmodelled.push({ column: col.name, def: col });
      continue;
    }
    audit.modelled.push(col.name);
    const override = overrides[col.name];
    usedKeys.add(override ?? (keys.has(col.name) ? col.name : camelCase(col.name)));

    const record = (kind: ShapeViolation['kind'], id: string, detail: string): void => {
      const reason = drift[col.name];
      const v: ShapeViolation = { kind, column: col.name, id, detail, line: col.line, ...(reason ? { knownDrift: reason } : {}) };
      (reason ? audit.knownDrift : audit.violations).push(v);
    };

    const defaultDef = defaulted.get(col.name);
    if (defaultDef && isExpression(defaultDef.defaultValue)) {
      audit.expressionDefaults.push(`${col.name} (DEFAULT ${defaultDef.defaultValue.raw})`);
    }

    for (const row of rows) {
      const id = entity.mockId(row);
      const value = read(row);

      if (col.notNull && (value === null || value === undefined)) {
        record('not-null', id, `${col.name} is ${value === undefined ? 'absent' : 'null'} on the mock row, but schema/${entity.sqlFile} declares it NOT NULL`);
      }
      const mismatch = typeMismatch(col.type, value);
      if (mismatch !== null) {
        record('type', id, `${col.name} = ${showValue(value)}, which ${mismatch} — schema/${entity.sqlFile} declares it ${col.type.toUpperCase()}`);
      }
      if (col.vocabulary && value !== null && value !== undefined) {
        if (!col.vocabulary.includes(String(value))) {
          record('vocabulary', id, `${col.name} = ${showValue(value)}, which is not one of the ${col.vocabulary.length} values the column's CHECK allows (${col.vocabulary.map((v) => `'${v}'`).join(', ')})`);
        }
      }
      if (defaultDef && !isExpression(defaultDef.defaultValue) && defaultDef.defaultValue !== undefined) {
        const want = asJsValue(defaultDef.defaultValue, col.type);
        if (!sameLiteral(want, value) && JSON.stringify(want) !== JSON.stringify(value)) {
          record('seeded-default', id, `no INSERT in schema/${entity.sqlFile} names ${col.name}, so the seeded row holds the column DEFAULT ${showValue(want)} — the mock holds ${showValue(value)}`);
        }
      }
    }
  }

  for (const key of keys) {
    if (usedKeys.has(key)) continue;
    const reason = declaredKeys[key];
    if (reason !== undefined) audit.documentedKeys.push({ key, reason });
    else audit.inventedKeys.push(key);
  }

  // Exemption lists that outlive their problem are the failure mode this whole
  // harness is about — enforced here exactly as `./columns.ts` enforces it.
  const columnNames = new Set(shape.columns.map((c) => c.name));
  for (const [column, reason] of Object.entries(declaredColumns)) {
    if (reason.trim().length < REASON_MIN) {
      audit.staleExemptions.push(`unmodelledColumns['${column}'] gives no usable reason — say why the fixture carries nothing for it`);
    } else if (!columnNames.has(column)) {
      audit.staleExemptions.push(`unmodelledColumns['${column}'] names a column schema/${entity.sqlFile} no longer declares on ${entity.table} — delete it`);
    } else if (audit.modelled.includes(column)) {
      audit.staleExemptions.push(`unmodelledColumns['${column}'] is exempted AND modelled by the fixture — delete the exemption`);
    }
  }
  for (const [key, reason] of Object.entries(declaredKeys)) {
    if (reason.trim().length < REASON_MIN) {
      audit.staleExemptions.push(`extraKeys['${key}'] gives no usable reason — say why the fixture carries a key the table has no column for`);
    } else if (!keys.has(key)) {
      audit.staleExemptions.push(`extraKeys['${key}'] names a key no mock row carries any more — delete it`);
    } else if (columnNames.has(key) && usedKeys.has(key)) {
      audit.staleExemptions.push(`extraKeys['${key}'] is a real column of ${entity.table} that the fixture models — delete the exemption`);
    }
  }
  for (const [column, reason] of Object.entries(drift)) {
    if (reason.trim().length < REASON_MIN) {
      audit.staleExemptions.push(`knownDrift['${column}'] gives no usable reason — say why the disagreement is accepted`);
    } else if (!audit.knownDrift.some((v) => v.column === column)) {
      audit.staleExemptions.push(`knownDrift['${column}'] excuses a disagreement that no longer happens — delete it`);
    }
  }

  return audit;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** `null` when the fixture's shape matches the table; otherwise the finding. */
export function describeShape<M>(entity: ShapeEntity<M>, a: ShapeAudit): string | null {
  const bad = a.unmodelled.length + a.inventedKeys.length + a.violations.length + a.staleExemptions.length;
  if (bad === 0) return null;

  const lines: string[] = [''];
  lines.push(`${a.entity} — mock fixture ↔ the shape schema/${entity.sqlFile} declares for ${a.table}`);
  lines.push(`  ${entity.describes}`);
  lines.push(`  table columns: ${a.columnCount}   mock rows: ${a.mockCount}   modelled: ${a.modelled.length}`);
  lines.push('');

  if (a.unmodelled.length > 0) {
    lines.push(`  ${a.unmodelled.length} column(s) the table declares and the fixture models NOTHING for:`);
    for (const { column, def } of a.unmodelled) {
      const bits = [def.type, def.notNull ? 'NOT NULL' : 'nullable'];
      if (def.defaultValue !== undefined) bits.push(`DEFAULT ${showValue(def.defaultValue)}`);
      if (def.vocabulary) bits.push(`IN (${def.vocabulary.map((v) => `'${v}'`).join(', ')})`);
      lines.push(`    ${pad(column, 24)} ${bits.join('  ')}   (${entity.sqlFile}:${def.line})`);
    }
    lines.push('');
  }

  if (a.inventedKeys.length > 0) {
    lines.push(`  ${a.inventedKeys.length} key(s) the fixture carries that ${a.table} has NO column for:`);
    for (const key of a.inventedKeys) lines.push(`    ${key}`);
    lines.push('');
  }

  if (a.violations.length > 0) {
    lines.push(`  ${a.violations.length} row(s) violate what the DDL guarantees:`);
    for (const v of a.violations.slice(0, 25)) {
      lines.push(`    [${v.kind}] ${v.id}: ${v.detail}   (${entity.sqlFile}:${v.line})`);
    }
    if (a.violations.length > 25) lines.push(`    …and ${a.violations.length - 25} more`);
    lines.push('');
  }

  if (a.staleExemptions.length > 0) {
    lines.push(`  ${a.staleExemptions.length} exemption(s) have OUTLIVED the problem they excused:`);
    for (const s of a.staleExemptions) lines.push(`    ${s}`);
    lines.push('');
  }

  lines.push(`  Fix the fixture, or say why in \`unmodelledColumns\` / \`extraKeys\` / \`knownDrift\` WITH A REASON.`);
  if (a.violations.some((v) => v.kind === 'vocabulary')) {
    lines.push(`  A vocabulary violation is never a fixture's call to make: the CHECK is the column's own spelling.`);
  }
  return lines.join('\n');
}

/** Everything this check deliberately tolerates, for the visibility roll-up. */
export function describeShapeDrift(a: ShapeAudit): string[] {
  const out: string[] = [
    ...a.documented.map((d) => `${a.entity}.${d.column}: the table has it, the fixture does not — ${d.reason}`),
    ...a.documentedKeys.map((d) => `${a.entity}: fixture key '${d.key}' is no column of ${a.table} — ${d.reason}`),
    ...a.expressionDefaults.map((e) => `${a.entity}.${e}: no value to conform to — the DDL default is an expression`),
  ];
  const grouped = new Map<string, { first: ShapeViolation; ids: string[] }>();
  for (const v of a.knownDrift) {
    const seen = grouped.get(v.column);
    if (seen) seen.ids.push(v.id);
    else grouped.set(v.column, { first: v, ids: [v.id] });
  }
  for (const { first, ids } of grouped.values()) {
    const where = ids.length === 1 ? `@ ${ids[0]}` : `@ ${ids.length} rows (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`;
    out.push(`${a.entity}.${first.column} ${where}: ${first.detail} — ${first.knownDrift ?? 'no reason given'}`);
  }
  return out;
}

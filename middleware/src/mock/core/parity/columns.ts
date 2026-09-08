// COLUMN COVERAGE — the check that decides WHICH columns get compared.
//
// The failure this exists for. `MOCK_BUDGETS` allocated $60/$45/$30 where
// `schema/seed_program.sql` allocates $95/$85/$45 for the same three
// initiatives. Every id matched, every row was present, the shapes agreed, and
// the harness was green — because the parity table is a hand-written list of
// `fields`, and a column nobody remembered to list is a column nobody compares.
// A human found it by reading the two files side by side.
//
// That is a class, not an incident: **a mock that agrees on every id and
// disagrees on every amount passes a presence-and-shape check.** And the fix
// cannot be "write down the expected numbers", because a hand-maintained list
// of expected numbers is the same typed-aggregate defect one level up — it is
// right the day it is written and wrong the first time the seed moves.
//
// So this module derives the question instead of the answer. For each entity it
// reads the columns the seed's own INSERT statements carry, matches them to the
// keys the mock rows actually expose, and asks of every pair: is this column
// compared? A column both sources carry and nobody compares is a finding — and
// the finding names the column and both values, so it reads like the bug it is:
//
//   initiative_budgets: seed column `allocated_usd` pairs with mock key
//     `allocatedUsd` and is never compared — p-observability: seed 95 vs mock 60
//
// The escape hatches are the same two the rest of the harness uses, and they
// carry the same contract:
//
//   - a `FieldCheck` in `entity.fields` — the column is compared;
//   - an entry in `entity.uncheckedColumns` — WITH A REASON, printed on every
//     run, exactly like `knownDrift`. An exemption with no reason is how drift
//     becomes permanent, so a blank one fails, and a stale one (naming a column
//     that is compared, or that the seed no longer writes) fails too. The list
//     cannot quietly outlive the problem.
//
// One exemption is derived rather than written: a column whose seed value is a
// SQL *expression* on every row (`NOW() - INTERVAL '4 days'`, the shape
// `generate_program_seed.py` dates almost everything with) has no literal for a
// value comparison to read. Those are auto-exempt and still printed, so the
// gap is visible rather than assumed away. A column that is an expression on
// SOME rows and a literal on others must still be declared — `completed_at` is
// exactly that, and "null for every open item" is a real thing to check.

import type { ParityEntity } from './compare.js';
import { seedRows, showValue, type SeedRow, type SeedValue } from './sql-seed.js';

/** `org_project_id` → `orgProjectId`. The one naming convention the middleware
 *  applies to every Aurora column on its way to the wire. */
export function camelCase(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_m, c: string) => (c as string).toUpperCase());
}

const isExpression = (v: SeedValue): v is { raw: string } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export interface PairedColumn {
  /** Column as the seed spells it. */
  column: string;
  /** Key on the mock row it pairs with. */
  mockKey: string;
  /** First id where the two disagree today, rendered — or null if they agree. */
  disagreement: string | null;
  /** How many ids carry a literal on both sides. */
  compared: number;
}

export interface ColumnCoverage {
  entity: string;
  /** Columns a `FieldCheck` compares. */
  checked: string[];
  /** Columns that ARE the identity — comparing an id to itself proves nothing. */
  identity: string[];
  /** Paired, but the seed writes an expression on every row: nothing to compare. */
  expression: string[];
  /** In the seed, absent from the mock row — outside "columns both sources carry". */
  seedOnly: string[];
  /** Declared in `uncheckedColumns`, with the reason that must be there. */
  documented: Array<{ column: string; reason: string }>;
  /** THE FINDING: both sources carry it, nothing compares it, nobody said why. */
  uncovered: PairedColumn[];
  /** `uncheckedColumns` entries that are blank, or that name a column which is
   *  compared / no longer in the seed / not on the mock row. */
  staleExemptions: string[];
}

/**
 * Columns that carry the row's identity. Comparing one to itself is vacuous, so
 * they are not findings — but they are derived, not listed: the id column
 * `seedId` names, plus (for a composite `seedKey`) any column whose value is a
 * component of the key the entity builds for every single row.
 */
function identityColumns<M>(entity: ParityEntity<M>, rows: SeedRow[], columns: string[]): Set<string> {
  const out = new Set<string>();
  if (entity.seedId) out.add(entity.seedId);
  if (!entity.seedKey || rows.length === 0) return out;
  const keyOf = entity.seedKey;
  for (const column of columns) {
    const componentOfEveryKey = rows.every((row) => {
      const v = row.values[column];
      if (v == null || isExpression(v) || Array.isArray(v)) return false;
      // Keys are built by joining components with `@` / `:` (see entities.ts).
      return keyOf(row).split(/[@:]/).includes(String(v));
    });
    if (componentOfEveryKey) out.add(column);
  }
  return out;
}

/** Deep-ish equality with the same tolerances `compare.ts` uses. */
function sameLiteral(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameLiteral(v, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return false;
}

/**
 * What the mock row says at `key`, reduced to something comparable with a seed
 * literal. A jsonb column arrives as an object on the mock side and as its JSON
 * text on the seed side, so the seed text is parsed rather than the object
 * stringified — `{"a": 1}` and `{"a":1}` are the same value and different text.
 */
function comparableSeed(v: SeedValue): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try { return JSON.parse(t) as unknown; } catch { return v; }
}

function agrees(seed: SeedValue, mock: unknown): boolean {
  const s = comparableSeed(seed);
  if (sameLiteral(s, mock)) return true;
  if (s && mock && typeof s === 'object' && typeof mock === 'object') {
    return JSON.stringify(s) === JSON.stringify(mock);
  }
  return false;
}

/**
 * Walk one entity's seed columns against its mock rows. Pure reporting — the
 * driver decides what is fatal, the same way `describeResult` does.
 */
export async function auditColumnCoverage<M>(entity: ParityEntity<M>): Promise<ColumnCoverage> {
  const table = entity.sqlTable ?? entity.name;
  const rows = seedRows(entity.sqlFile, table)
    .filter((r) => (entity.seedFilter ? entity.seedFilter(r) : true));
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];

  const keyOf = (row: SeedRow): string =>
    entity.seedKey ? entity.seedKey(row) : String(row.values[entity.seedId]);
  const seedById = new Map<string, SeedRow>();
  for (const row of rows) seedById.set(keyOf(row), row);

  const mockList = await entity.mockRows();
  const mockById = new Map<string, M>();
  for (const row of mockList) mockById.set(entity.mockId(row), row);
  const mockKeys = new Set(
    mockList.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r as object) : [])),
  );

  const checked = new Set(entity.fields.map((f) => f.seed));
  const identity = identityColumns(entity, rows, columns);
  const declared = entity.uncheckedColumns ?? {};

  const coverage: ColumnCoverage = {
    entity: entity.name,
    checked: [...checked],
    identity: [...identity].filter(Boolean),
    expression: [],
    seedOnly: [],
    documented: [],
    uncovered: [],
    staleExemptions: [],
  };

  for (const column of columns) {
    if (identity.has(column)) continue;
    const mockKey = mockKeys.has(camelCase(column)) ? camelCase(column)
      : mockKeys.has(column) ? column
      : null;
    if (mockKey === null) {
      // Not a column "both sources carry" — out of scope for this check. It is
      // reported so a reader can see what the mock does not model.
      if (!checked.has(column)) coverage.seedOnly.push(column);
      continue;
    }

    // Pair up the values so both a finding and the roll-up can quote real ones.
    let comparedIds = 0;
    let expressions = 0;
    let disagreement: string | null = null;
    for (const [id, seedRow] of seedById) {
      const mockRow = mockById.get(id);
      if (mockRow === undefined) continue;
      const seedValue = column in seedRow.values ? seedRow.values[column]! : null;
      if (isExpression(seedValue)) { expressions += 1; continue; }
      comparedIds += 1;
      const mockValue = (mockRow as Record<string, unknown>)[mockKey];
      if (disagreement === null && !agrees(seedValue, mockValue)) {
        disagreement = `${id}: seed ${showValue(seedValue)} vs mock ${showValue(mockValue)}`;
      }
    }

    if (checked.has(column)) continue;
    if (comparedIds === 0 && expressions > 0) {
      // Auto-exempt: `NOW() - INTERVAL '4 days'` has no instant to compare.
      coverage.expression.push(`${column} (${expressions} row(s), every one a SQL expression)`);
      continue;
    }
    const reason = declared[column];
    if (reason !== undefined) {
      coverage.documented.push({ column, reason });
      continue;
    }
    coverage.uncovered.push({ column, mockKey, disagreement, compared: comparedIds });
  }

  // An exemption list that outlives its problem is worse than none.
  for (const [column, reason] of Object.entries(declared)) {
    if (reason.trim().length < 20) {
      coverage.staleExemptions.push(
        `uncheckedColumns['${column}'] gives no usable reason — say why the column is not compared`,
      );
      continue;
    }
    if (!columns.includes(column)) {
      coverage.staleExemptions.push(
        `uncheckedColumns['${column}'] names a column schema/${entity.sqlFile} no longer writes for ${table} — delete it`,
      );
      continue;
    }
    if (checked.has(column)) {
      coverage.staleExemptions.push(
        `uncheckedColumns['${column}'] is exempted AND compared by a FieldCheck — delete the exemption`,
      );
      continue;
    }
    if (identity.has(column)) {
      coverage.staleExemptions.push(
        `uncheckedColumns['${column}'] is part of this entity's identity, so it is already exempt — delete it`,
      );
    }
  }

  return coverage;
}

/** `null` when every paired column is accounted for; otherwise the finding. */
export function describeCoverage<M>(entity: ParityEntity<M>, c: ColumnCoverage): string | null {
  if (c.uncovered.length === 0 && c.staleExemptions.length === 0) return null;
  const lines: string[] = [''];
  lines.push(`${c.entity} — columns both schema/${entity.sqlFile} and the mock carry, that nothing compares`);
  lines.push(`  ${entity.describes}`);
  lines.push('');
  for (const u of c.uncovered) {
    lines.push(`  seed column \`${u.column}\` pairs with mock key \`${u.mockKey}\` and is never compared`);
    lines.push(
      u.disagreement
        ? `      they DISAGREE today — ${u.disagreement}   (${u.compared} id(s) comparable)`
        : `      they agree on all ${u.compared} comparable id(s) today, and nothing keeps them agreeing`,
    );
  }
  for (const s of c.staleExemptions) lines.push(`  ${s}`);
  lines.push('');
  lines.push(`  Add a FieldCheck to this entity's \`fields\` — that is the fix.`);
  lines.push(`  If the column genuinely cannot be compared, say so in \`uncheckedColumns\` WITH A REASON.`);
  return lines.join('\n');
}

/** Everything this check deliberately tolerates, for the visibility roll-up. */
export function describeCoverageDrift(c: ColumnCoverage): string[] {
  return [
    ...c.documented.map((d) => `${c.entity}.${d.column}: not compared — ${d.reason}`),
    ...c.expression.map((e) => `${c.entity}.${e}: not compared — the seed writes no literal`),
  ];
}

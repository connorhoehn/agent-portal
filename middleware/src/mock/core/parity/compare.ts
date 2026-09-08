// The comparison engine + the failure format.
//
// A parity failure has to be readable without opening either file. The nine
// tests this replaces failed with `expect(received).toBe(expected)` on a bare
// string, which told you two values disagreed but not which entity, which id,
// which field, or where the seed row lives. Every message this module produces
// names all four:
//
//   work_items — src/providers/work-items.ts ↔ schema/seed_program.sql
//
//     2 seeded ids missing from the mock:
//       wi-obs-e2-s3   (seed_program.sql:41)
//       wi-obs-e2-s4   (seed_program.sql:42)
//     1 id invented by the mock (no seed row):
//       wi-k8s-1
//     1 field disagrees:
//       wi-obs-e1-s1.project_id   seed 'p-observability'   mock 'p-cost-opt'

import { showValue, type SeedRow, type SeedValue } from './sql-seed.js';

export interface FieldCheck<M> {
  /** Column name in the seed row. Also the label in failure output. */
  seed: string;
  /**
   * Override the label when the check reads *part* of a column — a scalar out
   * of a jsonb blob, say — so the failure says `result.costUsd` rather than
   * `result` and a reader knows which half of the column moved.
   */
  label?: string;
  /** Same value as the mock provider reports it. */
  mock: (row: M) => unknown;
  /**
   * Optional coercion applied to the seed literal before comparing — for
   * scale changes (`composite_score` 0–100 → `influenceScore` 0–1), joins
   * (a team id → its name), or nullable columns the mock spells differently.
   */
  normalize?: (value: SeedValue, row: SeedRow) => unknown;
  /**
   * Compare with something other than deep equality. Return true when the two
   * agree.
   */
  equals?: (seedValue: unknown, mockValue: unknown) => boolean;
  /**
   * A disagreement that is understood and accepted. The harness reports it in
   * the known-drift roll-up instead of failing, and the string must say WHY —
   * an unexplained exemption is how drift becomes permanent.
   *
   * A bare string exempts the field everywhere; an object exempts it only for
   * the named ids, which is almost always what you want.
   *
   * A reason beginning `DEFECT:` says this is NOT an accepted disagreement —
   * it is a real bug, recorded because the fix belongs in a file this harness
   * does not own. The roll-up prints those in their own section rather than
   * mixing them in with the deliberate ones, on the same argument as
   * `core/wire/allow.ts`'s `bug: true`: a bug that is silenced is a bug that
   * stays.
   */
  knownDrift?: string | Record<string, string>;
  /**
   * What the seed means when the INSERT omits this column entirely. Defaults
   * to `null` — the column default for every nullable column these seeds use.
   * The `work_items` epic rows really do omit `sprint_id`/`pr_url`/`pr_status`.
   */
  whenAbsent?: SeedValue;
}

export interface ParityEntity<M> {
  /** Table name as the seed spells it: `work_items`, `bots`, `app_users`. */
  name: string;
  /** File under `schema/`, e.g. `seed_program.sql`. */
  sqlFile: string;
  /** Table inside that file, when it differs from `name`. */
  sqlTable?: string;
  /**
   * Id column in the seed. For a table with a composite key
   * (`project_contributions` is keyed on person_id + project_id) use
   * `seedKey` instead and set this to `''`.
   */
  seedId: string;
  /** Composite/derived key, when one column is not enough. */
  seedKey?: (row: SeedRow) => string;
  /** Where the mock rows come from — a provider call under `dev:mock`. */
  mockRows: () => Promise<M[]> | M[];
  /** Same id, off the mock row. */
  mockId: (row: M) => string;
  /** Which columns must agree. */
  fields: Array<FieldCheck<M>>;
  /**
   * Columns BOTH sources carry that this entity deliberately does not compare,
   * column → reason. Enforced by `./columns.ts`: a seed column that pairs with
   * a key on the mock row must be in `fields` or in here, because a column
   * nobody listed is a column nobody compares — which is how `MOCK_BUDGETS`
   * could allocate $60 against the seed's $95 with the harness green.
   *
   * Same contract as `knownDrift`: the reason is mandatory, it is printed on
   * every run, and a stale entry (naming a column that IS compared, or that
   * the seed no longer writes) fails rather than lingering.
   */
  uncheckedColumns?: Record<string, string>;
  /**
   * `complete` — the fixture claims to mirror the seed: every seeded id must
   *   be present and no id may be invented.
   * `subset`  — the fixture is a curated cast: it may omit seeded ids, but
   *   every id it DOES carry must exist in the seed and agree on every field.
   *
   * Note `subset` is not a licence to invent. An id in the mock that the seed
   * has never heard of is a failure under both settings — that is precisely
   * how `wi-k8s-*` and the "Developer Onboarding" family got shipped.
   */
  coverage: 'complete' | 'subset';
  /** Only compare the seed rows that match — e.g. one initiative's work items. */
  seedFilter?: (row: SeedRow) => boolean;
  /** Ids the fixture is documented to invent, id → reason. */
  allowedExtraIds?: Record<string, string>;
  /** Seeded ids a `complete` fixture is documented to omit, id → reason. */
  allowedMissingIds?: Record<string, string>;
  /** One line for the registry listing, so a reader knows what this row covers. */
  describes: string;
  /** Which of the nine original tests' lessons this row carries. */
  lesson?: string;
}

export interface FieldDisagreement {
  id: string;
  field: string;
  seedValue: unknown;
  mockValue: unknown;
  seedLine: number;
  knownDrift?: string;
}

export interface ParityResult {
  entity: string;
  seedCount: number;
  mockCount: number;
  comparedIds: number;
  missingFromMock: Array<{ id: string; line: number }>;
  inventedInMock: string[];
  disagreements: FieldDisagreement[];
  /** Disagreements matched by a documented `knownDrift`, reported not failed. */
  knownDrift: FieldDisagreement[];
  allowedExtras: string[];
  allowedMissing: string[];
  /**
   * Ids exempted by `allowedMissingIds` that are no longer missing. An
   * exemption that outlives its problem is the failure mode this whole harness
   * is about — `p-data-lake` and `p-zero-trust` were exempted with a written
   * reason on a Monday and given real ledger rows on the Tuesday, and nothing
   * would have said the reason had stopped being true.
   *
   * `allowedExtraIds` is deliberately NOT checked this way: it is derived from
   * a sibling seed file (see `authoredElsewhere` in entities.ts), so entries
   * there are generated, not hand-curated, and an unused one means the other
   * seed has a row this fixture happens not to serve — not a stale claim.
   */
  staleMissingExemptions: string[];
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number') {
    // Seed money/points are exact decimals; guard only float representation.
    return Math.abs(a - b) < 1e-9;
  }
  return false;
}

import { seedRows } from './sql-seed.js';

export async function compareEntity<M>(entity: ParityEntity<M>): Promise<ParityResult> {
  const table = entity.sqlTable ?? entity.name;
  const allSeed = seedRows(entity.sqlFile, table)
    .filter((r) => (entity.seedFilter ? entity.seedFilter(r) : true));

  // `ON CONFLICT DO UPDATE` means a later statement for the same id wins.
  const seedById = new Map<string, SeedRow>();
  for (const row of allSeed) {
    if (entity.seedKey) { seedById.set(entity.seedKey(row), row); continue; }
    const id = row.values[entity.seedId];
    if (id == null || typeof id === 'object' || Array.isArray(id)) continue;
    seedById.set(String(id), row);
  }

  const mockList = await entity.mockRows();
  const mockById = new Map<string, M>();
  for (const row of mockList) mockById.set(entity.mockId(row), row);

  const allowedExtraIds = entity.allowedExtraIds ?? {};
  const allowedMissingIds = entity.allowedMissingIds ?? {};

  const missingFromMock: Array<{ id: string; line: number }> = [];
  const allowedMissing: string[] = [];
  if (entity.coverage === 'complete') {
    for (const [id, row] of seedById) {
      if (mockById.has(id)) continue;
      if (id in allowedMissingIds) allowedMissing.push(id);
      else missingFromMock.push({ id, line: row.line });
    }
  }

  // An exemption whose problem is fixed must be deleted, not left standing.
  const staleMissingExemptions = Object.keys(allowedMissingIds)
    .filter((id) => !allowedMissing.includes(id))
    .map((id) => (seedById.has(id)
      ? `allowedMissingIds['${id}'] exempts an id the mock now carries — delete it`
      : `allowedMissingIds['${id}'] names an id schema/${entity.sqlFile} no longer seeds — delete it`));

  const inventedInMock: string[] = [];
  const allowedExtras: string[] = [];
  for (const id of mockById.keys()) {
    if (seedById.has(id)) continue;
    if (id in allowedExtraIds) allowedExtras.push(id);
    else inventedInMock.push(id);
  }

  const disagreements: FieldDisagreement[] = [];
  const knownDrift: FieldDisagreement[] = [];
  let comparedIds = 0;
  for (const [id, seedRow] of seedById) {
    const mockRow = mockById.get(id);
    if (mockRow === undefined) continue;
    comparedIds += 1;
    for (const field of entity.fields) {
      const rawSeed = field.seed in seedRow.values
        ? (seedRow.values[field.seed] as SeedValue)
        : (field.whenAbsent ?? null);
      const seedValue = field.normalize ? field.normalize(rawSeed, seedRow) : rawSeed;
      const mockValue = field.mock(mockRow);
      const agrees = field.equals ? field.equals(seedValue, mockValue) : sameValue(seedValue, mockValue);
      if (agrees) continue;
      const reason = typeof field.knownDrift === 'string'
        ? field.knownDrift
        : field.knownDrift?.[id];
      const entry: FieldDisagreement = {
        id, field: field.label ?? field.seed, seedValue, mockValue, seedLine: seedRow.line,
        ...(reason ? { knownDrift: reason } : {}),
      };
      (reason ? knownDrift : disagreements).push(entry);
    }
  }

  return {
    entity: entity.name,
    seedCount: seedById.size,
    mockCount: mockById.size,
    comparedIds,
    missingFromMock,
    inventedInMock,
    disagreements,
    knownDrift,
    allowedExtras,
    allowedMissing,
    staleMissingExemptions,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** `null` when the entity is clean; otherwise a diff a human can act on. */
export function describeResult<M>(entity: ParityEntity<M>, r: ParityResult): string | null {
  const bad = r.missingFromMock.length + r.inventedInMock.length + r.disagreements.length
    + r.staleMissingExemptions.length;
  if (bad === 0) return null;

  const lines: string[] = [];
  lines.push('');
  lines.push(`${r.entity} — mock fixture ↔ schema/${entity.sqlFile} (${entity.coverage} coverage)`);
  lines.push(`  ${entity.describes}`);
  lines.push(`  seed rows: ${r.seedCount}   mock rows: ${r.mockCount}   compared: ${r.comparedIds}`);
  lines.push('');

  if (r.missingFromMock.length > 0) {
    lines.push(`  ${r.missingFromMock.length} seeded id(s) MISSING from the mock:`);
    for (const { id, line } of r.missingFromMock.slice(0, 25)) {
      lines.push(`    ${pad(id, 44)} ${entity.sqlFile}:${line}`);
    }
    if (r.missingFromMock.length > 25) lines.push(`    …and ${r.missingFromMock.length - 25} more`);
    lines.push('');
  }

  if (r.inventedInMock.length > 0) {
    lines.push(`  ${r.inventedInMock.length} id(s) INVENTED by the mock (no row in ${entity.sqlFile}):`);
    for (const id of r.inventedInMock.slice(0, 25)) lines.push(`    ${id}`);
    if (r.inventedInMock.length > 25) lines.push(`    …and ${r.inventedInMock.length - 25} more`);
    lines.push('');
  }

  if (r.disagreements.length > 0) {
    lines.push(`  ${r.disagreements.length} field(s) DISAGREE (seed value vs mock value):`);
    const idW = Math.max(...r.disagreements.slice(0, 40).map((d) => d.id.length), 8);
    const fW = Math.max(...r.disagreements.slice(0, 40).map((d) => d.field.length), 8);
    for (const d of r.disagreements.slice(0, 40)) {
      lines.push(
        `    ${pad(d.id, idW)}  ${pad(d.field, fW)}  seed ${pad(showValue(d.seedValue), 28)}` +
        `  mock ${showValue(d.mockValue)}   (${entity.sqlFile}:${d.seedLine})`,
      );
    }
    if (r.disagreements.length > 40) lines.push(`    …and ${r.disagreements.length - 40} more`);
    lines.push('');
  }

  if (r.staleMissingExemptions.length > 0) {
    lines.push(`  ${r.staleMissingExemptions.length} exemption(s) have OUTLIVED the problem they excused:`);
    for (const s of r.staleMissingExemptions) lines.push(`    ${s}`);
    lines.push('');
  }

  lines.push(`  Fix the fixture, or — if the seed moved on purpose — the seed's row for these ids.`);
  lines.push(`  Do NOT widen the parity table to hide it without a knownDrift reason.`);
  return lines.join('\n');
}

/**
 * A `knownDrift` reason opening with this is a bug on the record, not an
 * accepted difference — see `FieldCheck.knownDrift`.
 */
export const DEFECT_PREFIX = 'DEFECT:';

/** Split a drift roll-up into accepted differences and recorded bugs. */
export function partitionDrift(lines: string[]): { accepted: string[]; defects: string[] } {
  const defects = lines.filter((l) => l.includes(`— ${DEFECT_PREFIX}`));
  return { accepted: lines.filter((l) => !defects.includes(l)), defects };
}

/**
 * Everything the harness deliberately tolerates, for the visibility test.
 *
 * Grouped by field+reason, not one line per row. A blanket `knownDrift` over a
 * column of 77 seeded jobs printed 77 identical paragraphs, and a roll-up
 * nobody can read is a roll-up nobody reads — which is the same silence the
 * exemption was supposed to avoid. One line per tolerated *rule*, carrying how
 * many ids it covers and one real pair of values, is the readable form.
 */
export function describeKnownDrift<M>(entity: ParityEntity<M>, r: ParityResult): string[] {
  const out: string[] = [];
  for (const id of r.allowedExtras) {
    out.push(`${r.entity}: mock invents '${id}' — ${entity.allowedExtraIds?.[id] ?? 'no reason given'}`);
  }
  for (const id of r.allowedMissing) {
    out.push(`${r.entity}: mock omits seeded '${id}' — ${entity.allowedMissingIds?.[id] ?? 'no reason given'}`);
  }

  const grouped = new Map<string, { first: FieldDisagreement; ids: string[] }>();
  for (const d of r.knownDrift) {
    const key = `${d.field} ${d.knownDrift ?? ''}`;
    const seen = grouped.get(key);
    if (seen) seen.ids.push(d.id);
    else grouped.set(key, { first: d, ids: [d.id] });
  }
  for (const { first, ids } of grouped.values()) {
    const where = ids.length === 1
      ? `@ ${ids[0]}`
      : `@ ${ids.length} ids (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`;
    out.push(
      `${r.entity}.${first.field} ${where}: e.g. seed ${showValue(first.seedValue)}` +
      ` vs mock ${showValue(first.mockValue)} — ${first.knownDrift ?? 'no reason given'}`,
    );
  }
  return out;
}

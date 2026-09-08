// The joins the ORG GRAPH needs, resolved the way the database resolves them.
//
// `schema/seed.sql` models the graph as edge tables keyed on ids — a
// `person_skills` row says `('p-001', 'sk-analytics', 0.69, 'seed')`. The mock
// renders the same edge as a NAME on a person (`skills: ['AWS', 'Analytics']`),
// because a name is what a page shows. So the two sides cannot be matched
// without doing the join the seed's own foreign key implies.
//
// Doing the join, rather than skipping the column, is the point — it is the
// same argument `resolvePersonSubquery` in ./entities.ts makes for
// `identity_schema.sql`'s `(SELECT id FROM people WHERE name = …)`. Resolving
// 'Analytics' through the seed's own `skills` table checks that the mock's
// vocabulary IS the seed's; a name the seed never defined resolves to nothing
// and the row is reported as invented, which is exactly what should happen.
//
// Nothing here hand-copies an id. Every map is built from the parsed INSERTs.

import { seedRows, seedText, type SeedRow } from './sql-seed.js';

/**
 * `name` → `id` for a seeded lookup table (`skills`, `teams`). Last write
 * wins, matching `seedRowsById`, because the seed files are ON CONFLICT
 * upserts and a later statement for the same row is the one that survives.
 */
export function idByName(fileName: string, table: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of seedRows(fileName, table)) {
    const name = row.values['name'];
    const id = row.values['id'];
    if (typeof name === 'string' && typeof id === 'string') out.set(name, id);
  }
  return out;
}

/**
 * Resolve a display name to the seed's id, or a *legible placeholder* when the
 * seed has no such row. A placeholder rather than a skipped row on purpose: a
 * skipped row is a silently uncompared row, and the whole harness exists
 * because uncompared is how drift survives. The placeholder key matches
 * nothing in the seed, so the mock row is reported as invented, and the id in
 * the failure message says what the mock made up.
 */
export function resolveOrName(map: Map<string, string>, name: string, what: string): string {
  return map.get(name) ?? `<no seeded ${what} named '${name}'>`;
}

/** The composite key both `project_contributions` seeds are keyed on. */
export const contributionKey = (row: SeedRow): string =>
  `${String(row.values['person_id'])}@${String(row.values['project_id'])}`;

/** `person_skills` / `team_memberships` / `collaborations` composite keys. */
export const personSkillKey = (row: SeedRow): string =>
  `${String(row.values['person_id'])}@${String(row.values['skill_id'])}`;
export const teamMembershipKey = (row: SeedRow): string =>
  `${String(row.values['person_id'])}@${String(row.values['team_id'])}`;
export const collaborationKey = (row: SeedRow): string =>
  `${String(row.values['person_a_id'])}@${String(row.values['person_b_id'])}`;

/** Order-independent key for an undirected edge the mock may store either way. */
export const undirectedKey = (a: string, b: string): string =>
  (a < b ? `${a}@${b}` : `${b}@${a}`);

/**
 * TWO SEEDS, ONE PRIMARY KEY, AND THE ONE THAT LOSES.
 *
 * `schema/apply_all_seed.py` loads `seed.sql` before `seed_program.sql`, and
 * every `project_contributions` statement in the program seed ends
 * `ON CONFLICT DO NOTHING`. So where both files write the same
 * (person_id, project_id), the row Aurora ends up holding is the FIRST file's
 * — the program seed's copy is dead SQL that no error reports.
 *
 * This is the `d-iceberg` failure exactly: one row, two authors, the later one
 * silently discarded, and a mock that shows the discarded copy. It is derived
 * from the two files rather than listed, so a collision the seeds stop having
 * stops being reported here with no edit, and a new one starts.
 *
 * Every colliding id gets the SAME reason string, deliberately: `describeKnownDrift`
 * groups the roll-up by field+reason, and a per-id sentence would print 22
 * near-identical paragraphs per column — the unreadable roll-up the grouping
 * was introduced to stop. So the shared reason carries the mechanism once and
 * then lists every colliding row with its line numbers and both values, which
 * is the same information in a form somebody will actually read.
 *
 * @param loserFile  the file whose row is discarded (loaded second)
 * @param winnerFile the file whose row survives (loaded first)
 * @param column     the column to quote for each row, so the reason names values
 */

/**
 * `DELETE FROM <table> WHERE <column> IN (…)` statements in a seed file.
 *
 * A seed that clears the rows it is about to write is not colliding with an
 * earlier seed — it is replacing it, deliberately. `seed_program.sql` opens
 * with exactly that for all fourteen initiatives, which is why its `owner`
 * contributions do land against a real cluster despite `ON CONFLICT DO
 * NOTHING`. Any precedence claim that ignores these statements is guessing.
 */
function clearedByLoser(
  fileName: string,
  table: string,
): Array<{ line: number; covers: (row: SeedRow) => boolean }> {
  const text = seedText(fileName);
  const out: Array<{ line: number; covers: (row: SeedRow) => boolean }> = [];
  const re = new RegExp(
    `DELETE\\s+FROM\\s+${table}\\s+WHERE\\s+([a-z_]+)\\s+IN\\s*\\(([^)]*)\\)`,
    'gi',
  );
  for (const m of text.matchAll(re)) {
    const column = m[1]!;
    const ids = new Set(
      [...m[2]!.matchAll(/'([^']*)'/g)].map((q) => q[1]!),
    );
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ line, covers: (row) => ids.has(String(row.values[column] ?? '')) });
  }
  // A bare `DELETE FROM <table>` with no WHERE clears everything.
  const bare = new RegExp(`DELETE\\s+FROM\\s+${table}\\s*;`, 'gi');
  for (const m of text.matchAll(bare)) {
    out.push({ line: text.slice(0, m.index).split('\n').length, covers: () => true });
  }
  return out;
}

export function lostToAnEarlierSeed(opts: {
  table: string;
  winnerFile: string;
  loserFile: string;
  key: (row: SeedRow) => string;
  column: string;
  note: string;
}): Record<string, string> {
  const winners = new Map(seedRows(opts.winnerFile, opts.table).map((r) => [opts.key(r), r]));
  const cleared = clearedByLoser(opts.loserFile, opts.table);
  const collisions: Array<{ id: string; detail: string }> = [];
  for (const loser of seedRows(opts.loserFile, opts.table)) {
    const id = opts.key(loser);
    const winner = winners.get(id);
    if (!winner) continue;
    // `ON CONFLICT DO NOTHING` only means "first writer wins" if the first
    // writer's row is still THERE. A loser file that DELETEs the rows before
    // inserting has removed the winner, so the later file wins and there is no
    // collision at all. Missing this reported 22 phantom defects on
    // `project_contributions`, six of them an initiative's owner row — a
    // finding that would have sent someone to change a seed that is correct.
    if (cleared.some((c) => c.line < loser.line && c.covers(loser))) continue;
    const show = (row: SeedRow): string => JSON.stringify(row.values[opts.column] ?? null);
    collisions.push({
      id,
      detail: `${id} (${opts.winnerFile}:${winner.line} ${show(winner)} `
        + `wins over ${opts.loserFile}:${loser.line} ${show(loser)})`,
    });
  }
  if (collisions.length === 0) return {};

  const reason = `DEFECT: ${collisions.length} ${opts.table} rows are written by BOTH seeds under one `
    + `primary key. schema/apply_all_seed.py loads schema/${opts.winnerFile} first, and every `
    + `${opts.table} statement in schema/${opts.loserFile} ends ON CONFLICT DO NOTHING — so the `
    + `second file's copy is silently discarded and a real cluster keeps the first file's `
    + `\`${opts.column}\`. The mock carries the DISCARDED copy, so dev:mock and Aurora disagree on `
    + `every one of these rows and nothing errors. This is the d-iceberg failure one table over. `
    + `${opts.note} Fix belongs in schema/ — the two seeds must not write one primary key — not in `
    + `a fixture. Colliding rows: ${collisions.map((c) => c.detail).join('; ')}.`;

  return Object.fromEntries(collisions.map((c) => [c.id, reason]));
}

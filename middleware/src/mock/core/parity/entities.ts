// THE PARITY TABLE — one row per seeded entity.
//
// CLAUDE.md promises `npm run dev:mock` mirrors the SQL seeds. This table is
// where that promise is written down in a form a test can check. Every row
// names four things:
//
//   sqlFile + name   the seed statements that are canonical
//   mockRows         the provider call a route actually serves in dev:mock
//   seedId / mockId  how a row on one side finds its twin on the other
//   fields           the columns that must agree, and how the mock spells them
//
// ADDING A ROW. Touching a fixture? Add (or extend) its row here in the same
// change. A row is ~15 lines and needs no new test — `seed-parity.test.ts`
// walks this array. Use `coverage: 'complete'` when the fixture claims to
// carry the whole seeded set, `'subset'` when it is a curated cast; either
// way an id the mock invents is a failure, because inventing ids is how the
// `wi-k8s-*` and "Developer Onboarding" families shipped.
//
// A disagreement you cannot fix today goes in `knownDrift` (per field) or
// `allowedExtraIds`/`allowedMissingIds` (per id) WITH A REASON. Those are
// printed by the known-drift test, so they stay visible instead of silently
// becoming the new normal.
//
// Providers are imported lazily inside `mockRows` so that this module can be
// loaded (e.g. to list the table) without dragging in the whole provider
// graph, and so a test file controls import order via its own jest.mock calls.

import { sameValue, type ParityEntity } from './compare.js';
import { seedRows, type SeedRow, type SeedValue } from './sql-seed.js';
import { crosswalkStatus as crosswalkRunStatus } from '../../../lib/pipeline-runs.js';
import {
  collaborationKey, contributionKey, idByName, lostToAnEarlierSeed, personSkillKey,
  resolveOrName, teamMembershipKey, undirectedKey,
} from './joins.js';

const num = (v: SeedValue): number | null => (typeof v === 'number' ? v : null);
const str = (v: SeedValue): string | null => (typeof v === 'string' ? v : null);

/** The seed parser's escape hatch: a value it could not reduce to a scalar. */
const isSqlExpression = (v: unknown): v is { raw: string } =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && 'raw' in (v as object);

/**
 * A column the seed writes as a relative expression on SOME rows
 * (`NOW() - INTERVAL '12 days'`) and as a literal on the rest. There is no
 * instant to compare a relative expression against — but there is one thing
 * worth comparing, and it is the thing the portal reads: whether the column is
 * set at all. A done work item must carry a completedAt; an open one must not.
 */
const setExactlyWhenTheSeedSetsIt = (seed: unknown, mock: unknown): boolean =>
  isSqlExpression(seed) ? mock != null : sameValue(seed ?? null, mock ?? null);

/**
 * Read one scalar out of a jsonb column. The seed writes jsonb as its JSON
 * text (`'{"costUsd": 0.1313}'::jsonb`) and the provider hands back the parsed
 * object, so comparing the columns whole would compare text to structure and
 * fail on whitespace. Naming the scalar is both narrower and more honest — and
 * the FieldCheck's `label` says which scalar, so a failure reads
 * `result.costUsd`, not `result`.
 */
const jsonScalar = (key: string) => (v: SeedValue): unknown => {
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v) as Record<string, unknown>;
    return parsed[key] ?? null;
  } catch { return null; }
};

/** Seed `people.team` is a team NAME; the mock calls the same thing `department`. */
const asDepartment = (v: SeedValue): string | null => str(v);

/**
 * `schema/identity_schema.sql` writes `person_id` as a lookup rather than a
 * literal — `(SELECT id FROM people WHERE name = 'Theo Chang' LIMIT 1)` — so
 * the file loads in any order relative to seed.sql. Resolve it the way the
 * database would, against seed.sql's own `people` rows. Doing this rather
 * than skipping the column is the point: it checks that u-theo really is
 * p-001 and not whichever id a fixture author remembered.
 */
function resolvePersonSubquery(v: SeedValue): string | null {
  if (v === null || typeof v === 'string') return v;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const sql = v.raw;
  const byId = /WHERE\s+id\s*=\s*'([^']+)'/i.exec(sql);
  if (byId) return byId[1]!;
  const byName = /WHERE\s+name\s*=\s*'((?:[^']|'')+)'/i.exec(sql);
  if (!byName) return null;
  const name = byName[1]!.replace(/''/g, "'");
  for (const row of seedRows('seed.sql', 'people')) {
    if (row.values['name'] === name) return String(row.values['id']);
  }
  return null;
}

/** Same to the cent — `mock/people.ts` truncates composite_score/100, the
 *  seed rounds. 49.5 → 0.49 or 0.50 are both faithful; 49.5 → 0.62 is not. */
const sameToTheCent = (seed: unknown, mock: unknown): boolean =>
  typeof seed === 'number' && typeof mock === 'number' && Math.abs(seed - mock) <= 0.005 + 1e-9;

/**
 * `decisions.decided_at` is seeded as `DATE '2026-03-12'`, which the seed
 * parser keeps as raw SQL. The RDS Data API hands a DATE back as the bare
 * 'YYYY-MM-DD' the mock carries, so unwrap the literal before comparing.
 */
function asSeedDate(v: SeedValue): string | null {
  if (v === null || typeof v === 'string') return v;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const m = /'([0-9]{4}-[0-9]{2}-[0-9]{2})'/.exec(v.raw);
  return m ? m[1]! : null;
}

/**
 * `decisions` is ONE table with TWO seed authors: schema/seed.sql writes the
 * org graph's settled calls, schema/seed_program.sql writes the ones an
 * initiative raised (it alone can set `work_item_id`, because it emits the
 * work item in the same file). One `ParityEntity` names one file, so the table
 * gets a row per file and each documents the other file's ids as expected
 * extras — READ OUT OF THAT FILE, never typed here, so moving a decision from
 * one seed to the other needs no edit in this one.
 */
function idsAuthoredBy(sqlFile: string, table: string, key: (row: SeedRow) => string): string[] {
  return seedRows(sqlFile, table).map(key);
}

function authoredElsewhere(ids: string[], sqlFile: string, sibling: string): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [
    id,
    `not invented: authored by schema/${sqlFile} — the same table, the other seed. `
    + `Checked against that file by the '${sibling}' row.`,
  ]));
}

const decisionId = (row: SeedRow): string => String(row.values['id']);
const participantKey = (row: SeedRow): string =>
  `${String(row.values['decision_id'])}:${String(row.values['person_id'])}`;

/**
 * PROJECT THE MOCK ROW UNDER THE SEED'S COLUMN NAMES.
 *
 * `columns.ts` pairs a seed column with a mock key by camelCase, and a column
 * it cannot pair is filed as `seedOnly` — out of scope, not a finding. So a
 * projection that renames a column on its way into the parity table makes that
 * column invisible to the very audit that exists to notice uncompared columns:
 * `collaborations.weight` reaches the portal as `strength` and
 * `team_memberships.role` reaches it as a person's `title`, and under those
 * names neither would ever be asked about. Every projection below therefore
 * carries the SEED's spelling, and the rename is done once, in the projection,
 * where a provider rename breaks it at compile time.
 */
interface MockContribution {
  key: string;
  personId: string;
  projectId: string;
  role: string | null;
  weight: number | null;
  name: string;
}

/** Contributors as both `project_contributions` seeds spell them. */
async function contributionRows(): Promise<MockContribution[]> {
  const { listProjects, getProject } = await import('../../../providers/projects.js');
  const out: MockContribution[] = [];
  for (const summary of await listProjects({ limit: 200 })) {
    const detail = await getProject(summary.id);
    if (!detail) continue;
    for (const c of detail.contributors) {
      out.push({
        key: `${c.personId}@${summary.id}`,
        personId: c.personId, projectId: summary.id,
        role: c.role, weight: c.weight ?? null, name: c.name,
      });
    }
  }
  return out;
}

/**
 * The (person, project) pairs both contribution seeds write.
 *
 * ⚠️ This was briefly reported as a DEFECT — "seed.sql loads first and the
 * program seed's rows end ON CONFLICT DO NOTHING, so six initiatives have no
 * owner contribution against a real cluster." That reasoning was static and
 * wrong: `schema/seed_program.sql:6` opens with
 * `DELETE FROM project_contributions WHERE project_id IN (…all fourteen…)`
 * BEFORE any of its inserts, so seed.sql's rows for those projects are gone
 * and the program seed's `owner`/`sme` rows do land. `ON CONFLICT DO NOTHING`
 * only means "first writer wins" while the first writer's row is still there.
 *
 * `lostToAnEarlierSeed` now reads those DELETEs and reports nothing here, which
 * is the correct answer — so this stays as a knownDrift against **seed.sql**
 * only, because the mock deliberately carries the program seed's value (the one
 * a real cluster ends with) while this entity's `sqlFile` is seed.sql. Derived
 * from the DELETE list, so it needs no edit if the seeds' division of labour
 * changes.
 */
const contributionCollisions = (column: string): Record<string, string> => {
  const stillColliding = lostToAnEarlierSeed({
    table: 'project_contributions',
    winnerFile: 'seed.sql',
    loserFile: 'seed_program.sql',
    key: contributionKey,
    column,
    note: 'If this ever reports again, the DELETE that makes the program seed authoritative '
      + 'has been removed or narrowed, and six initiatives really would lose their owner row.',
  });
  if (Object.keys(stillColliding).length > 0) return stillColliding;

  const reason = `seed_program.sql is authoritative for the fourteen initiative projects: it `
    + `DELETEs every project_contributions row for them (seed_program.sql:6) before writing its `
    + `own owner/sme rows, so a real cluster ends with ITS \`${column}\`, not seed.sql's. The mock `
    + `carries the program seed's value, which is correct; this entity is declared against `
    + `seed.sql, so the two disagree here by design.`;
  const out: Record<string, string> = {};
  for (const row of seedRows('seed_program.sql', 'project_contributions')) {
    out[contributionKey(row)] = reason;
  }
  return out;
};

export const PARITY_ENTITIES: Array<ParityEntity<any>> = [
  // ── the org graph (schema/seed.sql) ────────────────────────────────────────
  //
  // THREE ORG-GRAPH TABLES ARE DELIBERATELY ABSENT, and it is worth writing
  // down which and why, so the next reader does not take the gap for an
  // oversight. `documents`, `mentions` and `node_embeddings` are DELETEd at the
  // top of schema/seed.sql and never written by it — or by any other file under
  // schema/*.sql. Their only author is schema/synth/load.py, the LLM corpus
  // pipeline, which runs against a live Aurora + Bedrock and costs real money.
  // A column no seed writes is not drift, and there is nothing here to compare
  // against; a parity row for them would be a row that passes vacuously.
  {
    name: 'people',
    describes: 'The 56-person cast every surface renders by id — the single source for a person\'s name.',
    lesson: 'person-identity-parity: the same id must resolve to the same human on every surface.',
    sqlFile: 'seed.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../people.js')).mockPeople,
    mockId: (p: { id: string }) => p.id,
    fields: [
      { seed: 'name', mock: (p: { name: string }) => p.name },
      { seed: 'title', mock: (p: { title: string }) => p.title },
      { seed: 'team', mock: (p: { department: string }) => p.department, normalize: asDepartment },
      {
        seed: 'composite_score',
        mock: (p: { influenceScore: number }) => p.influenceScore,
        // mock/people.ts documents influenceScore as composite_score/100.
        normalize: (v) => (typeof v === 'number' ? v / 100 : null),
        equals: sameToTheCent,
      },
    ],
  },
  {
    name: 'teams',
    describes: 'Departments used to colour the graph and group the people list.',
    sqlFile: 'seed.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../people.js')).departments,
    // Seed team ids are `t-platform`; the fixture slugs the NAME instead, so
    // match on the name and let the field check cover the rest.
    seedKey: (row) => String(row.values['name']),
    mockId: (d: { name: string }) => d.name,
    fields: [
      { seed: 'name', mock: (d: { name: string }) => d.name },
    ],
  },
  {
    name: 'projects',
    describes: 'The 14 canonical p-* initiatives behind /iq/projects and every initiative-scoped route.',
    sqlFile: 'seed.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/projects.js')).listProjects({ limit: 200 }),
    mockId: (p: { id: string }) => p.id,
    fields: [
      { seed: 'name', mock: (p: { name: string }) => p.name },
      { seed: 'status', mock: (p: { status: string }) => p.status },
    ],
  },

  {
    name: 'skills',
    describes: 'The skill vocabulary the graph, the person page and the search agent all name — 38 rows, and the only place a skill name is defined.',
    lesson:
      'rule 2 at the data level: a skill name the mock invents is a term no seeded row, no KB document and no agent answer can ever match, and it looks identical to a real one on the page.',
    sqlFile: 'seed.sql',
    seedId: '',
    // The mock never carries `skills` as rows — `fetchSkillsGraph` and
    // `getTopSkills` both return [] offline (a rule-4 gap of their own). What
    // it does carry is the vocabulary: the distinct names mock/people.ts hangs
    // on people. Matching on the NAME is therefore the only join available,
    // and it is the one that matters, because the name is what renders.
    seedKey: (row) => String(row.values['name']),
    // `complete` is a claim about the CAST, and it is worth making: every one
    // of the 38 seeded skills is held by somebody in mock/people.ts today, so
    // every skill an agent could be asked about has an offline answer. A
    // "MISSING from the mock" failure here means a seeded skill nobody holds
    // any more — give it to someone, or drop to `subset` with a reason. It does
    // NOT mean mock/people.ts lost a skill name; that fails as an invented id.
    coverage: 'complete',
    mockRows: async () => {
      const { mockPeople } = await import('../../people.js');
      return [...new Set(mockPeople.flatMap((p) => p.skills))].map((name) => ({ name }));
    },
    mockId: (s: { name: string }) => s.name,
    fields: [
      { seed: 'name', mock: (s: { name: string }) => s.name },
    ],
  },
  {
    name: 'person_skills',
    describes: 'HAS_SKILL: the 244 edges that make a person an expert in something — what /api/graph/person/:id renders and what the search agent retrieves on.',
    lesson:
      'person-identity-parity, one edge out: an invented skill edge makes the mock answer "who knows Kubernetes?" with someone the seed never said knew it.',
    sqlFile: 'seed.sql',
    seedId: '',
    seedKey: personSkillKey,
    coverage: 'complete',
    mockRows: async () => {
      const { mockPeople } = await import('../../people.js');
      const skillIds = idByName('seed.sql', 'skills');
      return mockPeople.flatMap((p) => p.skills.map((name) => ({
        key: `${p.id}@${resolveOrName(skillIds, name, 'skill')}`,
        personId: p.id,
      })));
    },
    mockId: (e: { key: string }) => e.key,
    // `weight` and `source` are on the seed row and on no mock row: the mock
    // renders an ORDERED LIST of names, so the weight survives only as the
    // order. That is not nothing, and it is not comparable per-row either —
    // it is checked across rows by the `a person's skills are listed in the
    // seed's weight order` invariant in ./invariants.ts.
    fields: [],
  },
  {
    name: 'team_memberships',
    describes: 'MEMBER_OF: which team each of the 56 people belongs to and what they do there — the department the graph colours by and the people list groups on.',
    lesson:
      'The same fact lives in `people.team` and in this edge table. A mock agreeing with one and not the other puts a person in two departments depending on which read answered.',
    sqlFile: 'seed.sql',
    seedId: '',
    seedKey: teamMembershipKey,
    coverage: 'complete',
    mockRows: async () => {
      const { mockPeople } = await import('../../people.js');
      const teamIds = idByName('seed.sql', 'teams');
      return mockPeople.map((p) => ({
        key: `${p.id}@${resolveOrName(teamIds, p.department, 'team')}`,
        personId: p.id,
        // The seed's `role` on this edge is the person's role ON the team; the
        // mock spells the same string `title`. Projected under the seed's name
        // so ./columns.ts can pair it — see the note on MockContribution.
        role: p.title,
      }));
    },
    mockId: (m: { key: string }) => m.key,
    fields: [
      { seed: 'role', mock: (m: { role: string }) => m.role },
    ],
  },
  {
    name: 'collaborations',
    describes: 'WORKED_WITH: the 216 undirected edges the org graph draws, and the weights that size them.',
    lesson:
      'An edge list that agrees on WHO is connected and disagrees on HOW STRONGLY is the allocation bug in graph form — every id present, every number wrong, and a picture that reads differently.',
    sqlFile: 'seed.sql',
    seedId: '',
    seedKey: collaborationKey,
    coverage: 'complete',
    mockRows: async () => {
      const { mockRelationships } = await import('../../people.js');
      return mockRelationships.map((r) => ({
        // The seed stores each edge once under `person_a_id < person_b_id`
        // (a CHECK constraint in schema/orgiq_schema.sql). Keying on the
        // ordered pair means a mock edge stored the other way round still
        // finds its twin — and is then caught by the `person_a_id` check
        // below rather than mis-reported as an invented edge.
        key: undirectedKey(r.source, r.target),
        personAId: r.source,
        weight: r.strength,
      }));
    },
    mockId: (r: { key: string }) => r.key,
    fields: [
      { seed: 'weight', mock: (r: { weight: number }) => r.weight, normalize: num },
      {
        seed: 'person_a_id',
        label: 'person_a_id (edge direction)',
        mock: (r: { personAId: string }) => r.personAId,
      },
    ],
  },
  {
    name: 'graph project_contributions',
    sqlTable: 'project_contributions',
    describes: 'WORKED_ON as the ORG GRAPH seed writes it: 110 lead/contributor/reviewer edges over the same primary key the program seed writes owner/sme into.',
    lesson:
      'decision-parity, one table over: `decisions` was split across two seeds under one id and the second copy lost to ON CONFLICT DO NOTHING. This table is split the same way, and 22 rows collide.',
    sqlFile: 'seed.sql',
    seedId: '',
    seedKey: contributionKey,
    // `subset`: the mock models only the operating model's owner/sme roles, so
    // most of seed.sql's 110 edges have no mock counterpart. The 22 that DO
    // overlap are the whole point of this row.
    coverage: 'subset',
    mockRows: contributionRows,
    mockId: (c: MockContribution) => c.key,
    allowedExtraIds: authoredElsewhere(
      idsAuthoredBy('seed_program.sql', 'project_contributions', contributionKey),
      'seed_program.sql', 'project_contributions',
    ),
    fields: [
      { seed: 'role', mock: (c: MockContribution) => c.role, knownDrift: contributionCollisions('role') },
      {
        seed: 'weight',
        mock: (c: MockContribution) => c.weight,
        normalize: num,
        knownDrift: contributionCollisions('weight'),
      },
    ],
  },
  {
    name: 'leaderboard people',
    sqlTable: 'people',
    describes: 'The same `people` rows read by the expertise leaderboard (mock/scores.ts) rather than by the graph — /iq/scores, the cohort distribution and every person page score panel.',
    lesson:
      'One table, two mock readers. mock/people.ts takes its number from the seed and mock/scores.ts makes its own up, so the same person ranks first on one surface and near-last on the other.',
    sqlFile: 'seed.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => {
      const { mockScores } = await import('../../scores.js');
      return mockScores.map((s) => ({
        id: s.personId,
        name: s.name,
        team: s.department,
        // 0–1 on this surface, 0–100 in the seed; normalized on the seed side
        // by the FieldCheck rather than here, so the audit and the check read
        // the same number the leaderboard renders.
        expertiseScore: s.expertise,
        compositeScore: s.composite,
        scoredAt: s.scoredAt,
      }));
    },
    mockId: (p: { id: string }) => p.id,
    fields: [
      { seed: 'name', mock: (p: { name: string }) => p.name },
      { seed: 'team', mock: (p: { team: string }) => p.team, normalize: asDepartment },
      {
        seed: 'expertise_score',
        mock: (p: { expertiseScore: number }) => p.expertiseScore,
        normalize: (v) => (typeof v === 'number' ? v / 100 : null),
        equals: sameToTheCent,
        knownDrift:
          'DEFECT: mock/scores.ts invents its five axes rather than reading the seed. `expertise` there is unrelated to `people.expertise_score` — p-023 is 0.96 in the fixture and 33.53 in the seed. providers/aurora.ts serves this array from getLeaderboard() offline and the real `people` columns online, so /iq/scores shows two different orderings of the same cast depending on the mode: the fixture ranks p-023 first, the seed ranks it 47th of 56 by composite_score. Fix belongs in middleware/src/mock/scores.ts:77 (the SEEDS array) — derive the axes from schema/seed.sql\'s expertise_score/pagerank_score, or stop claiming these are the same people\'s scores.',
      },
      {
        seed: 'composite_score',
        mock: (p: { compositeScore: number }) => p.compositeScore,
        normalize: num,
        equals: (seed, mock) =>
          typeof seed === 'number' && typeof mock === 'number' && Math.abs(seed - mock) <= 0.5,
        knownDrift:
          'DEFECT: follows from expertise_score above — mock/scores.ts derives `composite` as the mean of its five invented axes, so it inherits the drift. It also contradicts mock/people.ts, which takes `influenceScore` from this very column: p-023 is composite 89 on the leaderboard and influenceScore 0.47 (= the seed\'s 46.98) on the graph, two numbers for one person in one process. Fix belongs in middleware/src/mock/scores.ts:77.',
      },
    ],
  },

  // ── the program operating model (schema/seed_program.sql) ──────────────────
  {
    name: 'project_contributions',
    describes: 'Who owns and who SMEs each initiative — the roles /iq/projects/:id renders and requireInitiativeSteward gates on.',
    lesson: 'person-identity-parity: an owner/SME name must be the seed\'s person, not a fixture\'s.',
    sqlFile: 'seed_program.sql',
    seedId: '',
    seedKey: (row) => `${row.values['person_id']}@${row.values['project_id']}`,
    // Only owner/sme contributions are modelled by MOCK_INITIATIVES (the
    // operating model's two roles); seed.sql's older lead/contributor/reviewer
    // rows live in a different file and are not part of this row.
    coverage: 'complete',
    mockRows: contributionRows,
    mockId: (c: MockContribution) => c.key,
    fields: [
      { seed: 'role', mock: (c: MockContribution) => c.role },
      // The operating model's two roles carry two weights (owner 1.0, SME 0.8)
      // and /iq/projects/:id sorts its contributor list by them, so the owner
      // is whoever sorts first. It was never compared — the projection used to
      // drop the column, and a column the mock row does not carry is outside
      // the coverage audit's question by construction.
      { seed: 'weight', mock: (c: MockContribution) => c.weight, normalize: num },
    ],
  },
  {
    name: 'work_items',
    describes: 'Epics/stories/bugs behind the Work tab, the work queue, dispatch and every points rollup.',
    lesson: 'work-items-seed-parity: an initiative\'s work must be the work the seed gave it (no wi-k8s-*, no wi-onboard-*).',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    // Every one of the 14 initiatives' seeded work items now has a mock
    // counterpart (member defect #14: p-design-system-api had none, and
    // p-auth-migration was missing 4 of its 9). 'subset' was exactly how
    // that went unnoticed for so long — a 7-of-14 fixture still passed. No
    // allowedMissingIds: there is no seeded work_items row this fixture
    // means to omit.
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/work-items.js')).searchWorkItems({ limit: 1000 }),
    mockId: (i: { id: string }) => i.id,
    fields: [
      { seed: 'work_item_key', mock: (i: { key?: string | null }) => i.key ?? null },
      { seed: 'project_id', mock: (i: { projectId: string }) => i.projectId },
      { seed: 'parent_id', mock: (i: { parentId: string | null }) => i.parentId },
      { seed: 'type', mock: (i: { type: string }) => i.type },
      { seed: 'title', mock: (i: { title: string }) => i.title },
      { seed: 'status', mock: (i: { status: string }) => i.status },
      { seed: 'priority', mock: (i: { priority: string }) => i.priority },
      { seed: 'assignee_id', mock: (i: { assigneeId: string | null }) => i.assigneeId },
      { seed: 'story_points', mock: (i: { storyPoints: number | null }) => i.storyPoints, normalize: num },
      { seed: 'estimated_cost_usd', mock: (i: { estimatedCostUsd: number | null }) => i.estimatedCostUsd, normalize: num },
      { seed: 'sprint_id', mock: (i: { sprintId: string | null }) => i.sprintId },
      { seed: 'pr_url', mock: (i: { prUrl: string | null }) => i.prUrl },
      { seed: 'pr_status', mock: (i: { prStatus: string | null }) => i.prStatus },
      /**
       * `kindOf` (lib/work-suggestions.ts) derives the `blocked` suggestion
       * kind from a `blocked` label because the status enum has no such
       * state. Comparing the whole `labels` array would fail on unrelated,
       * pre-existing drift (epic rows carry a topic label in the mock —
       * 'otel', 'slo' — but the seed always writes NULL for an epic's
       * labels), so this checks only the one bit that a suggestion kind
       * actually reads: does the item carry 'blocked' on both sides. This
       * is what used to only be true offline — see wi-obs-e2-b4 and
       * wi-auth-e2-s2.
       */
      {
        seed: 'labels',
        label: 'labels[blocked]',
        mock: (i: { labels: readonly string[] }) => i.labels.includes('blocked'),
        normalize: (v) => Array.isArray(v) && v.includes('blocked'),
      },
      /**
       * Completion is a date the seed writes as `NOW() - INTERVAL 'N days'` for
       * a done item and omits for every other, so there is no instant to
       * compare — but "set exactly when the seed sets it" is the half the Work
       * tab renders, and it is what makes a done item look done.
       */
      {
        seed: 'completed_at',
        mock: (i: { completedAt: string | null }) => i.completedAt,
        equals: setExactlyWhenTheSeedSetsIt,
      },
      /**
       * The brief (schema/orgiq_work_items_schema.sql): copy the initiative
       * Overview and a work item's Brief render verbatim — the attention
       * callout, a Plan-next row, the Next-step callout. The seed writes it
       * with UPDATEs after the inserts (generate_program_seed.py BRIEFS), and
       * absent means NULL, so every other row must be null in the mock too.
       */
      { seed: 'summary', mock: (i: { summary: string | null }) => i.summary },
      { seed: 'blocked_reason', mock: (i: { blockedReason: string | null }) => i.blockedReason },
      { seed: 'next_step', mock: (i: { nextStep: string | null }) => i.nextStep },
      { seed: 'next_step_detail', mock: (i: { nextStepDetail: string | null }) => i.nextStepDetail },
      /**
       * The seed omits `description` on most story/bug rows (the column is not
       * even in their INSERT column list), and the mock writes prose for three
       * of them. Text, not a number — but it is text the item detail renders as
       * though the seed said it, so the three are named rather than waved
       * through as a class. A fourth invented description fails here.
       *
       * There were six. All six are now SEEDED — the generator's BRIEFS
       * UPDATEs write them (the three wi-auth-* ones since 2026-10-15, the
       * Auth Migration demo story), and sql-seed.ts overlays an UPDATE onto
       * the row it names — so they are compared, not excused.
       */
      {
        seed: 'description',
        mock: (i: { description: string | null }) => i.description,
      },
    ],
  },
  {
    name: 'sprints',
    describes: 'Sprint envelopes behind /iq/sprints and the grant-scoped dispatch gate.',
    lesson: 'program-seed-parity: the demo persona\'s initiative must have the sprint the seed gave it.',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => (await import('../../../providers/sprints.js')).listSprints({ limit: 400 }),
    mockId: (s: { id: string }) => s.id,
    fields: [
      { seed: 'org_project_id', mock: (s: { orgProjectId: string }) => s.orgProjectId },
      { seed: 'name', mock: (s: { name: string }) => s.name },
      { seed: 'goal', mock: (s: { goal: string | null }) => s.goal },
      { seed: 'steward_person_id', mock: (s: { stewardPersonId: string | null }) => s.stewardPersonId },
      { seed: 'status', mock: (s: { status: string }) => s.status },
    ],
  },
  {
    name: 'budget_grants',
    describes: 'The SME sprint envelopes decideEnvelope() spends against.',
    lesson: 'program-seed-parity: an envelope present in the mock must be the seed\'s envelope, to the dollar.',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => (await import('../../../providers/budgets.js')).listGrants(),
    mockId: (g: { id: string }) => g.id,
    fields: [
      { seed: 'org_project_id', mock: (g: { orgProjectId: string }) => g.orgProjectId },
      { seed: 'sprint_id', mock: (g: { sprintId: string | null }) => g.sprintId },
      { seed: 'grantee_person_id', mock: (g: { granteePersonId: string }) => g.granteePersonId },
      { seed: 'allocated_usd', mock: (g: { allocatedUsd: number }) => g.allocatedUsd, normalize: num },
      { seed: 'granted_by', mock: (g: { grantedBy: string | null }) => g.grantedBy },
    ],
  },
  {
    name: 'initiative_budgets',
    describes: 'Monthly allocations on /admin/budgets, read against the maintenance floor.',
    lesson:
      'allocation-value-parity: the ledger agreed with the seed about WHICH initiatives have a budget and disagreed about HOW MUCH, and nothing failed. Money is the column a reader acts on.',
    sqlFile: 'seed_program.sql',
    seedId: 'org_project_id',
    // Was 'subset', and 'subset' was the hole. Aurora's ledger query unions
    // "has an allocation" with "has spend this period", so a cluster carrying
    // schema/seed_program.sql returns a row for all 14 initiatives — while the
    // mock shipped 12, silently, because a subset fixture may omit anything.
    // p-data-lake ($15) and p-zero-trust ($10) were the two it omitted: both
    // hold an allocation and no maintenance bot, which is why they looked
    // skippable, and neither was — an allocation with no maintenance floor to
    // read it against is still an allocation /admin/budgets must show, and
    // p-zero-trust even carries a live sprint on /iq/sprints, so a missing
    // ledger row there was two surfaces disagreeing about one initiative. Both
    // now carry the seed's number. 'complete' is what makes the next omission
    // fail rather than pass.
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/budgets.js')).listBudgets(),
    mockId: (b: { orgProjectId: string }) => b.orgProjectId,
    fields: [
      {
        // No knownDrift for p-observability / p-llm-platform / p-cost-opt. It
        // used to be here, reading "plausible against the seed's volumes"; that
        // sentence is what let $60 stand against the seed's $95 for months. An
        // allocation is not a mood, and the exemption that tolerated three of
        // them was the check this harness most needed to be making.
        seed: 'allocated_usd',
        mock: (b: { allocatedUsd: number | null }) => b.allocatedUsd,
        normalize: num,
        knownDrift: {
          'p-inference-platform': 'DELIBERATE: an initiative spending with no allocation is the blind spot /admin/budgets exists to surface, so the ledger row carries null on purpose.',
        },
      },
      {
        seed: 'period',
        mock: (b: { period: string | null }) => b.period,
        knownDrift: {
          'p-inference-platform': 'A period is the window an allocation covers, and this initiative deliberately has no allocation (see allocated_usd above). Carrying the seed\'s `monthly` beside a null amount would render on /admin/budgets as a monthly budget that happens to be empty — which is the opposite of the finding the null is there to make: this initiative is spending and nobody has budgeted it at all.',
        },
      },
      {
        // The release manager who set the allocation — rendered beside it on
        // /admin/budgets, so a wrong one misattributes a spending decision.
        seed: 'updated_by',
        mock: (b: { updatedBy: string | null }) => b.updatedBy,
        knownDrift: {
          'p-inference-platform': 'follows from the deliberate null allocation above: providers/budgets.ts derives updatedBy as null whenever there is no allocation to attribute.',
        },
      },
    ],
  },
  {
    name: 'agent_projects',
    describes: 'The repo that delivers each initiative — what preflightWorkItem() requires before any dispatch.',
    lesson: 'agent-projects-seed-parity: every seeded initiative must resolve a codebase, or dispatch 400s.',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/agent-projects.js')).listAgentProjects(),
    mockId: (p: { id: string }) => p.id,
    fields: [
      { seed: 'repo_full_name', mock: (p: { repoFullName: string }) => p.repoFullName },
      { seed: 'org_project_id', mock: (p: { orgProjectId: string | null }) => p.orgProjectId },
      { seed: 'default_branch', mock: (p: { defaultBranch: string }) => p.defaultBranch },
      /**
       * The only visibility signal a linked repo carries: null reads as
       * "public, no credential" on /admin/projects and sends clones and pushes
       * out with no token. Every initiative repo is private, so a mock that
       * drifted back to null would show all fourteen as public again.
       */
      { seed: 'connection_name', mock: (p: { connectionName: string | null }) => p.connectionName },
    ],
  },
  {
    name: 'bots',
    describes: 'Standing cron missions — the maintenance floor of each initiative (v_initiative_maintenance_30d).',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => (await import('../../../providers/bots.js')).listBots(),
    mockId: (b: { id: string }) => b.id,
    fields: [
      { seed: 'name', mock: (b: { name: string }) => b.name },
      { seed: 'template', mock: (b: { template: string }) => b.template },
      { seed: 'org_project_id', mock: (b: { orgProjectId: string | null }) => b.orgProjectId },
      { seed: 'model', mock: (b: { model: string }) => b.model },
      { seed: 'trigger', mock: (b: { trigger: string }) => b.trigger },
      { seed: 'cron_expr', mock: (b: { cronExpr: string | null }) => b.cronExpr },
      { seed: 'enabled', mock: (b: { enabled: boolean }) => b.enabled },
      { seed: 'budget_per_run_usd', mock: (b: { budgetPerRunUsd: number | null }) => b.budgetPerRunUsd, normalize: num },
      { seed: 'budget_per_day_usd', mock: (b: { budgetPerDayUsd: number | null }) => b.budgetPerDayUsd, normalize: num },
      { seed: 'max_runs_per_day', mock: (b: { maxRunsPerDay: number }) => b.maxRunsPerDay, normalize: num },
      { seed: 'requires_review', mock: (b: { requiresReview: boolean }) => b.requiresReview },
      { seed: 'created_by', mock: (b: { createdBy: string | null }) => b.createdBy },
      /**
       * Why a bot is parked is the sentence /iq/bots renders under a disabled
       * bot, so a wrong one is an operator reading the wrong reason for the
       * wrong remedy: "provision the repo" against a bot that is off because
       * its initiative shipped.
       */
      {
        seed: 'paused_reason',
        mock: (b: { pausedReason: string | null }) => b.pausedReason,
        knownDrift: {
          'f595b10b-5f52-50d0-81a0-9117e9334fb4':
            'DEFECT: rag-index-health. schema/seed_program.sql:326 parks it with \'initiative completed — bot parked\' (p-rag-search is done); providers/bots.ts overwrites that with the fleet-wide \'awaiting repo provisioning — un-pause once the repository exists\'. The blanket reason is right for the bots the mock parks itself and wrong for the one the seed had already parked, for a different reason. Fix belongs in providers/bots.ts.',
        },
      },
    ],
  },
  {
    name: 'bot_runs',
    describes: 'Run history on /iq/bots/:id — each row links to the job it enqueued.',
    lesson: 'bots-run-job-parity: every run\'s jobId has to resolve, or the run-history link spins forever.',
    sqlFile: 'seed_program.sql',
    // Run ids are generated on both sides (the seed mints UUIDs, the fixture
    // mints `<botId>-run-N`), so they carry no shared identity to match on.
    // The job a run enqueued does: it is the link the run-history row renders
    // and the reason bots-run-job-parity existed at all.
    seedId: '',
    seedKey: (row) => String(row.values['job_id']),
    seedFilter: (row) => typeof row.values['job_id'] === 'string',
    coverage: 'subset',
    mockRows: async () => {
      const { listBots, listBotRuns } = await import('../../../providers/bots.js');
      const out: Array<{ jobId: string | null }> = [];
      for (const bot of await listBots()) out.push(...await listBotRuns(bot.id, 500));
      return out.filter((r) => typeof r.jobId === 'string');
    },
    mockId: (r: { jobId: string }) => r.jobId,
    fields: [
      { seed: 'bot_id', mock: (r: { botId: string | null }) => r.botId },
      { seed: 'trigger', mock: (r: { trigger: string }) => r.trigger },
      { seed: 'status', mock: (r: { status: string }) => r.status },
      {
        seed: 'cost_usd',
        mock: (r: { costUsd: number | null }) => r.costUsd,
        normalize: num,
        knownDrift: 'providers/bots.ts hand-picks per-run costs so the narrative adds up ("2 runs today (0.16 + 0.10 = 0.26)") and re-times every run against the live clock via todayHoursAgo() — neither the timestamps nor the individual costs claim to be the seed\'s. The run→job link, the bot and the status do, and those are checked above.',
      },
      {
        // Why the run happened, out of the jsonb the run history renders.
        seed: 'outcome',
        label: 'outcome.reason',
        mock: (r: { outcome: { reason?: string } | null }) => r.outcome?.reason ?? null,
        normalize: jsonScalar('reason'),
      },
    ],
    uncheckedColumns: {
      id: 'run ids are minted independently on both sides — the seed mints UUIDs, providers/bots.ts mints `<botId>-run-N` — which is exactly why this entity matches on job_id instead. Comparing them would report 77 disagreements that mean nothing.',
    },
  },
  {
    name: 'agent_jobs',
    describes: 'The fleet dispatcher queue behind /iq/work — where a bot run\'s jobId has to land.',
    lesson: 'bots-run-job-parity: a job minted from a run keeps the run\'s provenance.',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => (await import('../../../providers/agent-jobs.js')).listJobs({ limit: 500 }),
    mockId: (j: { id: string }) => j.id,
    fields: [
      { seed: 'kind', mock: (j: { kind: string }) => j.kind },
      { seed: 'title', mock: (j: { title: string }) => j.title },
      { seed: 'status', mock: (j: { status: string }) => j.status },
      { seed: 'bot_id', mock: (j: { botId: string | null }) => j.botId },
      { seed: 'created_by', mock: (j: { createdBy: string | null }) => j.createdBy },
      // The numbers on the queue row: where it sits in the run order, how many
      // times it has been tried, and how many tries it gets before
      // reapStaleJobs() fails it for good.
      { seed: 'priority', mock: (j: { priority: number }) => j.priority, normalize: num },
      { seed: 'attempts', mock: (j: { attempts: number }) => j.attempts, normalize: num },
      {
        seed: 'max_attempts',
        mock: (j: { maxAttempts: number }) => j.maxAttempts,
        normalize: num,
        knownDrift:
          'DEFECT: every seeded job allows 1 attempt (schema/seed_program.sql, `max_attempts` = 1); seedMockJobsFromBotRuns in providers/agent-jobs.ts mints 2 for all 77. A job the seed says is one-shot reads as retryable in dev:mock, so the "attempts 1/1 — exhausted" state the reaper produces is unreachable there. Fix belongs in providers/agent-jobs.ts.',
      },
      {
        seed: 'result',
        label: 'result.costUsd',
        mock: (j: { result: { costUsd?: number } | null }) => j.result?.costUsd ?? null,
        normalize: jsonScalar('costUsd'),
        knownDrift:
          'the same hand-picked per-run costs as bot_runs.cost_usd above — this jsonb is the job-side copy of that number, so it drifts for the same documented reason. (result.summary is the fixture\'s own phrasing and nothing derives from it.)',
      },
      {
        seed: 'payload',
        label: 'payload.requiresReview',
        mock: (j: { payload: { requiresReview?: boolean } }) => j.payload?.requiresReview ?? null,
        normalize: jsonScalar('requiresReview'),
        knownDrift:
          'DEFECT: and it is the SEED that is wrong here. Every one of the 12 seeded bots sets `requires_review = TRUE`, yet schema/seeds/generate_program_seed.py writes a constant `"requiresReview": false` into every job payload it mints from those same bots. The mock carries the coherent value (true). Fix belongs in the generator, not in either fixture; nothing here should be changed to match a seed that contradicts itself.',
      },
      // The rest of `payload` is the prompt, which the generator truncates to
      // 120 characters (`…triage flaky pipeline tests, lint `) while the mock
      // carries the bot's whole prompt_template. A generator artifact, not a
      // fixture claim, so the scalar above is the part worth pinning.
    ],
  },

  // ── the pipelines run projection (lib/pipeline-runs.ts) ────────────────────
  //
  // docs/pipelines-tenant-goal.md §Registration row 10: the design's P0 judge
  // is "every seed row appears exactly once with a valid PipelineRunStatus,
  // under dev:mock and against Aurora". The mock rows below ARE the projection
  // (providers/pipeline-runs.ts over the registered fixtures); the seed side is
  // the same crosswalk (`crosswalkStatus`, imported from the projection) over
  // the SQL seed. Of the five run-shaped tables only `agent_jobs` and
  // `bot_runs` are seeded (agent_project_runs, assessment_runs and
  // distillation_compactions have no INSERTs in schema/), so two rows pin it:
  // the Run keyed on its job, and the bot firing folded into it as trigger.
  {
    name: 'pipeline runs',
    describes: 'The pipelines run projection — each seeded agent_jobs row is one Run, its status crosswalked into pipeline-runtime\'s nine and kept verbatim as context.sourceStatus.',
    lesson: 'pipelines P0: a projection that drops or double-counts a seed row, or guesses a status, is not a ledger.',
    sqlFile: 'seed_program.sql',
    sqlTable: 'agent_jobs',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => {
      const { loadProjection } = await import('../../../providers/pipeline-runs.js');
      return (await loadProjection()).runs.filter((r) => r.context.table === 'agent_jobs');
    },
    mockId: (r: { context: { id: string } }) => r.context.id,
    fields: [
      {
        seed: 'status',
        label: 'status (crosswalked)',
        mock: (r: { status: string }) => r.status,
        normalize: (v: SeedValue) => (typeof v === 'string' ? crosswalkRunStatus(v) : null),
      },
      {
        seed: 'status',
        label: 'context.sourceStatus',
        mock: (r: { context: { sourceStatus: string } }) => r.context.sourceStatus,
      },
      {
        seed: 'bot_id',
        label: 'definitionId',
        mock: (r: { definitionId: string }) => r.definitionId,
        normalize: (v: SeedValue) => (typeof v === 'string' ? `bot:${v}` : null),
      },
    ],
    uncheckedColumns: {
      finished_at: 'written by the seed as a relative NOW() expression and re-timed on the mock side by the same clock drift the bot_runs row documents; the agent_jobs entity already owns this column.',
    },
  },
  {
    name: 'pipeline run triggers',
    describes: 'The bot firing folded into each projected job Run as its trigger record (context.sources role trigger) — the "once" rule of docs/pipelines-tenant-goal.md.',
    sqlFile: 'seed_program.sql',
    sqlTable: 'bot_runs',
    seedId: '',
    seedKey: (row) => String(row.values['job_id']),
    seedFilter: (row) => typeof row.values['job_id'] === 'string',
    coverage: 'subset',
    mockRows: async () => {
      const { loadProjection } = await import('../../../providers/pipeline-runs.js');
      const out: Array<{ jobId: string; status: string; runStatus: string }> = [];
      for (const r of (await loadProjection()).runs) {
        if (r.context.table !== 'agent_jobs') continue;
        const t = r.context.sources.find((s) => s.role === 'trigger' && s.table === 'bot_runs');
        if (t) out.push({ jobId: r.context.id, status: t.status, runStatus: r.status });
      }
      return out;
    },
    mockId: (t: { jobId: string }) => t.jobId,
    fields: [
      { seed: 'status', mock: (t: { status: string }) => t.status },
    ],
  },
  // The pipelines tenant's definition registry (lane P2). schema/pipeline_schema.sql
  // seeds the nine assessment commands at version 1; the mock side is the
  // DERIVED registry (lib/pipeline-definitions.ts over AGENT_COMMANDS merged
  // with the `pipelines.definitions` fixture), so a command added to the
  // worker's list and not to the seed — or seeded under the wrong agent —
  // fails here. Only the registry's commands are compared: its bots,
  // runbooks and agents are derived from their own tables.
  {
    name: 'pipeline_definitions',
    describes: 'Definitions the pipelines tenant catalogs — the seeded assessment commands, each owned by the agent that runs it, against the derived registry.',
    lesson: 'pipelines P2: a catalog derived from the worker\'s command list and a seed typed beside it drift the day one command is added.',
    sqlFile: 'pipeline_schema.sql',
    seedId: 'id',
    coverage: 'subset',
    mockRows: async () => {
      const { loadDefinitions } = await import('../../../providers/pipeline-definitions.js');
      // The registry's commands only: its bots, runbooks and agents are
      // derived from tables the seed does not write here (their own entities).
      // Only those the seed RECORDS: the deck commands (draft-/revise-review-deck)
      // are derived from the worker's command list and have no pipeline_definitions
      // row by design, so a subset check must not call them invented.
      return (await loadDefinitions()).definitions.filter((d) => d.kind === 'assessment-command' && d.recorded);
    },
    mockId: (d: { id: string }) => d.id,
    fields: [
      { seed: 'kind', mock: (d: { kind: string }) => d.kind },
      { seed: 'title', mock: (d: { title: string }) => d.title },
      { seed: 'context_tenant', mock: (d: { contextTenant: string }) => d.contextTenant },
      { seed: 'owner', mock: (d: { owner: string | null }) => d.owner },
      { seed: 'version', mock: (d: { version: number }) => d.version, normalize: num },
      { seed: 'source_id', mock: (d: { source: { id: string } }) => d.source.id },
    ],
  },

  // ── the access tenant (schema/access_schema.sql) ──────────────────────────
  // docs/access-tenant-goal.md §Registration row 10: the mock rows ARE the
  // registered fixtures (mock/access-*.ts), the seed rows are the additive
  // file's own INSERTs, over the same ids. Timestamps are relative SQL
  // expressions on the seed side, so the harness exempts them automatically;
  // the decision columns are compared for presence where they can be.
  {
    name: 'access catalog',
    describes: 'What the access tenant offers to request — six tenant roles, one capability (budget visibility in Work) and two initiative memberships.',
    lesson: 'access A0: a catalog item the mock invents can be requested offline and never on a real cluster.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_catalog_items',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-catalog.js')).accessCatalogFixture.rows(),
    mockId: (i: { id: string }) => i.id,
    fields: [
      { seed: 'kind', mock: (i: { kind: string }) => i.kind },
      { seed: 'tenant', mock: (i: { tenant: string }) => i.tenant },
      { seed: 'role', mock: (i: { role: string | null }) => i.role },
      { seed: 'project_id', mock: (i: { projectId: string | null }) => i.projectId },
      { seed: 'title', mock: (i: { title: string }) => i.title },
      { seed: 'description', mock: (i: { description: string }) => i.description },
      { seed: 'sensitive', mock: (i: { sensitive: boolean }) => i.sensitive },
      { seed: 'default_duration', mock: (i: { defaultDuration: string }) => i.defaultDuration },
      { seed: 'steward_rule', mock: (i: { stewardRule: string }) => i.stewardRule },
    ],
  },
  {
    name: 'access requests',
    describes: 'Access requests in six statuses — the requests, approvals and audit pages all read these rows.',
    lesson: 'access A0: a request whose status or parties differ offline walks a different approval chain than the cluster.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_requests',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-requests.js')).accessRequestsFixture.rows(),
    mockId: (r: { id: string }) => r.id,
    fields: [
      { seed: 'requester_id', mock: (r: { requesterId: string }) => r.requesterId },
      { seed: 'beneficiary_id', mock: (r: { beneficiaryId: string }) => r.beneficiaryId },
      { seed: 'item_id', mock: (r: { itemId: string }) => r.itemId },
      { seed: 'justification', mock: (r: { justification: string }) => r.justification },
      { seed: 'duration', mock: (r: { duration: string }) => r.duration },
      { seed: 'status', mock: (r: { status: string }) => r.status },
      { seed: 'sod_verdict', mock: (r: { sodVerdict: string }) => r.sodVerdict },
      { seed: 'decided_at', mock: (r: { decidedAt: string | null }) => r.decidedAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'provisioned_at', mock: (r: { provisionedAt: string | null }) => r.provisionedAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'expires_at', mock: (r: { expiresAt: string | null }) => r.expiresAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'revoked_at', mock: (r: { revokedAt: string | null }) => r.revokedAt, equals: setExactlyWhenTheSeedSetsIt },
    ],
  },
  {
    name: 'access request steps',
    describes: 'Each request\'s approval chain as computed at submit, and who decided each step.',
    lesson: 'access A0: a chain that differs offline makes the inbox and the self-approval rule disagree with the cluster.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_request_steps',
    seedId: '',
    seedKey: (row) => `${row.values['request_id']}#${row.values['step']}`,
    coverage: 'complete',
    mockRows: async () => (await import('../../access-requests.js')).accessStepsFixture.rows(),
    mockId: (s: { requestId: string; step: number }) => `${s.requestId}#${s.step}`,
    fields: [
      { seed: 'request_id', mock: (s: { requestId: string }) => s.requestId },
      { seed: 'step', mock: (s: { step: number }) => s.step, normalize: num },
      { seed: 'kind', mock: (s: { kind: string }) => s.kind },
      { seed: 'status', mock: (s: { status: string }) => s.status },
      { seed: 'decided_by', mock: (s: { decidedBy: string | null }) => s.decidedBy },
      { seed: 'decided_at', mock: (s: { decidedAt: string | null }) => s.decidedAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'comment', mock: (s: { comment: string | null }) => s.comment },
      { seed: 'current_since', mock: (s: { currentSince: string | null }) => s.currentSince, equals: setExactlyWhenTheSeedSetsIt },
    ],
  },
  {
    name: 'access delegations',
    describes: 'Approvers handing their decisions to another approver for a window (2026-10-14).',
    lesson: 'access A3: a delegation in force offline but not on the cluster puts a step in an inbox it never reaches.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_delegations',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-delegations.js')).accessDelegationsFixture.rows(),
    mockId: (d: { id: string }) => d.id,
    fields: [
      { seed: 'delegator_id', mock: (d: { delegatorId: string }) => d.delegatorId },
      { seed: 'delegate_id', mock: (d: { delegateId: string }) => d.delegateId },
      { seed: 'reason', mock: (d: { reason: string }) => d.reason },
      { seed: 'ended_at', mock: (d: { endedAt: string | null }) => d.endedAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'ended_by', mock: (d: { endedBy: string | null }) => d.endedBy },
    ],
  },
  {
    name: 'access events',
    describes: 'The append-only audit trail behind /access/audit.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_events',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-requests.js')).accessEventsFixture.rows(),
    mockId: (e: { id: string }) => e.id,
    fields: [
      { seed: 'request_id', mock: (e: { requestId: string | null }) => e.requestId },
      { seed: 'policy_id', mock: (e: { policyId: string | null }) => e.policyId },
      { seed: 'delegation_id', mock: (e: { delegationId: string | null }) => e.delegationId },
      { seed: 'actor_id', mock: (e: { actorId: string | null }) => e.actorId },
      { seed: 'kind', mock: (e: { kind: string }) => e.kind },
      { seed: 'before_status', mock: (e: { beforeStatus: string | null }) => e.beforeStatus },
      { seed: 'after_status', mock: (e: { afterStatus: string | null }) => e.afterStatus },
      { seed: 'reason', mock: (e: { reason: string | null }) => e.reason },
    ],
  },
  {
    name: 'access reviews',
    describes: 'Access review campaigns (lane A2): each certifies the standing grants of one tenant.',
    lesson: 'access A2: a campaign that differs offline asks a reviewer to certify grants the cluster never listed.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_reviews',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-reviews.js')).accessReviewsFixture.rows(),
    mockId: (v: { id: string }) => v.id,
    fields: [
      { seed: 'tenant', mock: (v: { tenant: string }) => v.tenant },
      { seed: 'title', mock: (v: { title: string }) => v.title },
      { seed: 'status', mock: (v: { status: string }) => v.status },
      { seed: 'opened_by', mock: (v: { openedBy: string | null }) => v.openedBy },
      { seed: 'closes_at', mock: (v: { closesAt: string | null }) => v.closesAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'closed_at', mock: (v: { closedAt: string | null }) => v.closedAt, equals: setExactlyWhenTheSeedSetsIt },
    ],
  },
  {
    name: 'access review items',
    describes: 'One standing (user, role) grant under review and its keep / revoke decision.',
    lesson: 'access A2: an item decided offline but open on the cluster makes the campaign close in one world only.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_review_items',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-reviews.js')).accessReviewItemsFixture.rows(),
    mockId: (i: { id: string }) => i.id,
    fields: [
      { seed: 'review_id', mock: (i: { reviewId: string }) => i.reviewId },
      { seed: 'user_id', mock: (i: { userId: string }) => i.userId },
      { seed: 'tenant', mock: (i: { tenant: string }) => i.tenant },
      { seed: 'role', mock: (i: { role: string }) => i.role },
      { seed: 'decision', mock: (i: { decision: string | null }) => i.decision },
      { seed: 'decided_by', mock: (i: { decidedBy: string | null }) => i.decidedBy },
      { seed: 'decided_at', mock: (i: { decidedAt: string | null }) => i.decidedAt, equals: setExactlyWhenTheSeedSetsIt },
      { seed: 'comment', mock: (i: { comment: string | null }) => i.comment },
      { seed: 'revocation_request_id', mock: (i: { revocationRequestId: string | null }) => i.revocationRequestId },
    ],
  },
  {
    name: 'access policies',
    describes: 'Separation-of-duties rules: two (tenant, role) pairs not to be held together.',
    lesson: 'access A0: a severity that differs offline lets a request through the mock that the cluster blocks.',
    sqlFile: 'access_schema.sql',
    sqlTable: 'access_policies',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../access-policies.js')).accessPoliciesFixture.rows(),
    mockId: (p: { id: string }) => p.id,
    fields: [
      { seed: 'title', mock: (p: { title: string }) => p.title },
      { seed: 'left_tenant', mock: (p: { left: { tenant: string } }) => p.left.tenant },
      { seed: 'left_role', mock: (p: { left: { role: string } }) => p.left.role },
      { seed: 'right_tenant', mock: (p: { right: { tenant: string } }) => p.right.tenant },
      { seed: 'right_role', mock: (p: { right: { role: string } }) => p.right.role },
      { seed: 'severity', mock: (p: { severity: string }) => p.severity },
      { seed: 'reason', mock: (p: { reason: string }) => p.reason },
      { seed: 'updated_by', mock: (p: { updatedBy: string | null }) => p.updatedBy },
    ],
  },

  // ── identity & tenancy (schema/identity_schema.sql) ────────────────────────
  {
    name: 'tenants',
    describes: 'The five tenants the BFF serves — orgiq plus four tenants beside it (assessment, social, pipelines, access); the user picker and requireTenant() both read this.',
    sqlFile: 'identity_schema.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/identity.js')).listTenants(),
    mockId: (t: { id: string }) => t.id,
    fields: [
      { seed: 'display_name', mock: (t: { displayName: string }) => t.displayName },
    ],
  },
  {
    name: 'app_users',
    describes: 'The sign-in cast; personId is what links a session to the org graph.',
    sqlFile: 'identity_schema.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/identity.js')).listUsers(),
    mockId: (u: { id: string }) => u.id,
    fields: [
      { seed: 'display_name', mock: (u: { displayName: string }) => u.displayName },
      { seed: 'email', mock: (u: { email: string | null }) => u.email },
      { seed: 'person_id', mock: (u: { personId: string | null }) => u.personId, normalize: resolvePersonSubquery },
    ],
  },
  {
    name: 'user_tenant_roles',
    describes: 'Grants the signed session cookie carries — no grant in a tenant, no access.',
    sqlFile: 'identity_schema.sql',
    seedId: '',
    seedKey: (row) => `${row.values['user_id']}@${row.values['tenant_id']}:${row.values['role']}`,
    coverage: 'complete',
    mockRows: async () => {
      const { listUsers } = await import('../../../providers/identity.js');
      const out: Array<{ key: string }> = [];
      for (const u of await listUsers()) {
        for (const [tenant, roles] of Object.entries(u.grants)) {
          for (const role of roles as string[]) out.push({ key: `${u.id}@${tenant}:${role}` });
        }
      }
      return out;
    },
    mockId: (g: { key: string }) => g.key,
    fields: [],
  },
  {
    name: 'decisions',
    describes: 'The org graph\'s settled decisions behind /api/graph/decisions — an ADR\'s parent row.',
    lesson: 'decision-parity: /api/graph/decisions 500\'d offline with no mock branch; the rows that replaced the 500 must be the seed\'s rows.',
    sqlFile: 'seed.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/decisions.js')).listDecisions({ limit: 200 }),
    mockId: (d: { id: string }) => d.id,
    allowedExtraIds: authoredElsewhere(
      idsAuthoredBy('seed_program.sql', 'decisions', decisionId),
      'seed_program.sql', 'program decisions',
    ),
    fields: [
      { seed: 'topic', mock: (d: { topic: string }) => d.topic },
      { seed: 'summary', mock: (d: { summary: string | null }) => d.summary },
      // status and project_id were the half of the column set this file used to
      // leave unwritten: every row defaulted to 'open' with no initiative, so
      // an initiative's Decisions tab could not reach one of them.
      { seed: 'status', mock: (d: { status: string }) => d.status },
      { seed: 'project_id', mock: (d: { projectId: string | null }) => d.projectId },
      { seed: 'decided_at', mock: (d: { decidedAt: string | null }) => d.decidedAt, normalize: asSeedDate },
    ],
  },
  {
    name: 'program decisions',
    sqlTable: 'decisions',
    describes: 'The same table, the other author: the decisions an initiative raised, served to its Decisions tab.',
    lesson: 'These rows were never parity-checked, which is how a hand-typed mock copy of them drifted into naming work items the seed never linked.',
    sqlFile: 'seed_program.sql',
    seedId: 'id',
    coverage: 'complete',
    mockRows: async () => (await import('../../../providers/decisions.js')).listDecisions({ limit: 200 }),
    mockId: (d: { id: string }) => d.id,
    allowedExtraIds: authoredElsewhere(
      idsAuthoredBy('seed.sql', 'decisions', decisionId),
      'seed.sql', 'decisions',
    ),
    fields: [
      { seed: 'topic', mock: (d: { topic: string }) => d.topic },
      { seed: 'summary', mock: (d: { summary: string | null }) => d.summary },
      { seed: 'status', mock: (d: { status: string }) => d.status },
      { seed: 'project_id', mock: (d: { projectId: string | null }) => d.projectId },
      // decided_at is a relative expression here (`NOW() - INTERVAL '6 days'`)
      // where the seed sets it at all, so there is no instant to compare — but
      // whether it is set is exactly the thing the invariant table cares about
      // (decided exactly when settled), and that IS comparable.
      {
        seed: 'decided_at',
        mock: (d: { decidedAt: string | null }) => d.decidedAt,
        equals: setExactlyWhenTheSeedSetsIt,
      },
      // escalated_at / resolved_at / work_item_id are not on the decision-list
      // row at all, so they are outside "columns both sources carry".
    ],
  },
  {
    name: 'decision_participants',
    describes: 'Who decided and who contributed — the join participantCount is counted from.',
    lesson: 'A participant list that invents people makes the same decision look like it was made by a different room.',
    sqlFile: 'seed.sql',
    seedId: '',
    seedKey: participantKey,
    coverage: 'complete',
    mockRows: async () => {
      const { listDecisions, getDecision } = await import('../../../providers/decisions.js');
      const out: Array<{ key: string; role: string | null }> = [];
      for (const d of await listDecisions({ limit: 200 })) {
        const detail = await getDecision(d.id);
        for (const p of detail?.participants ?? []) {
          out.push({ key: `${d.id}:${p.personId}`, role: p.role });
        }
      }
      return out;
    },
    mockId: (p: { key: string }) => p.key,
    allowedExtraIds: authoredElsewhere(
      idsAuthoredBy('seed_program.sql', 'decision_participants', participantKey),
      'seed_program.sql', 'program decision_participants',
    ),
    fields: [
      { seed: 'role', mock: (p: { role: string | null }) => p.role },
    ],
  },
  {
    name: 'program decision_participants',
    sqlTable: 'decision_participants',
    describes: 'The room for an initiative\'s decision: its owner decides, its SMEs contribute.',
    lesson: 'The program decisions carried no participants at all, so the same rows an initiative showed read "0 participants" on the graph\'s decision list.',
    sqlFile: 'seed_program.sql',
    seedId: '',
    seedKey: participantKey,
    coverage: 'complete',
    // Scoped by a property of the data, not by a copy of the seed's id list:
    // only schema/seed_program.sql can write `decisions.work_item_id` (the item
    // does not exist when seed.sql runs), so "carries a work-item link" is
    // exactly "authored there". An invented participant still fails, here or on
    // the `decision_participants` row above.
    mockRows: async () => {
      const { decisionRows } = await import('../../decisions.js');
      const { getDecision } = await import('../../../providers/decisions.js');
      const out: Array<{ key: string; role: string | null }> = [];
      for (const d of decisionRows.rows().filter((r) => r.workItemId != null)) {
        const detail = await getDecision(d.id);
        for (const p of detail?.participants ?? []) {
          out.push({ key: `${d.id}:${p.personId}`, role: p.role });
        }
      }
      return out;
    },
    mockId: (p: { key: string }) => p.key,
    fields: [
      { seed: 'role', mock: (p: { role: string | null }) => p.role },
    ],
  },
];

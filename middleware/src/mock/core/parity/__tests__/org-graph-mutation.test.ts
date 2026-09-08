// PROVING THE ORG-GRAPH CHECKS CAN FAIL.
//
// The five org-graph entities added to ../entities.ts — skills, person_skills,
// team_memberships, collaborations and the seed.sql half of
// project_contributions — are all GREEN against the live fixtures. So were the
// allocations at $60 against the seed's $95. Green proves nothing on its own,
// and a check that cannot be shown to fail is not a check.
//
// So this file breaks the fixture the providers actually serve — mock/people.ts,
// which is where the whole org graph lives offline — one value at a time, and
// requires the harness to fail naming the row, the column and BOTH values.
// Mutating the SOURCE rather than the parity projection is deliberate: it
// exercises the join (name → seeded id) that the projection does, so a mutation
// that invents a skill name is reported the way a real one would be.
//
// It also proves the two DEFECTS the table records are really being detected
// and merely tolerated: strip the `knownDrift` and the disagreements come back,
// with the values reported in this slice's write-up.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: { mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true }, region: 'us-east-1' },
}));

type Person = { id: string; name: string; title: string; department: string; skills: string[]; influenceScore: number };
type Relationship = { source: string; target: string; type: string; strength: number };

/** The live cast every check below reads, swapped per test. */
const mockState: { people: Person[]; relationships: Relationship[] } = { people: [], relationships: [] };

jest.mock('../../../people.js', () => ({
  get mockPeople() { return mockState.people; },
  get mockRelationships() { return mockState.relationships; },
  get departments() {
    return (jest.requireActual('../../../people.js') as { departments: unknown }).departments;
  },
}));

import { PARITY_ENTITIES } from '../entities.js';
import { compareEntity, describeResult, type ParityEntity } from '../compare.js';
import { auditColumnCoverage, describeCoverage } from '../columns.js';
import { SURFACE_INVARIANTS } from '../invariants.js';

const realPeople = (): Person[] =>
  (jest.requireActual('../../../people.js') as { mockPeople: Person[] }).mockPeople
    .map((p) => ({ ...p, skills: [...p.skills] }));
const realRelationships = (): Relationship[] =>
  (jest.requireActual('../../../people.js') as { mockRelationships: Relationship[] }).mockRelationships
    .map((r) => ({ ...r }));

const entityNamed = (name: string): ParityEntity<any> => {
  const found = PARITY_ENTITIES.find((e) => e.name === name);
  if (!found) throw new Error(`no parity entity named '${name}' — this test is stale`);
  return found;
};

const report = async (entity: ParityEntity<any>): Promise<string> =>
  describeResult(entity, await compareEntity(entity)) ?? '';

/** The person the mutations below perturb, and the skills the seed gave them. */
const SUBJECT = 'p-001';

beforeEach(() => {
  mockState.people = realPeople();
  mockState.relationships = realRelationships();
});

describe('the org-graph entities are clean before anything is broken', () => {
  it.each(['skills', 'person_skills', 'team_memberships', 'collaborations'])(
    '%s agrees with schema/seed.sql as shipped',
    async (name) => {
      expect(await report(entityNamed(name))).toBe('');
    },
  );
});

describe('person_skills fails on an edge the seed never wrote', () => {
  it('names the invented pair, resolved through the seed\'s own skills table', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.skills = [...subject.skills, 'Rust']; // a real skill, never given to p-001
    const broken = await report(entityNamed('person_skills'));
    expect(broken).toContain('INVENTED by the mock');
    expect(broken).toContain(`${SUBJECT}@sk-rust`);
  });

  it('says which name it could not resolve when the skill itself is invented', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.skills = [...subject.skills, 'Bicycle Repair'];
    // Two entities catch it, and both name the string rather than dropping the
    // row: the vocabulary check, and the edge whose join found nothing.
    const vocabulary = await report(entityNamed('skills'));
    expect(vocabulary).toContain('INVENTED by the mock');
    expect(vocabulary).toContain('Bicycle Repair');
    expect(await report(entityNamed('person_skills')))
      .toContain(`${SUBJECT}@<no seeded skill named 'Bicycle Repair'>`);
  });

  it('names the seeded edge and its line when the mock drops one', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.skills = subject.skills.filter((s) => s !== 'AWS');
    const broken = await report(entityNamed('person_skills'));
    expect(broken).toContain('MISSING from the mock');
    expect(broken).toContain(`${SUBJECT}@sk-aws`);
    expect(broken).toMatch(/seed\.sql:\d+/);
  });
});

describe('team_memberships fails on the role and on the team', () => {
  it('names the column and both values when a person\'s role on their team moves', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    expect(subject.title).toBe('Engineer');
    subject.title = 'Distinguished Engineer';
    const broken = await report(entityNamed('team_memberships'));
    expect(broken).toContain('role');
    expect(broken).toContain("seed 'Engineer'");
    expect(broken).toContain("mock 'Distinguished Engineer'");
  });

  it('names the department when it is a team no seed defines', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.department = 'Platform Eng';
    const broken = await report(entityNamed('team_memberships'));
    expect(broken).toContain(`${SUBJECT}@<no seeded team named 'Platform Eng'>`);
  });
});

describe('collaborations fails on an edge weight and on an edge direction', () => {
  it('names the weight column and both numbers', async () => {
    const edge = mockState.relationships[0]!;
    const before = edge.strength;
    edge.strength = 0.11;
    const broken = await report(entityNamed('collaborations'));
    expect(broken).toContain('weight');
    expect(broken).toContain(`seed ${before}`);
    expect(broken).toContain('mock 0.11');
  });

  it('names the direction when an undirected edge is stored the wrong way round', async () => {
    // The seed stores every edge with person_a_id < person_b_id (a CHECK in
    // schema/orgiq_schema.sql). A reversed mock edge still finds its twin —
    // and is reported as a direction disagreement rather than as two bogus
    // findings ("invented edge" + "missing edge") that hide what moved.
    const edge = mockState.relationships[0]!;
    const [a, b] = [edge.source, edge.target];
    edge.source = b;
    edge.target = a;
    const broken = await report(entityNamed('collaborations'));
    expect(broken).toContain('person_a_id (edge direction)');
    expect(broken).toContain(`seed '${a}'`);
    expect(broken).toContain(`mock '${b}'`);
    expect(broken).not.toContain('INVENTED');
  });
});

describe('the column-coverage audit covers the new columns', () => {
  // These columns reach the portal under other names — `collaborations.weight`
  // as an edge's `strength`, `team_memberships.role` as a person's `title` —
  // and the audit pairs by camelCase, so a projection that kept the provider's
  // spelling would leave both columns permanently invisible to it. The
  // projections use the seed's spelling precisely so these two fail.
  it('reports collaborations.weight the moment nothing compares it', async () => {
    const edges = entityNamed('collaborations');
    const blind: ParityEntity<any> = { ...edges, fields: edges.fields.filter((f) => f.seed !== 'weight') };
    const gap = describeCoverage(blind, await auditColumnCoverage(blind));
    expect(gap).toContain('seed column `weight` pairs with mock key `weight`');
    expect(gap).toContain('is never compared');
    expect(gap).toContain('nothing keeps them agreeing');
  });

  it('reports team_memberships.role, quoting the values the silence would hide', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.title = 'Distinguished Engineer';
    const memberships = entityNamed('team_memberships');
    const blind: ParityEntity<any> = { ...memberships, fields: [] };
    const gap = describeCoverage(blind, await auditColumnCoverage(blind));
    expect(gap).toContain('seed column `role` pairs with mock key `role`');
    expect(gap).toContain("seed 'Engineer' vs mock 'Distinguished Engineer'");
  });
});

// ── the two DEFECTS on the record ───────────────────────────────────────────
//
// Both are tolerated by a `knownDrift` reason, which is the only difference
// between them and a failing check. Strip the reason and the disagreements are
// reported — which is what proves the harness is detecting them rather than
// looking past them, and reproduces the numbers this slice reported.

/** The same entity with every field's `knownDrift` removed. */
const withoutDrift = (entity: ParityEntity<any>): ParityEntity<any> => ({
  ...entity,
  fields: entity.fields.map(({ knownDrift: _drop, ...f }) => f),
});

// NOT a defect — and the correction is the interesting part.
//
// This was first reported as: seed.sql loads first, every program-seed
// contribution ends `ON CONFLICT DO NOTHING`, therefore six initiatives have no
// `owner` row against a real cluster. That reasoning never looked past the
// INSERTs. `schema/seed_program.sql:6` opens with
// `DELETE FROM project_contributions WHERE project_id IN (…all fourteen…)`, so
// seed.sql's rows for those projects are gone before the first program INSERT
// runs and the owner/sme rows do land. `ON CONFLICT DO NOTHING` only means
// "first writer wins" while the first writer's row still exists.
//
// What is pinned here now: that the helper reads the DELETE, that the drift is
// declared against every program-seed row rather than a hand-typed subset, and
// that removing the DELETE would make it a real defect again.
describe('project_contributions: the later seed is authoritative, by DELETE', () => {
  it('reports no collision, because the program seed clears the rows first', async () => {
    const { lostToAnEarlierSeed } = await import('../joins.js');
    const { contributionKey } = await import('../joins.js');
    const collisions = lostToAnEarlierSeed({
      table: 'project_contributions',
      winnerFile: 'seed.sql',
      loserFile: 'seed_program.sql',
      key: contributionKey,
      column: 'role',
      note: 'n/a',
    });
    expect(Object.keys(collisions)).toEqual([]);
  });

  it('still passes as shipped, with the drift declared from the program seed', async () => {
    const graph = entityNamed('graph project_contributions');
    expect(await report(graph)).toBe('');
    const role = graph.fields.find((f) => f.seed === 'role')!;
    const ids = Object.keys(role.knownDrift as Record<string, string>);
    const { seedRows } = await import('../sql-seed.js');
    const inProgram = seedRows('seed_program.sql', 'project_contributions')
      .map((r) => `${String(r.values['person_id'])}@${String(r.values['project_id'])}`);
    // Derived, not typed: exactly the program seed's own rows.
    expect(new Set(ids)).toEqual(new Set(inProgram));
  });

  it('the mock carries the value a real cluster ends with, not seed.sql\'s', async () => {
    const graph = entityNamed('graph project_contributions');
    const broken = await report(withoutDrift(graph));
    expect(broken).toContain('p-004@p-observability');
    expect(broken).toContain("seed 'lead'");   // schema/seed.sql
    expect(broken).toContain("mock 'owner'");  // seed_program.sql, and Aurora
  });
});

describe('DEFECT: the leaderboard invents the scores it attributes to seeded people', () => {
  it('detects the expertise and composite drift, naming both numbers', async () => {
    const leaderboard = entityNamed('leaderboard people');
    expect(await report(leaderboard)).toBe(''); // tolerated as shipped
    const broken = await report(withoutDrift(leaderboard));
    expect(broken).toContain('expertise_score');
    expect(broken).toContain('composite_score');
    // p-023 is the top of the mock leaderboard and 46.98 in the seed.
    expect(broken).toContain('p-023');
    expect(broken).toContain('seed 46.98');
    expect(broken).toContain('mock 89');
  });

  it('still fails on identity, which the leaderboard does claim to mirror', async () => {
    const leaderboard = entityNamed('leaderboard people');
    const renamed: ParityEntity<any> = {
      ...leaderboard,
      mockRows: async () => (await leaderboard.mockRows())
        .map((r: any) => (r.id === 'p-023' ? { ...r, name: 'Hiro Greene' } : r)),
    };
    const broken = await report(renamed);
    expect(broken).toContain("seed 'Hiro Green'");
    expect(broken).toContain("mock 'Hiro Greene'");
  });
});

// ── the ordering invariant ──────────────────────────────────────────────────

const skillOrder = SURFACE_INVARIANTS.find(
  (i) => i.name === "a person's skills are listed in the seed's weight order",
)!;
const noApp = { app: async () => { throw new Error('this invariant needs no express app'); } } as never;

describe('the skill-order invariant', () => {
  it('holds over the cast as shipped', async () => {
    expect(await skillOrder.check(noApp)).toEqual([]);
  });

  it('names both skills and both seed weights when a list is reordered', async () => {
    const subject = mockState.people.find((p) => p.id === SUBJECT)!;
    subject.skills = [...subject.skills].reverse();
    const violations = await skillOrder.check(noApp);
    const text = violations.join('\n');
    expect(text).toContain(`${SUBJECT}:`);
    expect(text).toMatch(/lists '[^']+' \(seed weight 0\.\d+\) before '[^']+' \(seed weight 0\.\d+\)/);
    expect(text).toContain('the seed ranks');
  });

  // The vacuity guard has to empty what the CHECK reads, not something
  // adjacent — a previous guard in this harness passed because the invariant
  // read `rows('default')` explicitly while the test switched scenarios, so
  // the "empty" world it thought it was testing never reached the check.
  // These two mutate `mockPeople` itself, which is the only thing the check
  // iterates.
  it('reports vacuity when the cast is empty', async () => {
    mockState.people = [];
    expect((await skillOrder.check(noApp)).join('\n')).toContain('no person in mock/people.ts holds two skills');
  });

  it('reports vacuity when nobody holds two skills, so ordering is free', async () => {
    mockState.people = mockState.people.map((p) => ({ ...p, skills: p.skills.slice(0, 1) }));
    const text = (await skillOrder.check(noApp)).join('\n');
    expect(text).toContain('ordering is vacuous');
    expect(text).toContain(`${mockState.people.length} people`);
  });
});

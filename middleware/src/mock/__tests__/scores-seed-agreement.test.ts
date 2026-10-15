// One `people` table, two mock readers, one set of numbers.
//
// mock/scores.ts used to carry its own twelve-person list with five invented
// axes. The names agreed with schema/seed.sql, so it read as the seed's cast;
// the numbers did not. providers/aurora.ts served that array offline and the
// real `people` columns online, so /iq/scores ordered the same people
// differently depending on the mode — p-023 Hiro Green was first in the
// fixture and is 47th of 56 in the seed — and it contradicted mock/people.ts
// in the same process: composite 89 on the leaderboard, influenceScore 0.47
// on the graph.
//
// What is pinned here, in the order that matters:
//
//   1. THE AGREEMENT. Every leaderboard row and the graph node for the same
//      person carry the same number for `composite_score`. This is the test
//      that stops the two readers drifting apart again, and it is written as
//      a join between the two live fixtures rather than against a table of
//      expected values — a typed table would drift with them.
//   2. THE SEED. Both readers are checked against schema/seed.sql's own
//      `people` rows, so "they agree" cannot be satisfied by agreeing on the
//      wrong number.
//   3. THE SCALE. `composite` is 0-100 on this wire; `influence`, `expertise`
//      and the three unmeasured axes are 0-1. One answer, asserted, because a
//      silent rescale is how a page starts lying quietly.
//   4. NO TYPED AGGREGATES. `total` is counted from the fixture's own rows —
//      the filtered set BEFORE the page is sliced off it, matching what
//      realGetLeaderboard's/realGetSkillLeaderboard's paired `count(*)` reports
//      online — never a typed field and never (as it read until 2026-09-16)
//      the length of the capped page. `mostRecentScoredAt` is a reduction over
//      the page's own rows, same as the real query's LIMIT'd result; the skill
//      mention counts are counted from the person_skills edges, never stored.

const auroraState = { mockAurora: true };
jest.mock('../../config.js', () => ({
  get config() {
    return { mock: { aurora: auroraState.mockAurora }, region: 'us-east-1' };
  },
}));

import { seedRows } from '../core/parity/sql-seed.js';
import { fixtureRegistry } from '../core/index.js';
import { mockPeople } from '../people.js';
import { mockSkills } from '../graph-taxonomy.js';
import { personScoreColumns, scoreColumnsFor } from '../people-scores.js';
import { mockScores, scores, toScoreEntry } from '../scores.js';
import { mockAurora } from '../../providers/aurora.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

/** schema/seed.sql's `people` rows, keyed by id — the authority for all of this. */
const seedPeople = new Map(
  seedRows('seed.sql', 'people').map((row) => [
    String(row.values['id']),
    {
      name: String(row.values['name']),
      team: String(row.values['team']),
      expertise: Number(row.values['expertise_score']),
      pagerank: Number(row.values['pagerank_score']),
      composite: Number(row.values['composite_score']),
    },
  ]),
);

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe('the leaderboard and the graph read the same people', () => {
  it('agrees with the graph on composite_score, person for person', () => {
    // The defect in one line: p-023 was 89 here and 0.47 there.
    const graphById = new Map(mockPeople.map((p) => [p.id, p]));
    const disagreements: string[] = [];
    for (const entry of mockScores) {
      const node = graphById.get(entry.personId);
      if (!node) {
        disagreements.push(`${entry.personId}: on the leaderboard, absent from the graph`);
        continue;
      }
      if (!near(entry.composite / 100, node.influenceScore)) {
        disagreements.push(
          `${entry.personId} ${entry.name}: leaderboard composite ${entry.composite}`
          + ` (= ${entry.composite / 100}) vs graph influenceScore ${node.influenceScore}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('serves the seed\'s whole cast, not a curated twelve', () => {
    expect(mockScores).toHaveLength(seedPeople.size);
    expect(new Set(mockScores.map((s) => s.personId))).toEqual(new Set(seedPeople.keys()));
    // The old cast covered two of the six departments, so four of them had no
    // cohort offline at all.
    expect(new Set(mockScores.map((s) => s.department)).size).toBe(6);
  });

  it('takes every number from the seed row, not from a list beside it', () => {
    const wrong: string[] = [];
    for (const entry of mockScores) {
      const seed = seedPeople.get(entry.personId)!;
      if (entry.name !== seed.name) wrong.push(`${entry.personId}.name ${entry.name} != ${seed.name}`);
      if (entry.department !== seed.team) wrong.push(`${entry.personId}.department`);
      if (!near(entry.expertise, seed.expertise / 100)) {
        wrong.push(`${entry.personId}.expertise ${entry.expertise} != ${seed.expertise}/100`);
      }
      if (!near(entry.influence, seed.pagerank / 100)) {
        wrong.push(`${entry.personId}.influence ${entry.influence} != ${seed.pagerank}/100`);
      }
      if (!near(entry.composite, seed.composite)) {
        wrong.push(`${entry.personId}.composite ${entry.composite} != ${seed.composite}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('reports Hiro Green as the seed reports him — the row the defect was named for', () => {
    const hiro = mockScores.find((s) => s.personId === 'p-023')!;
    expect(hiro).toMatchObject({ name: 'Hiro Green', expertise: 0.3353, composite: 46.98 });
    // 47th of 56 by composite, where the old fixture put him first.
    const rank = [...mockScores].sort((a, b) => b.composite - a.composite)
      .findIndex((s) => s.personId === 'p-023') + 1;
    expect(rank).toBe(47);
  });

  it('derives influenceScore rather than carrying a second copy of it', () => {
    for (const node of mockPeople) {
      expect(node.influenceScore).toBeCloseTo(scoreColumnsFor(node.id).compositeScore / 100, 10);
      // The graph node is the wire: the score columns must not ride on it.
      for (const leaked of ['compositeScore', 'expertiseScore', 'pagerankScore']) {
        expect(Object.keys(node)).not.toContain(leaked);
      }
    }
  });

  it('scores exactly the people the graph carries, and no others', () => {
    expect(Object.keys(personScoreColumns).sort()).toEqual(mockPeople.map((p) => p.id).sort());
  });

  it('reads an unscored person as zero, the way COALESCE does, not as undefined', () => {
    expect(scoreColumnsFor('p-not-yet-scored'))
      .toEqual({ expertiseScore: 0, pagerankScore: 0, compositeScore: 0 });
  });
});

describe('one scale, stated', () => {
  it('carries composite on 0-100 and every other axis on 0-1', () => {
    for (const entry of mockScores) {
      expect(entry.composite).toBeGreaterThan(1);
      expect(entry.composite).toBeLessThanOrEqual(100);
      for (const axis of ['influence', 'collaboration', 'expertise', 'velocity', 'quality'] as const) {
        expect(entry[axis]).toBeGreaterThanOrEqual(0);
        expect(entry[axis]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spells the three axes Aurora has no column for as one neutral placeholder', () => {
    // realGetLeaderboard writes the literal 50 into these on its 0-100 axes.
    // Whatever the value is, it must be the same for everyone — a per-person
    // number here would be a measurement the seed never made.
    for (const key of ['collaboration', 'velocity', 'quality'] as const) {
      expect(new Set(mockScores.map((s) => s[key]))).toEqual(new Set([0.5]));
    }
  });
});

describe('nothing countable is stored', () => {
  // Until 2026-09-16 this asserted `total === page.entries.length` — true only
  // because the seed (56 people) happens to be smaller than every limit this
  // suite tried. `realGetLeaderboard`/`realGetSkillLeaderboard` were fixed the
  // same day to run a real `count(*)` alongside the capped page (feat(scale):
  // honest counts) specifically because `entries.length` silently equals the
  // LIMIT once a filtered set outgrows it — the mock carried the identical bug
  // and this test pinned it as intentional. `total` now counts the filtered
  // set before the page is sliced off it, the same fix, so a request that
  // actually caps below the matching count must report the true count, not
  // the page size.
  it('reports `total` as a real count of the filtered set, not the page size', async () => {
    const page = await mockAurora.getLeaderboard({ limit: 12 });
    expect(page.entries).toHaveLength(12);
    expect(page.total).toBe(seedPeople.size); // 56 people, capped to a 12-row page
    expect(page.total).not.toBe(page.entries.length);
    const all = await mockAurora.getLeaderboard({ limit: 200 });
    expect(all.total).toBe(seedPeople.size);
  });

  it('orders by composite descending, the way `ORDER BY composite_score DESC` does', async () => {
    const { entries } = await mockAurora.getLeaderboard({ limit: 200 });
    const composites = entries.map((e) => e.composite);
    expect([...composites].sort((a, b) => b - a)).toEqual(composites);
    expect(entries[0]!.personId).toBe('p-028'); // Felix Rivera, 96.02
  });

  it('filters by department without inventing a cast', async () => {
    const { entries } = await mockAurora.getLeaderboard({ department: 'Security', limit: 200 });
    const seeded = [...seedPeople.entries()].filter(([, p]) => p.team === 'Security');
    expect(entries.map((e) => e.personId).sort()).toEqual(seeded.map(([id]) => id).sort());
  });

  it('derives mostRecentScoredAt from the rows rather than typing null beside them', async () => {
    const page = await mockAurora.getLeaderboard({ limit: 200 });
    // Every seeded row is `scored_at = NOW()`, which is not a literal a fixture
    // can copy, so the fixture carries null and the reduction agrees with it.
    expect(page.entries.every((e) => e.scoredAt === null)).toBe(true);
    expect(page.mostRecentScoredAt).toBeNull();
  });

  it('counts skill mentions from the person_skills edges', async () => {
    const top = await mockAurora.getTopSkills(100);
    expect(top.length).toBeGreaterThan(0);
    for (const skill of top) {
      const held = mockPeople.filter((p) => p.skills.includes(skill.name)).length;
      expect(skill.mentionCount).toBe(held);
      // The id is the seed's, never a slug minted here.
      expect(mockSkills.some((s) => s.id === skill.id && s.name === skill.name)).toBe(true);
    }
    expect([...top].sort((a, b) => b.mentionCount - a.mentionCount)[0]!.mentionCount)
      .toBe(top[0]!.mentionCount);
  });

  it('answers by-skill with the people the seed gave that skill', async () => {
    const { entries, total } = await mockAurora.getSkillLeaderboard({ skill: 'kubernetes', limit: 100 });
    const expected = mockPeople.filter((p) => p.skills.includes('Kubernetes')).map((p) => p.id);
    expect(entries.map((e) => e.personId).sort()).toEqual([...expected].sort());
    expect(total).toBe(expected.length);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('keeps `total` the full holder count once the page is capped below it', async () => {
    const holderCount = mockPeople.filter((p) => p.skills.includes('Kubernetes')).length;
    expect(holderCount).toBeGreaterThan(1); // otherwise this test can't exercise a cap
    const capped = await mockAurora.getSkillLeaderboard({ skill: 'kubernetes', limit: 1 });
    expect(capped.entries).toHaveLength(1);
    expect(capped.total).toBe(holderCount);
    expect(capped.total).not.toBe(capped.entries.length);
  });

  it('spreads the cohorts over all six departments now the cast is whole', async () => {
    const cohorts = await mockAurora.getCohorts();
    expect(cohorts).toHaveLength(6);
    for (const cohort of cohorts) {
      const members = mockScores.filter((s) => s.department === cohort.department);
      expect(cohort.count).toBe(members.length);
      // The histogram has to account for everyone it claims.
      expect(cohort.compositeBuckets.reduce((a, b) => a + b, 0)).toBe(cohort.count);
    }
  });
});

describe('scenarios', () => {
  it('answers `empty` with no rows, so an unscored tenant can be audited', () => {
    expect(scores.rows('empty')).toEqual([]);
  });

  it('rebuilds a row from its graph person, so the projection has one author', () => {
    const person = mockPeople.find((p) => p.id === 'p-017')!;
    expect(toScoreEntry(person)).toEqual(mockScores.find((s) => s.personId === 'p-017'));
  });

  it('keeps a person\'s sparkline stable across builds and tied to their composite', () => {
    const person = mockPeople.find((p) => p.id === 'p-023')!;
    expect(toScoreEntry(person).trend).toEqual(toScoreEntry(person).trend);
    // It rises toward the current score rather than wandering off it.
    const trend = toScoreEntry(person).trend;
    expect(Math.abs(trend[6]! - scoreColumnsFor('p-023').compositeScore)).toBeLessThan(10);
  });
});

// mock/people.ts's `graphPeople`/`graphRelationships` — the `large` branch the
// graph routes read (providers/aurora.ts's `cappedGraphPeople`, feeding
// `mockFetchGraph`/`mockFetchSkillsGraph`/`mockFetchProjectsGraph`).
//
// WHY THIS EXISTS. `GET /api/graph/entities` caps its node list at 500
// (`PEOPLE_GRAPH_LIMIT`) and the portal caps its canvas at 200 — the seeded
// 56-person cast can never make either cap fire, so nothing offline could
// exercise the "showing N of M" truncation path those caps exist for. `large`
// clones the seeded 56 into `LARGE_ROUNDS` rounds (616 people), which the mock
// graph functions now cap at 500 the same way the real provider caps
// `fetchAllPeople`, reporting the true (larger) count beside it as
// `peopleTotal` — see mock/people.ts's header comment for the full reasoning.

jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import { graphPeople, graphRelationships, mockPeople, mockRelationships } from '../people.js';
import { fixtureRegistry } from '../core/index.js';
import { mockAurora } from '../../providers/aurora.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('graphPeople / graphRelationships', () => {
  it('default is exactly mockPeople/mockRelationships, unchanged', () => {
    expect(graphPeople.rows('default')).toEqual(mockPeople);
    expect(graphRelationships.rows('default')).toEqual(mockRelationships);
  });

  it('large is bigger than default, past the 500-row graph cap, and every id keeps the p- prefix', () => {
    const large = graphPeople.rows('large');
    expect(large.length).toBeGreaterThan(mockPeople.length);
    expect(large.length).toBeGreaterThan(500);
    for (const person of large) expect(person.id).toMatch(/^p-large-\d{2}-\d{3}$/);
    // Every id is unique — a round/index collision would silently drop a row
    // when a caller keys off id.
    expect(new Set(large.map((p) => p.id)).size).toBe(large.length);
  });

  it('large relationships translate the seeded pairs, never invent new endpoints', () => {
    const largeRel = graphRelationships.rows('large');
    expect(largeRel.length).toBe(mockRelationships.length * (graphPeople.rows('large').length / mockPeople.length));
    for (const rel of largeRel) {
      expect(rel.source).toMatch(/^p-large-\d{2}-\d{3}$/);
      expect(rel.target).toMatch(/^p-large-\d{2}-\d{3}$/);
    }
  });

  it('POST /api/__mock/reset (resetAll) restores the seeded size', () => {
    fixtureRegistry.resetAll('large');
    expect(graphPeople.rows().length).toBeGreaterThan(500);
    expect(graphRelationships.rows().length).toBeGreaterThan(mockRelationships.length);

    fixtureRegistry.resetAll('default');
    expect(graphPeople.rows()).toHaveLength(mockPeople.length);
    expect(graphRelationships.rows()).toHaveLength(mockRelationships.length);
  });
});

describe('mockFetchGraph applies the same 500-row cap the real provider does', () => {
  it('default: peopleTotal equals nodes.length (the seeded cast is under the cap)', async () => {
    const snap = await mockAurora.fetchGraph();
    expect(snap.peopleTotal).toBe(snap.nodes.length);
    expect(snap.peopleTotal).toBe(mockPeople.length);
  });

  it('large: nodes cap at 500, peopleTotal reports the true (larger) population', async () => {
    fixtureRegistry.resetAll('large');
    const snap = await mockAurora.fetchGraph();
    expect(snap.nodes).toHaveLength(500);
    expect(snap.peopleTotal).toBeGreaterThan(500);
    expect(snap.peopleTotal).not.toBe(snap.nodes.length);
    // Comfortably past the portal's own 200-node canvas cap too.
    expect(snap.nodes.length).toBeGreaterThan(200);
  });

  it('large: skills-graph and projects-graph report the same true population', async () => {
    fixtureRegistry.resetAll('large');
    const skills = await mockAurora.fetchSkillsGraph();
    const projects = await mockAurora.fetchProjectsGraph();
    expect(skills.peopleTotal).toBeGreaterThan(500);
    expect(projects.peopleTotal).toBeGreaterThan(500);
    expect(skills.people).toHaveLength(500);
    expect(projects.people).toHaveLength(500);
  });
});

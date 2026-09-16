// The /api/graph entity surface (routes/graph.ts) — the three graph snapshots
// the org-chart / skills / projects canvases render, the person drawer, and
// the "who can help" lookup.
//
// What is pinned:
//   * the snapshot key names each canvas destructures (`nodes`/`edges`/
//     `departments`/`peopleTotal`, `domains`/`skills`/`people`/
//     `personSkillEdges`/`peopleTotal`, `projects`/`people`/
//     `personProjectEdges`/`peopleTotal`) — a renamed key here blanks a
//     whole page with no error, the contract.ts bug class 2 failure,
//   * `peopleTotal` is the TRUE count behind the (possibly capped) people
//     list, never the length of the list beside it — this router just
//     forwards what providers/aurora.ts computed, so this suite pins the
//     forwarding rather than re-deriving the count itself,
//   * that /help stays SCORE-FREE. This router's gate (ViewOrgChart) is held
//     by every orgiq role, unlike /api/scores' ViewLeaderboard, so a score
//     leaking into this payload is a privilege leak, not a cosmetic change.
//   * that /help fetches evidence only for the people it actually returns and
//     caps each at three documents,
//   * the empty branch of /people/:id/evidence — `{documents: []}`, never a
//     404, because an un-ingested corpus is not a missing person.

jest.mock('../../providers/index.js', () => ({
  aurora: {
    fetchGraph: jest.fn(),
    fetchSkillsGraph: jest.fn(),
    fetchProjectsGraph: jest.fn(),
    fetchPersonGraph: jest.fn(),
    fetchPersonEvidence: jest.fn(),
  },
}));
jest.mock('../../lib/help-search.js', () => ({ findHelp: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { graphRouter } from '../graph.js';
import { errorHandler } from '../../lib/async-handler.js';
import { aurora } from '../../providers/index.js';
import { findHelp } from '../../lib/help-search.js';

const a = aurora as unknown as Record<string, jest.Mock>;
const findHelpMock = findHelp as unknown as jest.Mock;

const PERSON = { id: 'p-004', name: 'Nora Vance', title: 'Staff Engineer', team: 'Platform' };

function doc(id: string) {
  return {
    id, title: `doc ${id}`, source: 'adr', sourceUri: null,
    ingestedAt: '2026-08-01T00:00:00Z', mentionCount: 2,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/graph', graphRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(a)) fn.mockReset();
  findHelpMock.mockReset();
});

describe('the three snapshot reads', () => {
  it('GET /entities ships nodes + edges + departments + peopleTotal', async () => {
    a['fetchGraph']!.mockResolvedValue({
      nodes: [PERSON],
      edges: [{ sourceId: 'p-004', targetId: 'p-001', kind: 'reports_to', weight: 1 }],
      departments: [{ name: 'Platform', headcount: 1 }],
      peopleTotal: 1,
    });
    const res = await request(buildApp()).get('/api/graph/entities');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['departments', 'edges', 'nodes', 'peopleTotal']);
    expect(res.body.nodes[0].id).toBe('p-004');
  });

  // The whole point of the field: a graph bounded by the circuit-breaker
  // LIMIT ships fewer `nodes` than the true population, and `peopleTotal`
  // has to carry the REAL number rather than collapsing to `nodes.length`
  // the instant a cap is hit. Fails against the old shape (no peopleTotal
  // field at all, or one hand-derived from the capped list).
  it('reports the TRUE population even when `nodes` is a capped page of it', async () => {
    a['fetchGraph']!.mockResolvedValue({
      nodes: [PERSON], // one node shipped...
      edges: [],
      departments: [],
      peopleTotal: 842, // ...of 842 people in the graph.
    });
    const res = await request(buildApp()).get('/api/graph/entities');
    expect(res.body.peopleTotal).toBe(842);
    expect(res.body.peopleTotal).not.toBe(res.body.nodes.length);
  });

  it('GET /skills-graph ships domains + skills + people + personSkillEdges + peopleTotal', async () => {
    a['fetchSkillsGraph']!.mockResolvedValue({
      domains: [{ id: 'domain:Infra', name: 'Infra' }],
      skills: [{ id: 'skill:1', name: 'Kubernetes', domain: 'Infra', personCount: 1 }],
      people: [PERSON],
      personSkillEdges: [{ personId: 'p-004', skillId: 'skill:1', weight: 3 }],
      peopleTotal: 1,
    });
    const res = await request(buildApp()).get('/api/graph/skills-graph');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['domains', 'people', 'peopleTotal', 'personSkillEdges', 'skills']);
    // Edges must reference nodes the same payload carries, or the canvas
    // silently drops them.
    expect(res.body.personSkillEdges[0].skillId).toBe(res.body.skills[0].id);
  });

  it('GET /projects-graph ships projects + people + personProjectEdges + peopleTotal', async () => {
    a['fetchProjectsGraph']!.mockResolvedValue({
      projects: [{ id: 'proj:1', name: 'Observability', status: 'active', contributorCount: 1 }],
      people: [PERSON],
      personProjectEdges: [{ personId: 'p-004', projectId: 'proj:1', weight: 1 }],
      peopleTotal: 1,
    });
    const res = await request(buildApp()).get('/api/graph/projects-graph');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['people', 'peopleTotal', 'personProjectEdges', 'projects']);
    expect(res.body.personProjectEdges[0].projectId).toBe(res.body.projects[0].id);
  });

  it('serves an EMPTY graph as empty arrays rather than an error', async () => {
    a['fetchGraph']!.mockResolvedValue({ nodes: [], edges: [], departments: [], peopleTotal: 0 });
    const res = await request(buildApp()).get('/api/graph/entities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodes: [], edges: [], departments: [], peopleTotal: 0 });
  });
});

describe('GET /api/graph/help', () => {
  beforeEach(() => {
    a['fetchGraph']!.mockResolvedValue({ nodes: [PERSON], edges: [], departments: [], peopleTotal: 1 });
    a['fetchSkillsGraph']!.mockResolvedValue({ domains: [], skills: [], people: [], personSkillEdges: [], peopleTotal: 0 });
    a['fetchProjectsGraph']!.mockResolvedValue({ projects: [], people: [], personProjectEdges: [], peopleTotal: 0 });
  });

  it('400s on a missing or whitespace-only q', async () => {
    for (const url of ['/api/graph/help', '/api/graph/help?q=', '/api/graph/help?q=%20%20']) {
      const res = await request(buildApp()).get(url);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/q/);
    }
    expect(findHelpMock).not.toHaveBeenCalled();
  });

  it('echoes the TRIMMED query and attaches at most three evidence docs per person', async () => {
    findHelpMock.mockReturnValue([{ id: 'p-004', name: 'Nora Vance', reason: 'skill: Kubernetes' }]);
    a['fetchPersonEvidence']!.mockResolvedValue([doc('d1'), doc('d2'), doc('d3'), doc('d4')]);

    const res = await request(buildApp()).get('/api/graph/help?q=%20kubernetes%20');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('kubernetes');
    expect(findHelpMock.mock.calls[0]![0]).toBe('kubernetes');
    expect(res.body.people[0].id).toBe('p-004');
    expect(res.body.people[0].reason).toBe('skill: Kubernetes');
    expect(res.body.people[0].documents.map((d: { id: string }) => d.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('never leaks a score — this router is readable by every orgiq role', async () => {
    findHelpMock.mockReturnValue([{ id: 'p-004', name: 'Nora Vance', reason: 'project: Observability' }]);
    a['fetchPersonEvidence']!.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/graph/help?q=obs');
    const keys = Object.keys(res.body.people[0]);
    for (const forbidden of ['composite', 'compositeScore', 'expertise', 'expertiseScore', 'pagerankScore']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('fetches evidence only for the matched people — zero matches, zero lookups', async () => {
    findHelpMock.mockReturnValue([]);
    const res = await request(buildApp()).get('/api/graph/help?q=nothing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: 'nothing', people: [] });
    expect(a['fetchPersonEvidence']).not.toHaveBeenCalled();
  });
});

describe('GET /api/graph/people/:personId', () => {
  it('returns the detail record, and 404s an unknown person', async () => {
    a['fetchPersonGraph']!.mockResolvedValue({
      ...PERSON, scoredAt: null,
      connections: [{ sourceId: 'p-004', targetId: 'p-001', kind: 'collaborates', weight: 2, otherPerson: { id: 'p-001', name: 'Alex Chen', title: 'PM' } }],
    });
    const ok = await request(buildApp()).get('/api/graph/people/p-004');
    expect(ok.status).toBe(200);
    expect(ok.body.connections[0].otherPerson.id).toBe('p-001');
    expect(ok.body).toHaveProperty('scoredAt');

    a['fetchPersonGraph']!.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/graph/people/p-999');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Person not found' });
  });
});

describe('GET /api/graph/people/:personId/evidence', () => {
  it('wraps the documents and passes the id through', async () => {
    a['fetchPersonEvidence']!.mockResolvedValue([doc('d1')]);
    const res = await request(buildApp()).get('/api/graph/people/p-004/evidence');
    expect(res.status).toBe(200);
    expect(a['fetchPersonEvidence']).toHaveBeenCalledWith('p-004');
    expect(Object.keys(res.body)).toEqual(['documents']);
    expect(res.body.documents[0]).toEqual(doc('d1'));
  });

  it('returns 200 with an empty list when nothing has been ingested', async () => {
    a['fetchPersonEvidence']!.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/graph/people/p-004/evidence');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ documents: [] });
  });
});

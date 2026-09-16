// getRecentInvocations (lib/invocations.ts) under MOCK_AGENTCORE (dev:mock).
//
// The ring buffer it normally reads only fills from real chat traffic, so a
// fresh dev:mock boot showed "No invocations yet" forever even though
// Health's summary (mock/agent-statuses.ts) reports a full day of traffic
// with 25 errors across the 6 agents — the Health "Read the failures on …"
// link had nowhere real to land (DEFECTS.md #7). This pins the fix: in mock
// mode, an empty ring is backfilled with a realistic tail instead of staying
// empty, and any real (mock-agent) traffic still takes priority.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
};

jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/index.js', () => ({
  guardrails: { getGuardrail: jest.fn(async () => ({})) },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(async () => undefined),
  putQualityMetric: jest.fn(async () => undefined),
  putSchemaMetric: jest.fn(async () => undefined),
}));
jest.mock('../embedding.js', () => ({
  embedText: jest.fn(async () => null),
  toPgVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  cosineDistance: () => 0,
  EMBEDDING_DIMENSIONS: 1024,
}));
jest.mock('../judge.js', () => ({
  judgeResponse: jest.fn(async () => ({ score: 0.8, rationale: 'fine', usage: { inputTokens: 1, outputTokens: 1 } })),
}));

import { getRecentInvocations } from '../invocations.js';
import { mockAgents } from '../../mock/agent-statuses.js';

describe('getRecentInvocations under MOCK_AGENTCORE', () => {
  beforeEach(() => {
    mockConfig.mock.agentcore = false;
  });

  it('stays empty (real mode, no traffic yet) when MOCK_AGENTCORE is off', () => {
    expect(getRecentInvocations()).toEqual([]);
  });

  it('backfills a realistic tail whose agents are all real fleet members', () => {
    mockConfig.mock.agentcore = true;
    const rows = getRecentInvocations(100);

    expect(rows.length).toBeGreaterThanOrEqual(25);

    // This used to assert the converse — that every agent in the fleet appears
    // in the tail — which was true only while the fleet was exactly the six
    // agents the corpus writes traffic for. `ListAgentRuntimes` filters by
    // nothing, so the real fleet also carries the two assessment agents and
    // devbox, and the honest tail for an agent with no traffic is no rows at
    // all. Making that assertion pass again would mean manufacturing runs to
    // satisfy a count, which is the exact sin mock/agent-statuses.ts's header
    // was written about.
    //
    // The drift worth guarding runs the other way: the tail must never name an
    // agent the fleet does not have, because that is what makes the "All
    // agents" filter disagree with Health about who exists.
    const fleetIds = new Set(mockAgents.map((a) => a.id));
    const fleetNames = new Set(mockAgents.map((a) => a.name));
    for (const row of rows) {
      expect(fleetIds.has(row.agentId)).toBe(true);
      expect(fleetNames.has(row.agentName)).toBe(true);
    }

    // And the agents the corpus does write traffic for are all represented, so
    // a corpus that quietly stopped covering one is still caught.
    const agentIds = new Set(rows.map((r) => r.agentId));
    for (const id of [
      'orgiq-supervisor', 'orgiq-search', 'orgiq-scoring',
      'orgiq-advisor', 'orgiq-ingestion', 'orgiq-graph-builder',
    ]) {
      expect(agentIds.has(id)).toBe(true);
    }

    const errors = rows.filter((r) => r.error);
    const blocked = rows.filter((r) => r.guardrailIntervened);
    const ok = rows.filter((r) => !r.error && !r.guardrailIntervened);
    expect(errors.length).toBeGreaterThan(0);
    expect(blocked.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);

    // Scoring reports 0 errors in the Health summary — the tail should agree.
    const scoringRows = rows.filter((r) => r.agentId === 'orgiq-scoring');
    expect(scoringRows.some((r) => r.error)).toBe(false);

    // Every timestamp is inside the last 24h.
    const now = Date.now();
    for (const r of rows) {
      const ageMs = now - new Date(r.startedAt).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(24 * 3_600_000);
    }
  });

  it('respects the limit', () => {
    mockConfig.mock.agentcore = true;
    expect(getRecentInvocations(5).length).toBe(5);
  });
});

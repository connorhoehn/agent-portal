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

  it('backfills a realistic tail across the 6 deployed agents when MOCK_AGENTCORE is on', () => {
    mockConfig.mock.agentcore = true;
    const rows = getRecentInvocations(100);

    expect(rows.length).toBeGreaterThanOrEqual(25);

    const agentNames = new Set(rows.map((r) => r.agentName));
    // Every agent Health's summary knows about should be represented, so the
    // "All agents" filter and the tail agree on who's in the fleet.
    for (const a of mockAgents) {
      expect(agentNames.has(a.name)).toBe(true);
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

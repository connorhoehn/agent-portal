// mock/org-findings.ts's `large` branch.
//
// WHY THIS EXISTS. `/api/work/summary`'s `findings.open/critical/warning`
// comes from `findingStats()` (providers/org-sweeps.ts) — a real GROUP BY
// over every row, deliberately NOT `listFindings({limit:300}).length`,
// because that route caps its LIST at 300. Nothing offline could prove the
// summary stays right past that cap while the seeded board has 7 rows.

import { orgFindings, mockFindings, nextMockFindingId } from '../org-findings.js';
import { fixtureRegistry } from '../core/index.js';

// The last describe block below dynamically imports providers/org-sweeps.ts,
// which imports providers/aurora.ts, which reads config.ts — and config.ts's
// `import.meta.url` is a hard TS1343 error under ts-jest's CJS transform.
// Mocked the same way schema-shape.test.ts / mock-control.test.ts already do.
jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('orgFindings large scenario', () => {
  it('is bigger than default, and past the 300-row findings-list cap', () => {
    const seeded = orgFindings.rows('default');
    const large = orgFindings.rows('large');
    expect(large.length).toBeGreaterThan(seeded.length);
    expect(large.length).toBeGreaterThan(300);
  });

  it('every large row is open, well-formed, and uniquely fingerprinted', () => {
    const large = orgFindings.rows('large');
    for (const f of large) {
      expect(f.id).toMatch(/^find-mock-\d+$/);
      expect(f.status).toBe('open');
    }
    expect(new Set(large.map((f) => f.id)).size).toBe(large.length);
    expect(new Set(large.map((f) => f.fingerprint)).size).toBe(large.length);
  });

  it('reset restores the seeded 7-row board', () => {
    fixtureRegistry.resetAll('large');
    expect(orgFindings.rows().length).toBeGreaterThan(300);

    fixtureRegistry.resetAll('default');
    expect(orgFindings.rows()).toHaveLength(7);
    expect(mockFindings).toHaveLength(7);
  });

  it('nextMockFindingId continues past the large board\'s own high-water mark', () => {
    fixtureRegistry.resetAll('large');
    const large = orgFindings.rows();
    const maxId = Math.max(...large.map((f) => Number(/^find-mock-(\d+)$/.exec(f.id)?.[1] ?? 0)));
    expect(nextMockFindingId()).toBe(`find-mock-${maxId + 1}`);
  });
});

describe('findingStats over the large board (GROUP BY, not a capped list)', () => {
  it('counts every open row, not just the first 300 a list would return', async () => {
    fixtureRegistry.resetAll('large');
    const { findingStats } = await import('../../providers/org-sweeps.js');
    const stats = await findingStats();
    const openTotal = stats.filter((s) => s.status === 'open').reduce((sum, s) => sum + s.n, 0);
    expect(openTotal).toBeGreaterThan(300);
    expect(openTotal).toBe(mockFindings.length);
  });
});

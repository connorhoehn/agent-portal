// The seeded candidates the pipelines tenant reads as runbook definitions.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { listCandidates } from '../promotions.js';

describe('listCandidates', () => {
  it('lists the three seeded candidates, including the drifted one', async () => {
    const candidates = await listCandidates();
    expect(candidates.map((c) => c.id)).toEqual(expect.arrayContaining([
      'promo-aurora-cold-start', 'promo-arm64-fargate', 'promo-custodian-sg-drift',
    ]));
    const drifted = candidates.find((c) => c.id === 'promo-custodian-sg-drift');
    expect(drifted?.driftedFrom).toBe('skl-custodian-sg-allowlist');
    expect(drifted?.proposedKind).toBe('runbook');
  });
});

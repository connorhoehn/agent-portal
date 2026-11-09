// The cookie-less demo identity (DEMO_SUB) has no person link, so it is attached
// nowhere and decides nothing. Under INSECURE_DEV_MODE it explores as an org-wide
// steward and a decide override; outside the flag it is exactly what it was.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn(async (id: string) => ({ id, ownerId: 'p-owner' })) }));

import { stewardsInitiative } from '../initiative-scope.js';
import { mayDecideDecision } from '../decision-authority.js';
import { DEMO_SUB, type Session } from '../session.js';

const as = (sub: string): Session => ({ sub, tenant: 'orgiq', role: 'sme', epoch: 0, iat: 1, grants: { orgiq: ['sme'] } });
const decision = { projectId: 'p-x', participants: [{ personId: 'p-d', role: 'decider' }] };

const saved = process.env.INSECURE_DEV_MODE;
afterEach(() => { if (saved === undefined) delete process.env.INSECURE_DEV_MODE; else process.env.INSECURE_DEV_MODE = saved; });

describe('stewardsInitiative, demo identity', () => {
  it('flag on: the demo identity stewards any initiative', async () => {
    process.env.INSECURE_DEV_MODE = 'true';
    expect(await stewardsInitiative(as(DEMO_SUB), 'p-x')).toBe(true);
  });
  it('flag off: unchanged, not attached', async () => {
    process.env.INSECURE_DEV_MODE = 'false';
    expect(await stewardsInitiative(as(DEMO_SUB), 'p-x')).toBe(false);
  });
  it('a real sub is unchanged under the flag', async () => {
    process.env.INSECURE_DEV_MODE = 'true';
    expect(await stewardsInitiative(as('u-real'), 'p-x')).toBe(false);
  });
});

describe('mayDecideDecision, demo identity', () => {
  it('flag on: the demo identity may decide, via demo', async () => {
    process.env.INSECURE_DEV_MODE = 'true';
    expect(await mayDecideDecision(as(DEMO_SUB), decision)).toEqual({ ok: true, via: 'demo', decidesThis: false });
  });
  it('flag off: unchanged, refused', async () => {
    process.env.INSECURE_DEV_MODE = 'false';
    expect(await mayDecideDecision(as(DEMO_SUB), decision)).toEqual({ ok: false, decidesThis: false });
  });
  it('a real sub is unchanged under the flag', async () => {
    process.env.INSECURE_DEV_MODE = 'true';
    expect(await mayDecideDecision(as('u-real'), decision)).toEqual({ ok: false, decidesThis: false });
  });
});

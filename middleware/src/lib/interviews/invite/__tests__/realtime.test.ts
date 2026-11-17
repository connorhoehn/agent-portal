// The guest's realtime token, built and not served (lib/interviews/invite/realtime.ts; docs/interviews-tenant-plan.md
// row I2.1 and "I0.7 answer"): its claims, that it verifies as the token bridge's own tokens do, that no route
// hands one out, and that this middleware's gateway refuses it on every channel today (the directory has no
// user for its subject). Row I2.2 serves it, together with platform-api's refusal outside the video session.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []) }));
jest.mock('../../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../../page-resources.js', () => ({ pageResourceVisible: jest.fn(async () => true) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUser, type UserInfo } from '../../../../providers/identity.js';
import { verifyRealtimeToken } from '../../../realtime-token.js';
import { gatewayAuthFromClaims } from '../../../gateway/auth.js';
import { admitCursor, admitLobbyRead, admitPrincipal, admitPublish, admitSubscribe } from '../../../gateway/authority.js';
import { enumerateRoutes } from '../../../../mock/core/wire/routes.js';
import { GUEST_ROLE, type GuestPrincipal } from '../guest.js';
import { GUEST_DISPLAY_NAME, guestRealtimeClaims, mintGuestRealtimeToken } from '../realtime.js';

const SECRET = 'guest-realtime-test-secret';
const guest: GuestPrincipal = {
  kind: 'interview-guest', inviteId: 'inv-1', interviewId: 'iv-mateo-design', role: GUEST_ROLE, tenant: null, grants: {}, since: '2026-11-16T10:00:00.000Z',
};

beforeEach(() => {
  // A directory where everyone the facade tests know exists: the guest's subject is not among them, and never is.
  const users = new Map<string, UserInfo>([['u-greta', { id: 'u-greta', displayName: 'Greta', epoch: 0, email: null, personId: null, grants: { interviews: ['recruiter'] } }]]);
  jest.mocked(getUser).mockImplementation(async (id) => structuredClone(users.get(id) ?? null));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the claims', () => {
  it('name one interview, hold no tenant and a role no Cedar file grants, and carry nothing from the candidate\'s record', () => {
    const c = guestRealtimeClaims(guest);
    expect(c).toMatchObject({ sub: 'guest:inv-1', displayName: GUEST_DISPLAY_NAME, tenants: [], role: 'interview-guest', org: 'interviews', guest: { interviewId: 'iv-mateo-design', inviteId: 'inv-1' } });
    expect(c.email).toBeUndefined();
    expect(c.act).toBeUndefined();
    const seeds = join(__dirname, '..', '..', '..', '..', '..', 'seeds', 'roles');
    for (const tenant of ['interviews', 'orgiq', 'assessment', 'social', 'pipelines', 'access']) {
      expect(() => readFileSync(join(seeds, tenant, `${GUEST_ROLE}.cedar`))).toThrow();
    }
  });

  it('verify exactly as the token bridge\'s own tokens do', async () => {
    const { token, expiresAt } = await mintGuestRealtimeToken(guest, SECRET);
    const verified = await verifyRealtimeToken(token, SECRET);
    expect(verified).toMatchObject({ sub: 'guest:inv-1', role: GUEST_ROLE, tenants: [], guest: { interviewId: 'iv-mateo-design' } });
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('not served', () => {
  it('no route this server mounts hands one out: nothing imports the mint outside its own folder', () => {
    const routes = enumerateRoutes().routes.map((r) => r.path);
    expect(routes.filter((p) => p.startsWith('/api/interview-invite'))).toEqual(expect.arrayContaining(['/api/interview-invite/exchange', '/api/interview-invite/interview']));
    expect(routes.filter((p) => p.startsWith('/api/interview-invite'))).toHaveLength(2);
    for (const file of ['routes/interview-invite.ts', 'routes/interviews/invite.ts', 'routes/session.ts', 'index.ts']) {
      expect([file, readFileSync(join(__dirname, '..', '..', '..', '..', file), 'utf8').includes('mintGuestRealtimeToken')]).toEqual([file, false]);
    }
  });
});

describe('this middleware\'s gateway refuses a guest token on every channel today', () => {
  const CHANNELS = [
    'interviews:interview:iv-mateo-design', 'interviews:interview:iv-aiko-coding', 'interviews:pad:iv-mateo-design',
    'orgiq:initiative:p-1', 'assessment:team:TEAM-1', 'pipelines:run:r1', 'social:ch:general', 'social:dm:guest:inv-1:u-greta',
    'access:req:req-0001', 'presence:interviews:interview:iv-mateo-design', 'notifications:guest:inv-1', 'orgiq:huddle:c1',
  ];
  let ctx: Record<string, unknown>;
  beforeEach(async () => {
    const { token } = await mintGuestRealtimeToken(guest, SECRET);
    ctx = gatewayAuthFromClaims(await verifyRealtimeToken(token, SECRET)) as unknown as Record<string, unknown>;
  });

  it('the principal itself is not current', async () => {
    expect(await admitPrincipal(ctx)).toBe(false);
  });

  it.each(CHANNELS)('%s: no subscribe, no publish, no cursor', async (channel) => {
    expect(await admitSubscribe(ctx, channel)).toBe(false);
    expect(await admitPublish(ctx, channel)).toBe(false);
    expect(await admitCursor(ctx, channel, 'publish')).toBe(false);
  });

  it('no lobby admits it, its own interview\'s included', async () => {
    for (const lobby of ['interviews:interview:iv-mateo-design', 'orgiq:initiative:p-1']) {
      expect(await admitLobbyRead(ctx, lobby)).not.toBe('ok');
    }
  });
});

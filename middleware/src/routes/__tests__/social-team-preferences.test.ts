// Real providers and registered route middleware, without a listening socket.
// The existing social-platform HTTP suite retains transport/URL coverage.
jest.mock('../../config.js', () => ({
  config: {
    auth: { policyStoreId: undefined }, mock: { aurora: true },
    cognito: { userPoolId: 'test', clientId: 'test', clientSecret: 'test', domain: 'test', callbackUrl: 'test' },
  },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', capabilities: ['*'] },
    { id: 'participant', capabilities: ['ViewSocial'] },
    { id: 'moderator', capabilities: ['ViewSocial', 'ManageTeams'] },
    { id: 'community-admin', capabilities: ['ViewSocial', 'ManageTeams'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class {}, IsAuthorizedCommand: class {},
}));

import type { Request, Response as ExpressResponse, NextFunction, RequestHandler } from 'express';
import { decodeJwt } from 'jose';
import { socialRouter } from '../social.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { lobbyGuard } from '../../lib/realtime-gateway.js';
import type { Session } from '../../lib/session.js';
import * as identity from '../../providers/identity.js';
import {
  addTeamMember, createTeam, getTeam, isSocialTeamMember, listTeams, removeTeamMember,
  resetSocialTeamMirror, setTeamFavorite,
} from '../../providers/social-platform.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { socialRoomsFixture, socialTeamMembersFixture, socialTeamsFixture, type SocialTeamRow } from '../../mock/social-platform.js';

const COMMUNITY = 'mock-team-community';
const MODERATION = 'mock-team-moderation';
const CHANNEL = 'social:team:community:community-general';
const session = (sub: string, role = 'participant', tenant = 'social'): Session => ({
  sub, role, tenant, grants: { [tenant]: [role] }, iat: 0,
}) as Session;
const sana = session('u-sana');
const mira = session('u-mira', 'community-admin');
const lena = session('u-lena', 'moderator');
const claims = (current = sana) => ({ userId: current.sub, org: 'social', tenants: ['social'] });
const membership = (userId: string) => socialTeamMembersFixture.rows().find(row => row.teamId === COMMUNITY && row.userId === userId);

async function route(method: 'patch' | 'delete', current: Session | null = sana, body?: unknown, teamId = COMMUNITY, userId = current?.sub ?? '') {
  const path = method === 'patch' ? '/teams/:teamId/me' : '/teams/:teamId/members/:userId';
  const layer = socialRouter.stack.find(item => item.route?.path === path && item.route.stack.some(handler => handler.method === method));
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} is not registered`);
  const handlers: RequestHandler[] = [requireTenant('social'), ...layer.route.stack.map(item => item.handle)];
  const req = { session: current ?? undefined, body: arguments.length >= 3 ? body : { favorite: true }, params: { teamId, userId }, path, method: method.toUpperCase() } as unknown as Request;
  return new Promise<{ status: number; body?: Record<string, unknown> }>((resolve, reject) => {
    const result: { status: number; body?: Record<string, unknown> } = { status: 200 };
    const res = {
      headersSent: false,
      status(status: number) { result.status = status; return this; },
      json(value: Record<string, unknown>) { result.body = value; resolve(result); return this; },
      end() { resolve(result); return this; },
    } as unknown as ExpressResponse;
    let index = 0;
    const next: NextFunction = err => {
      if (err) { errorHandler(err, req, res, reject); return; }
      const handler = handlers[index++];
      if (!handler) { reject(new Error('The route did not produce a response')); return; }
      try { Promise.resolve(handler(req, res, next)).catch(next); } catch (error) { next(error); }
    };
    next();
  });
}

const savedEnv = { ...process.env };
const originalFetch = global.fetch;
beforeEach(() => {
  delete process.env['SOCIAL_PLATFORM_INTERNAL_URL'];
  delete process.env['SOCIAL_PLATFORM_BACKEND'];
  delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
  delete process.env['PLATFORM_API_URL'];
  process.env['REALTIME_JWT_SECRET'] = 'team-preferences-test';
  resetSocialTeamMirror();
});
afterEach(() => {
  jest.restoreAllMocks(); global.fetch = originalFetch;
  socialTeamsFixture.reset(); socialTeamMembersFixture.reset(); socialRoomsFixture.reset();
  resetSocialTeamMirror(); process.env = { ...savedEnv };
});

describe('registered personal team routes with the mock provider', () => {
  it('participant pins/unpins only their own membership; list/detail agree and fixture reset restores the preference', async () => {
    const teamBefore = { ...socialTeamsFixture.rows().find(row => row.teamId === COMMUNITY)! };
    const ownerBefore = { ...membership('u-mira')! };
    const peerBefore = { ...membership('u-lena')! };
    expect(await route('patch')).toMatchObject({ status: 200, body: { member: { teamId: COMMUNITY, userId: 'u-sana', role: 'member', favorite: true } } });
    expect((await listTeams(sana)).find(row => row.teamId === COMMUNITY)?.favorite).toBe(true);
    expect((await getTeam(sana, COMMUNITY)).team.favorite).toBe(true);
    expect((await listTeams(mira)).find(row => row.teamId === COMMUNITY)?.favorite).toBe(false);
    expect(membership('u-mira')).toEqual(ownerBefore); expect(membership('u-lena')).toEqual(peerBefore);
    expect(socialTeamsFixture.rows().find(row => row.teamId === COMMUNITY)).toEqual(teamBefore);
    expect((await route('patch', sana, { favorite: false })).status).toBe(200);
    expect(membership('u-sana')?.favorite).toBe(false);
    await route('patch'); fixtureRegistry.get('social.team-members')!.reset();
    expect(membership('u-sana')?.favorite).toBe(false);
  });
  it.each([undefined, null, [], true, {}, { favorite: 1 }, { favorite: 'true' }, { favorite: true, userId: 'u-mira' }, { favorite: true, tenant: 'orgiq' }])(
    'rejects malformed/forged preference body %# before mutation', async body => {
      expect((await route('patch', sana, body)).status).toBe(400);
      expect(membership('u-sana')?.favorite).toBe(false);
      expect(membership('u-mira')?.favorite).toBe(false);
    },
  );
  it('requires a real session and the current Social tenant', async () => {
    expect((await route('patch', null)).status).toBe(401);
    const parked = session('u-sana', 'member', 'orgiq'); parked.grants.social = ['participant'];
    expect((await route('patch', parked)).status).toBe(403);
    expect(membership('u-sana')?.favorite).toBe(false);
  });
  // The one Social gate (lib/social-authority.ts) answers a cookie whose signed role the directory no longer
  // grants with 401 "sign in again" — the plane's verdict for the same (user, action, epoch) — not the 403 the
  // retired personalTeamSession gave; a signed role still held but lacking the action stays 403 (below).
  it.each(['patch', 'delete'] as const)('rechecks current authoritative grants for %s despite a previously permitted cookie', async method => {
    const user = (await identity.getUser(sana.sub))!;
    jest.spyOn(identity, 'getUser').mockResolvedValueOnce({ ...user, grants: {} });
    expect((await route(method)).status).toBe(401);
    expect(identity.getUser).toHaveBeenCalledWith('u-sana', { authoritative: true });
    expect(membership('u-sana')).toBeDefined(); expect(membership('u-sana')?.favorite).toBe(false);
  });
  it.each(['patch', 'delete'] as const)('fails closed on deleted identity and identity outage for %s', async method => {
    const lookup = jest.spyOn(identity, 'getUser').mockResolvedValueOnce(null);
    expect((await route(method)).status).toBe(401);
    lookup.mockRejectedValueOnce(new Error('identity unavailable'));
    expect((await route(method)).status).toBe(503);
    expect(membership('u-sana')).toBeDefined();
  });
  it.each(['patch', 'delete'] as const)('rejects a cookie superseded by a tenant/role switch before its periodic grant refresh for %s', async method => {
    const user = (await identity.getUser(sana.sub))!;
    jest.spyOn(identity, 'getUser').mockResolvedValueOnce({ ...user, epoch: 1 });
    const recentCookie = { ...sana, iat: Math.floor(Date.now() / 1000), epoch: 0 };
    expect((await route(method, recentCookie)).status).toBe(401);
    expect(membership('u-sana')).toBeDefined(); expect(membership('u-sana')?.favorite).toBe(false);
  });
  it.each(['patch', 'delete'] as const)('rejects a revoked selected role even when another Social role remains for %s', async method => {
    const user = (await identity.getUser(sana.sub))!;
    jest.spyOn(identity, 'getUser').mockResolvedValueOnce({ ...user, grants: { social: ['moderator'] } });
    expect((await route(method)).status).toBe(401);
    expect(membership('u-sana')).toBeDefined();
  });
  it.each(['patch', 'delete'] as const)('rechecks masquerade actor epoch and current admin authority for %s', async method => {
    const user = (await identity.getUser(sana.sub))!;
    const impersonated = { ...sana, act: { sub: 'actor-admin', role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] }, epoch: 0 } } as Session;
    const lookup = jest.spyOn(identity, 'getUser').mockImplementation(async userId => userId === sana.sub ? user : {
      ...user, id: 'actor-admin', epoch: 1, grants: { orgiq: ['admin'] },
    });
    expect((await route(method, impersonated)).status).toBe(401);
    lookup.mockImplementation(async userId => userId === sana.sub ? user : { ...user, id: 'actor-admin', epoch: 0, grants: {} });
    expect((await route(method, impersonated)).status).toBe(401);
    expect(membership('u-sana')).toBeDefined(); expect(membership('u-sana')?.favorite).toBe(false);
  });
  it('a participant leaves their team, losing list, preference and gateway access', async () => {
    await route('patch');
    expect(lobbyGuard(claims(), CHANNEL)).toBe(true);
    expect((await route('delete')).status).toBe(204);
    expect(membership('u-sana')).toBeUndefined();
    expect(await listTeams(sana)).toEqual([]);
    expect(lobbyGuard(claims(), CHANNEL)).toBe(false);
    expect((await route('patch')).status).toBe(403);
    expect(membership('u-mira')).toBeDefined(); expect(membership('u-lena')).toBeDefined();
  });
  it('keeps ManageTeams and team ownership checks for removing other people', async () => {
    expect((await route('delete', sana, undefined, COMMUNITY, 'u-mira')).status).toBe(403);
    expect((await route('delete', lena, undefined, COMMUNITY, 'u-mira')).status).toBe(403);
    expect((await route('delete', mira, undefined, COMMUNITY, 'u-sana')).status).toBe(204);
    expect(membership('u-mira')).toBeDefined(); expect(membership('u-sana')).toBeUndefined();
  });
  it('denies public nonmembers and hides private, missing, archived and other-tenant teams', async () => {
    const outsider = session('u-theo');
    expect((await route('patch', outsider)).status).toBe(403);
    expect((await route('patch', sana, { favorite: true }, MODERATION)).status).toBe(404);
    expect((await route('patch', sana, { favorite: true }, 'missing')).status).toBe(404);
    const team = socialTeamsFixture.rows().find(row => row.teamId === COMMUNITY)!;
    team.state = 'archived'; expect((await route('patch')).status).toBe(404);
    team.state = 'active'; team.orgId = 'orgiq'; expect((await route('patch')).status).toBe(404);
    expect(membership('u-sana')?.favorite).toBe(false);
  });
});

describe('direct mock preference provider', () => {
  it('an awaited preference cannot recreate a membership removed after its initial read', async () => {
    const pending = setTeamFavorite(sana, COMMUNITY, true);
    const members = socialTeamMembersFixture.rows();
    members.splice(members.findIndex(row => row.teamId === COMMUNITY && row.userId === sana.sub), 1);
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(membership('u-sana')).toBeUndefined(); expect(isSocialTeamMember('community', 'u-sana')).toBe(false);
  });
  it('new teams and newly added people start with an explicit resettable false preference', async () => {
    const team = await createTeam(mira, { name: 'Preferences crew', visibility: 'org' });
    await addTeamMember(mira, team.teamId, sana.sub);
    expect(socialTeamMembersFixture.rows().filter(row => row.teamId === team.teamId).map(row => row.favorite)).toEqual([false, false]);
  });
});

describe('upstream preference and membership contracts without HTTP listeners', () => {
  const team: SocialTeamRow = {
    orgId: 'social', teamId: 'upstream-team', slug: 'upstream-team', name: 'Upstream team', visibility: 'org',
    createdBy: mira.sub, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', state: 'active',
  };
  const member = (userId = sana.sub) => ({ teamId: team.teamId, userId, role: userId === mira.sub ? 'owner' : 'member', addedBy: mira.sub, joinedAt: team.createdAt, favorite: false });
  const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  beforeEach(() => { process.env['SOCIAL_PLATFORM_INTERNAL_URL'] = 'http://platform.test'; process.env['SOCIAL_PLATFORM_BACKEND'] = 'platform'; });
  it('uses the caller token and fixed social partition, preserves the upstream member response and never primes gateway membership', async () => {
    const mine = { ...member(), favorite: true };
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, init) => init?.method === 'GET'
      ? json({ team, role: 'member', members: [member(), member(mira.sub)] }) : json({ member: mine }));
    global.fetch = fetcher;
    expect(await setTeamFavorite(sana, team.teamId, true)).toEqual(mine);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('http://platform.test/api/teams/upstream-team/me?tenant=social');
    expect(init?.method).toBe('PATCH'); expect(JSON.parse(String(init?.body))).toEqual({ favorite: true, tenant: 'social' });
    expect(decodeJwt(String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /, ''))).toMatchObject({ sub: sana.sub, org: 'social' });
    expect(isSocialTeamMember(team.slug, sana.sub)).toBe(false);
  });
  it.each([
    [{ ...team, orgId: 'orgiq' }, [member()], 404],
    [{ ...team, state: 'archived' }, [member()], 404],
    [{ ...team, teamId: 'wrong-team' }, [member()], 404],
    [{ ...team, visibility: 'private' }, [], 404],
    [team, [], 403],
  ])('rejects a wrong tenant, inactive team or absent membership before PATCH %#', async (row, members, status) => {
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(json({ team: row, members })); global.fetch = fetcher;
    await expect(setTeamFavorite(sana, team.teamId, true)).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404, 500])('passes upstream refusal %i through with 5xx mapped to502', async status => {
    global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, init) => init?.method === 'GET'
      ? json({ team, members: [member()] }) : json({ error: 'preference unavailable' }, status));
    await expect(setTeamFavorite(sana, team.teamId, true)).rejects.toMatchObject({ status: status === 500 ? 502 : status });
  });
  it.each([{ ...member('another-user'), favorite: true }, { ...member(), teamId: 'another-team', favorite: true }, { ...member(), favorite: false }])(
    'refuses a mismatched upstream personal preference response %#', async value => {
      global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, init) => init?.method === 'GET'
        ? json({ team, members: [member()] }) : json({ member: value }));
      await expect(setTeamFavorite(sana, team.teamId, true)).rejects.toMatchObject({ status: 502 });
    },
  );
  it.each(['list', 'detail'] as const)('a deferred old %s response cannot restore gateway access after self-leave', async kind => {
    let members = [member(), member(mira.sub)];
    let holdNextRead = false;
    let release!: (response: Response) => void;
    let entered!: () => void;
    const readStarted = new Promise<void>(resolve => { entered = resolve; });
    const oldRead = new Promise<Response>(resolve => { release = resolve; });
    global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') { members = members.filter(row => row.userId !== sana.sub); return json(null, 204); }
      const isList = new URL(String(url)).pathname === '/api/teams';
      const body = isList ? { teams: [{ ...team, role: 'member', favorite: false }] } : { team, role: 'member', members };
      if (holdNextRead) { holdNextRead = false; const snapshot = JSON.parse(JSON.stringify(body)); entered(); await oldRead; return json(snapshot); }
      return json(body);
    });
    await getTeam(sana, team.teamId);
    const channel = `social:team:${team.slug}:general`;
    expect(lobbyGuard(claims(), channel)).toBe(true);
    holdNextRead = true;
    const pending = kind === 'list' ? listTeams(sana) : getTeam(mira, team.teamId);
    await readStarted;
    await removeTeamMember(sana, team.teamId, sana.sub);
    expect(lobbyGuard(claims(), channel)).toBe(false);
    release(json(null)); await pending;
    expect(lobbyGuard(claims(), channel)).toBe(false);
    expect(isSocialTeamMember(team.slug, mira.sub)).toBe(true);
    await getTeam(mira, team.teamId);
    expect(lobbyGuard(claims(), channel)).toBe(false);
  });
  it('a preference preflight using an old roster cannot revive a removed member', async () => {
    const snapshot = { team, role: 'member', members: [member(), member(mira.sub)] };
    global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, init) => init?.method === 'DELETE' ? json(null, 204) : json(snapshot));
    await getTeam(sana, team.teamId); await removeTeamMember(sana, team.teamId, sana.sub);
    global.fetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async (_url, init) => init?.method === 'GET' ? json(snapshot) : json({ error: 'not a member' }, 403));
    await expect(setTeamFavorite(sana, team.teamId, true)).rejects.toMatchObject({ status: 403 });
    expect(isSocialTeamMember(team.slug, sana.sub)).toBe(false);
  });
});

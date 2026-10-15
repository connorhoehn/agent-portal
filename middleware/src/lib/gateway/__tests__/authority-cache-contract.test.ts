// The verdict cache's revocation contract on the BFF (lib/gateway/authority-invalidation.ts,
// realtime-modules 0.120 verdictCache.ts V1–V7), over a real http.Server, raw `ws`
// clients and real realtime tokens, driving the REAL write functions:
//
//   for every authority write: a removal refuses the very next frame on the
//   affected channel (the cache is fresh — maxAgeMs is 60 s here, so a refusal
//   can only come from the invalidation), and a grant admits the next frame.
//
// Each case first proves the probe frame IS served from the cache (a hit), so a
// refusal afterwards is the invalidation working, not a cold cache. The control
// case shows a removal written around the seam keeps being admitted from the
// cache, which is why every write must call it
// (authority-invalidation-coverage.test.ts pins the list).

jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
// The seed capabilities this file needs; the Jest CJS runtime cannot import the
// registry's import.meta URL (same stand-in as realtime-gateway-social.test.ts).
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [
  ...['participant', 'moderator', 'community-admin'].map(id => ({ id, tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] })),
  ...['requester', 'approver', 'access-admin'].map(id => ({ id, tenant: 'access', capabilities: ['ViewAccess'] })),
  ...['assessor', 'lead-assessor', 'program-lead'].map(id => ({ id, tenant: 'assessment', capabilities: ['ViewAssessment'] })),
] }));
// The Cedar decision itself stays the real open-mode evaluation; `policyDenies`
// stands in for an edited policy, which routes/identity.ts follows with the
// real `clearAuthzCache()` — the hook under test.
const policyDenies = new Set<string>();
jest.mock('../../authz.js', () => {
  const actual = jest.requireActual('../../authz.js');
  return { ...actual, isAllowed: jest.fn(async (principal: { role: string }, action: string, ...rest: unknown[]) =>
    !policyDenies.has(`${principal.role}:${action}`) && actual.isAllowed(principal, action, ...rest)) };
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../../realtime-gateway.js';
import { socialChat } from '../../social-chat.js';
import { signRealtimeToken, realtimeClaims } from '../../realtime-token.js';
import type { Session } from '../../session.js';
import { bumpSessionEpoch, getUser, grantRole, revokeRole, setGrants } from '../../../providers/identity.js';
import { addTeamMember, createTeam, removeTeamMember } from '../../../providers/social-platform.js';
import { socialTeamMembersFixture } from '../../../mock/social-platform.js';
import { casRequest, findRequest } from '../../../providers/access.js';
import { requestReadableBy } from '../../access/thread.js';
import { deleteTeam } from '../../../providers/assessment.js';
import { clearAuthzCache } from '../../authz.js';
import { fixtureRegistry } from '../../../mock/core/fixture.js';
import { authorityInvalidationStats, invalidateAll, invalidateForUser } from '../authority-invalidation.js';

const SECRET = 'authority-cache-contract';
const GENERAL = 'social:ch:general';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server, port: number, handle: ReturnType<typeof attachRealtimeGateway>;
const sockets: WebSocket[] = [];
const env = { secret: process.env['REALTIME_JWT_SECRET'], age: process.env['REALTIME_AUTHORITY_CACHE_MAX_AGE_MS'] };

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  process.env['REALTIME_AUTHORITY_CACHE_MAX_AGE_MS'] = '60000';
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, statsIntervalMs: 0, authorityCache: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => { for (const ws of sockets.splice(0)) ws.terminate(); policyDenies.clear(); fixtureRegistry.resetAll(); invalidateAll('test-reset'); });
afterAll(async () => {
  await handle.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const [name, value] of [['REALTIME_JWT_SECRET', env.secret], ['REALTIME_AUTHORITY_CACHE_MAX_AGE_MS', env.age]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

async function connectAs(sub: string, tenant: string): Promise<Open> {
  const user = await getUser(sub, { authoritative: true });
  const session = { sub, name: sub, role: user?.grants[tenant]?.[0], tenant, grants: user?.grants ?? {}, epoch: user?.epoch ?? 0,
    iat: Math.floor(Date.now() / 1000) } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
  sockets.push(ws);
  const open: Open = { ws, frames: [] };
  ws.on('message', data => open.frames.push(JSON.parse(String(data)) as Frame));
  await until(() => open.frames.some(f => f.type === 'session'));
  return open;
}
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise(r => setTimeout(r, 10));
  }
}
const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const hits = () => handle.authorityCache!.stats().hits;
let seq = 0;

async function join(o: Open, channel: string): Promise<void> {
  send(o, { service: 'chat', action: 'join', channel });
  await until(() => o.frames.some(f => f.type === 'chat' && f.action === 'joined' && f['channel'] === channel));
}
/** The next chat send on `channel`: 'admitted' (acknowledged) or 'refused' (AUTHZ_CHANNEL_DENIED). */
async function nextSend(o: Open, channel: string): Promise<'admitted' | 'refused'> {
  const text = `probe ${++seq}`;
  // The sender's own echo carries the text; the `sent` ack carries only the id.
  const acked = () => o.frames.some(f => f.type === 'chat' && f.action === 'message' && (f['message'] as { message?: string } | undefined)?.message === text);
  const refusals = o.frames.filter(f => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED').length;
  const refused = () => o.frames.filter(f => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED').length > refusals;
  send(o, { service: 'chat', action: 'send', channel, message: text });
  await until(() => acked() || refused());
  if (refused()) expect((await socialChat().chatStore.listMessages(channel, 200)).some(m => m.message === text)).toBe(false);
  return acked() ? 'admitted' : 'refused';
}
/** Join, send once (a miss that stores), and prove the next send is a cache HIT. */
async function warm(o: Open, channel: string): Promise<void> {
  await join(o, channel);
  expect(await nextSend(o, channel)).toBe('admitted');
  const before = hits();
  expect(await nextSend(o, channel)).toBe('admitted');
  expect(hits()).toBeGreaterThan(before);
}

describe('removal refuses the next frame; grant admits the next frame', () => {
  // Theo is signed in to orgiq and posts in Social on his Social grant: removing
  // that grant leaves his source session current, so principal revalidation
  // alone would keep admitting him; only the seam's user invalidation refuses.
  it('identity revokeRole / grantRole on a grant other than the source role', async () => {
    const theo = await connectAs('u-theo', 'orgiq');
    await warm(theo, GENERAL);
    await revokeRole('u-theo', 'social', 'participant');
    expect(await nextSend(theo, GENERAL)).toBe('refused');
    await grantRole('u-theo', 'social', 'participant');
    expect(await nextSend(theo, GENERAL)).toBe('admitted');
  });

  it('identity setGrants (the admin matrix) on a grant other than the source role', async () => {
    const theo = await connectAs('u-theo', 'orgiq');
    await warm(theo, GENERAL);
    await setGrants('u-theo', { orgiq: ['member'], social: [] });
    expect(await nextSend(theo, GENERAL)).toBe('refused');
    await setGrants('u-theo', { orgiq: ['member'], social: ['participant'] });
    expect(await nextSend(theo, GENERAL)).toBe('admitted');
  });

  // The epoch is also checked by principal revalidation on every hit (V4); the
  // seam's call additionally drops the entries at once.
  it('identity bumpSessionEpoch (switch, revoke-others)', async () => {
    const sana = await connectAs('u-sana', 'social');
    await warm(sana, GENERAL);
    await bumpSessionEpoch('u-sana');
    expect(await nextSend(sana, GENERAL)).toBe('refused');
  });

  it('Social channel membership (leave, rejoin)', async () => {
    const sana = await connectAs('u-sana', 'social');
    await warm(sana, GENERAL);
    const member = await socialChat().membershipStore.getMember(GENERAL, 'u-sana');
    await socialChat().membershipStore.putMember({ ...member!, removedAt: new Date().toISOString() });
    expect(await nextSend(sana, GENERAL)).toBe('refused');
    await socialChat().membershipStore.putMember({ ...member!, removedAt: null });
    expect(await nextSend(sana, GENERAL)).toBe('admitted');
  });

  it('Social team roster (removeTeamMember, addTeamMember)', async () => {
    const owner = { sub: 'u-mira', name: 'Mira', role: 'community-admin', tenant: 'social', grants: { social: ['community-admin'] },
      iat: Math.floor(Date.now() / 1000) } as Session;
    const team = await createTeam(owner, { name: 'Verdict cache roster', visibility: 'private' });
    await addTeamMember(owner, team.teamId, 'u-sana', 'Sana');
    const general = team.channels.find(c => c.name === 'General')!;
    const channel = `social:team:${team.slug}:${general.slug.slice(team.slug.length + 1)}`;
    const sana = await connectAs('u-sana', 'social');
    await warm(sana, channel);
    await removeTeamMember(owner, team.teamId, 'u-sana');
    expect(await nextSend(sana, channel)).toBe('refused');
    await addTeamMember(owner, team.teamId, 'u-sana', 'Sana');
    expect(await nextSend(sana, channel)).toBe('admitted');
  });

  it('Cedar policy edit (clearAuthzCache after Create/Update/DeletePolicy)', async () => {
    const sana = await connectAs('u-sana', 'social');
    await warm(sana, GENERAL);
    policyDenies.add('participant:PostMessage'); clearAuthzCache();
    expect(await nextSend(sana, GENERAL)).toBe('refused');
    policyDenies.clear(); clearAuthzCache();
    expect(await nextSend(sana, GENERAL)).toBe('admitted');
  });

  it('access request read rule (casRequest moves the request out of the reader\'s reach and back)', async () => {
    const id = 'req-0001', channel = `access:req:${id}`;
    const original = findRequest(id)!;
    expect(await requestReadableBy(id, 'u-omar')).toBe(true); // Rhea's manager
    const omar = await connectAs('u-omar', 'access');
    await warm(omar, channel);
    expect(casRequest(id, { from: [original.status] }, { requesterId: 'u-nora', beneficiaryId: 'u-nora' }, [], 'u-priya', new Date().toISOString())).not.toBeNull();
    expect(await requestReadableBy(id, 'u-omar')).toBe(false);
    expect(await nextSend(omar, channel)).toBe('refused');
    casRequest(id, { from: [original.status] }, { requesterId: original.requesterId, beneficiaryId: original.beneficiaryId }, [], 'u-priya', new Date().toISOString());
    expect(await nextSend(omar, channel)).toBe('admitted');
  });

  it('assessment team page resource (deleteTeam)', async () => {
    const channel = 'assessment:team:TEAM-006';
    const asha = await connectAs('u-asha', 'assessment');
    await warm(asha, channel);
    expect(await deleteTeam('TEAM-006')).toBe(true);
    expect(await nextSend(asha, channel)).toBe('refused');
  });
});

describe('why every write must call the seam', () => {
  it('a removal written around the seam is still admitted from the cache, until the seam is told', async () => {
    const owner = { sub: 'u-mira', name: 'Mira', role: 'community-admin', tenant: 'social', grants: { social: ['community-admin'] },
      iat: Math.floor(Date.now() / 1000) } as Session;
    const team = await createTeam(owner, { name: 'Verdict cache control', visibility: 'private' });
    await addTeamMember(owner, team.teamId, 'u-sana', 'Sana');
    const general = team.channels.find(c => c.name === 'General')!;
    const channel = `social:team:${team.slug}:${general.slug.slice(team.slug.length + 1)}`;
    const sana = await connectAs('u-sana', 'social');
    await warm(sana, channel);
    const rows = socialTeamMembersFixture.rows();
    rows.splice(rows.findIndex(m => m.teamId === team.teamId && m.userId === 'u-sana'), 1);
    expect(await nextSend(sana, channel)).toBe('admitted'); // stale: no event
    invalidateForUser('u-sana', 'test');
    expect(await nextSend(sana, channel)).toBe('refused');
  });

  it('counts each invalidation it applied', () => {
    const before = authorityInvalidationStats();
    invalidateAll('test');
    expect(authorityInvalidationStats()).toMatchObject({ all: before.all + 1, bound: true, peers: false });
  });
});

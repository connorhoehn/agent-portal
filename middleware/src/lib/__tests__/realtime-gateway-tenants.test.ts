// The gateway's partition rule widened to the token's `tenants` claim
// (docs/social-tenant-design.md E5, §4.2 — lane E), over a real http.Server and
// raw `ws` clients with real realtime tokens, on the memory chat backend whose
// `social:` rows are the registered fixtures (MOCK_AURORA):
//   - an ORGIQ session holding a `social` grant (tokens carry `tenants:
//     ['orgiq', 'social']`) subscribes to social:ch:general as a member and
//     posts into it — the embedding case (an initiative page showing its
//     bound channel);
//   - the same user without the grant gets AUTHZ_CHANNEL_DENIED;
//   - `social:team:<team>:<channel>` admits the team's members only;
//   - `assessment:doc:*` is still refused for a social-only session;
//   - the DM rule is unchanged under a granted partition;
//   - on the platform-api backend, team membership is the BFF's in-process
//     copy of what platform-api answered (fail closed for an unseen team).

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'moderator', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'community-admin', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
] }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, channelGuard, lobbyGuard, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { isSocialTeamMember, listTeams, getTeam, resetSocialTeamMirror } from '../../providers/social-platform.js';

const SECRET = 'test-realtime-secret';
const GENERAL = 'social:ch:general';
const TEAM_EVENTS = 'social:team:community:events';
const MOD_GENERAL = 'social:team:moderation:general';
const DOC = 'assessment:doc:doc-1';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

function session(sub: string, name: string, tenant: string, grants: Record<string, string[]>): Session {
  return { sub, name, role: grants[tenant]?.[0] ?? 'member', tenant, grants, iat: Math.floor(Date.now() / 1000) } as Session;
}

async function connect(s: Session): Promise<Open> {
  const { token } = await signRealtimeToken(realtimeClaims(s), SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some((f) => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
        else if (Date.now() - start > 2_000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const denied = (o: Open) => o.frames.filter((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED');
const chatMessages = (o: Open, channel: string) => o.frames
  .filter((f) => f.type === 'chat' && f.action === 'message' && (f['message'] as { channel?: string } | undefined)?.channel === channel)
  .map((f) => f['message'] as { message: string; userId?: string });

describe('the partition rule reads the token\'s tenants (E5)', () => {
  it('admits a social:ch: member standing in orgiq when the token lists social, and refuses without the grant', () => {
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'] }, GENERAL)).toBe(true);
    // baseChannel (0.107) unwraps `chat:` only around a DM lobby; the chat
    // service uses the bare name, so a `chat:`-prefixed channel name fails closed.
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'] }, `chat:${GENERAL}`)).toBe(false);
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq', tenants: ['orgiq'] }, GENERAL)).toBe(false);
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq' }, GENERAL)).toBe(false);
    // The grant opens the partition, never membership: not a member of #design-reviews.
    expect(channelGuard({ userId: 'u-sana', org: 'orgiq', tenants: ['orgiq', 'social'] }, 'social:ch:design-reviews')).toBe(false);
  });

  it('a channel\'s CALL lobby asks the same membership as its chat (2026-09-30)', () => {
    // #general member: the lobby opens; #design-reviews non-member: refused,
    // even though the social grant admits the partition.
    expect(lobbyGuard({ userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'] }, GENERAL)).toBe(true);
    expect(lobbyGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'social:ch:design-reviews')).toBe(false);
    expect(lobbyGuard({ userId: 'u-sana', org: 'orgiq', tenants: ['orgiq'] }, GENERAL)).toBe(false);
  });

  it('refuses assessment:doc:* to a social-only session, and a tenant it merely names', () => {
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, DOC)).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, `presence:${DOC}`)).toBe(false);
    expect(lobbyGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'assessment:room:x')).toBe(false);
    // The admin, who holds every grant, reaches it — the cross-tenant role.
    expect(channelGuard({ userId: 'u-admin', org: 'orgiq', tenants: ['orgiq', 'assessment', 'social', 'pipelines'] }, DOC)).toBe(true);
  });

  it('keeps the DM rule under a granted partition, and refuses names with no partition', () => {
    const theo = { userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'] };
    expect(lobbyGuard(theo, 'social:dm:u-lena:u-theo')).toBe(true);
    expect(lobbyGuard(theo, 'social:dm:u-lena:u-sana')).toBe(false);
    expect(lobbyGuard(theo, 'orgiq:dm:u-lena:u-sana')).toBe(false);
    expect(lobbyGuard(theo, 'no-partition')).toBe(false);
    expect(lobbyGuard(theo, ':x')).toBe(false);
    expect(lobbyGuard(theo, 'social:')).toBe(false);
    expect(lobbyGuard({ org: 'orgiq', tenants: ['orgiq'] }, 'orgiq:initiative:p-soc2')).toBe(false);
  });

  it('admits social:team:<team>:* to the team\'s members only', () => {
    // community: u-mira (owner), u-lena, u-sana. moderation: u-lena, u-mira.
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, TEAM_EVENTS)).toBe(true);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, `presence:${TEAM_EVENTS}`)).toBe(true);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, MOD_GENERAL)).toBe(false);
    expect(channelGuard({ userId: 'u-lena', org: 'social', tenants: ['social'] }, MOD_GENERAL)).toBe(true);
    // A social participant who is not on the team.
    expect(channelGuard({ userId: 'u-theo', org: 'orgiq', tenants: ['orgiq', 'social'] }, TEAM_EVENTS)).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'social:team:no-such-team:general')).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'social:team:community')).toBe(false);
  });
});

describe('over the socket', () => {
  it('an orgiq session holding a social grant joins social:ch:general as a member and posts; its message lands', async () => {
    const theo = await connect(session('u-theo', 'Theo Chang', 'orgiq', { orgiq: ['member'], social: ['participant'] }));
    const mira = await connect(session('u-mira', 'Mira Okafor', 'social', { social: ['community-admin'] }));
    try {
      send(mira, { service: 'chat', action: 'join', channel: GENERAL });
      send(theo, { service: 'chat', action: 'join', channel: GENERAL });
      await settle();
      send(theo, { service: 'chat', action: 'send', channel: GENERAL, message: 'posted from the initiative page' });
      await until(() => chatMessages(mira, GENERAL).some((m) => m.message === 'posted from the initiative page'));
      expect(denied(theo)).toEqual([]);
      expect(socialChannelMessagesFixture.rows().some((m) => m.channel === GENERAL && m.userId === 'u-theo')).toBe(true);
    } finally { for (const o of [theo, mira]) o.ws.close(); }
  });

  it('a user with a forged social token grant and no current directory grant gets no history', async () => {
    const theo = await connect(session('u-hr', 'Helen Desai', 'orgiq', { orgiq: ['hr-admin'], social: ['participant'] }));
    try {
      send(theo, { service: 'chat', action: 'join', channel: GENERAL });
      send(theo, { service: 'chat', action: 'history', channel: GENERAL, limit: 10 });
      await until(() => theo.frames.filter(frame => frame.type === 'error').length >= 2);
      expect(denied(theo).length).toBeGreaterThanOrEqual(1);
      expect(denied(theo)[0]).toMatchObject({ service: 'chat', channel: GENERAL });
      expect(theo.frames.some((f) => f.type === 'chat' && (f.action === 'history' || f.action === 'message'))).toBe(false);
    } finally { theo.ws.close(); }
  });

  it('a social participant who is not on the team is refused its channel; a member is not', async () => {
    const theo = await connect(session('u-theo', 'Theo Chang', 'social', { orgiq: ['member'], social: ['participant'] }));
    const sana = await connect(session('u-sana', 'Sana Iqbal', 'social', { social: ['participant'] }));
    try {
      send(theo, { service: 'chat', action: 'send', channel: TEAM_EVENTS, message: 'not on the team' });
      send(theo, { service: 'presence', action: 'subscribe', channel: TEAM_EVENTS });
      send(sana, { service: 'presence', action: 'subscribe', channel: TEAM_EVENTS });
      await until(() => denied(theo).length >= 2);
      await settle();
      for (const f of denied(theo)) expect(f['channel']).toBe(TEAM_EVENTS);
      expect(denied(sana)).toEqual([]);
    } finally { for (const o of [theo, sana]) o.ws.close(); }
  });

  it('an assessment:doc:* channel is still refused for a social-only session', async () => {
    const sana = await connect(session('u-sana', 'Sana Iqbal', 'social', { social: ['participant'] }));
    try {
      send(sana, { service: 'chat', action: 'join', channel: DOC });
      send(sana, { service: 'presence', action: 'subscribe', channel: DOC });
      await until(() => denied(sana).length >= 2);
      for (const f of denied(sana)) expect(f['channel']).toBe(DOC);
    } finally { sana.ws.close(); }
  });
});

describe('team membership on the platform-api backend (the in-process copy)', () => {
  const prevUrl = process.env['SOCIAL_PLATFORM_INTERNAL_URL'];
  const realFetch = global.fetch;
  beforeEach(() => { process.env['SOCIAL_PLATFORM_INTERNAL_URL'] = 'http://platform.invalid'; resetSocialTeamMirror(); });
  afterEach(() => {
    global.fetch = realFetch;
    if (prevUrl === undefined) delete process.env['SOCIAL_PLATFORM_INTERNAL_URL'];
    else process.env['SOCIAL_PLATFORM_INTERNAL_URL'] = prevUrl;
    resetSocialTeamMirror();
  });
  const reply = (body: unknown) => jest.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const team = { orgId: 'social', teamId: 't-1', slug: 'crew', name: 'Crew', visibility: 'org', createdBy: 'u-mira', createdAt: 'x', updatedAt: 'x', state: 'active' };

  it('an unseen team admits nobody; listing your teams records you; a detail replaces the roster', async () => {
    expect(isSocialTeamMember('crew', 'u-sana')).toBe(false);
    global.fetch = reply({ teams: [{ ...team, role: 'member' }, { ...team, teamId: 't-2', slug: 'lurkers' }] });
    await listTeams(session('u-sana', 'Sana Iqbal', 'social', { social: ['participant'] }));
    expect(isSocialTeamMember('crew', 'u-sana')).toBe(true);
    expect(isSocialTeamMember('lurkers', 'u-sana')).toBe(false); // listed without a role: not a member
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'social:team:crew:general')).toBe(true);
    global.fetch = reply({ team, role: 'owner', members: [{ teamId: 't-1', userId: 'u-mira', role: 'owner', addedAt: 'x', addedBy: 'u-mira' }] });
    await getTeam(session('u-mira', 'Mira Okafor', 'social', { social: ['community-admin'] }), 't-1');
    expect(isSocialTeamMember('crew', 'u-mira')).toBe(true);
    expect(isSocialTeamMember('crew', 'u-sana')).toBe(false); // removed upstream since
  });
});

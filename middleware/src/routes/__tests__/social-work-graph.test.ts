// /api/social/work-graph (routes/social-work-graph.ts) over the real social mock fixtures — the social
// counterpart of assessment-work-graph.test.ts (docs/activity-graph-migration.md §10).
//
// Pinned:
//   * honesty — every node is one row the /api/social and /api/chat routes serve to the same viewer
//     (channels, DMs, team channels, rooms, calls, recordings, decks, own flow runs), the thread node
//     carries a COUNT never a message's text, and every edge is a documented relation
//     (thread→conversation discussed, call→conversation runs-in, recording→call derived-from,
//     deck→conversation derived-from, run→conversation operates-on, team→channel works-on);
//   * the membership matrix, decided fresh per request: a viewer who is not in a private channel, a DM or a
//     private room receives none of its nodes, its title, its calls, its decks, its runs — and the page
//     answers the SAME 404 as an absent conversation; leaving a channel ends it; a history floor hides what
//     predates it; other people's flow runs are never drawn;
//   * the gates: no ViewSocial gets nothing, a failed decision withholds and says
//     `authorization-unavailable`, another tenant 403, anonymous 401, a stale epoch 401, a forged name 404.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ ...jest.requireActual('../../lib/authz.js'), isAllowed: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { socialWorkGraphRouter } from '../social-work-graph.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';
import { workDayWindow, validateWorkGraphSnapshotV2 } from '@connorhoehn/realtime-modules/work-graph';
import { clock, fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { stopWorkGraphLiveHints } from '../../lib/work-graph/live.js';
import { observeCall, observeCallEnded, resetObservedCalls } from '../../lib/work-graph/social-events.js';
import { flowRunStore } from '../../lib/flow-runs/index.js';
import { socialDeckStore } from '../../providers/social-decks.js';
import { socialChat } from '../../lib/social-chat.js';
import { socialCallLogFixture } from '../../mock/social-platform.js';

const SOCIAL = ['ViewSocial', 'PostMessage', 'StartCall'];
const POLICY: Record<string, string[]> = { participant: SOCIAL, moderator: SOCIAL, 'community-admin': SOCIAL, member: [] };
const WHO: Record<string, { sub: string; role: string; tenant: string }> = {
  sana: { sub: 'u-sana', role: 'participant', tenant: 'social' },
  lena: { sub: 'u-lena', role: 'moderator', tenant: 'social' },
  mira: { sub: 'u-mira', role: 'community-admin', tenant: 'social' },
  blind: { sub: 'u-blind', role: 'member', tenant: 'social' },   // a social grant whose role holds no Social action
  theo: { sub: 'u-theo', role: 'member', tenant: 'orgiq' },
};
const TZ = 'UTC';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
const DM = 'social:dm:u-lena:u-sana';
const GENERAL = 'social:ch:general';
const MODS = 'social:ch:moderators';
let users: Map<string, UserInfo>;
let sessions: Map<string, Session>;
let app: express.Express;
let cedarDown = false;
const v2Query = () => { const w = workDayWindow(today(), TZ); return { day: today(), timezone: TZ, schemaVersion: '2', windowStart: w.start, windowEnd: w.end, mode: 'live' }; };
const graph = (who: string | null, path = '/api/social/work-graph/workspace/graph', query: Record<string, string> = v2Query()) => {
  const r = request(app).get(path).query(query);
  return who ? r.set('x-user', who) : r;
};
const page = (who: string | null, conversation: string) => graph(who, `/api/social/work-graph/conversations/${encodeURIComponent(conversation)}/graph`);
const ENCODED_DM = encodeURIComponent(DM);
type Body = { nodes: Array<{ id: string; kind: string; title: string; status: string; capabilities: string[] }>; edges: Array<{ fromId: string; toId: string; relation: string }>;
  details: Array<{ nodeId: string; lines?: string[]; participants?: Array<{ label: string }>; footer?: { label: string } }>; sources: Array<{ source: string; health: string }> };
const ids = (body: Body, prefix: string) => body.nodes.filter(n => n.id.startsWith(prefix)).map(n => n.id).sort();
const rel = (body: Body) => body.edges.map(e => `${e.fromId}>${e.toId}:${e.relation}`);
const node = (body: Body, id: string) => body.nodes.find(n => n.id === id);

/** A message stamped now (inside today's window), as the chat service would store it. */
async function post(channel: string, userId: string, name: string, text: string, id = `t-${Math.random().toString(36).slice(2)}`): Promise<void> {
  await socialChat().chatStore.putMessage({ id, clientId: 'c', userId, channel, message: text, timestamp: clock.nowIso(), metadata: { displayName: name } } as never);
}

beforeAll(() => stopWorkGraphLiveHints());
afterAll(() => unfreezeClock());
// Frozen at UTC midnight so every fixture message (stamped hoursAgo) sits in the previous UTC day at any wall-clock hour.
beforeEach(async () => {
  unfreezeClock(); freezeClock('2026-10-06T00:00:00.000Z');
  jest.clearAllMocks(); cedarDown = false; fixtureRegistry.resetAll(); resetObservedCalls();
  users = new Map(Object.entries(WHO).map(([key, w]): [string, UserInfo] => [key, {
    id: w.sub, displayName: key, email: null, personId: null, epoch: 1, grants: { [w.tenant]: [w.role] },
  }]));
  const bySub = new Map([...users.values()].map(u => [u.id, u]));
  sessions = new Map(Object.entries(WHO).map(([key, w]) => [key, {
    sub: w.sub, tenant: w.tenant, role: w.role, epoch: 1, iat: 1, grants: structuredClone(users.get(key)!.grants),
  } as Session]));
  jest.mocked(getUser).mockImplementation(async id => structuredClone(bySub.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => {
    if (cedarDown) throw new Error('AVP unreachable');
    return (POLICY[p.role] ?? []).includes(action);
  });
  app = express();
  app.use((req, _res, next) => { const s = sessions.get(String(req.headers['x-user'])); if (s) req.session = s; next(); });
  app.use('/api/social/work-graph', socialWorkGraphRouter); app.use(errorHandler);
});

describe('honesty against the social REST sources', () => {
  it('draws the viewer\'s conversations with a day\'s messages as a count, with documented edges, and never a message\'s text', async () => {
    await post(GENERAL, 'u-theo', 'Theo Chang', 'a secret sentence nobody should read in the graph');
    await post(GENERAL, 'u-mira', 'Mira Okafor', 'another one');
    await post(DM, 'u-lena', 'Lena Brandt', 'dm text');
    const res = await graph('sana');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(validateWorkGraphSnapshotV2(res.body).ok).toBe(true);
    expect(res.body.scope.personId).toBe('workspace:social');
    expect(res.body.scope.policyRevision).toMatch(/^social\./);
    const body = res.body as Body;
    expect(ids(body, 'sconv:')).toEqual(expect.arrayContaining([`sconv:${GENERAL}`, `sconv:${DM}`]));
    expect(node(body, `sconv:${GENERAL}`)!.kind).toBe('project');
    expect(node(body, `sthread:${GENERAL}`)!.kind).toBe('conversation');
    const general = body.details.find(d => d.nodeId === `sthread:${GENERAL}`)!;
    expect(general.lines).toContain('Messages · 2');
    expect(general.participants!.map(p => p.label).sort()).toEqual(['Mira Okafor', 'Theo Chang']);
    expect(rel(body)).toContain(`sthread:${GENERAL}>sconv:${GENERAL}:discussed`);
    expect(rel(body)).toContain(`sthread:${DM}>sconv:${DM}:discussed`);
    // The graph names a conversation in a footer a person can read (its title, never its channel key); it never carries message text.
    expect(body.details.find(d => d.nodeId === `sconv:${GENERAL}`)!.footer!.label).toBe('Conversation · #general');
    expect(JSON.stringify(res.body)).not.toMatch(/secret sentence|another one|dm text/);
    // Every conversation is a project anchor; every node sits inside an effort.
    const inEffort = new Set((res.body.efforts as Array<{ nodeIds: string[] }>).flatMap(e => e.nodeIds));
    expect(body.nodes.filter(n => !inEffort.has(n.id))).toEqual([]);
    // Every drawn channel is one the REST list serves this viewer as joined.
    const listed = new Set(socialChat().membershipStore.activeMembers(GENERAL).map(m => m.userId));
    expect(listed.has('u-sana')).toBe(true);
  });

  it('a conversation page draws that conversation only: its calls, recordings, decks and runs, wired to it', async () => {
    const deck = await socialDeckStore.insertDeck({ id: 'sdeck-11111111-1111-4111-8111-111111111111', channel: DM, runId: null, title: 'DM recap', createdBy: 'u-lena', headRevisionId: null });
    const run = await flowRunStore.create({ tenant: 'social', kind: 'social.summarize', requestedBy: 'u-sana', scope: DM, input: {}, idPrefix: 'sum' });
    const res = await page('sana', DM);
    expect(res.status).toBe(200);
    expect(validateWorkGraphSnapshotV2(res.body).ok).toBe(true);
    expect(res.body.scope.personId).toBe(`conversation:${DM}`);
    const body = res.body as Body;
    expect(ids(body, 'sconv:')).toEqual([`sconv:${DM}`]);
    const edges = rel(body);
    // The fixture's DM call and its recording (Sana was in both).
    expect(edges).toContain(`scall:mock-call-dm-lena-sana>sconv:${DM}:runs-in`);
    expect(edges).toContain('srec:mock-rec-dm-lena-sana>scall:mock-call-dm-lena-sana:derived-from');
    expect(edges).toContain(`sdeck:${deck.id}>sconv:${DM}:derived-from`);
    expect(edges).toContain(`sflow:${run.id}>sconv:${DM}:operates-on`);
    expect(node(body, 'scall:mock-call-dm-lena-sana')!.kind).toBe('meeting');
    expect(node(body, 'srec:mock-rec-dm-lena-sana')!.kind).toBe('transcript');
    expect(node(body, `sdeck:${deck.id}`)!.kind).toBe('document');
    expect(node(body, `sflow:${run.id}`)!.kind).toBe('run');
    // Nothing of any other conversation.
    expect(body.nodes.some(n => n.id.includes('general') || n.id.includes('town-hall'))).toBe(false);
  });

  it('a room page draws its recordings; a team channel draws its team anchor with team→channel works-on', async () => {
    const room = await page('sana', 'social:room:town-hall');
    expect(room.status).toBe(200);
    expect(ids(room.body, 'srec:')).toEqual(['srec:mock-rec-town-hall-1', 'srec:mock-rec-town-hall-2']);
    const team = await page('sana', 'social:team:community:general');
    expect(team.status).toBe(200);
    expect(ids(team.body, 'steam:')).toEqual(['steam:mock-team-community']);
    expect(rel(team.body)).toContain('steam:mock-team-community>sconv:social:team:community:general:works-on');
  });

  it('live call state: ringing → running → ended arrive in the graph, only for someone who reads the lobby', async () => {
    observeCall({ callId: 'live-1', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 1 });
    let res = await page('sana', DM);
    expect(node(res.body, 'scall:live-1')).toMatchObject({ kind: 'meeting', status: 'waiting' });
    observeCall({ callId: 'live-1', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 2 });
    res = await page('sana', DM);
    expect(node(res.body, 'scall:live-1')).toMatchObject({ status: 'running', capabilities: ['join-meeting'] });
    // The last seat leaves while the library holds the call for a rejoin: over for the graph, back if someone returns.
    observeCall({ callId: 'live-1', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 0 });
    res = await page('sana', DM);
    expect(node(res.body, 'scall:live-1')).toMatchObject({ status: 'completed', capabilities: [] });
    observeCall({ callId: 'live-1', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 1 });
    res = await page('sana', DM);
    expect(node(res.body, 'scall:live-1')).toMatchObject({ status: 'running' });
    observeCallEnded('live-1');
    res = await page('sana', DM);
    expect(node(res.body, 'scall:live-1')).toMatchObject({ status: 'completed', capabilities: [] });
    // Mira is not in that DM: she gets neither the call nor the conversation.
    observeCall({ callId: 'live-2', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 2 });
    const mira = await graph('mira');
    expect(JSON.stringify(mira.body)).not.toMatch(/live-2|u-lena:u-sana/);
    expect((await page('mira', DM)).status).toBe(404);
  });
});

describe('a call the log keeps open', () => {
  const row = (callId: string, hoursAgo: number) => ({
    userId: 'u-sana', callId, direction: 'incoming' as const, callerId: 'u-lena', targetUserIds: ['u-sana'], lobbyName: DM, audioOnly: false,
    outcome: 'answered' as const, startedAt: clock.hoursAgo(hoursAgo), updatedAt: clock.hoursAgo(hoursAgo),
  });
  it('is running only when the call state store confirms it (or it is fresh enough for the log to lag); an old uncorroborated row is stale, not running', async () => {
    socialCallLogFixture.rows().push(row('old-open', 3), row('fresh-open', 0.01), row('confirmed-open', 4));
    observeCall({ callId: 'confirmed-open', lobbyName: DM, callerId: 'u-lena', targetUserIds: ['u-sana'], participants: 2 });
    const res = await page('sana', DM);
    expect(node(res.body, 'scall:old-open')).toMatchObject({ status: 'stale', capabilities: [] });
    expect(node(res.body, 'scall:fresh-open')).toMatchObject({ status: 'running' });
    expect(node(res.body, 'scall:confirmed-open')).toMatchObject({ status: 'running' });
  });
});

describe('the membership matrix', () => {
  it('a private channel the viewer is not in is never drawn, never named, and its page is the same 404 as an absent channel', async () => {
    await post(MODS, 'u-mira', 'Mira Okafor', 'mods only');
    const sana = await graph('sana');
    expect(sana.status).toBe(200);
    expect(JSON.stringify(sana.body)).not.toMatch(/moderators|mods only|Moderators|moderation/i);
    const hidden = await page('sana', MODS);
    const absent = await page('sana', 'social:ch:no-such-channel');
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(absent.body);
    // The members get it.
    const lena = await graph('lena');
    expect(ids(lena.body, 'sconv:')).toContain(`sconv:${MODS}`);
    expect((await page('lena', MODS)).status).toBe(200);
    // A public channel Sana has not joined is not hers to see here either (the chat admits members only).
    expect((await page('sana', 'social:ch:design-reviews')).status).toBe(404);
  });

  it('private rooms and a team the viewer is not in are withheld; their members see them', async () => {
    const sana = await graph('sana');
    expect(JSON.stringify(sana.body)).not.toMatch(/moderators-desk|Moderators desk|moderation/i);
    expect((await page('sana', 'social:room:moderators-desk')).status).toBe(404);
    expect((await page('sana', 'social:team:moderation:general')).status).toBe(404);
    expect((await page('lena', 'social:room:moderators-desk')).status).toBe(200);
    expect((await page('lena', 'social:team:moderation:general')).status).toBe(200);
  });

  it('a decision made now: leaving a channel ends it; a history floor hides what predates it', async () => {
    await post(GENERAL, 'u-mira', 'Mira Okafor', 'before the floor');
    let res = await graph('sana');
    expect(res.body.details.find((d: { nodeId: string }) => d.nodeId === `sthread:${GENERAL}`).lines).toContain('Messages · 1');
    const chat = socialChat();
    const row = (await chat.membershipStore.getMember(GENERAL, 'u-sana'))!;
    await chat.membershipStore.putMember({ ...row, historyFrom: new Date(clock.now().getTime() + 60_000).toISOString() });
    res = await graph('sana');
    expect(ids(res.body, `sthread:${GENERAL}`)).toEqual([]);
    await chat.membershipStore.putMember({ ...row, removedAt: clock.nowIso() });
    res = await graph('sana');
    expect(ids(res.body, 'sconv:')).not.toContain(`sconv:${GENERAL}`);
    expect((await page('sana', GENERAL)).status).toBe(404);
  });

  it('decks follow the source conversation; flow runs are requester-private', async () => {
    const deck = await socialDeckStore.insertDeck({ id: 'sdeck-22222222-2222-4222-8222-222222222222', channel: DM, runId: null, title: 'Lena\'s deck', createdBy: 'u-lena', headRevisionId: null });
    const mine = await flowRunStore.create({ tenant: 'social', kind: 'social.diagram', requestedBy: 'u-sana', scope: DM, input: {}, idPrefix: 'sdg' });
    const hers = await flowRunStore.create({ tenant: 'social', kind: 'social.summarize', requestedBy: 'u-lena', scope: DM, input: {}, idPrefix: 'sum' });
    const sana = await page('sana', DM);
    expect(ids(sana.body, 'sdeck:')).toContain(`sdeck:${deck.id}`);
    expect(ids(sana.body, 'sflow:')).toEqual([`sflow:${mine.id}`]);
    const lena = await page('lena', DM);
    expect(ids(lena.body, 'sflow:')).toEqual([`sflow:${hers.id}`]);
    // Mira holds a Social grant but is no member of the DM: nothing of it, anywhere.
    const mira = await graph('mira');
    expect(JSON.stringify(mira.body)).not.toContain(deck.id);
    expect(JSON.stringify(mira.body)).not.toContain(mine.id);
  });
});

describe('the gates', () => {
  it('a viewer without ViewSocial gets nothing; a conversation page is the uniform 404', async () => {
    const res = await graph('blind');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect((await page('blind', DM)).status).toBe(404);
  });

  it('a decision that cannot be made withholds the part and says authorization-unavailable', async () => {
    cedarDown = true;
    const res = await graph('sana');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect((res.body as Body).sources.find(s => s.source === 'conversation')!.health).toBe('authorization-unavailable');
  });

  it('another tenant 403, anonymous 401, a stale epoch 401, a forged or malformed name the uniform 404', async () => {
    expect((await graph('theo')).status).toBe(403);
    expect((await graph(null)).status).toBe(401);
    users.get('sana')!.epoch = 2;
    expect((await graph('sana')).status).toBe(401);
    users.get('sana')!.epoch = 1;
    for (const bad of ['social:ch:../x', 'orgiq:initiative:p-1', 'social:dm:', 'x']) expect((await page('sana', bad)).status).toBe(404);
    expect((await request(app).get('/api/social/work-graph/workspace/graph').query({ day: today() }).set('x-user', 'sana')).status).toBe(400);
    // The route as the portal calls it: the channel name URL-encoded in one segment.
    const direct = await request(app).get(`/api/social/work-graph/conversations/${ENCODED_DM}/graph`).query(v2Query()).set('x-user', 'sana');
    expect(direct.status).toBe(200);
    expect(direct.body.scope.personId).toBe(`conversation:${DM}`);
  });
});

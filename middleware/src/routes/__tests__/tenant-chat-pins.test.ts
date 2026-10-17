// Shared pins on tenant discussions (routes/chat-pins.ts `tenantPinAccess`):
// one adversarial matrix per family — orgiq:initiative|work, pipelines:run|def,
// assessment:doc. Every decision runs the gateway's real channel authority
// (authorizeConversationChat → admitChannel + channelGuard), the
// directory read fresh each time, and the chat store's membership rows,
// history floor and deletions. Social pins keep their own suite (chat-pins.test.ts).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { chatPinsRouter } from '../chat-pins.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import type { Session } from '../../lib/session.js';

const SECRET = 'tenant-pins-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});

const POLICY: Record<string, string[]> = {
  member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment'], 'assessment-reader': [],
  author: ['ViewPipelines'], participant: ['ViewSocial', 'PostMessage'],
};
let users: Map<string, UserInfo>;
let duringPolicy: ((action: string) => void) | null;
let hints: string[];
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: `${id} Directory`, email: null, personId: null, epoch: 1, grants });
const sessionFor = (sub: string, tenant: string, role: string): Session =>
  ({ sub, tenant, role, epoch: 1, iat: 1, grants: structuredClone(users.get(sub)?.grants ?? {}) }) as Session;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.headers['x-as'];
  if (typeof raw === 'string') { const [sub, tenant, role] = raw.split('/'); req.session = sessionFor(sub!, tenant!, role!); }
  next();
});
app.use('/api/chat', chatPinsRouter);
app.use(errorHandler);

const list = (as: string, channel: string) => request(app).get(`/api/chat/pins?channel=${encodeURIComponent(channel)}`).set('x-as', as);
const lookup = (as: string, channel: string, messageId: string) =>
  request(app).get(`/api/chat/message?channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(messageId)}`).set('x-as', as);
// What a forging client sends: another author, text, time, pinner, tenant and actor.
const forged = { text: 'FORGED TEXT', author: 'Forged Author', sentAt: '2001-01-01T00:00:00.000Z', pinnedBy: 'zed',
  tenant: 'social', org: 'social', act: { sub: 'admin' }, actor: 'admin' };
const pin = (as: string, channel: string, messageId: string) =>
  request(app).post('/api/chat/pins').set('x-as', as).send({ channel, messageId, ...forged });
const unpin = (as: string, channel: string, messageId: string) =>
  request(app).delete('/api/chat/pins').set('x-as', as).send({ channel, messageId, pinnedBy: 'zed' });
const msg = (channel: string, id: string, userId: string, text: string, timestamp: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, channel, clientId: `c-${userId}`, userId, message: text, timestamp, metadata: { displayName: 'Forged label' }, ...over });

// Per family: a conversation, a reader who may pin, a reader who may not pin
// (where the family distinguishes read from write), a same-tenant non-reader
// (where the family has a read action), and a cross-tenant caller holding a
// grant in the conversation's tenant but standing elsewhere.
const CASES = [
  { channel: 'orgiq:initiative:p-auth', writer: 'olu/orgiq/sme', readOnly: 'mia/orgiq/member', nonReader: null, crossTenant: 'ana/assessment/assessor' },
  { channel: 'orgiq:work:w-17', writer: 'olu/orgiq/sme', readOnly: 'mia/orgiq/member', nonReader: null, crossTenant: 'pat/pipelines/author' },
  { channel: 'assessment:doc:d-1', writer: 'ana/assessment/assessor', readOnly: null, nonReader: 'rae/assessment/assessment-reader', crossTenant: 'olu/orgiq/sme' },
  { channel: 'assessment:team:TEAM-001', writer: 'ana/assessment/assessor', readOnly: null, nonReader: 'rae/assessment/assessment-reader', crossTenant: 'olu/orgiq/sme' },
  { channel: 'pipelines:run:r-7', writer: 'pat/pipelines/author', readOnly: null, nonReader: null, crossTenant: 'ana/assessment/assessor' },
  { channel: 'pipelines:def:d-9', writer: 'pat/pipelines/author', readOnly: null, nonReader: null, crossTenant: 'olu/orgiq/sme' },
] as const;
const subOf = (as: string) => as.split('/')[0]!;
const stored = async (channel: string) => socialChat().pinsStore.list(channel);

beforeEach(async () => {
  duringPolicy = null; hints = [];
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }), null, channel => { hints.push(channel); });
  users = new Map([
    ['olu', user('olu', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
    ['mia', user('mia', { orgiq: ['member'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['rae', user('rae', { assessment: ['assessment-reader'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['zed', user('zed', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => {
    const ok = (POLICY[p.role] ?? []).includes(action);
    duringPolicy?.(action);
    return ok;
  });
  const store = socialChat().chatStore;
  for (const c of CASES) {
    await store.putMessage(msg(c.channel, 'm-1', 'zed', 'We ship the cutover on Thursday.', '2026-10-01T10:00:00.000Z'));
    await store.putMessage(msg(c.channel, 'm-2', 'olu', 'I will update the runbook first.', '2026-10-01T11:00:00.000Z'));
    await store.putMessage(msg(c.channel, 'm-del', 'zed', 'Deleted line with a secret.', '2026-10-01T12:00:00.000Z',
      { deletedAt: '2026-10-01T12:05:00.000Z' }));
  }
});
afterEach(() => { setSocialChatBackend(null); jest.clearAllMocks(); jest.restoreAllMocks(); });

describe('assessment:team forged channels', () => {
  it.each(['assessment:team:TEAM-NOPE-0', 'assessment:team:001', 'assessment:team:TEAM-001:x'])('%s is refused', async (channel) => {
    const res = await pin('ana/assessment/assessor', channel, 'm-1');
    expect([400, 403, 404]).toContain(res.status);
    expect((await list('ana/assessment/assessor', channel)).status).not.toBe(200);
    expect(await stored(channel)).toHaveLength(0);
  });
});

describe.each(CASES)('$channel', (c) => {
  it('a writer pins: excerpt, author and time come from the stored original; forged body fields are ignored', async () => {
    const res = await pin(c.writer, c.channel, 'm-1');
    expect(res.status).toBe(200);
    expect(res.body.pin).toMatchObject({ channelId: c.channel, messageId: 'm-1', pinnedBy: subOf(c.writer),
      author: 'zed Directory', sentAt: '2026-10-01T10:00:00.000Z' });
    expect(JSON.stringify(res.body)).not.toMatch(/FORGED|Forged/);
    expect(hints).toEqual([c.channel]);
    const listed = await list(c.writer, c.channel);
    expect(listed.status).toBe(200);
    expect(listed.body.pins).toEqual([expect.objectContaining({ messageId: 'm-1', author: 'zed Directory',
      preview: 'We ship the cutover on Thursday.', sentAt: '2026-10-01T10:00:00.000Z', pinnedBy: subOf(c.writer) })]);
    expect((await unpin(c.writer, c.channel, 'm-1')).status).toBe(200);
    expect(await stored(c.channel)).toHaveLength(0);
  });

  it('a reader without the family\'s publish authority sees pins but cannot pin or unpin', async () => {
    if (!c.readOnly) return;
    await pin(c.writer, c.channel, 'm-1');
    expect((await list(c.readOnly, c.channel)).body.pins).toHaveLength(1);
    expect((await lookup(c.readOnly, c.channel, 'm-1')).status).toBe(200);
    expect((await pin(c.readOnly, c.channel, 'm-2')).status).toBe(403);
    expect((await unpin(c.readOnly, c.channel, 'm-1')).status).toBe(403);
    expect((await stored(c.channel)).map(p => p.messageId)).toEqual(['m-1']);
  });

  it('a non-reader is denied: by policy where the family has one, and by the chat store\'s membership rows', async () => {
    await pin(c.writer, c.channel, 'm-1');
    if (c.nonReader) {
      expect((await list(c.nonReader, c.channel)).status).toBe(403);
      expect((await pin(c.nonReader, c.channel, 'm-2')).status).toBe(403);
      expect((await lookup(c.nonReader, c.channel, 'm-1')).status).toBe(403);
    }
    // Explicit conversation rows close it to everyone not listed.
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: 'zed', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' } as never);
    expect((await list(c.writer, c.channel)).status).toBe(403);
    expect((await pin(c.writer, c.channel, 'm-2')).status).toBe(403);
    expect((await unpin(c.writer, c.channel, 'm-1')).status).toBe(403);
    expect((await stored(c.channel)).map(p => p.messageId)).toEqual(['m-1']);
  });

  it('a cross-tenant caller is refused even holding a grant in the conversation\'s tenant', async () => {
    await pin(c.writer, c.channel, 'm-1');
    expect((await list(c.crossTenant, c.channel)).status).toBe(403);
    expect((await lookup(c.crossTenant, c.channel, 'm-1')).status).toBe(403);
    expect((await pin(c.crossTenant, c.channel, 'm-2')).status).toBe(403);
    expect((await unpin(c.crossTenant, c.channel, 'm-1')).status).toBe(403);
    expect((await stored(c.channel)).map(p => p.messageId)).toEqual(['m-1']);
  });

  it('deleted originals cannot be pinned and vanish from the list; a pin never carries a second copy', async () => {
    expect((await pin(c.writer, c.channel, 'm-del')).status).toBe(404);
    expect((await lookup(c.writer, c.channel, 'm-del')).status).toBe(404);
    expect((await pin(c.writer, c.channel, 'm-missing')).status).toBe(404);
    await pin(c.writer, c.channel, 'm-2');
    await socialChat().chatStore.updateMessage(c.channel, 'm-2', { message: '', metadata: { deleted: true }, deletedAt: '2026-10-02T00:00:00.000Z' });
    const listed = await list(c.writer, c.channel);
    expect(listed.body.pins).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain('runbook');
  });

  it('honours the reader\'s history floor for pinning, listing and Jump', async () => {
    await pin(c.writer, c.channel, 'm-1');
    const sub = subOf(c.writer);
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: sub, role: 'member',
      joinedAt: '2026-10-01T10:30:00.000Z', historyFrom: '2026-10-01T10:30:00.000Z' } as never);
    expect((await list(c.writer, c.channel)).body.pins).toEqual([]);
    expect((await lookup(c.writer, c.channel, 'm-1')).status).toBe(404);
    expect((await pin(c.writer, c.channel, 'm-1')).status).toBe(404);
    expect((await lookup(c.writer, c.channel, 'm-2')).body.message).toMatchObject({ id: 'm-2' });
  });

  it('a revocation during the policy decision, the membership read or the message lookup denies and stores nothing', async () => {
    const sub = subOf(c.writer);
    // Every family's publish authority is a Cedar action, so a policy call to interleave exists.
    duringPolicy = () => { users.get(sub)!.epoch = 2; };
    expect((await pin(c.writer, c.channel, 'm-1')).status).toBe(403);
    duringPolicy = null; users.get(sub)!.epoch = 1;
    const members = socialChat().membershipStore;
    const listMembers = members.listMembers.bind(members);
    const spy = jest.spyOn(members, 'listMembers').mockImplementation(async (...args) => { users.get(sub)!.epoch = 2; return listMembers(...args); });
    expect((await pin(c.writer, c.channel, 'm-1')).status).toBe(403);
    // The bump outlived that call, so this session is stale before the next one starts: a 401, not a refusal.
    expect((await list(c.writer, c.channel)).status).toBe(401);
    spy.mockRestore(); users.get(sub)!.epoch = 1;
    const store = socialChat().chatStore;
    const get = store.getMessage!.bind(store);
    const lookupSpy = jest.spyOn(store, 'getMessage').mockImplementation(async (...args) => { users.get(sub)!.grants = {}; return get(...args); });
    expect((await pin(c.writer, c.channel, 'm-1')).status).toBe(403);
    expect(await stored(c.channel)).toHaveLength(0);
    expect(hints).toEqual([]);
    lookupSpy.mockRestore();
  });

  it('the realtime bearer token is checked against the directory: current epoch, active tenant', async () => {
    const [sub, tenant, role] = c.writer.split('/') as [string, Session['tenant'], string];
    const bearer = async (over: Partial<Session> = {}) => (await signRealtimeToken(realtimeClaims({ ...sessionFor(sub, tenant, role), ...over }), SECRET)).token;
    const ok = await request(app).post('/api/chat/pins').set('Authorization', `Bearer ${await bearer()}`).send({ channel: c.channel, messageId: 'm-1', ...forged });
    expect(ok.status).toBe(200);
    expect(ok.body.pin.pinnedBy).toBe(sub);
    const stale = await request(app).get(`/api/chat/pins?channel=${encodeURIComponent(c.channel)}`).set('Authorization', `Bearer ${await bearer({ epoch: 0 })}`);
    // A stale epoch is a session to renew (401), not a conversation the reader may not see.
    expect(stale.status).toBe(401);
    // A token minted in another tenant cannot reach this conversation, whatever its tenants claim says.
    const [xsub, xtenant, xrole] = c.crossTenant.split('/') as [string, Session['tenant'], string];
    const cross = (await signRealtimeToken(realtimeClaims(sessionFor(xsub, xtenant, xrole)), SECRET)).token;
    expect((await request(app).get(`/api/chat/pins?channel=${encodeURIComponent(c.channel)}`).set('Authorization', `Bearer ${cross}`)).status).toBe(403);
    expect((await request(app).get(`/api/chat/pins?channel=${encodeURIComponent(c.channel)}`).set('Authorization', 'Bearer not-a-token')).status).toBe(401);
  });
});

describe('the tenant pin surface', () => {
  it('refuses anonymous callers and every family that is not a pinnable discussion', async () => {
    expect((await request(app).get('/api/chat/pins?channel=orgiq%3Ainitiative%3Ap-auth')).status).toBe(401);
    for (const channel of ['orgiq:session:s-1', 'orgiq:invoke', 'orgiq:deck:d1', 'assessment:knowledge:x', 'orgiq:lobby',
      'pins:orgiq:initiative:p-auth', 'presence:orgiq:initiative:p-auth', 'orgiq:nope:1', 'orgiq:dm:a:b']) {
      expect((await list('olu/orgiq/sme', channel)).status).toBe(400);
      expect((await pin('olu/orgiq/sme', channel, 'm-1')).status).toBe(400);
    }
    // A huddle is pinnable, but only by a current seat of that call (call-chat-gateway.test.ts).
    expect((await list('olu/orgiq/sme', 'orgiq:huddle:c-1')).status).toBe(403);
    expect((await pin('olu/orgiq/sme', 'orgiq:huddle:c-1', 'm-1')).status).toBe(403);
  });

  it('a pin on one conversation is not visible through another', async () => {
    await pin('olu/orgiq/sme', 'orgiq:initiative:p-auth', 'm-1');
    expect((await list('olu/orgiq/sme', 'orgiq:work:w-17')).body.pins).toEqual([]);
    expect((await list('olu/assessment/assessor', 'assessment:doc:d-1')).body.pins).toEqual([]);
  });
});

// 2026-10-07: an admin's work-item pane showed "Pinned messages are
// unavailable: … 403" while the same reader's comments read fine. The family
// gate admits admin and org-leader; the 403 was a stale-epoch session folded
// into a refusal. A current session reads; a stale one is a 401, never a 403;
// a reader with no authority on the thread is still refused.
describe('orgiq:work pins: admin and org-leader read, outsiders stay out', () => {
  const channel = 'orgiq:work:wi-obs-e1-b5';
  beforeEach(async () => {
    users.set('op', user('op', { orgiq: ['admin'], assessment: ['admin'], social: ['admin'], pipelines: ['admin'] }));
    users.set('vee', user('vee', { orgiq: ['org-leader', 'member'], social: ['participant'] }));
    users.set('sol', user('sol', { social: ['participant'] }));
    await socialChat().chatStore.putMessage(msg(channel, 'm-1', 'zed', 'Dashboards ship first.', '2026-10-01T10:00:00.000Z'));
    expect((await pin('olu/orgiq/sme', channel, 'm-1')).status).toBe(200);
  });

  it.each(['op/orgiq/admin', 'vee/orgiq/org-leader'])('%s lists the thread\'s pins and opens the original', async (as) => {
    const res = await list(as, channel);
    expect(res.status).toBe(200);
    expect(res.body.pins).toEqual([expect.objectContaining({ messageId: 'm-1' })]);
    expect((await lookup(as, channel, 'm-1')).status).toBe(200);
  });

  it('a Social-only user (no orgiq grant) is still refused with 403', async () => {
    expect((await list('sol/social/participant', channel)).status).toBe(403);
    expect((await lookup('sol/social/participant', channel, 'm-1')).status).toBe(403);
  });

  it('an orgiq reader standing in another tenant is still refused with 403', async () => {
    expect((await list('ana/assessment/assessor', channel)).status).toBe(403);
  });

  it('a stale-epoch admin session answers 401 (sign in again), not 403', async () => {
    users.set('op', { ...users.get('op')!, epoch: 2 });
    const res = await list('op/orgiq/admin', channel);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/no longer current/);
  });
});

// `/summarize` beyond Social (routes/conversation-summarize.ts): one adversarial
// matrix per tenant conversation family, plus huddle chat. Each case runs
// against the gateway's real channel authority (authorizeLiveGatewayChannel +
// channelGuard), the directory read fresh on every decision, the chat store's
// membership rows/history floor/deletions, and the durable flow-run fixture.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { InMemoryChatStore, type ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { baseChannel, type RealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { conversationSummarizeRouter, pendingConversationSummaries } from '../conversation-summarize.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { agentcore } from '../../providers/index.js';
import { config } from '../../config.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { flowRunChannel, flowRunStore, parseFlowRunChannel } from '../../lib/flow-runs/index.js';
import { authorizeLiveGatewayChannel } from '../../lib/live-principal.js';
import { channelGuard, lobbyGuard } from '../../lib/realtime-gateway.js';
import { CallChatRuntime, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle, type RecoverableCallStateStore } from '../../lib/call-pages.js';
import type { Session } from '../../lib/session.js';

const POLICY: Record<string, string[]> = {
  member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment'], 'assessment-reader': [],
  author: ['ViewPipelines'], participant: ['ViewSocial', 'PostMessage'],
};
let users: Map<string, UserInfo>;
let duringPolicy: ((action: string) => void) | null;
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
app.use('/api/conversations/summarize', conversationSummarizeRouter);
app.use(errorHandler);

const settle = async (): Promise<void> => { await Promise.all([...pendingConversationSummaries]); };
const run = (as: string, channel: string, text = '') => request(app).post('/api/conversations/summarize/run').set('x-as', as).send({ channel, text });
const status = (as: string, id: string) => request(app).get(`/api/conversations/summarize/runs/${id}`).set('x-as', as);
const post = (as: string, id: string) => request(app).post(`/api/conversations/summarize/runs/${id}/post`).set('x-as', as);
const msg = (channel: string, id: string, userId: string, text: string, timestamp: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, channel, clientId: `c-${userId}`, userId, message: text, timestamp, metadata: { displayName: 'Forged label' }, ...over });

// Per tenant: a conversation, a reader who may post, a reader who may not
// post (where the family distinguishes), a same-tenant non-reader, and a
// cross-tenant caller holding a grant there but standing elsewhere.
const CASES = [
  { tenant: 'orgiq', prefix: 'osm', channel: 'orgiq:initiative:p-auth', reader: 'olu/orgiq/sme', readOnly: 'mia/orgiq/member',
    nonReader: null, crossTenant: 'ana/assessment/assessor' },
  { tenant: 'orgiq', prefix: 'osm', channel: 'orgiq:session:s-42', reader: 'olu/orgiq/sme', readOnly: null,
    nonReader: null, crossTenant: 'pat/pipelines/author' },
  { tenant: 'assessment', prefix: 'asm', channel: 'assessment:doc:d-1', reader: 'ana/assessment/assessor', readOnly: null,
    nonReader: 'rae/assessment/assessment-reader', crossTenant: 'olu/orgiq/sme' },
  { tenant: 'pipelines', prefix: 'psm', channel: 'pipelines:run:r-7', reader: 'pat/pipelines/author', readOnly: null,
    nonReader: null, crossTenant: 'ana/assessment/assessor' },
  { tenant: 'pipelines', prefix: 'psm', channel: 'pipelines:def:d-9', reader: 'pat/pipelines/author', readOnly: null,
    nonReader: null, crossTenant: 'olu/orgiq/sme' },
] as const;
const subOf = (as: string) => as.split('/')[0]!;

beforeEach(async () => {
  flowRunsFixture.reset();
  duringPolicy = null;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
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
    await store.putMessage(msg(c.channel, `${c.channel}-1`, 'zed', 'We ship the cutover on Thursday.', '2026-10-01T10:00:00.000Z'));
    await store.putMessage(msg(c.channel, `${c.channel}-2`, 'olu', 'I will update the runbook first.', '2026-10-01T11:00:00.000Z'));
    await store.putMessage(msg(c.channel, `${c.channel}-3`, 'zed', 'Deleted line with a secret.', '2026-10-01T12:00:00.000Z',
      { deletedAt: '2026-10-01T12:05:00.000Z' }));
  }
});
afterEach(() => { flowRunsFixture.reset(); setSocialChatBackend(null); jest.clearAllMocks(); });

describe.each(CASES)('$channel', (c) => {
  it('a reader gets a private run of verbatim quotes; nothing is posted', async () => {
    const before = (await socialChat().chatStore.listMessages(c.channel, 50)).length;
    const started = await run(c.reader, c.channel);
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(new RegExp(`^${c.prefix}-`));
    await settle();
    const got = await status(c.reader, started.body.runId);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ phase: 'completed', posted: false, channel: c.channel });
    const quoted = JSON.stringify(got.body.result);
    expect(quoted).toContain('runbook');
    expect(quoted).not.toContain('secret');
    // Authors come from the directory, never message metadata.
    expect(quoted).toContain('olu Directory');
    expect(quoted).not.toContain('Forged label');
    expect((await socialChat().chatStore.listMessages(c.channel, 50)).length).toBe(before);
    expect(flowRunsFixture.rows()[0]).toMatchObject({ tenant: c.tenant, kind: `${c.tenant}.summarize`, requestedBy: subOf(c.reader) });
  });

  it('a non-reader is denied: closed by the chat store\'s membership rows (and by policy where the family has one)', async () => {
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: 'zed', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' } as never);
    expect((await run(c.reader, c.channel)).status).toBe(403);
    if (c.nonReader) {
      flowRunsFixture.reset(); setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
      expect((await run(c.nonReader, c.channel)).status).toBe(403);
    }
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('a cross-tenant caller is denied, even holding a grant in the conversation\'s tenant', async () => {
    expect((await run(c.crossTenant, c.channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('a revocation during the policy decision, the membership read or the transcript read denies, and stores nothing', async () => {
    const sub = subOf(c.reader);
    if (c.tenant !== 'orgiq') { // orgiq's read authority is the active tenant alone: no policy call to interleave
      duringPolicy = () => { users.get(sub)!.epoch = 2; };
      expect((await run(c.reader, c.channel)).status).toBe(403);
      duringPolicy = null; users.get(sub)!.epoch = 1;
    }
    const members = socialChat().membershipStore;
    const listMembers = members.listMembers.bind(members);
    const spy = jest.spyOn(members, 'listMembers').mockImplementation(async (...args) => { users.get(sub)!.epoch = 2; return listMembers(...args); });
    expect((await run(c.reader, c.channel)).status).toBe(403);
    spy.mockRestore(); users.get(sub)!.epoch = 1;
    expect((await run(c.reader, c.channel)).status).toBe(202); // sanity: the same caller, unrevoked, is admitted
    flowRunsFixture.reset();
    const store = socialChat().chatStore;
    const list = store.listMessages.bind(store);
    jest.spyOn(store, 'listMessages').mockImplementation(async (...args) => { users.get(sub)!.grants = {}; return list(...args); });
    expect((await run(c.reader, c.channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('honours the reader\'s history floor', async () => {
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: subOf(c.reader), role: 'member',
      joinedAt: '2026-10-01T10:30:00.000Z', historyFrom: '2026-10-01T10:30:00.000Z' } as never);
    const started = await run(c.reader, c.channel); await settle();
    const result = (await status(c.reader, started.body.runId)).body.result;
    expect(result.messageCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Thursday');
  });

  it('the run is the requester\'s alone, and re-checks the conversation on every read', async () => {
    const started = await run(c.reader, c.channel); await settle();
    // Another reader of the same conversation: an unknown id.
    expect((await status('zed/' + c.reader.split('/').slice(1).join('/'), started.body.runId)).status).toBe(404);
    expect((await post('zed/' + c.reader.split('/').slice(1).join('/'), started.body.runId)).status).toBe(404);
    expect((await status(c.reader, `${c.prefix}-00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    // The requester loses the conversation: the record is refused.
    users.get(subOf(c.reader))!.grants = {};
    expect((await status(c.reader, started.body.runId)).status).toBe(403);
  });

  it('posting needs the conversation\'s post authority and returns the server-built message once', async () => {
    const started = await run(c.reader, c.channel); await settle();
    if (c.readOnly) {
      const ro = await run(c.readOnly, c.channel); await settle();
      expect((await status(c.readOnly, ro.body.runId)).status).toBe(200);
      expect((await post(c.readOnly, ro.body.runId)).status).toBe(403);
    }
    const posted = await post(c.reader, started.body.runId);
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ channel: c.channel, metadata: { summaryOf: { runId: started.body.runId } } });
    expect(posted.body.text).toContain('runbook');
    expect((await post(c.reader, started.body.runId)).status).toBe(409);
    // Posting wrote nothing to the conversation: the portal sends it.
    expect((await socialChat().chatStore.listMessages(c.channel, 50)).some(m => m.metadata?.['summaryOf'])).toBe(false);
  });
});

describe('the route surface', () => {
  it('refuses anonymous callers, Social conversations, presence-only families and a bad range', async () => {
    expect((await request(app).post('/api/conversations/summarize/run').send({ channel: 'orgiq:initiative:p-auth' })).status).toBe(401);
    for (const channel of ['social:ch:general', 'orgiq:deck:d1', 'assessment:knowledge:x', 'orgiq:lobby', 'presence:orgiq:initiative:p-auth', 'orgiq:nope:1']) {
      expect((await run('olu/orgiq/sme', channel)).status).toBe(400);
    }
    expect((await run('olu/orgiq/sme', 'orgiq:initiative:p-auth', 'last banana')).status).toBe(400);
    expect((await status('olu/orgiq/sme', 'sum-00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});

describe('the drafter', () => {
  const invoke = agentcore.invokeAgent as jest.Mock;
  beforeEach(() => { (config.mock as { agentcore: boolean }).agentcore = false; invoke.mockReset(); });
  afterEach(() => { (config.mock as { agentcore: boolean }).agentcore = true; });

  it('a tenant the drafter\'s guard refuses gets the deterministic digest, flagged with the reason; the guard is not widened', async () => {
    invoke.mockResolvedValue({ text: '', raw: { agent: 'orgiq-assessment-drafter', error: 'forbidden', detail: "only serves the 'assessment' tenant (got 'orgiq')" } });
    const started = await run('olu/orgiq/sme', 'orgiq:initiative:p-auth'); await settle();
    const result = (await status('olu/orgiq/sme', started.body.runId)).body.result;
    expect(result).toMatchObject({ fallback: true, unavailable: expect.stringContaining('assessment') });
    expect(invoke).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({
      structuredInput: expect.objectContaining({ mode: 'summarize-conversation', tenant: 'orgiq', auth: { tenant: 'orgiq', sub: 'olu' } }) }));
  });

  it('assessment uses the grounded drafter answer when every quote is verbatim', async () => {
    invoke.mockResolvedValue({ text: JSON.stringify({ summary: 'Runbook first.', content: '## Summary\nRunbook first.', format: 'markdown',
      source_spans: ['I will update the runbook first.'] }) });
    const started = await run('ana/assessment/assessor', 'assessment:doc:d-1'); await settle();
    const result = (await status('ana/assessment/assessor', started.body.runId)).body.result;
    expect(result).toMatchObject({ fallback: false, summary: 'Runbook first.' });
    expect(result.unavailable).toBeUndefined();
  });
});

describe('the private run channel (<tenant>:flowrun:<id>)', () => {
  const ctxOf = (as: string) => {
    const [sub, org, role] = as.split('/');
    return { userId: sub, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(sub!)?.grants ?? {}), displayName: sub };
  };
  const subscribe = (as: string, channel: string, kind: 'subscribe' | 'publish' = 'subscribe') =>
    authorizeLiveGatewayChannel({ kind, clientId: `${as}-sock`, channel, ctx: ctxOf(as) }, { guard: channelGuard, baseChannel });

  it.each(CASES)('$channel: only the requester, only while they still read the conversation', async (c) => {
    const started = await run(c.reader, c.channel); await settle();
    const channel = flowRunChannel(started.body.runId)!;
    expect(channel).toBe(`${c.tenant}:flowrun:${started.body.runId}`);
    expect(await subscribe(c.reader, channel)).toBe(true);
    // A fellow reader of the same conversation, and a cross-tenant caller.
    expect(await subscribe('zed/' + c.reader.split('/').slice(1).join('/'), channel)).toBe(false);
    expect(await subscribe(c.crossTenant, channel)).toBe(false);
    // No publish, no service prefix, never a lobby.
    expect(await subscribe(c.reader, channel, 'publish')).toBe(false);
    expect(await subscribe(c.reader, `presence:${channel}`)).toBe(false);
    expect(lobbyGuard({ userId: subOf(c.reader), org: c.tenant, tenants: [c.tenant] }, channel)).toBe(false);
    // Re-filed under another tenant: not a channel at all.
    for (const other of ['social', 'assessment', 'orgiq', 'pipelines'].filter(t => t !== c.tenant)) {
      expect(parseFlowRunChannel(`${other}:flowrun:${started.body.runId}`)).toBeNull();
    }
    // The requester loses the conversation (membership rows close it): refused.
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: 'zed', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' } as never);
    expect(await subscribe(c.reader, channel)).toBe(false);
  });

  it('a revocation during the conversation\'s policy decision denies the requester', async () => {
    const started = await run('ana/assessment/assessor', 'assessment:doc:d-1'); await settle();
    duringPolicy = () => { users.get('ana')!.epoch = 2; };
    expect(await subscribe('ana/assessment/assessor', flowRunChannel(started.body.runId)!)).toBe(false);
  });

  it('an assessment summarize run is not decided by the evidence-draft rule', async () => {
    // rae holds the assessment tenant but no ViewAssessment; a forged row naming her still needs the doc's read authority.
    const row = await flowRunStore.create({ tenant: 'assessment', kind: 'assessment.summarize', requestedBy: 'rae', scope: 'assessment:doc:d-1',
      input: null, progress: [], idPrefix: 'asm' });
    expect(await subscribe('rae/assessment/assessment-reader', flowRunChannel(row.id)!)).toBe(false);
    // And a run of an unknown kind under a new prefix is refused outright.
    const odd = await flowRunStore.create({ tenant: 'orgiq', kind: 'orgiq.other', requestedBy: 'olu', scope: 'orgiq:initiative:p-auth',
      input: null, progress: [], idPrefix: 'osm' });
    expect(await subscribe('olu/orgiq/sme', flowRunChannel(odd.id)!)).toBe(false);
  });
});

describe('huddle chat (orgiq:huddle:<callId>)', () => {
  const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:charlie'; const HUDDLE = `orgiq:huddle:${CALL}`;
  let contexts: Map<string, Record<string, unknown>>;
  let runtime: CallChatRuntime; let observed: RecoverableCallStateStore;
  const ctx = (sub: string) => ({ userId: sub, org: 'orgiq', role: 'member', displayName: sub, epoch: 1, sessionIat: 1 });
  const as = (sub: string) => `${sub}/orgiq/member`;
  // A huddle message is ordinary gateway chat on the call's channel (the chat
  // service stores it); its join boundary is the reader's membership floor.
  const tick = () => new Promise(resolve => setTimeout(resolve, 3));
  const say = async (sub: string, text: string, id: string) => {
    await tick();
    await runtime.messages.putMessage({ id, clientId: sub[0]!, userId: sub, channel: HUDDLE,
      message: text, timestamp: new Date().toISOString(), metadata: { displayName: sub, clientDeliveryId: id } });
    await tick();
  };

  beforeEach(async () => {
    for (const id of ['alice', 'bob', 'charlie']) users.set(id, user(id, { orgiq: ['member'], social: ['participant'] }));
    contexts = new Map([['a', ctx('alice')], ['b', ctx('bob')], ['c', ctx('charlie')]]);
    const calls = new InMemoryCallStateStore();
    const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id),
      getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
    runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, maintenanceIntervalMs: 0,
      lobbyAllowed: (auth, lobby) => lobby.startsWith('orgiq:') && lobby.split(':').includes(String(auth.userId)) });
    setCallChatRuntime(runtime);
    observed = observeCallPageLifecycle(calls, () => null, () => runtime);
    await observed.registerParticipant(CALL, 'a', 'alice', LOBBY, ['bob', 'charlie']);
    await observed.registerParticipant(CALL, 'b', 'alice', LOBBY, ['bob', 'charlie']);
  });
  afterEach(() => { runtime.dispose(); setCallChatRuntime(null); });

  it('a seated participant summarizes; someone not seated is denied; a late joiner\'s floor hides earlier messages', async () => {
    await say('bob', 'Huddle decision: roll back the canary.', 'd-1');
    const started = await run(as('alice'), HUDDLE);
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(/^osm-/);
    await settle();
    expect(JSON.stringify((await status(as('alice'), started.body.runId)).body.result)).toContain('roll back the canary');
    expect((await run(as('charlie'), HUDDLE)).status).toBe(403);
    await observed.registerParticipant(CALL, 'c', 'alice', LOBBY, ['bob', 'charlie']);
    const late = await run(as('charlie'), HUDDLE); await settle();
    expect((await status(as('charlie'), late.body.runId)).body.result.messageCount).toBe(0);
  });

  it('the run channel and post follow the participant authority (a seat, not Social PostMessage)', async () => {
    await say('bob', 'Ship it after lunch.', 'd-2');
    const started = await run(as('alice'), HUDDLE); await settle();
    const channel = flowRunChannel(started.body.runId)!;
    const sub = (who: string) => authorizeLiveGatewayChannel({ kind: 'subscribe', clientId: `${who}-s`, channel, ctx: { ...ctx(who), tenants: ['orgiq', 'social'] } },
      { guard: channelGuard, baseChannel });
    expect(await sub('alice')).toBe(true);
    expect(await sub('bob')).toBe(false);
    // 77942166: a seated huddle member chats under the stored lobby's read
    // authority; Social PostMessage is not asked (currentCallChatGrant ignores
    // the action). So a policy that grants only ViewSocial still lets the seat post.
    jest.mocked(isAllowed).mockImplementation(async (p, action) => action === 'ViewSocial' && p.role === 'participant');
    const posted = await post(as('alice'), started.body.runId);
    expect(posted.status).toBe(200);
    expect(posted.body.channel).toBe(HUDDLE);
    // Leaving the call ends the requester's read of the record and of its channel.
    await observed.removeParticipant(CALL, 'a'); contexts.delete('a');
    expect((await status(as('alice'), started.body.runId)).status).toBe(403);
    expect((await post(as('alice'), started.body.runId)).status).toBe(403);
    expect(await sub('alice')).toBe(false);
  });
});

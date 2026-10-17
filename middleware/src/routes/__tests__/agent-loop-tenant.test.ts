// `/agent` on tenant discussions (routes/agent-loop.ts, the /api/conversations mount):
// the plan, the posting-right gate, once-only Approve/Discard, sequential execution through
// the existing flows, and a failing step stopping the loop.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { conversationAgentRouter } from '../agent-loop.js';
import { conversationArtifactRouter } from '../conversation-artifact.js';
import { conversationSummarizeRouter } from '../conversation-summarize.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { agentPlansFixture } from '../../mock/agent-plans.js';
import { parseFlowRunChannel, pendingFlowRuns } from '../../lib/flow-runs/index.js';
import type { Session } from '../../lib/session.js';

const POLICY: Record<string, string[]> = { member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment', 'ManageKnowledge'], author: ['ViewPipelines'] };
let users: Map<string, UserInfo>;
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
app.use('/api/conversations', conversationArtifactRouter);
app.use('/api/conversations', conversationAgentRouter);
app.use(errorHandler);

const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const base = '/api/conversations/agent';
const start = (as: string, channel: string, text = 'wrap up this thread') => request(app).post(`${base}/run`).set('x-as', as).send({ channel, text });
const status = (as: string, id: string) => request(app).get(`${base}/runs/${id}`).set('x-as', as);
const approve = (as: string, id: string) => request(app).post(`${base}/runs/${id}/approve`).set('x-as', as);
const discard = (as: string, id: string) => request(app).post(`${base}/runs/${id}/discard`).set('x-as', as);
const msg = (channel: string, id: string, userId: string, text: string, timestamp: string): ChatMessage =>
  ({ id, channel, clientId: `c-${userId}`, userId, message: text, timestamp, metadata: {} });

const CASES = [
  { tenant: 'orgiq', letter: 'o', channel: 'orgiq:initiative:p-auth', reader: 'olu/orgiq/sme', readOnly: 'mia/orgiq/member', crossTenant: 'ana/assessment/assessor' },
  { tenant: 'assessment', letter: 'a', channel: 'assessment:doc:d-1', reader: 'ana/assessment/assessor', readOnly: null, crossTenant: 'olu/orgiq/sme' },
  { tenant: 'pipelines', letter: 'p', channel: 'pipelines:run:r-7', reader: 'pat/pipelines/author', readOnly: null, crossTenant: 'ana/assessment/assessor' },
] as const;
const subOf = (as: string) => as.split('/')[0]!;

beforeEach(async () => {
  flowRunsFixture.reset(); agentPlansFixture.reset();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['olu', user('olu', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
    ['mia', user('mia', { orgiq: ['member'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['zed', user('zed', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (POLICY[p.role] ?? []).includes(action));
  const store = socialChat().chatStore;
  for (const c of CASES) {
    await store.putMessage(msg(c.channel, `${c.channel}-1`, 'zed', 'We ship the cutover on Thursday.', '2026-10-01T10:00:00.000Z'));
    await store.putMessage(msg(c.channel, `${c.channel}-2`, 'olu', 'I will update the runbook first.', '2026-10-01T11:00:00.000Z'));
  }
});
afterEach(() => { flowRunsFixture.reset(); agentPlansFixture.reset(); setSocialChatBackend(null); jest.clearAllMocks(); });

describe.each(CASES)('/agent in $channel', (c) => {
  const prefix = `${c.letter}ag`;
  const kinds = () => flowRunsFixture.rows().map(r => r.kind).sort();

  it('plans privately: a 2-step plan with acceptance, awaiting approval, nothing started or posted', async () => {
    const before = (await socialChat().chatStore.listMessages(c.channel, 50)).length;
    const started = await start(c.reader, c.channel);
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(new RegExp(`^${prefix}-`));
    expect(parseFlowRunChannel(`${c.tenant}:flowrun:${started.body.runId}`)).toMatchObject({ tenant: c.tenant });
    await settle();
    const got = await status(c.reader, started.body.runId);
    expect(got.body).toMatchObject({ stage: 'awaiting-approval', phase: 'completed', channel: c.channel });
    expect(got.body.plan.steps.map((s: { kind: string }) => s.kind)).toEqual(['summarize', 'diagram']);
    expect(got.body.plan.steps.every((s: { acceptance: string }) => s.acceptance.length > 0)).toBe(true);
    expect(got.body.steps.map((s: { status: string }) => s.status)).toEqual(['pending', 'pending']);
    expect(kinds()).toEqual([`${c.tenant}.agent`]);
    expect((await socialChat().chatStore.listMessages(c.channel, 50)).length).toBe(before);
  });

  it('refuses a goal-less command, a reader without the posting right, a cross-tenant caller and a revoked reader', async () => {
    expect((await start(c.reader, c.channel, '  ')).status).toBe(400);
    expect((await start(c.reader, c.channel, 'x'.repeat(301))).status).toBe(400);
    if (c.readOnly) expect((await start(c.readOnly, c.channel)).status).toBe(403);
    expect((await start(c.crossTenant, c.channel)).status).toBe(403);
    const sub = subOf(c.reader);
    const store = socialChat().chatStore;
    const list = store.listMessages.bind(store);
    jest.spyOn(store, 'listMessages').mockImplementation(async (...args) => { users.get(sub)!.grants = {}; return list(...args); });
    expect((await start(c.reader, c.channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('the run is the requester\'s alone, and every call re-asks the conversation', async () => {
    const started = await start(c.reader, c.channel); await settle();
    const other = 'zed/' + c.reader.split('/').slice(1).join('/');
    for (const call of [status, approve, discard]) expect((await call(other, started.body.runId)).status).toBe(404);
    expect((await status(c.reader, `${prefix}-00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await status(c.reader, 'sum-00000000-0000-4000-8000-000000000000')).status).toBe(404);
    users.get(subOf(c.reader))!.grants = {};
    expect((await status(c.reader, started.body.runId)).status).toBe(403);
    expect((await approve(c.reader, started.body.runId)).status).toBe(403);
  });

  it('Approve runs the steps in order through the existing flows; each step links its run; once only', async () => {
    const started = await start(c.reader, c.channel); await settle();
    const ok = await approve(c.reader, started.body.runId);
    expect(ok.status).toBe(202);
    await settle();
    const got = await status(c.reader, started.body.runId);
    expect(got.body).toMatchObject({ stage: 'done', phase: 'completed', error: null });
    expect(got.body.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed']);
    expect(got.body.steps.map((s: { ref: { kind: string } }) => s.ref.kind)).toEqual(['summary', 'diagram']);
    expect(kinds()).toEqual([`${c.tenant}.agent`, `${c.tenant}.diagram`, `${c.tenant}.summarize`]);
    const children = flowRunsFixture.rows().filter(r => r.kind !== `${c.tenant}.agent`);
    expect(children.every(r => r.requestedBy === subOf(c.reader) && r.status === 'completed' && r.scope === c.channel)).toBe(true);
    expect(got.body.steps.map((s: { ref: { runId: string } }) => s.ref.runId).sort()).toEqual(children.map(r => r.id).sort());
    expect((await approve(c.reader, started.body.runId)).status).toBe(409);
    expect((await discard(c.reader, started.body.runId)).status).toBe(409);
  });

  it('Approve is idempotent per requestId; another requestId or another approver is refused', async () => {
    const started = await start(c.reader, c.channel); await settle();
    const send = (as: string, requestId: string) => request(app).post(`${base}/runs/${started.body.runId}/approve`).set('x-as', as).send({ requestId });
    expect((await send(c.reader, 'req-12345678')).status).toBe(202);
    expect((await send(c.reader, 'req-12345678')).status).toBe(202);
    expect((await send(c.reader, 'req-other-999')).status).toBe(409);
    expect((await send(c.reader, 'bad id')).status).toBe(400);
    // Loops run as the requester's authority in every tenant: no one else may approve (the deck Save rules stay per card).
    expect((await send('zed/' + c.reader.split('/').slice(1).join('/'), 'req-zzzzzzzz')).status).toBe(404);
    await settle();
    expect(flowRunsFixture.rows().filter(r => r.kind === `${c.tenant}.summarize`)).toHaveLength(1);
    expect((await status(c.reader, started.body.runId)).body.stage).toBe('done');
  });

  it('Discard drops the plan once; nothing runs and Approve is refused', async () => {
    const started = await start(c.reader, c.channel); await settle();
    expect((await discard(c.reader, started.body.runId)).body).toMatchObject({ stage: 'discarded' });
    expect((await discard(c.reader, started.body.runId)).status).toBe(409);
    expect((await approve(c.reader, started.body.runId)).status).toBe(409);
    expect((await status(c.reader, started.body.runId)).body.stage).toBe('discarded');
    expect(kinds()).toEqual([`${c.tenant}.agent`]);
  });

  it('Approve needs the posting right now, not only at /run', async () => {
    if (!c.readOnly) return;
    const started = await start(c.reader, c.channel); await settle();
    // The same person later loses the right to post (role change in the directory).
    users.set('olu', user('olu', { orgiq: ['member'] }));
    expect((await approve('olu/orgiq/member', started.body.runId)).status).toBe(403);
    expect(kinds()).toEqual([`${c.tenant}.agent`]);
  });

  it('a failing step stops the loop and says why; later steps never start', async () => {
    agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'Three.', steps: [
      { kind: 'summarize', title: 'Summarize', instruction: '', acceptance: 'Quotes the thread.' },
      { kind: 'diagram', title: 'Diagram', instruction: '', acceptance: 'Shows the flow.' },
      { kind: 'doc', title: 'Page', instruction: '', acceptance: 'A page exists.' },
    ] });
    const started = await start(c.reader, c.channel); await settle();
    // Three diagram runs already in flight: the diagram step meets its own 429.
    for (let i = 0; i < 3; i++) flowRunsFixture.rows().push({ ...flowRunsFixture.rows()[0]!, id: `busy-${i}`, kind: `${c.tenant}.diagram`, status: 'running', requestedBy: subOf(c.reader), result: null });
    expect((await approve(c.reader, started.body.runId)).status).toBe(202);
    await settle();
    const got = (await status(c.reader, started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'stopped', phase: 'failed' });
    expect(got.error).toMatch(/Step 2 stopped the loop: 429/);
    expect(got.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'failed', 'pending']);
    expect(got.steps[1].detail).toMatch(/Wait for your running/);
    expect(flowRunsFixture.rows().some(r => r.kind === `${c.tenant}.doc`)).toBe(false);
  });
});

describe('the route surface', () => {
  it('refuses anonymous callers, Social and presence-only channels, and a deck step outside Social', async () => {
    expect((await request(app).post(`${base}/run`).send({ channel: 'orgiq:initiative:p-auth', text: 'x' })).status).toBe(401);
    for (const channel of ['social:ch:general', 'orgiq:deck:d1', 'orgiq:lobby', 'orgiq:nope:1']) {
      expect((await start('olu/orgiq/sme', channel)).status).toBe(400);
    }
    expect(flowRunsFixture.rows()).toHaveLength(0);
    // The mock planner may name a deck, but outside Social the plan keeps only flows that exist there.
    const started = await start('olu/orgiq/sme', 'orgiq:initiative:p-auth', 'turn this into a deck'); await settle();
    const got = await status('olu/orgiq/sme', started.body.runId);
    expect(got.body.plan.steps.map((s: { kind: string }) => s.kind)).toEqual(['summarize']);
  });
});

// ─── approval steps (HITL) ──────────────────────────────────────────────────

describe('an approval step in an orgiq discussion', () => {
  const channel = 'orgiq:initiative:p-auth';
  const owner = 'olu/orgiq/sme';
  const second = 'zed/orgiq/sme';           // holds DispatchAgentRun: the tenant's second-approver action
  const reader = 'mia/orgiq/member';        // may read, may not post
  const outsider = 'ana/assessment/assessor';
  const waitingList = (as: string) => request(app).get(`${base}/waiting`).query({ channel }).set('x-as', as);
  const decide = (as: string, id: string, verb: 'approve' | 'reject', body: Record<string, unknown> = {}) =>
    request(app).post(`${base}/runs/${id}/approval/${verb}`).set('x-as', as).send(body);

  async function paused(): Promise<string> {
    agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'Check, then draft.', steps: [
      { kind: 'summarize', title: 'Summarize', instruction: '', acceptance: 'Quotes the thread.' },
      { kind: 'approval', title: 'Check first', instruction: 'Draft the page?', acceptance: 'You decided.' },
      { kind: 'doc', title: 'Draft the page', instruction: '', acceptance: 'A page exists.' },
    ] });
    const started = await start(owner, channel); await settle();
    expect((await approve(owner, started.body.runId)).status).toBe(202); await settle();
    return started.body.runId;
  }

  it('pauses with the question; the requester, an eligible second approver and a reader see it with their own role', async () => {
    const id = await paused();
    expect(flowRunsFixture.rows().find(r => r.id === id)!.status).toBe('waiting-approval');
    expect((await status(owner, id)).body).toMatchObject({ stage: 'waiting-approval', phase: 'running', approval: { stepId: 's2', question: 'Draft the page?' } });
    expect(flowRunsFixture.rows().filter(r => r.kind === 'orgiq.doc')).toHaveLength(0);
    for (const [as, role] of [[owner, 'requester'], [second, 'approver'], [reader, 'reader']] as const) {
      const list = await waitingList(as);
      expect(list.status).toBe(200);
      expect(list.body.runs).toEqual([expect.objectContaining({ runId: id, role, approval: expect.objectContaining({ question: 'Draft the page?' }) })]);
    }
    // The reader view carries no goal text or transcript, only the question and the step titles.
    expect(JSON.stringify((await waitingList(reader)).body)).not.toMatch(/wrap up this thread|cutover|runbook/);
    expect((await waitingList(outsider)).status).toBe(403);
  });

  it('the wrong actor cannot decide: a reader is 403, another tenant and an unknown id are 404; nothing resumes', async () => {
    const id = await paused();
    expect((await decide(reader, id, 'approve')).status).toBe(403);
    expect((await decide(reader, id, 'reject')).status).toBe(403);
    expect((await decide(outsider, id, 'approve')).status).toBe(404);
    expect((await decide(owner, `oag-00000000-0000-4000-8000-000000000000`, 'approve')).status).toBe(404);
    expect((await decide(owner, id, 'approve', { requestId: 'bad id' })).status).toBe(400);
    await settle();
    expect(flowRunsFixture.rows().find(r => r.id === id)!.status).toBe('waiting-approval');
  });

  it('Approve by the requester resumes from the next step as them; idempotent per requestId, once only', async () => {
    const id = await paused();
    const ok = await decide(owner, id, 'approve', { requestId: 'ap-12345678' });
    expect(ok.status).toBe(202);
    expect((await decide(owner, id, 'approve', { requestId: 'ap-12345678' })).status).toBe(202);
    expect((await decide(owner, id, 'reject', { requestId: 'ap-other-999' })).status).toBe(409);
    await settle();
    expect((await status(owner, id)).body).toMatchObject({ stage: 'done' });
    expect(flowRunsFixture.rows().filter(r => r.kind === 'orgiq.summarize')).toHaveLength(1);
    const doc = flowRunsFixture.rows().filter(r => r.kind === 'orgiq.doc');
    expect(doc).toHaveLength(1);
    expect(doc[0]!.requestedBy).toBe('olu');
    expect((await decide(owner, id, 'approve', { requestId: 'ap-late-0000' })).status).toBe(409);
  });

  it('a second approver continues the loop as THEMSELVES, not as the requester', async () => {
    const id = await paused();
    expect((await decide(second, id, 'approve', { requestId: 'ap-zzzzzzzz' })).status).toBe(202);
    await settle();
    const doc = flowRunsFixture.rows().filter(r => r.kind === 'orgiq.doc');
    expect(doc).toHaveLength(1);
    expect(doc[0]!.requestedBy).toBe('zed');
    expect(flowRunsFixture.rows().find(r => r.id === id)!.progress[1]!.detail).toContain('Approved by zed');
  });

  it('Reject ends the loop with the reason; Approve afterwards is refused and no later step runs', async () => {
    const id = await paused();
    expect((await decide(owner, id, 'reject', { reason: 'Not this week' })).status).toBe(202); await settle();
    const got = (await status(owner, id)).body;
    expect(got).toMatchObject({ stage: 'stopped', phase: 'failed', error: expect.stringContaining('rejected by olu: Not this week') });
    expect(got.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'failed', 'pending']);
    expect((await decide(owner, id, 'approve')).status).toBe(409);
    expect(flowRunsFixture.rows().some(r => r.kind === 'orgiq.doc')).toBe(false);
    expect((await waitingList(owner)).body.runs).toEqual([]);
  });

  it('a decider whose epoch moved fails closed with the 403 shape and the loop stays paused', async () => {
    const id = await paused();
    users.get('zed')!.epoch = 2; // the directory moved past the session's epoch 1
    const out = await decide(second, id, 'approve', { requestId: 'ap-zzzzzzzz' });
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/authorization-unavailable/);
    await settle();
    expect(flowRunsFixture.rows().find(r => r.id === id)!.status).toBe('waiting-approval');
    expect(flowRunsFixture.rows().some(r => r.kind === 'orgiq.doc')).toBe(false);
  });

  it('Discard is not the way out of a paused loop (409); it stays paused', async () => {
    const id = await paused();
    expect((await discard(owner, id)).status).toBe(409);
    expect(flowRunsFixture.rows().find(r => r.id === id)!.status).toBe('waiting-approval');
  });
});

// `/agent` in Social channels and DMs (routes/agent-loop.ts, the Social mount): chatAccess with
// PostMessage from the start, a plan that may name a deck, Approve running the existing flows
// as the member's fresh session, and a revoked member stopping the loop.
const mockCaps = { current: ['ViewSocial', 'PostMessage'] };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => ['participant', 'moderator', 'community-admin']
    .map(id => ({ id, tenant: 'social', capabilities: mockCaps.current })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { chatPinsRouter } from '../chat-pins.js';
import { socialAgentRouter } from '../agent-loop.js';
import { socialArtifactRouter } from '../conversation-artifact.js';
import { socialSummarizeRouter } from '../social-summarize.js';
import { socialDeckRouter } from '../social-deck.js';
import { errorHandler } from '../../lib/async-handler.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import * as authz from '../../lib/authz.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { agentPlansFixture } from '../../mock/agent-plans.js';
import { socialDeckRevisionsFixture, socialDecksFixture } from '../../mock/social-decks.js';
import { flowRunChannel, pendingFlowRuns } from '../../lib/flow-runs/index.js';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';

const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  const sub = req.headers['x-as'];
  if (typeof sub === 'string') {
    const user = await getUser(sub);
    req.session = { sub, name: user?.displayName, role: 'participant', tenant: 'social', epoch: user?.epoch ?? 0, grants: user?.grants ?? {}, iat: 1 } as Session;
  }
  next();
});
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialSummarizeRouter);
app.use('/api/chat/commands', socialArtifactRouter);
app.use('/api/chat/commands', socialAgentRouter);
app.use('/api/chat', socialDeckRouter);
app.use(errorHandler);

const CHANNEL = 'social:ch:general';
const base = '/api/chat/commands/agent';
const msg = (id: string, text: string, timestamp: string, userId: string): ChatMessage =>
  ({ id, channel: CHANNEL, clientId: 'c', userId, message: text, timestamp, metadata: { displayName: userId } });
const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const start = (as: string, channel = CHANNEL, text = 'wrap this up') => request(app).post(`${base}/run`).set('x-as', as).send({ channel, text });
const status = (as: string, id: string) => request(app).get(`${base}/runs/${id}`).set('x-as', as);
const approve = (as: string, id: string) => request(app).post(`${base}/runs/${id}/approve`).set('x-as', as);
const discard = (as: string, id: string) => request(app).post(`${base}/runs/${id}/discard`).set('x-as', as);
const kinds = () => flowRunsFixture.rows().map(r => r.kind).sort();

let restorePptx: () => void;
beforeAll(() => { restorePptx = hidePptxNodeDetection(); });
afterAll(() => { restorePptx(); });
beforeEach(async () => {
  mockCaps.current = ['ViewSocial', 'PostMessage'];
  agentPlansFixture.reset();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  const store = socialChat().chatStore;
  await store.putMessage(msg('a1', 'Release is Thursday.', '2026-10-01T10:00:00.000Z', 'u-mira'));
  await store.putMessage(msg('a2', 'I will update the runbook.', '2026-10-01T11:00:00.000Z', 'u-theo'));
  await store.putMessage(msg('a3', 'Rollback plan needs an owner.', '2026-10-01T12:00:00.000Z', 'u-mira'));
});
afterEach(() => {
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset();
  socialDecksFixture.reset(); socialDeckRevisionsFixture.reset(); agentPlansFixture.reset();
  jest.restoreAllMocks(); setSocialChatBackend(null);
});

describe('/agent in Social', () => {
  it('plans privately on the run\'s own push channel; Approve runs summarize then diagram as the member', async () => {
    const started = await start('u-sana');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ pipelineId: 'conversation-agent', card: { kind: 'agent-run', command: '/agent' } });
    expect(started.body.runId).toMatch(/^sag-/);
    expect(flowRunChannel(started.body.runId)).toBe(`social:flowrun:${started.body.runId}`);
    await settle();
    expect((await status('u-sana', started.body.runId)).body).toMatchObject({ stage: 'awaiting-approval', plan: { steps: [{ kind: 'summarize' }, { kind: 'diagram' }] } });
    expect(kinds()).toEqual(['social.agent']);
    expect((await approve('u-sana', started.body.runId)).status).toBe(202);
    await settle();
    const got = (await status('u-sana', started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'done', phase: 'completed' });
    expect(got.steps.map((s: { ref: { kind: string } }) => s.ref.kind)).toEqual(['summary', 'diagram']);
    expect(kinds()).toEqual(['social.agent', 'social.diagram', 'social.summarize']);
    expect((await approve('u-sana', started.body.runId)).status).toBe(409);
  });

  it('a deck step starts a PREVIEW deck run: nothing is stored until Save', async () => {
    const started = await start('u-sana', CHANNEL, 'make a deck of this'); await settle();
    expect((await status('u-sana', started.body.runId)).body.plan.steps.map((s: { kind: string }) => s.kind)).toEqual(['summarize', 'deck']);
    await approve('u-sana', started.body.runId); await settle();
    const got = (await status('u-sana', started.body.runId)).body;
    expect(got.stage).toBe('done');
    const deckRun = flowRunsFixture.rows().find(r => r.kind === 'social.deck')!;
    expect(deckRun).toMatchObject({ requestedBy: 'u-sana', status: 'completed' });
    expect(got.steps[1].ref).toEqual({ kind: 'deck', runId: deckRun.id });
    expect(socialDecksFixture.rows()).toHaveLength(0);
  });

  it('refuses a non-member, a reader without PostMessage, another channel\'s tenant and anonymous callers', async () => {
    expect((await start('u-sana', 'social:ch:moderators')).status).toBe(403);
    expect((await start('u-sana', 'orgiq:initiative:x')).status).toBe(400);
    expect((await request(app).post(`${base}/run`).send({ channel: CHANNEL, text: 'x' })).status).toBe(401);
    expect((await start('u-sana', CHANNEL, ' ')).status).toBe(400);
    jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await start('u-sana')).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('is private; Approve and Discard are once-only; a removed member fails closed', async () => {
    const started = await start('u-sana'); await settle();
    for (const call of [status, approve, discard]) expect((await call('u-theo', started.body.runId)).status).toBe(404);
    expect((await discard('u-sana', started.body.runId)).body.stage).toBe('discarded');
    expect((await approve('u-sana', started.body.runId)).status).toBe(409);
    expect(kinds()).toEqual(['social.agent']);
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await status('u-sana', started.body.runId)).status).toBe(403);
  });
});

describe('an approval step in Social', () => {
  const waitingList = (as: string) => request(app).get(`${base}/waiting`).query({ channel: CHANNEL }).set('x-as', as);
  const decide = (as: string, id: string, verb: 'approve' | 'reject', body: Record<string, unknown> = {}) =>
    request(app).post(`${base}/runs/${id}/approval/${verb}`).set('x-as', as).send(body);
  async function paused(): Promise<string> {
    agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'Ask first.', steps: [
      { kind: 'approval', title: 'Ask', instruction: 'Post a diagram of this?', acceptance: 'You decided.' },
      { kind: 'diagram', title: 'Diagram', instruction: '', acceptance: 'A diagram exists.' },
    ] });
    const started = await start('u-sana'); await settle();
    await approve('u-sana', started.body.runId); await settle();
    return started.body.runId;
  }

  it('pauses; Social has no second approver, so another member is a read-only reader; the requester approves and the next step completes', async () => {
    const id = await paused();
    expect((await status('u-sana', id)).body).toMatchObject({ stage: 'waiting-approval', approval: { question: 'Post a diagram of this?' } });
    expect((await waitingList('u-sana')).body.runs[0]).toMatchObject({ runId: id, role: 'requester', mine: true });
    expect((await waitingList('u-theo')).body.runs[0]).toMatchObject({ runId: id, role: 'reader', mine: false });
    expect((await decide('u-theo', id, 'approve')).status).toBe(403);
    expect((await decide('u-sana', id, 'approve', { requestId: 'ap-12345678' })).status).toBe(202);
    expect((await decide('u-sana', id, 'approve', { requestId: 'ap-12345678' })).status).toBe(202);
    await settle();
    expect((await status('u-sana', id)).body).toMatchObject({ stage: 'done' });
    expect(kinds()).toEqual(['social.agent', 'social.diagram']);
    expect(flowRunsFixture.rows().find(r => r.kind === 'social.diagram')!.requestedBy).toBe('u-sana');
  });

  it('an unknown identity fails closed (403) and cannot decide; Reject carries its reason', async () => {
    const id = await paused();
    expect((await decide('u-nobody', id, 'approve')).status).toBe(403);
    expect((await decide('u-sana', id, 'reject', { reason: 'Too early' })).status).toBe(202); await settle();
    expect((await status('u-sana', id)).body).toMatchObject({ stage: 'stopped', error: expect.stringContaining('rejected by u-sana: Too early') });
    expect(kinds()).toEqual(['social.agent']);
  });
});

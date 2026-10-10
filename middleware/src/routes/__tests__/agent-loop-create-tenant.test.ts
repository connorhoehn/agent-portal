// `/agent` creation steps on tenant discussions (routes/agent-loop-create.ts): document:create in
// assessment (the Documents tab's New path), meeting:create as the conversation's own huddle lobby,
// and what is NOT offered or refused elsewhere.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { conversationAgentRouter } from '../agent-loop.js';
import { conversationArtifactRouter } from '../conversation-artifact.js';
import { conversationSummarizeRouter } from '../conversation-summarize.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { knowledgeDocs, knowledgeSections } from '../../mock/assessment.js';
import { knowledgeDocsFixture, knowledgeSectionsFixture } from '../../mock/assessment.js';
import { createDocumentStep, createMeetingStep } from '../agent-loop-create.js';
import type { Request } from 'express';
import { agentPlansFixture } from '../../mock/agent-plans.js';
import { parseFlowRunChannel, pendingFlowRuns } from '../../lib/flow-runs/index.js';
import type { Session } from '../../lib/session.js';

const POLICY: Record<string, string[]> = { member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment', 'ManageKnowledge'], viewer: ['ViewAssessment'], author: ['ViewPipelines'] };
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

const DOC = 'assessment:doc:d-1';
const INIT = 'orgiq:initiative:p-auth-migration';
const RUN = 'pipelines:run:r-7';
const DEF = 'pipelines:def:d-7';
const subOf = (as: string) => as.split('/')[0]!;
const plan = (steps: { kind: string; title: string; body?: string }[]) =>
  agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'Create.', steps: steps.map(s => ({ ...s, instruction: '', acceptance: 'It exists.' })) as never });

beforeEach(async () => {
  flowRunsFixture.reset(); agentPlansFixture.reset(); knowledgeDocsFixture.reset(); knowledgeSectionsFixture.reset();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['olu', user('olu', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['vic', user('vic', { assessment: ['viewer'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['zed', user('zed', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (POLICY[p.role] ?? []).includes(action));
  const store = socialChat().chatStore;
  for (const channel of [DOC, INIT, RUN]) await store.putMessage(msg(channel, `${channel}-1`, 'zed', 'Kickoff on Thursday.', '2026-10-01T10:00:00.000Z'));
});
afterEach(() => { flowRunsFixture.reset(); agentPlansFixture.reset(); knowledgeDocsFixture.reset(); knowledgeSectionsFixture.reset(); setSocialChatBackend(null); jest.clearAllMocks(); });

describe('assessment: document:create is the Documents tab\'s New, meeting:create the document\'s own lobby', () => {
  const ana = 'ana/assessment/assessor';
  it('Approve creates a workspace draft with the planner\'s body and records the lobby, each linked from its step', async () => {
    const started = await start(ana, DOC, 'plan the kickoff'); await settle();
    const planned = (await status(ana, started.body.runId)).body.plan;
    expect(planned.steps.map((s: { kind: string }) => s.kind)).toEqual(['document:create', 'meeting:create']);
    expect((await approve(ana, started.body.runId)).status).toBe(202); await settle();
    const got = (await status(ana, started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'done', phase: 'completed', error: null });
    const [docStep, meetStep] = got.steps;
    expect(docStep.link).toMatchObject({ kind: 'document', href: expect.stringMatching(/^\/assessment\/workspace\?doc=draft%3A[0-9a-f-]{36}$/) });
    const id = decodeURIComponent(docStep.link.href.split('doc=')[1]);
    const doc = knowledgeDocs().find(d => d.id === id)!;
    expect(doc).toMatchObject({ title: 'Notes: plan the kickoff', editable: true });
    expect(doc.markdown).toContain('## Agenda');
    expect(knowledgeSections().find(s => s.key === 'workspace_drafts')!.nodes.some(n => n.id === id)).toBe(true);
    expect(meetStep.link).toEqual({ kind: 'huddle', label: 'Meeting: plan the kickoff', lobbyName: DOC });
    expect(flowRunsFixture.rows().map(r => r.kind)).toEqual(['assessment.agent']);
  });

  it('a requester without ManageKnowledge is refused by the create path: 403 on the step, nothing created, the loop stops', async () => {
    const vic = 'vic/assessment/viewer';
    const started = await start(vic, DOC, 'plan the kickoff'); await settle();
    expect((await approve(vic, started.body.runId)).status).toBe(202); await settle();
    const got = (await status(vic, started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'stopped', error: expect.stringContaining('Step 1 stopped the loop: 403') });
    expect(got.steps.map((s: { status: string }) => s.status)).toEqual(['failed', 'pending']);
    expect(knowledgeDocs().some(d => d.title === 'Notes: plan the kickoff')).toBe(false);
  });

  it('access revoked after the plan is refused 403 at Approve, and nothing is created', async () => {
    const started = await start(ana, DOC, 'plan the kickoff'); await settle();
    users.get('ana')!.grants = {};
    expect((await approve(ana, started.body.runId)).status).toBe(403);
    expect(knowledgeDocs().some(d => d.title === 'Notes: plan the kickoff')).toBe(false);
  });

  it('the run is the requester\'s alone: another assessor gets 404 and creates nothing', async () => {
    const started = await start(ana, DOC, 'plan the kickoff'); await settle();
    expect((await approve('zed/assessment/assessor', started.body.runId)).status).toBe(404);
    expect(knowledgeDocs().some(d => d.title === 'Notes: plan the kickoff')).toBe(false);
  });

  it('a cross-tenant caller cannot start a plan on the document conversation', async () => {
    expect((await start('olu/orgiq/sme', DOC)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});

describe('orgiq and pipelines: only what exists is offered, and the steps refuse the rest', () => {
  it('an initiative discussion plans only meeting:create and Approve records its huddle lobby', async () => {
    const olu = 'olu/orgiq/sme';
    const started = await start(olu, INIT, 'plan the kickoff'); await settle();
    expect((await status(olu, started.body.runId)).body.plan.steps.map((s: { kind: string }) => s.kind)).toEqual(['meeting:create']);
    await approve(olu, started.body.runId); await settle();
    const got = (await status(olu, started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'done' });
    expect(got.steps[0].link).toEqual({ kind: 'huddle', label: 'Meeting: plan the kickoff', lobbyName: INIT });
  });

  it('a pipelines definition offers neither kind: the kickoff plan falls back to the one-step plan', async () => {
    const pat = 'pat/pipelines/author';
    const started = await start(pat, DEF, 'plan the kickoff'); await settle();
    expect((await status(pat, started.body.runId)).body.plan).toMatchObject({ fallback: true, steps: [{ kind: 'summarize' }] });
  });

  it('the step functions refuse directly: no document store in orgiq or pipelines, no lobby for a work item, definition or huddle, nor for a missing run', async () => {
    const mk = (tenant: string, role: string, sub: string): Session => sessionFor(sub, tenant, role);
    const req = (s: Session) => ({ method: 'POST', session: s, headers: {}, get: () => undefined }) as unknown as Request;
    const doc = { kind: 'document:create', title: 'T', instruction: '', acceptance: 'x' } as const;
    const meet = { ...doc, kind: 'meeting:create' } as const;
    const olu = mk('orgiq', 'sme', 'olu'); const pat = mk('pipelines', 'author', 'pat');
    await expect(createDocumentStep(req(olu), olu, 'orgiq', INIT, doc)).rejects.toMatchObject({ status: 409 });
    await expect(createDocumentStep(req(pat), pat, 'pipelines', RUN, doc)).rejects.toMatchObject({ status: 409 });
    await expect(createMeetingStep(req(pat), pat, 'pipelines', DEF, meet)).rejects.toMatchObject({ status: 409 });
    // A run page IS a huddle lobby (realtime-parity gap 3), but only for a run that exists now.
    await expect(createMeetingStep(req(pat), pat, 'pipelines', 'pipelines:run:no-such-run', meet)).rejects.toMatchObject({ status: 404 });
    await expect(createMeetingStep(req(olu), olu, 'orgiq', 'orgiq:huddle:abc', meet)).rejects.toBeTruthy();
    // A session of another tenant is refused outright.
    await expect(createMeetingStep(req(olu), olu, 'assessment', DOC, meet)).rejects.toMatchObject({ status: 403 });
  });
});

// The invoke route asks the local data assistant FIRST (lib/local-answers):
// a program-data question is answered from the providers with no agent call;
// anything else falls through to the agent with the scope/stance rebuilt as
// prose. The money gate is the budgets read tier, asserted through the route.

const mockStream = {
  runId: 'run-1', closed: false,
  stepStarted: jest.fn(), stepFinished: jest.fn(),
  toolCallStart: jest.fn(), toolCallArgs: jest.fn(), toolCallEnd: jest.fn(), toolCallResult: jest.fn(),
  textMessageStart: jest.fn(), textMessageContent: jest.fn(), textMessageEnd: jest.fn(), runFinished: jest.fn(),
};
jest.mock('@connorhoehn/realtime-modules/agent-streaming', () => ({
  agentStreamMiddleware: (handler: (req: unknown, stream: unknown, signal: AbortSignal) => Promise<void>) =>
    (req: unknown, res: { json: (value: unknown) => void }, next: (error?: unknown) => void) => {
      handler(req, mockStream, new AbortController().signal).then(() => res.json({ ok: true }), next);
    },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => false),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(), safeExec: jest.fn(async () => []) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {} } }));
jest.mock('../../lib/mine.js', () => ({ mineViewer: jest.fn(async () => ({ userId: 'u', personId: null })) }));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Supervisor' })),
  invokeAgentStreaming: jest.fn(async function* () {
    yield { type: 'TEXT_MESSAGE_START', messageId: 'answer' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Agent answer.' };
    yield { type: 'TEXT_MESSAGE_END', messageId: 'answer' };
  }),
} }));
jest.mock('../../providers/search.js', () => ({ resolveSearchContext: jest.fn(async () => ({ records: [], edges: [] })) }));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(async () => []), recordTurn: jest.fn(async () => {}) }));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn(async (_n: string, c: unknown) => c) }));
jest.mock('../../lib/invocations.js', () => ({ detectIntervention: jest.fn(async () => false), recordInvocation: jest.fn(), snippet: (value: string) => value }));
jest.mock('../../lib/agent-runs-live.js', () => ({ openAgentRun: jest.fn(), recordAgentRunEvent: jest.fn(), closeAgentRun: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { scopedRuntimeSessionId } from '../../lib/runtime-session.js';
import { listEvents, recordTurn } from '../../providers/memory.js';
import { openAgentRun } from '../../lib/agent-runs-live.js';
import { listProjects } from '../../providers/projects.js';

let principal: { sub: string; role: string; tenant: string } = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);

const text = () => mockStream.textMessageContent.mock.calls.map(c => c[1]).join('');
const toolNames = () => mockStream.toolCallStart.mock.calls.map(c => c[1]);
beforeEach(() => {
  jest.clearAllMocks();
  principal = { sub: 'u-release', role: 'org-leader', tenant: 'orgiq' };
  delete process.env['LOCAL_ANSWERS'];
});

describe('routing order', () => {
  it('a program-data question is answered locally and never reaches the agent', async () => {
    const res = await request(app).post('/api/agents/orgiq-supervisor/invoke')
      .send({ message: 'what project is over budget?', scope: { kind: 'initiatives' }, stance: 'advise' });
    expect(res.status).toBe(200);
    expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
    expect(openAgentRun).not.toHaveBeenCalled(); // no agent ran, so no agent run is recorded
    expect(mockStream.stepStarted).toHaveBeenCalledWith('local data: budget');
    expect(toolNames()).toEqual(['local_answer', 'search_context']);
    // The answer names the initiative with the highest spend/allocation share
    // (nobody is over today), so derive it from the same rows rather than
    // pinning an id: the seed's allocations move (LLM Application Platform is
    // 4.28 of 85, 5%; RAG Knowledge Search is 0.36 of 5, 7%, and is the closest).
    const rows = (await listProjects({ limit: 200 })).filter(p => p.allocatedUsd != null && p.allocatedUsd > 0);
    expect(rows.some(p => (p.agentSpendUsd ?? 0) > p.allocatedUsd!)).toBe(false);
    const closest = rows.sort((a, b) => (b.agentSpendUsd ?? 0) / b.allocatedUsd! - (a.agentSpendUsd ?? 0) / a.allocatedUsd!)[0]!;
    expect(text()).toContain('No initiative is over its');
    expect(text()).toContain(`$${closest.agentSpendUsd!.toFixed(2)} of $${closest.allocatedUsd!.toFixed(2)}`);
    const evidence = JSON.parse(mockStream.toolCallResult.mock.calls[1]![2]);
    expect(evidence.records[0]).toMatchObject({ type: 'initiative', n: 1, href: expect.stringMatching(/^\/iq\/projects\//) });
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'what project is over budget?',
      toolCalls: [expect.objectContaining({ name: 'local_answer' }), expect.objectContaining({ name: 'search_context' })] }));
    expect(mockStream.runFinished).toHaveBeenCalled();
  });

  it('reads and records the transcript as the signed-in user, never a body-supplied actor', async () => {
    await request(app).post('/api/agents/orgiq-supervisor/invoke')
      .send({ message: 'who knows auth best?', actorId: 'portal-default', sessionId: 'sess-of-someone-else-0000000000000' });
    expect(listEvents).toHaveBeenCalledWith(expect.any(String), 'orgiq_u-release');
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'orgiq_u-release' }));
    expect(JSON.stringify((listEvents as jest.Mock).mock.calls)).not.toContain('portal-default');
  });

  it('anything else falls through to the agent, with the scope and stance rebuilt as prose', async () => {
    await request(app).post('/api/agents/orgiq-supervisor/invoke')
      .send({ message: 'who knows auth best?', scope: { kind: 'initiatives' }, stance: 'advise' });
    const payload = (agentcore.invokeAgentStreaming as jest.Mock).mock.calls[0]![1];
    expect(payload.message).toBe("who knows auth best?\n\nAbout the organisation's initiatives. Advise only; do not change anything.");
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'who knows auth best?' }));
  });

  it('routes the agent to a microVM bound to the signed-in user, not the client-chosen session id', async () => {
    const clientId = 'someone-elses-conversation-'.padEnd(40, 'x');
    await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'who knows auth best?', sessionId: clientId });
    const first = (agentcore.invokeAgentStreaming as jest.Mock).mock.calls[0]![1];
    expect(first.sessionId).toBe(clientId);
    expect(first.runtimeSessionId).toBe(scopedRuntimeSessionId('orgiq_u-release', clientId));
    principal = { sub: 'u-other', role: 'org-leader', tenant: 'orgiq' };
    await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'who knows auth best?', sessionId: clientId });
    const second = (agentcore.invokeAgentStreaming as jest.Mock).mock.calls[1]![1];
    expect(second.runtimeSessionId).not.toBe(first.runtimeSessionId);
  });

  it('LOCAL_ANSWERS=false sends every question to the agent', async () => {
    process.env['LOCAL_ANSWERS'] = 'false';
    await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'what project is over budget?' });
    expect(agentcore.invokeAgentStreaming).toHaveBeenCalled();
  });

  it.each(['orgiq-graph-builder', 'orgiq-assessment-drafter'])('%s is never answered locally', async (agentId) => {
    principal = { sub: 'u-admin', role: 'admin', tenant: 'orgiq' };
    const { isAllowed } = jest.requireMock('../../lib/authz.js') as { isAllowed: jest.Mock };
    isAllowed.mockResolvedValue(true);
    await request(app).post(`/api/agents/${agentId}/invoke`).send({ message: 'what project is over budget?' });
    expect(agentcore.invokeAgentStreaming).toHaveBeenCalled();
    isAllowed.mockResolvedValue(false);
  });

  it('another tenant is not answered from orgiq program data', async () => {
    principal = { sub: 'u-mira', role: 'participant', tenant: 'social' };
    await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'what project is over budget?' });
    expect(agentcore.invokeAgentStreaming).toHaveBeenCalled();
  });

  it('a malformed scope is a 400 before the stream opens', async () => {
    const res = await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'hi', scope: { kind: 'everything' } });
    expect(res.status).toBe(400);
    const bad = await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'hi', stance: 'act' });
    expect(bad.status).toBe(400);
  });
});

describe('authority', () => {
  it('a member without the budgets read tier gets an answer with no dollar figures, and why', async () => {
    principal = { sub: 'demo-user', role: 'member', tenant: 'orgiq' };
    await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'what project is over budget?', scope: { kind: 'initiatives' } });
    expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
    expect(text()).not.toMatch(/\$\d/);
    expect(text()).toContain('budgets read tier');
    expect(JSON.parse(mockStream.toolCallResult.mock.calls[0]![2]).rows).toEqual([]);
    // Locked, not refused: the answer offers the tier's quick request, from where they are.
    expect(text()).toContain('locked');
    expect(text()).toContain('[Request budget access](/iq/projects?request=budget-access)');
    expect(JSON.parse(mockStream.toolCallResult.mock.calls[0]![2]).action)
      .toEqual({ kind: 'request-access', itemId: 'capability:orgiq:budgets-read', label: 'Request budget access', href: '/iq/projects?request=budget-access' });
  });
});

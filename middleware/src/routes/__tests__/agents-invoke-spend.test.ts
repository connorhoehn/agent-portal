// Money on the chat invoke (docs/next-steps.md §8 work item 16): the agent
// path is judged and held through lib/spend-holds.ts reserveSpend before the
// runtime is called, writes one ledger row per invoke after it, and sits
// behind a per-user rate limit. Real dev:mock providers (budgets, holds,
// ledger); only the runtime and the transcript store are stubbed.

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
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  isAllowed: jest.fn(async () => false),
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, cloudwatch: true, guardrails: true }, aurora: {} },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Supervisor' })),
  invokeAgentStreaming: jest.fn(),
} }));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(async () => []), recordTurn: jest.fn(async () => {}) }));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn(async (_n: string, c: unknown) => c) }));
jest.mock('../../lib/invocations.js', () => ({ detectIntervention: jest.fn(async () => false), recordInvocation: jest.fn(), snippet: (value: string) => value }));
jest.mock('../../lib/agent-runs-live.js', () => ({ openAgentRun: jest.fn(), recordAgentRunEvent: jest.fn(), closeAgentRun: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter, AGUI_RUN_ID_HEADER } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { mockHolds } from '../../providers/spend-holds.js';
import { userSpendThisPeriod } from '../../providers/user-budgets.js';

const USER = 'u-vera';
let principal = { sub: USER, role: 'org-leader', tenant: 'orgiq' };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);

const invoke = (body: Record<string, unknown> = {}) =>
  request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'draft a plan for the auth migration', ...body });

function streamAnswer(finished: Record<string, unknown> = {}) {
  (agentcore.invokeAgentStreaming as jest.Mock).mockImplementation(async function* () {
    yield { type: 'TEXT_MESSAGE_START', messageId: 'a' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: 'A plan.' };
    yield { type: 'TEXT_MESSAGE_END', messageId: 'a' };
    yield { type: 'RUN_FINISHED', ...finished };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimits();
  spendHolds.reset();
  spendEntries.reset();
  userBudgets.reset();
  principal = { sub: USER, role: 'org-leader', tenant: 'orgiq' };
  process.env['LOCAL_ANSWERS'] = 'false';
  streamAnswer();
});
afterAll(() => { delete process.env['LOCAL_ANSWERS']; });

const invokeRows = () => spendEntries.rows().filter((r) => r.source === 'agent_invoke');

describe('the chat invoke reserves and records spend', () => {
  it('an exhausted user budget gets the spend refusal and never reaches the runtime', async () => {
    const spent = (await userSpendThisPeriod(USER)).spentUsd;
    userBudgets.rows().push({ userId: USER, allocatedUsd: spent, hardCapUsd: spent, note: null, setBy: 'u-release' });
    const res = await invoke();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'user-cap', userBudget: { userId: USER } });
    expect(res.body.amountUsd).toBeCloseTo(0.05, 4);
    expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
    expect(invokeRows()).toHaveLength(0);
    expect(mockHolds().filter((h) => h.status === 'held')).toHaveLength(0);
  });

  it('a successful invoke writes one ledger row, priced from the usage the agent reports, and settles its hold', async () => {
    userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
    streamAnswer({ usage: { inputTokens: 12_000, outputTokens: 800 }, model: 'us.amazon.nova-pro-v1:0' });
    const res = await invoke();
    expect(res.status).toBe(200);
    const runId = res.headers[AGUI_RUN_ID_HEADER.toLowerCase()];
    expect(invokeRows()).toEqual([expect.objectContaining({
      sourceId: runId, actorId: USER, initiativeId: null, trigger: 'chat:orgiq-supervisor',
      model: 'us.amazon.nova-pro-v1:0', costBasis: 'estimated', inputTokens: 12_000, outputTokens: 800, provider: 'bedrock',
    })]);
    expect(invokeRows()[0]!.costUsd).toBeCloseTo(12 * 0.0008 + 0.8 * 0.0032, 6);
    expect(mockHolds()).toEqual([expect.objectContaining({ source: 'agent_invoke', sourceId: runId, actorId: USER, status: 'settled' })]);
  });

  it('an invoke whose answer carries no usage still writes its row, with an unknown cost, and keeps the hold until it expires', async () => {
    userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
    const res = await invoke();
    expect(res.status).toBe(200);
    expect(invokeRows()).toEqual([expect.objectContaining({ actorId: USER, costUsd: null, costBasis: 'unknown' })]);
    expect(mockHolds()).toEqual([expect.objectContaining({ source: 'agent_invoke', status: 'held' })]);
  });

  it('unattributed spend is refused when SPEND_HOLDS_UNATTRIBUTED=refuse', async () => {
    process.env['SPEND_HOLDS_UNATTRIBUTED'] = 'refuse';
    try {
      const res = await invoke();
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ gate: 'spend-hold' });
      expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
    } finally {
      delete process.env['SPEND_HOLDS_UNATTRIBUTED'];
    }
  });
});

describe('SPEND_HOLDS_UNATTRIBUTED=actor (the default): initiative, else the actor, else refused', () => {
  it('a scoped invoke is charged to the initiative the caller is on', async () => {
    expect(process.env['SPEND_HOLDS_UNATTRIBUTED']).toBeUndefined();
    const res = await invoke({ scope: { kind: 'initiative', id: 'p-auth' } });
    expect(res.status).toBe(200);
    expect(mockHolds()).toEqual([expect.objectContaining({ source: 'agent_invoke', initiativeId: 'p-auth', actorId: USER })]);
    expect(invokeRows()).toEqual([expect.objectContaining({ initiativeId: 'p-auth', actorId: USER })]);
  });

  it('an unscoped invoke writes its ledger row to the actor, and is refused once that user budget is spent', async () => {
    userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
    const ok = await invoke();
    expect(ok.status).toBe(200);
    expect(invokeRows()).toEqual([expect.objectContaining({ actorId: USER, initiativeId: null })]);
    expect(mockHolds()).toEqual([expect.objectContaining({ actorId: USER, initiativeId: null })]);

    userBudgets.reset();
    const spent = (await userSpendThisPeriod(USER)).spentUsd;
    userBudgets.rows().push({ userId: USER, allocatedUsd: spent, hardCapUsd: spent, note: null, setBy: 'u-release' });
    const refused = await invoke();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ gate: 'user-cap', userBudget: { userId: USER } });
    expect(agentcore.invokeAgentStreaming).toHaveBeenCalledTimes(1);
  });

  it('an invoke with neither an initiative nor an actor is refused; allow lets it through', async () => {
    principal = null as unknown as typeof principal;
    const res = await invoke();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'spend-hold' });
    expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();

    process.env['SPEND_HOLDS_UNATTRIBUTED'] = 'allow';
    try {
      expect((await invoke()).status).toBe(200);
      expect(invokeRows()).toEqual([expect.objectContaining({ actorId: null, initiativeId: null })]);
    } finally {
      delete process.env['SPEND_HOLDS_UNATTRIBUTED'];
    }
  });
});

describe('the per-user rate limit', () => {
  it('the 31st invoke in a minute is 429; another user is unaffected', async () => {
    for (let i = 0; i < 30; i++) expect((await invoke()).status).toBe(200);
    const over = await invoke();
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    expect(agentcore.invokeAgentStreaming).toHaveBeenCalledTimes(30);
    principal = { sub: 'u-layla', role: 'org-leader', tenant: 'orgiq' };
    expect((await invoke()).status).toBe(200);
  });
});

// POST /api/agents/:id/invoke — a caller-supplied `tenant` (or any identity
// key) in the body's `payload` cannot change whose documents the read agents
// retrieve: the route drops it, and the invoke body nests what is left under
// `input` with the session's signed identity set last.
const mockStream = { runId: 'tenant-run', closed: false,
  toolCallStart: jest.fn(), toolCallArgs: jest.fn(), toolCallEnd: jest.fn(), toolCallResult: jest.fn(),
  textMessageStart: jest.fn(), textMessageContent: jest.fn(), textMessageEnd: jest.fn(), runFinished: jest.fn(),
  stepStarted: jest.fn(), stepFinished: jest.fn(),
};
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('@connorhoehn/realtime-modules/agent-streaming', () => ({
  agentStreamMiddleware: (handler: (req: unknown, stream: unknown, signal: AbortSignal) => Promise<void>) =>
    (req: unknown, res: { json: (body: unknown) => void }, next: (error?: unknown) => void) => {
      handler(req, mockStream, new AbortController().signal).then(() => res.json({ ok: true }), next);
    },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn(async () => false),
}));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Search' })),
  invokeAgentStreaming: jest.fn(async function* () {
    yield { type: 'TEXT_MESSAGE_START', messageId: 'answer' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'ok' };
    yield { type: 'TEXT_MESSAGE_END', messageId: 'answer' };
  }),
} }));
jest.mock('../../providers/search.js', () => ({ resolveSearchContext: jest.fn() }));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(async () => []), recordTurn: jest.fn(async () => {}) }));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn() }));
jest.mock('../../lib/invocations.js', () => ({ detectIntervention: jest.fn(async () => false), recordInvocation: jest.fn(), snippet: (v: string) => v }));
jest.mock('../../lib/agent-runs-live.js', () => ({ openAgentRun: jest.fn(), recordAgentRunEvent: jest.fn(), closeAgentRun: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { buildInvokeBody } from '../../lib/agent-invoke-auth.js';

const app = express().use(express.json());
app.use((req, _res, next) => { req.session = { sub: 'u-member', tenant: 'orgiq', role: 'member' } as never; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);

beforeEach(() => jest.clearAllMocks());

it('a member posting `tenant` (and a forged auth block) in the payload still invokes as their own tenant', async () => {
  const res = await request(app).post('/api/agents/orgiq-search/invoke').send({
    message: 'what is the hiring plan',
    payload: { tenant: 'assessment', auth: { tenant: 'assessment', role: 'admin' }, authSig: 'v1.forged', sub: 'u-other', mode: 'x' },
  });
  expect(res.status).toBe(200);
  const sent = jest.mocked(agentcore.invokeAgentStreaming).mock.calls[0][1] as Parameters<typeof buildInvokeBody>[0];
  expect(sent.structuredInput).toEqual({ mode: 'x' });
  expect(sent.auth).toMatchObject({ sub: 'u-member', tenant: 'orgiq', role: 'member' });
  // What the runtime receives: no top-level tenant, nothing identity-shaped in `input`.
  const body = buildInvokeBody(sent, { stream: true });
  expect(body['tenant']).toBeUndefined();
  expect(body['authSig']).toBeUndefined();
  expect(JSON.parse(String(body['input']))).toEqual({ mode: 'x' });
  expect(body['auth']).toMatchObject({ tenant: 'orgiq', sub: 'u-member' });
});

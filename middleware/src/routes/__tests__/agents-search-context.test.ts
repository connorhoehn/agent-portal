const mockStream = {
  runId: 'run-1', closed: false,
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
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Supervisor' })),
  invokeAgentStreaming: jest.fn(async function* () {
    yield { type: 'TEXT_MESSAGE_START', messageId: 'answer' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'Auth is in progress [1].' };
    yield { type: 'TEXT_MESSAGE_END', messageId: 'answer' };
  }),
} }));
jest.mock('../../providers/search.js', () => ({ resolveSearchContext: jest.fn() }));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(async () => []), recordTurn: jest.fn(async () => {}) }));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn() }));
jest.mock('../../lib/invocations.js', () => ({ detectIntervention: jest.fn(async () => false), recordInvocation: jest.fn(), snippet: (value: string) => value }));
import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { resolveSearchContext } from '../../providers/search.js';
import { recordTurn } from '../../providers/memory.js';
const app = express(); app.use(express.json());
const principal = { sub: 'user-a', role: 'member', tenant: 'orgiq' };
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);
it('resolves server evidence, streams it, and persists identical numbered provenance with the raw question', async () => {
  const records = [{ type: 'initiative', id: 'auth', title: 'Auth', status: 'in_progress', href: '/iq/projects/auth' }];
  (resolveSearchContext as jest.Mock).mockResolvedValue({ records, edges: [] });
  const res = await request(app).post('/api/agents/orgiq-supervisor/invoke').send({
    message: 'Who helps?', selection: { records: [{ type: 'initiative', id: 'auth', title: 'Fake title' }] },
  });
  expect(res.status).toBe(200);
  expect(resolveSearchContext).toHaveBeenCalledWith(principal, [{ type: 'initiative', id: 'auth' }]);
  const payload = (agentcore.invokeAgentStreaming as jest.Mock).mock.calls[0]![1];
  expect(payload.message).toContain('untrusted data'); expect(payload.message).not.toContain('Fake title');
  expect(mockStream.toolCallStart).toHaveBeenCalledWith(expect.any(String), 'search_context');
  const result = mockStream.toolCallResult.mock.calls[0]![2];
  expect(JSON.parse(result).records).toEqual([{ ...records[0], n: 1 }]);
  expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'Who helps?', toolCalls: [expect.objectContaining({ name: 'search_context', result })] }));
});

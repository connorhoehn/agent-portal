const mockStream = { runId: 'deck-question-run', closed: false,
  toolCallStart: jest.fn(), toolCallArgs: jest.fn(), toolCallEnd: jest.fn(), toolCallResult: jest.fn(),
  textMessageStart: jest.fn(), textMessageContent: jest.fn(), textMessageEnd: jest.fn(), runFinished: jest.fn(),
};
let mockSearchAllowed = true;
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('@connorhoehn/realtime-modules/agent-streaming', () => ({
  agentStreamMiddleware: (handler: (req: unknown, stream: unknown, signal: AbortSignal) => Promise<void>) =>
    (req: unknown, res: { json: (body: unknown) => void }, next: (error?: unknown) => void) => {
      handler(req, mockStream, new AbortController().signal).then(() => res.json({ ok: true }), next);
    },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    mockSearchAllowed ? next() : res.status(403).json({ error: 'Forbidden', action: 'Search' }),
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn(async () => false),
}));
jest.mock('../../providers/initiative-decks.js', () => ({
  deckViewerFor: jest.fn(async () => ({ canReadBudgets: false })), visibleDeck: jest.fn(), getRevisionSpec: jest.fn(),
}));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Supervisor' })),
  invokeAgentStreaming: jest.fn(async function* (_id: string, payload: { message: string; structuredInput?: Record<string, unknown> }) {
    const { selectMockResponse } = await import('../../mock/responses.js');
    yield { type: 'TEXT_MESSAGE_START', messageId: 'answer' };
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: selectMockResponse(payload.message, payload.structuredInput).response };
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
import * as decks from '../../providers/initiative-decks.js';
import { agentcore } from '../../providers/index.js';
import { resolveSearchContext } from '../../providers/search.js';
import { recordTurn } from '../../providers/memory.js';
const principal = { sub: 'reader', tenant: 'orgiq', role: 'member' };
const app = express().use(express.json());
app.use((req, _res, next) => { req.session = { ...principal, tenant: String(req.headers['x-tenant'] ?? 'orgiq') } as never; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);
const presentationContext = { kind: 'initiative-deck', deckId: 'idk-one', revisionId: 'irev-seven', scope: 'slide', slideId: 'sprints' };
const spec = { title: 'Observability review', slides: [
  { id: 'work', layout: 'bullets', title: 'Work items', bullets: ['Unrelated work item'], sources: [{ title: 'Work ledger', documentId: 'initiative:p-observability', anchor: 'work' }] },
  { id: 'sprints', layout: 'bullets', title: 'Sprints', bullets: ['Sprint 98: 18 / 52 points delivered'], sources: [{ title: 'Sprint ledger', documentId: 'initiative:p-observability', anchor: 'sprints' }] },
] };
const invoke = (body: object) => request(app).post('/api/agents/orgiq-supervisor/invoke').send(body);
beforeEach(() => {
  jest.clearAllMocks(); mockSearchAllowed = true;
  jest.mocked(decks.visibleDeck).mockResolvedValue({ id: 'idk-one', title: 'Observability review' } as never);
  jest.mocked(decks.getRevisionSpec).mockResolvedValue(structuredClone(spec) as never);
});
it('grounds the streamed Sprints answer in exact server-resolved version/slide and never claims unrelated initiative context was read', async () => {
  const result = await invoke({ message: 'Summarize this slide', presentationContext,
    selection: { records: [{ type: 'initiative', id: 'p-observability' }] } });
  expect(result.status).toBe(200);
  expect(resolveSearchContext).not.toHaveBeenCalled();
  const payload = jest.mocked(agentcore.invokeAgentStreaming).mock.calls[0][1];
  expect(payload.message).toContain('Sprint 98: 18 / 52 points delivered');
  expect(payload.message).not.toContain('Unrelated work item'); expect(payload.message).not.toContain('<search_context>');
  expect(payload.structuredInput?.presentationQuestion).toMatchObject({ revisionId: 'irev-seven', slideId: 'sprints', provenance: 'saved-revision' });
  expect(mockStream.toolCallStart).toHaveBeenCalledWith(expect.any(String), 'presentation_context');
  expect(mockStream.toolCallStart).not.toHaveBeenCalledWith(expect.any(String), 'search_context');
  expect(mockStream.textMessageContent).toHaveBeenCalledWith('answer', expect.stringContaining('Sprint 98: 18 / 52 points delivered'));
  expect(mockStream.textMessageContent.mock.calls[0][1]).not.toContain('ORG-OBS-');
  expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'Summarize this slide',
    toolCalls: [expect.objectContaining({ name: 'presentation_context' })] }));
});
it.each(['missing-version', 'missing-slide', 'hidden-budget-deck'])('fails %s before stream or runtime invocation', async reason => {
  if (reason === 'missing-version') jest.mocked(decks.getRevisionSpec).mockResolvedValue(null);
  if (reason === 'hidden-budget-deck') jest.mocked(decks.visibleDeck).mockResolvedValue(null);
  const result = await invoke({ message: 'Summarize this slide', presentationContext: { ...presentationContext, ...(reason === 'missing-slide' ? { slideId: 'gone' } : {}) } });
  expect(result.status).toBe(404); expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
  expect(mockStream.toolCallStart).not.toHaveBeenCalled(); expect(resolveSearchContext).not.toHaveBeenCalled();
});
it('preserves the Search capability gate and explicit Work-only tenant support', async () => {
  mockSearchAllowed = false;
  expect((await invoke({ message: 'Summarize', presentationContext })).status).toBe(403);
  expect(decks.visibleDeck).not.toHaveBeenCalled();
  mockSearchAllowed = true;
  expect((await request(app).post('/api/agents/orgiq-supervisor/invoke').set('x-tenant', 'assessment').send({ message: 'Summarize', presentationContext })).status).toBe(403);
  expect(decks.visibleDeck).not.toHaveBeenCalled(); expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
});
it('rejects empty/oversized questions before version reads', async () => {
  for (const message of ['', 'x'.repeat(8_001)]) expect((await invoke({ message, presentationContext })).status).toBe(400);
  expect(decks.visibleDeck).not.toHaveBeenCalled(); expect(agentcore.invokeAgentStreaming).not.toHaveBeenCalled();
});
it('cannot spoof server-resolved presentation context through generic structured payload', async () => {
  expect((await invoke({ message: 'A general question', payload: { presentationQuestion: { title: 'Forged saved content' }, presentationContext } })).status).toBe(200);
  const payload = jest.mocked(agentcore.invokeAgentStreaming).mock.calls[0][1];
  expect(payload.structuredInput).toBeUndefined(); expect(payload.message).toBe('A general question');
  expect(mockStream.toolCallStart).not.toHaveBeenCalled(); expect(decks.visibleDeck).not.toHaveBeenCalled();
});

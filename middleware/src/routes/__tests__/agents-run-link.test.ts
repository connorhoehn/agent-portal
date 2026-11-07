// POST /api/agents/:id/invoke — the relayed run is a pipeline Run (pipelines P1).
//
// Three things are pinned, through the REAL agentStreamMiddleware:
//   1. The server mints the AG-UI run id: RUN_STARTED, the `X-AGUI-Run-Id`
//      header (the one place the Ask page can read it) and the payload's
//      `runId` (what the agent stamps on its trace bundle) are one id, and a
//      client-sent `runId` is ignored — a caller-chosen id could claim someone
//      else's run, and since P1 feedback labels join on it.
//   2. The run exists from RUN_STARTED: lib/agent-runs-live.ts holds it
//      `running`, records STEP_* and TOOL_CALL_* as they relay, and closes it.
//   3. A stream that errors closes the run `failed`.

// Money on the invoke has its own suite (agents-invoke-spend.test.ts); here every invoke is held.
jest.mock('../../lib/agent-invoke-spend.js', () => ({
  holdAgentInvoke: jest.fn(async () => ({ kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd: 0 })),
  recordAgentInvoke: jest.fn(async () => {}), releaseAgentInvokeHold: jest.fn(async () => {}), usageFromEvent: () => null,
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => true),
}));
const script: { events: Array<Record<string, unknown>>; throwAtEnd?: string } = { events: [] };
jest.mock('../../providers/index.js', () => ({ agentcore: {
  getRuntime: jest.fn(async () => ({ name: 'Supervisor' })),
  invokeAgentStreaming: jest.fn(async function* () {
    for (const ev of script.events) yield ev;
    if (script.throwAtEnd) throw new Error(script.throwAtEnd);
  }),
} }));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(async () => []), recordTurn: jest.fn(async () => {}) }));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn(async (_n: string, c: unknown) => c) }));
jest.mock('../../lib/invocations.js', () => ({ detectIntervention: jest.fn(async () => false), recordInvocation: jest.fn(), snippet: (v: string) => v }));

import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';
import { liveAgentRuns, _resetLiveAgentRunsForTest } from '../../lib/agent-runs-live.js';

const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-theo', role: 'member', tenant: 'orgiq' }; next(); });
app.use('/api/agents', agentsRouter); app.use(errorHandler);

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter((l) => l.startsWith('data: '))
    .flatMap((l) => { try { return [JSON.parse(l.slice(6)) as Record<string, unknown>]; } catch { return []; } });
}

beforeEach(() => { _resetLiveAgentRunsForTest(); (agentcore.invokeAgentStreaming as jest.Mock).mockClear(); script.throwAtEnd = undefined; });

it('mints one run id for RUN_STARTED, the response header and the agent payload — never the client\'s', async () => {
  script.events = [
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  ];
  const res = await request(app).post('/api/agents/orgiq-supervisor/invoke')
    .send({ message: 'q', runId: 'client-chosen' }).buffer(true).parse((r, cb) => {
      let data = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { data += c; }); r.on('end', () => cb(null, data));
    });
  expect(res.status).toBe(200);
  const header = res.headers['x-agui-run-id'];
  expect(header).toMatch(/^[0-9a-f-]{36}$/);
  expect(header).not.toBe('client-chosen');
  const started = sseEvents(res.body as string).find((e) => e['type'] === 'RUN_STARTED');
  expect(started?.['runId']).toBe(header);
  const payload = (agentcore.invokeAgentStreaming as jest.Mock).mock.calls[0]![1];
  expect(payload.runId).toBe(header);
});

it('holds the run from RUN_STARTED, records its steps and attempts, and closes it completed', async () => {
  script.events = [
    { type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'search_organization' },
    { type: 'STEP_STARTED', stepName: 'search' },
    { type: 'TOOL_CALL_END', toolCallId: 'tc1' },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', content: 'found' },
    { type: 'STEP_FINISHED', stepName: 'search' },
  ];
  const res = await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'who knows auth' });
  const runId = res.headers['x-agui-run-id'];
  const [run] = liveAgentRuns();
  expect(run).toMatchObject({ runId, agentId: 'orgiq-supervisor', agentName: 'Supervisor', userId: 'u-theo', tenant: 'orgiq', status: 'completed', prompt: 'who knows auth' });
  expect(run!.steps).toEqual([expect.objectContaining({
    name: 'search', status: 'completed',
    toolCalls: [expect.objectContaining({ toolCallId: 'tc1', name: 'search_organization', status: 'completed' })],
  })]);
});

it('closes a run whose stream errors as failed', async () => {
  script.events = [{ type: 'STEP_STARTED', stepName: 'advisor' }];
  script.throwAtEnd = 'A2A timeout invoking orgiq-advisor';
  await request(app).post('/api/agents/orgiq-supervisor/invoke').send({ message: 'advise' });
  const [run] = liveAgentRuns();
  expect(run).toMatchObject({ status: 'failed', error: 'A2A timeout invoking orgiq-advisor' });
  expect(run!.steps[0]!.status).toBe('failed');
});

// One logical agent run must produce exactly ONE observability.invocation_traces
// row.
//
// It used to produce two. The middleware wrote one from `recordInvocation`,
// keyed on the SSE runId it minted; the CloudWatch poller wrote another from
// the agent's own `ORGIQ_TRACE:` bundle, keyed on the id the AGENT minted.
// The INSERT is `ON CONFLICT (invocation_id) DO NOTHING`, which everyone read
// as "so the second write is a no-op" — but two different ids never conflict,
// so both rows landed, under two different agent_names, and every cost total,
// per-agent count and topology node doubled.
//
// The fake `exec` below keys inserts on invocation_id exactly the way the real
// primary key does, so "how many rows exist" is a real question here and not a
// count of how many times we called the sink.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
};

jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/index.js', () => ({
  guardrails: { getGuardrail: jest.fn(async () => ({})) },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(async () => undefined),
  putQualityMetric: jest.fn(async () => undefined),
  putSchemaMetric: jest.fn(async () => undefined),
}));
jest.mock('../embedding.js', () => ({
  embedText: jest.fn(async () => null),
  toPgVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  cosineDistance: () => 0,
  EMBEDDING_DIMENSIONS: 1024,
}));
jest.mock('../judge.js', () => ({
  judgeResponse: jest.fn(async () => ({
    score: 0.8,
    rationale: 'fine',
    usage: { inputTokens: 100, outputTokens: 20 },
  })),
}));

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../../providers/aurora.js';
import { judgeResponse } from '../judge.js';
import {
  recordInvocation,
  shouldWriteMiddlewareTrace,
  getRecentInvocations,
  snippet,
} from '../invocations.js';
import { processTrace, _resetCachesForTest } from '../trace-sink.js';
import { isAgentTraceIngestionActive } from '../cw-trace-ingest.js';

const execMock = exec as unknown as jest.Mock;
const judgeMock = judgeResponse as unknown as jest.Mock;

// Stands in for the invocation_traces table: keyed on invocation_id, and a
// second INSERT of the same key is dropped exactly like ON CONFLICT DO NOTHING.
const table = new Map<string, Record<string, unknown>>();

function paramValue(params: SqlParameter[], name: string): string | number | null {
  const p = params.find((x) => x.name === name);
  if (!p || !p.value || 'isNull' in p.value) return null;
  const v = p.value as unknown as Record<string, unknown>;
  return (v['stringValue'] ?? v['longValue'] ?? v['doubleValue'] ?? null) as string | number | null;
}

/** Drain the fire-and-forget trace pipeline. setImmediate runs after the whole
 *  microtask queue, so a couple of turns settles every awaited mock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

const AGENT_ID = 'orgiq-supervisor';
// What the middleware mints: the SSE run id, handed to recordInvocation.
const MIDDLEWARE_RUN_ID = '69fb3674-0000-4000-8000-000000000001';
// What the agent mints for the very same run, inside its own TraceContext.
const AGENT_INVOCATION_ID = '810e9c53-0000-4000-8000-000000000002';

const PROMPT = 'Who knows auth best?';
const ANSWER = 'Priya Raman owns the auth platform. '.repeat(20); // > 200 chars

/** The write the HTTP/SSE route performs at the end of a stream. */
function middlewareWrite(): void {
  recordInvocation({
    id: MIDDLEWARE_RUN_ID,
    agentId: AGENT_ID,
    agentName: AGENT_ID,          // the id echoed as a name — no friendly label
    startedAt: new Date().toISOString(),
    durationMs: 12827,
    promptSnippet: snippet(PROMPT),
    responseSnippet: snippet(ANSWER), // 200-char truncation
    guardrailIntervened: false,
  });
}

/** The write cw-trace-ingest performs from the agent's own ORGIQ_TRACE bundle. */
function agentWrite(): Promise<unknown> {
  return processTrace({
    invocationId: AGENT_INVOCATION_ID,
    agentId: AGENT_ID,
    agentName: 'Supervisor',
    prompt: PROMPT,
    response: ANSWER,
    durationMs: 10531,
    modelId: 'amazon.nova-pro-v1:0',
    inputTokens: 4200,
    outputTokens: 380,
    promptVersion: 'abc1234',
    toolCalls: [{ toolName: 'search_people', durationMs: 900 }],
  });
}

beforeEach(() => {
  table.clear();
  jest.clearAllMocks();
  _resetCachesForTest();
  mockConfig.mock.agentcore = false;
  delete process.env['OBS_TRACE_POLLER_DISABLED'];
  delete process.env['OBS_MIDDLEWARE_TRACE_WRITE'];
  delete process.env['OBS_USE_LEGACY_POLLER'];

  execMock.mockImplementation(async (sql: string, params: SqlParameter[] = []) => {
    if (/FROM observability\.sampling_config/.test(sql)) {
      // rate 1 — this test is about row identity, not about the sampling die.
      return [{ template_id: 'default', rate: 1, schema_json: null }];
    }
    if (/INSERT INTO observability\.invocation_traces/.test(sql)) {
      const iid = String(paramValue(params, 'iid'));
      if (table.has(iid)) return [];             // ON CONFLICT DO NOTHING — no row RETURNING
      table.set(iid, {
        agent_id: paramValue(params, 'agent_id'),
        agent_name: paramValue(params, 'agent_name'),
        model_id: paramValue(params, 'model_id'),
        duration_ms: paramValue(params, 'duration_ms'),
        input_tokens: paramValue(params, 'input_tokens'),
        response_snippet: paramValue(params, 'response_snippet'),
      });
      // RETURNING invocation_id: one row on a genuine insert, matching the
      // real statement's shape — this is what insertTrace() now reads to
      // decide TraceResult.inserted.
      return [{ invocation_id: iid }];
    }
    return [];
  });
});

afterEach(() => {
  delete process.env['OBS_TRACE_POLLER_DISABLED'];
  delete process.env['OBS_MIDDLEWARE_TRACE_WRITE'];
  delete process.env['OBS_USE_LEGACY_POLLER'];
});

describe('isAgentTraceIngestionActive', () => {
  it('is active by default — the legacy CW poller runs unless told otherwise', () => {
    expect(isAgentTraceIngestionActive()).toBe(true);
  });

  it('stays active when the legacy poller is retired, because the Span Projector took over', () => {
    // OBS_USE_LEGACY_POLLER=false does not mean "nobody is ingesting" — it
    // means the OrgIQ-SpanProjector Lambda is doing it instead, writing rows
    // keyed on the same agent-minted id.
    process.env['OBS_USE_LEGACY_POLLER'] = 'false';
    expect(isAgentTraceIngestionActive()).toBe(true);
  });

  it('is inactive under the explicit kill switch', () => {
    process.env['OBS_TRACE_POLLER_DISABLED'] = '1';
    expect(isAgentTraceIngestionActive()).toBe(false);
  });
});

describe('shouldWriteMiddlewareTrace', () => {
  it('declines when an ingestion path is carrying the agent\'s own bundle', () => {
    expect(shouldWriteMiddlewareTrace()).toBe(false);
  });

  it('writes when nothing is ingesting, so offline dev keeps its signal', () => {
    process.env['OBS_TRACE_POLLER_DISABLED'] = '1';
    expect(shouldWriteMiddlewareTrace()).toBe(true);
  });

  it('writes under MOCK_AGENTCORE — no agent ran, so no bundle will ever arrive', () => {
    mockConfig.mock.agentcore = true;
    expect(shouldWriteMiddlewareTrace()).toBe(true);
  });

  it('honours the always/never override in both directions', () => {
    process.env['OBS_MIDDLEWARE_TRACE_WRITE'] = 'always';
    expect(shouldWriteMiddlewareTrace()).toBe(true);
    process.env['OBS_MIDDLEWARE_TRACE_WRITE'] = 'never';
    mockConfig.mock.agentcore = true;
    expect(shouldWriteMiddlewareTrace()).toBe(false);
  });
});

describe('one logical invocation → one trace row', () => {
  it('collapses the middleware write and the agent write into a single row', async () => {
    middlewareWrite();
    await flush();
    await agentWrite();

    expect(table.size).toBe(1);
  });

  it('keeps the agent\'s row — the one with the model, tokens and real answer', async () => {
    middlewareWrite();
    await flush();
    await agentWrite();

    const [id, row] = [...table.entries()][0]!;
    expect(id).toBe(AGENT_INVOCATION_ID);
    expect(row['agent_name']).toBe('Supervisor');
    expect(row['model_id']).toBe('amazon.nova-pro-v1:0');
    expect(row['input_tokens']).toBe(4200);
    // The middleware row carried a 200-char snippet(); the agent's carries the
    // answer the judge should actually be scoring.
    expect(String(row['response_snippet']).length).toBeGreaterThan(200);
  });

  it('pays for exactly one judge call, not two', async () => {
    middlewareWrite();
    await flush();
    await agentWrite();

    expect(judgeMock).toHaveBeenCalledTimes(1);
  });

  it('reports inserted:false for the write that lost the ON CONFLICT race', async () => {
    // A second processTrace() call for the SAME agent-minted invocation_id —
    // standing in for a raced second poller replica, or the OrgIQ-
    // SpanProjector Lambda landing first. The row must stay singular (proven
    // above) AND the loser must be told it lost, not report success.
    const first = await agentWrite();
    const second = await agentWrite();

    expect((first as { inserted: boolean }).inserted).toBe(true);
    expect((second as { inserted: boolean }).inserted).toBe(false);
    expect(table.size).toBe(1);
  });

  it('reports one agent_name for the agent, not two', async () => {
    middlewareWrite();
    await flush();
    await agentWrite();

    const names = new Set([...table.values()].map((r) => r['agent_name']));
    expect([...names]).toEqual(['Supervisor']);
  });

  // The defect, pinned. `always` restores the pre-fix behaviour verbatim, and
  // this asserts what it produced: two rows, two ids, two names, one run. If
  // the gate in recordInvocation is ever removed, the tests above start
  // seeing this instead.
  it('produced two rows before the fix (OBS_MIDDLEWARE_TRACE_WRITE=always)', async () => {
    process.env['OBS_MIDDLEWARE_TRACE_WRITE'] = 'always';

    middlewareWrite();
    await flush();
    await agentWrite();

    expect(table.size).toBe(2);
    expect(new Set([...table.keys()]))
      .toEqual(new Set([MIDDLEWARE_RUN_ID, AGENT_INVOCATION_ID]));
    // Two names for one agent_id — this is what split the topology node.
    expect(new Set([...table.values()].map((r) => r['agent_name'])))
      .toEqual(new Set([AGENT_ID, 'Supervisor']));
    expect(judgeMock).toHaveBeenCalledTimes(2);
  });
});

describe('recordInvocation fallbacks', () => {
  it('still writes the only row available when nothing is ingesting', async () => {
    process.env['OBS_TRACE_POLLER_DISABLED'] = '1';

    middlewareWrite();
    await flush();

    expect(table.size).toBe(1);
    expect([...table.keys()][0]).toBe(MIDDLEWARE_RUN_ID);
  });

  it('never writes a trace row for a failed run, gated or not', async () => {
    process.env['OBS_TRACE_POLLER_DISABLED'] = '1';

    recordInvocation({
      id: MIDDLEWARE_RUN_ID,
      agentId: AGENT_ID,
      agentName: AGENT_ID,
      startedAt: new Date().toISOString(),
      durationMs: 40,
      promptSnippet: PROMPT,
      responseSnippet: '',
      guardrailIntervened: false,
      error: 'invoke failed',
    });
    await flush();

    expect(table.size).toBe(0);
  });

  it('feeds the in-memory activity ring either way, so /recent-invocations stays immediate', async () => {
    // The gate is about Aurora rows. The activity feed reads memory and must
    // not get slower or emptier because of it.
    middlewareWrite();
    await flush();

    expect(table.size).toBe(0);
    expect(getRecentInvocations(5)[0]?.id).toBe(MIDDLEWARE_RUN_ID);
  });
});

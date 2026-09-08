// X-Ray-shaped traces for the observability trace list and the span waterfall
// (providers/cloudwatch.ts `listTraces` / `getTrace`).
//
// This module used to open with `const now = Date.now()` and stamp every trace
// against it — contract.ts bug #3 in its purest form. The value was baked when
// the module was imported, so a `dev:mock` server left running overnight kept
// insisting its newest trace was two minutes old, and one started just before
// UTC midnight put every trace in yesterday. `clock.hoursAgo()` inside the rows
// factory samples the clock at READ time instead, so the ages stay true for as
// long as the process does.
//
// `traceCount` on Health's summary is `mockTraces.length` — counted, not typed,
// which is why switching this fixture to `empty` empties that tile too.

import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'agent' | 'tool' | 'llm' | 'retrieval';
  startTimeMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number>;
}

export interface Trace {
  traceId: string;
  rootSpan: string;
  agentId: string;
  agentName: string;
  startTime: string;
  totalDurationMs: number;
  spanCount: number;
  status: 'ok' | 'error';
  tokensIn: number;
  tokensOut: number;
  spans: TraceSpan[];
}

/** Minutes are the natural unit for a trace list; the clock speaks hours. */
const minutesAgo = (minutes: number): string => clock.hoursAgo(minutes / 60);

/**
 * `spanCount`, `status` and `totalDurationMs` are counted from `spans`, never
 * typed beside them. A trace claiming 6 spans over a list of 4 is the same
 * defect as a summary claiming 25 errors over a list of 6, one nesting level
 * down — and a hand-typed `totalDurationMs` is that same defect for the root
 * span's own duration, which is already sitting right there in `spans`.
 */
function trace(input: Omit<Trace, 'spanCount' | 'status' | 'totalDurationMs'>): Trace {
  const root = input.spans.find((span) => span.spanId === input.rootSpan);
  return {
    ...input,
    totalDurationMs: root ? root.durationMs : 0,
    spanCount: input.spans.length,
    status: input.spans.some((span) => span.status === 'error') ? 'error' : 'ok',
  };
}

function seedTraces(): Trace[] {
  return [
    trace({
      traceId: 'trace-001',
      rootSpan: 'span-001-root',
      agentId: 'orgiq-supervisor',
      agentName: 'Supervisor',
      startTime: minutesAgo(2),
      tokensIn: 1240,
      tokensOut: 856,
      spans: [
        { traceId: 'trace-001', spanId: 'span-001-root', parentSpanId: null, name: 'supervisor.invoke', kind: 'agent', startTimeMs: 0, durationMs: 3420, status: 'ok', attributes: { 'agent.id': 'orgiq-supervisor', 'user.query': 'Who knows Kubernetes best?' } },
        { traceId: 'trace-001', spanId: 'span-001-llm1', parentSpanId: 'span-001-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 50, durationMs: 820, status: 'ok', attributes: { 'model.id': 'nova-pro-v1', 'tokens.in': 340, 'tokens.out': 128 } },
        { traceId: 'trace-001', spanId: 'span-001-a2a', parentSpanId: 'span-001-root', name: 'a2a.invoke_search', kind: 'agent', startTimeMs: 900, durationMs: 1800, status: 'ok', attributes: { 'target.agent': 'orgiq-search' } },
        { traceId: 'trace-001', spanId: 'span-001-kb', parentSpanId: 'span-001-a2a', name: 'kb.retrieve', kind: 'retrieval', startTimeMs: 950, durationMs: 450, status: 'ok', attributes: { 'kb.id': 'orgiq-knowledge-base', 'results.count': 5 } },
        { traceId: 'trace-001', spanId: 'span-001-graph', parentSpanId: 'span-001-a2a', name: 'aurora.query', kind: 'retrieval', startTimeMs: 1420, durationMs: 320, status: 'ok', attributes: { 'query.type': 'sql', 'results.count': 3 } },
        { traceId: 'trace-001', spanId: 'span-001-llm2', parentSpanId: 'span-001-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 2750, durationMs: 620, status: 'ok', attributes: { 'model.id': 'nova-pro-v1', 'tokens.in': 900, 'tokens.out': 728 } },
      ],
    }),
    trace({
      traceId: 'trace-002',
      rootSpan: 'span-002-root',
      agentId: 'orgiq-scoring',
      agentName: 'Scoring',
      startTime: minutesAgo(5),
      tokensIn: 580,
      tokensOut: 320,
      spans: [
        { traceId: 'trace-002', spanId: 'span-002-root', parentSpanId: null, name: 'scoring.compute', kind: 'agent', startTimeMs: 0, durationMs: 1850, status: 'ok', attributes: { 'agent.id': 'orgiq-scoring', 'metric': 'pagerank' } },
        { traceId: 'trace-002', spanId: 'span-002-graph', parentSpanId: 'span-002-root', name: 'aurora.query', kind: 'retrieval', startTimeMs: 100, durationMs: 680, status: 'ok', attributes: { 'query.type': 'sql', 'results.count': 24 } },
        { traceId: 'trace-002', spanId: 'span-002-llm', parentSpanId: 'span-002-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 820, durationMs: 540, status: 'ok', attributes: { 'model.id': 'nova-lite-v1', 'tokens.in': 580, 'tokens.out': 320 } },
        { traceId: 'trace-002', spanId: 'span-002-ddb', parentSpanId: 'span-002-root', name: 'dynamodb.batch_write', kind: 'tool', startTimeMs: 1400, durationMs: 120, status: 'ok', attributes: { 'table': 'orgiq-scores', 'items.count': 24 } },
      ],
    }),
    trace({
      traceId: 'trace-003',
      rootSpan: 'span-003-root',
      agentId: 'orgiq-ingestion',
      agentName: 'Ingestion',
      startTime: minutesAgo(10),
      tokensIn: 2100,
      tokensOut: 890,
      spans: [
        { traceId: 'trace-003', spanId: 'span-003-root', parentSpanId: null, name: 'ingestion.process', kind: 'agent', startTimeMs: 0, durationMs: 8200, status: 'error', attributes: { 'agent.id': 'orgiq-ingestion', 'document.source': 'confluence' } },
        { traceId: 'trace-003', spanId: 'span-003-s3', parentSpanId: 'span-003-root', name: 's3.get_object', kind: 'tool', startTimeMs: 100, durationMs: 250, status: 'ok', attributes: { 'bucket': 'orgiq-documents', 'key': 'confluence/auth-migration-prd.pdf' } },
        { traceId: 'trace-003', spanId: 'span-003-llm', parentSpanId: 'span-003-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 400, durationMs: 3200, status: 'ok', attributes: { 'model.id': 'nova-lite-v1', 'tokens.in': 2100, 'tokens.out': 890 } },
        { traceId: 'trace-003', spanId: 'span-003-a2a', parentSpanId: 'span-003-root', name: 'a2a.invoke_graph_builder', kind: 'agent', startTimeMs: 3700, durationMs: 4200, status: 'error', attributes: { 'target.agent': 'orgiq-graph-builder', 'error': 'timeout after 4000ms' } },
        { traceId: 'trace-003', spanId: 'span-003-gb', parentSpanId: 'span-003-a2a', name: 'graph_builder.merge', kind: 'agent', startTimeMs: 3750, durationMs: 4150, status: 'error', attributes: { 'error.type': 'TimeoutError' } },
      ],
    }),
  ];
}

/**
 * Traces.
 *
 * `empty` — X-Ray has exported nothing yet. This is the honest state before
 *           the first agent runs, and the one the trace list's empty copy is
 *           written for; without it an auditor had to stop the poller to see
 *           that copy at all.
 * `large` — a day of traces rather than three, so the list's paging, its
 *           relative timestamps and the waterfall's density can be read.
 */
export const traces = defineFixture<Trace>({
  key: 'traces',
  scenarios: {
    default: seedTraces,
    empty: () => [],
    large: () =>
      Array.from({ length: 12 }, (_, round) =>
        seedTraces().map((seed) => ({
          ...seed,
          traceId: `${seed.traceId}-r${round}`,
          startTime: minutesAgo(2 + round * 47),
          spans: seed.spans.map((span) => ({ ...span, traceId: `${seed.traceId}-r${round}` })),
        })),
      ).flat(),
  },
});

/** Live view — see mock/live.ts. Consumers keep reading it as an array. */
export const mockTraces: Trace[] = liveRows(traces);

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

const now = Date.now();

export const mockTraces: Trace[] = [
  {
    traceId: 'trace-001',
    rootSpan: 'span-001-root',
    agentId: 'orgiq-supervisor',
    agentName: 'Supervisor',
    startTime: new Date(now - 120000).toISOString(),
    totalDurationMs: 3420,
    spanCount: 6,
    status: 'ok',
    tokensIn: 1240,
    tokensOut: 856,
    spans: [
      { traceId: 'trace-001', spanId: 'span-001-root', parentSpanId: null, name: 'supervisor.invoke', kind: 'agent', startTimeMs: 0, durationMs: 3420, status: 'ok', attributes: { 'agent.id': 'orgiq-supervisor', 'user.query': 'Who knows Kubernetes best?' } },
      { traceId: 'trace-001', spanId: 'span-001-llm1', parentSpanId: 'span-001-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 50, durationMs: 820, status: 'ok', attributes: { 'model.id': 'nova-pro-v1', 'tokens.in': 340, 'tokens.out': 128 } },
      { traceId: 'trace-001', spanId: 'span-001-a2a', parentSpanId: 'span-001-root', name: 'a2a.invoke_search', kind: 'agent', startTimeMs: 900, durationMs: 1800, status: 'ok', attributes: { 'target.agent': 'orgiq-search' } },
      { traceId: 'trace-001', spanId: 'span-001-kb', parentSpanId: 'span-001-a2a', name: 'kb.retrieve', kind: 'retrieval', startTimeMs: 950, durationMs: 450, status: 'ok', attributes: { 'kb.id': 'orgiq-knowledge-base', 'results.count': 5 } },
      { traceId: 'trace-001', spanId: 'span-001-graph', parentSpanId: 'span-001-a2a', name: 'aurora_age.query', kind: 'retrieval', startTimeMs: 1420, durationMs: 320, status: 'ok', attributes: { 'query.type': 'cypher', 'results.count': 3 } },
      { traceId: 'trace-001', spanId: 'span-001-llm2', parentSpanId: 'span-001-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 2750, durationMs: 620, status: 'ok', attributes: { 'model.id': 'nova-pro-v1', 'tokens.in': 900, 'tokens.out': 728 } },
    ],
  },
  {
    traceId: 'trace-002',
    rootSpan: 'span-002-root',
    agentId: 'orgiq-scoring',
    agentName: 'Scoring',
    startTime: new Date(now - 300000).toISOString(),
    totalDurationMs: 1850,
    spanCount: 4,
    status: 'ok',
    tokensIn: 580,
    tokensOut: 320,
    spans: [
      { traceId: 'trace-002', spanId: 'span-002-root', parentSpanId: null, name: 'scoring.compute', kind: 'agent', startTimeMs: 0, durationMs: 1850, status: 'ok', attributes: { 'agent.id': 'orgiq-scoring', 'metric': 'pagerank' } },
      { traceId: 'trace-002', spanId: 'span-002-graph', parentSpanId: 'span-002-root', name: 'aurora_age.query', kind: 'retrieval', startTimeMs: 100, durationMs: 680, status: 'ok', attributes: { 'query.type': 'cypher', 'results.count': 24 } },
      { traceId: 'trace-002', spanId: 'span-002-llm', parentSpanId: 'span-002-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 820, durationMs: 540, status: 'ok', attributes: { 'model.id': 'nova-lite-v1', 'tokens.in': 580, 'tokens.out': 320 } },
      { traceId: 'trace-002', spanId: 'span-002-ddb', parentSpanId: 'span-002-root', name: 'dynamodb.batch_write', kind: 'tool', startTimeMs: 1400, durationMs: 120, status: 'ok', attributes: { 'table': 'orgiq-scores', 'items.count': 24 } },
    ],
  },
  {
    traceId: 'trace-003',
    rootSpan: 'span-003-root',
    agentId: 'orgiq-ingestion',
    agentName: 'Ingestion',
    startTime: new Date(now - 600000).toISOString(),
    totalDurationMs: 8200,
    spanCount: 5,
    status: 'error',
    tokensIn: 2100,
    tokensOut: 890,
    spans: [
      { traceId: 'trace-003', spanId: 'span-003-root', parentSpanId: null, name: 'ingestion.process', kind: 'agent', startTimeMs: 0, durationMs: 8200, status: 'error', attributes: { 'agent.id': 'orgiq-ingestion', 'document.source': 'confluence' } },
      { traceId: 'trace-003', spanId: 'span-003-s3', parentSpanId: 'span-003-root', name: 's3.get_object', kind: 'tool', startTimeMs: 100, durationMs: 250, status: 'ok', attributes: { 'bucket': 'orgiq-documents', 'key': 'confluence/auth-migration-prd.pdf' } },
      { traceId: 'trace-003', spanId: 'span-003-llm', parentSpanId: 'span-003-root', name: 'bedrock.invoke_model', kind: 'llm', startTimeMs: 400, durationMs: 3200, status: 'ok', attributes: { 'model.id': 'nova-lite-v1', 'tokens.in': 2100, 'tokens.out': 890 } },
      { traceId: 'trace-003', spanId: 'span-003-a2a', parentSpanId: 'span-003-root', name: 'a2a.invoke_graph_builder', kind: 'agent', startTimeMs: 3700, durationMs: 4200, status: 'error', attributes: { 'target.agent': 'orgiq-graph-builder', 'error': 'timeout after 4000ms' } },
      { traceId: 'trace-003', spanId: 'span-003-gb', parentSpanId: 'span-003-a2a', name: 'graph_builder.merge', kind: 'agent', startTimeMs: 3750, durationMs: 4150, status: 'error', attributes: { 'error.type': 'TimeoutError' } },
    ],
  },
];

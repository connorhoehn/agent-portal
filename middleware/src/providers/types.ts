// Provider contracts. All four providers (aurora, agentcore, guardrails, cloudwatch)
// implement these interfaces. Routes consume the interface, not the implementation,
// so mock vs real swap is one line per provider in providers/index.ts.
//
// Shapes deliberately mirror the existing mock types so route swaps are minimal-diff.

// ── Aurora (graph + scores) ───────────────────────────────────────────────────

export interface Person {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  imageUrl?: string;
}

export interface Relationship {
  source: string;
  target: string;
  type: 'collaborates' | 'mentors' | 'reports_to' | 'expert_in_common';
  strength: number;
}

export interface Department {
  id: string;
  name: string;
  color: string;
}

export interface GraphSnapshot {
  nodes: Person[];
  edges: Relationship[];
  departments: Department[];
}

export interface PersonDetail extends Person {
  connections: Array<Relationship & {
    otherPerson: { id: string; name: string; title: string } | null;
  }>;
}

export interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  collaboration: number;
  expertise: number;
  velocity: number;
  quality: number;
  composite: number;
  trend: number[];
}

export interface Leaderboard {
  entries: ScoreEntry[];
  total: number;
}

export interface AuroraProvider {
  fetchGraph(): Promise<GraphSnapshot>;
  fetchPersonGraph(personId: string): Promise<PersonDetail | null>;
  getLeaderboard(opts: { department?: string; limit?: number }): Promise<Leaderboard>;
  getScore(personId: string): Promise<ScoreEntry | null>;
}

// ── AgentCore (runtimes, memory, gateway, capabilities sessions) ───────────────

export interface AgentRuntimeSummary {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'offline' | 'deploying';
  protocol: 'ag-ui' | 'a2a';
  model: string;
  tools: string[];
  guardrails: string[];
  endpoint: string;
  latencyP50Ms: number;
  latencyP99Ms: number;
  invocationsLast24h: number;
  errorsLast24h: number;
  tokensLast24h: number;
}

export interface AgentMetrics {
  agentId: string;
  latencyP50Ms: number;
  latencyP99Ms: number;
  invocationsLast24h: number;
  errorsLast24h: number;
  tokensLast24h: number;
  successRate: string;
}

export interface CodeSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  startedAt: string;
  lastActivityAt: string;
  executionCount: number;
  lastCode: string;
  lastOutput: string;
  memoryUsageMb: number;
}

export interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

export interface AgentInvokeToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

export interface AgentInvokeResult {
  text: string;
  toolCalls?: AgentInvokeToolCall[];
  raw?: unknown;
  runtimeSessionId?: string;
}

export interface BrowserScreenshot {
  sessionId: string;
  imageDataUrl: string; // data:image/png;base64,...
  takenAt: string;
}

export interface CodeExecutionResult {
  sessionId: string;
  output: string;
  durationMs: number;
  error?: string;
}

export interface AgentCoreProvider {
  listRuntimes(): Promise<AgentRuntimeSummary[]>;
  getRuntime(agentId: string): Promise<AgentRuntimeSummary | null>;
  getRuntimeMetrics(agentId: string): Promise<AgentMetrics | null>;
  invokeAgent(agentId: string, payload: { message: string; sessionId?: string }): Promise<AgentInvokeResult>;
  listCodeSessions(): Promise<CodeSession[]>;
  terminateCodeSession(sessionId: string): Promise<boolean>;
  executeCode(code: string, language?: 'python'): Promise<CodeExecutionResult>;
  listBrowserSessions(): Promise<BrowserSession[]>;
  createBrowserSession(opts: { agentName: string; url?: string }): Promise<BrowserSession>;
  closeBrowserSession(sessionId: string): Promise<boolean>;
  navigateBrowser(sessionId: string, url: string): Promise<BrowserSession | null>;
  screenshotBrowser(sessionId: string): Promise<BrowserScreenshot | null>;
}

// ── Guardrails ─────────────────────────────────────────────────────────────────

export interface PiiFilter {
  type: string;
  action: 'ANONYMIZE' | 'BLOCK' | 'NONE';
  enabled: boolean;
}

export interface DeniedTopic {
  name: string;
  definition: string;
  enabled: boolean;
}

export interface ContentPolicy {
  hateEnabled: boolean;
  violenceEnabled: boolean;
  sexualEnabled: boolean;
  insultsEnabled: boolean;
  misconductEnabled: boolean;
  promptAttackEnabled: boolean;
}

export interface GuardrailSnapshot {
  id: string;
  name: string;
  status: string;
  version: string;
  updatedAt: string;
  piiFilters: PiiFilter[];
  contentPolicy: ContentPolicy;
  deniedTopics: DeniedTopic[];
  groundingThreshold: number;
  relevanceThreshold: number;
}

export interface GuardrailsProvider {
  getGuardrail(): Promise<GuardrailSnapshot>;
  togglePiiFilter(type: string, patch: { action?: string; enabled?: boolean }): Promise<PiiFilter | null>;
  updateDeniedTopic(name: string, patch: { enabled?: boolean; definition?: string }): Promise<DeniedTopic | null>;
  addDeniedTopic(topic: { name: string; definition: string }): Promise<DeniedTopic>;
  removeDeniedTopic(name: string): Promise<boolean>;
}

// ── CloudWatch (traces + summary metrics) ──────────────────────────────────────

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

export interface ObservabilitySummary {
  totalInvocations24h: number;
  totalErrors24h: number;
  totalTokens24h: number;
  avgLatencyMs: number;
  successRate: string;
  traceCount: number;
}

export interface GuardrailMetricPoint {
  timestamp: string;
  invocations: number;
  interventions: number;
}

export interface GuardrailMetricsSummary {
  totalInvocations: number;
  totalInterventions: number;
  interventionRate: string;
  series: GuardrailMetricPoint[];
}

export interface CloudWatchProvider {
  getSummary(): Promise<ObservabilitySummary>;
  listTraces(limit: number): Promise<Trace[]>;
  getTrace(traceId: string): Promise<Trace | null>;
  getGuardrailMetrics(guardrailId: string, hours: number): Promise<GuardrailMetricsSummary>;
}

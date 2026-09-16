// Provider contracts. All four providers (aurora, agentcore, guardrails, cloudwatch)
// implement these interfaces. Routes consume the interface, not the implementation,
// so mock vs real swap is one line per provider in providers/index.ts.
//
// Shapes deliberately mirror the existing mock types so route swaps are minimal-diff.

import type { Upstream } from '../lib/upstream.js';

// ── Aurora (graph + scores) ───────────────────────────────────────────────────

export type PresenceStatus =
  | 'office' | 'wfh' | 'travel' | 'pto' | 'vacation' | 'sick' | 'unknown';

export interface Person {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  imageUrl?: string;
  /** Today's presence status — stable within a calendar day, changes nightly. */
  presence?: PresenceStatus;
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
  /**
   * The TRUE count of people in the graph, independent of how many `nodes`
   * carries. `fetchAllPeople` applies a bounded circuit-breaker LIMIT
   * (`PEOPLE_GRAPH_LIMIT` in providers/aurora.ts) so the graph can never grow
   * unbounded server-side — this field is what lets a caller say "showing N
   * of M" instead of the payload silently claiming to be complete.
   */
  peopleTotal: number;
}

export interface PersonDetail extends Person {
  scoredAt: string | null;
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
  scoredAt: string | null;
}

export interface Leaderboard {
  entries: ScoreEntry[];
  total: number;
  mostRecentScoredAt: string | null;
}

export interface SkillSummary {
  id: string;
  name: string;
  mentionCount: number;
}

export interface BrokerSummary {
  id: string;
  name: string;
  departmentsTouched: number;
}

export interface CohortStats {
  department: string;
  count: number;
  medianComposite: number;
  meanComposite: number;
  /** Histogram counts for buckets 0-20, 20-40, 40-60, 60-80, 80-100 */
  compositeBuckets: [number, number, number, number, number];
  /** Gini coefficient of expertise_score within the department (0..1) */
  expertiseGini: number;
  /** People in this dept whose top-3 collaborators span ≥3 distinct depts */
  brokers: BrokerSummary[];
}

export interface RadarBatchEntry {
  personId: string;
  name: string;
  person: RadarAxes;
  peerMax: RadarAxes;
}

// ── Multi-entity graph snapshots ─────────────────────────────────────────────

export interface SkillNode {
  id: string;       // "skill:<uuid>"
  name: string;
  domain: string;   // parent taxonomy category (maps to SkillDomain.name)
  personCount: number;
}

export interface SkillDomain {
  id: string;       // "domain:<name>"
  name: string;
  skillCount: number;
}

export interface PersonSkillEdge {
  personId: string;
  skillId: string;  // "skill:<uuid>"
  weight: number;
}

export interface SkillsGraphSnapshot {
  domains: SkillDomain[];
  skills: SkillNode[];
  people: Person[];
  personSkillEdges: PersonSkillEdge[];
  /** See GraphSnapshot.peopleTotal — same circuit breaker, same contract. */
  peopleTotal: number;
}

export interface ProjectNode {
  id: string;       // "proj:<uuid>"
  name: string;
  status: string;   // 'active' | 'planning' | 'archived'
  contributorCount: number;
}

export interface ProjectPersonEdge {
  personId: string;
  projectId: string; // "proj:<uuid>"
  weight: number;
}

export interface ProjectsGraphSnapshot {
  projects: ProjectNode[];
  people: Person[];
  personProjectEdges: ProjectPersonEdge[];
  /** See GraphSnapshot.peopleTotal — same circuit breaker, same contract. */
  peopleTotal: number;
}

/** A document that mentions a person — the "how do we know?" behind a skill/score. */
export interface EvidenceDoc {
  id: string;
  title: string;
  source: string;
  sourceUri: string | null;
  ingestedAt: string | null;
  mentionCount: number;
}

export interface AuroraProvider {
  fetchGraph(): Promise<GraphSnapshot>;
  fetchSkillsGraph(): Promise<SkillsGraphSnapshot>;
  fetchProjectsGraph(): Promise<ProjectsGraphSnapshot>;
  fetchPersonGraph(personId: string): Promise<PersonDetail | null>;
  getLeaderboard(opts: { department?: string; limit?: number }): Promise<Leaderboard>;
  getScore(personId: string): Promise<ScoreEntry | null>;
  getSkillLeaderboard(opts: { skill: string; limit?: number }): Promise<Leaderboard>;
  getTopSkills(limit?: number): Promise<SkillSummary[]>;
  getCohorts(): Promise<CohortStats[]>;
  getPersonRadar(personId: string): Promise<RadarResponse | null>;
  getContributions(personId: string): Promise<ContributionsResponse | null>;
  getRadarBatch(personIds: string[]): Promise<RadarBatchEntry[]>;
  fetchPersonEvidence(personId: string): Promise<EvidenceDoc[]>;
}

export interface CollaboratorContribution {
  otherId: string;
  otherName: string;
  weight: number;
}

export interface ProjectContribution {
  projectName: string;
  role: string | null;
  weight: number;
}

export interface DecisionContribution {
  topic: string;
  role: string | null;
  weight: number;
}

export interface ContributionsResponse {
  personId: string;
  collaborators: CollaboratorContribution[];
  projects: ProjectContribution[];
  decisions: DecisionContribution[];
}

export interface HistorySample {
  ts: string;
  score: number;
}

export interface HistoryResponse {
  personId: string;
  samples: HistorySample[];
  deltaVs7d: number | null;
}

export interface RadarAxes {
  influence: number;
  expertise: number;
  collaborationBreadth: number;
  decisionImpact: number;
  crossTeamReach: number;
  recency: number;
}

export interface RadarResponse {
  personId: string;
  person: RadarAxes;
  peerMax: RadarAxes;
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

export interface SandboxExecution {
  code: string;
  output: string;
  durationMs: number;
  sessionId: string;
  timestamp: string;
  error?: string;
}

export interface AgentInvokeResult {
  text: string;
  toolCalls?: AgentInvokeToolCall[];
  raw?: unknown;
  runtimeSessionId?: string;
  sandboxExecutions?: SandboxExecution[];
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
  /**
   * The fleet, with the failure discarded.
   *
   * `GET /api/agents` no longer uses it — that route now answers
   * `{ agents, degraded?, error? }` off `listRuntimesResult`. What is left is
   * providers/cloudwatch.ts, which catches for itself. An empty array from
   * here means "the fleet is empty OR we could not ask" and nothing downstream
   * can tell which, so any NEW caller wants `listRuntimesResult`; this one
   * survives for the callers that genuinely have nowhere to put a marker.
   */
  listRuntimes(): Promise<AgentRuntimeSummary[]>;
  /**
   * The fleet, and whether this is a reading of the control plane.
   *
   * See lib/upstream.ts. An empty `items` with `degraded: true` is
   * "ListAgentRuntimes failed"; an empty `items` without it is "nothing is
   * deployed" — the distinction agent-detail's 404 used to destroy.
   */
  listRuntimesResult(): Promise<Upstream<AgentRuntimeSummary[]>>;
  getRuntime(agentId: string): Promise<AgentRuntimeSummary | null>;
  getRuntimeMetrics(agentId: string): Promise<AgentMetrics | null>;
  invokeAgent(agentId: string, payload: {
    message: string;
    sessionId?: string;
    userId?: string;
    auth?: { sub: string; role: string };
    history?: { role: string; content: string }[];
  }): Promise<AgentInvokeResult>;
  invokeAgentStreaming(agentId: string, payload: {
    message: string;
    sessionId?: string;
    userId?: string;
    auth?: { sub: string; role: string };
    history?: { role: string; content: string }[];
  }): AsyncIterable<unknown>;
  /** Sessions, failure discarded — prefer `listCodeSessionsResult`. */
  listCodeSessions(): Promise<CodeSession[]>;
  /** Sessions, and whether the data plane could be reached. */
  listCodeSessionsResult(): Promise<Upstream<CodeSession[]>>;
  terminateCodeSession(sessionId: string): Promise<boolean>;
  executeCode(code: string, language?: 'python'): Promise<CodeExecutionResult>;
  /** Sessions, failure discarded — prefer `listBrowserSessionsResult`. */
  listBrowserSessions(): Promise<BrowserSession[]>;
  /** Sessions, and whether the data plane could be reached. */
  listBrowserSessionsResult(): Promise<Upstream<BrowserSession[]>>;
  createBrowserSession(opts: { agentName: string; url?: string }): Promise<BrowserSession>;
  closeBrowserSession(sessionId: string): Promise<boolean>;
  navigateBrowser(sessionId: string, url: string): Promise<BrowserSession | null>;
  screenshotBrowser(sessionId: string): Promise<BrowserScreenshot | null>;
  evaluateInBrowser(sessionId: string, expression: string): Promise<unknown>;
  /** Send a left-button mouseClick at the given pixel coordinates. Used by the
   *  crawler's SPA mode to traverse JS-driven nav links the model identified. */
  clickBrowser(sessionId: string, x: number, y: number): Promise<boolean>;
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
  /** null when nothing ran in the window — see cloudwatch.ts. */
  avgLatencyMs: number | null;
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

export interface BedrockInvocationEntry {
  requestId: string;
  timestamp: string;
  agent: string;        // derived from execution role ARN
  modelId: string;
  operation: string;    // ConverseStream | Converse | InvokeModel
  promptSnippet: string;
  responseSnippet: string;
  inputTokens: number;
  outputTokens: number;
  durationGuess: number; // not directly logged — leave 0
  intervened: boolean;
  interventions: Array<{
    source: 'INPUT' | 'OUTPUT';
    policyType: string;       // TopicPolicy, SensitiveInformationPolicy, etc.
    detail: string;           // matched topic name / PII type / etc.
  }>;
}

export interface CloudWatchProvider {
  getSummary(): Promise<ObservabilitySummary>;
  listTraces(limit: number): Promise<Trace[]>;
  getTrace(traceId: string): Promise<Trace | null>;
  getGuardrailMetrics(guardrailId: string, hours: number): Promise<GuardrailMetricsSummary>;
  listBedrockInvocations(opts: { limit: number; sinceMs?: number }): Promise<BedrockInvocationEntry[]>;
}

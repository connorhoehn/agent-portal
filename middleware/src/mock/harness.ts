// Mock fixture + in-memory store for the regression-test harness
// (routes/harness.ts). Every route there calls providers/aurora.ts's `exec`
// directly — a raw RDS Data API caller with no mock branch of its own — so
// under MOCK_AURORA every harness endpoint threw straight through
// asyncHandler into a bare 500, and HarnessHomePage's three cards (cases,
// runs, coverage) all rendered "Couldn't load".
//
// This mirrors the shape observability.test_cases / test_runs / test_results
// would hold for a small, plausible demo history: four cases across the
// OrgIQ + newsroom agents, two completed runs (one middling, one improved
// after a prompt tweak) with per-case results, and the coverage rollup that
// falls out of them. Mutable in-memory arrays so POST /cases and POST /runs
// still work in a demo session (mirrors lib/mock-bot-runner.ts's pattern of a
// live-feeling mock rather than a frozen fixture) — resets on restart, same
// as every other in-memory mock in this file tree.

export interface MockTestCase {
  testId: string;
  agentId: string;
  templateId: string | null;
  prompt: string;
  referenceOutput: string | null;
  expectedTags: string[];
  rubricOverride: string | null;
  passThreshold: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

export interface MockTestRun {
  runId: string;
  label: string;
  gitSha: string | null;
  judgeModelId: string;
  agentVersions: Record<string, string>;
  status: 'pending' | 'running' | 'done' | 'failed';
  totalCases: number;
  completed: number;
  passed: number;
  failed: number;
  passRate: number | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  mode: 'live' | 'sim';
}

export interface MockTestResult {
  runId: string;
  testId: string;
  invocationId: string | null;
  passed: boolean | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  tagHits: Record<string, boolean> | null;
  referenceSimilarity: number | null;
  responseSnippet: string | null;
  failReasons: string[] | null;
  durationMs: number | null;
  ts: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
  agentId?: string;
  prompt?: string;
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

export const mockTestCases: MockTestCase[] = [
  {
    testId: 'orgiq-search-kubernetes-experts-a1b2c3',
    agentId: 'orgiq-search',
    templateId: null,
    prompt: 'Who are our Kubernetes experts?',
    referenceOutput: 'Names people with high pagerank/expertise scores on the Kubernetes skill, with their team.',
    expectedTags: ['name', 'team'],
    rubricOverride: null,
    passThreshold: 0.7,
    active: true,
    createdAt: daysAgo(21),
    updatedAt: daysAgo(21),
    notes: 'Baseline search regression case.',
  },
  {
    testId: 'orgiq-supervisor-who-knows-auth-d4e5f6',
    agentId: 'orgiq-supervisor',
    templateId: null,
    prompt: 'Who knows auth best on the platform team?',
    referenceOutput: 'Routes to search, surfaces a ranked list with evidence.',
    expectedTags: ['name', 'evidence'],
    rubricOverride: null,
    passThreshold: 0.7,
    active: true,
    createdAt: daysAgo(20),
    updatedAt: daysAgo(6),
    notes: null,
  },
  {
    testId: 'orgiq-advisor-onboarding-plan-g7h8i9',
    agentId: 'orgiq-advisor',
    templateId: null,
    prompt: 'Draft a 30-day onboarding plan for a new SRE joining the platform team.',
    referenceOutput: 'A week-by-week plan referencing real docs/decisions, not generic advice.',
    expectedTags: ['week 1', 'week 2'],
    rubricOverride: null,
    passThreshold: 0.65,
    active: true,
    createdAt: daysAgo(18),
    updatedAt: daysAgo(18),
    notes: null,
  },
  {
    testId: 'orgiq-news-researcher-cluster-brief-j1k2l3',
    agentId: 'orgiq-news-researcher',
    templateId: null,
    prompt: 'Summarize the top story cluster from this week for the news desk.',
    referenceOutput: 'A short brief naming the cluster and its lead entities.',
    expectedTags: ['cluster'],
    rubricOverride: null,
    passThreshold: 0.7,
    active: true,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
    notes: null,
  },
];

const RUN_A = 'a0000000-0000-4000-8000-00000000a001';
const RUN_B = 'b0000000-0000-4000-8000-00000000b002';

export const mockTestRuns: MockTestRun[] = [
  {
    runId: RUN_A,
    label: 'nightly-2026-08-19',
    gitSha: 'a1b2c3d',
    judgeModelId: 'amazon.nova-pro-v1:0',
    agentVersions: { 'orgiq-search': 'sha-1a2b3c', 'orgiq-supervisor': 'sha-4d5e6f' },
    status: 'done',
    totalCases: 4,
    completed: 4,
    passed: 3,
    failed: 1,
    passRate: 0.75,
    startedAt: daysAgo(7),
    finishedAt: daysAgo(7),
    notes: null,
    mode: 'sim',
  },
  {
    runId: RUN_B,
    label: 'nightly-2026-08-24',
    gitSha: 'e7f8a9b',
    judgeModelId: 'amazon.nova-pro-v1:0',
    agentVersions: { 'orgiq-search': 'sha-1a2b3c', 'orgiq-supervisor': 'sha-7g8h9i' },
    status: 'done',
    totalCases: 4,
    completed: 4,
    passed: 4,
    failed: 0,
    passRate: 1.0,
    startedAt: daysAgo(2),
    finishedAt: daysAgo(2),
    notes: 'Prompt tweak on orgiq-supervisor fixed the auth-routing miss.',
    mode: 'sim',
  },
];

export const mockTestResults: Record<string, MockTestResult[]> = {
  [RUN_A]: [
    {
      runId: RUN_A, testId: mockTestCases[0]!.testId, invocationId: null,
      passed: true, judgeScore: 0.86, judgeRationale: 'Named three Kubernetes SMEs with team + evidence.',
      schemaValid: true, tagHits: { name: true, team: true }, referenceSimilarity: 0.81,
      responseSnippet: 'Nora Vance (Platform Engineering) and two others lead on Kubernetes...',
      failReasons: null, durationMs: 2150, ts: daysAgo(7),
      inputTokens: 410, outputTokens: 180, estCostUsd: 0.0021,
    },
    {
      runId: RUN_A, testId: mockTestCases[1]!.testId, invocationId: null,
      passed: false, judgeScore: 0.58, judgeRationale: 'Routed to advisor instead of search; no named evidence.',
      schemaValid: true, tagHits: { name: false, evidence: false }, referenceSimilarity: 0.4,
      responseSnippet: 'Auth ownership generally sits with the platform team...',
      failReasons: ['missing_tag:name', 'missing_tag:evidence'], durationMs: 3020, ts: daysAgo(7),
      inputTokens: 520, outputTokens: 210, estCostUsd: 0.0027,
    },
    {
      runId: RUN_A, testId: mockTestCases[2]!.testId, invocationId: null,
      passed: true, judgeScore: 0.74, judgeRationale: 'Plan referenced real onboarding docs by week.',
      schemaValid: true, tagHits: { 'week 1': true, 'week 2': true }, referenceSimilarity: 0.7,
      responseSnippet: 'Week 1: shadow on-call, read the platform runbook...',
      failReasons: null, durationMs: 4110, ts: daysAgo(7),
      inputTokens: 640, outputTokens: 380, estCostUsd: 0.0041,
    },
    {
      runId: RUN_A, testId: mockTestCases[3]!.testId, invocationId: null,
      passed: true, judgeScore: 0.79, judgeRationale: 'Correctly named the lead cluster and its entities.',
      schemaValid: true, tagHits: { cluster: true }, referenceSimilarity: 0.68,
      responseSnippet: 'The "AI regulation" cluster led this week with 6 linked articles...',
      failReasons: null, durationMs: 1890, ts: daysAgo(7),
      inputTokens: 380, outputTokens: 160, estCostUsd: 0.0019,
    },
  ],
  [RUN_B]: [
    {
      runId: RUN_B, testId: mockTestCases[0]!.testId, invocationId: null,
      passed: true, judgeScore: 0.88, judgeRationale: 'Same strong result, slightly tighter phrasing.',
      schemaValid: true, tagHits: { name: true, team: true }, referenceSimilarity: 0.83,
      responseSnippet: 'Nora Vance and two teammates on Platform Engineering lead on Kubernetes...',
      failReasons: null, durationMs: 2080, ts: daysAgo(2),
      inputTokens: 405, outputTokens: 175, estCostUsd: 0.0021,
    },
    {
      runId: RUN_B, testId: mockTestCases[1]!.testId, invocationId: null,
      passed: true, judgeScore: 0.83, judgeRationale: 'Prompt fix routed to search; named Diana with evidence.',
      schemaValid: true, tagHits: { name: true, evidence: true }, referenceSimilarity: 0.77,
      responseSnippet: 'Diana Martinez owns auth on the platform team, per the Q2 ADR...',
      failReasons: null, durationMs: 2640, ts: daysAgo(2),
      inputTokens: 510, outputTokens: 205, estCostUsd: 0.0026,
    },
    {
      runId: RUN_B, testId: mockTestCases[2]!.testId, invocationId: null,
      passed: true, judgeScore: 0.76, judgeRationale: 'Still solid on both weeks.',
      schemaValid: true, tagHits: { 'week 1': true, 'week 2': true }, referenceSimilarity: 0.71,
      responseSnippet: 'Week 1: shadow on-call, meet the SRE leads...',
      failReasons: null, durationMs: 3980, ts: daysAgo(2),
      inputTokens: 630, outputTokens: 365, estCostUsd: 0.004,
    },
    {
      runId: RUN_B, testId: mockTestCases[3]!.testId, invocationId: null,
      passed: true, judgeScore: 0.81, judgeRationale: 'Named cluster + entities, slightly more concise.',
      schemaValid: true, tagHits: { cluster: true }, referenceSimilarity: 0.7,
      responseSnippet: 'The "AI regulation" cluster remained the lead story...',
      failReasons: null, durationMs: 1820, ts: daysAgo(2),
      inputTokens: 375, outputTokens: 150, estCostUsd: 0.0018,
    },
  ],
};

// ── Mutable store (POST/PATCH keep working in a demo session) ─────────────

const cases: MockTestCase[] = mockTestCases.map((c) => ({ ...c }));
const runs: MockTestRun[] = mockTestRuns.map((r) => ({ ...r }));
const results: Record<string, MockTestResult[]> = Object.fromEntries(
  Object.entries(mockTestResults).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
);

export function mockListCases(includeInactive: boolean): MockTestCase[] {
  return cases
    .filter((c) => includeInactive || c.active)
    .slice()
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.testId.localeCompare(b.testId));
}

export function mockGetCase(id: string): MockTestCase | null {
  return cases.find((c) => c.testId === id) ?? null;
}

export function mockUpsertCase(input: Partial<MockTestCase> & { testId: string; agentId: string; prompt: string }): string {
  const now = new Date().toISOString();
  const existing = cases.find((c) => c.testId === input.testId);
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
    return existing.testId;
  }
  cases.push({
    testId: input.testId,
    agentId: input.agentId,
    templateId: input.templateId ?? null,
    prompt: input.prompt,
    referenceOutput: input.referenceOutput ?? null,
    expectedTags: input.expectedTags ?? [],
    rubricOverride: input.rubricOverride ?? null,
    passThreshold: input.passThreshold ?? 0.7,
    active: input.active ?? true,
    createdAt: now,
    updatedAt: now,
    notes: input.notes ?? null,
  });
  return input.testId;
}

export function mockPatchCase(id: string, patch: Partial<MockTestCase>): boolean {
  const existing = cases.find((c) => c.testId === id);
  if (!existing) return false;
  Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
  return true;
}

export function mockDeleteCase(id: string): boolean {
  const existing = cases.find((c) => c.testId === id);
  if (!existing) return false;
  existing.active = false;
  existing.updatedAt = new Date().toISOString();
  return true;
}

export function mockListRuns(limit: number): MockTestRun[] {
  return runs
    .slice()
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

export function mockGetRun(id: string): MockTestRun | null {
  return runs.find((r) => r.runId === id) ?? null;
}

export function mockGetResults(runId: string): MockTestResult[] {
  const rows = results[runId] ?? [];
  const byCase = new Map(cases.map((c) => [c.testId, c]));
  return rows.map((r) => {
    const c = byCase.get(r.testId);
    return c ? { ...r, agentId: c.agentId, prompt: c.prompt } : { ...r };
  });
}

export function mockCreateRun(input: {
  label?: string; gitSha?: string | null; judgeModelId?: string;
  agentVersions?: Record<string, string>; notes?: string | null; totalCases?: number; mode?: 'live' | 'sim';
}): { runId: string; mode: 'live' | 'sim' } {
  const runId = `mock-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
  const mode: 'live' | 'sim' = input.mode === 'live' ? 'live' : 'sim';
  runs.push({
    runId,
    label: input.label?.trim() || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    gitSha: input.gitSha ?? null,
    judgeModelId: input.judgeModelId?.trim() || 'amazon.nova-pro-v1:0',
    agentVersions: input.agentVersions ?? {},
    status: 'pending',
    totalCases: input.totalCases ?? 0,
    completed: 0,
    passed: 0,
    failed: 0,
    passRate: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    notes: input.notes ?? null,
    mode,
  });
  results[runId] = [];
  return { runId, mode };
}

export function mockCoverage(): Array<{
  agentId: string; count: number; lastRunPassed?: number; lastRunTotal?: number; lastRunAt?: string;
}> {
  const byAgent = new Map<string, number>();
  for (const c of cases) {
    if (!c.active) continue;
    byAgent.set(c.agentId, (byAgent.get(c.agentId) ?? 0) + 1);
  }
  // "Last run" per agent = the most recent run touching that agent's cases.
  const latestRun = runs
    .slice()
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  const latestResults = latestRun ? mockGetResults(latestRun.runId) : [];

  return Array.from(byAgent.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentId, count]) => {
      const forAgent = latestResults.filter((r) => r.agentId === agentId);
      const row: { agentId: string; count: number; lastRunPassed?: number; lastRunTotal?: number; lastRunAt?: string } = {
        agentId, count,
      };
      if (forAgent.length > 0 && latestRun) {
        row.lastRunPassed = forAgent.filter((r) => r.passed).length;
        row.lastRunTotal = forAgent.length;
        row.lastRunAt = latestRun.startedAt;
      }
      return row;
    });
}

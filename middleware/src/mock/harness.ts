// The regression-test harness's cases, runs and results (routes/harness.ts
// under MOCK_AURORA).
//
// Every route in routes/harness.ts calls providers/aurora.ts's `exec` — a raw
// RDS Data API caller with no mock branch of its own — so offline every
// endpoint threw into a bare 500 and HarnessHomePage's three cards all
// rendered "Couldn't load". These fixtures are that branch.
//
// WHAT THE FLOOR CHANGED HERE. A run used to carry `totalCases: 4,
// completed: 4, passed: 3, failed: 1, passRate: 0.75` as typed fields, sitting
// directly above the four result rows those five numbers describe. They were
// right when written and there was nothing keeping them right: flip one
// result's `passed` and the run still claims 3/4, exactly the way Health
// claimed 25 errors over a list of 6. All five are counted from the run's own
// results now. A run with no results yet — one this process just created —
// reports zeros and a null pass rate, which is what "pending" honestly means.
//
// The three in-memory arrays that made POST/PATCH stick are fixtures too, so
// `POST /api/__mock/reset` takes an audit's edits back instead of the audit
// having to warn the next reader that the store gained a case.

import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';

// Run-id uniqueness comes from a counter, not a clock read — `Date.now()` in
// an id suffix means freezing the clock in a test collapses every run created
// in that test to the same id.
let runIdSeq = 0;

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

/** A run as the fixture stores it: identity and provenance, no arithmetic. */
export interface MockTestRunSeed {
  runId: string;
  label: string;
  gitSha: string | null;
  judgeModelId: string;
  agentVersions: Record<string, string>;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  mode: 'live' | 'sim';
}

/** The wire shape, with the five counted fields attached. */
export interface MockTestRun extends MockTestRunSeed {
  totalCases: number;
  completed: number;
  passed: number;
  failed: number;
  passRate: number | null;
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

/**
 * What `POST /runs/:runId/results` may write.
 *
 * `runId` and `ts` are not here: the first is the path parameter and the second
 * is `now()` in the statement, so neither is ever the caller's to supply. The
 * joined `agentId`/`prompt` are not here either — they belong to the case, and
 * `mockGetResults` joins them on the way out.
 */
export interface MockResultInput {
  testId: string;
  invocationId?: string | null;
  passed?: boolean | null;
  judgeScore?: number | null;
  judgeRationale?: string | null;
  schemaValid?: boolean | null;
  tagHits?: Record<string, boolean> | null;
  referenceSimilarity?: number | null;
  responseSnippet?: string | null;
  failReasons?: string[] | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
}

const RUN_A = 'a0000000-0000-4000-8000-00000000a001';
const RUN_B = 'b0000000-0000-4000-8000-00000000b002';

const CASE_SEARCH = 'orgiq-search-kubernetes-experts-a1b2c3';
const CASE_SUPERVISOR = 'orgiq-supervisor-who-knows-auth-d4e5f6';
const CASE_ADVISOR = 'orgiq-advisor-onboarding-plan-g7h8i9';
const CASE_SCORING = 'orgiq-scoring-recompute-expertise-j1k2l3';

// ── Cases ──────────────────────────────────────────────────────────────────

/**
 * Test cases.
 *
 * `empty` — no case has been written yet. The harness home page's coverage
 *           card and its "add a case" call to action are both written for this
 *           state, and it was previously reachable only by deactivating all
 *           four seeded cases in a shared dev server.
 */
export const testCases = defineFixture<MockTestCase>({
  key: 'harness-cases',
  scenarios: {
    default: () => [
      {
        testId: CASE_SEARCH,
        agentId: 'orgiq-search',
        templateId: null,
        prompt: 'Who are our Kubernetes experts?',
        referenceOutput: 'Names people with high pagerank/expertise scores on the Kubernetes skill, with their team.',
        expectedTags: ['name', 'team'],
        rubricOverride: null,
        passThreshold: 0.7,
        active: true,
        createdAt: clock.daysAgo(21),
        updatedAt: clock.daysAgo(21),
        notes: 'Baseline search regression case.',
      },
      {
        testId: CASE_SUPERVISOR,
        agentId: 'orgiq-supervisor',
        templateId: null,
        prompt: 'Who knows auth best on the platform team?',
        referenceOutput: 'Routes to search, surfaces a ranked list with evidence.',
        expectedTags: ['name', 'evidence'],
        rubricOverride: null,
        passThreshold: 0.7,
        active: true,
        createdAt: clock.daysAgo(20),
        updatedAt: clock.daysAgo(6),
        notes: null,
      },
      {
        testId: CASE_ADVISOR,
        agentId: 'orgiq-advisor',
        templateId: null,
        prompt: 'Draft a 30-day onboarding plan for a new SRE joining the platform team.',
        referenceOutput: 'A week-by-week plan referencing real docs/decisions, not generic advice.',
        expectedTags: ['week 1', 'week 2'],
        rubricOverride: null,
        passThreshold: 0.65,
        active: true,
        createdAt: clock.daysAgo(18),
        updatedAt: clock.daysAgo(18),
        notes: null,
      },
      {
        testId: CASE_SCORING,
        agentId: 'orgiq-scoring',
        templateId: null,
        prompt: "Recompute expertise scores for the platform team after last week's postmortem.",
        referenceOutput: 'Updated composite scores referencing the postmortem as new evidence.',
        expectedTags: ['expertise', 'composite'],
        rubricOverride: null,
        passThreshold: 0.7,
        active: true,
        createdAt: clock.daysAgo(10),
        updatedAt: clock.daysAgo(10),
        notes: null,
      },
    ],
    empty: () => [],
  },
});

// ── Runs ───────────────────────────────────────────────────────────────────

/**
 * Runs.
 *
 * `empty` — cases exist but nothing has been run against them. That is a
 *           genuinely different state from "no cases", and the two used to
 *           look identical in dev:mock.
 */
export const testRuns = defineFixture<MockTestRunSeed>({
  key: 'harness-runs',
  scenarios: {
    default: () => [
      {
        runId: RUN_A,
        label: 'nightly-2026-08-19',
        gitSha: 'a1b2c3d',
        judgeModelId: 'amazon.nova-pro-v1:0',
        agentVersions: { 'orgiq-search': 'sha-1a2b3c', 'orgiq-supervisor': 'sha-4d5e6f' },
        status: 'done',
        startedAt: clock.daysAgo(7),
        finishedAt: clock.daysAgo(7),
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
        startedAt: clock.daysAgo(2),
        finishedAt: clock.daysAgo(2),
        notes: 'Prompt tweak on orgiq-supervisor fixed the auth-routing miss.',
        mode: 'sim',
      },
    ],
    empty: () => [],
  },
});

// ── Results ────────────────────────────────────────────────────────────────

/**
 * Results, flat and keyed by `runId` on the row rather than nested under one.
 *
 * Flat because that is what the table is — `observability.test_results` has a
 * `run_id` column — and because a nested map cannot be a fixture: `rows()`
 * returns a list, and `resetAll` has to be able to hand one back.
 *
 * `empty` — no run has produced a result. Kept separate from `harness-runs`
 *           so an auditor can see a run that is genuinely mid-flight: rows for
 *           the run, none for its cases.
 */
export const testResults = defineFixture<MockTestResult>({
  key: 'harness-results',
  scenarios: {
    default: (): MockTestResult[] => [
      {
        runId: RUN_A, testId: CASE_SEARCH, invocationId: null,
        passed: true, judgeScore: 0.86, judgeRationale: 'Named three Kubernetes SMEs with team + evidence.',
        schemaValid: true, tagHits: { name: true, team: true }, referenceSimilarity: 0.81,
        responseSnippet: 'Nora Vance (Platform Engineering) and two others lead on Kubernetes...',
        failReasons: null, durationMs: 2150, ts: clock.daysAgo(7),
        inputTokens: 410, outputTokens: 180, estCostUsd: 0.0021,
      },
      {
        runId: RUN_A, testId: CASE_SUPERVISOR, invocationId: null,
        passed: false, judgeScore: 0.58, judgeRationale: 'Routed to advisor instead of search; no named evidence.',
        schemaValid: true, tagHits: { name: false, evidence: false }, referenceSimilarity: 0.4,
        responseSnippet: 'Auth ownership generally sits with the platform team...',
        failReasons: ['missing_tag:name', 'missing_tag:evidence'], durationMs: 3020, ts: clock.daysAgo(7),
        inputTokens: 520, outputTokens: 210, estCostUsd: 0.0027,
      },
      {
        runId: RUN_A, testId: CASE_ADVISOR, invocationId: null,
        passed: true, judgeScore: 0.74, judgeRationale: 'Plan referenced real onboarding docs by week.',
        schemaValid: true, tagHits: { 'week 1': true, 'week 2': true }, referenceSimilarity: 0.7,
        responseSnippet: 'Week 1: shadow on-call, read the platform runbook...',
        failReasons: null, durationMs: 4110, ts: clock.daysAgo(7),
        inputTokens: 640, outputTokens: 380, estCostUsd: 0.0041,
      },
      {
        runId: RUN_A, testId: CASE_SCORING, invocationId: null,
        passed: true, judgeScore: 0.79, judgeRationale: 'Rescored the team and cited the postmortem as the new evidence.',
        schemaValid: true, tagHits: { expertise: true, composite: true }, referenceSimilarity: 0.68,
        responseSnippet: 'Recomputed composites for 14 people; Priya Desai +0.06 on the postmortem citation...',
        failReasons: null, durationMs: 1890, ts: clock.daysAgo(7),
        inputTokens: 380, outputTokens: 160, estCostUsd: 0.0019,
      },
      {
        runId: RUN_B, testId: CASE_SEARCH, invocationId: null,
        passed: true, judgeScore: 0.88, judgeRationale: 'Same strong result, slightly tighter phrasing.',
        schemaValid: true, tagHits: { name: true, team: true }, referenceSimilarity: 0.83,
        responseSnippet: 'Nora Vance and two teammates on Platform Engineering lead on Kubernetes...',
        failReasons: null, durationMs: 2080, ts: clock.daysAgo(2),
        inputTokens: 405, outputTokens: 175, estCostUsd: 0.0021,
      },
      {
        runId: RUN_B, testId: CASE_SUPERVISOR, invocationId: null,
        passed: true, judgeScore: 0.83, judgeRationale: 'Prompt fix routed to search; named Diana with evidence.',
        schemaValid: true, tagHits: { name: true, evidence: true }, referenceSimilarity: 0.77,
        responseSnippet: 'Diana Martinez owns auth on the platform team, per the Q2 ADR...',
        failReasons: null, durationMs: 2640, ts: clock.daysAgo(2),
        inputTokens: 510, outputTokens: 205, estCostUsd: 0.0026,
      },
      {
        runId: RUN_B, testId: CASE_ADVISOR, invocationId: null,
        passed: true, judgeScore: 0.76, judgeRationale: 'Still solid on both weeks.',
        schemaValid: true, tagHits: { 'week 1': true, 'week 2': true }, referenceSimilarity: 0.71,
        responseSnippet: 'Week 1: shadow on-call, meet the SRE leads...',
        failReasons: null, durationMs: 3980, ts: clock.daysAgo(2),
        inputTokens: 630, outputTokens: 365, estCostUsd: 0.004,
      },
      {
        runId: RUN_B, testId: CASE_SCORING, invocationId: null,
        passed: true, judgeScore: 0.81, judgeRationale: 'Cited the postmortem and moved the right two composites.',
        schemaValid: true, tagHits: { expertise: true, composite: true }, referenceSimilarity: 0.7,
        responseSnippet: 'Recomputed composites for 14 people; two movers, both traceable to the postmortem...',
        failReasons: null, durationMs: 1820, ts: clock.daysAgo(2),
        inputTokens: 375, outputTokens: 150, estCostUsd: 0.0018,
      },
    ],
    empty: () => [],
  },
});

/** Live views — see mock/live.ts. Kept for anything reading the seed directly. */
export const mockTestCases: MockTestCase[] = liveRows(testCases);
export const mockTestResults: MockTestResult[] = liveRows(testResults);

// ── Selectors ──────────────────────────────────────────────────────────────

/**
 * A run's five counted fields, taken over its own results.
 *
 * `completed` is the number of results that reached a verdict; a `passed` of
 * `null` is a case that ran and was not judged, which is neither a pass nor a
 * failure and must not be counted as either. `passRate` is null rather than 0
 * when nothing has completed — 0 would read as "everything failed".
 */
function withCounts(seed: MockTestRunSeed, results: MockTestResult[]): MockTestRun {
  const mine = results.filter((r) => r.runId === seed.runId);
  const completed = mine.filter((r) => r.passed !== null);
  const passed = completed.filter((r) => r.passed === true).length;
  return {
    ...seed,
    totalCases: mine.length,
    completed: completed.length,
    passed,
    failed: completed.length - passed,
    passRate: completed.length > 0 ? passed / completed.length : null,
  };
}

function runsWithCounts(): MockTestRun[] {
  const results = testResults.rows();
  return testRuns.rows().map((seed) => withCounts(seed, results));
}

/** The runs list, with each run's numbers counted from its results. */
export const mockTestRuns: MockTestRun[] = liveRows<MockTestRun>({
  key: testRuns.key,
  rows: runsWithCounts,
  reset: (scenario) => testRuns.reset(scenario),
});

export function mockListCases(includeInactive: boolean): MockTestCase[] {
  return testCases
    .rows()
    .filter((c) => includeInactive || c.active)
    .slice()
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.testId.localeCompare(b.testId));
}

export function mockGetCase(id: string): MockTestCase | null {
  return testCases.rows().find((c) => c.testId === id) ?? null;
}

export function mockUpsertCase(
  input: Partial<MockTestCase> & { testId: string; agentId: string; prompt: string },
): string {
  const now = clock.nowIso();
  const cases = testCases.rows();
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
  const existing = testCases.rows().find((c) => c.testId === id);
  if (!existing) return false;
  Object.assign(existing, patch, { updatedAt: clock.nowIso() });
  return true;
}

export function mockDeleteCase(id: string): boolean {
  const existing = testCases.rows().find((c) => c.testId === id);
  if (!existing) return false;
  existing.active = false;
  existing.updatedAt = clock.nowIso();
  return true;
}

export function mockListRuns(limit: number): MockTestRun[] {
  return runsWithCounts()
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

export function mockGetRun(id: string): MockTestRun | null {
  const seed = testRuns.rows().find((r) => r.runId === id);
  return seed ? withCounts(seed, testResults.rows()) : null;
}

export function mockGetResults(runId: string): MockTestResult[] {
  const byCase = new Map(testCases.rows().map((c) => [c.testId, c]));
  return testResults
    .rows()
    .filter((r) => r.runId === runId)
    .map((r) => {
      const c = byCase.get(r.testId);
      return c ? { ...r, agentId: c.agentId, prompt: c.prompt } : { ...r };
    });
}

export function mockCreateRun(input: {
  label?: string;
  gitSha?: string | null;
  judgeModelId?: string;
  agentVersions?: Record<string, string>;
  notes?: string | null;
  totalCases?: number;
  mode?: 'live' | 'sim';
}): { runId: string; mode: 'live' | 'sim' } {
  const runId = `mock-${Math.random().toString(16).slice(2)}-${(runIdSeq++).toString(16)}`;
  const mode: 'live' | 'sim' = input.mode === 'live' ? 'live' : 'sim';
  // `input.totalCases` is deliberately NOT stored. A run's totals are counted
  // from its results, and a run that has produced none has run none — a stored
  // "4 cases" over an empty result list is the defect this fixture just lost.
  testRuns.rows().push({
    runId,
    label: input.label?.trim() || `run-${clock.nowIso().replace(/[:.]/g, '-')}`,
    gitSha: input.gitSha ?? null,
    judgeModelId: input.judgeModelId?.trim() || 'amazon.nova-pro-v1:0',
    agentVersions: input.agentVersions ?? {},
    status: 'pending',
    startedAt: clock.nowIso(),
    finishedAt: null,
    notes: input.notes ?? null,
    mode,
  });
  return { runId, mode };
}

/**
 * `POST /runs/:runId/results` — upsert one result row.
 *
 * The real statement is an `INSERT … ON CONFLICT (run_id, test_id) DO UPDATE`
 * that assigns EVERY column from `EXCLUDED`, so a field the caller omits
 * becomes NULL rather than keeping whatever the previous attempt wrote. This
 * replaces the row for exactly that reason: a merge here would make a retried
 * case silently inherit the first attempt's judge rationale, and the offline
 * result would then disagree with the Aurora one in the one case — a retry —
 * where the two most need to agree.
 *
 * `run_id` carries no foreign key in `schema/observability_schema.sql`, so a
 * result for a run this process has never seen is accepted here exactly as
 * Aurora accepts it. That is not an oversight being copied: the runner creates
 * its run through a different process than the one that records results in
 * some deployments, and a mock that 404'd would reject a sequence production
 * allows.
 */
export function mockUpsertResult(runId: string, input: MockResultInput): MockTestResult {
  const row: MockTestResult = {
    runId,
    testId: input.testId,
    invocationId: input.invocationId ?? null,
    passed: input.passed ?? null,
    judgeScore: input.judgeScore ?? null,
    judgeRationale: input.judgeRationale ?? null,
    schemaValid: input.schemaValid ?? null,
    tagHits: input.tagHits ?? null,
    referenceSimilarity: input.referenceSimilarity ?? null,
    responseSnippet: input.responseSnippet ?? null,
    failReasons: input.failReasons ?? null,
    durationMs: input.durationMs ?? null,
    ts: clock.nowIso(),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    estCostUsd: input.estCostUsd ?? null,
  };
  const rows = testResults.rows();
  const at = rows.findIndex((r) => r.runId === runId && r.testId === input.testId);
  if (at >= 0) rows[at] = row;
  else rows.push(row);
  return row;
}

/**
 * `PATCH /runs/:id` — the storable half of a run patch.
 *
 * `completed`, `passed`, `failed`, `passRate` and `totalCases` are deliberately
 * ABSENT from this type even though the route accepts all five. They are
 * selectors over `harness-results` (see `withCounts`), and storing what the
 * caller sent would recreate precisely the defect this fixture was built to
 * lose: a run claiming 3/4 above four rows that say otherwise.
 *
 * Nothing is lost by dropping them. The runner posts every result *before* it
 * patches the run — `infra/scripts/harness.py` records the case, then updates
 * the counters — so by the time the patch arrives the rows it counted are
 * already here and `withCounts` computes the same five numbers from them. A
 * caller that patches counters it never backed with results is asserting a
 * total it cannot support, and offline it does not get to.
 */
export interface MockRunPatch {
  status?: MockTestRunSeed['status'];
  /** `'now'` is the route's no-value case (`finishedAt: true`), which SQL spells `now()`. */
  finishedAt?: string | null | 'now';
  notes?: string | null;
  agentVersions?: Record<string, string>;
}

/** Applies the storable fields; returns false when no such run exists (the route's 404). */
export function mockPatchRun(runId: string, patch: MockRunPatch): boolean {
  const seed = testRuns.rows().find((r) => r.runId === runId);
  if (!seed) return false;
  if (patch.status !== undefined) seed.status = patch.status;
  if (patch.finishedAt !== undefined) {
    seed.finishedAt = patch.finishedAt === 'now' ? clock.nowIso() : patch.finishedAt;
  }
  if (patch.notes !== undefined) seed.notes = patch.notes;
  if (patch.agentVersions !== undefined) seed.agentVersions = patch.agentVersions;
  return true;
}

export function mockCoverage(): Array<{
  agentId: string;
  count: number;
  lastRunPassed?: number;
  lastRunTotal?: number;
  lastRunAt?: string;
}> {
  const byAgent = new Map<string, number>();
  for (const c of testCases.rows()) {
    if (!c.active) continue;
    byAgent.set(c.agentId, (byAgent.get(c.agentId) ?? 0) + 1);
  }
  // "Last run" per agent = the most recent run touching that agent's cases.
  const latestRun = runsWithCounts().sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )[0];
  const latestResults = latestRun ? mockGetResults(latestRun.runId) : [];

  return Array.from(byAgent.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentId, count]) => {
      const forAgent = latestResults.filter((r) => r.agentId === agentId);
      const row: {
        agentId: string;
        count: number;
        lastRunPassed?: number;
        lastRunTotal?: number;
        lastRunAt?: string;
      } = { agentId, count };
      if (forAgent.length > 0 && latestRun) {
        row.lastRunPassed = forAgent.filter((r) => r.passed).length;
        row.lastRunTotal = forAgent.length;
        row.lastRunAt = latestRun.startedAt;
      }
      return row;
    });
}

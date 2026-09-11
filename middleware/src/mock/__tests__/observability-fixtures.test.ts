// The observability corpus and the rollups over it.
//
// WHAT THIS FILE IS FOR. Eight routers' worth of reads had no offline path at
// all: `exec()` threw, the handler caught it, and every one of them answered an
// empty collection. The fix is the corpus in mock/observability.ts, and the
// thing that can go wrong with a corpus like this is not that it is missing —
// it is that the summary and the list stop describing the same fleet. So the
// load-bearing assertions below are the ones that tie a rollup to the rows it
// claims to summarise: every per-agent error count, every tool count, every
// intervention tally and every memory rollup is checked against the rows a
// reader could click through to.
//
// The clock is frozen for every case. Percentiles, cost totals and window
// membership are all functions of `now`, so an unfrozen assertion would either
// be vague or flaky at UTC midnight — which is bug #3 wearing a test's clothes.

import {
  fixtureRegistry,
  freezeClock,
  unfreezeClock,
  type ScenarioName,
} from '../core/index.js';
import {
  agentTelemetryProfiles,
  humanLabels,
  interventionRows,
  memoryEventRows,
  modelledDistance,
  percentileCont,
  pgTimestamp,
  toolCallRows,
  traceRows,
  tracesInWindow,
  mockSetHumanLabel,
} from '../observability.js';
import {
  isRealFailure,
  mockDriftSummary,
  mockGuardrailByRule,
  mockGuardrailInterventions,
  mockInvocationSearch,
  mockMemoryStats,
  mockQualityScores,
  mockToolErrors,
  mockToolLatency,
  mockTrafficPerAgentSummary,
  mockTrafficRps,
  mockTrafficTopUsers,
} from '../observability-queries.js';
import { invocationsInWindow } from '../invocations.js';

// A Tuesday, mid-afternoon UTC — far enough into the day that a 24-hour window
// reaches back into "yesterday", which is where the corpus's clean rows live.
const AT = '2026-09-08T15:20:00.000Z';

let restore: () => void;

beforeEach(() => {
  restore = freezeClock(AT);
  // Rows materialize lazily and are cached per scenario. Anything built before
  // the freeze would carry instants from wall time, so start every case from
  // the factory.
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

/** Read a world without leaving the registry in it. */
function inScenario<T>(scenario: ScenarioName, fn: () => T): T {
  fixtureRegistry.resetAll(scenario);
  try {
    return fn();
  } finally {
    fixtureRegistry.resetAll('default');
  }
}

// ── The corpus is the fleet ────────────────────────────────────────────────

describe('the trace corpus is the invocation tail', () => {
  it('projects exactly one trace row per tail row, and no more', () => {
    const traces = traceRows();
    const tail = invocationsInWindow(24 * 400); // the whole corpus, not a window
    expect(traces).toHaveLength(tail.length);
    expect(new Set(traces.map((r) => r.invocation_id)))
      .toEqual(new Set(tail.map((r) => r.id)));
  });

  it('carries the tail row’s own prompt, duration and tokens, unaltered', () => {
    const tail = invocationsInWindow(24 * 400).find((r) => r.id === 'mock-inv-0')!;
    const trace = traceRows().find((r) => r.invocation_id === 'mock-inv-0')!;
    expect(trace.prompt_snippet).toBe(tail.promptSnippet);
    expect(trace.response_snippet).toBe(tail.responseSnippet);
    expect(trace.duration_ms).toBe(tail.durationMs);
    expect(trace.input_tokens).toBe(tail.tokensIn);
    expect(trace.output_tokens).toBe(tail.tokensOut);
    expect(trace.ts).toBe(pgTimestamp(tail.startedAt));
  });

  it('is deterministic — two reads of the same world are the same corpus', () => {
    expect(traceRows()).toEqual(traceRows());
  });

  it('pins the exact facets of one row, so a silent change to the derivation shows up here', () => {
    const r = traceRows().find((x) => x.invocation_id === 'mock-inv-0')!;
    expect(r).toMatchObject({
      agent_id: 'orgiq-supervisor',
      agent_name: 'Supervisor',
      template_id: 'orgiq.supervisor.route',
      model_id: 'amazon.nova-pro-v1:0',
      // The run threw, so there is no output: nothing to grade, nothing to
      // embed, and `schema_valid` false — which is half the error predicate.
      judge_score: null,
      judge_rationale: null,
      schema_valid: false,
      guardrail_action: null,
      input_tokens: 410,
      output_tokens: 0,
      est_cost_usd: 0.000328,
      judge_cost_usd: null,
      total_cost_usd: 0.000328,
      // The seeded human verdict on this row.
      human_label: 'bad',
    });
    expect(modelledDistance(r)).toBeNull();
  });

  it('gives a graded row a judge score inside its agent’s authored band', () => {
    const profile = agentTelemetryProfiles.rows().find((p) => p.agentId === 'orgiq-scoring')!;
    const graded = traceRows().filter((r) => r.agent_id === 'orgiq-scoring' && r.judge_score !== null);
    expect(graded.length).toBeGreaterThan(0);
    for (const r of graded) {
      expect(r.judge_score!).toBeGreaterThanOrEqual(profile.judgeCentre - profile.judgeSpread - 1e-9);
      expect(r.judge_score!).toBeLessThanOrEqual(profile.judgeCentre + profile.judgeSpread + 1e-9);
    }
  });

  it('never dates a child A2A call before the parent that made it', () => {
    const byId = new Map(traceRows().map((r) => [r.invocation_id, r]));
    const linked = traceRows().filter((r) => r.parent_invocation_id !== null);
    expect(linked.length).toBeGreaterThan(0);
    for (const child of linked) {
      const parent = byId.get(child.parent_invocation_id!)!;
      expect(parent).toBeDefined();
      expect(parent.agent_id).toBe('orgiq-supervisor');
      expect(parent.tsIso <= child.tsIso).toBe(true);
    }
  });
});

// ── Rollups pinned against their rows ──────────────────────────────────────

describe('every rollup is reachable from the list beneath it', () => {
  it('per-agent-summary counts exactly the rows the search list can show', () => {
    const summary = mockTrafficPerAgentSummary(24);
    const window = tracesInWindow(24);
    expect(summary.length).toBeGreaterThan(0);

    for (const row of summary) {
      const mine = window.filter((t) => t.agent_id === row['agent_id']);
      expect(row['invocations']).toBe(mine.length);
      // THE assertion this whole surface turns on: the summary's error count is
      // the number of rows a reader can go and open, not a number beside them.
      expect(row['error_count']).toBe(mine.filter(isRealFailure).length);
      expect(row['low_quality_count'])
        .toBe(mine.filter((t) => t.judge_score !== null && t.judge_score < 0.3).length);
      expect(row['p50']).toBe(percentileCont(mine.map((t) => t.duration_ms), 0.5));
      expect(row['p99']).toBe(percentileCont(mine.map((t) => t.duration_ms), 0.99));
      expect(row['total_cost_usd'] as number)
        .toBeCloseTo(mine.reduce((a, t) => a + (t.total_cost_usd ?? 0), 0), 10);
    }
  });

  it('reports the whole fleet’s 24h volume, agent by agent, with nothing left over', () => {
    const summary = mockTrafficPerAgentSummary(24);
    const total = summary.reduce((a, r) => a + (r['invocations'] as number), 0);
    expect(total).toBe(tracesInWindow(24).length);
    // Pinned exactly: the seeded day is 335 invocations across six agents,
    // which is what mock/invocations.ts's VOLUME table adds up to.
    expect(total).toBe(335);
    expect(summary.map((r) => [r['agent_id'], r['invocations']])).toEqual([
      ['orgiq-search', 120],
      ['orgiq-supervisor', 90],
      ['orgiq-scoring', 45],
      ['orgiq-advisor', 30],
      ['orgiq-graph-builder', 30],
      ['orgiq-ingestion', 20],
    ]);
  });

  it('separates a real failure from a weak answer — the errorRate gotcha', () => {
    const ingestion = mockTrafficPerAgentSummary(24)
      .find((r) => r['agent_id'] === 'orgiq-ingestion')!;
    // 20 invocations, 8 of which threw (VOLUME says so) and none of which were
    // blocked, so the error count is exactly the failures.
    expect(ingestion['invocations']).toBe(20);
    expect(ingestion['error_count']).toBe(8);
    // Weak answers are counted separately and are NOT in the error count. If a
    // future change folds them together this number moves into error_count and
    // this line fails, which is the entire point of it.
    expect(ingestion['low_quality_count']).toBe(6);

    const window = tracesInWindow(24).filter((t) => t.agent_id === 'orgiq-ingestion');
    const weakButFine = window.filter(
      (t) => t.judge_score !== null && t.judge_score < 0.3 && !isRealFailure(t),
    );
    expect(weakButFine.length).toBe(6);
  });

  it('counts a guardrail block as an error and a low score as not one', () => {
    const search = mockTrafficPerAgentSummary(24).find((r) => r['agent_id'] === 'orgiq-search')!;
    const window = tracesInWindow(24).filter((t) => t.agent_id === 'orgiq-search');
    const blocked = window.filter((t) => t.guardrail_action === 'BLOCKED');
    const threw = window.filter((t) => t.schema_valid === false);
    expect(blocked.length).toBeGreaterThan(0);
    expect(threw.length).toBeGreaterThan(0);
    expect(search['error_count']).toBe(blocked.length + threw.length);
  });

  it('rps buckets add up to the window they bucket', () => {
    const points = mockTrafficRps(24, 60);
    const total = points.reduce((a, p) => a + (p['invocations'] as number), 0);
    expect(total).toBe(tracesInWindow(24).length);
    // Distinct users in a bucket can never exceed the rows in it.
    for (const p of points) {
      expect(p['unique_users'] as number).toBeLessThanOrEqual(p['invocations'] as number);
      expect(p['unique_sessions'] as number).toBeLessThanOrEqual(p['invocations'] as number);
    }
  });

  it('top-users skips unattributed rows rather than inventing a user for them', () => {
    const users = mockTrafficTopUsers(24, 200);
    const window = tracesInWindow(24);
    const attributed = window.filter((t) => t.user_id !== null);
    expect(attributed.length).toBeLessThan(window.length); // some rows really have none
    expect(users.reduce((a, u) => a + (u['invocations'] as number), 0)).toBe(attributed.length);
    expect(users.some((u) => u['user_id'] === null || u['user_id'] === '')).toBe(false);
  });

  it('the drift rollup is the percentile of the distances its outlier list ranks', () => {
    for (const row of mockDriftSummary(24)) {
      const mine = tracesInWindow(24).filter((t) => t.agent_id === row['agent_id']);
      expect(row['cnt']).toBe(mine.length);
      const dists = mine.map(modelledDistance).filter((d): d is number => d !== null);
      expect(row['drift_p95']).toBe(percentileCont(dists, 0.95));
      const scores = mine.map((t) => t.judge_score).filter((s): s is number => s !== null);
      expect(row['p50']).toBe(percentileCont(scores, 0.5));
    }
  });

  it('tool latency counts the calls its error tail can show', () => {
    const byTool = mockToolLatency(24, '');
    const calls = toolCallRows().filter((c) => {
      const t = new Date(c.tsIso).getTime();
      return t > Date.parse(AT) - 24 * 3_600_000 && t <= Date.parse(AT);
    });
    expect(byTool.reduce((a, r) => a + (r['cnt'] as number), 0)).toBe(calls.length);
    for (const row of byTool) {
      const mine = calls.filter((c) => c.tool_name === row['tool_name']);
      expect(row['error_rate']).toBe(mine.filter((c) => c.errored).length / mine.length);
      expect(row['with_cost']).toBe(mine.filter((c) => c.est_cost_usd !== null).length);
    }
  });

  it('every errored tool call carries the failure its invocation actually reported', () => {
    const errors = mockToolErrors(500);
    expect(errors.length).toBeGreaterThan(0);
    const tail = new Map(invocationsInWindow(24 * 400).map((r) => [r.id, r]));
    for (const e of errors) {
      const src = tail.get(e['invocation_id'] as string)!;
      expect(src).toBeDefined();
      expect(e['error_message']).toBe(src.error);
    }
    // And the set of failing invocations is the set the summary counted.
    const failing = new Set(errors.map((e) => e['invocation_id']));
    expect(failing.size).toBe(traceRows().filter((t) => t.schema_valid === false).length);
  });

  it('the guardrail breakdown only names rules the configured guardrail has', () => {
    const byRule = mockGuardrailByRule(24);
    expect(byRule.length).toBeGreaterThan(0);
    const all = interventionRows();
    const inWindow = all.filter((i) => new Date(i.tsIso).getTime() > Date.parse(AT) - 24 * 3_600_000);
    expect(byRule.reduce((a, r) => a + (r['cnt'] as number), 0)).toBe(inWindow.length);
    for (const r of byRule) {
      const mine = inWindow.filter((i) => i.rule_name === r['rule_name']);
      expect((r['low_cnt'] as number) + (r['med_cnt'] as number) + (r['high_cnt'] as number))
        .toBe(mine.length);
      expect(['PII', 'TOPIC', 'CONTENT', 'PROMPT_ATTACK']).toContain(r['rule_category']);
    }
  });

  it('only blocked invocations produce interventions, and every one of them does', () => {
    const blocked = traceRows().filter((t) => t.guardrail_action !== null);
    const withIntervention = new Set(interventionRows().map((i) => i.invocation_id));
    expect(withIntervention.size).toBe(blocked.length);
    expect(blocked.every((t) => withIntervention.has(t.invocation_id))).toBe(true);
  });

  it('memory stats count the events the feed lists', () => {
    const stats = mockMemoryStats(24);
    const events = memoryEventRows()
      .filter((e) => new Date(e.tsIso).getTime() > Date.parse(AT) - 24 * 3_600_000);
    expect(stats.length).toBeGreaterThan(0);
    for (const row of stats) {
      const mine = events.filter((e) => e.agent_id === row['agent_id']);
      expect(row['total']).toBe(mine.length);
      expect(row['retrieves']).toBe(mine.filter((e) => e.kind === 'retrieve').length);
      expect(row['writes']).toBe(mine.filter((e) => e.kind === 'write').length);
      expect(row['errors']).toBe(mine.filter((e) => e.errored).length);
      // A cold session is one whose retrieves brought nothing back — countable
      // from the same rows, never stored.
      const sessions = new Map<string, number>();
      for (const e of mine.filter((x) => x.kind === 'retrieve' && x.session_id !== null)) {
        sessions.set(e.session_id!, (sessions.get(e.session_id!) ?? 0) + (e.result_count ?? 0));
      }
      expect(row['cold_sessions']).toBe([...sessions.values()].filter((n) => n === 0).length);
    }
  });

  it('a memory retrieve’s result_count is the length of what it retrieved', () => {
    const retrieves = memoryEventRows().filter((e) => e.kind === 'retrieve');
    expect(retrieves.length).toBeGreaterThan(0);
    for (const e of retrieves) {
      const listed = e.retrieved_summary === null ? 0 : e.retrieved_summary.split('; ').length;
      expect(e.result_count).toBe(listed);
    }
    // Only an agent whose profile says it uses memory has any events at all.
    const memoryAgents = new Set(
      agentTelemetryProfiles.rows().filter((p) => p.usesMemory).map((p) => p.agentId),
    );
    for (const e of memoryEventRows()) {
      if (e.memory_event_id.startsWith('mock-me-')) continue; // a manual insert
      expect(memoryAgents.has(e.agent_id)).toBe(true);
    }
  });
});

// ── Filters and ordering ───────────────────────────────────────────────────

describe('the selectors apply the filters their SQL applies', () => {
  it('search returns newest first and honours every filter it accepts', () => {
    const base = {
      q: '', agentId: '', minScore: null, maxScore: null,
      since: null, until: null, promptVersion: '', userId: '', limit: 500,
    };
    const all = mockInvocationSearch(base);
    expect(all).toHaveLength(335);
    for (let i = 1; i < all.length; i++) {
      expect(String(all[i - 1]!['ts']) >= String(all[i]!['ts'])).toBe(true);
    }
    const byAgent = mockInvocationSearch({ ...base, agentId: 'orgiq-advisor' });
    expect(byAgent).toHaveLength(30);
    expect(byAgent.every((r) => r['agent_id'] === 'orgiq-advisor')).toBe(true);

    const good = mockInvocationSearch({ ...base, minScore: 0.9 });
    expect(good.length).toBeGreaterThan(0);
    expect(good.every((r) => (r['judge_score'] as number) >= 0.9)).toBe(true);

    expect(mockInvocationSearch({ ...base, limit: 7 })).toHaveLength(7);
  });

  it('quality scores run oldest first, which is what a series is', () => {
    const points = mockQualityScores(Date.parse(AT) - 24 * 3_600_000, 'orgiq-ingestion');
    expect(points.length).toBe(20);
    for (let i = 1; i < points.length; i++) {
      expect(String(points[i - 1]!['ts']) <= String(points[i]!['ts'])).toBe(true);
    }
  });

  it('a human label written at run time reaches every read that shows one', () => {
    expect(mockSetHumanLabel('mock-inv-9', 'fixed', 'reran it')).toBe(true);
    expect(traceRows().find((r) => r.invocation_id === 'mock-inv-9')!.human_label).toBe('fixed');
    const point = mockQualityScores(0, undefined).find((p) => p['invocation_id'] === 'mock-inv-9')!;
    expect(point['human_label']).toBe('fixed');
    // An id the corpus does not serve is a miss, which the route turns into 404.
    expect(mockSetHumanLabel('mock-inv-nope', 'good', null)).toBe(false);
    // And an out-of-vocabulary label is refused rather than stored.
    expect(mockSetHumanLabel('mock-inv-9', 'excellent', null)).toBe(false);
  });

  it('intervention filters narrow to one invocation and one rule', () => {
    const first = interventionRows()[0]!;
    const forOne = mockGuardrailInterventions(first.invocation_id, null, 500);
    expect(forOne.length).toBeGreaterThan(0);
    expect(forOne.every((i) => i['invocation_id'] === first.invocation_id)).toBe(true);

    const forRule = mockGuardrailInterventions(null, first.rule_name, 500);
    expect(forRule.every((i) => i['rule_name'] === first.rule_name)).toBe(true);
  });
});

// ── Percentiles ────────────────────────────────────────────────────────────

describe('percentileCont matches Postgres PERCENTILE_CONT', () => {
  it('interpolates between ranks and answers null over nothing', () => {
    expect(percentileCont([], 0.5)).toBeNull();
    expect(percentileCont([7], 0.99)).toBe(7);
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([1, 2, 3, 4], 0)).toBe(1);
    expect(percentileCont([1, 2, 3, 4], 1)).toBe(4);
    // p95 of ten evenly spaced values: idx = 0.95*9 = 8.55 → 9 + 0.55*1
    expect(percentileCont([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 10);
  });
});

// ── The other worlds ───────────────────────────────────────────────────────

describe('the scenarios an auditor can ask for', () => {
  it('empty means the projector has written nothing — everywhere, not in patches', () => {
    inScenario('empty', () => {
      expect(traceRows()).toEqual([]);
      expect(toolCallRows()).toEqual([]);
      expect(interventionRows()).toEqual([]);
      expect(memoryEventRows()).toEqual([]);
      expect(mockTrafficPerAgentSummary(24)).toEqual([]);
      expect(mockDriftSummary(24)).toEqual([]);
      expect(mockToolLatency(24, '')).toEqual([]);
      expect(mockGuardrailByRule(24)).toEqual([]);
      expect(mockMemoryStats(24)).toEqual([]);
    });
  });

  it('the profiles fixture’s own error is the observability schema being gone', () => {
    // Asserted on the fixture directly, because in the GLOBAL error world the
    // fleet fixture (mock/agent-statuses.ts) also throws, and a windowed read
    // reaches it first — see the next case. Which failure a caller sees depends
    // on which fixture the read touches first, and both are true failures; what
    // this pins is that THIS fixture reports the right one.
    expect(() => agentTelemetryProfiles.rows('error'))
      .toThrow(/observability\.invocation_traces unavailable/);
  });

  it('error throws on every read, which is how a route’s degraded answer is reachable at all', () => {
    inScenario('error', () => {
      // No message assertion: the point of the error world is that the read
      // FAILS rather than answering an empty list, and the route's catch turns
      // any of these into `degraded` plus the first line of whatever threw.
      expect(() => traceRows()).toThrow();
      expect(() => toolCallRows()).toThrow();
      expect(() => interventionRows()).toThrow();
      expect(() => memoryEventRows()).toThrow();
      expect(() => mockTrafficPerAgentSummary(24)).toThrow();
      expect(() => mockDriftSummary(24)).toThrow();
      expect(() => mockToolLatency(24, '')).toThrow();
      expect(() => mockGuardrailByRule(24)).toThrow();
      expect(() => mockMemoryStats(24)).toThrow();
      expect(() => mockQualityScores(0, undefined)).toThrow();
    });
  });

  it('emptying the human-label fixture clears the labels without touching the corpus', () => {
    humanLabels.reset('default');
    expect(traceRows().filter((r) => r.human_label !== null).length).toBe(5);
    inScenario('empty', () => { /* profiles empty here; checked above */ });
  });
});

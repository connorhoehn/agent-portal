// The offline half of every read in the eight observability routers.
//
// WHAT THESE FUNCTIONS ARE. Each one is the mock counterpart of ONE SQL
// statement, and it returns what `providers/aurora.ts` `exec()` returns for
// that statement: an array of snake_case rows. The route then runs its own
// `rows.map(...)` over it, unchanged, so the wire body has exactly one
// definition and a mock can never quietly grow a second shape (contract.ts
// bug #2 — the `enterprise` / `enterprise_context` defect, which a test using
// the fixture's own key could not catch).
//
// It also means the filters, the ordering, the clamps and the NULL handling
// are written here to match the SQL beside them, not approximated. Where the
// statement says `ORDER BY cnt DESC, tool_name ASC`, so does the selector;
// where it says `AVG(CASE WHEN schema_valid IS NULL THEN NULL ...)`, the
// selector skips NULLs rather than counting them as zero.
//
// NOTHING HERE STORES A NUMBER. Every count, rate, percentile and bucket total
// below is computed from `traceRows()` / `toolCallRows()` / `interventionRows()`
// / `memoryEventRows()` at read time. The rollups and the lists they summarise
// are the same rows, so a summary cannot promise errors the list cannot show.
//
// ERROR RATE IS NOT QUALITY. `/per-agent-summary` counts a row as an error only
// when a guardrail intervened (`guardrail_action` present and not 'NONE') or
// the output did not conform (`schema_valid = false`). A weak answer is
// `lowQualityRate` (judge < 0.3), separately, for the reason CLAUDE.md's
// observability gotcha gives: folding the two together made a healthy fleet
// giving mediocre answers alarm as erroring.

import { clock, type ScenarioName } from './core/index.js';
import {
  approvalRequests,
  bucketStart,
  bucketStartMs,
  excludeTestTraffic,
  interventionRows,
  memoryEventRows,
  modelledDistance,
  percentileCont,
  pgTimestamp,
  toolCallRows,
  traceRows,
  tracesInWindow,
  type MockApprovalRow,
  type MockMemoryEventRow,
  type MockToolCallRow,
  type MockTraceRow,
} from './observability.js';
import { mockListPromptVersions } from './prompt-versions.js';

type Row = Record<string, unknown>;

/**
 * Now, from the ONE clock.
 *
 * These helpers used to call `Date.now()` directly, which is contract.ts bug #3
 * with the sign flipped: not a timestamp baked at import, but a window that
 * ignores a frozen clock while the rows inside it honour one. The corpus is
 * built through `clock.hoursAgo()`, so a `Date.now()` cutoff measured a window
 * from wall time against rows dated from the frozen instant — and the tool
 * rollup counted 647 calls while the list beneath it could produce 542. Same
 * clock on both sides, or the rollup and its rows are describing different days.
 */
function nowMs(): number {
  return clock.now().getTime();
}

/** Group rows by a key, preserving first-seen order. */
function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * `SUM(x)` — NULLs skipped, exactly as the aggregate does. A missing cost is
 * not a zero cost, and folding one in as zero is how a total starts claiming
 * that rows it could not price were free.
 */
function sum(values: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) total += v;
  return total;
}

/** `ts > now() - INTERVAL '1 day' * days`, for the reads that speak in days. */
function tracesInDays(days: number, scenario?: ScenarioName): MockTraceRow[] {
  return tracesInWindow(days * 24, scenario);
}

function toolCallsInWindow(hours: number, scenario?: ScenarioName): MockToolCallRow[] {
  const now = nowMs();
  const cutoff = now - hours * 3_600_000;
  return toolCallRows(scenario).filter((c) => {
    const t = new Date(c.tsIso).getTime();
    return t > cutoff && t <= now;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/traffic.ts
// ═══════════════════════════════════════════════════════════════════════════

/** GET /rps — invocations per (bucket, agent), plus distinct users and sessions. */
export function mockTrafficRps(windowHours: number, bucketMin: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  const buckets = group(rows, (r) => `${bucketStart(r.tsIso, bucketMin)}|${r.agent_id}`);
  return [...buckets.entries()]
    .map(([key, group_]) => {
      const [bucket, agentId] = key.split('|');
      return {
        bucket_start: bucket!,
        agent_id: agentId!,
        // COUNT(DISTINCT user_id) ignores NULL, exactly as Postgres does — an
        // unattributed row is not a user.
        invocations: group_.length,
        unique_users: new Set(group_.map((r) => r.user_id).filter((u): u is string => u !== null)).size,
        unique_sessions: new Set(group_.map((r) => r.session_id).filter((s): s is string => s !== null)).size,
      };
    })
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.agent_id.localeCompare(b.agent_id));
}

/** GET /heatmap — a (day-of-week, hour-of-day) grid. `date_part` buckets in UTC. */
export function mockTrafficHeatmap(days: number, scenario?: ScenarioName): Row[] {
  const cells = group(excludeTestTraffic(tracesInDays(days, scenario)), (r) => {
    const d = new Date(r.tsIso);
    return `${d.getUTCDay()}|${d.getUTCHours()}`;
  });
  return [...cells.entries()]
    .map(([key, group_]) => {
      const [dow, hod] = key.split('|').map(Number);
      return { dow: dow!, hod: hod!, cnt: group_.length };
    })
    .sort((a, b) => a.dow - b.dow || a.hod - b.hod);
}

/** GET /top-users — biggest `user_id` by invocation count. NULL users are skipped. */
export function mockTrafficTopUsers(windowHours: number, limit: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario))
    .filter((r) => r.user_id !== null && r.user_id.trim().length > 0);
  return [...group(rows, (r) => r.user_id!).entries()]
    .map(([userId, group_]) => ({
      user_id: userId,
      invocations: group_.length,
      unique_agents: new Set(group_.map((r) => r.agent_id)).size,
      total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
      last_seen_at: pgTimestamp(
        group_.reduce((max, r) => (r.tsIso > max ? r.tsIso : max), group_[0]!.tsIso),
      ),
    }))
    .sort((a, b) => b.invocations - a.invocations || b.total_cost_usd - a.total_cost_usd)
    .slice(0, Math.max(0, limit));
}

/**
 * GET /per-agent-summary — the rollup the error-rate gotcha is about.
 *
 * `error_count` and `low_quality_count` are FILTERs over the same rows the
 * Invocations list serves, so the number in the summary is reachable by
 * clicking through. `errorRate` itself is computed by the route from
 * `error_count / invocations`; this returns the counts, not the rate, exactly
 * as the SQL does.
 */
export function mockTrafficPerAgentSummary(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [...group(rows, (r) => r.agent_id).entries()]
    .map(([agentId, group_]) => ({
      agent_id: agentId,
      invocations: group_.length,
      p50: percentileCont(group_.map((r) => r.duration_ms), 0.5),
      p99: percentileCont(group_.map((r) => r.duration_ms), 0.99),
      error_count: group_.filter(isRealFailure).length,
      low_quality_count: group_.filter((r) => r.judge_score !== null && r.judge_score < 0.3).length,
      total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
    }))
    .sort((a, b) => b.invocations - a.invocations || a.agent_id.localeCompare(b.agent_id));
}

/**
 * The `errorRate` predicate, in one place so the summary, the on-call timeline
 * and any test can only ever mean the same thing by it.
 */
export function isRealFailure(row: MockTraceRow): boolean {
  return (row.guardrail_action !== null && row.guardrail_action !== 'NONE') || row.schema_valid === false;
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/drift.ts
//
// Every `drift_p95` below is PERCENTILE_CONT over `modelledDistance()` — the
// one modelled scalar on this surface (see mock/observability.ts). Rows with no
// distance are skipped, which is the `output_embedding IS NOT NULL` predicate.
// ═══════════════════════════════════════════════════════════════════════════

function distances(rows: readonly MockTraceRow[]): number[] {
  return rows.map(modelledDistance).filter((d): d is number => d !== null);
}

/** `AVG(CASE WHEN schema_valid IS NULL THEN NULL WHEN schema_valid THEN 1 ELSE 0 END)`. */
function conformance(rows: readonly MockTraceRow[]): number | null {
  const known = rows.filter((r) => r.schema_valid !== null);
  if (known.length === 0) return null;
  return known.filter((r) => r.schema_valid === true).length / known.length;
}

function judgeScores(rows: readonly MockTraceRow[]): number[] {
  return rows.map((r) => r.judge_score).filter((s): s is number => s !== null);
}

/** GET /summary — per-agent rollup, ordered by volume. */
export function mockDriftSummary(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [...group(rows, (r) => r.agent_id).entries()]
    .map(([agentId, group_]) => ({
      agent_id: agentId,
      cnt: group_.length,
      conformance: conformance(group_),
      p50: percentileCont(judgeScores(group_), 0.5),
      p05: percentileCont(judgeScores(group_), 0.05),
      drift_p95: percentileCont(distances(group_), 0.95) ?? 0,
    }))
    .sort((a, b) => b.cnt - a.cnt);
}

/** GET /outliers — furthest from the centroid in the last hour. Always a 1h window. */
export function mockDriftOutliers(agentId: string | undefined, limit: number, scenario?: ScenarioName): Row[] {
  return excludeTestTraffic(tracesInWindow(1, scenario))
    .filter((r) => modelledDistance(r) !== null)
    .filter((r) => !agentId || r.agent_id === agentId)
    .map((r) => ({
      invocation_id: r.invocation_id,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      template_id: r.template_id,
      prompt_snippet: r.prompt_snippet,
      response_snippet: r.response_snippet,
      judge_score: r.judge_score,
      judge_rationale: r.judge_rationale,
      schema_valid: r.schema_valid,
      dist: modelledDistance(r)!,
      ts: r.ts,
    }))
    .sort((a, b) => (b.dist as number) - (a.dist as number))
    .slice(0, Math.max(0, limit));
}

/** GET /timeseries — bucketed drift and median judge score. */
export function mockDriftTimeseries(
  windowHours: number,
  bucketMin: number,
  agentId: string | undefined,
  scenario?: ScenarioName,
): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario))
    .filter((r) => !agentId || r.agent_id === agentId);
  const buckets = group(rows, (r) => `${bucketStart(r.tsIso, bucketMin)}|${r.agent_id}`);
  return [...buckets.entries()]
    .map(([key, group_]) => {
      const [bucket, agent] = key.split('|');
      return {
        bucket_start: bucket!,
        agent_id: agent!,
        cnt: group_.length,
        drift_p95: percentileCont(distances(group_), 0.95) ?? 0,
        p50: percentileCont(judgeScores(group_), 0.5),
      };
    })
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.agent_id.localeCompare(b.agent_id));
}

/** GET /templates — the per-(agent, template) breakdown, `HAVING COUNT(*) >= minCount`. */
export function mockDriftTemplates(windowHours: number, minCount: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [...group(rows, (r) => `${r.agent_id}|${r.template_id ?? ''}`).entries()]
    .map(([key, group_]) => {
      const [agentId, templateId] = key.split('|');
      return {
        agent_id: agentId!,
        // `COALESCE(template_id, '(none)')` — the route's own default.
        template_id: templateId ? templateId : '(none)',
        cnt: group_.length,
        p50: percentileCont(judgeScores(group_), 0.5),
        p05: percentileCont(judgeScores(group_), 0.05),
        conformance: conformance(group_),
        drift_p95: percentileCont(distances(group_), 0.95) ?? 0,
      };
    })
    .filter((r) => r.cnt >= minCount)
    .sort((a, b) => (b.drift_p95 as number) - (a.drift_p95 as number)
      || nullsLast(a.p05) - nullsLast(b.p05));
}

function nullsLast(v: number | null): number {
  return v === null ? Number.POSITIVE_INFINITY : v;
}

/**
 * GET /neighbors/:invocationId — the closest known-good rows from the same
 * agent in the last 7 days, so a researcher can diff a drifted answer against
 * a trusted one. `judge_score IS NULL OR >= 0.7` is the "known good" filter.
 */
export function mockDriftNeighbors(invocationId: string, limit: number, scenario?: ScenarioName): Row[] {
  const all = traceRows(scenario);
  const probe = all.find((r) => r.invocation_id === invocationId);
  if (!probe) return [];
  const probeDist = modelledDistance(probe);
  if (probeDist === null) return [];

  const cutoff = nowMs() - 7 * 86_400_000;
  return all
    .filter((r) => r.invocation_id !== invocationId)
    .filter((r) => r.agent_id === probe.agent_id)
    .filter((r) => modelledDistance(r) !== null)
    .filter((r) => r.judge_score === null || r.judge_score >= 0.7)
    .filter((r) => new Date(r.tsIso).getTime() > cutoff)
    .map((r) => ({
      invocation_id: r.invocation_id,
      ts: r.ts,
      response_snippet: r.response_snippet,
      judge_score: r.judge_score,
      // `t.output_embedding <=> p.output_embedding` — the distance BETWEEN the
      // two rows, which for the modelled scalar is the gap between their
      // distances to the shared centroid.
      dist: Math.abs(modelledDistance(r)! - probeDist),
    }))
    .sort((a, b) => (a.dist as number) - (b.dist as number))
    .slice(0, Math.max(0, limit));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/tool-calls.ts
// ═══════════════════════════════════════════════════════════════════════════

/** GET /latency — per-tool rollup over the window, test traffic excluded. */
export function mockToolLatency(windowHours: number, agentId: string, scenario?: ScenarioName): Row[] {
  const calls = toolCallsInWindow(windowHours, scenario)
    .filter((c) => c.trace.template_id === null || !c.trace.template_id.startsWith('test:'))
    .filter((c) => !agentId || c.trace.agent_id === agentId);
  return [...group(calls, (c) => c.tool_name).entries()]
    .map(([toolName, group_]) => ({
      tool_name: toolName,
      cnt: group_.length,
      p50: percentileCont(group_.map((c) => c.duration_ms), 0.5),
      p99: percentileCont(group_.map((c) => c.duration_ms), 0.99),
      error_rate: group_.filter((c) => c.errored).length / group_.length,
      total_cost_usd: sum(group_.map((c) => c.est_cost_usd ?? 0)),
      // `COUNT(est_cost_usd)` — Postgres counts non-NULLs, so this is how many
      // of these calls actually cost anything, not how many there were.
      with_cost: group_.filter((c) => c.est_cost_usd !== null).length,
    }))
    .sort((a, b) => b.cnt - a.cnt || a.tool_name.localeCompare(b.tool_name));
}

/** GET /timeseries — bucketed per-tool series. */
export function mockToolTimeseries(windowHours: number, bucketMin: number, scenario?: ScenarioName): Row[] {
  const calls = toolCallsInWindow(windowHours, scenario)
    .filter((c) => c.trace.template_id === null || !c.trace.template_id.startsWith('test:'));
  const buckets = group(calls, (c) => `${bucketStart(c.tsIso, bucketMin)}|${c.tool_name}`);
  return [...buckets.entries()]
    .map(([key, group_]) => {
      const [bucket, toolName] = key.split('|');
      return {
        bucket_start: bucket!,
        tool_name: toolName!,
        cnt: group_.length,
        p99: percentileCont(group_.map((c) => c.duration_ms), 0.99),
        error_rate: group_.filter((c) => c.errored).length / group_.length,
        total_cost_usd: sum(group_.map((c) => c.est_cost_usd ?? 0)),
      };
    })
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.tool_name.localeCompare(b.tool_name));
}

/**
 * GET /errors — the recent errored-call tail.
 *
 * Deliberately NOT filtered on `test:%`: the route's own comment says
 * researchers debug failing test cases through this tail, so the mock keeps
 * them too rather than quietly applying a filter the server does not.
 */
export function mockToolErrors(limit: number, scenario?: ScenarioName): Row[] {
  return toolCallRows(scenario)
    .filter((c) => c.errored)
    .sort((a, b) => b.tsIso.localeCompare(a.tsIso))
    .slice(0, Math.max(0, limit))
    .map((c) => ({
      tool_call_id: c.tool_call_id,
      invocation_id: c.invocation_id,
      agent_id: c.trace.agent_id,
      tool_name: c.tool_name,
      error_message: c.error_message,
      ts: c.ts,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/quality.ts
// ═══════════════════════════════════════════════════════════════════════════

/** GET /scores — the judge-score series, oldest first, capped at 5000 like the SQL. */
export function mockQualityScores(
  sinceMs: number,
  agentId: string | undefined,
  scenario?: ScenarioName,
): Row[] {
  return excludeTestTraffic(traceRows(scenario))
    .filter((r) => new Date(r.tsIso).getTime() > sinceMs)
    .filter((r) => !agentId || r.agent_id === agentId)
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso))
    .slice(0, 5000)
    .map((r) => ({
      invocation_id: r.invocation_id,
      agent_id: r.agent_id,
      ts: r.ts,
      judge_score: r.judge_score,
      schema_valid: r.schema_valid,
      human_label: r.human_label,
      // These seven were dropped here and omitted from the real SELECT at the
      // same time, so the fixture and the query agreed and the wire check had
      // nothing to disagree with — while the Quality page rendered a RATIONALE
      // and a COST column that were empty on every row of every deployment.
      // The fixture has carried all of them all along (MockTraceRow).
      judge_rationale: r.judge_rationale,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      est_cost_usd: r.est_cost_usd,
      judge_cost_usd: r.judge_cost_usd,
      total_cost_usd: r.total_cost_usd,
      prompt_version: r.prompt_version,
      model_id: r.model_id,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/guardrails-detail.ts
// ═══════════════════════════════════════════════════════════════════════════

/** GET /by-rule — top-firing rules with their severity split. */
export function mockGuardrailByRule(windowHours: number, scenario?: ScenarioName): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  const rows = interventionRows(scenario).filter((i) => new Date(i.tsIso).getTime() > cutoff);
  return [...group(rows, (i) => i.rule_name).entries()]
    .map(([ruleName, group_]) => ({
      rule_name: ruleName,
      // `MAX(rule_category)` over one rule's rows — every row of a rule carries
      // the same category, so the max is that category.
      rule_category: group_[0]!.rule_category,
      cnt: group_.length,
      low_cnt: group_.filter((i) => i.severity === 'LOW').length,
      med_cnt: group_.filter((i) => i.severity === 'MEDIUM').length,
      high_cnt: group_.filter((i) => i.severity === 'HIGH').length,
    }))
    .sort((a, b) => b.cnt - a.cnt);
}

/**
 * GET /by-actor — who set the guardrails off, over the window.
 *
 * Mirrors the route's SQL exactly, including the two things that are easy to
 * get wrong offline: the JOIN drops an intervention whose invocation has no
 * trace, and `user_id IS NOT NULL` drops the ~1-in-12 rows the seed leaves
 * unattributed (a scheduled or agent-to-agent call). Bucketing those under
 * one "unknown" actor would make the most prolific row on the page a fiction.
 */
export function mockGuardrailByActor(
  windowHours: number,
  limit: number,
  scenario?: ScenarioName,
): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  const userByInvocation = new Map(
    traceRows(scenario)
      .filter((t) => t.user_id && t.user_id.trim())
      .map((t) => [t.invocation_id, t.user_id as string]),
  );
  const rows = interventionRows(scenario)
    .filter((i) => new Date(i.tsIso).getTime() > cutoff)
    .filter((i) => i.invocation_id !== null && userByInvocation.has(i.invocation_id));

  return [...group(rows, (i) => userByInvocation.get(i.invocation_id!)!).entries()]
    .map(([userId, mine]) => {
      // `mode() WITHIN GROUP` — the most common rule for THIS actor. Ties go
      // to the lexically first name so the offline answer is deterministic;
      // PostgreSQL's mode() picks an arbitrary one among ties, and a fixture
      // that reshuffles between reads is worse than one that commits.
      const byRule = [...group(mine, (i) => i.rule_name).entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      const top = byRule[0];
      const times = mine.map((i) => i.tsIso).sort();
      return {
        user_id: userId,
        interventions: mine.length,
        blocked: mine.filter((i) => i.action === 'BLOCKED').length,
        anonymized: mine.filter((i) => i.action === 'ANONYMIZED').length,
        high_severity: mine.filter((i) => i.severity === 'HIGH').length,
        unique_rules: byRule.length,
        unique_agents: new Set(mine.map((i) => i.agent_id)).size,
        top_rule: top ? top[0] : null,
        top_rule_category: top ? mine.find((i) => i.rule_name === top[0])!.rule_category : null,
        first_seen_at: pgTimestamp(times[0]!),
        last_seen_at: pgTimestamp(times[times.length - 1]!),
      };
    })
    .sort((a, b) => b.interventions - a.interventions || b.high_severity - a.high_severity)
    .slice(0, limit);
}

/** GET /interventions — the raw feed, newest first. No window; the SQL has none either. */
export function mockGuardrailInterventions(
  invocationId: string | null,
  ruleName: string | null,
  limit: number,
  scenario?: ScenarioName,
): Row[] {
  return interventionRows(scenario)
    .filter((i) => !invocationId || i.invocation_id === invocationId)
    .filter((i) => !ruleName || i.rule_name === ruleName)
    .sort((a, b) => b.tsIso.localeCompare(a.tsIso))
    .slice(0, Math.max(0, limit))
    .map((i) => ({
      intervention_id: i.intervention_id,
      invocation_id: i.invocation_id,
      agent_id: i.agent_id,
      rule_name: i.rule_name,
      rule_category: i.rule_category,
      severity: i.severity,
      action: i.action,
      matched_text: i.matched_text,
      ts: i.ts,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/invocations.ts
// ═══════════════════════════════════════════════════════════════════════════

export interface InvocationSearchFilters {
  q: string;
  agentId: string;
  minScore: number | null;
  maxScore: number | null;
  since: string | null;
  until: string | null;
  promptVersion: string;
  userId: string;
  limit: number;
}

/**
 * GET /search.
 *
 * The `mode` filter (live vs sim) is deliberately NOT applied here: it joins
 * `observability.test_runs`, the harness's own table, and this corpus contains
 * no harness runs at all. The route says so in its degraded note rather than
 * silently answering as if the filter had been honoured — see the route.
 */
export function mockInvocationSearch(f: InvocationSearchFilters, scenario?: ScenarioName): Row[] {
  const sinceMs = f.since ? Date.parse(f.since) : null;
  const untilMs = f.until ? Date.parse(f.until) : null;
  return excludeTestTraffic(traceRows(scenario))
    .filter((r) => !f.q || r.prompt_snippet.toLowerCase().includes(f.q.toLowerCase()))
    .filter((r) => !f.agentId || r.agent_id === f.agentId)
    .filter((r) => f.minScore === null || (r.judge_score !== null && r.judge_score >= f.minScore))
    .filter((r) => f.maxScore === null || (r.judge_score !== null && r.judge_score <= f.maxScore))
    .filter((r) => sinceMs === null || new Date(r.tsIso).getTime() >= sinceMs)
    .filter((r) => untilMs === null || new Date(r.tsIso).getTime() <= untilMs)
    .filter((r) => !f.promptVersion || r.prompt_version === f.promptVersion)
    .filter((r) => !f.userId || r.user_id === f.userId)
    .sort((a, b) => b.tsIso.localeCompare(a.tsIso))
    .slice(0, Math.max(0, f.limit))
    .map(toSearchRow);
}

function toSearchRow(r: MockTraceRow): Row {
  return {
    invocation_id: r.invocation_id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    template_id: r.template_id,
    prompt_snippet: r.prompt_snippet,
    response_snippet: r.response_snippet,
    judge_score: r.judge_score,
    schema_valid: r.schema_valid,
    duration_ms: r.duration_ms,
    total_cost_usd: r.total_cost_usd,
    prompt_version: r.prompt_version,
    model_id: r.model_id,
    parent_invocation_id: r.parent_invocation_id,
    user_id: r.user_id,
    ts: r.ts,
  };
}

/** GET /:invocationId — the full trace row, or `[]` for a 404. */
export function mockInvocationDetailRow(invocationId: string, scenario?: ScenarioName): Row[] {
  const r = traceRows(scenario).find((x) => x.invocation_id === invocationId);
  if (!r) return [];
  return [{
    invocation_id: r.invocation_id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    template_id: r.template_id,
    prompt_snippet: r.prompt_snippet,
    response_snippet: r.response_snippet,
    judge_score: r.judge_score,
    judge_rationale: r.judge_rationale,
    schema_valid: r.schema_valid,
    pii_detected: r.pii_detected,
    guardrail_action: r.guardrail_action,
    duration_ms: r.duration_ms,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    judge_input_tokens: r.judge_input_tokens,
    judge_output_tokens: r.judge_output_tokens,
    est_cost_usd: r.est_cost_usd,
    judge_cost_usd: r.judge_cost_usd,
    total_cost_usd: r.total_cost_usd,
    prompt_version: r.prompt_version,
    model_id: r.model_id,
    runtime_image_digest: r.runtime_image_digest,
    parent_invocation_id: r.parent_invocation_id,
    user_id: r.user_id,
    session_id: r.session_id,
    human_label: r.human_label,
    human_note: r.human_note,
    ts: r.ts,
  }];
}

/** The `tool_calls` half of the detail view, ordered `started_at ASC`. */
export function mockInvocationToolCalls(invocationId: string, scenario?: ScenarioName): Row[] {
  return toolCallRows(scenario)
    .filter((c) => c.invocation_id === invocationId)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.tool_call_id.localeCompare(b.tool_call_id))
    .map((c) => ({
      tool_call_id: c.tool_call_id,
      tool_name: c.tool_name,
      started_at: c.started_at,
      duration_ms: c.duration_ms,
      input_size: c.input_size,
      output_size: c.output_size,
      errored: c.errored,
      error_message: c.error_message,
      input_sample: c.input_sample,
      output_sample: c.output_sample,
      est_cost_usd: c.est_cost_usd,
    }));
}

/** The parent-summary lookup (`WHERE invocation_id = :pid`). */
export function mockInvocationSummaryRow(invocationId: string, scenario?: ScenarioName): Row[] {
  const r = traceRows(scenario).find((x) => x.invocation_id === invocationId);
  if (!r) return [];
  return [{ invocation_id: r.invocation_id, agent_id: r.agent_id, agent_name: r.agent_name, ts: r.ts, user_id: r.user_id }];
}

/** The children lookup (`WHERE parent_invocation_id IN (...)`), oldest first. */
export function mockInvocationChildren(parentIds: readonly string[], scenario?: ScenarioName): Row[] {
  const wanted = new Set(parentIds);
  return traceRows(scenario)
    .filter((r) => r.parent_invocation_id !== null && wanted.has(r.parent_invocation_id))
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso))
    .map((r) => ({
      invocation_id: r.invocation_id,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      judge_score: r.judge_score,
      duration_ms: r.duration_ms,
      parent_invocation_id: r.parent_invocation_id,
      user_id: r.user_id,
      ts: r.ts,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/memory.ts
// ═══════════════════════════════════════════════════════════════════════════

/** GET /events — the feed, newest first. */
export function mockMemoryEvents(
  invocationId: string | null,
  agentId: string | null,
  kind: string | null,
  limit: number,
  scenario?: ScenarioName,
): Row[] {
  return memoryEventRows(scenario)
    .filter((e) => !invocationId || e.invocation_id === invocationId)
    .filter((e) => !agentId || e.agent_id === agentId)
    .filter((e) => !kind || e.kind === kind)
    .sort((a, b) => b.tsIso.localeCompare(a.tsIso))
    .slice(0, Math.max(0, limit))
    .map(toMemoryEventRow);
}

function toMemoryEventRow(e: MockMemoryEventRow): Row {
  return {
    memory_event_id: e.memory_event_id,
    invocation_id: e.invocation_id,
    agent_id: e.agent_id,
    session_id: e.session_id,
    kind: e.kind,
    memory_id: e.memory_id,
    query_text: e.query_text,
    result_count: e.result_count,
    duration_ms: e.duration_ms,
    retrieved_summary: e.retrieved_summary,
    errored: e.errored,
    error_message: e.error_message,
    ts: e.ts,
  };
}

/**
 * GET /stats — per-agent memory rollup.
 *
 * `cold_sessions` is the route's own definition, reproduced: group the window's
 * retrieves by (agent, session) and count the groups whose result counts sum to
 * zero. Sessions with no retrieve at all are not counted as cold, which is why
 * the grouping is over retrieves rather than over every event.
 */
export function mockMemoryStats(windowHours: number, scenario?: ScenarioName): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  const rows = memoryEventRows(scenario).filter((e) => new Date(e.tsIso).getTime() > cutoff);

  const coldByAgent = new Map<string, number>();
  for (const [key, group_] of group(
    rows.filter((e) => e.kind === 'retrieve' && e.session_id !== null),
    (e) => `${e.agent_id}|${e.session_id}`,
  )) {
    const agentId = key.split('|')[0]!;
    const retrieved = sum(group_.map((e) => e.result_count ?? 0));
    if (retrieved === 0) coldByAgent.set(agentId, (coldByAgent.get(agentId) ?? 0) + 1);
  }

  return [...group(rows, (e) => e.agent_id).entries()]
    .map(([agentId, group_]) => {
      const retrieveMs = group_
        .filter((e) => e.kind === 'retrieve' && e.duration_ms !== null)
        .map((e) => e.duration_ms!);
      return {
        agent_id: agentId,
        retrieves: group_.filter((e) => e.kind === 'retrieve').length,
        writes: group_.filter((e) => e.kind === 'write').length,
        // The SQL no longer zero-fills these: a retrieve p50 of 0ms is not a
        // measurement, it is an agent that never retrieved. Mirror the null.
        p50_ms: percentileCont(retrieveMs, 0.5),
        p99_ms: percentileCont(retrieveMs, 0.99),
        errors: group_.filter((e) => e.errored).length,
        total: group_.length,
        cold_sessions: coldByAgent.get(agentId) ?? 0,
      };
    })
    .sort((a, b) => b.retrieves - a.retrieves || b.writes - a.writes);
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/cost.ts
//
// Seven of the eight reads are the SAME windowed, test-traffic-excluded rows
// every other surface in this file counts — cost is just another cut of
// `observability.invocation_traces`, so a change to the corpus above (a
// telemetry profile's `usdPer1kIn`/`usdPer1kOut`, the tail's token counts)
// moves these rollups exactly as it moves Drift's and Traffic's. Nothing here
// is a stored dollar figure: every total is `sum()`/`group()` over
// `est_cost_usd`/`judge_cost_usd`/`total_cost_usd`, the same fields
// `traceRows()` already derives from each row's tail entry and its agent's
// authored per-token rate.
//
// `deploy-markers` is the one exception: the route reads
// `observability.prompt_versions`, not the trace table, and the mock follows
// it there — `mock/prompt-versions.ts` already carries every field the route
// needs (agentId, the content whose short SHA IS `prompt_version`,
// registeredAt, notes), so no new fixture rows are added for this section.
// ═══════════════════════════════════════════════════════════════════════════

/** `SUM(x) FILTER (WHERE cond)` — same skip-NULL rule as `sum()` above. */
function sumWhere<T>(rows: readonly T[], cond: (r: T) => boolean, value: (r: T) => number | null): number {
  return sum(rows.filter(cond).map(value));
}

/** GET /total — the single-row aggregate over the window. */
export function mockCostTotal(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [{
    invocations: rows.length,
    with_cost: rows.filter((r) => r.total_cost_usd !== null).length,
    total_cost_usd: sum(rows.map((r) => r.total_cost_usd)),
    input_tokens: sum(rows.map((r) => r.input_tokens)),
    output_tokens: sum(rows.map((r) => r.output_tokens)),
  }];
}

/** GET /per-agent — `ORDER BY total_cost_usd DESC, invocations DESC`. */
export function mockCostPerAgent(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [...group(rows, (r) => r.agent_id).entries()]
    .map(([agentId, group_]) => ({
      agent_id: agentId,
      invocations: group_.length,
      with_cost: group_.filter((r) => r.total_cost_usd !== null).length,
      input_tokens: sum(group_.map((r) => r.input_tokens)),
      output_tokens: sum(group_.map((r) => r.output_tokens)),
      est_cost_usd: sum(group_.map((r) => r.est_cost_usd)),
      judge_cost_usd: sum(group_.map((r) => r.judge_cost_usd)),
      total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || b.invocations - a.invocations);
}

/** GET /timeseries — bucketed per-agent cost, optional agent filter. */
export function mockCostTimeseries(
  windowHours: number,
  bucketMin: number,
  agentId: string | undefined,
  scenario?: ScenarioName,
): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario))
    .filter((r) => !agentId || r.agent_id === agentId);
  const buckets = group(rows, (r) => `${bucketStart(r.tsIso, bucketMin)}|${r.agent_id}`);
  return [...buckets.entries()]
    .map(([key, group_]) => {
      const [bucket, agent] = key.split('|');
      return {
        bucket_start: bucket!,
        agent_id: agent!,
        invocations: group_.length,
        with_cost: group_.filter((r) => r.total_cost_usd !== null).length,
        total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
      };
    })
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.agent_id.localeCompare(b.agent_id));
}

/** GET /top — the most expensive invocations. `total_cost_usd IS NOT NULL` only. */
export function mockCostTop(windowHours: number, limit: number, scenario?: ScenarioName): Row[] {
  return excludeTestTraffic(tracesInWindow(windowHours, scenario))
    .filter((r) => r.total_cost_usd !== null)
    .sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0))
    .slice(0, Math.max(0, limit))
    .map((r) => ({
      invocation_id: r.invocation_id,
      agent_id: r.agent_id,
      prompt_snippet: r.prompt_snippet,
      total_cost_usd: r.total_cost_usd,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      ts: r.ts,
      prompt_version: r.prompt_version,
    }));
}

/** GET /by-model — `COALESCE(model_id, '(unknown)')`, same ordering as per-agent. */
export function mockCostByModel(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  return [...group(rows, (r) => r.model_id ?? '(unknown)').entries()]
    .map(([modelId, group_]) => ({
      model_id: modelId,
      invocations: group_.length,
      with_cost: group_.filter((r) => r.total_cost_usd !== null).length,
      input_tokens: sum(group_.map((r) => r.input_tokens)),
      output_tokens: sum(group_.map((r) => r.output_tokens)),
      total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
    }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd || b.invocations - a.invocations);
}

/** GET /a2a-overhead — spend split on `parent_invocation_id IS NOT NULL`. */
export function mockCostA2AOverhead(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  const isA2a = (r: MockTraceRow): boolean => r.parent_invocation_id !== null;
  return [{
    total_invocations: rows.length,
    a2a_invocations: rows.filter(isA2a).length,
    direct_invocations: rows.filter((r) => !isA2a(r)).length,
    total_cost_usd: sum(rows.map((r) => r.total_cost_usd)),
    a2a_cost_usd: sumWhere(rows, isA2a, (r) => r.total_cost_usd),
    direct_cost_usd: sumWhere(rows, (r) => !isA2a(r), (r) => r.total_cost_usd),
  }];
}

/** GET /value-ratio — cost per "good" (`judge_score >= 0.7`) response, per agent. */
export function mockCostValueRatio(windowHours: number, scenario?: ScenarioName): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  const isGood = (r: MockTraceRow): boolean => r.judge_score !== null && r.judge_score >= 0.7;
  return [...group(rows, (r) => r.agent_id).entries()]
    .map(([agentId, group_]) => ({
      agent_id: agentId,
      total_responses: group_.length,
      total_cost_usd: sum(group_.map((r) => r.total_cost_usd)),
      good_responses: group_.filter(isGood).length,
      good_cost_usd: sumWhere(group_, isGood, (r) => r.total_cost_usd),
    }))
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

/**
 * GET /deploy-markers — `ORDER BY registered_at ASC`, reading the prompt
 * registry rather than the trace table. `windowHours` is the route's own
 * (wider) default/cap; this selector applies whatever it is handed.
 */
export function mockCostDeployMarkers(windowHours: number): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  return mockListPromptVersions(10_000)
    .filter((r) => new Date(r.registeredAt).getTime() > cutoff)
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
    .map((r) => ({
      prompt_version: r.promptVersion,
      agent_id: r.agentId,
      registered_at: r.registeredAt,
      notes: r.notes,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// routes/oncall.ts
//
// The one router that read straight through `exec()` with no mock branch at
// all — every one of its four routes threw under `dev:mock`, was caught, and
// answered an empty payload, so the incident surface rendered blank while the
// pages either side of it (drift, cost) showed the same 24h of traffic. The
// quality-signal half of the alarm probe is NOT duplicated here: it is
// byte-for-byte the same per-agent cnt/conformance/p05/drift_p95 rollup
// `mockDriftSummary` already computes, so `routes/oncall.ts` calls that
// selector directly over a 1-hour window rather than this file growing a
// second copy of it. Everything below is the other half: the HITL queue
// (`observability.approvals`, a table no other router reads) and the
// per-bucket / per-event shapes unique to this router's SQL.
// ═══════════════════════════════════════════════════════════════════════════

function approvalsAll(scenario?: ScenarioName): MockApprovalRow[] {
  return approvalRequests.rows(scenario);
}

/** `EXTRACT(EPOCH FROM (decided_at - requested_at))` — NULL until decided. */
function decisionSecondsOf(r: MockApprovalRow): number | null {
  return r.decided_at
    ? (new Date(r.decided_at).getTime() - new Date(r.requested_at).getTime()) / 1000
    : null;
}

/**
 * `computeAlarms()`'s HITL probe — pending count and the oldest pending
 * request's age, over the WHOLE table. The real query carries no
 * `WHERE ts > …` at all, so this reads every row regardless of `windowHours`
 * — deliberately unwindowed, the same as the SQL beside it.
 */
export function mockOncallHitlAlarmProbe(scenario?: ScenarioName): Row[] {
  const pending = approvalsAll(scenario).filter((r) => r.status === 'PENDING');
  const oldestAgeS = pending.length === 0
    ? null
    : (nowMs() - Math.min(...pending.map((r) => new Date(r.requested_at).getTime()))) / 1000;
  return [{ pending: pending.length, oldest_age_s: oldestAgeS }];
}

/**
 * GET /timeline's `bucketsSql` — per-bucket rollup ACROSS the whole fleet
 * (unlike `mockDriftSummary`, which groups by agent), test traffic excluded.
 * `drift_p95`/`judge_p05` are plain percentiles, NULL over no rows: the real
 * SQL's `COALESCE(PERCENTILE_CONT(...), NULL)` is a no-op, so — unlike the
 * alarm probe's `COALESCE(..., 0)` — a quiet bucket stays NULL, not 0.
 */
export function mockOncallTimelineBuckets(
  windowHours: number,
  bucketMin: number,
  scenario?: ScenarioName,
): Row[] {
  const rows = excludeTestTraffic(tracesInWindow(windowHours, scenario));
  const buckets = group(rows, (r) => bucketStart(r.tsIso, bucketMin));
  return [...buckets.entries()]
    .map(([bucket, group_]) => ({
      bucket_start: bucket,
      invocations: group_.length,
      drift_p95: percentileCont(distances(group_), 0.95),
      judge_p05: percentileCont(judgeScores(group_), 0.05),
      errors: group_.filter(isRealFailure).length,
      cost_usd: sum(group_.map((r) => r.total_cost_usd)),
    }))
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

/**
 * GET /timeline's `hitlSql` — decided count per bucket plus the running
 * pending count at each bucket's END. The bucket SET comes from
 * `invocation_traces` with NO test-traffic filter, matching the real
 * `buckets` CTE exactly — this is the one bucketing read in the router that
 * does not exclude `test:%`. `pending` mirrors the correlated subquery: a
 * request counts as pending at a bucket when it was requested at-or-before
 * the bucket's end and either was never decided or was decided after it.
 * Bucketing is done in epoch ms internally (`bucketStartMs`) and only
 * converted to the `::text` wire form at the end, so the two bucket sets this
 * function and `mockOncallTimelineBuckets` produce key-match exactly — the
 * route merges the two by that string.
 */
export function mockOncallTimelineHitl(
  windowHours: number,
  bucketMin: number,
  scenario?: ScenarioName,
): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  const bucketStartsMs = new Set(
    tracesInWindow(windowHours, scenario).map((r) => bucketStartMs(r.tsIso, bucketMin)),
  );
  const approvals = approvalsAll(scenario);
  const decidedInWindow = approvals.filter(
    (r) => r.decided_at !== null && new Date(r.decided_at).getTime() > cutoff,
  );
  const decidedByBucketMs = group(decidedInWindow, (r) => String(bucketStartMs(r.decided_at!, bucketMin)));

  return [...bucketStartsMs]
    .sort((a, b) => a - b)
    .map((startMs) => {
      const endMs = startMs + bucketMin * 60_000;
      const decided = (decidedByBucketMs.get(String(startMs)) ?? []).length;
      const pending = approvals.filter((r) => {
        const requestedMs = new Date(r.requested_at).getTime();
        const decidedMs = r.decided_at ? new Date(r.decided_at).getTime() : null;
        return r.status === 'PENDING' && requestedMs <= endMs && (decidedMs === null || decidedMs > endMs);
      }).length;
      return { bucket_start: pgTimestamp(startMs), decided, pending };
    });
}

/**
 * GET /hitl-sla — queue health over `windowHours`. `pending_count` and
 * `oldest_pending_age_s` are the two subqueries in the real SQL that read
 * `observability.approvals` with NO `requested_at` filter at all; everything
 * else reads the `win` CTE, which does apply the window.
 */
export function mockOncallHitlSla(windowHours: number, scenario?: ScenarioName): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  const all = approvalsAll(scenario);
  const win = all.filter((r) => new Date(r.requested_at).getTime() > cutoff);

  const pendingAll = all.filter((r) => r.status === 'PENDING');
  const oldestPendingAgeS = pendingAll.length === 0
    ? null
    : (nowMs() - Math.min(...pendingAll.map((r) => new Date(r.requested_at).getTime()))) / 1000;

  const decided = win.filter(
    (r) => r.decided_at !== null && (r.status === 'APPROVED' || r.status === 'REJECTED'),
  ).length;

  const decisionSecondsInWin = win.map(decisionSecondsOf).filter((s): s is number => s !== null);
  const expired = win.filter((r) => r.status === 'EXPIRED').length;
  const SLA_SECONDS = 5 * 60;

  return [{
    pending_count: pendingAll.length,
    oldest_pending_age_s: oldestPendingAgeS,
    decided,
    p50_s: percentileCont(decisionSecondsInWin, 0.5),
    p99_s: percentileCont(decisionSecondsInWin, 0.99),
    expired,
    within_sla: decisionSecondsInWin.filter((s) => s < SLA_SECONDS).length,
    sla_total: decisionSecondsInWin.length,
  }];
}

/**
 * GET /recent-events' deploy source — same registry read as
 * `/cost/deploy-markers` (`mockCostDeployMarkers`), re-aliased to `ts` (the
 * real SQL's `registered_at::text AS ts`) and re-ordered DESC LIMIT 200 to
 * match this route's own SQL rather than the cost route's ASC.
 */
export function mockOncallRecentDeploys(windowHours: number): Row[] {
  return mockCostDeployMarkers(windowHours)
    .slice()
    .sort((a, b) => String(b['registered_at']).localeCompare(String(a['registered_at'])))
    .slice(0, 200)
    .map((r) => ({
      ts: r['registered_at'],
      agent_id: r['agent_id'],
      prompt_version: r['prompt_version'],
      notes: r['notes'],
    }));
}

/** GET /recent-events' HITL source — decided (incl. expired) in the window, newest first, LIMIT 200. */
export function mockOncallHitlDecisionEvents(windowHours: number, scenario?: ScenarioName): Row[] {
  const cutoff = nowMs() - windowHours * 3_600_000;
  return approvalsAll(scenario)
    .filter((r) => r.decided_at !== null && new Date(r.decided_at).getTime() > cutoff)
    .sort((a, b) => b.decided_at!.localeCompare(a.decided_at!))
    .slice(0, 200)
    .map((r) => ({
      approval_id: r.approval_id,
      ts: pgTimestamp(r.decided_at!),
      status: r.status,
      agent_id: r.agent_id,
      decided_by: r.decided_by,
      decided_note: r.decided_note,
    }));
}

/** GET /recent-events' judge-regression source — `judge_score < 0.3` in the window, test traffic excluded, newest first, LIMIT 200. */
export function mockOncallJudgeRegressions(windowHours: number, scenario?: ScenarioName): Row[] {
  return excludeTestTraffic(tracesInWindow(windowHours, scenario))
    .filter((r) => r.judge_score !== null && r.judge_score < 0.3)
    .sort((a, b) => b.tsIso.localeCompare(a.tsIso))
    .slice(0, 200)
    .map((r) => ({
      invocation_id: r.invocation_id,
      ts: r.ts,
      agent_id: r.agent_id,
      judge_score: r.judge_score,
      judge_rationale: r.judge_rationale,
      response_snippet: r.response_snippet,
      prompt_snippet: r.prompt_snippet,
    }));
}

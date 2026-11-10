// Invocations routes — surface a searchable view of observability.invocation_traces
// plus the per-invocation drill-down used by the triage workflow.
//
// Mounted at /api/observability/invocations BEFORE the gated /api/observability
// router (see index.ts). Same pattern as cost / harness / approvals: ungated so
// internal dashboards can hit it without a session cookie.
//
// Endpoints:
//   GET  /search                       — full-text-ish search across recent
//                                        invocations (substring on
//                                        prompt_snippet + filters)
//   GET  /:invocationId                — full row + tool calls + parent +
//                                        child invocations (depth 2)
//   POST /:invocationId/replay         — re-invoke the agent with the source
//                                        prompt and sink the result as a child
//                                        trace
//
// All Aurora I/O goes through providers/aurora.ts exec(). All endpoints
// degrade defensively: missing tables or empty result sets yield empty
// responses rather than 500s. We filter out test:* rows in /search because the
// search view is the live-traffic surface, but we do NOT filter them in the
// detail view — clicking into a test row should still work.

import { Router, type Request, type Response } from 'express';
import { requireAction } from '../lib/authz.js';
import { traceScope, scopeSql, rowInScope } from '../lib/trace-scope.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { asyncHandler } from '../lib/async-handler.js';
import { reasonLine } from '../lib/upstream.js';
import { exec } from '../providers/aurora.js';
import { agentcore as agentCoreProvider } from '../providers/index.js';
import { mockRuntimeArn } from '../lib/devbox-arn.js';
import { clock } from '../mock/core/index.js';
import { config } from '../config.js';
import { processTrace } from '../lib/trace-sink.js';
import {
  mockInvocationChildren,
  mockInvocationDetailRow,
  mockInvocationSearch,
  mockInvocationSummaryRow,
  mockInvocationToolCalls,
} from '../mock/observability-queries.js';

/**
 * Marks a response whose query failed — the wrapper from routes/cost.ts, kept
 * local so each router owns its own copy.
 *
 * Every read below answers 200 with an empty payload rather than failing the
 * page, which is the right call. What it cost was the difference between
 * "nothing happened in this window" and "the query blew up": both rendered as
 * an empty panel. The marker restores it without touching the healthy shape —
 * a quiet window answers exactly as it did before, and only a caught failure
 * carries `degraded` + the first line of the error.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: reasonLine(err) };
}

export const invocationsRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

// Whose traces a caller may read: lib/trace-scope.ts, shared with every route
// that returns snippet text from invocation_traces.

function clampLimit(raw: string | undefined, def = 50, max = 500): number {
  const n = parseInt(raw ?? String(def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function isUuid(s: string | undefined): s is string {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

// Treat a possibly-malformed ISO string as a Postgres timestamp literal. We
// bind via :param::timestamptz so Postgres does the parsing. If parsing fails
// at the DB layer it'll surface as a 500 via the catch — we don't pre-validate
// because Postgres accepts many shapes (RFC-3339, "YYYY-MM-DD HH:MM:SS", etc).
function safeIsoOrNull(raw: string | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? trimmed : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /search — find recent invocations matching the supplied filters.
//
// Query params (all optional, all combine with AND):
//   q              — substring match against prompt_snippet (ILIKE %q%)
//   agentId        — exact match on agent_id
//   minScore       — judge_score >= minScore
//   maxScore       — judge_score <= maxScore
//   mode           — 'live' | 'sim' (joins test_runs on the latest run for the
//                    trace via invocation_id)
//   since / until  — ts >= since / ts <= until (ISO strings)
//   promptVersion  — exact match
//   userId         — exact match
//   limit          — default 50, max 500
//
// Test rows (template_id LIKE 'test:%') are filtered out — same pattern as
// drift.ts and cost.ts. Result is always a populated object even on DB error.
// ─────────────────────────────────────────────────────────────────────────────
interface InvocationSearchRow {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  schemaValid: boolean | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
  parentInvocationId: string | null;
  userId: string | null;
  ts: string;
}

invocationsRouter.get('/search', asyncHandler(async (req, res) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const agentId = typeof req.query['agentId'] === 'string'
    ? req.query['agentId'].trim()
    : '';
  const minScoreRaw = req.query['minScore'];
  const maxScoreRaw = req.query['maxScore'];
  const minScore = typeof minScoreRaw === 'string' && minScoreRaw.trim()
    ? Number(minScoreRaw)
    : null;
  const maxScore = typeof maxScoreRaw === 'string' && maxScoreRaw.trim()
    ? Number(maxScoreRaw)
    : null;
  const modeRaw = typeof req.query['mode'] === 'string'
    ? req.query['mode'].trim()
    : '';
  const mode = modeRaw === 'live' || modeRaw === 'sim' ? modeRaw : null;
  const since = safeIsoOrNull(req.query['since'] as string | undefined);
  const until = safeIsoOrNull(req.query['until'] as string | undefined);
  const promptVersion = typeof req.query['promptVersion'] === 'string'
    ? req.query['promptVersion'].trim()
    : '';
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  // `?userId=` is a filter only a fleet-wide role may choose; everyone else is
  // pinned to their own id and their own tenant whatever the query says.
  const userId = scope?.userId
    ?? (typeof req.query['userId'] === 'string' ? req.query['userId'].trim() : '');
  const limit = clampLimit(req.query['limit'] as string | undefined, 50, 500);

  // Build WHERE clauses incrementally. We never inline user-supplied strings;
  // everything goes through bound parameters. The `t.` alias points at
  // invocation_traces; the optional mode filter joins test_runs via a
  // results-table bridge (test_results.invocation_id <-> test_runs.run_id).
  const whereClauses: string[] = [
    `(t.template_id NOT LIKE 'test:%' OR t.template_id IS NULL)`,
  ];
  const params: SqlParameter[] = [];

  if (q) {
    whereClauses.push(`t.prompt_snippet ILIKE :q`);
    params.push({ name: 'q', value: { stringValue: `%${q}%` } });
  }
  if (agentId) {
    whereClauses.push(`t.agent_id = :agent_id`);
    params.push({ name: 'agent_id', value: { stringValue: agentId } });
  }
  if (minScore !== null && Number.isFinite(minScore)) {
    whereClauses.push(`t.judge_score >= :min_score`);
    params.push({ name: 'min_score', value: { doubleValue: minScore } });
  }
  if (maxScore !== null && Number.isFinite(maxScore)) {
    whereClauses.push(`t.judge_score <= :max_score`);
    params.push({ name: 'max_score', value: { doubleValue: maxScore } });
  }
  if (since) {
    whereClauses.push(`t.ts >= :since::timestamptz`);
    params.push({ name: 'since', value: { stringValue: since } });
  }
  if (until) {
    whereClauses.push(`t.ts <= :until::timestamptz`);
    params.push({ name: 'until', value: { stringValue: until } });
  }
  if (promptVersion) {
    whereClauses.push(`t.prompt_version = :pv`);
    params.push({ name: 'pv', value: { stringValue: promptVersion } });
  }
  if (userId) {
    whereClauses.push(`t.user_id = :uid`);
    params.push({ name: 'uid', value: { stringValue: userId } });
  }
  if (scope) {
    whereClauses.push(`t.tenant = :scope_tenant`);
    params.push({ name: 'scope_tenant', value: { stringValue: scope.tenant } });
  }

  // Mode filter is a soft join — invocation_traces doesn't carry mode itself,
  // but test_results -> test_runs does. We use a sub-EXISTS so the join can't
  // duplicate trace rows. If no row in test_results maps the invocation, the
  // EXISTS yields false and the trace is excluded.
  if (mode) {
    whereClauses.push(`EXISTS (
      SELECT 1
        FROM observability.test_results tr
        JOIN observability.test_runs trn ON trn.run_id = tr.run_id
       WHERE tr.invocation_id = t.invocation_id
         AND trn.mode = :mode
    )`);
    params.push({ name: 'mode', value: { stringValue: mode } });
  }

  params.push({ name: 'lim', value: { longValue: limit } });

  const sql = `
    SELECT t.invocation_id::text                  AS invocation_id,
           t.agent_id,
           t.agent_name,
           t.template_id,
           COALESCE(t.prompt_snippet, '')         AS prompt_snippet,
           COALESCE(t.response_snippet, '')       AS response_snippet,
           t.judge_score,
           t.schema_valid,
           t.duration_ms,
           t.total_cost_usd,
           t.prompt_version,
           t.model_id,
           t.parent_invocation_id::text           AS parent_invocation_id,
           t.user_id,
           t.ts::text                             AS ts
      FROM observability.invocation_traces t
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY t.ts DESC
     LIMIT :lim`;

  try {
    const rows = config.mock.aurora
      ? mockInvocationSearch({ q, agentId, minScore, maxScore, since, until, promptVersion, userId, limit })
        .filter((r) => rowInScope(scope, r))
      : await exec(sql, params);
    const invocations: InvocationSearchRow[] = rows.map((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      agentName: String(r['agent_name'] ?? ''),
      templateId: r['template_id'] == null ? null : String(r['template_id']),
      promptSnippet: String(r['prompt_snippet'] ?? ''),
      responseSnippet: String(r['response_snippet'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      totalCostUsd: r['total_cost_usd'] == null ? null : Number(r['total_cost_usd']),
      promptVersion: r['prompt_version'] == null ? null : String(r['prompt_version']),
      modelId: r['model_id'] == null ? null : String(r['model_id']),
      parentInvocationId: r['parent_invocation_id'] == null ? null : String(r['parent_invocation_id']),
      userId: r['user_id'] == null ? null : String(r['user_id']),
      ts: String(r['ts'] ?? ''),
    }));
    // `mode` joins observability.test_runs, the harness's own table, and the
    // offline corpus holds no harness runs at all — so rather than answer as
    // if the filter had been applied, say it was not. A silently-ignored
    // filter is the same class of lie as an empty list that means "broken".
    if (config.mock.aurora && mode) {
      res.json({
        invocations,
        count: invocations.length,
        degraded: true,
        error: `mode=${mode} filters on observability.test_runs, which dev:mock does not seed — results are unfiltered`,
      });
      return;
    }
    res.json({ invocations, count: invocations.length });
  } catch (err) {
    console.warn('[invocations] /search failed:', (err as Error).message);
    // `count: 0` beside an empty list reads as a real zero — a search that
    // matched nothing. Marked, it reads as what it is: we could not search.
    res.json(degraded({ invocations: [] as InvocationSearchRow[], count: 0 }, err));
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /:invocationId — full row + tool calls + parent + child invocations.
//
// Always returns the trace (no test-row filter — if you clicked into a test
// invocation deliberately, you want to see it). Children include depth-2
// grandchildren so the portal can render a small waterfall without N+1.
// 404 if the trace doesn't exist.
// ─────────────────────────────────────────────────────────────────────────────
interface InvocationDetail {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  judgeRationale: string | null;
  schemaValid: boolean | null;
  piiDetected: boolean;
  guardrailAction: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
  estCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
  runtimeImageDigest: string | null;
  parentInvocationId: string | null;
  userId: string | null;
  sessionId: string | null;
  humanLabel: string | null;
  humanNote: string | null;
  ts: string;
}

interface ToolCallRow {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  durationMs: number | null;
  inputSize: number | null;
  outputSize: number | null;
  errored: boolean;
  errorMessage: string | null;
  inputSample: string | null;
  outputSample: string | null;
  estCostUsd: number | null;
}

interface ChildSummary {
  invocationId: string;
  agentId: string;
  agentName: string;
  judgeScore: number | null;
  durationMs: number | null;
  ts: string;
  grandchildren?: ChildSummary[];
}

interface ParentSummary {
  invocationId: string;
  agentId: string;
  agentName: string;
  ts: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /:invocationId under dev:mock.
//
// WHY IT IS NOT A SEPARATE MAPPING ANY MORE. This route used to carry a second
// hand-written projection: it looked the id up in `getRecentInvocations` and
// built an InvocationDetail with every DB-only field (judge score, tokens,
// cost, model) nulled, "rather than inventing values invocation_traces would
// actually carry" (org-leader.md #22). That was the right call while nothing
// else offline had those values. It is the wrong one now that the whole
// observability surface is seeded from the same fleet: the search list would
// show this row scoring 0.83 and costing $0.0021 while its own detail page
// showed a dash for both — the count-vs-list defect, one click apart.
//
// So the mock branch is no longer a second projection. `mock/observability-
// queries.ts` returns the same snake_case rows `exec()` returns for each of
// these four statements, and the SAME `rows.map(...)` below builds the wire
// body on both paths. There is one mapping, and the detail page shows exactly
// what the list that linked to it showed.
//
// The id shape check stays for the live path only: `:id::uuid` requires a
// UUID, while the offline corpus is keyed on the invocation tail's ids
// (`mock-inv-33`). An id neither path can resolve still 404s.
// ─────────────────────────────────────────────────────────────────────────────

invocationsRouter.get('/:invocationId', asyncHandler(async (req, res) => {
  const id = String(req.params['invocationId'] ?? '').trim();
  const useMock = config.mock.aurora;
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const scoped = scopeSql(scope);
  if (!useMock && !isUuid(id)) {
    res.status(404).json({ error: 'invocation not found' });
    return;
  }

  // 1) Pull the trace row itself.
  let invocation: InvocationDetail | null = null;
  try {
    const rows = useMock ? mockInvocationDetailRow(id) : await exec(
      `SELECT invocation_id::text                  AS invocation_id,
              agent_id, agent_name, template_id,
              COALESCE(prompt_snippet, '')         AS prompt_snippet,
              COALESCE(response_snippet, '')       AS response_snippet,
              judge_score, judge_rationale,
              schema_valid, pii_detected, guardrail_action, duration_ms,
              input_tokens, output_tokens,
              judge_input_tokens, judge_output_tokens,
              est_cost_usd, judge_cost_usd, total_cost_usd,
              prompt_version, model_id, runtime_image_digest,
              parent_invocation_id::text           AS parent_invocation_id,
              user_id, session_id,
              human_label, human_note,
              ts::text                             AS ts
         FROM observability.invocation_traces
        WHERE invocation_id = :id::uuid${scoped.clause}`,
      [{ name: 'id', value: { stringValue: id } }, ...scoped.params],
    );
    // Out of scope answers exactly like a missing id: the caller learns
    // nothing about a trace that is not theirs, not even that it exists.
    if (rows.length === 0 || !rowInScope(scope, rows[0])) {
      res.status(404).json({ error: 'invocation not found' });
      return;
    }
    const r = rows[0]!;
    invocation = {
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      agentName: String(r['agent_name'] ?? ''),
      templateId: r['template_id'] == null ? null : String(r['template_id']),
      promptSnippet: String(r['prompt_snippet'] ?? ''),
      responseSnippet: String(r['response_snippet'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      judgeRationale: r['judge_rationale'] == null ? null : String(r['judge_rationale']),
      schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
      piiDetected: r['pii_detected'] == null ? false : Boolean(r['pii_detected']),
      guardrailAction: r['guardrail_action'] == null ? null : String(r['guardrail_action']),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      inputTokens: r['input_tokens'] == null ? null : Number(r['input_tokens']),
      outputTokens: r['output_tokens'] == null ? null : Number(r['output_tokens']),
      judgeInputTokens: r['judge_input_tokens'] == null ? null : Number(r['judge_input_tokens']),
      judgeOutputTokens: r['judge_output_tokens'] == null ? null : Number(r['judge_output_tokens']),
      estCostUsd: r['est_cost_usd'] == null ? null : Number(r['est_cost_usd']),
      judgeCostUsd: r['judge_cost_usd'] == null ? null : Number(r['judge_cost_usd']),
      totalCostUsd: r['total_cost_usd'] == null ? null : Number(r['total_cost_usd']),
      promptVersion: r['prompt_version'] == null ? null : String(r['prompt_version']),
      modelId: r['model_id'] == null ? null : String(r['model_id']),
      runtimeImageDigest: r['runtime_image_digest'] == null ? null : String(r['runtime_image_digest']),
      parentInvocationId: r['parent_invocation_id'] == null ? null : String(r['parent_invocation_id']),
      userId: r['user_id'] == null ? null : String(r['user_id']),
      sessionId: r['session_id'] == null ? null : String(r['session_id']),
      humanLabel: r['human_label'] == null ? null : String(r['human_label']),
      humanNote: r['human_note'] == null ? null : String(r['human_note']),
      ts: String(r['ts'] ?? ''),
    };
  } catch (err) {
    console.warn('[invocations] /:id trace lookup failed:', (err as Error).message);
    res.status(500).json({ error: 'invocation lookup failed' });
    return;
  }

  // 2) Tool calls. Best-effort — if the table doesn't exist yet (pre-schema),
  // return an empty array rather than 500.
  let toolCalls: ToolCallRow[] = [];
  try {
    const rows = useMock ? mockInvocationToolCalls(id) : await exec(
      `SELECT tool_call_id::text                   AS tool_call_id,
              tool_name,
              started_at::text                     AS started_at,
              duration_ms, input_size, output_size,
              errored, error_message,
              input_sample, output_sample,
              est_cost_usd
         FROM observability.tool_calls
        WHERE invocation_id = :id::uuid
        ORDER BY started_at ASC, tool_call_id ASC`,
      [{ name: 'id', value: { stringValue: id } }],
    );
    toolCalls = rows.map((r) => ({
      toolCallId: String(r['tool_call_id'] ?? ''),
      toolName: String(r['tool_name'] ?? ''),
      startedAt: String(r['started_at'] ?? ''),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      inputSize: r['input_size'] == null ? null : Number(r['input_size']),
      outputSize: r['output_size'] == null ? null : Number(r['output_size']),
      errored: r['errored'] == null ? false : Boolean(r['errored']),
      errorMessage: r['error_message'] == null ? null : String(r['error_message']),
      inputSample: r['input_sample'] == null ? null : String(r['input_sample']),
      outputSample: r['output_sample'] == null ? null : String(r['output_sample']),
      estCostUsd: r['est_cost_usd'] == null ? null : Number(r['est_cost_usd']),
    }));
  } catch (err) {
    console.warn('[invocations] /:id tool_calls lookup failed:', (err as Error).message);
    toolCalls = [];
  }

  // 3) Parent summary (one row, if present). If the child references a parent
  // invocation_id that hasn't been ingested yet (CW Logs poller lag, agent
  // didn't emit, etc), still return a "ghost" parent — the UI shows
  // "(record not found)" rather than the misleading "no parent" empty state.
  let parent: ParentSummary | null = null;
  if (invocation.parentInvocationId) {
    try {
      const rows = useMock
        ? mockInvocationSummaryRow(invocation.parentInvocationId)
        : await exec(
          `SELECT invocation_id::text AS invocation_id,
                  agent_id, agent_name, ts::text AS ts
             FROM observability.invocation_traces
            WHERE invocation_id = :pid::uuid${scoped.clause}`,
          [{ name: 'pid', value: { stringValue: invocation.parentInvocationId } }, ...scoped.params],
        );
      if (rows.length > 0 && rowInScope(scope, rows[0])) {
        const r = rows[0]!;
        parent = {
          invocationId: String(r['invocation_id'] ?? ''),
          agentId: String(r['agent_id'] ?? ''),
          agentName: String(r['agent_name'] ?? ''),
          ts: String(r['ts'] ?? ''),
        };
      } else {
        // Ghost parent — id is known but row is missing.
        parent = {
          invocationId: invocation.parentInvocationId,
          agentId: '(record not found)',
          agentName: '(record not found)',
          ts: '',
        };
      }
    } catch (err) {
      console.warn('[invocations] /:id parent lookup failed:', (err as Error).message);
      parent = {
        invocationId: invocation.parentInvocationId,
        agentId: '(lookup failed)',
        agentName: '(lookup failed)',
        ts: '',
      };
    }
  }

  // 4) Children + depth-2 grandchildren. We pull everything with parent in
  // {self, child_ids} in a single query, then assemble client-side. This keeps
  // the call to Aurora to two round-trips total instead of N+1.
  let children: ChildSummary[] = [];
  try {
    const directRows = useMock ? mockInvocationChildren([id]) : await exec(
      `SELECT invocation_id::text AS invocation_id,
              agent_id, agent_name,
              judge_score, duration_ms,
              ts::text AS ts
         FROM observability.invocation_traces
        WHERE parent_invocation_id = :id::uuid${scoped.clause}
        ORDER BY ts ASC`,
      [{ name: 'id', value: { stringValue: id } }, ...scoped.params],
    );
    children = directRows.filter((r) => rowInScope(scope, r)).map<ChildSummary>((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      agentName: String(r['agent_name'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      ts: String(r['ts'] ?? ''),
      grandchildren: [],
    }));

    if (children.length > 0) {
      // Pull grandchildren for every direct child in one shot. RDS Data API
      // doesn't accept arrays, so emit :c0, :c1, ... placeholders.
      const placeholders = children.map((_, i) => `:c${i}::uuid`).join(', ');
      const params: SqlParameter[] = children.map((c, i) => ({
        name: `c${i}`,
        value: { stringValue: c.invocationId },
      }));
      const grandRows = useMock
        ? mockInvocationChildren(children.map((c) => c.invocationId))
        : await exec(
        `SELECT invocation_id::text AS invocation_id,
                agent_id, agent_name,
                judge_score, duration_ms,
                parent_invocation_id::text AS parent_invocation_id,
                ts::text AS ts
           FROM observability.invocation_traces
          WHERE parent_invocation_id IN (${placeholders})${scoped.clause}
          ORDER BY ts ASC`,
        [...params, ...scoped.params],
      );
      const byParent = new Map<string, ChildSummary[]>();
      for (const r of grandRows) {
        if (!rowInScope(scope, r)) continue;
        const pid = r['parent_invocation_id'] == null
          ? ''
          : String(r['parent_invocation_id']);
        if (!pid) continue;
        const entry: ChildSummary = {
          invocationId: String(r['invocation_id'] ?? ''),
          agentId: String(r['agent_id'] ?? ''),
          agentName: String(r['agent_name'] ?? ''),
          judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
          durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
          ts: String(r['ts'] ?? ''),
        };
        const arr = byParent.get(pid) ?? [];
        arr.push(entry);
        byParent.set(pid, arr);
      }
      for (const c of children) {
        c.grandchildren = byParent.get(c.invocationId) ?? [];
      }
    }
  } catch (err) {
    console.warn('[invocations] /:id children lookup failed:', (err as Error).message);
    children = [];
  }

  res.json({ invocation, toolCalls, parent, children });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /:invocationId/replay — Sprint 4 (M13).
//
// Replay flow:
//   1. Look up the source invocation row in invocation_traces.
//   2. Resolve the deployed runtime ARN by agent_id → orgiq_<id> match.
//   3. Invoke the runtime via bedrock-agentcore InvokeAgentRuntime.
//   4. Stream + parse the response, capture wall-clock.
//   5. Pipe the replayed (prompt, response) bundle through processTrace, with
//      parent_invocation_id pointing back at the source — the replay appears
//      as a child in the trace tree.
//
// Body: { newPrompt?: string }  — when omitted, the source prompt is reused.
//
// Returns: { invocationId, response, durationMs, agentId, parentInvocationId,
//            judgeScore, persisted, notPersisted? }
//
// OFFLINE (`dev:mock`). This route 500'd long after the libraries beneath it
// were mocked, because all three of its blockers were in the handler ITSELF —
// a bare `exec` source lookup, `getRuntimeArn`'s `ListAgentRuntimes`, and a raw
// `InvokeAgentRuntimeCommand`. Rule 4's write scan reports leaves in
// `src/lib/**` and `src/providers/**` and excludes `exec` everywhere as
// transport, so a handler reaching AWS directly is structurally invisible to
// it: the budget said this route was fine for as long as it was broken. Fixing
// it moves no number, and that is the point of writing it down here.
//
// All three now borrow a seam that already existed rather than inventing a
// fourth: the source row comes from `mockInvocationDetailRow` (the same
// counterpart `GET /:invocationId` reads), the ARN from `lib/devbox-arn.ts`'s
// `mockRuntimeArn` gated on the fleet fixture, and the invocation from
// `mockAgentCore.invokeAgent` — the transport the chat surface and the harness
// runner already speak through. Everything after the invoke is the production
// path unchanged, sampling and the phantom guard included.
// ─────────────────────────────────────────────────────────────────────────────

// ARN cache for deployed runtimes — refreshed lazily on cache miss. AgentCore
// runtime ARNs are stable for a given runtime id, so caching is safe.
let _runtimeArnCache: Map<string, string> | null = null;
let _runtimeCacheFetchedAt = 0;
const RUNTIME_CACHE_TTL_MS = 5 * 60_000;

/** Exported so the harness runner resolves runtimes exactly as replay does. */
export async function getRuntimeArn(agentId: string): Promise<string | null> {
  const runtimeName = agentId.replace(/-/g, '_'); // orgiq-supervisor → orgiq_supervisor

  // OFFLINE. `ListAgentRuntimes` is the second of replay's three handler-level
  // AWS calls, and its failure mode is the quiet one: it catches, returns null,
  // and every caller says "no deployed runtime" — a sentence about the fleet
  // that is really a sentence about the credentials.
  //
  // The answer offline is the same one `lib/devbox-arn.ts` gives for the
  // devbox, from the same function (`mockRuntimeArn`), so there is one spelling
  // of a runtime that was never deployed rather than two. What decides whether
  // there IS one is the fleet fixture, not this function: an agent the mock
  // fleet does not carry still resolves to null, so the 503 stays reachable and
  // `{"scenario":"empty","fixture":"agent-fleet"}` makes every replay 503 —
  // an audit state that otherwise had no way to exist. Not cached: the cache
  // bounds a live ListAgentRuntimes call and there is none to bound.
  if (config.mock.agentcore) {
    const runtime = await agentCoreProvider.getRuntime(agentId);
    return runtime ? mockRuntimeArn(runtimeName) : null;
  }

  const now = Date.now();
  if (
    _runtimeArnCache &&
    _runtimeArnCache.has(runtimeName) &&
    now - _runtimeCacheFetchedAt < RUNTIME_CACHE_TTL_MS
  ) {
    return _runtimeArnCache.get(runtimeName) ?? null;
  }
  try {
    const ctrl = new BedrockAgentCoreControlClient({ region: config.region });
    const resp = await ctrl.send(new ListAgentRuntimesCommand({ maxResults: 50 }));
    const cache = new Map<string, string>();
    for (const r of resp.agentRuntimes ?? []) {
      if (r.agentRuntimeName && r.agentRuntimeArn) {
        cache.set(r.agentRuntimeName, r.agentRuntimeArn);
      }
      // Some deployments use agentRuntimeId as the key; index both shapes.
      if (r.agentRuntimeId && r.agentRuntimeArn) {
        cache.set(r.agentRuntimeId, r.agentRuntimeArn);
      }
    }
    _runtimeArnCache = cache;
    _runtimeCacheFetchedAt = now;
    return cache.get(runtimeName) ?? null;
  } catch (err) {
    console.warn('[invocations] ListAgentRuntimes failed:',
      (err as Error).message);
    return null;
  }
}

interface ReplayBody {
  newPrompt?: string;
}

interface ReplayResponse {
  invocationId: string;
  response: string;
  durationMs: number;
  agentId: string;
  parentInvocationId: string;
  judgeScore: number | null;
  /** Did the sink actually write a row? False when sampled out or dropped. */
  persisted: boolean;
  /** Present only when `persisted` is false: which rule refused it. */
  notPersisted?: string;
  /**
   * Did the stored trace keep the link back to its source?
   *
   * `observability.invocation_traces.parent_invocation_id` is a uuid column, so
   * `processTrace` drops a parent id that is not one. Live that never bites —
   * the id shape check above guarantees a uuid. Offline the seeded corpus is
   * keyed on `mock-inv-<n>`, so the replay persists with a NULL parent and does
   * not appear as a child in the trace tree. `parentInvocationId` above says
   * what was replayed; this says whether the row remembers it.
   */
  parentLinked: boolean;
}

// Mirror harness.py::_parse_agent_response — try common shapes.
function parseAgentResponse(text: string): string {
  const raw = text.trim();
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      const o = obj as Record<string, unknown>;
      const r = (o['response'] ?? o['message'] ?? o['text']) as unknown;
      if (typeof r === 'string' && r) return r;
      if (typeof o['output'] === 'string') return o['output'] as string;
    }
    if (typeof obj === 'string') return obj;
  } catch {
    // not a single JSON blob — try last-line JSON (NDJSON style).
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) {
      try {
        const obj = JSON.parse(last);
        if (obj && typeof obj === 'object') {
          const o = obj as Record<string, unknown>;
          const r = (o['response'] ?? o['message'] ?? o['text']) as unknown;
          if (typeof r === 'string' && r) return r;
        }
      } catch {
        // fall through to raw
      }
    }
  }
  return raw;
}

// Replay RE-INVOKES the deployed agent (real Bedrock spend + side effects, and
// can target a write agent), so it must not ride the observability read tier
// that member/sme hold — that would bypass the ManageIngest direct-invoke gate.
invocationsRouter.post('/:invocationId/replay', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const id = String(req.params['invocationId'] ?? '').trim();
  const useMock = config.mock.aurora;
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const scoped = scopeSql(scope);
  // The id shape check is the live path's, for the same reason it is on
  // `GET /:invocationId`: `:id::uuid` requires a UUID, while the offline
  // corpus is keyed on the invocation tail's ids (`mock-inv-33`). An id
  // neither path can resolve still 404s below, on the lookup itself.
  if (!useMock && !isUuid(id)) {
    res.status(404).json({ error: 'invocation_not_found', invocationId: id });
    return;
  }
  const body = (req.body ?? {}) as ReplayBody;
  const overridePrompt =
    typeof body.newPrompt === 'string' && body.newPrompt.trim()
      ? body.newPrompt
      : null;

  // 1. Source row.
  let sourceAgentId = '';
  let sourcePrompt = '';
  let sourceTemplateId: string | null = null;
  let sourceUserId: string | null = null;
  let sourceSessionId: string | null = null;
  try {
    // OFFLINE. The same seam `GET /:invocationId` reads — one statement, one
    // mock counterpart. This SELECT asks for five of the columns
    // `mockInvocationDetailRow` already returns, so borrowing it keeps the
    // corpus with one definition instead of giving replay a private idea of
    // what a source row is. It was the first of the three handler-level AWS
    // calls, and the one the write-route scan structurally cannot see: `exec`
    // is excluded everywhere as transport, so a bare `exec` in a handler is
    // invisible to it.
    const rows = useMock ? mockInvocationDetailRow(id) : await exec(
      `SELECT agent_id,
              COALESCE(prompt_snippet, '') AS prompt_snippet,
              template_id,
              user_id,
              session_id
         FROM observability.invocation_traces
        WHERE invocation_id = :id::uuid${scoped.clause}`,
      [{ name: 'id', value: { stringValue: id } }, ...scoped.params],
    );
    if (rows.length === 0 || !rowInScope(scope, rows[0])) {
      res.status(404).json({ error: 'invocation_not_found', invocationId: id });
      return;
    }
    const r = rows[0]!;
    sourceAgentId = String(r['agent_id'] ?? '');
    sourcePrompt = String(r['prompt_snippet'] ?? '');
    sourceTemplateId = r['template_id'] == null ? null : String(r['template_id']);
    sourceUserId = r['user_id'] == null ? null : String(r['user_id']);
    sourceSessionId = r['session_id'] == null ? null : String(r['session_id']);
  } catch (err) {
    console.warn('[invocations] /replay source lookup failed:',
      (err as Error).message);
    res.status(500).json({ error: 'replay_lookup_failed', invocationId: id });
    return;
  }

  const finalPrompt = overridePrompt ?? sourcePrompt;
  if (!sourceAgentId || !finalPrompt) {
    res.status(400).json({
      error: 'replay_missing_fields',
      message: 'Source row had no agent_id or prompt to replay.',
      invocationId: id,
    });
    return;
  }

  // 2. Resolve runtime ARN.
  const arn = await getRuntimeArn(sourceAgentId);
  if (!arn) {
    res.status(503).json({
      error: 'replay_runtime_unavailable',
      message: `No deployed runtime found for agent ${sourceAgentId}.`,
      invocationId: id,
      agentId: sourceAgentId,
    });
    return;
  }

  // 3. Invoke the runtime.
  const payload = new TextEncoder().encode(
    JSON.stringify({ prompt: finalPrompt }),
  );
  let responseText = '';
  let durationMs = 0;
  try {
    // OFFLINE, AT THE TRANSPORT — the third handler-level AWS call, and the
    // same seam `lib/harness-runner.ts` invokes through. `mockAgentCore
    // .invokeAgent` is what the chat surface streams, so a replay offline
    // re-asks the fleet's own mock rather than growing a third idea of what an
    // agent says. Everything after this line is the production path: the
    // response goes through the same `parseAgentResponse`, into the same
    // `processTrace`, under the same sampling die and the same phantom rule.
    //
    // `clock.now()` rather than `Date.now()` for the stopwatch so a
    // frozen-clock test reads a stable 0 instead of a racy 1.
    //
    // What this does NOT do is answer as the deployed agent would. The four
    // canned responses are a fixed corpus keyed on the prompt, so an offline
    // replay exercises the replay pipeline and says nothing about the fleet —
    // which is why the reply carries `degraded` saying exactly that. A replay
    // that always looks like a real answer is worse than one that admits it
    // is not.
    if (config.mock.agentcore) {
      const t0 = clock.now().getTime();
      const out = await agentCoreProvider.invokeAgent(sourceAgentId, {
        message: finalPrompt,
        ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
        ...(sourceUserId ? { userId: sourceUserId } : {}),
      });
      durationMs = clock.now().getTime() - t0;
      responseText = parseAgentResponse(out.text ?? '');
      // Fall through to step 4 — one persistence path, both modes.
    } else {
      const client = new BedrockAgentCoreClient({ region: config.region });
      const t0 = Date.now();
      const out = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: arn,
          qualifier: 'DEFAULT',
          payload,
        }),
      );
      durationMs = Date.now() - t0;
      const stream = out.response;
      if (stream) {
        // SdkStream — transformToString() is the canonical drain.
        const text = await (stream as unknown as {
          transformToString: () => Promise<string>;
        }).transformToString();
        responseText = parseAgentResponse(text);
      }
    }
  } catch (err) {
    console.warn('[invocations] /replay InvokeAgentRuntime failed:',
      (err as Error).message);
    res.status(502).json({
      error: 'replay_invoke_failed',
      message: (err as Error).message,
      invocationId: id,
      agentId: sourceAgentId,
    });
    return;
  }

  // 4. Persist as child trace. parent_invocation_id links it back to the
  // source so the trace tree shows the replay branch.
  let result;
  try {
    result = await processTrace({
      agentId: sourceAgentId,
      agentName: sourceAgentId,
      templateId: sourceTemplateId ?? undefined,
      prompt: finalPrompt,
      response: responseText,
      durationMs,
      parentInvocationId: id,
      userId: sourceUserId ?? undefined,
      sessionId: sourceSessionId ?? undefined,
    });
  } catch (err) {
    console.warn('[invocations] /replay processTrace failed:',
      (err as Error).message);
    // The agent already responded; surface the response even though we
    // couldn't persist. Caller still gets a usable result.
    res.status(207).json({
      error: 'replay_persist_failed',
      message: (err as Error).message,
      invocationId: id,
      agentId: sourceAgentId,
      response: responseText,
      durationMs,
    });
    return;
  }

  // `processTrace` returning is not the same as a trace existing. The sampling
  // die and the write-side phantom guard BOTH answer by returning a result
  // with `inserted: false`, and a 200 carrying a fresh `invocationId` reads as
  // a row that was written. Both rules are load-bearing (CLAUDE.md's two
  // observability gotchas) and neither is touched here — but a caller is
  // entitled to know which of the three things happened, so say it. Derived
  // from the result, never stored.
  const out: ReplayResponse = {
    invocationId: result.invocationId,
    response: responseText,
    durationMs,
    agentId: sourceAgentId,
    parentInvocationId: id,
    judgeScore: result.judgeScore,
    persisted: result.inserted,
    // The sink's own rule, not a second one: `isValidUuid` there is this
    // module's `isUuid`, and it is what decides whether the row keeps a parent.
    parentLinked: result.inserted && isUuid(id),
    ...(result.inserted ? {} : {
      notPersisted: result.skipped
        ? 'the write-side phantom guard dropped the bundle: no model, no response, no tokens, no tool calls, no guardrail signal, no memory events'
        : !result.sampled
          ? 'the sampling die rolled against this trace (observability.sampling_config)'
          : 'the trace insert did not report a row',
    }),
  };
  // OFFLINE the answer came from the fleet's canned corpus, not the agent, so
  // the reply says so in the shape `/search` above already uses for a filter
  // it could not honour. Everything else on this response is real: a real
  // source row, a real invocation through the real transport seam, and a real
  // trace through the real sink.
  res.status(200).json(
    config.mock.agentcore
      ? degraded(out, new Error(
        'dev:mock — the replayed answer came from the offline agent corpus '
        + '(mock/responses.ts), not from a deployed runtime',
      ))
      : out,
  );
}));

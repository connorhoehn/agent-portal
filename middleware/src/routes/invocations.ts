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
//   POST /:invocationId/replay         — stub (501) — wired in M4 finalisation
//
// All Aurora I/O goes through providers/aurora.ts exec(). All endpoints
// degrade defensively: missing tables or empty result sets yield empty
// responses rather than 500s. We filter out test:* rows in /search because the
// search view is the live-traffic surface, but we do NOT filter them in the
// detail view — clicking into a test row should still work.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';

export const invocationsRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

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
  const userId = typeof req.query['userId'] === 'string'
    ? req.query['userId'].trim()
    : '';
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
    const rows = await exec(sql, params);
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
    res.json({ invocations, count: invocations.length });
  } catch (err) {
    console.warn('[invocations] /search failed:', (err as Error).message);
    res.json({ invocations: [], count: 0 });
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

invocationsRouter.get('/:invocationId', asyncHandler(async (req, res) => {
  const id = String(req.params['invocationId'] ?? '').trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: 'invocation not found' });
    return;
  }

  // 1) Pull the trace row itself.
  let invocation: InvocationDetail | null = null;
  try {
    const rows = await exec(
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
        WHERE invocation_id = :id::uuid`,
      [{ name: 'id', value: { stringValue: id } }],
    );
    if (rows.length === 0) {
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
    const rows = await exec(
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

  // 3) Parent summary (one row, if present).
  let parent: ParentSummary | null = null;
  if (invocation.parentInvocationId) {
    try {
      const rows = await exec(
        `SELECT invocation_id::text AS invocation_id,
                agent_id, agent_name, ts::text AS ts
           FROM observability.invocation_traces
          WHERE invocation_id = :pid::uuid`,
        [{ name: 'pid', value: { stringValue: invocation.parentInvocationId } }],
      );
      if (rows.length > 0) {
        const r = rows[0]!;
        parent = {
          invocationId: String(r['invocation_id'] ?? ''),
          agentId: String(r['agent_id'] ?? ''),
          agentName: String(r['agent_name'] ?? ''),
          ts: String(r['ts'] ?? ''),
        };
      }
    } catch (err) {
      console.warn('[invocations] /:id parent lookup failed:', (err as Error).message);
      parent = null;
    }
  }

  // 4) Children + depth-2 grandchildren. We pull everything with parent in
  // {self, child_ids} in a single query, then assemble client-side. This keeps
  // the call to Aurora to two round-trips total instead of N+1.
  let children: ChildSummary[] = [];
  try {
    const directRows = await exec(
      `SELECT invocation_id::text AS invocation_id,
              agent_id, agent_name,
              judge_score, duration_ms,
              ts::text AS ts
         FROM observability.invocation_traces
        WHERE parent_invocation_id = :id::uuid
        ORDER BY ts ASC`,
      [{ name: 'id', value: { stringValue: id } }],
    );
    children = directRows.map<ChildSummary>((r) => ({
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
      const grandRows = await exec(
        `SELECT invocation_id::text AS invocation_id,
                agent_id, agent_name,
                judge_score, duration_ms,
                parent_invocation_id::text AS parent_invocation_id,
                ts::text AS ts
           FROM observability.invocation_traces
          WHERE parent_invocation_id IN (${placeholders})
          ORDER BY ts ASC`,
        params,
      );
      const byParent = new Map<string, ChildSummary[]>();
      for (const r of grandRows) {
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
// POST /:invocationId/replay — stub for M4 finalisation.
//
// Returns 501 with a structured body so the portal can grey out the replay
// button and surface the canned message. Wired up to a real async replay job
// in a later milestone.
// ─────────────────────────────────────────────────────────────────────────────
invocationsRouter.post('/:invocationId/replay', asyncHandler(async (req, res) => {
  // Keep the id string accessible so we can echo it back; no DB work yet.
  const id = String(req.params['invocationId'] ?? '').trim();
  res.status(501).json({
    error: 'not_implemented',
    message: 'Replay will be added in M4 finalisation.',
    invocationId: id,
  });
}));

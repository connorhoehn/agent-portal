// Memory observability routes — surface AgentCore Memory ops to the portal.
//
// Mounted ungated at /api/observability/memory (see index.ts). AgentCore
// Memory operations (retrieve / write / summarize / expire) happen inside the
// agent. Middleware can't see them directly, so the agent emits memory events
// in its trace bundle and the trace-sink persists them best-effort. This
// router renders both the event feed and the per-agent rollup.
//
// Endpoints:
//   GET  /events?invocationId=&agentId=&kind=&limit=50
//   GET  /stats?windowHours=24
//   POST /events   — body: MemoryEventInput. Best-effort manual insert; used by
//                    the seed script and for backfill testing.
//
// Defensive: every read swallows DB errors and returns an empty/zero shape so
// the portal never sees a 5xx from this surface.

import { Router } from 'express';
import { requireAction } from '../lib/authz.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { reasonLine } from '../lib/upstream.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { mockMemoryEvents, mockMemoryStats } from '../mock/observability-queries.js';
import { mockInsertMemoryEvent } from '../mock/observability.js';

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

export const memoryRouter = Router();

// ── Types (mirrored client-side in MemoryPage) ─────────────────────────────

type MemoryKind = 'retrieve' | 'write' | 'summarize' | 'expire';

interface MemoryEvent {
  memoryEventId: string;
  invocationId: string | null;
  agentId: string;
  sessionId: string | null;
  kind: string;
  memoryId: string | null;
  queryText: string | null;
  resultCount: number | null;
  durationMs: number | null;
  retrievedSummary: string | null;
  errored: boolean;
  errorMessage: string | null;
  ts: string;
}

interface MemoryAgentStat {
  agentId: string;
  retrieves: number;
  writes: number;
  /** null when the agent recorded no retrieve in the window. A latency of 0ms
   *  is not a thing that happens, so zero-filling read as "instant", green. */
  p50RetrieveMs: number | null;
  p99RetrieveMs: number | null;
  errorRate: number;
  coldSessions: number;
}

// ── Param helpers ─────────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function longParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}
function nullableStr(name: string, value: string | null | undefined): SqlParameter {
  if (value === undefined || value === null) return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}
function nullableInt(name: string, value: number | null | undefined): SqlParameter {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { longValue: Math.round(value) } };
}
function nullableBool(name: string, value: boolean | null | undefined): SqlParameter {
  if (value === undefined || value === null) return { name, value: { isNull: true } };
  return { name, value: { booleanValue: value } };
}

function parseHours(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function parseLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function isValidUuid(s: string | undefined | null): s is string {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

function isValidKind(s: string | undefined | null): s is MemoryKind {
  return s === 'retrieve' || s === 'write' || s === 'summarize' || s === 'expire';
}

// ── GET /events ────────────────────────────────────────────────────────────
//
// Filters: invocationId (uuid), agentId (text), kind (retrieve/write/...).
// Default ordering newest-first. Capped at 500 rows.

memoryRouter.get('/events', asyncHandler(async (req, res) => {
  const invocationId = isValidUuid(req.query['invocationId'] as string | undefined)
    ? (req.query['invocationId'] as string)
    : null;
  // Same reason as guardrails-detail: the UUID guard protects the `:iid::uuid`
  // bind, and the offline corpus is keyed on the invocation tail's non-UUID
  // ids. Filtering the mock branch on the raw value keeps "memory ops for THIS
  // invocation" working from a mock detail page instead of silently listing
  // every event in the fleet.
  const mockInvocationFilter = (req.query['invocationId'] as string | undefined)?.trim() || null;
  const agentId = (req.query['agentId'] as string | undefined)?.trim() || null;
  const kindRaw = (req.query['kind'] as string | undefined)?.trim();
  const kind = isValidKind(kindRaw) ? kindRaw : null;
  const limit = parseLimit(req.query['limit'], 50, 500);

  const wheres: string[] = [];
  const params: SqlParameter[] = [longParam('lim', limit)];
  if (invocationId) {
    wheres.push('invocation_id = :iid::uuid');
    params.push(strParam('iid', invocationId));
  }
  if (agentId) {
    wheres.push('agent_id = :agent');
    params.push(strParam('agent', agentId));
  }
  if (kind) {
    wheres.push('kind = :kind');
    params.push(strParam('kind', kind));
  }
  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';

  const sql = `
    SELECT memory_event_id::text   AS memory_event_id,
           invocation_id::text     AS invocation_id,
           agent_id, session_id, kind, memory_id, query_text,
           result_count, duration_ms, retrieved_summary,
           errored, error_message,
           ts::text                AS ts
      FROM observability.memory_events
     ${whereSql}
     ORDER BY ts DESC
     LIMIT :lim`;

  try {
    const rows = config.mock.aurora
      ? mockMemoryEvents(mockInvocationFilter, agentId, kind, limit)
      : await exec(sql, params);
    const events: MemoryEvent[] = rows.map((r) => ({
      memoryEventId: String(r['memory_event_id'] ?? ''),
      invocationId: r['invocation_id'] == null ? null : String(r['invocation_id']),
      agentId: String(r['agent_id'] ?? ''),
      sessionId: r['session_id'] == null ? null : String(r['session_id']),
      kind: String(r['kind'] ?? ''),
      memoryId: r['memory_id'] == null ? null : String(r['memory_id']),
      queryText: r['query_text'] == null ? null : String(r['query_text']),
      resultCount: r['result_count'] == null ? null : Number(r['result_count']),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      retrievedSummary: r['retrieved_summary'] == null ? null : String(r['retrieved_summary']),
      errored: Boolean(r['errored'] ?? false),
      errorMessage: r['error_message'] == null ? null : String(r['error_message']),
      ts: String(r['ts'] ?? ''),
    }));
    res.json({ events });
  } catch (err) {
    console.warn('[memory] /events failed:', (err as Error).message);
    res.json(degraded({ events: [] as MemoryEvent[] }, err));
  }
}));

// ── GET /stats ─────────────────────────────────────────────────────────────
//
// Per-agent rollup. coldSessions = number of distinct session_ids where every
// 'retrieve' for that session returned 0 results. We restrict to sessions that
// had at least one retrieve in the window so we don't count sessions with no
// memory ops at all as "cold".

memoryRouter.get('/stats', asyncHandler(async (req, res) => {
  const windowHours = parseHours(req.query['windowHours'], 24, 24 * 14);

  const sql = `
    WITH win AS (
      SELECT *
        FROM observability.memory_events
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
    ),
    per_agent AS (
      SELECT agent_id,
             COUNT(*) FILTER (WHERE kind = 'retrieve')::bigint AS retrieves,
             COUNT(*) FILTER (WHERE kind = 'write')::bigint    AS writes,
             PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE kind = 'retrieve' AND duration_ms IS NOT NULL)::float8 AS p50_ms,
             PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)
               FILTER (WHERE kind = 'retrieve' AND duration_ms IS NOT NULL)::float8 AS p99_ms,
             SUM(CASE WHEN errored THEN 1 ELSE 0 END)::bigint  AS errors,
             COUNT(*)::bigint                                   AS total
        FROM win
       GROUP BY agent_id
    ),
    cold AS (
      -- Per (agent, session): all retrieves returned 0 → cold.
      SELECT agent_id, session_id
        FROM win
       WHERE kind = 'retrieve'
         AND session_id IS NOT NULL
       GROUP BY agent_id, session_id
      HAVING COALESCE(SUM(COALESCE(result_count, 0)), 0) = 0
    ),
    cold_per_agent AS (
      SELECT agent_id, COUNT(*)::bigint AS cold_sessions
        FROM cold
       GROUP BY agent_id
    )
    SELECT p.agent_id,
           p.retrieves,
           p.writes,
           p.p50_ms,
           p.p99_ms,
           p.errors,
           p.total,
           COALESCE(c.cold_sessions, 0) AS cold_sessions
      FROM per_agent p
      LEFT JOIN cold_per_agent c USING (agent_id)
     ORDER BY p.retrieves DESC, p.writes DESC`;

  try {
    const rows = config.mock.aurora
      ? mockMemoryStats(windowHours)
      : await exec(sql, [longParam('hours', windowHours)]);
    const byAgent: MemoryAgentStat[] = rows.map((r) => {
      const total = Number(r['total'] ?? 0);
      const errors = Number(r['errors'] ?? 0);
      return {
        agentId: String(r['agent_id'] ?? ''),
        retrieves: Number(r['retrieves'] ?? 0),
        writes: Number(r['writes'] ?? 0),
        p50RetrieveMs: r['p50_ms'] == null ? null : Number(r['p50_ms']),
        p99RetrieveMs: r['p99_ms'] == null ? null : Number(r['p99_ms']),
        errorRate: total > 0 ? errors / total : 0,
        coldSessions: Number(r['cold_sessions'] ?? 0),
      };
    });
    res.json({ byAgent, windowHours });
  } catch (err) {
    console.warn('[memory] /stats failed:', (err as Error).message);
    res.json(degraded({ byAgent: [] as MemoryAgentStat[], windowHours }, err));
  }
}));

// ── POST /events ───────────────────────────────────────────────────────────
//
// Manual insert. Used by the seed script + future agent backfill. The trace
// bundle path is preferred (see trace-sink.insertMemoryEvents) but this gives
// us a safe surface for one-off injection without going through trace-sink.

memoryRouter.post('/events', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const agentId = typeof body['agentId'] === 'string' ? body['agentId'].trim() : '';
  const kind = typeof body['kind'] === 'string' ? body['kind'].trim() : '';
  if (!agentId || !isValidKind(kind)) {
    res.status(400).json({ error: 'agentId and kind (retrieve|write|summarize|expire) are required' });
    return;
  }

  const invocationId = isValidUuid(body['invocationId'] as string | undefined)
    ? (body['invocationId'] as string)
    : null;
  const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'].trim() || null : null;
  const memoryId = typeof body['memoryId'] === 'string' ? body['memoryId'].trim() || null : null;
  const queryText = typeof body['queryText'] === 'string' ? body['queryText'] : null;
  const resultCount = typeof body['resultCount'] === 'number' ? body['resultCount'] : null;
  const durationMs = typeof body['durationMs'] === 'number' ? body['durationMs'] : null;
  const retrievedSummary = typeof body['retrievedSummary'] === 'string'
    ? body['retrievedSummary'].slice(0, 500)
    : null;
  const errored = typeof body['errored'] === 'boolean' ? body['errored'] : false;
  const errorMessage = typeof body['errorMessage'] === 'string' ? body['errorMessage'] : null;

  const invSql = invocationId ? ':iid::uuid' : 'NULL';
  const sql = `
    INSERT INTO observability.memory_events (
      invocation_id, agent_id, session_id, kind, memory_id, query_text,
      result_count, duration_ms, retrieved_summary, errored, error_message
    ) VALUES (
      ${invSql}, :agent_id, :session_id, :kind, :memory_id, :query_text,
      :result_count, :duration_ms, :retrieved_summary, :errored, :error_message
    )
    RETURNING memory_event_id::text AS memory_event_id`;

  const params: SqlParameter[] = [
    strParam('agent_id', agentId),
    nullableStr('session_id', sessionId),
    strParam('kind', kind),
    nullableStr('memory_id', memoryId),
    nullableStr('query_text', queryText),
    nullableInt('result_count', resultCount),
    nullableInt('duration_ms', durationMs),
    nullableStr('retrieved_summary', retrievedSummary),
    nullableBool('errored', errored),
    nullableStr('error_message', errorMessage),
  ];
  if (invocationId) params.push(strParam('iid', invocationId));

  try {
    // Offline the row goes into the `observability-memory-writes` fixture,
    // which the events feed concatenates onto the fleet's derived ops — so a
    // manual insert shows up in the next GET and `POST /api/__mock/reset`
    // drops it without touching the seeded corpus.
    if (config.mock.aurora) {
      const memoryEventId = mockInsertMemoryEvent({
        invocation_id: invocationId,
        agent_id: agentId,
        session_id: sessionId,
        kind,
        memory_id: memoryId,
        query_text: queryText,
        result_count: resultCount,
        duration_ms: durationMs,
        retrieved_summary: retrievedSummary,
        errored,
        error_message: errorMessage,
      });
      res.status(201).json({ memoryEventId });
      return;
    }
    const rows = await exec(sql, params);
    const memoryEventId = String(rows[0]?.['memory_event_id'] ?? '');
    res.status(201).json({ memoryEventId });
  } catch (err) {
    console.warn('[memory] POST /events failed:', (err as Error).message);
    res.status(500).json({ error: 'insert failed', detail: (err as Error).message });
  }
}));

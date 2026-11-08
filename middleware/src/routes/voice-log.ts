// /api/voice/sessions reads — the voice session log, for debugging (the
// owner's own sessions only; lib/voice/session-log.ts writes it).
//
//   GET /api/voice/sessions?since=&limit=
//     the caller's sessions in every tenant, newest first: 200 { sessions: [
//       { id, tenant, mock, startedAt, endedAt, seconds, maxSeconds, costUsd, costBasis,
//         toolCallCount, lastOutcome, stopReason } ] }
//     since: an ISO time (sessions started at or after it); limit: 1..100, default 20.
//   GET /api/voice/sessions/latest
//     the caller's most recent session, as /:id answers; 404 when there is none.
//   GET /api/voice/sessions/:id
//     200 { session: { ...the list fields, model, voice, usdPerMinute, holdId,
//           provider: { seconds, inputTokens, outputTokens, cachedTokens } },
//           toolCalls: [{ id, at, tool, outcome, argsSha256, confirmedBy, durationMs }],
//           events: [{ seq, at, kind, data }] }   (events in seq order)
//   GET /api/voice/sessions/:id/export
//     the same as one JSON document with `format` and `exportedAt`, sent as
//     an attachment (`voice-session-<id>.json`) for a bug report.
//
// Owner-only: a session is the caller's when its `user_sub` is the caller's
// sub. Anyone else (an admin included: nothing extra for any role) gets 404,
// whether or not the id exists. The rows sit under row-level security and a
// session may be in a tenant the caller has since left, so the session row is
// read as the system and the owner check is the boundary (routes/voice.ts
// close does the same); its tool calls and events are read only after it.
//
// Never in a body: the provider's own session id (the hang-up target stays
// server-side, spec §6), a transcript, audio, or a tool's arguments (only
// their sha256). The log rows were sanitized when they were written.

import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import type { Session } from '../lib/session.js';
import { rateLimit } from '../lib/rate-limit.js';
import { clock } from '../mock/core/index.js';
import { runAsSystem } from '../providers/db-tenant.js';
import {
  getVoiceSession, listUserVoiceSessions, listVoiceSessionEvents, listVoiceToolCalls,
  type VoiceSessionRow, type VoiceToolOutcome,
} from '../providers/voice-sessions.js';

export const voiceLogRouter = Router();

voiceLogRouter.use(requireSession('VoiceNavigate'));

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;
const bySub = (req: Request): string | null => resolveSession(req)?.sub ?? null;
const notFound = (res: Response): void => { res.status(404).json({ error: 'voice session not found' }); };
const reads = rateLimit('voice-log-reads', 120, 60_000, bySub);

/** The export's format tag; bump it when the document's shape changes. */
export const VOICE_LOG_EXPORT_FORMAT = 'voice-session-log/1';

function listItem(row: VoiceSessionRow, lastOutcome: VoiceToolOutcome | null) {
  return {
    id: row.id, tenant: row.tenant, mock: row.mock, startedAt: row.started_at, endedAt: row.ended_at,
    seconds: row.seconds, maxSeconds: row.max_seconds, costUsd: row.cost_usd, costBasis: row.cost_basis,
    toolCallCount: row.tool_calls, lastOutcome, stopReason: row.stop_reason,
  };
}

/** The session, its tool calls and its events, as /:id answers. Read as the system: the caller owns it. */
async function sessionLog(row: VoiceSessionRow) {
  const [calls, events] = await runAsSystem(() => Promise.all([listVoiceToolCalls(row.id), listVoiceSessionEvents(row.id)]));
  return {
    session: {
      ...listItem(row, calls.length ? calls[calls.length - 1]!.outcome : null),
      model: row.model, voice: row.voice, usdPerMinute: row.usd_per_minute, holdId: row.hold_id,
      provider: {
        seconds: row.provider_seconds, inputTokens: row.provider_tokens_in,
        outputTokens: row.provider_tokens_out, cachedTokens: row.provider_tokens_cached,
      },
    },
    toolCalls: calls.map((c) => ({
      id: c.id, at: c.at, tool: c.tool, outcome: c.outcome, argsSha256: c.args_sha256, confirmedBy: c.confirmed_by, durationMs: c.duration_ms,
    })),
    events: events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, data: e.data })),
  };
}

/** The caller's own session by `:id`, else null (the route answers 404). */
async function ownSession(req: Request): Promise<VoiceSessionRow | null> {
  const id = String(req.params['id'] ?? '');
  if (!SESSION_ID.test(id)) return null;
  const session = resolveSession(req) as Session;
  const row = await runAsSystem(() => getVoiceSession(id));
  return row && row.user_sub === session.sub ? row : null;
}

voiceLogRouter.get('/sessions', reads, asyncHandler(async (req, res) => {
  const session = resolveSession(req) as Session;
  const rawSince = typeof req.query['since'] === 'string' ? req.query['since'] : '';
  let since: Date | null = null;
  if (rawSince) {
    const t = Date.parse(rawSince);
    if (!Number.isFinite(t)) { res.status(400).json({ error: 'since must be an ISO date-time' }); return; }
    since = new Date(t);
  }
  const rawLimit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : 20;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) { res.status(400).json({ error: 'limit must be an integer from 1 to 100' }); return; }
  const rows = await listUserVoiceSessions(session.sub, { since, limit: rawLimit });
  res.json({ sessions: rows.map((r) => listItem(r, r.last_outcome)) });
}));

// Before /sessions/:id, so `latest` is never read as an id (it would fail the id pattern anyway).
voiceLogRouter.get('/sessions/latest', reads, asyncHandler(async (req, res) => {
  const session = resolveSession(req) as Session;
  const [latest] = await listUserVoiceSessions(session.sub, { limit: 1 });
  if (!latest) { notFound(res); return; }
  res.json(await sessionLog(latest));
}));

voiceLogRouter.get('/sessions/:id', reads, asyncHandler(async (req, res) => {
  const row = await ownSession(req);
  if (!row) { notFound(res); return; }
  res.json(await sessionLog(row));
}));

voiceLogRouter.get('/sessions/:id/export', reads, asyncHandler(async (req, res) => {
  const row = await ownSession(req);
  if (!row) { notFound(res); return; }
  const doc = {
    format: VOICE_LOG_EXPORT_FORMAT, exportedAt: clock.nowIso(),
    note: 'Structured events only: no audio, transcript or tool arguments are stored (arguments as sha256).',
    ...(await sessionLog(row)),
  };
  res.set('Content-Disposition', `attachment; filename="voice-session-${row.id}.json"`);
  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify(doc, null, 2));
}));

// The voice session's structured event log (debugging "what happened in my
// last voice session"; schema/voice_sessions.sql `voice_session_events`,
// routes/voice-log.ts reads it back to the session's owner).
//
// Written from the mint, POST /:id/events (the dock's phases, refusals,
// confirms, errors and short notes), the sideband, the close and the reaper.
// Spec §9 still holds: no audio, no transcript, no tool arguments. Every row's
// `data` goes through `sanitizeEventData` first:
//   - keys that carry words or secrets are dropped and named in `_dropped`
//     (FORBIDDEN_KEYS: delta, transcript, text, args, arguments, sdp, token…);
//   - strings are cut at 200 characters, OpenAI keys (`sk-…`), bearer tokens
//     and JWTs are redacted, and a URL keeps its origin and path only (a
//     presigned URL's signature is its query);
//   - at most 3 levels, 24 keys per object and 20 items per array;
//   - the serialized row is at most 2 KB, else it is replaced by its key list.
// At most 500 rows per session (providers/voice-sessions.ts), kept 30 days
// (sweepVoiceEventRetention, run by the voice reaper's sweep).
//
// The dev file log: with VOICE_LOG_DIR set (dev:mock sets `.voice-log`, under
// middleware/, gitignored) every row is also appended as one JSON line to
// `<dir>/<session_id>.jsonl`, for `tail -f`. Refused under NODE_ENV=production.
//
// Logging never fails the caller: a write that throws is warned and dropped.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clock } from '../../mock/core/index.js';
import type { VoiceEventKind, VoiceSessionEventRow } from '../../providers/voice-sessions.js';
import { insecureDevMode } from '../insecure-dev-mode.js';

export { VOICE_EVENT_KINDS, type VoiceEventKind } from '../../providers/voice-sessions.js';

/** The kinds the dock may post through POST /:id/events; the rest are the middleware's own. */
export const CLIENT_EVENT_KINDS: readonly VoiceEventKind[] = [
  'started', 'delegation', 'tool-call', 'tool-result', 'refused', 'confirm-shown', 'confirmed', 'cancelled', 'usage', 'error', 'client',
];

/** The most events one batched POST /:id/events carries (the dock flushes at most every 500 ms). */
export const MAX_EVENT_BATCH = 20;

/** The largest serialized `data` a row keeps. */
export const MAX_EVENT_DATA_BYTES = 2048;
/** How long event rows are kept. */
export const VOICE_EVENT_RETENTION_DAYS = 30;

const MAX_STRING = 200;
const MAX_KEYS = 24;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/**
 * Keys never kept, at any depth (compared lower-case): the words said or
 * heard, a tool's arguments or output, and anything that names a credential.
 */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'delta', 'transcript', 'text', 'said', 'utterance', 'words', 'content', 'body', 'message_text', 'instructions', 'prompt',
  'args', 'arguments', 'input', 'output', 'query', 'q', 'sdp',
  'key', 'apikey', 'api_key', 'secret', 'token', 'password', 'authorization', 'cookie', 'credential', 'credentials',
]);

/** Redact what a string must never carry into a row. */
export function scrubString(v: string): string {
  let out = v
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/\b(https?|wss?):\/\/[^\s"'<>]+/gi, (url) => {
      try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return '[url]'; }
    })
    .replace(/X-Amz-[A-Za-z-]+=[^\s&"']+/g, '[redacted]');
  // A stray `sk-` fragment (too short for the pattern above) still never leaves.
  out = out.replace(/sk-/g, 'sk_');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING - 1)}…` : out;
}

function clean(v: unknown, depth: number, dropped: Set<string>): unknown {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return scrubString(v);
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(v)) {
    return v.slice(0, MAX_ITEMS).map((x) => clean(x, depth + 1, dropped)).filter((x) => x !== undefined);
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!KEY.test(k) || FORBIDDEN_KEYS.has(k.toLowerCase())) { dropped.add(KEY.test(k) ? k : '?'); continue; }
      if (n >= MAX_KEYS) break;
      const c = clean(x, depth + 1, dropped);
      if (c !== undefined) { out[k] = c; n += 1; }
    }
    return out;
  }
  return undefined;
}

/**
 * A row's `data`: structured, small, with nothing a person said or typed and
 * nothing secret. Pure.
 */
export function sanitizeEventData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const dropped = new Set<string>();
  const out = clean(raw, 0, dropped) as Record<string, unknown>;
  if (dropped.size) out['_dropped'] = [...dropped].slice(0, 10);
  if (Buffer.byteLength(JSON.stringify(out)) <= MAX_EVENT_DATA_BYTES) return out;
  const keys = Object.keys(out).slice(0, 30);
  const small: Record<string, unknown> = { _truncated: true, keys };
  while (Buffer.byteLength(JSON.stringify(small)) > MAX_EVENT_DATA_BYTES) keys.pop();
  return small;
}

// ─── The dev file log ────────────────────────────────────────────────────────

let warnedProduction = false;

/**
 * Where the file log goes, or null when it is off: VOICE_LOG_DIR unset, or
 * NODE_ENV=production (refused, said once). Read per call.
 */
export function voiceLogDir(): string | null {
  // Under INSECURE_DEV_MODE the file log is on by default (`.voice-log` next to
  // the process): the owner reads these files directly rather than running
  // commands, so a laptop must write them without any extra variable.
  const raw = (process.env['VOICE_LOG_DIR'] ?? '').trim() || (insecureDevMode() ? '.voice-log' : '');
  if (!raw) return null;
  if (process.env['NODE_ENV'] === 'production') {
    if (!warnedProduction) {
      warnedProduction = true;
      console.warn('[voice] VOICE_LOG_DIR is set but NODE_ENV=production: the voice file log is a dev aid and stays off.');
    }
    return null;
  }
  return resolve(raw);
}

const SESSION_ID = /^vs_[0-9a-f-]{36}$/;

/** `<dir>/<session_id>.jsonl`, or null when the file log is off (or the id is not a session id). */
export function voiceLogFile(sessionId: string): string | null {
  const dir = voiceLogDir();
  return dir && SESSION_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : null;
}

function appendToFile(row: VoiceSessionEventRow): void {
  const file = voiceLogFile(row.session_id);
  if (!file) return;
  try {
    mkdirSync(voiceLogDir()!, { recursive: true });
    appendFileSync(file, `${JSON.stringify({ sessionId: row.session_id, tenant: row.tenant, seq: row.seq, at: row.at, kind: row.kind, data: row.data })}\n`);
  } catch (err) {
    console.warn(`[voice] file log write failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * Append one event to a session's log (and the dev file log). Returns the row,
 * or null at the 500-row cap, for an unknown session, or when the write failed
 * (warned, never thrown).
 */
export async function recordVoiceEvent(
  session: { id: string; tenant: string }, kind: VoiceEventKind, data: Record<string, unknown> = {},
): Promise<VoiceSessionEventRow | null> {
  try {
    const { insertVoiceSessionEvent } = await import('../../providers/voice-sessions.js');
    const row = await insertVoiceSessionEvent({ session_id: session.id, tenant: session.tenant, kind, data: sanitizeEventData(data) });
    if (row) appendToFile(row);
    return row;
  } catch (err) {
    console.warn(`[voice] event log write failed (${kind}): ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    return null;
  }
}

/**
 * The retention sweep: delete event rows older than 30 days, in every
 * tenant. Run by the voice reaper's sweep (routes/devbox.ts voiceSweep).
 */
export async function sweepVoiceEventRetention(now: number = clock.now().getTime()): Promise<number> {
  const { deleteVoiceSessionEventsBefore } = await import('../../providers/voice-sessions.js');
  const { runAsSystem } = await import('../../providers/db-tenant.js');
  const gone = await runAsSystem(() => deleteVoiceSessionEventsBefore(new Date(now - VOICE_EVENT_RETENTION_DAYS * 86_400_000)));
  if (gone > 0) console.log(JSON.stringify({ event: 'voice-session-events-expired', rows: gone }));
  return gone;
}

// ─── The dock's events (POST /api/voice/sessions/:id/events with `kind`) ─────

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The event form of the /events body, shaped into one row's kind and data:
 *
 *   { kind, tool?, args? | argsSha256?, summary?, note?, data? }
 *
 * `kind` is one of CLIENT_EVENT_KINDS. `tool` names the tool the event is
 * about (a name the catalogue does not know is kept as `unknown`, with
 * `knownTool: false`). `args` is hashed here and dropped, never stored;
 * `argsSha256` is taken as given (64 hex). `summary` is the tool's shaped
 * result (counts, statuses, ids: never words), `note` a short client note
 * (200 characters), `data` any other small structured fields (a phase, an
 * error code, a duration). All of it then goes through sanitizeEventData.
 */
export function parseClientEvent(
  body: Record<string, unknown>, deps: { knownTool: (name: string) => boolean; hashArgs: (args: unknown) => string },
): { kind: VoiceEventKind; data: Record<string, unknown> } | { error: string } {
  const kind = body['kind'] as VoiceEventKind;
  if (!CLIENT_EVENT_KINDS.includes(kind)) return { error: `kind must be one of ${CLIENT_EVENT_KINDS.join(', ')}` };
  const given = body['data'];
  if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) return { error: 'data must be an object' };
  const data: Record<string, unknown> = { ...(given as Record<string, unknown> | undefined ?? {}) };
  // The arguments never pass this point: hashed, then dropped from both places they could come from.
  const args = body['args'] !== undefined ? body['args'] : data['args'] ?? data['arguments'];
  delete data['args']; delete data['arguments'];
  const sha = body['argsSha256'] ?? data['argsSha256'];
  if (sha !== undefined) {
    if (typeof sha !== 'string' || !HEX64.test(sha)) return { error: 'argsSha256 must be 64 hex characters' };
    data['argsSha256'] = sha;
  } else if (args !== undefined) {
    data['argsSha256'] = deps.hashArgs(args);
  }
  const tool = body['tool'] ?? data['tool'];
  if (tool !== undefined) {
    const known = typeof tool === 'string' && TOOL_NAME.test(tool) && deps.knownTool(tool);
    data['tool'] = known ? tool : 'unknown';
    if (!known) data['knownTool'] = false;
  }
  if (body['summary'] !== undefined) {
    const summary = body['summary'];
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return { error: 'summary must be an object' };
    data['summary'] = summary;
  }
  if (body['note'] !== undefined) {
    if (typeof body['note'] !== 'string') return { error: 'note must be a string' };
    data['note'] = body['note'];
  }
  return { kind, data };
}

// Voice navigator sessions as data (docs/voice-navigator-spec.md §7, §9): storage only.
//
// One `voice_sessions` row per minted session, one `voice_tool_calls` row
// per tool call the dock reports, and one `voice_session_events` row per
// structured event of the session's log (lib/voice/session-log.ts, which
// sanitizes `data` before it reaches this file). Never audio, a transcript, or
// a tool's arguments: a tool-call row keeps the sha256 of the arguments only.
//
// Closing is a compare-and-set on `ended_at IS NULL`, so two closes (a retry,
// or the dock racing the reaper) settle exactly once; the caller learns which
// one won from the return value. Both tables carry `tenant` and sit under
// row-level security (schema/row_level_security.sql, providers/db-tenant.ts).

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { voiceSessionEvents, voiceSessions, voiceToolCalls } from '../mock/voice-sessions.js';
import type { CostBasis } from '../lib/run-cost.js';

export type VoiceStopReason = 'closed' | 'dropped' | 'cutoff' | 'tenant-switch' | 'reaped' | 'mint-failed';
export const CLIENT_STOP_REASONS: readonly VoiceStopReason[] = ['closed', 'dropped', 'cutoff', 'tenant-switch'];
export type VoiceToolOutcome = 'done' | 'refused' | 'failed' | 'cancelled';
export const VOICE_TOOL_OUTCOMES: readonly VoiceToolOutcome[] = ['done', 'refused', 'failed', 'cancelled'];

export interface VoiceSessionRow {
  id: string;
  user_sub: string;
  tenant: string;
  hold_id: string | null;
  provider_session_id: string | null;
  model: string | null;
  voice: string | null;
  mock: boolean;
  /** The ceiling at mint (VOICE_SESSION_MAX_MINUTES × 60): what the reaper bounds this session by. */
  max_seconds: number;
  usd_per_minute: number;
  started_at: string;
  ended_at: string | null;
  seconds: number | null;
  cost_usd: number | null;
  cost_basis: CostBasis | null;
  stop_reason: VoiceStopReason | null;
  tool_calls: number;
  /**
   * What the provider itself reported over the sideband (G12): the cumulative
   * `usage.seconds` and the sums of every nested `response.completed.response.usage`.
   * Null = the sideband never delivered that figure.
   */
  provider_seconds: number | null;
  provider_tokens_in: number | null;
  provider_tokens_out: number | null;
  provider_tokens_cached: number | null;
}

export interface VoiceToolCallRow {
  id: string;
  session_id: string;
  tenant: string;
  tool: string;
  args_sha256: string | null;
  outcome: VoiceToolOutcome;
  confirmed_by: 'voice' | 'click' | null;
  duration_ms: number | null;
  at: string;
}

export type VoiceSessionInsert = Pick<VoiceSessionRow,
  'id' | 'user_sub' | 'tenant' | 'hold_id' | 'model' | 'voice' | 'mock' | 'max_seconds' | 'usd_per_minute'>;

export interface VoiceSessionClose {
  seconds: number | null;
  cost_usd: number | null;
  cost_basis: CostBasis;
  stop_reason: VoiceStopReason;
}

const s = (name: string, v: string): SqlParameter => ({ name, value: { stringValue: v } });
const maybe = (name: string, v: string | null | undefined): SqlParameter => (v ? s(name, v) : { name, value: { isNull: true } });
const int = (name: string, v: number | null | undefined): SqlParameter =>
  (v == null || !Number.isFinite(v) ? { name, value: { isNull: true } } : { name, value: { longValue: Math.trunc(v) } });
const dbl = (name: string, v: number | null | undefined): SqlParameter =>
  (v == null || !Number.isFinite(v) ? { name, value: { isNull: true } } : { name, value: { doubleValue: v } });

const SELECT = `id, user_sub, tenant, hold_id::text AS hold_id, provider_session_id, model, voice, mock, max_seconds,
  usd_per_minute, started_at::text AS started_at, ended_at::text AS ended_at, seconds, cost_usd, cost_basis, stop_reason, tool_calls,
  provider_seconds, provider_tokens_in, provider_tokens_out, provider_tokens_cached`;

function toRow(r: Record<string, unknown>): VoiceSessionRow {
  const str = (k: string): string | null => (r[k] == null ? null : String(r[k]));
  const n = (k: string): number | null => (r[k] == null || !Number.isFinite(Number(r[k])) ? null : Number(r[k]));
  return {
    id: String(r['id']), user_sub: String(r['user_sub'] ?? ''), tenant: String(r['tenant'] ?? ''),
    hold_id: str('hold_id'), provider_session_id: str('provider_session_id'), model: str('model'), voice: str('voice'),
    mock: r['mock'] === true || r['mock'] === 't' || r['mock'] === 'true', max_seconds: n('max_seconds') ?? 0,
    usd_per_minute: n('usd_per_minute') ?? 0, started_at: String(r['started_at'] ?? ''), ended_at: str('ended_at'),
    seconds: n('seconds'), cost_usd: n('cost_usd'), cost_basis: str('cost_basis') as CostBasis | null,
    stop_reason: str('stop_reason') as VoiceStopReason | null, tool_calls: n('tool_calls') ?? 0,
    provider_seconds: n('provider_seconds'), provider_tokens_in: n('provider_tokens_in'),
    provider_tokens_out: n('provider_tokens_out'), provider_tokens_cached: n('provider_tokens_cached'),
  };
}

export async function insertVoiceSession(row: VoiceSessionInsert): Promise<VoiceSessionRow> {
  if (config.mock.aurora) {
    const full: VoiceSessionRow = {
      ...row, provider_session_id: null, started_at: clock.nowIso(), ended_at: null, seconds: null,
      cost_usd: null, cost_basis: null, stop_reason: null, tool_calls: 0,
      provider_seconds: null, provider_tokens_in: null, provider_tokens_out: null, provider_tokens_cached: null,
    };
    if (voiceSessions.rows().some((r) => r.id === row.id)) throw new Error(`voice session ${row.id} already exists`);
    voiceSessions.rows().push(full);
    return { ...full };
  }
  const rows = await exec(
    `INSERT INTO voice_sessions (id, user_sub, tenant, hold_id, model, voice, mock, max_seconds, usd_per_minute)
     VALUES (:id, :sub, :tenant, :hold::uuid, :model, :voice, :mock, :max, :rate::numeric) RETURNING ${SELECT}`,
    [s('id', row.id), s('sub', row.user_sub), s('tenant', row.tenant), maybe('hold', row.hold_id), maybe('model', row.model),
      maybe('voice', row.voice), { name: 'mock', value: { booleanValue: row.mock } }, int('max', row.max_seconds),
      dbl('rate', row.usd_per_minute)],
  );
  return toRow(rows[0] ?? {});
}

/** Record the provider's id once the mint answered. */
export async function setProviderSessionId(id: string, providerSessionId: string | null): Promise<void> {
  if (!providerSessionId) return;
  if (config.mock.aurora) {
    const row = voiceSessions.rows().find((r) => r.id === id);
    if (row) row.provider_session_id = providerSessionId;
    return;
  }
  await exec('UPDATE voice_sessions SET provider_session_id = :p WHERE id = :id', [s('p', providerSessionId), s('id', id)]);
}

/** The sideband's figures for one session (G12), as `lib/voice/openai.ts` ProviderUsage carries them. */
export interface ProviderUsageColumns {
  seconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
}

/**
 * Record the provider's figures for a session (G12). Every column only ever
 * grows (cumulative seconds, summed tokens), so frames written out of order,
 * or by a second writer, never lower a figure; a null leaves the column as it
 * is. Written outside any request (the sideband's socket events), so it runs
 * in the session's own tenant scope.
 */
export async function recordProviderUsage(id: string, tenant: string, usage: ProviderUsageColumns): Promise<void> {
  const whole = (v: number | null): number | null => (v == null || !Number.isFinite(v) || v < 0 ? null : Math.ceil(v));
  const sec = whole(usage.seconds), tin = whole(usage.inputTokens), tout = whole(usage.outputTokens), tcached = whole(usage.cachedTokens);
  if (sec == null && tin == null && tout == null && tcached == null) return;
  if (config.mock.aurora) {
    const row = voiceSessions.rows().find((r) => r.id === id);
    if (!row) return;
    const grow = (prev: number | null, next: number | null): number | null => (next == null ? prev : Math.max(prev ?? 0, next));
    row.provider_seconds = grow(row.provider_seconds ?? null, sec);
    row.provider_tokens_in = grow(row.provider_tokens_in ?? null, tin);
    row.provider_tokens_out = grow(row.provider_tokens_out ?? null, tout);
    row.provider_tokens_cached = grow(row.provider_tokens_cached ?? null, tcached);
    return;
  }
  const { runWithDbTenant } = await import('./db-tenant.js');
  // GREATEST ignores NULLs, so a null parameter keeps the stored figure and a null column takes the new one.
  await runWithDbTenant(tenant, () => exec(
    `UPDATE voice_sessions SET provider_seconds = GREATEST(provider_seconds, :sec::integer),
        provider_tokens_in = GREATEST(provider_tokens_in, :tin::bigint), provider_tokens_out = GREATEST(provider_tokens_out, :tout::bigint),
        provider_tokens_cached = GREATEST(provider_tokens_cached, :tcached::bigint)
      WHERE id = :id`,
    [s('id', id), int('sec', sec), int('tin', tin), int('tout', tout), int('tcached', tcached)],
  ));
}

export async function getVoiceSession(id: string): Promise<VoiceSessionRow | null> {
  if (config.mock.aurora) {
    const row = voiceSessions.rows().find((r) => r.id === id);
    return row ? { ...row } : null;
  }
  const rows = await exec(`SELECT ${SELECT} FROM voice_sessions WHERE id = :id`, [s('id', id)]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Close a session that is still open. Returns the closed row when THIS call
 * closed it, null when it was already closed (or does not exist).
 */
export async function closeVoiceSession(id: string, close: VoiceSessionClose): Promise<VoiceSessionRow | null> {
  if (config.mock.aurora) {
    const row = voiceSessions.rows().find((r) => r.id === id);
    if (!row || row.ended_at) return null;
    Object.assign(row, { ...close, ended_at: clock.nowIso() });
    return { ...row };
  }
  const rows = await exec(
    `UPDATE voice_sessions SET ended_at = NOW(), seconds = :sec, cost_usd = :cost::numeric, cost_basis = :basis, stop_reason = :reason
      WHERE id = :id AND ended_at IS NULL RETURNING ${SELECT}`,
    [s('id', id), int('sec', close.seconds), dbl('cost', close.cost_usd), s('basis', close.cost_basis), s('reason', close.stop_reason)],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * A reaped session the dock reports late: replace its unknown figure with the
 * reported seconds. Only ever moves `unknown` to known, never a known cost.
 */
export async function learnReapedSessionCost(id: string, seconds: number, costUsd: number): Promise<VoiceSessionRow | null> {
  if (config.mock.aurora) {
    const row = voiceSessions.rows().find((r) => r.id === id);
    if (!row || row.stop_reason !== 'reaped' || row.cost_basis !== 'unknown') return null;
    Object.assign(row, { seconds, cost_usd: costUsd, cost_basis: 'estimated' as CostBasis });
    return { ...row };
  }
  const rows = await exec(
    `UPDATE voice_sessions SET seconds = :sec, cost_usd = :cost::numeric, cost_basis = 'estimated'
      WHERE id = :id AND stop_reason = 'reaped' AND cost_basis = 'unknown' RETURNING ${SELECT}`,
    [s('id', id), int('sec', seconds), dbl('cost', costUsd)],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Every session not yet closed; the reaper decides which have passed their ceiling. */
export async function listOpenVoiceSessions(limit = 200): Promise<VoiceSessionRow[]> {
  if (config.mock.aurora) {
    return voiceSessions.rows().filter((r) => !r.ended_at).slice(0, limit).map((r) => ({ ...r }));
  }
  const rows = await exec(
    `SELECT ${SELECT} FROM voice_sessions WHERE ended_at IS NULL ORDER BY started_at LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}`,
  );
  return rows.map(toRow);
}

/**
 * The voice seconds `userSub` has used since `since` (G13, the daily minutes):
 * every non-mock session started at or after it, at its known seconds, else at
 * its ceiling (`max_seconds`: still open, or reaped unknown). Mock rows never
 * count. Read across every tenant (the cap is per user, not per workspace), so
 * it runs as the system; the statement is filtered by the user itself.
 */
export async function userVoiceSecondsSince(userSub: string, since: Date): Promise<number> {
  const from = since.getTime();
  const { runAsSystem } = await import('./db-tenant.js');
  if (config.mock.aurora) {
    return runAsSystem(() => voiceSessions.rows())
      .filter((r) => r.user_sub === userSub && !r.mock && Date.parse(r.started_at) >= from)
      .reduce((n, r) => n + (r.seconds ?? r.max_seconds), 0);
  }
  const rows = await runAsSystem(() => exec(
    `SELECT COALESCE(SUM(COALESCE(seconds, max_seconds)), 0)::bigint AS used
       FROM voice_sessions WHERE user_sub = :sub AND mock = false AND started_at >= :since::timestamptz`,
    [s('sub', userSub), s('since', since.toISOString())],
  ));
  const used = Number(rows[0]?.['used'] ?? 0);
  return Number.isFinite(used) ? used : 0;
}

/** More open rows than one person could hold at once; the mint needs only whether there is one. */
const MAX_OPEN_LISTED = 20;

/**
 * The user's open real sessions in every tenant, oldest first (one voice
 * session per person, routes/voice.ts). Mock rows never count. Read as the
 * system, like the daily minutes: the statement is filtered by the user.
 */
export async function userOpenVoiceSessions(userSub: string): Promise<VoiceSessionRow[]> {
  const { runAsSystem } = await import('./db-tenant.js');
  if (config.mock.aurora) {
    return runAsSystem(() => voiceSessions.rows())
      .filter((r) => r.user_sub === userSub && !r.mock && !r.ended_at)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .slice(0, MAX_OPEN_LISTED)
      .map((r) => ({ ...r }));
  }
  const rows = await runAsSystem(() => exec(
    `SELECT ${SELECT} FROM voice_sessions WHERE user_sub = :sub AND mock = false AND ended_at IS NULL
      ORDER BY started_at LIMIT ${MAX_OPEN_LISTED}`,
    [s('sub', userSub)],
  ));
  return rows.map(toRow);
}

/** Per-session cap on tool-call rows, so a misbehaving tab cannot grow the table without bound. */
export const MAX_TOOL_CALLS_PER_SESSION = 500;

export type VoiceToolCallInsert = Omit<VoiceToolCallRow, 'id' | 'at'>;

/** Append one tool-call row and count it on the session. False when the session is at its cap. */
export async function insertVoiceToolCall(row: VoiceToolCallInsert): Promise<VoiceToolCallRow | null> {
  const full: VoiceToolCallRow = { ...row, id: randomUUID(), at: clock.nowIso() };
  if (config.mock.aurora) {
    const session = voiceSessions.rows().find((r) => r.id === row.session_id);
    if (!session || session.tool_calls >= MAX_TOOL_CALLS_PER_SESSION) return null;
    session.tool_calls += 1;
    voiceToolCalls.rows().push(full);
    return { ...full };
  }
  const bumped = await exec(
    `UPDATE voice_sessions SET tool_calls = tool_calls + 1 WHERE id = :sid AND tool_calls < ${MAX_TOOL_CALLS_PER_SESSION} RETURNING id`,
    [s('sid', row.session_id)],
  );
  if (!bumped.length) return null;
  await exec(
    `INSERT INTO voice_tool_calls (id, session_id, tenant, tool, args_sha256, outcome, confirmed_by, duration_ms, at)
     VALUES (:id::uuid, :sid, :tenant, :tool, :sha, :outcome, :by, :ms, :at::timestamptz)`,
    [s('id', full.id), s('sid', row.session_id), s('tenant', row.tenant), s('tool', row.tool), maybe('sha', row.args_sha256),
      s('outcome', row.outcome), maybe('by', row.confirmed_by), int('ms', row.duration_ms), s('at', full.at)],
  );
  return full;
}

/** Every tool-call row of one session, oldest first. */
export async function listVoiceToolCalls(sessionId: string): Promise<VoiceToolCallRow[]> {
  if (config.mock.aurora) return voiceToolCalls.rows().filter((r) => r.session_id === sessionId).map((r) => ({ ...r }));
  const rows = await exec(
    `SELECT id::text AS id, session_id, tenant, tool, args_sha256, outcome, confirmed_by, duration_ms, at::text AS at
       FROM voice_tool_calls WHERE session_id = :sid ORDER BY at`,
    [s('sid', sessionId)],
  );
  return rows.map((r) => ({
    id: String(r['id']), session_id: String(r['session_id']), tenant: String(r['tenant']), tool: String(r['tool']),
    args_sha256: r['args_sha256'] == null ? null : String(r['args_sha256']), outcome: String(r['outcome']) as VoiceToolOutcome,
    confirmed_by: (r['confirmed_by'] ?? null) as VoiceToolCallRow['confirmed_by'],
    duration_ms: r['duration_ms'] == null ? null : Number(r['duration_ms']), at: String(r['at']),
  }));
}

// ─── The session's event log (lib/voice/session-log.ts, routes/voice-log.ts) ──

/** The closed set of event kinds (schema/voice_sessions.sql `voice_session_events.kind`). */
export const VOICE_EVENT_KINDS = [
  'minted', 'started', 'delegation', 'tool-call', 'tool-result', 'refused', 'confirm-shown', 'confirmed', 'cancelled',
  'usage', 'sideband', 'reaper', 'closed', 'error', 'client',
] as const;
export type VoiceEventKind = typeof VOICE_EVENT_KINDS[number];

export interface VoiceSessionEventRow {
  id: string;
  session_id: string;
  tenant: string;
  /** 1-based, gapless within the session: the order the events were written in. */
  seq: number;
  at: string;
  kind: VoiceEventKind;
  /** Already sanitized and at most 2 KB serialized (lib/voice/session-log.ts). */
  data: Record<string, unknown>;
}

/** Per-session cap on event rows, so a misbehaving tab cannot grow the log without bound. */
export const MAX_EVENTS_PER_SESSION = 500;

/**
 * Append one event to a session's log with the next `seq`. Null when the
 * session does not exist or its log is at the cap. Runs in the session's own
 * tenant scope: it is written from requests, the sideband's socket and the
 * reaper alike.
 */
export async function insertVoiceSessionEvent(row: Omit<VoiceSessionEventRow, 'id' | 'seq' | 'at'>): Promise<VoiceSessionEventRow | null> {
  const at = clock.nowIso();
  if (config.mock.aurora) {
    const { runAsSystem } = await import('./db-tenant.js');
    return runAsSystem(() => {
      if (!voiceSessions.rows().some((r) => r.id === row.session_id)) return null;
      const seq = voiceSessionEvents.rows().filter((r) => r.session_id === row.session_id).length + 1;
      if (seq > MAX_EVENTS_PER_SESSION) return null;
      const full: VoiceSessionEventRow = { ...row, id: randomUUID(), seq, at, data: { ...row.data } };
      voiceSessionEvents.rows().push(full);
      return { ...full, data: { ...full.data } };
    });
  }
  const { runWithDbTenant } = await import('./db-tenant.js');
  return runWithDbTenant(row.tenant, async () => {
    // The counter is the sequence: one statement, so two writers never share a seq.
    const bumped = await exec(
      `UPDATE voice_sessions SET events = events + 1 WHERE id = :sid AND events < ${MAX_EVENTS_PER_SESSION} RETURNING events`,
      [s('sid', row.session_id)],
    );
    const seq = Number(bumped[0]?.['events']);
    if (!bumped.length || !Number.isFinite(seq)) return null;
    const full: VoiceSessionEventRow = { ...row, id: randomUUID(), seq, at };
    await exec(
      `INSERT INTO voice_session_events (id, session_id, tenant, seq, at, kind, data)
       VALUES (:id::uuid, :sid, :tenant, :seq, :at::timestamptz, :kind, :data::jsonb)`,
      [s('id', full.id), s('sid', row.session_id), s('tenant', row.tenant), int('seq', seq), s('at', at), s('kind', row.kind),
        s('data', JSON.stringify(row.data))],
    );
    return full;
  });
}

/** One session's log, in `seq` order. The caller has checked who owns the session. */
export async function listVoiceSessionEvents(sessionId: string): Promise<VoiceSessionEventRow[]> {
  if (config.mock.aurora) {
    return voiceSessionEvents.rows().filter((r) => r.session_id === sessionId)
      .sort((a, b) => a.seq - b.seq).map((r) => ({ ...r, data: { ...r.data } }));
  }
  const rows = await exec(
    `SELECT id::text AS id, session_id, tenant, seq, at::text AS at, kind, data::text AS data
       FROM voice_session_events WHERE session_id = :sid ORDER BY seq`,
    [s('sid', sessionId)],
  );
  return rows.map((r) => {
    let data: Record<string, unknown> = {};
    try { const v = JSON.parse(String(r['data'] ?? '{}')); if (v && typeof v === 'object' && !Array.isArray(v)) data = v; } catch { /* stored by us; never fails */ }
    return {
      id: String(r['id']), session_id: String(r['session_id']), tenant: String(r['tenant']), seq: Number(r['seq']),
      at: String(r['at']), kind: String(r['kind']) as VoiceEventKind, data,
    };
  });
}

/**
 * Delete every event row written before `before` (the 30-day retention, run by
 * the voice reaper's sweep). Every tenant's rows: the caller runs as the
 * system. Returns how many went.
 */
export async function deleteVoiceSessionEventsBefore(before: Date): Promise<number> {
  const cutoff = before.getTime();
  if (config.mock.aurora) {
    const rows = voiceSessionEvents.rows();
    let gone = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (Date.parse(rows[i]!.at) < cutoff) { rows.splice(i, 1); gone += 1; }
    }
    return gone;
  }
  const rows = await exec(
    'DELETE FROM voice_session_events WHERE at < :before::timestamptz RETURNING id',
    [s('before', before.toISOString())],
  );
  return rows.length;
}

/** A session row as the owner's list shows it: the row plus its last tool call's outcome. */
export type VoiceSessionListRow = VoiceSessionRow & { last_outcome: VoiceToolOutcome | null };

/**
 * `userSub`'s own sessions in every tenant, newest first, started at or after
 * `since` when given. Read as the system, like the daily minutes: the
 * statement is filtered by the user, and the user is the boundary.
 */
export async function listUserVoiceSessions(userSub: string, opts: { since?: Date | null; limit: number }): Promise<VoiceSessionListRow[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const from = opts.since ? opts.since.getTime() : null;
  const { runAsSystem } = await import('./db-tenant.js');
  if (config.mock.aurora) {
    return runAsSystem(() => {
      const calls = voiceToolCalls.rows();
      return voiceSessions.rows()
        .filter((r) => r.user_sub === userSub && (from == null || Date.parse(r.started_at) >= from))
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((r) => {
          const mine = calls.filter((c) => c.session_id === r.id);
          return { ...r, last_outcome: mine.length ? mine[mine.length - 1]!.outcome : null };
        });
    });
  }
  const rows = await runAsSystem(() => exec(
    `SELECT ${SELECT},
        (SELECT t.outcome FROM voice_tool_calls t WHERE t.session_id = voice_sessions.id ORDER BY t.at DESC LIMIT 1) AS last_outcome
       FROM voice_sessions WHERE user_sub = :sub${from == null ? '' : ' AND started_at >= :since::timestamptz'}
      ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
    [s('sub', userSub), ...(from == null ? [] : [s('since', new Date(from).toISOString())])],
  ));
  return rows.map((r) => ({ ...toRow(r), last_outcome: (r['last_outcome'] ?? null) as VoiceToolOutcome | null }));
}

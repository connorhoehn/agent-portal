// The voice reaper (docs/voice-navigator-spec.md §7): the backstop for a
// session whose tab died without closing it.
//
// A session still open past its own ceiling (max_seconds, fixed at mint) plus
// the hold grace is hung up at the provider so it stops billing (server.mjs
// /api/hangup), closed as `reaped`, and its hold, due by then because it was
// taken for exactly that long, is expired. Its figures are the provider's
// when there are any (G12): the final `session.closed` usage read from the
// sideband this process holds, else the last figures the sideband wrote to
// the row, booked `reported`; with neither the cost is UNKNOWN (never 0:
// nobody reported its seconds), and a later close from the dock may still
// replace it (routes/voice.ts).
//
// Each session it closes gets a `reaper` and a `closed` row in its event log
// (lib/voice/session-log.ts). The same sweep also deletes event rows past
// their 30 days (sweepVoiceEventRetention, called beside this one).
//
// Run by the devbox reaper's leader once per sweep (lib/devbox-reaper.ts
// `voiceSweep`), so it is single-flight across replicas like the rest.

import { clock } from '../../mock/core/index.js';
import { HOLD_GRACE_MS } from '../spend-holds.js';
import type { VoiceEventKind, VoiceSessionRow, VoiceSessionClose } from '../../providers/voice-sessions.js';
import type { ProviderUsage } from './openai.js';
import { preferProviderFigures, providerUsageFromRow, type DelegatedUsage, type KnownBasis } from './ledger.js';

/** How long the reaper waits for `session.closed` on the sideband after its hangup. */
export const REAPER_SIDEBAND_WAIT_MS = 3_000;

export interface VoiceReaperDeps {
  now: () => number;
  listOpen: () => Promise<VoiceSessionRow[]>;
  close: (id: string, close: VoiceSessionClose) => Promise<VoiceSessionRow | null>;
  book: (row: VoiceSessionRow, delegated?: DelegatedUsage | null, tokensBasis?: KnownBasis) => Promise<void>;
  expireHold: (holdId: string | null) => Promise<boolean>;
  /** Hang the session up, then read its final usage from this process's sideband (null without one). */
  hangupAndRead: (providerSessionId: string) => Promise<{ hungUp: boolean; usage: ProviderUsage | null }>;
  /** Close and forget the session's sideband. */
  detach: (providerSessionId: string) => void;
  log: (line: Record<string, unknown>) => void;
  /** Append a row to the session's event log (lib/voice/session-log.ts). Default: none. */
  event?: (row: Pick<VoiceSessionRow, 'id' | 'tenant'>, kind: VoiceEventKind, data: Record<string, unknown>) => Promise<unknown>;
}

export async function defaultVoiceReaperDeps(): Promise<VoiceReaperDeps> {
  const sessions = await import('../../providers/voice-sessions.js');
  const { expireHoldIfDue } = await import('../../providers/spend-holds.js');
  const { hangupAndReadUsage, detachSideband } = await import('./openai.js');
  const { bookVoiceSpend } = await import('./ledger.js');
  const { recordVoiceEvent } = await import('./session-log.js');
  return {
    now: () => clock.now().getTime(),
    listOpen: () => sessions.listOpenVoiceSessions(),
    close: sessions.closeVoiceSession,
    book: bookVoiceSpend,
    expireHold: expireHoldIfDue,
    hangupAndRead: (id) => hangupAndReadUsage(id, REAPER_SIDEBAND_WAIT_MS),
    detach: detachSideband,
    log: (line) => console.log(JSON.stringify(line)),
    event: recordVoiceEvent,
  };
}

/** Whether an open session has passed its ceiling plus grace at `now`. Pure. */
export function voiceSessionOverdue(row: Pick<VoiceSessionRow, 'started_at' | 'max_seconds' | 'ended_at'>, now: number, graceMs = HOLD_GRACE_MS): boolean {
  if (row.ended_at) return false;
  const started = Date.parse(row.started_at);
  return Number.isFinite(started) && now - started >= row.max_seconds * 1000 + graceMs;
}

/** One sweep. Returns the ids it reaped. */
export async function sweepVoiceSessions(deps: VoiceReaperDeps, graceMs = HOLD_GRACE_MS): Promise<string[]> {
  const now = deps.now();
  const reaped: string[] = [];
  for (const row of await deps.listOpen()) {
    if (!voiceSessionOverdue(row, now, graceMs)) continue;
    // Stop the billing first, and read the final usage the hangup brings on the sideband (G12).
    const live = !row.mock && row.provider_session_id ? row.provider_session_id : null;
    let usage: ProviderUsage | null = null;
    let hungUp = false;
    if (live) ({ hungUp, usage } = await deps.hangupAndRead(live).catch(() => ({ hungUp: false, usage: null })));
    const figures = preferProviderFigures(row, usage ?? providerUsageFromRow(row), { seconds: null, delegated: null });
    // Compare-and-set: a close that raced this sweep wins and is left alone.
    const closed = await deps.close(row.id, {
      seconds: figures.seconds, cost_usd: figures.costUsd, cost_basis: figures.basis, stop_reason: 'reaped',
    });
    if (live) deps.detach(live);
    if (!closed) continue;
    await deps.book(closed, figures.delegated, figures.tokensBasis);
    await deps.expireHold(closed.hold_id);
    const minutesOpen = Math.round((now - Date.parse(row.started_at)) / 60_000);
    await deps.event?.(closed, 'reaper', { minutesOpen, maxSeconds: row.max_seconds, hungUp, providerFigures: usage != null, providerFinal: usage?.final ?? false });
    await deps.event?.(closed, 'closed', { stopReason: 'reaped', seconds: figures.seconds, costUsd: figures.costUsd, basis: figures.basis });
    deps.log({ event: 'voice-session-reaped', sessionId: closed.id, sub: closed.user_sub, minutes: Math.round((now - Date.parse(row.started_at)) / 60_000),
      seconds: figures.seconds, basis: figures.basis });
    reaped.push(closed.id);
  }
  return reaped;
}

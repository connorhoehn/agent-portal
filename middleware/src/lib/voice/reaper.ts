// The voice reaper (docs/voice-navigator-spec.md §7): the backstop for a
// session whose tab died without closing it.
//
// A session still open past its own ceiling (max_seconds, fixed at mint) plus
// the hold grace is closed as `reaped`, booked with an UNKNOWN cost (never 0:
// nobody reported its seconds), hung up at the provider so it stops billing
// (server.mjs /api/hangup), and its hold, due by then because it was taken
// for exactly that long, is expired. A later close from the dock may still
// replace the unknown figure (routes/voice.ts).
//
// Run by the devbox reaper's leader once per sweep (lib/devbox-reaper.ts
// `voiceSweep`), so it is single-flight across replicas like the rest.

import { clock } from '../../mock/core/index.js';
import { HOLD_GRACE_MS } from '../spend-holds.js';
import type { VoiceSessionRow, VoiceSessionClose } from '../../providers/voice-sessions.js';

export interface VoiceReaperDeps {
  now: () => number;
  listOpen: () => Promise<VoiceSessionRow[]>;
  close: (id: string, close: VoiceSessionClose) => Promise<VoiceSessionRow | null>;
  book: (row: VoiceSessionRow) => Promise<void>;
  expireHold: (holdId: string | null) => Promise<boolean>;
  hangup: (providerSessionId: string) => Promise<boolean>;
  log: (line: Record<string, unknown>) => void;
}

export async function defaultVoiceReaperDeps(): Promise<VoiceReaperDeps> {
  const sessions = await import('../../providers/voice-sessions.js');
  const { expireHoldIfDue } = await import('../../providers/spend-holds.js');
  const { hangupLiveSession } = await import('./openai.js');
  const { bookVoiceSpend } = await import('./ledger.js');
  return {
    now: () => clock.now().getTime(),
    listOpen: () => sessions.listOpenVoiceSessions(),
    close: sessions.closeVoiceSession,
    book: bookVoiceSpend,
    expireHold: expireHoldIfDue,
    hangup: hangupLiveSession,
    log: (line) => console.log(JSON.stringify(line)),
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
    // Compare-and-set: a close that raced this sweep wins and is left alone.
    const closed = await deps.close(row.id, { seconds: null, cost_usd: null, cost_basis: 'unknown', stop_reason: 'reaped' });
    if (!closed) continue;
    await deps.book(closed);
    if (!closed.mock && closed.provider_session_id) await deps.hangup(closed.provider_session_id);
    await deps.expireHold(closed.hold_id);
    deps.log({ event: 'voice-session-reaped', sessionId: closed.id, sub: closed.user_sub, minutes: Math.round((now - Date.parse(row.started_at)) / 60_000) });
    reaped.push(closed.id);
  }
  return reaped;
}

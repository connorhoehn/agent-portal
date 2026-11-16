// The live transcript in the call's pane: what Milo is hearing, as it hears it. Pure, so node:test covers it; the hook
// (liveTranscript.ts) and the view (components/shell/LiveTranscript.tsx) only follow what these functions decide.

import type { AssistantPhase, AssistantView } from './meetingAssistantModel';
import { ASSISTANT_NAME, assistantStateWords } from './meetingAssistantModel.ts';

/** The newest lines read when the view opens, and each "Load earlier lines" page. */
export const LIVE_TAIL = 100;
/** How often new lines are read while Milo listens, and while it is paused (nothing new is stored then; a resume shows soon enough). */
export const LIVE_POLL_LISTENING_MS = 2000;
export const LIVE_POLL_PAUSED_MS = 5000;

export interface LiveLine { seq: number; userId: string | null; speakerName: string; text: string; at: number; startMs?: number; endMs?: number }
export interface LiveSpeaker { userId: string; name: string; avatarUrl: string | null }

/** The first read (`tail`) and each "Load earlier lines" (`tail` before the oldest line held). */
export const liveTailUrl = (callId: string, before?: number | null): string =>
  `/api/calls/${encodeURIComponent(callId)}/assistant/transcript?tail=${LIVE_TAIL}${before ? `&before=${before}` : ''}`;
/** Each poll: the lines after the newest one held. */
export const liveAfterUrl = (callId: string, after: number): string =>
  `/api/calls/${encodeURIComponent(callId)}/assistant/transcript?after=${after}&limit=500`;
/**
 * A poll's read: the lines after the newest one held, or the newest lines again while nothing is held (a first read that failed
 * or found nothing), so a poll never reads forward from the oldest line (sweep 4 in-call 15).
 */
export function livePollRead(callId: string, held: readonly LiveLine[]): { url: string; mode: 'tail' | 'after' } {
  return held.length ? { url: liveAfterUrl(callId, newestSeq(held)), mode: 'after' } : { url: liveTailUrl(callId), mode: 'tail' };
}

/**
 * What the hook does next, from whether the view is on, Milo's phase and whether the last read after Milo left was made:
 * `idle` (nothing is fetched), `poll` every `everyMs`, `final` (one more read now that Milo has left), or `done`.
 * The first read (the tail) is made whenever the view is on and nothing is loaded yet, whatever the phase.
 */
export type LivePlan = { kind: 'idle' } | { kind: 'poll'; everyMs: number } | { kind: 'final' } | { kind: 'done' };

export function livePlan(on: boolean, phase: AssistantPhase, finalRead: boolean): LivePlan {
  if (!on) return { kind: 'idle' };
  if (phase === 'listening' || phase === 'invited') return { kind: 'poll', everyMs: LIVE_POLL_LISTENING_MS };
  if (phase === 'paused') return { kind: 'poll', everyMs: LIVE_POLL_PAUSED_MS };
  if (phase === 'left') return finalRead ? { kind: 'done' } : { kind: 'final' };
  return { kind: 'done' };
}

/**
 * The hook's reads after the first, one at a time: `out` is the read in flight, `final` the read after Milo left (owed, or made).
 * A call can have several listening periods (Milo invited back), so a new period (invited, listening or paused) forgets the last
 * final read and leaving again owes another. A poll still out when Milo leaves is waited for, then the final read is made: that
 * poll's answer may have been written before her last lines were stored.
 */
export interface LiveReads { out: 'poll' | 'final' | null; final: 'none' | 'owed' | 'done' }
export const LIVE_READS_START: LiveReads = { out: null, final: 'none' };

/** Milo's phase is now `phase`. A final read still out when a new period begins counts as an ordinary poll. */
export function readsAtPhase(r: LiveReads, phase: AssistantPhase): LiveReads {
  if (phase === 'left') return r.final === 'none' ? { ...r, final: 'owed' } : r;
  if (phase === 'invited' || phase === 'listening' || phase === 'paused') {
    return r.final === 'none' && r.out !== 'final' ? r : { out: r.out === 'final' ? 'poll' : r.out, final: 'none' };
  }
  return r;
}

/** The read to start now, if any: the owed final read once nothing is out; a due poll only when nothing is out and none is owed. */
export function readToStart(r: LiveReads, pollDue: boolean): 'poll' | 'final' | null {
  if (r.out) return null;
  if (r.final === 'owed') return 'final';
  return pollDue && r.final === 'none' ? 'poll' : null;
}

export const readStarted = (r: LiveReads, kind: 'poll' | 'final'): LiveReads => ({ ...r, out: kind });

/** The read in flight came back (or failed): when it was the owed final read, that read is made. */
export const readEnded = (r: LiveReads): LiveReads => ({ out: null, final: r.out === 'final' && r.final === 'owed' ? 'done' : r.final });

/** New lines after what is held, oldest first, each seq once (a poll that overlaps a slow earlier one adds nothing twice). */
export function mergeLines(held: readonly LiveLine[], incoming: readonly LiveLine[]): LiveLine[] {
  if (!incoming.length) return held as LiveLine[];
  const bySeq = new Map<number, LiveLine>();
  for (const l of held) bySeq.set(l.seq, l);
  for (const l of incoming) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The cursor for the next poll: the newest seq held. */
export const newestSeq = (lines: readonly LiveLine[], fallback = 0): number => (lines.length ? lines[lines.length - 1]!.seq : fallback);
/** The `before` for "Load earlier lines": the oldest seq held. */
export const oldestSeq = (lines: readonly LiveLine[]): number | null => (lines.length ? lines[0]!.seq : null);

/** Speakers keyed by user id; a later answer's portrait wins. */
export function mergeSpeakers(held: ReadonlyMap<string, LiveSpeaker>, incoming: readonly LiveSpeaker[]): Map<string, LiveSpeaker> {
  const next = new Map(held);
  for (const s of incoming) next.set(s.userId, s);
  return next;
}

/**
 * The quiet state after "Live transcript": the footer mark's own words while Milo is joining or listening ("Milo is connecting",
 * "Milo cannot hear the call"), so the two never disagree (sweep 4 in-call 6); the transcript's own words once paused or gone.
 */
export function liveStateWords(view: Pick<AssistantView, 'phase' | 'hearing'>): string {
  if (view.phase === 'paused') return `${ASSISTANT_NAME} is paused, nothing is being transcribed`;
  if (view.phase === 'left') return `${ASSISTANT_NAME} has left; this is what it heard`;
  return assistantStateWords(view as AssistantView) ?? `${ASSISTANT_NAME} is listening`;
}

export const LIVE_EMPTY = `${ASSISTANT_NAME} has not heard anything yet.`;
export const LIVE_NOT_ACKED = 'Your own words are not transcribed until you acknowledge.';
export const LIVE_ACK_LABEL = 'Acknowledge';
export const LIVE_SHOW_LABEL = 'Show transcript';
export const LIVE_HIDE_LABEL = 'Hide transcript';
export const LIVE_SHOW_DESCRIPTION = `What ${ASSISTANT_NAME} is hearing, as it hears it`;

/**
 * A line's place on the call's own timeline: always from its clock time (`at`, when it ended) less `since`, its media offsets
 * used only for how long it lasted. Offsets a session reported restart at 0 after a pause, a replaced session or an invitation
 * back, so they never place a line (sweep 4 in-call 4). With no `since` yet, the stored offsets stand.
 */
export function lineTimes(l: { at: number; startMs?: number; endMs?: number }, since: number | null): { startMs: number; endMs: number } {
  const lasted = l.startMs !== undefined && l.endMs !== undefined && l.endMs >= l.startMs ? l.endMs - l.startMs : null;
  if (since === null) { const startMs = l.startMs ?? 0; return { startMs, endMs: l.endMs ?? startMs + 1000 }; }
  const startMs = Math.max(0, l.at - since - (lasted ?? 0));
  return { startMs, endMs: startMs + (lasted ?? 1000) };
}

/**
 * The rows the library's TranscriptPanel draws: the speaker's name and portrait from the answer's speakers (the line's own name
 * otherwise, "Unknown" for an unattributed line with none, as the meeting page reads it), and the time since Milo joined.
 */
export function liveSegments(lines: readonly LiveLine[], speakers: ReadonlyMap<string, LiveSpeaker>, since: number | null) {
  return lines.map((l) => {
    const { startMs, endMs } = lineTimes(l, since);
    const who = l.userId ? speakers.get(l.userId) : undefined;
    return {
      id: String(l.seq), startMs, endMs, ...(l.userId ? { speakerId: l.userId } : {}),
      speakerLabel: who?.name || l.speakerName || 'Unknown', speakerAvatarUrl: who?.avatarUrl ?? null, text: l.text,
    };
  });
}

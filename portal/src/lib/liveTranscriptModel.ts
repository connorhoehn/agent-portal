// The live transcript in the call's pane: what Nova is hearing, as it hears it. Pure, so node:test covers it; the hook
// (liveTranscript.ts) and the view (components/shell/LiveTranscript.tsx) only follow what these functions decide.

import type { AssistantPhase } from './meetingAssistantModel';

/** The newest lines read when the view opens, and each "Load earlier lines" page. */
export const LIVE_TAIL = 100;
/** How often new lines are read while Nova listens, and while it is paused (nothing new is stored then; a resume shows soon enough). */
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
 * What the hook does next, from whether the view is on, Nova's phase and whether the last read after Nova left was made:
 * `idle` (nothing is fetched), `poll` every `everyMs`, `final` (one more read now that Nova has left), or `done`.
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

/** The quiet state after "Live transcript". */
export function liveStateWords(phase: AssistantPhase): string {
  if (phase === 'paused') return 'Nova is paused, nothing is being transcribed';
  if (phase === 'left') return 'Nova has left; this is what it heard';
  return 'Nova is listening';
}

export const LIVE_EMPTY = 'Nova has not heard anything yet.';
export const LIVE_NOT_ACKED = 'Your own words are not transcribed until you acknowledge Nova\'s notice.';
export const LIVE_SHOW_LABEL = 'Show transcript';
export const LIVE_HIDE_LABEL = 'Hide transcript';
export const LIVE_SHOW_DESCRIPTION = 'What Nova is hearing, as it hears it';

/**
 * The rows the library's TranscriptPanel draws: the speaker's name and portrait from the answer's speakers (the line's own name
 * otherwise, "Unknown" for an unattributed line with none, as the meeting page reads it), and the time since Nova joined.
 */
export function liveSegments(lines: readonly LiveLine[], speakers: ReadonlyMap<string, LiveSpeaker>, since: number | null) {
  return lines.map((l) => {
    const startMs = l.startMs ?? Math.max(0, l.at - (since ?? l.at));
    const who = l.userId ? speakers.get(l.userId) : undefined;
    return {
      id: String(l.seq), startMs, endMs: l.endMs ?? startMs + 1000, ...(l.userId ? { speakerId: l.userId } : {}),
      speakerLabel: who?.name || l.speakerName || 'Unknown', speakerAvatarUrl: who?.avatarUrl ?? null, text: l.text,
    };
  });
}

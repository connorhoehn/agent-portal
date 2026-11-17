// The live transcript for the panel (docs/interviews-tenant-plan.md row I3.7, decision 4; contract E5).
//
// Read from the meeting assistant's transcript of the interview's call, as the coach reads it (lib/interviews/coach/
// transcript.ts), with what the panel needs and the coach must not have: each line's time and who said it. The call is
// the interview's `callId` when it is set, else the newest assistant record in the interview's lobby. Only lines the
// store already holds are read, and the store holds a guest's words only when the transcript and Milo were accepted.
// A line nobody's audio was attributed to is left out, as the coach leaves it out: Milo never guesses who spoke.
//
// Who said it, for a person to read: a staff member by their display name; the candidate (a guest identity) by the name
// on the interview's candidate record, never the guest id. Reading never invites Milo and never costs anything.
import { assistantStore } from '../../meeting-assistant/store-select.js';
import type { AssistantRecord } from '../../meeting-assistant/types.js';
import type { CoachLine } from '../coach/prompt.js';
import { isGuestId, MILO_OFF_NO_TRANSCRIPT, MILO_OFF_NOT_ANSWERED } from '../milo-policy.js';

export interface LiveLine { seq: number; atMs: number; userId: string; text: string }
export interface LiveTranscript {
  callId: string;
  /** When Milo first joined the call (the meeting's start; a rejoin keeps it). */
  startedAtMs: number;
  /** The last line's seq the store holds, attributed or not (`after` when nothing is newer). */
  lastSeq: number;
  /** Attributed, non-empty lines after `after`, oldest first. */
  lines: LiveLine[];
}
export type LiveTranscriptSource = (interview: { id: string; callId: string | null }, after: number) => Promise<LiveTranscript | null>;

/** The most lines one read returns; the page asks again from `lastSeq`. */
export const TRANSCRIPT_PAGE = 500;
const LISTED_CALLS = 500;

async function callOf(interview: { id: string; callId: string | null }): Promise<AssistantRecord | null> {
  const store = assistantStore();
  if (interview.callId) {
    const r = await store.get(interview.callId);
    if (r) return r;
  }
  const lobby = `interviews:interview:${interview.id}`;
  const all = (await store.listByState(['invited', 'listening', 'paused', 'left'], LISTED_CALLS)).filter((r) => r.lobby === lobby);
  return all.sort((a, b) => a.invitedAt - b.invitedAt).at(-1) ?? null;
}

export const assistantLiveTranscript: LiveTranscriptSource = async (interview, after) => {
  const record = await callOf(interview);
  if (!record) return null;
  const raw = await assistantStore().lines(record.callId, Math.max(0, after), TRANSCRIPT_PAGE);
  const lastSeq = raw.reduce((m, l) => Math.max(m, l.seq), Math.max(0, after));
  const lines = raw.filter((l) => l.userId !== null && l.text.trim().length > 0)
    .map((l): LiveLine => ({ seq: l.seq, atMs: l.at, userId: l.userId!, text: l.text }));
  return { callId: record.callId, startedAtMs: record.invitedAt, lastSeq, lines };
};

// ── Pure: what the panel and the model read ─────────────────────────────────────────────────────────────────────────

export type Side = 'candidate' | 'panel';
/** E5's line. */
export interface TranscriptLineView { seq: number; at: string; side: Side; speaker: string; text: string }

export const sideOf = (userId: string): Side => (isGuestId(userId) ? 'candidate' : 'panel');

/** The panel's lines: the candidate by their record's name, everyone else by their display name. */
export function transcriptLineViews(lines: readonly LiveLine[], names: { candidate: string; nameOf: (userId: string) => string }): TranscriptLineView[] {
  return lines.map((l) => {
    const side = sideOf(l.userId);
    return { seq: l.seq, at: new Date(l.atMs).toISOString(), side, speaker: side === 'candidate' ? names.candidate : names.nameOf(l.userId), text: l.text };
  });
}

/** What the model reads: the side and the words, never a name or a time. */
export const coachLinesOf = (lines: readonly LiveLine[]): CoachLine[] => lines.map((l) => ({ seq: l.seq, side: sideOf(l.userId), text: l.text }));

/** The panel is told why there is no transcript, in one sentence. */
export const TRANSCRIPT_NOT_INVITED = 'There is no transcript yet: Milo has not been invited to the call.';

/**
 * Why there is no transcript from the candidate's answers, or null when it may run: nothing answered, or the transcript
 * declined (Milo's own sentences, lib/interviews/milo-policy.ts, which say exactly that).
 */
export function transcriptOffForConsent(consent: { transcription: boolean } | null): string | null {
  if (!consent) return MILO_OFF_NOT_ANSWERED;
  return consent.transcription ? null : MILO_OFF_NO_TRANSCRIPT;
}

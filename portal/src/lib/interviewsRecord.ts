// The interview record's model on the portal side (docs/interviews-tenant-plan.md row I5.1, contract E2): the shapes
// the middleware answers, the one line each part shows when there is nothing to play or read, the transcript as the
// library's time-aligned segments, the markers, and how a real recording is listed and played.
//
// A real recording is never played from a URL this middleware hands out: the page lists the interview's lobby on
// platform-api with the viewer's own realtime token and asks for a playback token there, and platform-api asks the
// middleware's /recording-access every time (round 4). The mock world has no media server; its stand-in says so.
import type { TranscriptSegment } from '@connorhoehn/ui-components/video';
import { recordingPlaybackUrl, type RecordingPlayback } from '../pages/projects/initiativeRecordingApi.ts';
import type { RunView } from './interviewsPad.ts';
import { INTERVIEWS_API, type InterviewState, type RoundType } from './interviews.ts';
import { realtimeEndpoints, realtimeTokenSource, type RealtimeTokenSource } from './realtimeToken.ts';

export type PartState = 'available' | 'none' | 'declined' | 'deleted';
export type MarkerKind = 'question' | 'milo-asked';

export interface RecordLine { seq: number; atMs: number; side: 'candidate' | 'panel'; speaker: string; text: string }
export interface RecordMarker { kind: MarkerKind; atMs: number; label: string }

/** E2's `record`. */
export interface InterviewRecordView {
  interview: {
    id: string; state: InterviewState; startedAt: string | null; endedAt: string | null;
    round: { name: string; type: RoundType; minutes: number };
    candidate: { id: string; name: string };
    opening: { id: string; title: string };
  };
  recording: { state: PartState; playbackUrl: string | null; durationSeconds: number | null; standIn?: boolean };
  transcript: { state: PartState; lines: RecordLine[] };
  markers: RecordMarker[];
  /** A technical round's runs, oldest first; empty for a behavioural round (and for an older server). */
  runs?: RunView[];
  /** The questions chosen for a technical round: what the pad's inserted question is called. */
  questions?: { id: string; prompt: string }[];
  /** Why a technical round's code (its pad log and runs) is gone: its keeping period ended, or the candidate asked; null or absent when nothing removed it. */
  codeRemoved?: 'period' | 'request' | null;
}

export const recordPath = (interviewId: string): string => `/interviews/rounds/${encodeURIComponent(interviewId)}/record`;
export const recordApi = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/record`;

/** Rounds that have a record: they have ended. */
export const RECORD_STATES: readonly InterviewState[] = ['ended', 'scored', 'reviewed'];
export const hasRecord = (state: InterviewState): boolean => RECORD_STATES.includes(state);

/** `m:ss`, or `h:mm:ss` past the hour. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "58 minutes", "1 hour 2 minutes". */
export function lengthOf(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${h === 1 ? '1 hour' : `${h} hours`}${rest ? ` ${rest === 1 ? '1 minute' : `${rest} minutes`}` : ''}`;
}

/** The line the code shows when it has none: why it was removed, or that none was written. */
export function codeEmptyLine(r: Pick<InterviewRecordView, 'codeRemoved'>): string {
  if (r.codeRemoved === 'request') return 'The code from this interview was removed when the candidate asked for their data to be deleted.';
  if (r.codeRemoved === 'period') return 'The code from this interview was removed at the end of its keeping period.';
  return 'No code was written in this interview.';
}

/** The one plain line the recording shows when there is no player. Null when a player shows. */
export function recordingLine(r: InterviewRecordView['recording'], media: 'none' | 'playable' | 'unreachable' | null = null): string | null {
  if (r.state === 'declined') return 'The candidate chose not to be recorded, so there is no recording of this interview.';
  if (r.state === 'deleted') return 'The recording of this interview has been deleted.';
  if (r.state === 'none') return 'There is no recording of this interview.';
  if (r.standIn) {
    const length = r.durationSeconds ? `The recording runs ${lengthOf(r.durationSeconds)}. ` : '';
    return `${length}This practice copy keeps the facts of the recording but no video, so there is nothing to play here.`;
  }
  if (media === 'none') return 'There is no recording of this interview.';
  if (media === 'unreachable') return 'The recording could not be reached just now. Try again in a moment.';
  return null;
}

/** The one plain line the transcript shows instead of its lines. Null when there are lines. */
export function transcriptLine(state: PartState): string | null {
  if (state === 'declined') return 'The candidate chose to go without a transcript, so there is none.';
  if (state === 'deleted') return 'The transcript of this interview has been deleted.';
  if (state === 'none') return 'Nothing was transcribed in this interview.';
  return null;
}

export const MARKER_LABELS: Record<MarkerKind, string> = { question: 'Question asked', 'milo-asked': 'Milo asked' };

/**
 * How far the recording's clock is ahead of the record's: the record's times count from `interview.startedAt`, a real
 * recording's from its own start. 0 when either is unknown.
 */
export function offsetMs(recordStartedAt: string | null, recordingStartedAt: string | null): number {
  const a = recordStartedAt ? Date.parse(recordStartedAt) : NaN;
  const b = recordingStartedAt ? Date.parse(recordingStartedAt) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
}

/** The last line holds until the end of the recording, or this long when the end is unknown. */
const LAST_LINE_MS = 30_000;

/** The longest gap across which one speaker's unfinished line is joined to their next. */
export const JOIN_GAP_MS = 10_000;
/** A joined line stops growing here. */
const JOIN_MAX_CHARS = 1_000;
const ENDS_SENTENCE = /[.?!…]["'”’)\]]*$/;

/**
 * One speaker's fragments joined into sentences, for reading: the live transcript stores what the provider sent, which can
 * break a sentence anywhere ("…a linked list in" / "place."). A line that does not end a sentence takes the same speaker's
 * next line when it follows within JOIN_GAP_MS; the joined line keeps the first one's seq and time. Stored lines are untouched.
 */
export function sentencesOf(lines: readonly RecordLine[]): RecordLine[] {
  const out: RecordLine[] = [];
  for (const l of lines) {
    const prev = out.at(-1);
    const text = l.text.trim();
    if (prev && prev.side === l.side && prev.speaker === l.speaker && !ENDS_SENTENCE.test(prev.text)
      && l.atMs - prev.atMs <= JOIN_GAP_MS && prev.text.length + text.length < JOIN_MAX_CHARS && text) {
      out[out.length - 1] = { ...prev, text: `${prev.text} ${text}` };
      continue;
    }
    out.push({ ...l, text });
  }
  return out;
}

/**
 * The lines as the library's segments on the player's clock (`shiftMs` from offsetMs), fragments joined (sentencesOf): each
 * runs until the next line starts, so a time inside the interview always lands on the line being said.
 */
export function segmentsOf(given: readonly RecordLine[], shiftMs = 0, endMs: number | null = null): TranscriptSegment[] {
  const lines = sentencesOf(given);
  return lines.map((l, i) => {
    const startMs = Math.max(0, l.atMs + shiftMs);
    const next = lines[i + 1];
    const until = next ? Math.max(startMs + 1, next.atMs + shiftMs) : Math.max(startMs + 1, endMs ?? startMs + LAST_LINE_MS);
    return { id: String(l.seq), startMs, endMs: until, speakerId: l.side === 'candidate' ? 'candidate' : l.speaker, speakerLabel: l.speaker, text: l.text };
  });
}

/** A moment on the player's clock that lands inside a segment, for a marker at `atMs` on the record's clock. */
export const markerTime = (m: Pick<RecordMarker, 'atMs'>, shiftMs = 0): number => Math.max(0, m.atMs + shiftMs);

/** The player's source started at `ms` (a media fragment: the player remounts there). */
export function playFrom(url: string, ms: number): string {
  const base = url.split('#')[0]!;
  return ms > 0 ? `${base}#t=${Math.floor(ms / 1000)}` : base;
}

// ── A real recording, through platform-api ───────────────────────────────────────────────────────────────────────────

export interface InterviewMedia { state: 'playable' | 'none' | 'unreachable'; url: string | null; startedAt: string | null }

/** The lobby an interview's call runs in (the middleware's lib/interviews/lobby.ts). */
export const interviewLobby = (interviewId: string): string => `interviews:interview:${interviewId}`;

/**
 * List the interview's lobby on platform-api and ask for the newest recording's playback, with the viewer's own token.
 * platform-api answers only the panel side (it asks /recording-access); a refusal reads as `none`, a failure as
 * `unreachable`. Never throws.
 */
export async function loadInterviewMedia(interviewId: string, signal: AbortSignal, opts: {
  source?: Pick<RealtimeTokenSource, 'get'>; fetchImpl?: typeof fetch; platformApiUrl?: string;
} = {}): Promise<InterviewMedia> {
  const none: InterviewMedia = { state: 'none', url: null, startedAt: null };
  try {
    const source = opts.source ?? realtimeTokenSource;
    const doFetch = opts.fetchImpl ?? fetch;
    const token = await source.get();
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    const base = realtimeEndpoints(token, { platformApiUrl: opts.platformApiUrl ?? env.VITE_PLATFORM_API_URL }).platformApiUrl;
    if (!base) return { ...none, state: 'unreachable' };
    const root = base.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${token.token}`, Accept: 'application/json' };
    const lobby = interviewLobby(interviewId);
    const list = await doFetch(`${root}/api/recordings?${new URLSearchParams({ lobbyName: lobby, limit: '10' })}`, { signal, cache: 'no-store', headers });
    if (list.status === 403 || list.status === 404) return none;
    if (!list.ok) return { ...none, state: 'unreachable' };
    const body = await list.json() as { items?: Array<{ recordingId?: unknown; lobbyName?: unknown; startedAt?: unknown }> };
    const items = (body.items ?? []).filter((r) => r.lobbyName === lobby && typeof r.recordingId === 'string')
      .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    const newest = items[0];
    if (!newest) return none;
    const play = await doFetch(`${root}/api/recordings/${encodeURIComponent(String(newest.recordingId))}/playback-token`, { method: 'POST', signal, cache: 'no-store', headers });
    if (play.status === 403 || play.status === 404) return none;
    if (!play.ok) return { ...none, state: 'unreachable' };
    const url = recordingPlaybackUrl(await play.json() as RecordingPlayback);
    const startedAt = typeof newest.startedAt === 'string' ? newest.startedAt : null;
    return url ? { state: 'playable', url, startedAt } : { state: 'none', url: null, startedAt };
  } catch {
    return signal.aborted ? none : { ...none, state: 'unreachable' };
  }
}

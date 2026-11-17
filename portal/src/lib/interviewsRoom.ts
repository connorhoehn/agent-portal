// The interview room, the panel's side (docs/interviews-tenant-plan.md row I2.4, decision 21; contracts C1, C3,
// C4, C5): names, shapes, the reads and writes the room page makes, and the small rules its footer shows
// (time left, what is off, the waiting candidate). Pure apart from the fetch helpers, so node's test runner
// reads it (lib/__tests__/interviewsRoom.test.ts).
import { INTERVIEWS_API, type RoundType } from './interviews.ts';
import type { KitCompetency, PadLanguage } from './interviewsKit.ts';
import { writeJson } from './writeJson.ts';

// ── C1: the call's lobby ────────────────────────────────────────────────────
const LOBBY_PREFIX = 'interviews:interview:';
/** The interview's call lobby (middleware lib/interviews/lobby.ts `interviewLobbyName`, the same string). */
export const interviewLobbyName = (interviewId: string): string => `${LOBBY_PREFIX}${interviewId}`;
/** The interview a lobby belongs to; null for every other lobby (an initiative's, a hangout, a breakout). */
export function interviewOfLobby(lobbyName: string | null | undefined): string | null {
  const m = /^interviews:interview:([^\s~:/?#]{1,128})$/.exec(lobbyName ?? '');
  return m ? m[1]! : null;
}
export const isInterviewLobby = (lobbyName: string | null | undefined): boolean => interviewOfLobby(lobbyName) !== null;

// ── C5: the room's read and its two writes ──────────────────────────────────
export const roomHref = (interviewId: string): string => `/interviews/rounds/${encodeURIComponent(interviewId)}/room`;
export const roomPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/room`;
export const MY_INTERVIEWS_HREF = '/interviews/my-interviews';

export type RoomState = 'assigned' | 'accepted' | 'ready' | 'live' | 'ended' | 'scored' | 'reviewed' | 'declined' | 'cancelled';
export interface RoomPerson { id: string; name: string }
export interface RoomQuestion {
  id: string;
  prompt: string;
  followUps: string[];
  competencyId: string;
  competency: string | null;
  starter: Array<{ language: PadLanguage; code: string }>;
}
export interface RoomView {
  id: string;
  lobbyName: string;
  opening: { id: string; title: string };
  candidate: { name: string };
  round: { id: string; name: string; type: RoundType; minutes: number };
  scheduledAt: string | null;
  endedAt: string | null;
  state: RoomState;
  seat: 'lead' | 'panel';
  seats: Array<{ person: RoomPerson; seat: 'lead' | 'panel' }>;
  questions: RoomQuestion[];
  competencies: KitCompetency[];
  revision: number;
}

/** The call's name on the bar: the round and who it is with. */
export const roomCallTitle = (room: Pick<RoomView, 'round' | 'candidate'>): string => `${room.round.name} with ${room.candidate.name}`;

/** The lead's join starts the interview (C5 start) while it is still accepted or ready. */
export const startsOnJoin = (room: Pick<RoomView, 'seat' | 'state'>): boolean =>
  room.seat === 'lead' && (room.state === 'accepted' || room.state === 'ready');

export type RoomWrite = { ok: true } | { ok: false; error: string; stale: boolean };

async function roomWrite(interviewId: string, what: 'start' | 'end', revision: number): Promise<RoomWrite> {
  const r = await writeJson<{ interview?: unknown }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/${what}`, 'POST', { revision });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error ?? 'That did not go through. Try again.', stale: r.status === 409 };
}
export const startInterview = (interviewId: string, revision: number): Promise<RoomWrite> => roomWrite(interviewId, 'start', revision);
export const endInterview = (interviewId: string, revision: number): Promise<RoomWrite> => roomWrite(interviewId, 'end', revision);

// ── Time left (decision 21: the footer's own element) ──────────────────────
/**
 * The interview runs from its set time (or, with none, from when the call started) for the round's length.
 * Plain words: "12 min left", "Over by 3 min", "Starts in 5 min". Null without a start.
 */
export function timeLeftLabel(startMs: number | null, minutes: number, nowMs: number): string | null {
  if (startMs === null || !Number.isFinite(startMs) || minutes <= 0) return null;
  const MIN = 60_000;
  if (nowMs < startMs) return `Starts in ${Math.max(1, Math.ceil((startMs - nowMs) / MIN))} min`;
  const left = startMs + minutes * MIN - nowMs;
  if (left >= 0) return `${Math.max(1, Math.ceil(left / MIN))} min left`;
  return `Over by ${Math.max(1, Math.floor(-left / MIN))} min`;
}

/** Where the time left counts from: the set time, else the call's start. */
export function roomStartMs(scheduledAt: string | null, callStartedAt: number | string | null | undefined): number | null {
  const set = scheduledAt ? Date.parse(scheduledAt) : NaN;
  if (Number.isFinite(set)) return set;
  if (typeof callStartedAt === 'number' && Number.isFinite(callStartedAt)) return callStartedAt;
  const started = typeof callStartedAt === 'string' ? Date.parse(callStartedAt) : NaN;
  return Number.isFinite(started) ? started : null;
}

/** "Over by" reads as a warning in the footer. */
export const timeLeftTone = (label: string | null): 'secondary' | 'warning' => (label?.startsWith('Over') ? 'warning' : 'secondary');

// ── C3: the waiting candidate (SEAT builds the routes) ──────────────────────
export interface Admission {
  state: 'not-knocked' | 'waiting' | 'admitted' | 'turned-away';
  knockedAt: string | null;
  decidedAt: string | null;
}
export const waitingPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/waiting`;
/** How often the lead's room asks whether the candidate is waiting. */
export const WAITING_POLL_MS = 5_000;

/** The lead asks while the room is open and the candidate is not yet in; a panel member never does. */
export const pollsWaiting = (seat: 'lead' | 'panel' | null, admission: Admission | null, state: RoomState | null): boolean =>
  seat === 'lead' && admission?.state !== 'admitted' && state !== null && ['accepted', 'ready', 'live'].includes(state);

/**
 * One read of C3's waiting route. Not found (SEAT's routes absent, or nothing to admit) and any failure read
 * as "nobody waiting": the room never shows an error for it.
 */
export async function readAdmission(interviewId: string, fetcher: typeof fetch = fetch): Promise<Admission | null> {
  try {
    const res = await fetcher(waitingPath(interviewId), { credentials: 'include' });
    if (!res.ok) return null;
    const body = (await res.json()) as { admission?: Admission };
    return body.admission ?? null;
  } catch {
    return null;
  }
}

export async function answerKnock(interviewId: string, admit: boolean): Promise<RoomWrite> {
  const r = await writeJson<{ admission?: Admission }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/admit`, 'POST', { admit });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error ?? 'That did not go through. Try again.', stale: r.status === 409 };
}

/** The prompt's id: one per knock, so a candidate who knocks again is asked about again. */
export const knockPromptId = (interviewId: string, admission: Admission): string => `interview-knock:${interviewId}:${admission.knockedAt ?? 'now'}`;

// ── C4: what the candidate turned off (CONSENT builds the route) ────────────
export type ConsentPart = 'recording' | 'transcription' | 'milo';
export const consentsPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/consents`;
const PART_WORDS: Record<ConsentPart, string> = { recording: 'Recording', transcription: 'Transcription', milo: 'Milo' };

/** One quiet line for the lead: "Recording is off for this interview". Null when nothing is off. */
export function consentOffLine(off: readonly ConsentPart[] | null | undefined): string | null {
  const parts = [...new Set(off ?? [])].filter((p): p is ConsentPart => p in PART_WORDS);
  if (!parts.length) return null;
  const words = parts.map((p, i) => (i === 0 ? PART_WORDS[p] : PART_WORDS[p] === 'Milo' ? 'Milo' : PART_WORDS[p].toLowerCase()));
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `${list} ${words.length === 1 ? 'is' : 'are'} off for this interview`;
}

/** The pad's language as the library's read-only code block names it; the rest are plain text. */
export const codeBlockLanguage = (language: PadLanguage): 'ts' | 'js' | 'text' =>
  language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : 'text';

// ── D7: Milo's suggestion for the lead (COACH builds the routes; decisions 8, 20 and 21) ──
export type SuggestionAnswerId = 'ask' | 'milo-ask' | 'skip';
export interface SuggestionView {
  id: string;
  text: string;
  competency: { id: string; name: string };
  basedOn: string | null;
  shownAt: string;
}
export interface SuggestionRead { suggestion: SuggestionView | null; paused: 'budget' | null; retryAfterMs: number }
const SUGGESTION_RETRY_DEFAULT = 30_000;
export const NO_SUGGESTION: SuggestionRead = { suggestion: null, paused: null, retryAfterMs: SUGGESTION_RETRY_DEFAULT };
/** The wait between reads is the server's, held between 10 seconds and 2 minutes. */
export const SUGGESTION_MIN_WAIT_MS = 10_000;
export const SUGGESTION_MAX_WAIT_MS = 120_000;

export const suggestionPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/suggestion`;
const suggestionAnswerPath = (interviewId: string, suggestionId: string): string =>
  `${suggestionPath(interviewId)}/${encodeURIComponent(suggestionId)}/answer`;

export function suggestionWaitMs(retryAfterMs: number | null | undefined): number {
  const n = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : SUGGESTION_RETRY_DEFAULT;
  return Math.min(SUGGESTION_MAX_WAIT_MS, Math.max(SUGGESTION_MIN_WAIT_MS, n));
}

/** How long the room keeps reading: the round's length plus half an hour. */
export const suggestionReadBudgetMs = (roundMinutes: number): number => (Math.max(0, roundMinutes) + 30) * 60_000;

/**
 * The room asks only for the lead (a panel member never gets a suggestion, decision 20), while the interview is
 * live, once the lead has joined the call, and not while one is already waiting in the deck.
 */
export const pollsSuggestion = (
  seat: 'lead' | 'panel' | null, state: RoomState | null, joined: boolean, waiting: SuggestionView | null,
): boolean => seat === 'lead' && state === 'live' && joined && !waiting;

/** One read. Not found (not the lead, or no route) and any failure read as no suggestion. */
export async function readSuggestion(interviewId: string, fetcher: typeof fetch = fetch): Promise<SuggestionRead> {
  try {
    const res = await fetcher(suggestionPath(interviewId), { credentials: 'include' });
    if (!res.ok) return NO_SUGGESTION;
    const body = (await res.json()) as Partial<SuggestionRead>;
    const s = body.suggestion;
    const valid = !!s && typeof s.id === 'string' && typeof s.text === 'string' && !!s.competency && typeof s.competency.name === 'string';
    return {
      suggestion: valid ? { id: s.id, text: s.text, competency: s.competency, basedOn: s.basedOn ?? null, shownAt: s.shownAt ?? '' } : null,
      paused: body.paused === 'budget' ? 'budget' : null,
      retryAfterMs: suggestionWaitMs(body.retryAfterMs),
    };
  } catch {
    return NO_SUGGESTION;
  }
}

/** The answer; `gone` is a 409 (answered elsewhere, or the interview ended): the prompt clears quietly. */
export async function answerSuggestion(
  interviewId: string, suggestionId: string, answer: SuggestionAnswerId,
): Promise<{ ok: true } | { ok: false; gone: boolean; error: string }> {
  const r = await writeJson<{ suggestion?: null }>(suggestionAnswerPath(interviewId, suggestionId), 'POST', { answer });
  if (r.ok) return { ok: true };
  return { ok: false, gone: r.status === 409, error: r.error ?? 'That did not go through. Try again.' };
}

/** One prompt per suggestion. */
export const suggestionPromptId = (interviewId: string, suggestionId: string): string => `interview-suggestion:${interviewId}:${suggestionId}`;

/** What the receipt says; Milo's words are posted to the call chat, not spoken. */
export const SUGGESTION_RECEIPTS: Record<SuggestionAnswerId, string> = {
  ask: 'You will ask it', 'milo-ask': 'Sent to the call chat', skip: 'Skipped',
};

/** The one quiet line when the budget has paused suggestions: the lead's only. */
export const SUGGESTIONS_PAUSED_LINE = 'Milo’s suggestions are paused: this interview has reached its budget.';
export const pausedLine = (seat: 'lead' | 'panel' | null, paused: 'budget' | null | undefined): string | null =>
  seat === 'lead' && paused === 'budget' ? SUGGESTIONS_PAUSED_LINE : null;

/** The consents line is for any seat on the interview (decision 5). */
export const readsConsents = (seat: 'lead' | 'panel' | null, open: boolean): boolean => seat !== null && open;

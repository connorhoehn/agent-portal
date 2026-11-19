// The interview room, the panel's side (docs/interviews-tenant-plan.md row I2.4, decision 21; contracts C1, C3,
// C4, C5): names, shapes, the reads and writes the room page makes, and the small rules its footer shows
// (time left, what is off, the waiting candidate). Pure apart from the fetch helpers, so node's test runner
// reads it (lib/__tests__/interviewsRoom.test.ts).
import { INTERVIEWS_API, type RoundType } from './interviews.ts';
import type { KitCompetency, PadLanguage } from './interviewsKit.ts';
import { writeJson } from './writeJson.ts';
import type { KitBoard, RoundSurface } from './interviewsBoard.ts';

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
/** The interview whose call this viewer is in now (the shell's call is that interview's lobby and they have joined it); else null. */
export const joinedInterviewOf = (lobbyName: string | null | undefined, joined: boolean): string | null => (joined ? interviewOfLobby(lobbyName) : null);
/**
 * A live round's way into its room: "Join" when the viewer is not in its call yet, "Back to the call" when they are (the call
 * docks in the footer when they leave the room page). Both open the room; neither joins a second time.
 */
export const roomEntryLabel = (interviewId: string, joinedId: string | null): 'Join' | 'Back to the call' => (joinedId === interviewId ? 'Back to the call' : 'Join');

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
  /** A board round question's starting board (WHITEBOARD-PLAN step 2). */
  board?: KitBoard;
}
export interface RoomView {
  id: string;
  lobbyName: string;
  opening: { id: string; title: string };
  candidate: { name: string };
  /** `surface`: the code pad or the whiteboard (lib/interviewsBoard.ts surfaceOf); missing from an older server. */
  round: { id: string; name: string; type: RoundType; minutes: number; surface?: RoundSurface | null };
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
/** How often the lead's room asks whether the candidate is waiting (the consents read keeps this pace too). */
export const WAITING_POLL_MS = 5_000;
/** The slow fallback under the live hint: a knock or an end reaches the page as an event (middleware lib/interviews/live-hint.ts). */
export const WAITING_FALLBACK_MS = 15_000;

// The room's live hints: the server publishes them on the interview's lobby name; both sides read the activity feed.
export const INTERVIEW_HINT_KNOCK = 'interview.knock';
export const INTERVIEW_HINT_ENDED = 'interview.ended';
/**
 * What the feed says since the reader last looked: whether this interview was knocked on or ended, and where to resume.
 * A hint carries no state; the page reads again and the read decides.
 */
export function hintsAfter(events: ReadonlyArray<{ eventType: string; detail?: Record<string, unknown> }>, seen: number, interviewId: string): { next: number; knock: boolean; ended: boolean } {
  const from = seen > events.length ? events.length : Math.max(0, seen);
  let knock = false; let ended = false;
  for (const e of events.slice(from)) {
    if (e.detail?.['interviewId'] !== interviewId) continue;
    if (e.eventType === INTERVIEW_HINT_KNOCK) knock = true;
    else if (e.eventType === INTERVIEW_HINT_ENDED) ended = true;
  }
  return { next: events.length, knock, ended };
}

/** The lead asks while the room is open and the candidate is not yet in; a panel member never does. */
export const pollsWaiting = (seat: 'lead' | 'panel' | null, admission: Admission | null, state: RoomState | null): boolean =>
  seat !== null && admission?.state !== 'admitted' && state !== null && ['accepted', 'ready', 'live'].includes(state);

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

const OFF_FACT_WORDS: Record<ConsentPart, string> = { recording: 'recording', transcription: 'transcript', milo: 'Milo' };
const OFF_FACT_ORDER: readonly ConsentPart[] = ['recording', 'transcription', 'milo'];

/** The idle room's fact (E4 #37): what is off, in a fixed order, "recording, transcript, Milo"; null when nothing is off. */
export function offForFact(off: readonly ConsentPart[] | null | undefined): string | null {
  const set = new Set(off ?? []);
  const words = OFF_FACT_ORDER.filter((p) => set.has(p)).map((p) => OFF_FACT_WORDS[p]);
  return words.length ? words.join(', ') : null;
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
/** Why Milo's suggestions are paused: the interview's budget, or the model failing several times in a row. */
export type SuggestionPause = 'budget' | 'model';
export interface SuggestionRead { suggestion: SuggestionView | null; paused: SuggestionPause | null; retryAfterMs: number }
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

/** The suggestion the footer turns into a prompt: only the lead's registration gets one. */
export const suggestionForPrompt = (lead: boolean, suggestion: SuggestionView | null): SuggestionView | null => (lead ? suggestion : null);

/**
 * The poll loop behind the room's suggestion read: reads on the server's wait, stops at the deadline or once a
 * suggestion arrives, and the returned function stops it for good (clears the pending timer).
 */
export function startSuggestionPoll(opts: {
  read(): Promise<SuggestionRead>;
  onRead(out: SuggestionRead): void;
  now(): number;
  deadline: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}): () => void {
  let live = true;
  let timer: unknown;
  const read = async () => {
    if (!live || opts.now() > opts.deadline) return;
    const out = await opts.read();
    if (!live) return;
    opts.onRead(out);
    if (out.suggestion) return;
    timer = opts.setTimer(() => { void read(); }, out.retryAfterMs);
  };
  void read();
  return () => { live = false; opts.clearTimer(timer); };
}

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
      paused: body.paused === 'budget' || body.paused === 'model' ? body.paused : null,
      retryAfterMs: suggestionWaitMs(body.retryAfterMs),
    };
  } catch {
    return NO_SUGGESTION;
  }
}

/** The answer; `gone` is a 409 (answered elsewhere, or the interview ended): the prompt clears quietly. */
export async function answerSuggestion(
  interviewId: string, suggestionId: string, answer: SuggestionAnswerId,
): Promise<{ ok: true; said?: MiloAsked; why?: MiloAskWhy; line?: string } | { ok: false; gone: boolean; error: string }> {
  const r = await writeJson<{ suggestion?: null; said?: unknown; line?: unknown }>(suggestionAnswerPath(interviewId, suggestionId), 'POST', { answer });
  // Row I3.5: after "Have Milo ask", whether Milo said it aloud, posted it in the chat only, or neither, and why.
  if (r.ok) return { ok: true, ...saidOf(r.data) };
  return { ok: false, gone: r.status === 409, error: r.error ?? 'That did not go through. Try again.' };
}

/**
 * Esc on the deck while a suggestion shows is a Skip (decision W2P, finding I3.4b): the server lets it go, so the page's read
 * starts again and Milo's next suggestion comes. Hiding it alone left it waiting on the server, which shows the same one again
 * and never a new one, and the read had stopped. Returns the suggestion to skip, once (`skipped`: the one already sent).
 */
export const escSkipsSuggestion = (collapsed: boolean, suggestionId: string | null, skipped: string | null): string | null =>
  collapsed && suggestionId !== null && suggestionId !== skipped ? suggestionId : null;

/** One prompt per suggestion. */
export const suggestionPromptId = (interviewId: string, suggestionId: string): string => `interview-suggestion:${interviewId}:${suggestionId}`;

/** What the receipt says. "Have Milo ask" has none fixed: it says what the server did with the words (miloAskReceipt). */
export const SUGGESTION_RECEIPTS: Record<Exclude<SuggestionAnswerId, 'milo-ask'>, string> = {
  ask: 'You will ask it', skip: 'Skipped',
};

/** The one quiet line when the budget has paused suggestions: the lead's only. */
export const SUGGESTIONS_PAUSED_LINE = 'Milo’s suggestions are paused: this interview has reached its budget.';
export const SUGGESTIONS_MODEL_PAUSED_LINE = 'Milo’s suggestions are paused: the model has not answered the last few times. Milo will try again on its own.';
export const pausedLine = (seat: 'lead' | 'panel' | null, paused: SuggestionPause | null | undefined): string | null =>
  seat !== 'lead' ? null : paused === 'budget' ? SUGGESTIONS_PAUSED_LINE : paused === 'model' ? SUGGESTIONS_MODEL_PAUSED_LINE : null;

/** The consents line is for any seat on the interview (decision 5). */
export const readsConsents = (seat: 'lead' | 'panel' | null, open: boolean): boolean => seat !== null && open;
/**
 * The open room reads the candidate's answers again (every WAITING_POLL_MS, bounded by the page) until they exist, so the lead's
 * bar and Invite follow the candidate's answers without a reload (finding I3.4j). Once answered they do not change in the room.
 */
export const pollsConsents = (seat: 'lead' | 'panel' | null, open: boolean, consents: { answered: boolean } | null | undefined): boolean =>
  readsConsents(seat, open) && consents?.answered !== true;

// ── E5: Milo for you and the live transcript (MILO-FOR-YOU; rows I3.6, I3.7; decisions 4, 6, 20, 21) ──
// All three live in the room's one right pane. The panel (every seat) reads the notes and the transcript; only the
// lead asks Milo privately. The candidate's room imports none of this.
export interface LiveTranscriptLine { seq: number; at: string; side: 'candidate' | 'panel'; speaker: string; text: string }
export interface LiveTranscriptRead { state: 'on' | 'off'; off: string | null; lines: LiveTranscriptLine[]; lastSeq: number }
export interface MiloAskedItem { text: string; questionId: string | null; by: 'panel' | 'milo' }
export interface MiloCompetencyNotes { id: string; name: string; asked: MiloAskedItem[]; toAsk: Array<{ questionId: string; text: string }> }
export interface MiloTimeCheck { startedAt: string | null; minutesIn: number | null; minutes: number; minutesLeft: number | null; line: string }
export interface MiloNotes { competencies: MiloCompetencyNotes[]; time: MiloTimeCheck }
export interface MiloAskSource { seq: number; quote: string; speaker: string; at: string }
export interface MiloAnswer { id: string; question: string; text: string; sources: MiloAskSource[]; askedAt: string }
export interface MiloAskBody {
  answer: MiloAnswer | null;
  refused: string | null;
  /** The one plain line to show when there is no answer. */
  line: string | null;
  paused: 'budget' | null;
  retryAfterMs: number | null;
}

const miloBase = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}`;
export const transcriptPath = (interviewId: string, after = 0): string => `${miloBase(interviewId)}/transcript${after > 0 ? `?after=${after}` : ''}`;
export const miloNotesPath = (interviewId: string): string => `${miloBase(interviewId)}/milo-notes`;
export const miloAskPath = (interviewId: string): string => `${miloBase(interviewId)}/milo-ask`;

/** How often the pane reads the transcript and the notes while the interview is live. */
export const TRANSCRIPT_POLL_MS = 5_000;
export const MILO_NOTES_POLL_MS = 30_000;
/** The exchanges the lead keeps in the pane (the newest first; older ones fold away). */
export const MILO_ASK_KEPT = 5;
export const MILO_QUESTION_MAX = 300;

/** The pane reads Milo's parts only while the interview is live (the reads answer not-found otherwise). */
export const pollsMilo = (seat: 'lead' | 'panel' | null, state: RoomState | null): boolean => seat !== null && state === 'live';
/** The private question is the lead's alone (decision 20). */
export const asksMilo = (seat: 'lead' | 'panel' | null, state: RoomState | null): boolean => seat === 'lead' && state === 'live';
/** In a technical round the coding questions lead, so the transcript starts folded. */
export const transcriptOpenByDefault = (roundType: RoundType): boolean => roundType !== 'technical';

/** One transcript read; not found and any failure read as "no news" (null), so the pane keeps what it has. */
export async function readLiveTranscript(interviewId: string, after: number, fetcher: typeof fetch = fetch): Promise<LiveTranscriptRead | null> {
  try {
    const res = await fetcher(transcriptPath(interviewId, after), { credentials: 'include' });
    if (!res.ok) return null;
    const t = ((await res.json()) as { transcript?: Partial<LiveTranscriptRead> }).transcript;
    if (!t || (t.state !== 'on' && t.state !== 'off')) return null;
    return { state: t.state, off: typeof t.off === 'string' ? t.off : null, lines: Array.isArray(t.lines) ? t.lines : [], lastSeq: typeof t.lastSeq === 'number' ? t.lastSeq : after };
  } catch {
    return null;
  }
}

/** One notes read; null on not found or any failure. */
export async function readMiloNotes(interviewId: string, fetcher: typeof fetch = fetch): Promise<MiloNotes | null> {
  try {
    const res = await fetcher(miloNotesPath(interviewId), { credentials: 'include' });
    if (!res.ok) return null;
    const n = ((await res.json()) as { notes?: MiloNotes }).notes;
    return n && Array.isArray(n.competencies) && n.time ? n : null;
  } catch {
    return null;
  }
}

/** The lead's private question. A refusal or a pause is an answer with a line, not an error. */
export async function askMilo(interviewId: string, question: string): Promise<{ ok: true; body: MiloAskBody } | { ok: false; error: string }> {
  const r = await writeJson<MiloAskBody>(miloAskPath(interviewId), 'POST', { question });
  if (r.ok && r.data) return { ok: true, body: r.data };
  if (r.status === 409 && r.data && typeof r.data.line === 'string') return { ok: true, body: r.data };
  return { ok: false, error: r.error ?? 'That did not go through. Try again.' };
}

/** New lines appended after the ones held, once each, in order. */
export function mergeTranscript(held: readonly LiveTranscriptLine[], next: readonly LiveTranscriptLine[]): LiveTranscriptLine[] {
  const seen = new Set(held.map((l) => l.seq));
  const add = next.filter((l) => !seen.has(l.seq));
  return add.length ? [...held, ...add].sort((a, b) => a.seq - b.seq) : [...held];
}

/** The library transcript's segments: times from the first line, the speaker's name, the stored line's seq as the key. */
export function liveTranscriptSegments(lines: readonly LiveTranscriptLine[]): Array<{ id: string; startMs: number; endMs: number; speakerId: string; speakerLabel: string; text: string }> {
  const first = lines.length ? Date.parse(lines[0]!.at) : 0;
  return lines.map((l, i) => {
    const start = Math.max(0, (Date.parse(l.at) || first) - first);
    const nextAt = lines[i + 1] ? Date.parse(lines[i + 1]!.at) - first : start;
    return { id: String(l.seq), startMs: start, endMs: Math.max(start, nextAt), speakerId: l.side === 'candidate' ? 'candidate' : l.speaker, speakerLabel: l.speaker, text: l.text };
  });
}

/** What the pane says when there is no answer: the server's line, or the budget's. */
export const MILO_ASK_PAUSED_LINE = 'Milo’s answers are paused: this interview has reached its budget.';
export const askLineOf = (body: MiloAskBody): string | null => (body.answer ? null : body.paused === 'budget' ? MILO_ASK_PAUSED_LINE : body.line);

/** One kept exchange: the question, and Milo's answer or its one line. */
export interface MiloExchange { key: string; question: string; answer: MiloAnswer | null; line: string | null }
export function keepExchange(kept: readonly MiloExchange[], question: string, body: MiloAskBody, key: string): MiloExchange[] {
  return [{ key, question, answer: body.answer, line: askLineOf(body) }, ...kept].slice(0, MILO_ASK_KEPT);
}

/** "Asked by Milo" for what Milo put in the call chat; nothing for what the panel asked itself. */
export const askedByLabel = (by: MiloAskedItem['by']): string | null => (by === 'milo' ? 'Milo asked it' : null);

// ── The room as decision 21 draws it (UI round 1, lane ROOM; contracts U1, U6) ──────────────────────────────

/** The one pane's tabs (U1), in order: a technical round leads with the pad, a behavioural one with the plan. */
export type RoomTabId = 'pad' | 'questions' | 'plan' | 'milo' | 'chat';
const TAB_LABELS: Record<RoomTabId, string> = { pad: 'Pad', questions: 'Questions', plan: 'Plan', milo: 'Milo', chat: 'Chat' };
export function roomTabIds(type: RoundType): RoomTabId[] {
  return type === 'technical' ? ['pad', 'questions', 'milo', 'chat'] : ['plan', 'milo', 'chat'];
}
/** The tab row; a board round's `pad` tab holds the whiteboard and says so (WHITEBOARD-PLAN step 1). */
export const roomTabs = (type: RoundType, surface?: RoundSurface | null): Array<{ id: RoomTabId; label: string }> =>
  roomTabIds(type).map((id) => ({ id, label: id === 'pad' && surface === 'board' ? 'Board' : TAB_LABELS[id] }));
export const defaultRoomTab = (type: RoundType): RoomTabId => (type === 'technical' ? 'pad' : 'plan');
/** The footer's Message opens the pane on its chat tab (never a second pane). */
export const ROOM_MESSAGE_TAB: RoomTabId = 'chat';
/** A tab id from the library's tab row, kept to this round's tabs (anything else keeps the current one). */
export function roomTabOf(type: RoundType, id: string, current: RoomTabId): RoomTabId {
  return (roomTabIds(type) as string[]).includes(id) ? (id as RoomTabId) : current;
}
/** The pane's floor and ceiling (U1, decision 21): code needs room; Milo's context stays narrow. */
export const ROOM_PANE_FLOOR = { technical: { min: 560, max: 760 }, behavioural: { min: 360, max: 460 } } as const;
/** The shell's split rounds the page's share to a tenth of a percent, which can take up to 0.05% of the window
 *  (under 1 px at 1440) off the pane: the pane asks for this much more so its column never lands under the floor. */
export const ROOM_PANE_ROUNDING_PX = 2;
/** The width the room asks the shell for: the floor plus the rounding margin, the same ceiling. */
export const roomPaneWidth = (type: RoundType): { min: number; max: number } => {
  const { min, max } = ROOM_PANE_FLOOR[type === 'technical' ? 'technical' : 'behavioural'];
  return { min: min + ROOM_PANE_ROUNDING_PX, max };
};

/** The round's crumb (U6): "Mateo Álvarez, System design". */
export const roundCrumbLabel = (room: Pick<RoomView, 'round' | 'candidate'>): string => `${room.candidate.name}, ${room.round.name}`;

/**
 * The footer's time while the call is on: counted from the call's start (the join), never from the set time, so a
 * call held early never reads "Starts in 1525 min". Before the start is known it says the round's length; once it is known
 * the label is time left, also when the start reads a moment later than the page's clock.
 */
export function callTimeLabel(callStartedAt: number | string | null | undefined, minutes: number, nowMs: number): string | null {
  if (minutes <= 0) return null;
  const start = roomStartMs(null, callStartedAt);
  if (start === null) return `${minutes} min round`;
  // A start a moment ahead of this page's clock (the clock ticks every few seconds, or skews) is the start: the call is on.
  return timeLeftLabel(start, minutes, Math.max(nowMs, start));
}

/**
 * The consent chip in the footer: a short label and the full sentence as its tooltip. Null shows nothing.
 *
 * Every combination the staff read can carry (`answered`, and the parts off: the server writes Milo off whenever the
 * transcript is declined, lib/interviews/consent/rules.ts). The label says what is off in a few words; the tooltip says
 * what the candidate answered and what that means for the call, in plain sentences. "Not answered yet" is never a
 * refusal: nothing is off by the candidate's choice until they answer. A required part declined holds the candidate on
 * their own page before they can knock (the held page's business); the chip only reports the answers as given.
 */
export interface ConsentChip { label: string; tooltip: string; tone: 'neutral' | 'warning' }
export const NOT_ANSWERED_LINE = 'The candidate has not answered yet';
const NOT_ANSWERED_TOOLTIP = `${NOT_ANSWERED_LINE}. Until they do, nothing is recorded or transcribed and Milo cannot join the call.`;
export function consentChip(consents: { answered: boolean; off: readonly ConsentPart[] } | null | undefined): ConsentChip | null {
  if (!consents) return null;
  if (!consents.answered) return { label: 'Not answered yet', tooltip: NOT_ANSWERED_TOOLTIP, tone: 'neutral' };
  const off = new Set(consents.off.filter((p) => p in PART_WORDS));
  const recording = off.has('recording');
  const transcript = off.has('transcription');
  const milo = transcript || off.has('milo');
  if (!recording && !milo) return null;
  const label = recording && transcript ? 'No recording, transcript or Milo'
    : recording && milo ? 'Recording and Milo off'
      : recording ? 'Recording off'
        : transcript ? 'No transcript or Milo'
          : 'Milo off';
  const sentences = [
    recording ? 'The candidate said no to recording, so the call is not recorded.' : null,
    transcript ? 'The candidate said no to the transcript, so nothing is transcribed and Milo cannot join the call.'
      : milo ? 'The candidate said no to Milo, so Milo makes no suggestions in this call.' : null,
  ].filter(Boolean);
  return { label, tooltip: sentences.join(' '), tone: 'warning' };
}

/**
 * Why the lead may not invite Milo, from the candidate's answers (lib/interviews/consent/effects.ts `miloMayBeInvited`:
 * the transcript answer alone, and nothing before an answer). Null: Invite is offered as in a work call. With the
 * transcript accepted and Milo declined, Milo may still join to keep the transcript, so Invite stays.
 */
export function miloInviteBlock(consents: { answered: boolean; off: readonly ConsentPart[] } | null | undefined): { label: string; tooltip: string } | null {
  if (!consents) return null;
  if (!consents.answered) return { label: 'Milo waits for answers', tooltip: 'Milo can join once the candidate has answered the recording and transcript questions.' };
  if (consents.off.includes('transcription')) return { label: 'Milo is off', tooltip: 'The candidate said no to the transcript, so Milo cannot join this call.' };
  return null;
}

/** The candidate's id in the call (middleware lib/interviews/invite/realtime.ts `guestSubject`: "guest:<invite>"). */
export const isGuestUserId = (userId: string): boolean => userId.startsWith('guest:');

type CallName = { displayName: string; avatarUrl?: string } | null | undefined;
/**
 * The panel's names for the call's tiles: the call knows the candidate only by the invite's id, which a person must never
 * read, so the room names it with the candidate's name. Everyone else is the shell's directory, unchanged.
 */
export function staffRoomNameFor(base: (userId: string) => CallName, candidateName: string): (userId: string) => CallName {
  return (userId) => (isGuestUserId(userId) ? { displayName: candidateName.trim() || 'Candidate' } : base(userId));
}

/**
 * The candidate's names for the call's tiles (E4 #32: the lead's name, and nobody else's, everywhere on the candidate's
 * side). The guest's read names only the lead; the room's read (D1) says which call id is the lead's. So: the candidate
 * is "Candidate" to themselves (the tile says "You"); the lead's id carries the lead's name; every other staff id reads
 * "Interviewer". Without the lead's id (an older server) a call with no other interviewer names every staff id as the
 * lead. Never an id.
 */
export function guestRoomNameFor(selfId: string, panel: { lead: string | null; others: number } | null | undefined, leadCallId?: string | null): (userId: string) => CallName {
  const lead = panel?.lead?.trim() || null;
  const alone = !!panel && !(panel.others > 0);
  return (userId) => {
    if (userId === selfId) return { displayName: 'Candidate' };
    if (userId.startsWith('agent:')) return null;
    const isLead = leadCallId ? userId === leadCallId : alone;
    return { displayName: isLead && lead ? lead : 'Interviewer' };
  };
}

/** Before the call: who sits on the panel, the lead first ("Hugo Marchetti (lead), Wen Zhao"). */
export function panelLine(seats: RoomView['seats']): string {
  const ordered = [...seats].sort((a, b) => (a.seat === b.seat ? 0 : a.seat === 'lead' ? -1 : 1));
  return ordered.map((s) => (s.seat === 'lead' ? `${s.person.name} (lead)` : s.person.name)).join(', ') || 'Nobody is seated yet';
}

/**
 * Before the call: whether the candidate is here, for any seat (the waiting read answers every seat; only the lead
 * may let them in, so a panel member reads who does). Null when the room does not know yet.
 */
export function candidateLine(admission: Admission | null, seat: 'lead' | 'panel' = 'lead'): string | null {
  if (!admission) return null;
  if (admission.state === 'waiting') return seat === 'lead' ? 'Waiting to be let in' : 'Waiting for the lead to let them in';
  if (admission.state === 'admitted') return 'Let in';
  if (admission.state === 'turned-away') return 'Asked to wait';
  return 'Not here yet';
}

// ── Milo asks aloud (rows I3.5, I3.8; decisions 9, 11; contract U10) ─────────────────────────────────────────────────
/** How Milo's approved words went: aloud (and in the call chat), or in the call chat only. */
export type MiloSaid = 'spoken' | 'chat';
/** "Have Milo ask" on a suggestion can also end with nothing posted (`none`). */
export type MiloAsked = MiloSaid | 'none';
/**
 * Why the words were not said aloud (the server's speak/index.ts NotAloudWhy): Milo's voice is off, Milo is paused, the
 * interview's budget refused the speech, Milo did not get to say it in time, Milo is not in the call, or anything else.
 */
export type MiloAskWhy = 'voice-off' | 'paused' | 'budget' | 'not-heard' | 'not-in-call' | 'not-said';
const ASK_WHYS: readonly MiloAskWhy[] = ['voice-off', 'paused', 'budget', 'not-heard', 'not-in-call', 'not-said'];

/** `said`, `why` and `line` read off an answer body; nothing for anything else. */
export function saidOf(body: unknown): { said?: MiloAsked; why?: MiloAskWhy; line?: string } {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const said = b['said'] === 'spoken' || b['said'] === 'chat' || b['said'] === 'none' ? b['said'] : undefined;
  const why = ASK_WHYS.find((w) => w === b['why']);
  const line = typeof b['line'] === 'string' && b['line'].trim() ? b['line'].slice(0, 300) : undefined;
  return { ...(said ? { said } : {}), ...(why ? { why } : {}), ...(line ? { line } : {}) };
}

/** The reason in the receipt's words. */
const NOT_ALOUD: Record<MiloAskWhy, string> = {
  'voice-off': 'Milo’s voice is off',
  paused: 'Milo is paused',
  budget: 'this interview’s budget does not cover Milo speaking',
  'not-heard': 'Milo could not say it in time',
  'not-in-call': 'Milo is not in the call',
  'not-said': 'Milo could not say it aloud',
};

/**
 * The prompt's receipt after "Have Milo ask": what happened and, short of aloud, why, in a few words (the full sentence is the
 * chat's or the line's). It says the words are in the chat only when the server says it posted them.
 */
export function miloAskReceipt(said: MiloAsked | undefined, why?: MiloAskWhy): string {
  if (said === 'spoken') return 'Milo asked it aloud';
  if (said === 'chat') return `Milo posted the question in the chat (${NOT_ALOUD[why ?? 'not-said']})`;
  if (said === 'none') return why === 'not-in-call' ? 'Not sent: Milo is not in the call. Ask it yourself' : 'Not sent: Milo could not post it. Ask it yourself';
  return 'Milo did not say whether it was sent. Check the call chat';
}

export const sayPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/say`;

/** "Have Milo ask" on a kit question: the server reads the words from the kit, posts them and says them. */
export async function sayQuestion(interviewId: string, questionId: string): Promise<{ ok: true; said: MiloSaid; line: string } | { ok: false; error: string }> {
  const r = await writeJson<{ said?: unknown; line?: unknown }>(sayPath(interviewId), 'POST', { questionId });
  if (!r.ok) return { ok: false, error: r.error ?? 'That did not go through. Try again.' };
  const { said, line } = saidOf(r.data);
  if (said === 'none') return { ok: false, error: line ?? 'Milo is not in the call.' };
  return { ok: true, said: said ?? 'chat', line: line ?? 'The question is in the call chat.' };
}

/**
 * A kit question to put in the pad once it is in sync (decision 11: "Have Milo ask" on a coding question also inserts it). The
 * Questions tab queues it and opens the Pad tab; the lead's pad takes it when its editor is in sync (pad/InterviewPad.tsx).
 */
type PendingQuestion = { id: string; prompt: string; starter: ReadonlyArray<{ language: string; code: string }> };
const pendingPad = new Map<string, PendingQuestion>();
const padListeners = new Set<() => void>();
export function queuePadQuestion(interviewId: string, q: PendingQuestion): void { pendingPad.set(interviewId, q); for (const l of padListeners) l(); }
/** The queued question for this interview, once: taking it clears it. */
export function takePadQuestion(interviewId: string): PendingQuestion | null { const q = pendingPad.get(interviewId) ?? null; pendingPad.delete(interviewId); return q; }
/** Called when a question is queued; returns the unsubscribe. */
export function onPadQuestion(fn: () => void): () => void { padListeners.add(fn); return () => { padListeners.delete(fn); }; }

/**
 * Milo's answers to the candidate's two requests and its fixed sentence (middleware lib/interviews/speak/index.ts writes these
 * exact forms; keep the two in step). A guest reads Milo's lines with none of the assistant's keys (contract E9), so the candidate's
 * page tells an answer from a question by its words.
 */
const MILO_ANSWER_LINES = [
  /^About \d+ minutes? (?:are|is) left in this round\.$/,
  /^This round is \d+ minutes long\.$/,
  /^This round is at the end of its time\.$/,
  /^Milo has not asked a question yet\.$/,
  /^I can repeat the question or tell you how much time is left\./,
];
export const isMiloAnswerLine = (text: string): boolean => MILO_ANSWER_LINES.some((re) => re.test(text.trim()));

/** Milo's fixed chat identity (middleware lib/meeting-assistant/chat-types.ts ASSISTANT_USER_ID). */
export const MILO_USER_ID = 'agent:meeting-assistant';

/**
 * The candidate's room (contract U9): the question Milo last asked, read from the call chat's frames on the socket the page already
 * holds. The server lets a guest read only Milo's approved lines (lib/call-chat.ts `guestMaySee`), as plain lines under Milo's
 * name; of those, the answers to the candidate's requests are left out. Returns the newer question, or `current` when none.
 */
/** Milo's latest line the candidate's bar shows: a question it asked, or something it said (an answer, a confirmation, its intro). */
export interface MiloLastLine { text: string; asked: boolean; /** When the line was sent (ms), from the message's own timestamp; absent when the frame gave none. */ at?: number }

/**
 * The latest line of Milo's in `frame` (else `current`): `asked` for a question; a line the server marks as said (`miloLine:
 * 'said'`, contract E9's one key) is not one. The fixed answers to the candidate's own two requests are left out (the bar shows
 * those on their own line).
 */
export function lastMiloLineOf(frame: unknown, channel: string, current: MiloLastLine | null): MiloLastLine | null {
  const f = frame && typeof frame === 'object' ? frame as Record<string, unknown> : null;
  if (!f || f['channel'] !== channel || (f['type'] !== 'chat' && f['type'] !== 'chat:message' && f['type'] !== 'chat:history')) return current;
  const list = Array.isArray(f['messages']) ? f['messages'] : f['message'] ? [f['message']] : [];
  let found = current;
  for (const m of list) {
    const msg = m && typeof m === 'object' ? m as Record<string, unknown> : null;
    if (!msg || msg['userId'] !== MILO_USER_ID) continue;
    const meta = msg['metadata'] && typeof msg['metadata'] === 'object' ? msg['metadata'] as Record<string, unknown> : {};
    if (meta['deleted'] === true) continue;
    const text = typeof msg['message'] === 'string' ? msg['message'].trim() : '';
    if (!text || isMiloAnswerLine(text)) continue;
    const sentAt = typeof msg['timestamp'] === 'string' ? Date.parse(msg['timestamp']) : NaN;
    found = { text: text.slice(0, 500), asked: meta['miloLine'] !== 'said' && meta['approvedAnswer'] !== true, ...(Number.isFinite(sentAt) ? { at: sentAt } : {}) };
  }
  return found;
}

/** One refusal for a round page the viewer holds no seat on (room and record say the same, with one way back to the viewer's home). */
export const NO_SEAT_NOT_FOUND = { title: 'Interview not found', body: 'There is no interview here that you can open.', backLabel: 'Home' } as const;

// ── The lost call ───────────────────────────────────────────────────────────
// The call can be lost under a live interview. When every socket of a call drops at once (a laptop that slept), the call
// service ends the call as its last participant drops; when one person's socket stays down past the rejoin grace, the call
// goes on (or ends) without them. Either way the library's client could not hear it (its socket was down): on waking it keeps
// its call and its clock and re-announces itself into a call it is no longer in, and the call service answers each frame with
// a `not-in-call` refusal. The room reads those refusals, and a server end of the call it was in, as the call LOST: it leaves
// the dead call (the clock and the tiles stop), says so in plain words, and joins the next call that is on in the interview's
// lobby (the lead's restart, through the same bound start as the first join). The interview record stays live throughout.

export interface CallLoss { callId: string }
export type CallLossEvent =
  /** The call service refused one of this client's frames because it is not in `callId` (realtime-modules CallService `not-in-call`). */
  | { kind: 'refused'; callId: string }
  /** The library tore the call down, for `reason` (its own `left`, or a server end such as `peer-disconnected`). */
  | { kind: 'ended'; callId: string; reason: string | null }
  /**
   * The call service's answer about the lobby (its `lobby-occupancy` frame: the snapshot every (re)connecting client's `watch` gets,
   * and each change after it): the lobby's live call, or null for none, while this client holds `held`.
   */
  | { kind: 'lobby'; callId: string | null; held: string | null }
  /** This viewer is in a call of the interview's lobby. */
  | { kind: 'joined'; callId: string }
  /** The interview is no longer live (ended, or the room closed): nothing is lost any more. */
  | { kind: 'closed' };

/** The ends the call service makes itself (realtime-modules CallService): nobody in the call chose them. */
const SERVER_ENDS = new Set(['peer-disconnected', 'rejoin-grace-expired']);

/** The call service's refusal of a frame for a call, from a raw gateway frame: that call's id; null for any other frame. */
export function refusedCallOf(frame: unknown): string | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  return f['type'] === 'error' && f['service'] === 'call' && f['code'] === 'not-in-call' && typeof f['callId'] === 'string' && f['callId'] ? f['callId'] : null;
}

/**
 * The room's lost call after one event. Only the call this viewer was last joined in (`joinedCallId`) can be lost, so a refusal
 * while a join is still settling, or about a call this page never held, changes nothing. A new call joined in the lobby clears it.
 */
export function nextCallLoss(prev: CallLoss | null, event: CallLossEvent, joinedCallId: string | null): CallLoss | null {
  switch (event.kind) {
    case 'closed': return null;
    case 'joined': return prev && event.callId !== prev.callId ? null : prev;
    case 'refused': return event.callId === joinedCallId ? (prev?.callId === event.callId ? prev : { callId: event.callId }) : prev;
    // The server says the lobby has no call, or another one, while this client still holds the call it was in: that call is gone.
    // This is the answer a waking client always gets (its reconnect re-sends `watch`), whatever happened to its own frames.
    case 'lobby': return event.held && event.held === joinedCallId && event.callId !== event.held ? (prev?.callId === event.held ? prev : { callId: event.held }) : prev;
    case 'ended': return event.callId === joinedCallId && !!event.reason && SERVER_ENDS.has(event.reason) ? (prev?.callId === event.callId ? prev : { callId: event.callId }) : prev;
  }
}

/**
 * The server's lobby report seats this client in the call it holds (`lobbyCallId` is the lobby's live call, `held` this client's): from
 * then on that call can be lost, also while the client's media has not come up (the library still reads "connecting").
 */
export const seatConfirmed = (lobbyCallId: string | null, held: string | null): boolean => !!held && lobbyCallId === held;

/** This client still holds the lost call (its clock runs, its tiles show): it leaves it. */
export const holdsLostCall = (loss: CallLoss | null, activeCallId: string | null): boolean => !!loss && activeCallId === loss.callId;

/**
 * After the loss, with no call held, a call is on in the interview's lobby (the lead restarted it, or the others' call went on):
 * this viewer joins it. `lobbyCallId` is the lobby's live call as the gateway reports it while this client holds none.
 */
export const rejoinsAfterLoss = (loss: CallLoss | null, lobbyCallId: string | null): boolean => !!loss && !!lobbyCallId;

/**
 * After a lost call, Milo's line for the panel: Milo leaves with a call that ends (its record says so, `leftReason` 'call-ended'),
 * so the room says that rather than leave the lead to find "Invite Milo" again in the bar. The lead is told how to bring Milo
 * back (the bar's Invite, once the call is back: Milo cannot join the dead call). Null when Milo was not in it or left for any
 * other reason (the bar says those).
 */
export function miloLostLine(milo: { phase: string; leftReason: string | null } | null | undefined, seat: 'lead' | 'panel' | null): string | null {
  if (!seat || milo?.phase !== 'left' || milo.leftReason !== 'call-ended') return null;
  return seat === 'lead' ? 'Milo left when the call dropped. Invite Milo again from the bar once the call is back.' : 'Milo left when the call dropped.';
}

export type CallLossSeat = 'lead' | 'panel' | 'candidate';
/** What the room says about the lost call, per seat; `action` is the lead's restart (the others join the call once it is back). */
export function callLossWords(seat: CallLossSeat): { title: string; body: string; action: string | null } {
  const title = 'The call dropped';
  if (seat === 'lead') return { title, action: 'Restart the call',
    body: 'The connection to the call was lost. The interview is still on: restart the call to carry on, and the candidate rejoins when you do.' };
  if (seat === 'panel') return { title, action: null, body: 'The connection to the call was lost. The interview is still on: you rejoin as soon as the call is back.' };
  return { title, action: null, body: 'The connection to the call was lost. The interview is still on: you rejoin as soon as your interviewer restarts the call.' };
}

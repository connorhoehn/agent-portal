// Milo speaks in an interview (docs/interviews-tenant-plan.md decisions 9, 10, 11; rows I3.5, I3.8; contract U10).
//
// The only words Milo says aloud in an interview call are words the server already holds: a question the lead approved (a
// suggestion's "Have Milo ask", a kit question from the room's Questions tab), the last such question again, the time left,
// and one fixed sentence. Each goes the same way, in this order: a row in the said log (store.ts), the words in the call chat
// with the approved mark (the one kind of Milo's message the candidate reads), then the call's own live session is asked to say
// them verbatim through the meeting assistant's one gate and relay (orchestrator.ts `sayHeldText`, gate reason `approved`), and
// the row is marked posted once the chat has the words, and spoken only when they were relayed. No model is ever asked anything here.
//
// Money (decision 18's `speech` part): the voice is the call's live session, whose minutes the listening hold already pays.
// Speech is still an explicit part of that money: before the words are said, a small hold (SPEECH_HOLD_USD, part `speech`,
// key the said row's id) is taken against the interview's and the opening's caps through the one door
// (spend.ts `reserveInterviewSpend`). Refused (a reached cap, no cap set), the words stay in the chat and nothing is said.
// Granted, the hold is released once the say is over, because the listening period's minute meter books the audio; the hold
// is a cap check that can be raced fairly, not a second charge.
//
// The candidate's requests come two ways and get the same answers: spoken in the call ("Milo, repeat the question"), found by the
// meeting assistant's detector and answered through the interviews policy (milo-policy.ts `answerFromHeldText`, which only logs:
// the orchestrator posts and says it), and the two buttons on the candidate's page (routes/interview-invite-milo.ts), which call
// `answerCandidate` here.
import { utterance } from './utterance.js';
import { randomBytes } from 'node:crypto';
import { interviewsNowMs } from '../clock.js';
import type { SayResult, SayWithheldWhy } from '../../meeting-assistant/approved-speech.js';
import type { Interview } from '../types.js';
import { saidStore, type SaidKind, type SaidRecord, type SaidSource, type SaidStore } from './store.js';

export { saidStore, setSaidStore, MemorySaidStore, SAID_SOURCES, type SaidRecord, type SaidSource, type SaidStore } from './store.js';

/** The one fixed sentence for anything else the candidate asks Milo (decision 10). */
export const MILO_CAN_DO = 'I can repeat the question or tell you how much time is left. Ask "Milo, repeat the question" or "Milo, how much time is left?"';
/** "Repeat the question" before Milo has asked one. */
export const NO_QUESTION_YET = 'Milo has not asked a question yet.';

/** What a candidate's request is: one of the two fixed ones, or anything else (the fixed sentence). */
export type CandidateRequest = 'repeat' | 'time' | 'other';

// The two requests are read from the WHOLE utterance (decision 10): a short request with at most a greeting, Milo's name, a
// "can you" and a "please" around it. A sentence that merely contains "repeat" or "how much … left" (the candidate thinking
// aloud, a hint asked as "repeat the answer", "how much time complexity …") is anything else, and gets the fixed sentence.
const LEAD = String.raw`(?:(?:um|uh|oh|sorry|so|ok|okay|hey|hi|and|but)\s+)*(?:(?:hey\s+)?milo\s+)?(?:i\s+was\s+(?:focusing|distracted|zoning\s+out|not\s+listening)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?`;
const TAIL = String.raw`(?:\s+(?:for\s+me|please|milo|again|thanks|thank\s+you))*`;
const IN_ROUND = String.raw`(?:\s+(?:in|for)\s+(?:this|the)\s+(?:round|interview))?`;
const REPEAT_CORE = String.raw`(?:repeat(?:\s+(?:the\s+(?:last\s+)?question|that|it))?|say\s+(?:that|it|the\s+question)\s+again|what\s+(?:was|is)\s+the\s+question|ask\s+(?:that|it|the\s+question)\s+again)`;
const TIME_CORE = String.raw`(?:how\s+are\s+we\s+(?:doing\s+)?(?:on|for)\s+time|time\s+check|how\s+much\s+time\s+(?:is\s+|do\s+(?:i|we)\s+have\s+|have\s+(?:i|we)\s+got\s+)?(?:left|remaining)|how\s+much\s+time\s+do\s+(?:i|we)\s+have|how\s+long\s+(?:do|have)\s+(?:i|we)\s+(?:have|got)(?:\s+left)?|(?:time|minutes?)\s+(?:is\s+|are\s+)?(?:left|remaining))`;
const REPEAT = new RegExp(`^${LEAD}${REPEAT_CORE}${TAIL}$`);
const TIME = new RegExp(`^${LEAD}${TIME_CORE}${IN_ROUND}${TAIL}$`);

/** Lower case, punctuation as spaces (apostrophes dropped), one space between words. */

/** Which fixed request this text is (the words after Milo's name, or the whole line). */
export function candidateRequestOf(text: string): CandidateRequest {
  const t = utterance(text);
  if (REPEAT.test(t)) return 'repeat';
  if (TIME.test(t)) return 'time';
  return 'other';
}

/** Where the round's clock starts: its set time once it has passed, else when Milo joined the call, else unknown. */
export function roundStartMs(scheduledAt: string | null, miloJoinedAtMs: number | null, nowMs: number): number | null {
  const set = scheduledAt ? Date.parse(scheduledAt) : NaN;
  if (Number.isFinite(set) && set <= nowMs) return set;
  return miloJoinedAtMs !== null && Number.isFinite(miloJoinedAtMs) && miloJoinedAtMs <= nowMs ? miloJoinedAtMs : null;
}

/** The time left as one spoken sentence, from the round's minutes and its start. */
export function timeLeftLine(minutes: number, startMs: number | null, nowMs: number): string {
  const length = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 60;
  if (startMs === null) return `This round is ${length} minutes long.`;
  const leftMs = startMs + length * 60_000 - nowMs;
  if (leftMs <= 0) return 'This round is at the end of its time.';
  const left = Math.max(1, Math.ceil(leftMs / 60_000));
  return left === 1 ? 'About 1 minute is left in this round.' : `About ${left} minutes are left in this round.`;
}

/** The last question Milo was approved to ask in this interview, or null. */
export function lastQuestion(rows: readonly SaidRecord[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.kind === 'question') return rows[i]!.text;
  return null;
}

/** What one spoken line holds against the interview's cap while it is said (a short utterance of the session's audio). */
export const SPEECH_HOLD_USD = 0.01;
/** How long a speech hold lives if nothing releases it: twice the longest say (a 30 s wait for quiet, a 45 s bound, 7 s for a silence to begin in). */
export const SPEECH_HOLD_TTL_MS = 180_000;

/** A speech hold: granted with its release, or refused (the words stay in the chat). */
export type SpeechHold = { ok: true; release: () => Promise<void> } | { ok: false };

/** Hold SPEECH_HOLD_USD for one line under the interview's `speech` part; never throws (a failure is a refusal). */
export async function holdSpeechMoney(interviewId: string, key: string): Promise<SpeechHold> {
  try {
    const { reserveInterviewSpend, releaseInterviewSpend } = await import('../spend.js');
    const out = await reserveInterviewSpend({ interviewId, part: 'speech', key, estimateUsd: SPEECH_HOLD_USD, expiresInMs: SPEECH_HOLD_TTL_MS });
    if (!out.ok) return { ok: false };
    return { ok: true, release: async () => { await releaseInterviewSpend([out.holdId]).catch(() => undefined); } };
  } catch (e) {
    // Still a refusal (nothing is said without the hold), but a broken money door is told apart from a reached cap here.
    console.warn('[interviews] speech hold failed', (e as Error)?.name ?? 'error', (e as Error)?.message ?? '');
    return { ok: false };
  }
}

/**
 * Why approved words were not said aloud, in the terms the lead's receipt uses: Milo's voice is off, Milo is paused, the money
 * hold was refused (`budget`), the session did not say them in time (`not-heard`: no quiet to speak into, or no utterance inside
 * the bound), Milo is not in the call, or anything else the meeting assistant withheld them for (`not-said`).
 */
export type NotAloudWhy = 'voice-off' | 'paused' | 'budget' | 'not-heard' | 'not-in-call' | 'not-said';

/** The receipt's reason for the meeting assistant's withheld code (approved-speech.ts SayWithheldWhy). */
export function notAloudWhy(why: SayWithheldWhy | null): NotAloudWhy {
  if (why === 'voice-off') return 'voice-off';
  if (why === 'paused') return 'paused';
  if (why === 'not-quiet' || why === 'timeout') return 'not-heard';
  return 'not-said';
}

/** One try at saying logged words aloud: relayed, or why not. */
export type Aloud = { spoken: true } | { spoken: false; why: NotAloudWhy };

export interface SpeakDeps {
  store: () => SaidStore;
  /** Post approved words in the call chat (the approved mark; `answer`: also the answer mark). False when Milo is not in the call. */
  post: (callId: string, text: string, kind: SaidKind) => Promise<boolean>;
  /** Ask the call's live session to say the words, and why it did not (orchestrator.ts `sayHeldTextWhy`). */
  say: (callId: string, text: string, by: string) => Promise<SayResult>;
  /** When Milo joined this call (epoch ms), or null when it is not in it. */
  miloJoinedAt: (callId: string) => Promise<number | null>;
  /** The call Milo is in for this interview: its `callId` when Milo has a record there, else Milo's newest open record in the lobby. */
  callOf: (interview: { id: string; callId: string | null }) => Promise<string | null>;
  now: () => number;
  newId: () => string;
  /** Hold the speech's money for one line (holdSpeechMoney). */
  holdSpeech: (interviewId: string, key: string) => Promise<SpeechHold>;
}

const defaultDeps = (): SpeakDeps => ({
  store: saidStore,
  post: async (callId, text, kind) => {
    const chat = await import('../../meeting-assistant/chat.js');
    return (await (kind === 'answer' ? chat.postApprovedAnswer(callId, text) : chat.postApprovedQuestion(callId, text))) !== null;
  },
  // The running meeting assistant's runtime, never a new one: with none in this process Milo is in no call here.
  say: async (callId, text, by) => (await (await import('../../meeting-assistant/orchestrator.js')).peekAssistantRuntime()?.sayHeldTextWhy(callId, text, by)) ?? { outcome: 'no-call', why: null },
  miloJoinedAt: async (callId) => {
    const { assistantStore } = await import('../../meeting-assistant/store-select.js');
    const record = await assistantStore().get(callId).catch(() => null);
    return record && record.state !== 'left' ? record.invitedAt : null;
  },
  // As the coach finds it (coach/transcript.ts): an interview's call id is often unset while it runs (the shell's call is the lobby's).
  callOf: async (interview) => {
    const { assistantStore } = await import('../../meeting-assistant/store-select.js');
    const store = assistantStore();
    if (interview.callId && await store.get(interview.callId).catch(() => null)) return interview.callId;
    const lobby = `interviews:interview:${interview.id}`;
    const open = (await store.listByState(['listening', 'paused'], 500).catch(() => [])).filter((r) => r.lobby === lobby);
    return open.at(-1)?.callId ?? interview.callId;
  },
  now: interviewsNowMs,
  newId: () => `said-${randomBytes(8).toString('hex')}`,
  holdSpeech: holdSpeechMoney,
});

let override: Partial<SpeakDeps> | null = null;
/** Tests: replace some dependencies; `null` puts the defaults back. */
export function setSpeakDeps(next: Partial<SpeakDeps> | null): void { override = next; }
const deps = (): SpeakDeps => ({ ...defaultDeps(), ...(override ?? {}) });

/** How the words went: aloud and in chat, in chat only, or nowhere (Milo is not in the call: the caller shows the line itself). */
export type Said = 'spoken' | 'chat' | 'none';

export interface SayInput {
  kind: SaidKind;
  source: SaidSource;
  text: string;
  askedBy: string;
  questionId?: string | null;
  suggestionId?: string | null;
}

/** The said log's row for approved words, written before they are posted or said (`posted` and `spoken` false). */
export async function logSaid(interview: Pick<Interview, 'id' | 'callId'>, input: SayInput): Promise<SaidRecord> {
  const d = deps();
  return d.store().append({
    id: d.newId(), interviewId: interview.id, callId: interview.callId, kind: input.kind, source: input.source,
    questionId: input.questionId ?? null, suggestionId: input.suggestionId ?? null, text: input.text, askedBy: input.askedBy,
    saidAt: new Date(d.now()).toISOString(), posted: false, spoken: false,
  });
}

/**
 * Say logged-and-posted words aloud on the call's voice (orchestrator.ts `sayHeldTextWhy`), behind the speech hold; marks the
 * row when relayed. Never throws: a say that throws reads as withheld.
 */
export async function sayLogged(interviewId: string, row: SaidRecord, callId: string): Promise<Aloud> {
  const d = deps();
  const hold = await d.holdSpeech(interviewId, row.id).catch((): SpeechHold => ({ ok: false }));
  if (!hold.ok) return { spoken: false, why: 'budget' };
  const out = await d.say(callId, row.text, row.askedBy)
    .catch((): SayResult => ({ outcome: 'posted', why: 'not-relayed' }))
    .finally(() => hold.release());
  if (out.outcome === 'no-call') return { spoken: false, why: 'not-in-call' };
  if (out.outcome !== 'spoken') {
    // Cut part way: the row says which words were heard (review 1, item 5).
    if (out.partly) await d.store().markSpokenPart(interviewId, row.id, out.partly).catch(() => null);
    return { spoken: false, why: notAloudWhy(out.why) };
  }
  await d.store().markSpoken(interviewId, row.id).catch(() => null);
  return { spoken: true };
}

/**
 * Log, post, mark: the one way approved words reach the call chat (a kit question, a candidate's button, the coach's "Have Milo
 * ask"). The row is written first; with no call, or a post refused, it stays unposted (asked of nobody). A log failure throws.
 */
export async function logAndPost(interviewId: string, callId: string | null, input: SayInput): Promise<{ row: SaidRecord; posted: boolean }> {
  const d = deps();
  const row = await logSaid({ id: interviewId, callId }, input);
  if (!callId) return { row, posted: false };
  const posted = await d.post(callId, input.text, input.kind).catch(() => false);
  if (!posted) return { row, posted: false };
  await d.store().markPosted(interviewId, row.id).catch(() => null);
  return { row: { ...row, posted: true }, posted: true };
}

/** Log, post, then say: the one path for approved words in an interview call. Never throws for the voice; a log failure throws. */
export async function sayApproved(interview: Pick<Interview, 'id' | 'callId'>, input: SayInput): Promise<{ said: Said; row: SaidRecord }> {
  const d = deps();
  const callId = await d.callOf(interview).catch(() => interview.callId);
  const { row, posted } = await logAndPost(interview.id, callId, input);
  if (!posted || !callId) return { said: 'none', row };
  const aloud = await sayLogged(interview.id, row, callId);
  return { said: aloud.spoken ? 'spoken' : 'chat', row: { ...row, spoken: aloud.spoken } };
}

/** The words for a candidate's request, from what the server holds (no model). */
export async function candidateLine(interview: Pick<Interview, 'id' | 'callId' | 'minutes' | 'scheduledAt'>, request: CandidateRequest): Promise<{ text: string; source: SaidSource }> {
  const d = deps();
  if (request === 'repeat') {
    const q = lastQuestion(await d.store().list(interview.id));
    return { text: q ?? NO_QUESTION_YET, source: 'repeat' };
  }
  if (request === 'time') {
    const callId = await d.callOf(interview).catch(() => interview.callId);
    const joined = callId ? await d.miloJoinedAt(callId).catch(() => null) : null;
    return { text: timeLeftLine(interview.minutes, roundStartMs(interview.scheduledAt, joined, d.now()), d.now()), source: 'time' };
  }
  return { text: MILO_CAN_DO, source: 'refusal' };
}

/** The candidate's button (routes/interview-invite-milo.ts): the line, logged, posted and said as approved words. */
export async function answerCandidate(interview: Pick<Interview, 'id' | 'callId' | 'minutes' | 'scheduledAt'>, request: CandidateRequest, askedBy: string): Promise<{ line: string; said: Said }> {
  const { text, source } = await candidateLine(interview, request);
  const { said } = await sayApproved(interview, { kind: 'answer', source, text, askedBy });
  return { line: text, said };
}

/**
 * The spoken request's half (milo-policy.ts `answerFromHeldText`): the line, logged as an answer not yet posted or spoken. The
 * orchestrator then posts it and says it, and `noteHeldSaid` marks the row.
 */
export async function logCandidateLine(interview: Pick<Interview, 'id' | 'callId' | 'minutes' | 'scheduledAt'>, text: string, askedBy: string): Promise<string> {
  const d = deps();
  const { text: line, source } = await candidateLine(interview, candidateRequestOf(text));
  await d.store().append({
    id: d.newId(), interviewId: interview.id, callId: interview.callId, kind: 'answer', source, questionId: null, suggestionId: null,
    text: line, askedBy, saidAt: new Date(d.now()).toISOString(), posted: false, spoken: false,
  });
  return line;
}

/**
 * The orchestrator posted (and perhaps said) a held answer: mark the latest row with those words for that asker that is not
 * yet posted. A post that failed marks nothing, so the row stays out of the round's record.
 */
export async function noteHeldSaid(interviewId: string, text: string, askedBy: string, said: { posted: boolean; spoken: boolean; partly?: string }): Promise<void> {
  if (!said.posted) return;
  const d = deps();
  const rows = await d.store().list(interviewId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!;
    if (r.kind !== 'answer' || r.posted || r.text !== text || r.askedBy !== askedBy) continue;
    await d.store().markPosted(interviewId, r.id);
    if (said.spoken) await d.store().markSpoken(interviewId, r.id);
    else if (said.partly) await d.store().markSpokenPart(interviewId, r.id, said.partly);
    return;
  }
}

/** Retention: remove these interviews' rows (a decision record, kept with the coach's log). */
export async function eraseSaidLog(interviewIds: readonly string[]): Promise<number> {
  return deps().store().erase(interviewIds);
}

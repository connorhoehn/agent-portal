// Hands-free Milo: the contracts between the lanes (listening side, talking side + router + seam, rules, surface, gate harness).
// Frozen at step 0. A change goes through the talking-side lane (it owns the runtime that wires them) and is a reviewed commit, never
// a drive-by edit from another lane.
//
// Shape (MEETING_ASSISTANT_HANDSFREE=1, read once per call in `AssistantRuntime.start`; see ../handsfree-flag.ts):
//
//   mixer.onPlaced ──► ListeningSide ──(line)──► store rows (coach, minutes read them unchanged)
//                       │  per person: transcription stream + 10 s ring
//                       └─(name / speech / frame)──► Router ──(frames)──► TalkingSide ──(output audio)──► relay
//                                                     ▲   │                    │
//                                       HandsfreeRules ┘   └─(RouteState)─► portal bar, tile ring
//
// Shared conventions (every interface below relies on them):
//   * TIME. Every `...Ms` that is a position is SESSION MILLISECONDS: the audio-intake mixer's timeline (mixer.ts: ms 0 is the mixer's
//     creation, frame k covers [k*100, (k+1)*100)), the same base `AudioSink.placed(userId, pcm, atMs)` reports. Provider offsets
//     (a transcription stream's own ms) are converted to session ms inside the listening side and never leave it. A `...At` field is
//     epoch ms (only where it is stored or shown). Durations are plain ms.
//   * AUDIO. 24 kHz mono signed 16-bit little-endian PCM everywhere (`HANDSFREE.sampleRate`). A "frame" is exactly 100 ms
//     (`HANDSFREE.frameBytes` = 4800 bytes). A placed piece from the mixer may be any length; the listening side re-cuts it.
//   * PEOPLE. `userId` is the person (never the media server's participant id). Audio only exists for people who acknowledged the
//     recording notice; the listening side opens no lane for anyone else, and a candidate who declined the transcript gets none.
//   * THREADING. Node's single thread. Event listeners are called synchronously, in emission order, and must not throw (a throw is
//     caught, logged and swallowed by the emitter; it never stops later listeners). Nothing here awaits inside a frame path: the
//     frame path (placed → ring → router → talking side) is synchronous so barge-in can stop the relay within one frame.
//   * STORAGE. PCM, the ring and routed audio live in memory only and are never written, logged or traced. Only `HeardLine`s are
//     stored (as `TranscriptLine` rows).
//   * CLOCK. Every timer goes through an injected `HandsfreeClock` so the router and the follow-up window run on a fake clock in jest.

import type { TranscriptLine } from '../types.js';
import type { PolicyCall } from '../policy.js';

// ---------------------------------------------------------------------------------------------------------------------------------
// Numbers (from the probe of 19 Nov; changing one is a contract change)

export const HANDSFREE = Object.freeze({
  sampleRate: 24_000,
  frameMs: 100,
  /** 100 ms of 24 kHz s16le mono. */
  frameBytes: 4_800,
  /** How far back each person's ring reaches. Older audio is gone; a read never returns more than this. */
  ringMs: 10_000,
  /** The most pre-roll a trigger replays (the sentence's start back from the name): the provider's burst limit. */
  preRollMaxMs: 5_000,
  /** The provider drops audio faster than this over any window (input_audio_rate_limit_exceeded). */
  replayMaxRate: 1.2,
  /** ...or sent ahead of real time by more than this. */
  replayBurstMs: 5_000,
  /** After Milo's answer finishes playing, the asker alone is still routed for this long without saying the name. */
  followUpMs: 10_000,
  /** A second person's queued "Milo" is let go if the floor has not freed this long after it (their words are stale by then). */
  queueKeepMs: 8_000,
  /** A held button routes for at most this long, then releases itself. */
  holdMaxMs: 30_000,
  /** `HandsfreeRules.admit` must settle within this; later (or a rejection) counts as `deny`. */
  admitWaitMs: 150,
  /** A named turn's output audio waits at most this long after its first frame for the rules' verdict; none by then counts as `mention`. */
  verdictWaitMs: 800,
  /**
   * Milo's voice is still heard back this long after his last frame played (the browser's buffer, the mic path, the transcript's lag;
   * voice.ts VOICE_ECHO_TAIL_MS): words, names and sentences that start inside it are checked against what he said (review 1, item 4).
   */
  echoGraceMs: 1_500,
  /**
   * The session's voice counts as finished this long after its last frame (or after the turn closed with none) when no `last` frame
   * came: frames dropped before the router (an approval pending, the voice off) or a provider that stopped mid-utterance (review 1, item 6).
   */
  answerQuietMs: 2_000,
  /** Target: from a barge-in's first word in a transcript delta to the relay going silent. Gate scenario, not a timer. */
  bargeInStopMs: 700,
  /** A closed transcription stream is reopened at most this many times per person per minute; past it the lane is down until the next minute. */
  reopenPerMinute: 3,
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Clock

export interface HandsfreeClock {
  /** Session ms now (same base as `placed`). */
  nowMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Listening side (lane A): one transcription stream and one ring per consenting person

/** A transcript line the listening side finished, with its exact speaker. The runtime assigns `seq` and appends it to the store. */
export type HeardLine = Omit<TranscriptLine, 'seq' | 'speakers'> & { userId: string; startMs: number; endMs: number };

/**
 * Milo's name heard in one person's live transcript (a delta, before the sentence is final). Emitted at most once per sentence per
 * person, on the first delta in which `findAddress` (detector.ts) finds an address, using every spelling in `NAME_SPELLINGS`.
 */
export interface NameEvent {
  userId: string;
  /** Session ms where the sentence holding the name began (the first word's start; the stream's segment start when words carry no times). */
  sentenceStartMs: number;
  /** Session ms where the name itself ended. */
  nameEndMs: number;
  /** The sentence so far, as transcribed (raw, not cleaned). */
  textSoFar: string;
  /** A per-person sentence id, stable across this sentence's later deltas and its final `SentenceEvent`. */
  sentenceId: string;
}

/** One person's sentence, final (the clean text the rules judge). Emitted once per sentence, after its last delta. */
export interface SentenceEvent {
  userId: string;
  sentenceId: string;
  text: string;
  startMs: number;
  endMs: number;
  /** True when a `NameEvent` was emitted for this sentence. */
  named: boolean;
}

/** Words arriving in a person's transcript (any delta). Drives barge-in and echo detection; carries no timing guarantee beyond order. */
export interface WordsEvent { userId: string; sentenceId: string; delta: string; atMs: number }

/** A lane's health. `down`: no stream (the name cannot trigger for this person; the hold button still routes their audio). */
export interface LaneEvent { userId: string; state: 'up' | 'down'; reason?: 'closed' | 'reopen-limit' | 'no-consent' | 'left' }

/** One person's re-cut 100 ms frame as it entered the ring. Synchronous within `placed`, in session-time order per person. */
export interface FrameEvent { userId: string; pcm: Buffer; atMs: number }

export interface ListeningEvents {
  line: HeardLine;
  name: NameEvent;
  sentence: SentenceEvent;
  words: WordsEvent;
  lane: LaneEvent;
  frame: FrameEvent;
}

export interface ListeningSide {
  /**
   * The mixer's per-person audio (AudioSink.placed). Synchronous: ring write and `frame` events happen before it returns; the stream
   * write is fire-and-forget. Audio of a person with no lane is dropped here.
   */
  placed(userId: string, pcm24k: Buffer, atMs: number): void;
  /** Open a lane (stream + ring) for a consenting person; a no-op when open. Rejects only on a configuration error (no key). */
  open(userId: string, speakerName: string): Promise<void>;
  /** Close one person's lane, dropping their ring at once. Idempotent. */
  closeLane(userId: string): void;
  /**
   * Frames of one person's ring from `fromMs` (rounded down to a frame) up to now, or only those starting before `toMs` (a finished
   * sentence), oldest first, gaps as silence. Clamped to the ring (never more than `HANDSFREE.ringMs`); empty when there is no lane.
   * A copy: the caller may keep it.
   */
  preRoll(userId: string, fromMs: number, toMs?: number): Buffer[];
  on<K extends keyof ListeningEvents>(type: K, fn: (e: ListeningEvents[K]) => void): () => void;
  /** Close every lane and stream; resolves once all streams are closed (bounded). Idempotent. Emits no events after it resolves. */
  close(): Promise<void>;
}

/** One provider transcription stream (lane A's socket; the gate harness supplies a scripted one). */
export interface PersonTranscriber {
  /** 24 kHz PCM, contiguous from the stream's own ms 0 (the listening side fills gaps with silence). Never throws; dropped when closed. */
  append(pcm24k: Buffer): void;
  /** Deltas and finals in the stream's own ms (converted by the listening side). */
  on(type: 'delta', fn: (e: { itemId: string; delta: string; streamMs: number }) => void): () => void;
  on(type: 'final', fn: (e: { itemId: string; text: string; startStreamMs: number; endStreamMs: number; words?: Array<{ text: string; startStreamMs: number; endStreamMs: number }> }) => void): () => void;
  /** Called once, whatever the cause; the listening side decides whether to reopen. */
  on(type: 'closed', fn: (e: { error: string | null }) => void): () => void;
  close(): Promise<void>;
}
/** `keywords`: the name's spellings (`NAME_SPELLINGS`). The real one opens with delay `minimal`. */
export type TranscriberFactory = (input: { callId: string; userId: string; keywords: readonly string[] }) => Promise<PersonTranscriber>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Rules (lane C): who may trigger, mention vs request, echo vs barge-in

/**
 * What a person may get from Milo in this call, asked at every trigger (name or hold) before any of their audio is routed.
 *   route        their audio goes to the talking session.
 *   fixed-lines  never routed; a final sentence of theirs addressed to Milo gets a server line (repeat / time / MILO_CAN_DO) only.
 *   deny         nothing (no lane, Milo off for them, or the rules could not answer in time).
 */
export type Admission = 'route' | 'fixed-lines' | 'deny';

/**
 * The rules' verdict on one finished sentence that opened (or continued, inside the follow-up window) a turn.
 *   request   relay Milo's answer.
 *   mention   talked about, not to, Milo ("I saw Milo's summary"): drop the turn's output; the session talks on unheard.
 *   aside     a follow-up-window sentence meant for someone else: drop as `mention`, and close the window.
 *   fixed     answered by the server: `line` is said verbatim (TalkingSide.say) and the session's own output for the turn is dropped.
 */
export type TriggerVerdict =
  | { kind: 'request' }
  | { kind: 'mention' }
  | { kind: 'aside' }
  | { kind: 'fixed'; line: string };

/** Words heard from a mic while Milo's voice is playing. */
export type OverlapVerdict = 'echo' | 'barge-in' | 'unclear';

export interface HandsfreeRules {
  /** Settles within `HANDSFREE.admitWaitMs` or is treated as `deny`. May read settings (candidateMayAsk) each time; may cache per call. */
  admit(call: PolicyCall, userId: string): Promise<Admission>;
  /**
   * The verdict on a finished sentence. `via`: `name` (it held Milo's name), `follow-up` (no name, inside the asker's window), `hold`
   * (never asked: a hold is a request by definition). Must settle within `HANDSFREE.verdictWaitMs` of the sentence's end to count;
   * a rejection counts as `mention` (fail closed).
   */
  verdict(call: PolicyCall, sentence: { userId: string; text: string; via: 'name' | 'follow-up' }): Promise<TriggerVerdict>;
  /**
   * Pure and synchronous (it runs on the frame path). `heard`: the words so far of a mic's sentence while the relay plays; `saying`:
   * the words of Milo's current utterance so far (text of the output transcript). `echo`: Milo's own words come back; `barge-in`:
   * someone else's words; `unclear`: too few words to tell (the router waits for the next delta).
   */
  overlap(heard: string, saying: string): OverlapVerdict;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Router (lane B): the one floor

/**
 * idle       nobody's audio reaches the session (it hears silence).
 * routing    `userId`'s audio reaches the session (pre-roll replayed, then live) until the provider closes the turn.
 * answering  the session is answering `userId`; their audio is still routed (a barge-in by them is heard) but no one else's.
 * follow-up  Milo finished; `userId` alone is routed until `untilMs` (session ms) without the name.
 */
export type RouteState =
  | { phase: 'idle' }
  | { phase: 'routing'; userId: string; via: 'name' | 'follow-up' | 'hold'; sinceMs: number }
  | { phase: 'answering'; userId: string; via: 'name' | 'follow-up' | 'hold'; sinceMs: number }
  | { phase: 'follow-up'; userId: string; untilMs: number };

/** Why the router stopped relaying a turn's audio (logged, and shown in the trace; never shown to people). */
export type RelayDrop = 'mention' | 'aside' | 'verdict-timeout' | 'barge-in' | 'stop' | 'fixed' | 'hold-cancel' | 'echo';

export interface RouterEvents {
  /** Every change, in order. The surface shows `routing` / `answering` as "<name> is talking to Milo" and rings that person's tile. */
  state: RouteState;
  /** A turn's relay was dropped (the session may keep talking, unheard). */
  drop: { userId: string; reason: RelayDrop; atMs: number };
  /** A second person's trigger while the floor was held: their sentence is kept (one, the latest replaces it) and replayed next. */
  queued: { userId: string; sentenceStartMs: number };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Talking side (lane B): the live session that only hears the routed person

export interface TalkingSide {
  /**
   * One tick of the session clock (the mixer's 100 ms `append` cadence). `frames`: what the router chose for this tick: none (the
   * talking side sends nothing: an idle tick is how the router pays a replay's lead back), one frame (live, or silence the router
   * made so the provider can close a turn), or a replay burst (the router keeps replays within `replayMaxRate` / `replayBurstMs`;
   * the talking side forwards as given and never mixes two people).
   * (Contract change, lane B, 19 Nov: was "none = one frame of silence", which left no tick to pay a replay's lead back on.)
   */
  feed(frames: readonly Buffer[]): void;
  /** Say server-held words verbatim (fixed lines, "Have Milo ask"). False when the session cannot take it now. */
  say(id: string, text: string, ended: (transcript: string | null) => void): boolean;
  /**
   * The person a tool call is attributed to, set by the router whenever it changes. Confirmed (`pending` false: the turn's verdict
   * is `request`, or a hold): every `toolCall` is emitted with `askedBy`. Pending (routed, the rules have not judged the sentence):
   * tool calls are held, then emitted with `askedBy` if the next call confirms the same person, else without it. Null (idle, a
   * mention, an aside, a `fixed` turn): emitted without `askedBy`, which the orchestrator refuses as unasked.
   * (Contract change, review 1 item 1, 19 Nov: was "stamped in any non-idle phase", so a write could run before `mention` landed.)
   */
  setAsker(userId: string | null, pending?: boolean): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The seam (lane B): what the orchestrator holds for a hands-free call

export type HoldResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'not-admitted' | 'not-running' | 'already-holding' };

export interface HandsfreeRun {
  /** The call's audio sink while hands-free: `placed` goes to the listening side; `append` (the room mix) is the tick for `TalkingSide.feed`. */
  readonly sink: { append(pcm24k: Buffer): void; placed(userId: string, pcm24k: Buffer, atMs: number): void };
  /** Current floor (for a page that loads mid-call). */
  state(): RouteState;
  on<K extends keyof RouterEvents>(type: K, fn: (e: RouterEvents[K]) => void): () => void;
  /**
   * The hold button (route handler, after the existing auth). Press: refused when someone else holds the floor (`busy`) or the person
   * is not admitted to `route`; otherwise routes them at once (no name, no verdict) until release, cancel or `holdMaxMs`. Release ends
   * the person's turn (the provider closes it); cancel drops the relay too. Release / cancel by someone who is not holding: no-op.
   */
  holdPress(userId: string): Promise<HoldResult>;
  holdRelease(userId: string): void;
  holdCancel(userId: string): void;
  /** "Have Milo ask": say server-approved words now, through the talking side, outside any turn. */
  say(id: string, text: string, ended: (transcript: string | null) => void): boolean;
  /** A person joined (after acknowledging) or left. */
  personJoined(userId: string, speakerName: string): void;
  personLeft(userId: string): void;
  /** Stop everything; resolves when both sides are closed. Idempotent. */
  close(): Promise<void>;
}

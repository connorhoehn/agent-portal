// The meeting assistant's brain (docs/meeting-assistant-design.md decisions 3 to 7, 11). One `CallRun` per listening call
// owns the live session, and `AssistantRuntime` owns the runs. Everything a model says is data; every rule that matters is here:
//
//   * ASKER. Decided by the server. Scripted session: the `askedBy` the server itself passed to `sendText` for the request.
//     Real session: the latest attributed transcript line in the 20 seconds before the call. Nothing the model says names a person.
//   * NAME LOCK. The asker must have said the name (`nameLock`) in those 20 seconds, or the call is refused, counted and not posted.
//   * ROLE. The call's policy (policy.ts) says whether the asker may have the tool run; by default it must be in the voice catalogue
//     for the asker's own tenant and role, and not in MEETING_EXCLUDED_TOOLS.
//   * NEVER EXECUTE. The server runs no tool. A call becomes a `turn` for the asker's browser: a read runs at once there, a write
//     waits behind a card only the asker can confirm. The result comes back through submitResult, and is handed to the session as
//     data, never posted raw and never read as an instruction.
//   * ONE ANSWER. Every tool call the session raises is answered exactly once, by `answer()`: it flips the call from 'open' to
//     'answered' BEFORE it sends, so a late result, an expiry and a refusal can race and only one is sent. A call is left open on
//     purpose only for a read turn, and then the turn's result, its expiry, or the session closing settles it (an unanswered call
//     stalls the session). The `finally` of `onToolCall` answers anything still open that no turn holds.
//   * PAUSE. While paused the session is closed (it does not bill) and nothing is sent anywhere; resume opens a new session
//     carrying the last minutes of the transcript. An unexpected close is replaced the same way, at most 3 times per call.
//   * DEAF. A session can stay open and hear nothing: the tap stops posting, or audio flows and no transcript ever comes back. While
//     people who may be heard hold seats, a minute of either is one stall: the tap is armed again or the session replaced (through
//     the paths above), the call is told once, and a stall the recovery does not end leaves through giveUp (`checkHearing`).
import { randomBytes } from 'node:crypto';
import { getUser, listUsers } from '../../providers/identity.js';
import { hashToolArgs, voiceTool } from '../voice/catalogue.js';
import { ASSISTANT_NAME, CANNOT_HEAR_NOTICE } from './chat-types.js';
import {
  nameOf, noticeText, postAction, postApprovedAnswer, postNoticeQuietly, postPrivately, postReply, moveAction,
} from './chat.js';
import { isPrivateRead, meetingInstructions } from './instructions.js';
import { limitsOfCall, linesForModels, payerOf, policyCallOf, policyForLobby, type MeetingAssistantPolicy, type PolicyCall } from './policy.js';
import { VoicedTimeline, attribute, lagSample, splitBySpeaker, transcriptLag, LAG_SAMPLES } from './attribution.js';
import { OUT_RATE } from './mixer.js';
import { AssistantSpeech, VOICE_FRAME_MS, VoiceRelay, voiceChannel, type VoiceSink } from './voice.js';
import { ASKER_WINDOW_MS, VOICE_PROMPT_WINDOW_MS, VoiceGate, type VoiceGateWhy } from './voice-gate.js';
import type { AudioIntake } from './audio-intake.js';
import type { TapArmer } from './media.js';
import { assistantAudio } from './audio-select.js';
import { findAddress, NAME_ALTERNATION, nameLock, parseCommand, type DetectorEvent } from './detector.js';
import { assistantIntake } from './intake-select.js';
import { assistantStore } from './store-select.js';
import { callChatRuntime } from '../call-chat.js';
import { CEILING_WARNING_SECONDS, REQUESTS_WARNING_LEFT, assistantLimits } from './limits.js';
import { finishMinutes } from './minutes-service.js';
import { assistantSpend, currentListeningSecondsOf, listeningSecondsOf, settleFinished, type ReserveOutcome } from './spend.js';
import type { AssistantStore } from './store.js';
import type { LineIntake } from './intake.js';
import { canSpeakOnRecord } from './intake.js';
import { makeSession } from './session-select.js';
import { MAX_NAMED, MAX_STATEMENT_CHARS, ProposalInputError, closeProposals, createProposal, onProposalConsented } from './proposals.js';
import { consentStatus, namedStatement, peopleSaid, resolvePeople, updateStatement, type PersonRole } from './named-people.js';
import type { RosterEntry } from './minutes.js';
import { hookProposalNotices, notifyOpenProposals } from './proposal-notify.js';
import { checkBeforeClaim, expireProposalTurn, finishProposal, startProposal, type ProposalRunDeps } from './proposal-run.js';
import { DecisionWatcher, defaultWatcherDeps } from './decision-watcher.js';
import { MAX_PROVIDER_ERRORS, type LiveMeetingSession, type ProviderErrorInfo, type SessionEvents } from './session.js';
import { trace } from './trace.js';
import { saidVerbatim, sayBoundMs, SAY_QUIET_WAIT_MS, speakableText, type SayOutcome, type SayResult, type SayWithheldWhy } from './approved-speech.js';
import { periodOf, periodRequests, sessionOf, type TranscriptLine, type AssistantRecord, type AssistantTurn, type TurnKind, type TurnStatus } from './types.js';

export const READ_TURN_TTL_MS = 90_000;
export const WRITE_TURN_TTL_MS = 10 * 60_000;
/** How far back from a tool call the asker is looked for and the name lock reads (decision 3); the voice gate's prompt window too. */
export { ASKER_WINDOW_MS };
/** Tool calls one addressed request may make; the next is refused with "too many steps". */
export const MAX_CALLS_PER_REQUEST = 3;
export const TYPED_UNSUPPORTED_REPLY = `${ASSISTANT_NAME} only hears spoken requests in this call. Say "${ASSISTANT_NAME}" and ask aloud.`;
/** A typed request while Milo is paused: said once per person per pause. */
export const TYPED_PAUSED_REPLY = `${ASSISTANT_NAME} is paused and did not take that. Ask again once it is listening.`;
const TYPED_MENTION = new RegExp(`(^|[^\\w])@(?:${NAME_ALTERNATION})\\b`, 'i');
/**
 * A call chat message that addresses the assistant: an @Milo mention, or the name as speech addresses it (detector.ts `findAddress`),
 * so the typed path and the spoken one share one rule ("Milo grain prices are up" typed is not a request; "Hey Milo, ..." is).
 */
export const addressesAssistant = (text: string): boolean => TYPED_MENTION.test(text) || findAddress(text) !== null;
export const MAX_REPLACEMENTS = 3;
/** The provider's session is replaced this long before its `expires_at` (about two hours after it starts). */
export const SESSION_EXPIRY_MARGIN_MS = 5 * 60_000;
/** A failed replacement is retried after each of these delays; when they are spent Milo leaves (audit B9). */
export const REPLACEMENT_RETRY_MS: readonly number[] = [1000, 3000, 9000];
/**
 * How long Milo may go without hearing anyone, while people who may be heard hold seats, before it counts as deaf (`checkHearing`).
 * The tap armer's own give-up (media.ts TAP_GIVE_UP_MS): the same minute after which a call is told Milo cannot hear it. Also how long
 * a recovery has to end the stall before Milo leaves.
 */
export const DEAF_AFTER_MS = 60_000;
/**
 * Audio flowing but no transcript for that minute: deaf only when the minute also held this much VOICED audio (attribution.ts
 * VoicedTimeline). Half of it: a session that hears gives a transcript at each pause in speech, so half a minute of voice with none
 * is a conversation going unheard, not a cough, a keyboard or one long sentence.
 */
export const DEAF_VOICED_MS = DEAF_AFTER_MS / 2;
/** Voiced milliseconds, anyone's, on a session's timeline after `fromMs` (session milliseconds). */
const voicedSince = (timeline: VoicedTimeline, fromMs: number): number =>
  timeline.intervals().reduce((sum, i) => sum + Math.max(0, i.endMs - Math.max(i.startMs, fromMs)), 0);
/** The most a tool call's arguments may weigh, as JSON, and the most a browser's result may weigh. */
export const MAX_ARGS_BYTES = 4096;
export const MAX_RESULT_BYTES = 16 * 1024;
/** How many unmatched delegation times a run keeps. */
export const MAX_DELEGATIONS = 16;
/** A delegation older than this before a function call is not matched to it. */
export const DELEGATION_MAX_AGE_MS = 60_000;
const RECENT_TRANSCRIPT_MS = 5 * 60_000;
const RECENT_TRANSCRIPT_LINES = 60;

/** The gateway's in-process hand-off for a transient frame (lib/social-chat.ts); loaded on first use so a unit test needs no gateway. */
const defaultVoiceSink: VoiceSink = async (channel, frame) => (await import('../social-chat.js')).sendThreadFrame(channel, frame);

export interface StartContext {
  callId: string;
  tenant: string;
  inviterId: string;
  /** Display names in the call. */
  roster: readonly string[];
  /** The call's record name (an initiative's name), or null. */
  recordName: string | null;
  /** The call's lobby, which picks its policy (policy.ts). Absent: the record's lobby, read when the run starts. */
  lobby?: string | null;
  /** Milo was invited back: lines before this one belong to an earlier period and are never taken as a request of this one. */
  fromSeq?: number;
  /**
   * Which period of Milo in this call the run serves (types.ts `periodOf`; 1 for the first). An invitation back passes the new one; absent,
   * it is the record's period (1 when no record exists yet). What the run writes on the record when it stops counts only for this period.
   */
  period?: number;
}

/** Said once a period when its requests pass the cap: "for this call" in the first period, "since it was invited back" in later ones. */
export const requestLimitNotice = (period: number): string =>
  `${ASSISTANT_NAME} has reached its limit of ${assistantLimits().maxRequests} requests ${period > 1 ? 'since it was invited back' : 'for this call'} and will not answer more.`;
/** Said once a period, a few requests before its cap. */
export const requestsLeftNotice = (period: number): string =>
  `${ASSISTANT_NAME} can answer ${REQUESTS_WARNING_LEFT} more requests ${period > 1 ? 'before it stops answering' : 'in this call, then it stops answering'}.`;

/**
 * `start` found a run for the call that is stopping (or one of an earlier period that has yet to stop): the new run cannot start until it
 * is gone, or the old one's stop would close and settle the new period (`AssistantRuntime.settled` waits for it).
 */
export class RunStillStopping extends Error {
  constructor(readonly callId: string) { super('the previous run of this call is still stopping'); this.name = 'RunStillStopping'; }
}

export interface RuntimeDeps {
  store: () => AssistantStore;
  intake: () => LineIntake;
  clock: () => number;
  makeSession: (clock: () => number) => LiveMeetingSession | null;
  /** The asker's roles in `tenant` (their grants), for the per-asker catalogue check. */
  rolesOf: (userId: string, tenant: string) => Promise<string[]>;
  /** Called when a call's run ends (dismissed, left or abandoned), with what the sessions reported. Spend settles here. */
  onFinished?: (event: FinishedEvent) => Promise<void>;
  /** The audio side (audio-intake.ts): told when a session opens and closes. Absent in tests that do not care. */
  audio?: Pick<AudioIntake, 'attach' | 'suspend' | 'detach'> & Partial<Pick<AudioIntake, 'forget'>>;
  /** Where Milo's voice frames go (the gateway's in-process sink); false from it means no gateway runs here. Default: lib/social-chat.ts `sendThreadFrame`. */
  voiceSink?: VoiceSink;
  /** Sleep for `ms` (replacement retries, the turn sweep's tests); injectable so tests never wait. */
  wait?: (ms: number) => Promise<void>;
  /** May this role take this Cedar action (a create form's gate, for a consented proposal)? Default: lib/authz.ts isAllowed. */
  actionAllowed?: ProposalRunDeps['actionAllowed'];
  /** May this person record a decision as decided on this initiative? Default: lib/decision-authority.ts, over each of their roles. */
  mayDecide?: ProposalRunDeps['mayDecide'];
  /** The decision watcher (decision-watcher.ts): started, paused and stopped with the run, and fed each stored line. Absent: none. */
  watcher?: Pick<DecisionWatcher, 'start' | 'pause' | 'stop' | 'onLine' | 'dispose'>;
  /** The org directory, for a person a write names who never held a seat in the call. Default: providers/identity.ts listUsers. */
  directory?: () => Promise<RosterEntry[]>;
  /** The tap armer (media.ts), when a media server is configured: the deaf watchdog arms a silent call again. Absent or null: no audio watch. */
  taps?: () => Promise<Pick<TapArmer, 'rearm' | 'hearing'> | null>;
  /** Who holds or held a seat in the call (lib/call-chat.ts `seatedUsers`). Default: the call chat runtime's. */
  seats?: (callId: string) => Promise<Array<{ userId: string; active: boolean }>>;
}

export interface FinishedEvent {
  callId: string;
  usageSeconds: number;
  tokens: { input: number; output: number; cached: number };
  /** Which session ran; only the provider's own figures are `reported` in the ledger. */
  sessionKind: 'openai' | 'scripted';
  /** The period the run served: a record that has moved to a newer one is not settled with these figures. */
  period?: number;
}

type CallState = 'open' | 'answered' | 'dropped';

/**
 * Who a spoken reply belongs to (audit B1, re-audit F1). A run has ONE current context, set only by `answer()`; people speaking never
 * change it, except that a later line addressing Milo supersedes it. `muted` means the continuation is not posted (a refused call, a
 * private answer, an expired read).
 */
export interface ReplyContext {
  modelCallId: string;
  asker: string | null;
  visibility: 'public' | 'muted';
  answeredAt: number;
  /** The latest line stored when the context was set: only a line stored after it can end the context (the order decides, not the clocks). */
  lastSeq?: number;
  /**
   * The answer was a write's card ("Waiting for <name>"): Milo's first words about it ("I have asked Vera to confirm.") are spoken but
   * not posted, since the card already says so. Cleared by that first utterance, or once the card is decided.
   */
  card?: true;
}
/** How soon after a bare "Milo?" the same person's next line is the request it announced. */
export const BARE_NAME_FOLLOW_MS = 8_000;
const BARE_NAME = new RegExp(`^\\s*((hey|hi|ok|okay)[\\s,]+)?(?:${NAME_ALTERNATION})[\\s.,!?…]*$`, 'i');

/**
 * The lines a spoken answer can be for, oldest first. A bare "Milo?" asks nothing yet: what Milo says to it ("Yes?") answers nobody,
 * and the same person's next line, a few seconds later, is the request even without the name.
 */
export function replyAddressing(lines: readonly TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const bareAt = new Map<string, number>();
  for (const l of lines) {
    const bare = BARE_NAME.test(l.text);
    const announced = l.userId !== null && (bareAt.get(l.userId) ?? -Infinity) >= l.at - (l.endMs !== undefined && l.startMs !== undefined ? l.endMs - l.startMs : 0) - BARE_NAME_FOLLOW_MS;
    if (l.userId !== null) { if (bare) bareAt.set(l.userId, l.at); else bareAt.delete(l.userId); }
    if (bare) continue;
    const hit = findAddress(l.text);
    // "Milo, pause" / "Milo, leave" addresses Milo but asks nothing: never the request a later answer belongs to.
    if (hit) { const command = parseCommand(hit.rest); if (command === 'pause' || command === 'dismiss') continue; }
    if (hit !== null || announced) out.push(l);
  }
  return out;
}

/** A public reply context covers speech this long after its answer; a muted one only the short continuation (counted from `answeredAt`). */
export const REPLY_CONTEXT_TTL_MS = 20_000;

/**
 * One delegation: the model began working on a request at `at` (epoch ms). Its work first produces either a function call (the
 * call takes this delegation: `callId`) or a spoken message (a plain answer worked out by the second model). Speech that begins
 * before that first item is the short acknowledgement the voice gives as it hands the work over (the real provider speaks it at
 * once, before the function call arrives). `asker` is who addressed Milo at `at` (judged then, audit S2), for a delegated plain answer.
 */
interface Delegation {
  at: number;
  /**
   * The moment the request is judged at, on the lines' clock. Lines carry the provider's audio times and the delegation the server's
   * wall clock; the two differ by up to a few seconds (the paid runs saw the request line end 0.2 to 2 s after its own delegation). Every line
   * stored before the delegation was heard before it, so the moment is the later of the delegation and the end of those lines
   * (bounded by DELEGATION_LINE_SKEW_MS). Set once `asker` resolves.
   */
  judgeAt: number;
  /** The latest line stored before the delegation (set with `judgeAt`): a line after it was spoken after the work began. */
  lastSeq: number | null;
  readyAt: number | null;
  item: 'message' | 'function_call' | null;
  acknowledged: boolean;
  answered: boolean;
  callId: string | null;
  asker: Promise<{ userId: string | null; seq: number | null }>;
}
export const MUTED_CONTEXT_TTL_MS = 8_000;
/** An utterance is the short acknowledgement of an open call only when it starts this soon after the call's delegation moment. */
export const ACKNOWLEDGEMENT_WINDOW_MS = 6_000;
/** A line must end this long after a delegation to count as spoken after it (a line's reported end can run a little late). */
const ACKNOWLEDGEMENT_LINE_MARGIN_MS = 1_000;
/**
 * A sanity bound only: how far the end of a line heard before a delegation (or before Milo's first word) may lie after that moment's
 * wall-clock time and still count as before it. The order the events arrived in is what decides: the paid runs saw the provider's
 * audio clock start up to 2 s ahead of the server's and then gain about 1.3 s every 100 s, so over a long call the two drift far apart.
 */
export const DELEGATION_LINE_SKEW_MS = 5 * 60_000;
/** The "could not tell who asked" reply is posted at most this often per call. */
export const UNASKED_NOTICE_EVERY_MS = 30_000;
/** How often the seat roster is read to record who is present while Milo is. */
export const ATTENDANCE_EVERY_MS = 15_000;
/** The process writes "still alive" on each listening record this often (audit M5); a restart closes the listening period there. */
export const HEARTBEAT_EVERY_MS = 30_000;
export const UNASKED_REPLY = `${ASSISTANT_NAME} could not tell who asked. Ask again.`;

/** One call's live state. Plain data plus the session; every behaviour is a method of the runtime. */
interface CallRun {
  ctx: StartContext;
  /** The call as its policy sees it, and that policy (policy.ts): chosen once when the run starts, from the call's lobby. */
  call: PolicyCall;
  policy: MeetingAssistantPolicy;
  /** The period of Milo in the call this run serves (`StartContext.period`). */
  period: number;
  session: LiveMeetingSession | null;
  unsubscribers: Array<() => void>;
  /** Session timeline start on the wall clock, and a counter that makes caption ids unique across sessions. */
  sessionStartedAt: number;
  /**
   * The call's own timeline start on the wall clock (the record's `invitedAt`, which an invitation back keeps): a stored line's
   * `startMs`/`endMs` are offsets on it, so they never restart at 0 after a pause, a replaced session or a later period.
   */
  callStartedAt: number;
  sessionNo: number;
  pieceNo: number;
  /** The latest end time of a line this session stored (epoch ms, on the audio timeline the lines use). */
  lastLineAt: number;
  /** The latest seq of a line this session stored, and that seq as of the previous delegation (the start of the model's current turn). */
  lastLineSeq: number;
  /** Input transcripts received this session, and the end (epoch ms, lines' clock) of each recent one by its number. */
  inputNo: number;
  inputEndAt: Map<number, number>;
  /** Which input transcript (by number) each recent stored line came from: lines split from one heard turn share it. */
  lineInput: Map<number, number>;
  /** Recent measures of how late the provider's transcript times run behind the voiced timeline (ms); see `transcriptLag`. */
  lagSamples: number[];
  /** When the second model's messages became ready (epoch ms), not yet spoken: the next utterance after one speaks it. */
  readyMessages: number[];
  delegationSeq: number;
  timeline: VoicedTimeline;
  calls: Map<string, CallState>;
  /** The model's call id behind each turn that is waiting on the asker's browser. */
  turnCalls: Map<string, string>;
  /** Tool calls made so far for each addressed request, keyed by asker and the line that addressed Milo (decision: a cap on chained calls). */
  requestCalls: Map<string, number>;
  /** People already told that typed requests are not heard in this call. */
  /** Who was told this listening stretch that typed requests are not heard (cleared on resume), and who was told Milo is paused (this pause). */
  typedNoticed: Set<string>;
  typedPausedNoticed: Set<string>;
  holding: Set<string>;
  /** The one current reply context, and each answered call's own (for a session that says which call its speech continues). */
  reply: ReplyContext | null;
  replyById: Map<string, ReplyContext>;
  /** When each tool call of this session was received and answered (null: still open). */
  callTimes: Map<string, { openedAt: number; answeredAt: number | null; acknowledged: boolean }>;
  /** Sequence numbers of addressing lines already answered (by a tool call's context or a plain answer): each gets one answer. */
  answeredLines: Set<number>;
  /** Addressing lines a tool call took as its request (line seq to the model's call id): that call's context answers them. */
  claimedLines: Map<number, string>;
  /** The moments the provider said the model began working on a request, the latest MAX_DELEGATIONS (see `Delegation`). */
  delegations: Delegation[];
  lastUnaskedNoticeAt: number;
  attendanceAt: number;
  /** When the heartbeat (session.lastAliveAt, and the figures to settle) was last written. */
  heartbeatAt: number;
  intentionalClose: boolean;
  /**
   * The deaf watchdog (`checkHearing`): when people's audio last reached the session, when the session last gave a transcript, when
   * the current watch began (it starts again whenever the watch does not apply: no session, Milo speaking, nobody to hear), and the
   * stall already acted on (cleared by the next audio or transcript), so one stall gets one recovery and one notice.
   */
  heardAt: number;
  transcribedAt: number;
  watchFrom: number;
  deaf: { kind: 'audio' | 'transcripts'; at: number } | null;
  /** Final usage of the session that just closed; added into the totals once. */
  usageSeconds: number;
  tokens: { input: number; output: number; cached: number };
  totals: { seconds: number; input: number; output: number; cached: number };
  replacements: number;
  /** Milo speaks aloud in this call (the record's `voice`, cached so a frame does not read the store). */
  voice: boolean;
  /** Set the moment a pause begins and cleared when a session is open again, so no frame is relayed in between. */
  voiceHeld: boolean;
  relay: VoiceRelay;
  /** In front of the relay: a speaking turn nobody asked for is held, then withheld (voice-gate.ts). */
  gate: VoiceGate;
  /** When the last relayed frame ends playing (epoch ms): frames released together after a hold play one after another. 0 when nothing is queued to play. */
  playhead: number;
  /** When the latest heard line that addressed Milo ended (epoch ms; not an echo), or a request was handed to a text session. */
  addressedAt: number;
  /** Tool calls of this session that passed the name lock (the server's own check that the asker addressed Milo). */
  addressedCalls: Set<string>;
  /** When the server last told the session news about addressed work (`tellSession`), epoch ms. */
  newsAt: number;
  speech: AssistantSpeech;
  /** The approved utterance being held whole while the session says it (approved-speech.ts); at most one at a time. */
  approved?: ApprovedHold | null;
  /** What Milo last answered each asker in the chat (held text or a reply): the fixed refusal is not posted twice in a row (`heldRefusal`). */
  lastAnswerTo?: Map<string, string>;
  /** True only while the held frames of a checked approved utterance are being handed to the gate (its reason is then `approved`). */
  releasingApproved?: boolean;
  /** When the provider says the open session ends (epoch ms), or null when it did not say. */
  expiresAt: number | null;
  sessionKind: 'openai' | 'scripted';
  /** Serialises session changes (pause, resume, replacement) so two never overlap. */
  chain: Promise<void>;
  /** Every stored line of this run, in the order it arrived: a tool call is judged only after the lines that came before it are written. */
  lineChain: Promise<void>;
  /** Provider error events across this run's sessions: how many, and the latest few as codes only. */
  providerErrorCount: number;
  /** Transcript pieces judged to be Milo's own voice and not stored. */
  echoLinesDropped: number;
  providerErrors: ProviderErrorInfo[];
  finished: boolean;
}

/**
 * Why a turn waiting on its asker was ended: its time ran out, Milo was paused or its session replaced under it, or Milo left the call
 * (dismissed, its time limit, a lost connection, the call ending) or the service restarted. Each cause has its own words, so nothing
 * that ended because Milo left is ever put on the asker.
 */
export type ExpiryCause = 'timeout' | 'paused' | 'replaced' | 'left' | 'dismissed' | 'limit' | 'lost' | 'restarted';
/** Why Milo's run stopped: the cause its open turns are ended with. */
export type StopReason = Extract<ExpiryCause, 'left' | 'dismissed' | 'limit' | 'lost'>;
export const EXPIRY_WORDS: Readonly<Record<ExpiryCause, { model: string; chat: (name: string) => string; card: string | null }>> = {
  timeout: { model: 'the person who asked is not available', chat: (n) => `${ASSISTANT_NAME} could not finish ${n}'s request because ${n}'s browser did not respond. Ask again.`, card: null },
  paused: { model: `${ASSISTANT_NAME} was paused`, chat: (n) => `${ASSISTANT_NAME} was paused before it could finish ${n}'s request. Ask again once it is listening.`, card: `${ASSISTANT_NAME} was paused before this was done. Ask again once it is listening.` },
  replaced: { model: `${ASSISTANT_NAME}'s session was restarted`, chat: (n) => `${ASSISTANT_NAME}'s session was restarted before it could finish ${n}'s request. Ask again.`, card: `${ASSISTANT_NAME}'s session was restarted before this was done. Ask again.` },
  left: { model: `${ASSISTANT_NAME} has left the call`, chat: (n) => `${ASSISTANT_NAME} left the call before it could finish ${n}'s request.`, card: `${ASSISTANT_NAME} left the call before this was done.` },
  dismissed: { model: `${ASSISTANT_NAME} was dismissed`, chat: (n) => `${ASSISTANT_NAME} was dismissed before it could finish ${n}'s request.`, card: `${ASSISTANT_NAME} was dismissed before this was done.` },
  limit: { model: `${ASSISTANT_NAME} reached its time limit`, chat: (n) => `${ASSISTANT_NAME} reached its time limit before it could finish ${n}'s request.`, card: `${ASSISTANT_NAME} reached its time limit before this was done.` },
  lost: { model: `${ASSISTANT_NAME} lost its connection`, chat: (n) => `${ASSISTANT_NAME} lost its connection before it could finish ${n}'s request.`, card: `${ASSISTANT_NAME} lost its connection before this was done.` },
  restarted: { model: `${ASSISTANT_NAME} was restarted`, chat: (n) => `${ASSISTANT_NAME} was restarted before it could finish ${n}'s request. Ask again once it is listening.`, card: `${ASSISTANT_NAME} was restarted before this ran. Ask again once it is listening.` },
};

/** A request the asker's role does not allow: the call reads the first line, the asker alone the second. */
export const NOT_PERMITTED_PUBLIC = `${ASSISTANT_NAME} can't do that from this call.`;
export const NOT_PERMITTED_PRIVATE = `${ASSISTANT_NAME} did not do that because it needs a permission your role here does not include. Someone who has it can ask ${ASSISTANT_NAME}, or an admin can help.`;
/** What a private read posts when the asker's browser sent no sentence of its own. */
export const PRIVATE_FALLBACK = 'Your answer is in your notifications.';
/** What a private read posts when it did not work. */
export const PRIVATE_FAILED = `${ASSISTANT_NAME} could not get that. Ask again.`;
export const PRIVATE_SAY_MAX = 600;
/** One plain-text line of at most `max` characters: control characters dropped, whitespace collapsed. */
const plainSentence = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const newId = (): string => randomBytes(5).toString('hex');
const capText = (v: unknown, n: number): string => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The kind of a tool call. In a meeting every tool that changes anything goes through a card, whatever the voice catalogue's
 * `confirm` / `noConfirm` flags say (they are for one person's own dock): the catalogue marks a read-only tool with `kind: 'read'`,
 * so any other kind is a write. Decision 6's private list is the other exception.
 */
export function classifyCall(name: string, args: unknown): TurnKind | null {
  const tool = voiceTool(name);
  if (!tool) return null;
  if (tool.kind !== 'read' || tool.confirm) return 'write';
  return isPrivateRead(name, args) ? 'private-read' : 'read';
}

const KIND_LABELS: Readonly<Record<string, string>> = { 'work-item': 'work item', 'saved-search': 'saved search', 'access-request': 'access request' };

/** One argument value in words: scalars as they are, lists joined, nothing cut (the whole call is at most MAX_ARGS_BYTES). */
const argText = (v: unknown): string => (typeof v === 'string' ? v : String(v)).replace(/\s+/g, ' ').trim();

/** Every leaf of the arguments as `path: value`, so the card hides nothing the tool will receive (audit B7). */
function argLines(value: unknown, path: string, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.every((x) => x === null || typeof x !== 'object')) { if (value.length) out.push(`${path}: ${value.map(argText).join(', ')}`); return; }
    value.forEach((x, i) => argLines(x, `${path} ${i + 1}`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) argLines(v, path ? `${path} ${k}` : k, out);
    return;
  }
  out.push(`${path}: ${argText(value)}`);
}

/**
 * A human line and the detail lines for a write's card. Built from the catalogue's own names and the call's own arguments.
 * The detail lists EVERY argument the tool will receive, nested ones included: the asker confirms what they can read.
 * `title` is the record's own name for the card's headline, and `does` what confirming will do in plain words ("Creates a work item");
 * the card adds where it lands. Neither carries a tool name, an id or a `key: value` row.
 */
export function describeCall(name: string, args: unknown): { summary: string; detail: string[]; title?: string; does?: string } {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const fields = a['fields'] && typeof a['fields'] === 'object' && !Array.isArray(a['fields']) ? a['fields'] as Record<string, unknown> : {};
  const detail: string[] = [];
  // The record's own fields first, under their own names; then every other argument.
  argLines(fields, '', detail);
  for (const [k, v] of Object.entries(a)) if (k !== 'fields') argLines(v, k, detail);
  if (name === 'create') {
    const kind = capText(a['kind'], 40), title = capText(fields['title'] ?? fields['name'], 120);
    const label = KIND_LABELS[kind] ?? (kind || 'record');
    return { summary: `Create a ${label}${title ? ` titled "${title}"` : ''}`, detail, ...(title ? { title } : {}), does: `Creates a ${label}` };
  }
  if (name === 'set_status') {
    const status = capText(a['status'], 20), message = capText(a['message'], 120);
    return { summary: `Set your status to ${status || 'a new value'}${message ? `: ${message}` : ''}`, detail };
  }
  // Every other write is said from its own arguments: what will change, on what, to what. The catalogue's `says` line is a
  // sample sentence for the voice dock ("Approving the request"), so it is never the headline: a reject must read as a reject.
  if (name === 'update') return { summary: updateSummary(a, fields), detail };
  if (name === 'decide') return { summary: decideSummary(a), detail };
  if (name === 'queue_work') return { summary: queueSummary(a), detail };
  if (name === 'message') return { summary: messageSummary(a), detail };
  return { summary: 'Make the change that was asked for', detail };
}

/** A record a write names, in words: a name in quotes, a position as a position, a typed reference by its kind only. */
export function recordWords(ref: unknown): string {
  const r = capText(ref, 120);
  if (!r) return 'a record';
  if (/^\d{1,2}$/.test(r)) return `item ${r} of the last list`;
  if (r === 'report:program') return 'the program report';
  const typed = /^([a-z][a-z-]*):[^\s]+$/i.exec(r);
  if (typed) { const k = typed[1]!.toLowerCase(), label = REF_LABELS[k] ?? k.replace(/-/g, ' '); return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`; }
  return `"${r}"`;
}
const REF_LABELS: Readonly<Record<string, string>> = { ...KIND_LABELS, 'hitl-approval': 'pending transaction', 'review-item': 'standing grant', 'runbook-proposal': 'runbook proposal', request: 'access request', dm: 'direct message' };
const shortQuote = (v: unknown, n = 80): string => { const t = capText(v, 2000); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const STATUS_WORDS: Readonly<Record<string, string>> = { in_progress: 'in progress', in_review: 'in review' };
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
function joinClauses(parts: string[]): string {
  const [first, ...rest] = parts;
  if (!first) return '';
  const tail = rest.map(lowerFirst);
  return tail.length ? `${first}${tail.length > 1 ? `, ${tail.slice(0, -1).join(', ')}` : ''} and ${tail.at(-1)}` : first;
}

/** An update in words: "Set "Runbook" to cancelled", "Assign "Runbook" to Ada", "Pause "Nightly digest"". */
function updateSummary(a: Record<string, unknown>, f: Record<string, unknown>): string {
  const what = recordWords(a['ref']);
  const parts: string[] = [];
  const status = capText(f['status'], 20);
  if (status) parts.push(`Set ${what} to ${STATUS_WORDS[status] ?? status.replace(/_/g, ' ')}`);
  const assignee = capText(f['assignee'], 120);
  if (assignee) parts.push(`Assign ${what} to ${/^me$/i.test(assignee) ? 'the person who asked' : assignee}`);
  const sprint = capText(f['sprint'], 80);
  if (sprint) parts.push(/^none$/i.test(sprint) ? `Take ${what} out of its sprint` : `Move ${what} to ${/^this$/i.test(sprint) ? 'the current sprint' : /^next$/i.test(sprint) ? 'the next sprint' : `the sprint "${sprint}"`}`);
  if (typeof f['paused'] === 'boolean') parts.push(`${f['paused'] ? 'Pause' : 'Resume'} ${what}`);
  const reviewed = capText(f['reviewed'], 10);
  if (reviewed) parts.push(`${reviewed === 'reject' ? 'Reject' : 'Accept'} the result of ${what}`);
  if (f['requeued'] === true) parts.push(`Run ${what} again`);
  if (typeof f['member'] === 'boolean') parts.push(`${f['member'] ? 'Join' : 'Leave'} ${what}`);
  if (f['read'] === true) parts.push(`Mark ${what} read`);
  if (f['publish'] === true) parts.push(`Publish ${what}`);
  if (capText(f['response'], 10) && !status) parts.push(`Answer ${what}`);
  return joinClauses(parts) || `Change ${what}`;
}

const DECIDE_VERBS: Readonly<Record<string, string>> = { approve: 'Approve', reject: 'Reject', accept: 'Accept', discard: 'Discard', deliver: 'Deliver', resolve: 'Resolve' };
/** A decision in words, the decision first: "Reject an access request" never reads as an approval. */
function decideSummary(a: Record<string, unknown>): string {
  const what = recordWords(a['ref']);
  const decision = capText(a['decision'], 20).toLowerCase();
  const option = capText(a['option'], 120);
  // A standing grant in an access review: approve keeps it, reject revokes it.
  const grant = /^review-item:/i.test(capText(a['ref'], 120));
  const verb = grant && decision === 'approve' ? 'Keep' : grant && decision === 'reject' ? 'Revoke' : DECIDE_VERBS[decision];
  if (!verb) return `Decide on ${what}`;
  return `${verb} ${what}${option ? ` with the option "${option}"` : ''}`;
}

const QUEUE_WORDS: Readonly<Record<string, (t: string) => string>> = {
  sweep: (t) => `Run the sweep ${t} now`,
  'bot-run': (t) => `Run the bot ${t} now`,
  pipeline: (t) => `Dry-run the runbook ${t}`,
  job: (t) => `Queue the job ${t}`,
  dispatch: (t) => `Dispatch ${t} to an agent`,
  'finding-promote': (t) => `Turn the finding ${t} into a job`,
  'finding-analyze': (t) => `Analyse the finding ${t}`,
  'change-rereview': (t) => `Review the change ${t} again`,
  'change-address': (t) => `Have an agent address the review comments on ${t}`,
  deck: (t) => `Build a status deck on ${t}`,
  summarize: (t) => `Summarise ${t}`,
  diagram: (t) => `Draw a diagram of ${t}`,
  doc: (t) => `Write a document from ${t}`,
  'assessment-run': (t) => `Score the dimensions of ${t}`,
  'draft-evidence': (t) => `Draft an evidence summary for ${t}`,
  'draft-followups': (t) => `Draft follow-ups for ${t}`,
};
/** Queued work in words, by what is queued and on what: "Build a status deck on "Payments"", never the sample sweep. */
function queueSummary(a: Record<string, unknown>): string {
  const kind = capText(a['kind'], 40);
  const rows = Array.isArray(a['rows']) ? a['rows'].filter((n): n is number => typeof n === 'number').slice(0, 10) : [];
  const target = rows.length && a['scope'] === 'this-page' ? `${rows.length === 1 ? 'row' : 'rows'} ${rows.join(', ')} of the page in view` : recordWords(a['target']);
  const base = (QUEUE_WORDS[kind] ?? ((t: string) => `Queue work on ${t}`))(target);
  const model = kind === 'dispatch' ? capText(a['model'], 40) : '';
  const focus = kind === 'deck' ? capText(a['focus'], 120) : '';
  return `${base}${model ? ` on ${model}` : ''}${focus ? `, covering ${focus}` : ''}`;
}

/** A message in words: where it goes and its first words. */
function messageSummary(a: Record<string, unknown>): string {
  const text = shortQuote(a['text']);
  const said = text ? `: "${text}"` : '';
  if (capText(a['thread'], 200)) return `Reply in the thread${said}`;
  const t = a['target'] && typeof a['target'] === 'object' && !Array.isArray(a['target']) ? a['target'] as Record<string, unknown> : {};
  const kind = capText(t['kind'], 10), to = capText(t['name'], 120);
  if (kind === 'dm' && to) return `Send ${to} a direct message${said}`;
  if (kind === 'team' && to) return `Post to the team ${to}${said}`;
  if (to) return `Post in #${to.replace(/^#/, '')}${said}`;
  return `Send a message${said}`;
}

/** A piece's session-relative times as offsets on the call's own timeline (CallRun.callStartedAt), never below 0. */
export function callOffsets(run: { sessionStartedAt: number; callStartedAt: number }, e: { startMs: number; endMs: number }): { startMs: number; endMs: number } {
  const shift = run.sessionStartedAt - run.callStartedAt;
  const startMs = Math.max(0, e.startMs + shift);
  return { startMs, endMs: Math.max(startMs, e.endMs + shift) };
}

/** An approved utterance in flight: what was asked, the session asked, and its frames, held in memory only until it is checked. */
interface ApprovedHold {
  id: string;
  text: string;
  session: LiveMeetingSession;
  frames: Array<{ pcm: Buffer; last: boolean }>;
  /** The bound: withheld whole when the utterance is not complete by then. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Checked and going out (the bound no longer applies). */
  releasing: boolean;
  finish: (outcome: SayOutcome, why: SayWithheldWhy | 'relayed') => void;
}


/** How far ahead of its playout an approved utterance is queued on the relay (2 s: under the relay's 3 s cap). */
const APPROVED_AHEAD_FRAMES = 20;

export class AssistantRuntime {
  private readonly runs = new Map<string, CallRun>();
  private saySeq = 0;
  /** Per call, the stops and leaves still finishing (a run's `stop`, a dismissal's follow-up): `settled` waits for them. */
  private readonly stopping = new Map<string, Set<Promise<void>>>();
  private readonly extending = new Map<string, Promise<void>>();
  private subscribedTo: LineIntake | null = null;
  private unsubscribeIntake: (() => void) | null = null;
  private unsubscribeLines: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly deps: RuntimeDeps, private readonly opts: { tickMs?: number } = {}) {}

  private get store(): AssistantStore { return this.deps.store(); }
  get proposalDeps(): ProposalRunDeps {
    return {
      store: this.store, now: () => this.now(), rolesOf: this.deps.rolesOf, nameOf,
      actionAllowed: this.deps.actionAllowed ?? defaultActionAllowed, mayDecide: this.deps.mayDecide ?? defaultMayDecide,
    };
  }

  /** A proposal of the call became consented (or was taken over): make the executor's turn (proposal-run.ts). */
  async startProposal(callId: string, proposalId: string): Promise<AssistantTurn | null> {
    return startProposal(this.proposalDeps, callId, proposalId);
  }
  private now(): number { return this.deps.clock(); }
  private wait(ms: number): Promise<void> {
    return this.deps.wait ? this.deps.wait(ms) : new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
  }

  isRunning(callId: string): boolean { const r = this.runs.get(callId); return !!r && !r.finished; }

  /**
   * Resolves true once the call has no run in this process, live or stopping, and no leave still finishing (its settlement and its audio
   * released); false when that takes longer than `timeoutMs` (wall clock). An invitation back waits for this before it books anything.
   * With `period`, a live run already serving that period or a later one does not count: it is a concurrent invitation back's, not one
   * that is leaving.
   */
  async settled(callId: string, timeoutMs: number, period?: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pause = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });
    for (;;) {
      const pending = this.stopping.get(callId);
      const run = this.runs.get(callId);
      const leaving = !!run && (run.finished || period === undefined || run.period < period);
      if (!leaving && !pending?.size) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      // A stop in flight is awaited; a live run whose record already left (its stop not begun yet) is looked at again shortly.
      await Promise.race([pending?.size ? Promise.allSettled([...pending]).then(() => undefined) : pause(25), pause(left)]);
    }
  }

  /** Without waiting: whether an earlier period's run (or its leave) is still finishing, as `settled` would wait for. The bar then says so. */
  stillLeaving(callId: string, period?: number): boolean {
    const run = this.runs.get(callId);
    return (!!run && (run.finished || period === undefined || run.period < period)) || !!this.stopping.get(callId)?.size;
  }

  /** Track `work` as a stop or leave of the call that is still finishing, until it ends (whatever the outcome). */
  private holdStopping(callId: string, work: Promise<void>): Promise<void> {
    let set = this.stopping.get(callId);
    if (!set) { set = new Set(); this.stopping.set(callId, set); }
    const tracked: Promise<void> = work.finally(() => {
      const current = this.stopping.get(callId);
      current?.delete(tracked);
      if (current && !current.size) this.stopping.delete(callId);
    });
    set.add(tracked);
    return tracked;
  }
  hasSession(callId: string): boolean { return !!this.runs.get(callId)?.session; }
  /** Tests and the dev route: the scripted session of a call, if that is what it has. */
  sessionOf(callId: string): LiveMeetingSession | null { return this.runs.get(callId)?.session ?? null; }

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Start the live session for a call. Throws when the session cannot start; nothing is left running then. A live run of the same period
   * makes this a no-op; a run that is stopping, one of another period, or a leave still finishing throws `RunStillStopping`.
   */
  async start(ctx: StartContext): Promise<void> {
    const existing = this.runs.get(ctx.callId);
    if (existing && !existing.finished && !this.stopping.get(ctx.callId)?.size && (ctx.period === undefined || ctx.period === existing.period)) return;
    if (existing || this.stopping.get(ctx.callId)?.size) throw new RunStillStopping(ctx.callId);
    this.watchIntake();
    const call: PolicyCall = { callId: ctx.callId, lobby: ctx.lobby ?? null, tenant: ctx.tenant };
    const run: CallRun = {
      ctx, call, policy: policyForLobby(call.lobby), period: ctx.period ?? 1, session: null, unsubscribers: [], sessionStartedAt: 0, callStartedAt: this.now(), sessionNo: 0, pieceNo: 0, lastLineAt: 0, lastLineSeq: 0, delegationSeq: 0, inputNo: 0, inputEndAt: new Map(), lineInput: new Map(), lagSamples: [], readyMessages: [], timeline: new VoicedTimeline(),
      calls: new Map(), turnCalls: new Map(), requestCalls: new Map(), typedNoticed: new Set(), typedPausedNoticed: new Set(), holding: new Set(), reply: null, replyById: new Map(), callTimes: new Map(), answeredLines: new Set(), claimedLines: new Map(), delegations: [], lastUnaskedNoticeAt: -Infinity, attendanceAt: -Infinity, heartbeatAt: -Infinity,
      intentionalClose: false, heardAt: -Infinity, transcribedAt: -Infinity, watchFrom: this.now(), deaf: null, usageSeconds: 0, tokens: { input: 0, output: 0, cached: 0 },
      totals: { seconds: 0, input: 0, output: 0, cached: 0 }, replacements: 0, voice: false, voiceHeld: false,
      relay: new VoiceRelay(ctx.callId, voiceChannel(ctx.callId), () => this.deps.voiceSink ?? defaultVoiceSink), gate: null as unknown as VoiceGate, playhead: 0, addressedAt: -Infinity, addressedCalls: new Set(), newsAt: -Infinity, speech: new AssistantSpeech(), expiresAt: null, sessionKind: 'scripted', chain: Promise.resolve(), lineChain: Promise.resolve(), providerErrorCount: 0, echoLinesDropped: 0, providerErrors: [], finished: false,
    };
    run.gate = this.makeGate(run);
    this.runs.set(ctx.callId, run);
    // The record's switch (a restarted call keeps it) and its period; read after the run is registered so two invites never both start.
    try {
      const record = await this.store.get(ctx.callId);
      run.voice = record?.voice === true;
      if (record) run.callStartedAt = record.invitedAt;
      if (record && ctx.lobby === undefined) { run.call = { ...call, lobby: record.lobby }; run.policy = policyForLobby(record.lobby); }
      if (ctx.period === undefined && record) run.period = periodOf(record);
    } catch { /* off, period 1 */ }
    try { await this.openSession(run, []); } catch (e) { this.runs.delete(ctx.callId); throw e; }
    await this.openListening(ctx.callId);
    this.deps.watcher?.start(ctx.callId);
    this.armTimer();
  }

  /** A listening period begins (a no-op when one is open, or when there is no record yet: the invite writes it with the period open). */
  private async openListening(callId: string): Promise<void> {
    const record = await this.store.get(callId);
    if (record && record.state === 'listening' && sessionOf(record).listeningSince == null) await this.store.patchSession(callId, { listeningSince: this.now() });
  }

  /** The open listening period ends: its seconds join the total. With `period`, only while the record is still in that period. */
  private async closeListening(callId: string, period?: number): Promise<void> {
    const record = await this.store.get(callId);
    if (!record) return;
    if (period !== undefined && periodOf(record) !== period) return;
    const s = sessionOf(record);
    if (s.listeningSince == null) return;
    await this.store.patchSession(callId, { listeningSeconds: currentListeningSecondsOf(record, this.now()), listeningSince: null }, period !== undefined ? { period } : undefined);
  }

  async pause(callId: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    run.voiceHeld = true; this.dropVoice(run, true); // nothing is relayed (or held) from the moment a pause begins
    this.deps.watcher?.pause(callId); // no wait or check carries across a pause
    await this.serial(run, async () => { await this.closeSession(run, 'pause'); run.reply = null; run.replyById.clear(); });
    await this.closeListening(callId, run.period);
  }

  async resume(callId: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    run.typedNoticed.clear(); run.typedPausedNoticed.clear(); // a new listening stretch: each person is told again, once
    await this.serial(run, async () => {
      if (run.session) return;
      await this.openSession(run, await this.recentLines(callId));
    });
    run.voiceHeld = false;
    await this.openListening(callId);
  }

  /**
   * Dismissed or left: close the session, expire what is open (each with the words for `reason`), tell the spend settlement.
   * Idempotent; the first call's reason is the one used. Until it has finished (the settlement included) the call counts as stopping
   * (`settled`, `start`). What it writes on the record (the closed clock, the usage, the settlement) holds only while the record is still in
   * the run's period, so even a stop that ends after Milo was invited back cannot touch the newer period.
   */
  async stop(callId: string, reason: StopReason = 'left'): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    run.finished = true; this.dropVoice(run, true);
    this.deps.watcher?.stop(callId);
    // Whatever a step before it throws, the audio and the tap are released and the settlement is told: money is booked once, here.
    const guarded = async (step: () => Promise<void>): Promise<void> => {
      try { await step(); } catch (e) { console.warn('[meeting-assistant] stop step failed', (e as Error).message); }
    };
    await this.holdStopping(callId, (async () => {
      try {
        await guarded(() => this.serial(run, async () => { await this.closeSession(run, 'stop'); }));
        await guarded(() => this.expireOpenTurns(run, false, reason));
        await guarded(() => this.closeListening(callId, run.period));
      } finally {
        this.deps.audio?.detach(callId);
        if (this.runs.get(callId) === run) this.runs.delete(callId);
        if (!this.runs.size) this.disarmTimer();
        await this.deps.onFinished?.({
          callId, usageSeconds: run.totals.seconds, tokens: { input: run.totals.input, output: run.totals.output, cached: run.totals.cached }, sessionKind: run.sessionKind, period: run.period,
        });
      }
    })());
  }

  /**
   * What follows a pause or a dismiss, whoever caused it: the Pause or Dismiss button (the route) or "Milo, pause" / "Milo, leave"
   * said in the call (the intake moved the record). One path for both, so they cannot drift: the named notice in the chat, and for a
   * dismiss the open proposals closed and moved to the meeting page, the people they still need who are absent told, the run stopped
   * (its open requests ended as "dismissed"), the used minutes settled and the audio bindings dropped. `record` is the moved record.
   */
  async afterMove(callId: string, to: 'paused' | 'left', record: AssistantRecord, by: { userId: string; name?: string }): Promise<void> {
    const who = await nameOf(by.userId, by.name);
    if (to === 'paused') {
      await this.pause(callId);
      await postNoticeQuietly(callId, noticeText.paused(who));
      return;
    }
    // The whole leave counts as stopping until its last step: an invitation back waits for it (`settled`), so none of these steps runs
    // against the newer period; and each step that writes is conditional on the period that left anyway.
    const period = periodOf(record);
    await this.holdStopping(callId, (async () => {
      await postNoticeQuietly(callId, noticeText.dismissed(who, record.linesStored === 0), { leaving: true });
      await closeProposals(this.store, callId, record.leftAt ?? this.now()).catch(() => 0); // open proposals wait 72 hours on the meeting page
      await notifyOpenProposals(this.store, callId).catch(() => 0); // the people they still need who are not in the call are told, without the statement
      this.deps.intake().stop(callId);
      await this.stop(callId, 'dismissed');
      // No run in this process (it died): the used minutes are booked from the record. A settled record is left alone.
      await (await import('./reconcile.js')).settleFromRecord(callId, { store: () => this.store, clock: () => this.now(), period });
      const now = await this.store.get(callId).catch(() => null);
      if (!now || (now.state === 'left' && periodOf(now) === period)) this.deps.audio?.forget?.(callId);
    })());
  }

  async dispose(): Promise<void> {
    this.disarmTimer();
    this.unsubscribeIntake?.(); this.unsubscribeIntake = null; this.unsubscribeLines?.(); this.unsubscribeLines = null; this.subscribedTo = null;
    this.deps.watcher?.dispose();
    for (const id of [...this.runs.keys()]) {
      const run = this.runs.get(id)!;
      run.finished = true;
      try { await this.closeSession(run, 'stop'); } catch { /* shutting down */ }
      this.runs.delete(id);
    }
  }

  private serial(run: CallRun, fn: () => Promise<void>): Promise<void> {
    const next = run.chain.then(fn, fn);
    run.chain = next.catch(() => undefined);
    return next;
  }

  private watchIntake(): void {
    const intake = this.deps.intake();
    if (this.subscribedTo === intake) return;
    this.unsubscribeIntake?.();
    this.subscribedTo = intake;
    const offEvents = intake.onEvents((callId, events, applied) => this.onDetector(callId, events, applied));
    // A spoken dismiss: whoever holds a seat is recorded as present before the record becomes `left` (as the Dismiss button does).
    const offLeave = intake.onBeforeDismiss(async (callId) => { if (this.isRunning(callId)) await this.snapshotAttendance(callId); });
    this.unsubscribeIntake = () => { offEvents(); offLeave(); };
    this.unsubscribeLines?.();
    this.unsubscribeLines = this.deps.watcher ? intake.onStored((line) => { if (this.isRunning(line.callId)) this.deps.watcher?.onLine(line); }) : null;
  }

  private armTimer(): void {
    const ms = this.opts.tickMs ?? 1000;
    if (this.timer || ms <= 0) return;
    this.timer = setInterval(() => { void this.tick().catch((e: unknown) => console.warn('[meeting-assistant] tick failed', (e as Error).message)); }, ms);
    this.timer.unref?.();
  }
  private disarmTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // -------------------------------------------------------------------------------------------------------------
  // The session

  private async recentLines(callId: string) {
    const record = await this.store.get(callId);
    if (!record) return [];
    const lines = await this.store.lines(callId, Math.max(0, record.nextSeq - 1 - RECENT_TRANSCRIPT_LINES), RECENT_TRANSCRIPT_LINES);
    const floor = this.now() - RECENT_TRANSCRIPT_MS;
    // The context shows people by display name, whatever the source put in `speakerName`; only lines the policy lets models read.
    const recent = await linesForModels(record, lines.filter((l) => l.at >= floor));
    return Promise.all(recent.map(async (l) => (l.userId && (!l.speakerName || l.speakerName === l.userId) ? { ...l, speakerName: await nameOf(l.userId) } : l)));
  }

  private async openSession(run: CallRun, recent: Awaited<ReturnType<AssistantRuntime['recentLines']>>): Promise<void> {
    const session = this.deps.makeSession(this.deps.clock);
    if (!session) throw new Error('no live session is available in this process');
    run.sessionNo += 1; run.pieceNo = 0; run.lastLineAt = 0; run.lastLineSeq = 0; run.delegationSeq = 0; run.inputNo = 0; run.inputEndAt = new Map(); run.lineInput = new Map(); run.lagSamples = []; run.readyMessages = []; run.timeline = new VoicedTimeline();
    run.usageSeconds = 0; run.tokens = { input: 0, output: 0, cached: 0 };
    run.calls = new Map(); run.addressedCalls = new Set(); this.dropVoice(run, false); run.turnCalls = new Map(); run.holding = new Set(); run.reply = null; run.replyById = new Map(); run.callTimes = new Map(); run.answeredLines = new Set(); run.claimedLines = new Map(); run.delegations = []; run.intentionalClose = false;
    run.expiresAt = null;
    this.wire(run, session);
    run.sessionKind = session.kind;
    await session.start({
      // A call whose policy relays nothing the model says on its own (an interview) tells the model so: it never answers anyone,
      // it only reads the lines the system hands it. Otherwise its own reply to a request runs over the line handed it to read.
      instructions: meetingInstructions({ tenant: run.ctx.tenant, roster: run.ctx.roster, recordName: run.ctx.recordName, recent, readAloudOnly: !run.policy.relaysLiveSpeech(run.call) }),
      ...run.policy.sessionTools(run.call),
    });
    run.session = session;
    run.sessionStartedAt = this.now();
    run.heartbeatAt = -Infinity; // the first tick writes one at once
    run.watchFrom = run.sessionStartedAt; // a new session is given its own minute
    // The mixer's clock starts with the session's: its frames are the provider's audio timeline, and the timeline below is fed on it.
    this.deps.audio?.attach(run.ctx.callId, {
      append: (pcm) => { try { run.session?.appendAudio(pcm); } catch { /* the close handler reports it */ } },
      placed: (userId, pcm, atMs) => {
        run.heardAt = this.now();
        if (run.deaf?.kind === 'audio') run.deaf = null;
        run.timeline.feed(userId, pcm, OUT_RATE, atMs);
      },
    });
  }

  /** Close the current session on purpose; fold its usage into the totals; expire reads that were waiting on it. */
  private async closeSession(run: CallRun, why: 'pause' | 'stop'): Promise<void> {
    // Paused or left: the audio token dies with the session, before anything else. Also with no session open (a replacement
    // under way when the ceiling is reached), so a tap never outlives the call's stop.
    this.deps.audio?.detach(run.ctx.callId);
    run.deaf = null; // a resume arms a new tap and opens a new session: any stall is watched afresh
    const session = run.session;
    if (!session) return;
    run.intentionalClose = true;
    run.session = null;
    try { await session.close(); } catch (e) { console.warn('[meeting-assistant] session close failed', (e as Error).message); }
    this.foldUsage(run);
    for (const off of run.unsubscribers.splice(0)) off();
    // A read waiting on its asker has no session to answer now; a write behind its card does not need one.
    if (why === 'pause') await this.expireOpenTurns(run, true, 'paused');
  }

  private foldUsage(run: CallRun): void {
    run.totals.seconds += run.usageSeconds; run.totals.input += run.tokens.input; run.totals.output += run.tokens.output; run.totals.cached += run.tokens.cached;
    run.usageSeconds = 0; run.tokens = { input: 0, output: 0, cached: 0 };
    void this.store.patchSession(run.ctx.callId, { sessionKind: run.sessionKind, usageSeconds: run.totals.seconds, tokensIn: run.totals.input, tokensOut: run.totals.output, tokensCached: run.totals.cached }, { period: run.period }).catch(() => undefined);
  }

  private wire(run: CallRun, session: LiveMeetingSession): void {
    const guard = <E>(fn: (e: E) => Promise<void> | void) => (e: E) => {
      void Promise.resolve().then(() => fn(e)).catch((err: unknown) => console.warn('[meeting-assistant] session event failed', (err as Error).message));
    };
    run.unsubscribers.push(
      session.on('inputTranscript', guard((e: SessionEvents['inputTranscript']) => this.onInput(run, e))),
      session.on('outputTranscript', guard((e: SessionEvents['outputTranscript']) => this.onOutput(run, e))),
      session.on('toolCall', guard((e: SessionEvents['toolCall']) => this.onToolCall(run, e))),
      session.on('usage', (e) => {
        run.usageSeconds = Math.max(run.usageSeconds, e.seconds);
        if (e.backendTokens) run.tokens = { input: e.backendTokens.inputTokens, output: e.backendTokens.outputTokens, cached: e.backendTokens.cachedTokens };
      }),
      // The moment the model began working on a request, kept until a function call takes it (a scripted session names its asker).
      session.on('delegation', (e) => {
        if (session.kind === 'scripted') return;
        const at = run.sessionStartedAt + e.atMs;
        // Judged once every line heard before the delegation is stored (the provider flushes the request line just before it).
        const d: Delegation = { at, judgeAt: at, lastSeq: null, readyAt: null, item: null, acknowledged: false, answered: false, callId: null, asker: Promise.resolve({ userId: null, seq: null }) };
        // The request line was emitted just before this event, and its write is queued on the next microtask (`guard`): wait
        // one microtask before reading the chain, so the chain read already holds it.
        d.asker = Promise.resolve().then(() => run.lineChain).then(() => {
          // Read at once, before any line heard after the delegation is stored (those are chained behind this one).
          d.judgeAt = Math.max(at, Math.min(run.lastLineAt, at + DELEGATION_LINE_SKEW_MS));
          const turn = { fromSeq: run.delegationSeq, toSeq: run.lastLineSeq };
          // (Lines this session stored itself; when it stored none, the time rule below is used.)
          d.lastSeq = run.lastLineSeq > 0 ? run.lastLineSeq : null;
          run.delegationSeq = run.lastLineSeq;
          return this.findAsker(run.ctx.callId, d.judgeAt, turn);
        }).then((f) => (f.ok ? { userId: f.userId, seq: f.seq } : { userId: null, seq: null }), () => ({ userId: null, seq: null }));
        run.delegations.push(d);
        trace('delegation', { at });
        if (run.delegations.length > MAX_DELEGATIONS) run.delegations.shift();
      }),
      session.on('messageReady', (e) => {
        if (session.kind === 'scripted') return;
        run.readyMessages.push(run.sessionStartedAt + e.atMs);
        if (run.readyMessages.length > MAX_DELEGATIONS) run.readyMessages.shift();
        run.gate.poke();
      }),
      session.on('delegationReady', (e) => {
        if (session.kind === 'scripted') return;
        const d = run.delegations[run.delegations.length - 1];
        if (!d || d.readyAt !== null) return;
        d.readyAt = run.sessionStartedAt + e.atMs; d.item = e.item;
        trace('delegation.ready', { at: d.at, readyAt: d.readyAt, item: e.item });
      }),
      session.on('outputAudio', (e) => this.onOutputAudio(run, session, e)),
      session.on('outputTranscript', (e) => {
        // An approved utterance's words wait, unheard, for its frames: they join the span its release opens (the echo guard).
        if (e.say !== undefined) { if (run.voice && run.approved?.id === e.say) run.speech.noteText(this.now(), e.text, e.final, true); return; }
        // Words for frames the gate holds wait for those frames; words for a withheld turn were never heard and are dropped.
        const g = run.gate.phase();
        if (run.voice && g !== 'dropping') run.speech.noteText(this.now(), e.text, e.final, g === 'held');
      }),
      session.on('expires', (e) => { run.expiresAt = e.atMs; }),
      session.on('closed', guard((e: SessionEvents['closed']) => this.onClosed(run, session, e.reason))),
      session.on('error', (e) => {
        console.warn('[meeting-assistant] session error', e.info?.code ?? e.message);
        run.providerErrorCount += 1;
        if (e.info) { run.providerErrors.push(e.info); if (run.providerErrors.length > MAX_PROVIDER_ERRORS) run.providerErrors.shift(); }
      }),
    );
  }

  private async onClosed(run: CallRun, session: LiveMeetingSession, reason: string): Promise<void> {
    if (run.intentionalClose || run.finished || run.session !== session) return;
    // An unexpected close (decision 11): replace the session with the last minutes of the call as context, a few times at most.
    run.session = null;
    this.dropVoice(run, false); // what the lost session was saying is never finished
    this.deps.audio?.suspend(run.ctx.callId); // the tap stays, its audio waits for the new session (and its time base)
    this.foldUsage(run);
    for (const off of run.unsubscribers.splice(0)) off();
    await this.expireOpenTurns(run, true, 'replaced');
    await this.reopen(run, reason, true);
  }

  /**
   * Milo has no session and the call still wants one: open a replacement with the last minutes as context. An unexpected close
   * counts against MAX_REPLACEMENTS; the planned replacement before the provider's expiry does not.
   */
  private async reopen(run: CallRun, reason: string, counted: boolean): Promise<void> {
    const record = await this.store.get(run.ctx.callId);
    if (!record || record.state !== 'listening') return;
    if (counted) {
      if (run.replacements >= MAX_REPLACEMENTS) { await this.giveUp(run); return; }
      run.replacements += 1;
      await this.store.patchSession(run.ctx.callId, { replacements: run.replacements });
    }
    console.warn(`[meeting-assistant] replacing session for ${run.ctx.callId} (${reason})${counted ? `, replacement ${run.replacements}` : ''}`);
    // The first attempt is at once; a failed one is retried after 1, 3 and 9 seconds (audit B9). The waits run OUTSIDE the
    // serial chain, so a pause or a dismiss is never held up behind them, and each attempt re-checks that it is still wanted.
    for (let attempt = 0; attempt <= REPLACEMENT_RETRY_MS.length; attempt += 1) {
      if (attempt > 0) await this.wait(REPLACEMENT_RETRY_MS[attempt - 1]!);
      if (run.finished || run.session) return;
      const now = await this.store.get(run.ctx.callId);
      if (!now || now.state !== 'listening') return;
      let opened = false;
      await this.serial(run, async () => {
        if (run.finished) return;
        if (run.session) { opened = true; return; }
        try { await this.openSession(run, await this.recentLines(run.ctx.callId)); opened = true; } catch (e) {
          for (const off of run.unsubscribers.splice(0)) off();
          console.warn('[meeting-assistant] replacement failed', (e as Error).message);
        }
      });
      if (opened || run.finished) return;
    }
    await this.giveUp(run);
  }

  /**
   * Close the open session on purpose and open a fresh one with the same context, through the replacement path an unexpected close
   * takes. Waiting reads expire, as for a pause. Before the provider's expiry it is planned and not counted against the cap; a deaf
   * session (`checkHearing`) is a fault and is counted, so a session that keeps coming back deaf ends in giveUp.
   */
  private async replaceSession(run: CallRun, reason: string, counted: boolean): Promise<void> {
    let closed = false;
    await this.serial(run, async () => {
      const session = run.session;
      if (!session || run.finished) return;
      closed = true;
      run.intentionalClose = true;
      run.session = null;
      this.deps.audio?.suspend(run.ctx.callId); // the tap stays; its audio waits for the new session
      try { await session.close(); } catch (e) { console.warn('[meeting-assistant] session close failed', (e as Error).message); }
      this.foldUsage(run);
      for (const off of run.unsubscribers.splice(0)) off();
      await this.expireOpenTurns(run, true, 'replaced');
    });
    if (closed && !run.finished) await this.reopen(run, reason, counted);
  }

  /** Milo has no session and cannot get one: leave with a notice, stop intake and audio, settle spend and write the minutes (once). */
  private async giveUp(run: CallRun): Promise<void> {
    const callId = run.ctx.callId;
    await this.snapshotAttendance(callId);
    const done = await this.store.transition(callId, { from: ['listening'], to: 'left', by: 'system', at: this.now() });
    if (!done) return;
    await postNoticeQuietly(callId, `${ASSISTANT_NAME} lost its connection and has left this call.`, { leaving: true });
    this.deps.intake().stop(callId);
    this.deps.audio?.detach(callId);
    await this.stop(callId, 'lost');
  }

  // -------------------------------------------------------------------------------------------------------------
  // Milo's voice (package 7a)

  /** The call's voice switch changed (the route wrote the record first). Turning it off drops what is queued. */
  setVoice(callId: string, on: boolean): void {
    const run = this.runs.get(callId);
    if (!run) return;
    run.voice = on;
    if (!on) this.dropVoice(run, true);
  }

  /** What the voice relay did on this run: frames handed to the gateway, and frames dropped (no gateway, a burst, a pause). Zeros when no run. */
  /** Counts the people who hold a seat may see: provider errors this run has had (codes are never shown). */
  callStats(callId: string): { providerErrors: number; echoLinesDropped: number } {
    const run = this.runs.get(callId);
    return { providerErrors: run?.providerErrorCount ?? 0, echoLinesDropped: run?.echoLinesDropped ?? 0 };
  }

  /** Read-only, for the state view: true while this call's run has an open session, false while it is between sessions (a reconnect), null with no run here. */
  sessionOpen(callId: string): boolean | null {
    const run = this.runs.get(callId);
    if (!run || run.finished) return null;
    return run.session !== null;
  }

  voiceStats(callId: string): { voiceFramesRelayed: number; voiceFramesDropped: number; voiceFramesWithheld: number; voiceUtterancesWithheld: number } {
    const run = this.runs.get(callId);
    return {
      voiceFramesRelayed: run?.relay.relayed ?? 0, voiceFramesDropped: run?.relay.dropped ?? 0,
      voiceFramesWithheld: run?.gate.withheldFrames ?? 0, voiceUtterancesWithheld: run?.gate.withheldUtterances ?? 0,
    };
  }

  /**
   * One frame of what Milo said aloud. Relayed only while the call's voice is on, the call is listening (this session is the open
   * one and no pause has begun) and the run has not ended; otherwise it is simply not sent (and not counted: it never was audio for
   * anyone). The provider sends voiced frames only (live-session.ts), so nothing flows while the model is quiet.
   *
   * WHAT MAY BE SPOKEN: only speech someone asked for. The model is told to stay silent unless addressed, but it does not always, and
   * its audio arrives long before the utterance's transcript is final (the chat side drops an unprompted remark; that comes too late
   * for the voice). So every speaking turn passes the gate (voice-gate.ts), which decides at its first frame and holds that decision
   * for the whole turn, through the pauses between its sentences, until Milo has been silent for a gap. It goes out at once when
   * someone addressed Milo in the last VOICE_PROMPT_WINDOW_MS (a heard line by the
   * detector's own rule, an echo of Milo excluded, including what the session has heard but not yet flushed), or when Milo has
   * addressed work in flight (a tool call that passed the name lock and is still open, a live PUBLIC reply context, or the second
   * model's message ready and unspoken; a muted context never counts). Otherwise it is held, unsent and in memory only, for at most
   * VOICE_GATE_HOLD_MS while the reason may still arrive (the provider often speaks before it flushes the request's transcript), then
   * released in order or withheld whole. Nothing is filtered by content: after audit repair B2 a private answer never reaches the
   * shared session, so what is asked for is safe to hear. Milo counts as heard (the echo guard) only for frames actually relayed, each
   * at the moment it plays: a burst released after a hold plays 100 ms a frame from the release on, so its tail is heard (and may
   * echo) up to the hold's length later than its frames were sent.
   */
  private onOutputAudio(run: CallRun, session: LiveMeetingSession, e: SessionEvents['outputAudio']): void {
    // Approved speech (sayHeldText): the frames of the utterance asked for are held whole, unsent, until its transcript is checked;
    // a frame tagged for any other request is dropped; and while one is outstanding nothing else the session says is relayed.
    if (e.say !== undefined) {
      const a = run.approved;
      if (a && a.id === e.say && !a.releasing && a.session === session && run.session === session) a.frames.push({ pcm: e.pcm, last: e.last === true });
      return;
    }
    if (run.approved) return;
    if (!run.voice || run.voiceHeld || run.finished || run.session !== session || !run.policy.relaysLiveSpeech(run.call)) return;
    run.gate.frame(e.pcm, e.last === true);
  }

  private makeGate(run: CallRun): VoiceGate {
    return new VoiceGate({
      now: () => this.now(),
      allowed: () => this.voiceWanted(run),
      send: (pcm, last) => {
        if (!run.voice || run.voiceHeld || run.finished || !run.session) return;
        // Playout: a frame plays once the frames before it have (a released burst plays over its length, not at the instant it went).
        const playAt = Math.max(this.now(), run.playhead);
        run.speech.noteFrame(playAt);
        run.playhead = playAt + VOICE_FRAME_MS;
        run.relay.push(pcm, last);
      },
      decided: (decision, heldMs, why) => {
        if (decision === 'withheld') run.speech.forgetUnheard();
        trace('voice', { decision, heldMs, why });
      },
    });
  }

  /** Forget what Milo was about to say: the gate's held frames and its words for them; with `relay`, also what is queued to go out (and its playout). */
  private dropVoice(run: CallRun, relay: boolean): void {
    run.approved?.finish('posted', 'voice-off');
    if (relay) { run.relay.clear(); run.playhead = 0; }
    run.gate.clear();
    run.speech.forgetUnheard();
  }

  /** Tell the session news about addressed work (a write done, failed, declined or expired): what Milo says about it next is wanted. */
  private tellSession(run: CallRun | null | undefined, text: string): void {
    if (!run?.session?.appendContext(text)) return;
    run.newsAt = this.now();
    run.gate.poke();
  }

  /** Why Milo's voice is wanted right now (the gate's two conditions), or null when nobody asked. */
  private voiceWanted(run: CallRun): VoiceGateWhy | null {
    // 0. An approved utterance, checked whole, is being let through (sayHeldText): the only reason it opens for.
    if (run.releasingApproved) return 'approved';
    const now = this.now();
    // 1. Someone addressed Milo just now, or is addressing it now (heard, not yet flushed).
    if (now - run.addressedAt <= VOICE_PROMPT_WINDOW_MS) return 'addressed';
    const pending = run.session?.pendingInputText() ?? '';
    if (pending && findAddress(pending) !== null && !(run.voice && run.speech.isEcho({ text: pending, startAt: now, endAt: now }))) return 'hearing';
    // 2. Addressed work in flight.
    for (const id of run.addressedCalls) if (run.calls.get(id) === 'open') return 'call';
    const c = run.reply;
    if (c && c.visibility === 'public' && this.contextLive(c, now)) return 'reply';
    if (now - run.newsAt < REPLY_CONTEXT_TTL_MS) return 'reply';
    // The second model's words belong to the latest answer: after a muted one (a private or refused call) they open nothing.
    const mutedNow = !!c && c.visibility === 'muted' && this.contextLive(c, now);
    if (!mutedNow && run.readyMessages.some((m) => m <= now && now - m < ASKER_WINDOW_MS)) return 'message';
    return null;
  }

  /**
   * Say words the SERVER holds aloud in this call, on its own live session, through its own gate and relay (interviews decision 9):
   * an approved question, a repeat of it, the time left, the one fixed refusal. The caller has already logged the words and posted
   * them in the call chat. The session is asked to say `text` verbatim; the utterance it produces is held whole until the session's
   * transcript of it is complete and equals `text` (approved-speech.ts), then released through the call's VoiceGate with the reason
   * `approved`; on any difference, no words, no audio or no answer inside `sayBoundMs`, it is withheld whole. `spoken` only when
   * frames were relayed; `posted` (chat only) when the voice is off, Milo is paused, the session cannot say verbatim, another approved
   * utterance is outstanding, or it was withheld; `no-call` when Milo has no run in this call. Never throws.
   */
  async sayHeldText(callId: string, text: string, by: string): Promise<SayOutcome> {
    return (await this.sayHeldTextWhy(callId, text, by)).outcome;
  }

  /** `sayHeldText` with why the words were not relayed, for a caller that tells the asker (interviews' "Have Milo ask" receipt). */
  async sayHeldTextWhy(callId: string, text: string, by: string): Promise<SayResult> {
    void by; // who asked is the caller's log row; the trace carries codes only
    const run = this.runs.get(callId);
    if (!run || run.finished) return { outcome: 'no-call', why: null };
    const session = run.session;
    const words = text.trim().slice(0, 1500);
    const early: SayWithheldWhy | null = !words ? 'empty' : !session?.sayVerbatim ? 'no-say' : !run.voice ? 'voice-off' : run.voiceHeld ? 'paused' : run.approved ? 'busy' : null;
    if (early || !session?.sayVerbatim) { trace('voice.approved', { decision: 'chat', why: early ?? 'no-say' }); return { outcome: 'posted', why: early ?? 'no-say' }; }
    this.saySeq += 1;
    const id = `say_${this.saySeq}`;
    return new Promise<SayResult>((resolve) => {
      const hold: ApprovedHold = {
        id, text: words, session, frames: [], timer: null, releasing: false,
        finish: (outcome, why) => {
          if (run.approved !== hold) return;
          run.approved = null;
          if (hold.timer) clearTimeout(hold.timer);
          if (outcome !== 'spoken') run.speech.forgetUnheard();
          // Given up: the session forgets the request, so it cannot claim a later utterance (whose frames would then be dropped).
          if (outcome !== 'spoken') { try { session.cancelSay?.(id); } catch { /* best effort */ } }
          trace('voice.approved', { decision: outcome === 'spoken' ? 'relayed' : 'withheld', why, frames: hold.frames.length, chars: words.length });
          hold.frames = [];
          resolve({ outcome, why: why === 'relayed' ? null : why });
        },
      };
      run.approved = hold;
      // Before the line goes to the model it may wait SAY_QUIET_WAIT_MS for quiet; once it is sent (`sent`), the bound counts.
      const bound = (ms: number, why: SayWithheldWhy) => {
        if (hold.releasing || run.approved !== hold) return;
        if (hold.timer) clearTimeout(hold.timer);
        hold.timer = setTimeout(() => { if (!hold.releasing) hold.finish('posted', why); }, ms);
        (hold.timer as { unref?: () => void }).unref?.();
      };
      bound(SAY_QUIET_WAIT_MS, 'not-quiet');
      let asked = false;
      // Sent with numbers spelled out, so the session reads them as written; the check compares against the approved text itself.
      try {
        asked = session.sayVerbatim!(id, speakableText(words),
          (transcript) => { void this.releaseApproved(run, hold, transcript).catch(() => hold.finish('posted', 'not-relayed')); },
          () => bound(sayBoundMs(words), 'timeout'));
      } catch { asked = false; }
      if (!asked) hold.finish('posted', 'refused');
    });
  }

  /**
   * The session's utterance for an approved request is complete: check it whole, then let it through the call's gate and relay, or
   * withhold it. Released at the pace it plays (the relay drops what runs more than 3 s ahead), so a long question is heard whole;
   * while it goes out nothing else the session says is relayed. `spoken` once the relay has sent its frames.
   */
  private async releaseApproved(run: CallRun, hold: ApprovedHold, transcript: string | null): Promise<void> {
    if (run.approved !== hold) return;
    if (transcript === null || !transcript.trim()) { hold.finish('posted', 'no-words'); return; }
    if (!saidVerbatim(hold.text, transcript)) { hold.finish('posted', 'mismatch'); return; }
    if (!hold.frames.length) { hold.finish('posted', 'no-audio'); return; }
    hold.releasing = true;
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    const stopped = (): SayWithheldWhy | null => run.approved !== hold ? 'voice-off' : run.finished ? 'closed' : run.session !== hold.session ? 'session-changed'
      : !run.voice ? 'voice-off' : run.voiceHeld ? 'paused' : null;
    const before = run.relay.relayed;
    const frames = hold.frames;
    // A turn of its own: decided afresh at its first frame (reason `approved`), and nothing after it rides on its open turn.
    run.gate.clear();
    let i = 0;
    let why: SayWithheldWhy | null = null;
    while (i < frames.length) {
      why = stopped();
      if (why) break;
      while (i < frames.length && run.relay.queuedFrames() < APPROVED_AHEAD_FRAMES) {
        const f = frames[i]!;
        run.releasingApproved = true;
        try { run.gate.frame(f.pcm, f.last); } finally { run.releasingApproved = false; }
        i += 1;
      }
      if (i < frames.length) await new Promise((r) => setTimeout(r, VOICE_FRAME_MS));
    }
    // Wait (bounded) for the relay to send what was queued, so `spoken` means sent.
    for (let k = 0; k < 40 && run.relay.queuedFrames() > 0; k += 1) await new Promise((r) => setTimeout(r, VOICE_FRAME_MS));
    await new Promise((r) => setTimeout(r, 0));
    run.gate.clear();
    const sent = run.relay.relayed > before;
    hold.finish(sent ? 'spoken' : 'posted', why ?? (sent ? 'relayed' : 'not-relayed'));
  }

  /** A person's name in Milo's chat: the call family's own name for someone the directory does not know, else the directory's. */
  private async nameIn(run: CallRun, userId: string): Promise<string> {
    const own = run.policy.displayName ? await run.policy.displayName(run.call, userId).catch(() => null) : null;
    return own ?? nameOf(userId);
  }

  /** Is Milo answering in this call: its voice going out now, or one of its tool calls still open? (The watcher waits while it is.) */
  assistantAnswering(callId: string): boolean {
    const run = this.runs.get(callId);
    if (!run || run.finished) return false;
    return run.speech.speakingAt(this.now()) || [...run.calls.values()].includes('open');
  }

  /** Is this stored line Milo's own voice heard back (the echo guard), for the watcher? */
  isEchoLine(callId: string, line: TranscriptLine): boolean {
    const run = this.runs.get(callId);
    return !!run && this.echoOf(run, line);
  }

  /** A stored line as the echo guard sees it: its text and the wall-clock span it covered (unknown span: not judged). */
  private echoOf(run: CallRun, l: TranscriptLine): boolean {
    if (l.startMs === undefined || l.endMs === undefined || l.endMs < l.startMs) return false;
    return run.speech.isEcho({ text: l.text, startAt: l.at - (l.endMs - l.startMs), endAt: l.at });
  }

  // -------------------------------------------------------------------------------------------------------------
  // What the session says

  /** Queue a line write behind the earlier ones of this run (never rejects). */
  private onInput(run: CallRun, e: SessionEvents['inputTranscript']): Promise<void> {
    run.transcribedAt = this.now(); run.deaf = null; // Milo hears: whatever stall there was is over
    // The voice gate reads the heard text at once, before the line is attributed or stored.
    if (findAddress(e.text) !== null) {
      const endAt = run.sessionStartedAt + e.endMs;
      if (!(run.voice && run.speech.isEcho({ text: e.text, startAt: run.sessionStartedAt + e.startMs, endAt }))) run.addressedAt = Math.max(run.addressedAt, endAt);
    }
    run.gate.poke();
    run.inputNo += 1;
    run.inputEndAt.set(run.inputNo, run.sessionStartedAt + e.endMs);
    if (run.inputEndAt.size > 64) run.inputEndAt.delete(run.inputEndAt.keys().next().value as number);
    const no = run.inputNo;
    const next = run.lineChain.then(() => this.storeInput(run, e, no));
    run.lineChain = next.catch((err: unknown) => { console.warn('[meeting-assistant] session event failed', (err as Error).message); });
    return next;
  }

  private async storeInput(run: CallRun, e: SessionEvents['inputTranscript'], inputNo = 0): Promise<void> {
    // Milo's own voice heard back through a microphone is not a person's line: not stored, only counted (the echo guard's own test).
    if (run.voice && run.speech.isEcho({ text: e.text, startAt: run.sessionStartedAt + e.startMs, endAt: run.sessionStartedAt + e.endMs })) { run.echoLinesDropped += 1; trace('line.echo', { startMs: e.startMs, endMs: e.endMs }); return; }
    // One heard turn can hold two people (a request spoken right after someone else's sentence): one line per voice.
    // The split is judged with each piece moved back by the measured lag of the provider's times behind the voices.
    const lag = transcriptLag(run.lagSamples);
    const pieces = e.parts && e.parts.length > 1
      ? splitBySpeaker(run.timeline.intervals(), e.parts.map((p) => ({ ...p, startMs: p.startMs - lag, endMs: p.endMs - lag }))).map((p) => ({ ...p, startMs: p.startMs + lag, endMs: p.endMs + lag }))
      : [{ text: e.text, startMs: e.startMs, endMs: e.endMs }];
    for (const p of pieces) await this.storePiece(run, p, inputNo, pieces.length === 1);
  }

  private async storePiece(run: CallRun, e: { text: string; startMs: number; endMs: number; mixed?: true }, inputNo = 0, whole = true): Promise<void> {
    const intervals = run.timeline.intervals();
    for (const i of intervals) if (i.endMs >= e.startMs - 2500 && i.startMs <= e.endMs + 1500) trace('line.voiced', { piece: `live:${run.sessionNo}:${run.pieceNo + 1}`, userId: i.userId, startMs: i.startMs, endMs: i.endMs });
    const lag = transcriptLag(run.lagSamples);
    const found = attribute(intervals, { startMs: e.startMs - lag, endMs: e.endMs - lag });
    // Speech several people voiced at once names nobody: whose words are whose cannot be told from one mixed transcript.
    const who = e.mixed && found.speakers.length > 1 ? { userId: null, speakers: found.speakers } : found;
    // A whole turn one person clearly spoke measures the lag: how far its reported start lies after that person's voice began.
    if (whole && who.userId !== null && who.speakers.length === 1) {
      const sample = lagSample(intervals, who.userId, e, lag);
      if (sample !== null) { run.lagSamples.push(sample); if (run.lagSamples.length > LAG_SAMPLES) run.lagSamples.shift(); }
    }
    run.pieceNo += 1;
    const outcome = await this.deps.intake().handle(run.ctx.callId, {
      userId: who.userId, text: e.text, at: run.sessionStartedAt + e.endMs, ...callOffsets(run, e),
      captionId: `live:${run.sessionNo}:${run.pieceNo}`,
      ...(who.speakers.length > 1 ? { speakers: who.speakers } : {}),
    });
    trace('line.lag', { lag });
    if (outcome.stored) { run.lastLineAt = Math.max(run.lastLineAt, outcome.stored.at); run.lastLineSeq = Math.max(run.lastLineSeq, outcome.stored.seq); run.lineInput.set(outcome.stored.seq, inputNo); if (run.lineInput.size > 200) run.lineInput.delete(run.lineInput.keys().next().value as number); }
    trace('line', {
      piece: `live:${run.sessionNo}:${run.pieceNo}`, seq: outcome.stored?.seq ?? null, userId: who.userId, speakers: who.speakers.length,
      startMs: e.startMs, endMs: e.endMs, at: run.sessionStartedAt + e.endMs, addressing: findAddress(e.text) !== null,
      stored: outcome.stored !== null, reason: 'reason' in outcome ? outcome.reason : undefined, events: outcome.events.map((x) => x.type).join('|') || undefined,
    });
  }

  /**
   * Who addressed Milo (audit B3): the speaker of the latest stored line in the window before `atMs` that addresses Milo by the
   * detector's own rule. A line with no primary speaker (nobody, or two people who started together) says nobody; a request spoken over someone names who spoke it.
   */
  private async findAsker(callId: string, atMs: number, turn?: { fromSeq: number; toSeq: number }): Promise<{ ok: true; userId: string; seq: number } | { ok: false }> {
    const record = await this.store.get(callId);
    if (!record) return { ok: false };
    const run = this.runs.get(callId);
    // Milo's own voice heard back through a microphone is not a person addressing it (echo guard).
    const lines = (await this.store.lines(callId, Math.max(0, record.nextSeq - 1 - 100), 100)).filter((l) => !run || !this.echoOf(run, l));
    const addressing = lines.filter((l) => l.at <= atMs && l.at >= atMs - ASKER_WINDOW_MS && findAddress(l.text) !== null);
    // Two people addressed Milo in ONE heard turn (the provider joined them: a request, and another person's question 300 ms after
    // it) just before the model began working. It works through them in order, so its work is for the first one nothing has served
    // yet; the later person's request is left free for what Milo says next. Lines from separate turns keep the latest-line rule.
    if (turn && run) {
      const lastTurn = run.lineInput.get(turn.toSeq);
      const waiting = addressing.filter((l) => l.seq > turn.fromSeq && l.seq <= turn.toSeq && lastTurn !== undefined && lastTurn > 0 && run.lineInput.get(l.seq) === lastTurn && l.userId !== null && !run.answeredLines.has(l.seq) && !run.claimedLines.has(l.seq));
      if (new Set(waiting.map((l) => l.userId)).size > 1) return { ok: true, userId: waiting[0]!.userId!, seq: waiting[0]!.seq };
    }
    const last = addressing[addressing.length - 1];
    // A line voiced by several people still has its primary speaker as `userId` (attribution.ts); only a line nobody dominated has none.
    if (!last || last.userId === null) return { ok: false };
    return { ok: true, userId: last.userId, seq: last.seq };
  }

  /**
   * Is this utterance the short acknowledgement of an open call? Only when it starts within the window after the call's delegation
   * moment, the call is still open, and no acknowledgement was taken for it yet. Taking one marks it (one per call at most).
   */
  private takeAcknowledgement(run: CallRun, from: number, to: number, addressing: TranscriptLine[], fromLines = from): boolean {
    // An acknowledgement is spoken as the work is handed over. Once someone has addressed Milo after that moment (their line
    // ends clearly later than the delegation, and no call has taken it), what Milo says next answers them.
    const addressedSince = (openedAt: number) => addressing.some((l) => l.at > openedAt + ACKNOWLEDGEMENT_LINE_MARGIN_MS && l.at <= fromLines && !run.claimedLines.has(l.seq));
    // A delegation: speech that began before its work produced a message or a function call (whether or not the call has arrived).
    for (const d of run.delegations) {
      if (d.acknowledged || d.at > to || from - d.at >= ACKNOWLEDGEMENT_WINDOW_MS) continue;
      if (d.readyAt !== null && from >= d.readyAt) continue;
      const answeredAt = d.callId ? run.callTimes.get(d.callId)?.answeredAt ?? null : null;
      if (answeredAt !== null && answeredAt <= from) continue;
      if (d.lastSeq !== null ? addressing.some((l) => l.seq > d.lastSeq! && l.at <= fromLines && !run.claimedLines.has(l.seq)) : addressedSince(d.at)) continue;
      d.acknowledged = true;
      const t = d.callId ? run.callTimes.get(d.callId) : undefined;
      if (t) t.acknowledged = true;
      return true;
    }
    // A call no delegation announced (its moment is when it arrived).
    for (const t of run.callTimes.values()) {
      if (t.acknowledged || t.openedAt > to || (t.answeredAt !== null && t.answeredAt <= from)) continue;
      if (from - t.openedAt >= ACKNOWLEDGEMENT_WINDOW_MS) continue;
      if (addressedSince(t.openedAt)) continue;
      t.acknowledged = true;
      return true;
    }
    return false;
  }

  /**
   * A plain answer the second model worked out: the oldest delegation whose work produced a spoken message (no call) before this
   * utterance began, not yet answered, within the asker window. It belongs to whoever addressed Milo at the delegation moment;
   * that line (and the asker's earlier addressing lines in the window) count as answered. Undefined when there is none.
   */
  private async takeDelegatedAnswer(run: CallRun, at: number): Promise<{ asker: string | null } | undefined> {
    const d = run.delegations.find((x) => !x.answered && x.item === 'message' && x.readyAt !== null && x.readyAt <= at && at - x.at < ASKER_WINDOW_MS);
    if (!d) return undefined;
    d.answered = true;
    const who = await d.asker;
    if (who.seq !== null) {
      run.answeredLines.add(who.seq);
      for (const l of await this.addressingLines(run)) if (l.userId === who.userId && l.at <= d.judgeAt && l.at >= d.judgeAt - ASKER_WINDOW_MS) run.answeredLines.add(l.seq);
    }
    trace('delegated.answer', { at: d.at, asker: who.userId, seq: who.seq });
    return { asker: who.userId };
  }

  private contextLive(c: ReplyContext, at: number): boolean {
    return at - c.answeredAt < (c.visibility === 'public' ? REPLY_CONTEXT_TTL_MS : MUTED_CONTEXT_TTL_MS);
  }

  /** Lines that address Milo by the detector's rule (echoes excluded), oldest first, from the latest stored ones. */
  private async addressingLines(run: CallRun): Promise<TranscriptLine[]> {
    const record = await this.store.get(run.ctx.callId);
    if (!record) return [];
    const floor = run.ctx.fromSeq ?? 0; // an earlier period's request is never this period's (Milo was invited back)
    const lines = (await this.store.lines(run.ctx.callId, Math.max(0, record.nextSeq - 1 - 100), 100)).filter((l) => l.seq >= floor && !this.echoOf(run, l));
    return replyAddressing(lines);
  }

  /**
   * A reply context ends when a person other than its asker addressed Milo after the context was set (a muted context has no
   * asker, so anyone does). The same asker speaking again keeps it: the answer still goes to them.
   */
  private async contextEnded(run: CallRun, c: ReplyContext): Promise<boolean> {
    return (await this.addressingLines(run)).some((l) => (c.lastSeq !== undefined ? l.seq > c.lastSeq : l.at > c.answeredAt) && (c.asker === null || l.userId !== c.asker));
  }

  /** The addressing lines up to `until` (within the asker window) are the request of this call. */
  private async claimAddressing(run: CallRun, modelCallId: string, until: number, asker?: string | null): Promise<void> {
    // When the asker was judged at the delegation, only that person's lines are the call's request; another person's stay free.
    for (const l of await this.addressingLines(run)) if (l.at <= until && l.at >= until - ASKER_WINDOW_MS && !run.claimedLines.has(l.seq) && (asker === undefined || asker === null || l.userId === asker)) run.claimedLines.set(l.seq, modelCallId);
  }

  /**
   * The asker for a plain answer: the oldest addressing line in the window that nothing has answered and no call has taken, marked
   * answered, so two quick questions from two people get one answer each in order. Only when there is none, a line whose call is
   * still open (Milo speaking about that request, not marked). Null when the line does not say who (or several people voiced it);
   * undefined when no line in the window addressed Milo at all (the speech answers nobody).
   */
  private async takeUnansweredAsker(run: CallRun, at: number): Promise<string | null | undefined> {
    const open = (await this.addressingLines(run)).filter((l) => l.at <= at && l.at >= at - ASKER_WINDOW_MS && !run.answeredLines.has(l.seq));
    const free = open.find((l) => !run.claimedLines.has(l.seq));
    const next = free ?? open.find((l) => run.calls.get(run.claimedLines.get(l.seq) ?? '') === 'open');
    trace('unanswered', { at, open: open.length, free: free?.seq ?? null, chosen: next?.seq ?? null, chosenUser: next?.userId ?? null });
    if (!next) return undefined;
    if (free) run.answeredLines.add(next.seq);
    return next.userId !== null && (next.speakers?.length ?? 0) <= 1 ? next.userId : null;
  }

  /**
   * One finished utterance of Milo's, in the order of the rules in the header: the scripted session's exact call; the
   * first short acknowledgement of an open call (never posted); the current context unless another person addressed Milo since (muted: silent; public: posted for its asker);
   * else a plain answer for the oldest unanswered addressing line (no label when none says who).
   */
  private async onOutput(run: CallRun, e: SessionEvents['outputTranscript']): Promise<void> {
    // Approved speech was posted (and logged) by whoever asked for it, before it was said: its transcript is never posted again.
    if (e.say !== undefined) return;
    // A pause closes the session on purpose: the half sentence its close flushes is not an answer to anyone.
    if (!e.final || !e.text.trim() || run.finished || run.intentionalClose) return;
    const t = e.startedAt !== undefined ? run.sessionStartedAt + e.startedAt : this.now();
    const tEnd = e.endedAt !== undefined ? run.sessionStartedAt + e.endedAt : t;
    let asker: string | null;
    const decide = (decision: string, f: Record<string, string | number | boolean | null | undefined> = {}) => trace('output', { decision, t, tEnd, ...f });
    if (e.inReplyTo !== undefined) {
      const c = run.replyById.get(e.inReplyTo);
      if (!c || !this.contextLive(c, t) || c.visibility === 'muted' || !c.asker) { decide('drop.byId', { found: !!c, visibility: c?.visibility }); return; }
      if (c.card) { delete c.card; decide('drop.cardSays', { call: c.modelCallId }); return; }
      asker = c.asker;
      decide('owner.byId', { asker });
    } else {
      // The short acknowledgement the voice speaks as it delegates: not an answer; changes nothing.
      await run.lineChain;
      // Lines heard before this utterance began (the provider's audio clock runs a little apart from the server's): every line
      // emitted before Milo's first word counts as before it, up to DELEGATION_LINE_SKEW_MS later than its wall-clock start.
      const bound = e.inputsBefore ? run.inputEndAt.get(e.inputsBefore) : undefined;
      const tLines = bound !== undefined ? Math.max(t, Math.min(bound, t + DELEGATION_LINE_SKEW_MS)) : t;
      // An utterance that begins after a message of the second model became ready speaks that message: it is no acknowledgement
      // (paid run: the voice spoke a read's result just after it had delegated the next person's question).
      run.readyMessages = run.readyMessages.filter((m) => t - m < ASKER_WINDOW_MS);
      const speaks = run.readyMessages.findIndex((m) => m <= t);
      if (speaks >= 0) run.readyMessages.splice(speaks, 1);
      if (speaks < 0 && this.takeAcknowledgement(run, t, tEnd, await this.addressingLines(run), tLines)) { decide('acknowledgement'); return; }
      const c = run.reply;
      // A plain answer to work begun AFTER the current context's answer is that work's, not the context's.
      const fresh = c !== null && run.delegations.some((x) => !x.answered && x.item === 'message' && x.readyAt !== null && x.readyAt <= t && t - x.at < ASKER_WINDOW_MS && x.at > c.answeredAt);
      const newer = fresh ? await this.takeDelegatedAnswer(run, t) : undefined;
      if (newer) {
        asker = newer.asker;
        decide('owner.delegated', { asker, context: 'newer-work' });
      } else if (c && this.contextLive(c, t) && !(await this.contextEnded(run, c))) {
        if (c.visibility === 'muted' || !c.asker) { decide('drop.mutedContext', { call: c.modelCallId }); return; }
        // Milo's first words about a write's card say what the card already shows: spoken, not posted.
        if (c.card) { delete c.card; decide('drop.cardSays', { call: c.modelCallId }); return; }
        asker = c.asker;
        decide('owner.context', { asker, call: c.modelCallId });
      } else {
        // A plain answer with no tool call: whoever addressed Milo in the oldest line nothing has answered; no label when none says.
        const record = await this.store.get(run.ctx.callId);
        if (record && periodRequests(record) > assistantLimits().maxRequests) { decide('drop.limit'); return; }
        const delegated = await this.takeDelegatedAnswer(run, t);
        const found = delegated ? delegated.asker : await this.takeUnansweredAsker(run, tLines);
        // Nobody addressed Milo in the window: an unprompted remark is not posted as anyone's answer.
        if (found === undefined) { decide('drop.unprompted'); return; }
        asker = found;
        decide(delegated ? 'owner.delegated' : 'owner.unanswered', { asker, context: c ? (this.contextLive(c, t) ? 'ended' : 'stale') : 'none' });
      }
    }
    const record = await this.store.get(run.ctx.callId);
    if (!record || record.state === 'left') { decide('drop.left'); return; }
    // The call's policy may keep everything the live model says out of the call (an interview: only approved words are said).
    if (!run.policy.relaysLiveSpeech(run.call)) { decide('drop.policy'); return; }
    if (asker === null) { await postNoticeQuietly(run.ctx.callId, e.text.slice(0, 1500)); return; }
    (run.lastAnswerTo ??= new Map()).set(asker, e.text);
    await postReply(run.ctx.callId, { text: e.text.slice(0, 1500), askedBy: asker, askedByName: await this.nameIn(run, asker) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The detector's requests (and pause or dismiss spoken in the call)

  private async onDetector(callId: string, events: DetectorEvent[], applied: ReadonlySet<DetectorEvent> = new Set()): Promise<void> {
    const run = this.runs.get(callId);
    if (!run) return;
    for (const e of events) {
      if (e.type === 'request') {
        // A fixed request of the call's policy is answered with text the server holds, and no model hears it from here.
        const held = run.policy.answerFromHeldText ? await run.policy.answerFromHeldText(run.call, { askedBy: e.askedBy, text: e.text }).catch(() => null) : null;
        if (held !== null) {
          // The fixed refusal for an asker whose last answer from Milo was already that refusal (the same request heard again, however
          // long after): not posted or said again. Once Milo has answered that asker something else, the refusal is posted again.
          if (run.policy.heldRefusal !== undefined && held === run.policy.heldRefusal && run.lastAnswerTo?.get(e.askedBy) === held) { trace('held.repeat', {}); continue; }
          (run.lastAnswerTo ??= new Map()).set(e.askedBy, held);
          // Posted first with the approved mark (the candidate reads it), then said aloud as approved words when Milo's voice is on.
          const posted = await postApprovedAnswer(callId, held, {}, { askedBy: e.askedBy, askedByName: await this.nameIn(run, e.askedBy) }).catch(() => null);
          // The family's money check for the speech (interviews: a hold under the interview's cap); refused, the answer stays in the chat.
          const speechHold = posted && run.policy.holdHeldSpeech
            ? await run.policy.holdHeldSpeech(run.call, { askedBy: e.askedBy, text: held }).catch(() => null)
            : posted ? { release: async () => undefined } : null;
          let said: SayOutcome = 'posted';
          if (speechHold) {
            try { said = await this.sayHeldText(callId, held, e.askedBy); } finally { await speechHold.release().catch(() => undefined); }
          }
          await run.policy.heldTextSaid?.(run.call, { askedBy: e.askedBy, text: held, posted: posted !== null, spoken: said === 'spoken' }).catch(() => undefined);
          continue;
        }
        // Past the cap Milo says so once and ignores further requests (the cap counts what the detector found). The cap is per listening
        // period, as each is paid for on its own: an invitation back starts a fresh count, and its notices can be said again.
        const record = await this.store.get(callId);
        if (record && periodRequests(record) > assistantLimits().maxRequests) {
          if (!sessionOf(record).limitNoticed) {
            await this.store.patchSession(callId, { limitNoticed: true });
            await postNoticeQuietly(callId, requestLimitNotice(periodOf(record)));
          }
          continue;
        }
        // A few requests before the cap, said once a period (the count only rises, so it equals this once).
        if (record && periodRequests(record) === assistantLimits().maxRequests - REQUESTS_WARNING_LEFT) {
          await postNoticeQuietly(callId, requestsLeftNotice(periodOf(record)));
        }
        // The scripted session answers typed text; the real one hears the same request in the audio and needs nothing.
        const session = run.session;
        if (session?.acceptsText) {
          run.addressedAt = Math.max(run.addressedAt, this.now()); // the detector judged it a request: its spoken answer is wanted
          try { session.sendText(e.askedBy, e.text); } catch (err) { console.warn('[meeting-assistant] sendText failed', (err as Error).message); }
        }
      } else if (e.type === 'command') {
        // Only a command that moved the record is followed up (a repeat changes nothing and says nothing), through the same steps
        // as the buttons.
        if (!applied.has(e)) continue;
        const to = e.command === 'pause' ? 'paused' : 'left';
        const record = await this.store.get(callId);
        if (!record || record.state !== to) continue;
        await this.afterMove(callId, to, record, { userId: e.by });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // A typed request in the call chat (after the message is stored; the caller never waits for this)

  /**
   * A seated person typed a message to Milo. A session that takes text (the scripted one) gets it as the person's own
   * line, so the detector and the name lock treat it like speech; one that cannot (the real one) is told once per person
   * per listening stretch (again after a resume or an invitation back), in chat, that only spoken requests are heard. While
   * Milo is paused the person is told so, once per pause.
   */
  async onTypedMessage(callId: string, userId: string, text: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished || !addressesAssistant(text)) return;
    const record = await this.store.get(callId);
    if (!record) return;
    if (record.state === 'paused') {
      if (run.typedPausedNoticed.has(userId)) return;
      run.typedPausedNoticed.add(userId);
      await postReply(callId, { text: TYPED_PAUSED_REPLY, askedBy: userId, askedByName: await this.nameIn(run, userId) });
      return;
    }
    if (!run.session || record.state !== 'listening') return;
    if (run.session.acceptsText) { await this.deps.intake().handle(callId, { userId, text, at: this.now() }); return; }
    if (run.typedNoticed.has(userId)) return;
    run.typedNoticed.add(userId);
    await postReply(callId, { text: TYPED_UNSUPPORTED_REPLY, askedBy: userId, askedByName: await this.nameIn(run, userId) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tool calls

  /** The one place a tool call is answered. True when this call sent the answer. */
  private answer(run: CallRun, modelCallId: string, output: unknown, reply: { asker: string; visibility: 'public'; card?: true } | null = null): boolean {
    if (run.calls.get(modelCallId) !== 'open') return false;
    run.calls.set(modelCallId, 'answered');
    run.holding.delete(modelCallId);
    const answeredAt = this.now();
    const times = run.callTimes.get(modelCallId);
    if (times) times.answeredAt = answeredAt;
    const sent = run.session?.answerToolCall(modelCallId, typeof output === 'string' ? output : JSON.stringify(output)) ?? false;
    trace('call.answered', { call: modelCallId, sent, visibility: reply ? reply.visibility : 'muted', asker: reply?.asker ?? null, refused: !!(output && typeof output === 'object' && 'refused' in output) });
    // The spoken continuation that follows belongs to THIS call: public and labelled for its asker, or muted (the default).
    if (sent) {
      const ctx: ReplyContext = { modelCallId, asker: reply?.asker ?? null, visibility: reply ? reply.visibility : 'muted', answeredAt, ...(run.lastLineSeq > 0 ? { lastSeq: run.lastLineSeq } : {}), ...(reply?.card ? { card: true as const } : {}) };
      // A muted context never replaces a live public one (its own call still finds it by id).
      if (!(ctx.visibility === 'muted' && run.reply && run.reply.visibility === 'public' && this.contextLive(run.reply, answeredAt))) run.reply = ctx;
      run.replyById.set(modelCallId, ctx);
      run.gate.poke();
      for (const [id, c] of run.replyById) if (answeredAt - c.answeredAt >= REPLY_CONTEXT_TTL_MS) run.replyById.delete(id);
    }
    return sent;
  }

  /** Refuse a call: answered with the reason, counted on the record, and nothing posted (its follow-up speech is muted too). */
  private async refuse(run: CallRun, modelCallId: string, why: string): Promise<void> {
    trace('call.refused', { call: modelCallId, why: why.replace(/\s+/g, '-') });
    this.answer(run, modelCallId, { refused: why });
    await this.store.bumpRefused(run.ctx.callId);
  }

  /** The latest delegation at or before `at` that no call has taken, now taken by `callId`; null when there is none. */
  private takeDelegation(run: CallRun, at: number, callId: string): Delegation | null {
    // A delegation long before the call belongs to a request that never produced one: it is not matched.
    let best: Delegation | null = null;
    for (const d of run.delegations) if (d.callId === null && d.at <= at && d.at >= at - DELEGATION_MAX_AGE_MS && (!best || d.at >= best.at)) best = d;
    if (best) best.callId = callId;
    return best;
  }

  private async onToolCall(run: CallRun, e: SessionEvents['toolCall']): Promise<void> {
    const id = e.callId;
    if (run.calls.has(id)) return;
    run.calls.set(id, 'open');
    // The request was made when the model began working on it, not when its function call reached the server: judge from then.
    const delegation = run.session?.kind === 'scripted' ? null : this.takeDelegation(run, run.sessionStartedAt + e.atMs, id);
    const judged = delegation ? await delegation.asker : undefined;
    const began = delegation?.at ?? null;
    // Without a delegation the call is judged when it arrived; on the lines' clock that is no earlier than the last line stored.
    const judgeAt = delegation?.judgeAt ?? (run.session?.kind === 'scripted' ? null : Math.max(run.sessionStartedAt + e.atMs, run.lastLineAt));
    run.callTimes.set(id, { openedAt: began ?? this.now(), answeredAt: null, acknowledged: delegation?.acknowledged ?? false });
    trace('call', { call: id, name: voiceTool(e.name) ? e.name : 'unknown', at: run.sessionStartedAt + e.atMs, began, matched: began !== null });
    // Judged only after every line that arrived before the call is stored (the asker is found among them).
    await run.lineChain;
    // The lines that addressed Milo up to that moment are this call's request: its context answers them, and a plain answer
    // spoken meanwhile goes to someone else's line first.
    await this.claimAddressing(run, id, judgeAt ?? this.now(), judged?.userId).catch(() => undefined);
    try {
      await this.handleToolCall(run, e, judgeAt, judged ? judged.userId : undefined);
    } catch (err) {
      console.warn('[meeting-assistant] tool call failed', (err as Error).message);
      this.answer(run, id, { error: `${ASSISTANT_NAME} could not run that.` });
    } finally {
      // Anything still open that no turn is holding gets an answer now: an unanswered call stalls the session.
      if (run.calls.get(id) === 'open' && !run.holding.has(id)) this.answer(run, id, { error: `${ASSISTANT_NAME} could not run that.` });
    }
  }

  private async handleToolCall(run: CallRun, e: SessionEvents['toolCall'], judgedAt: number | null = null, judgedAsker?: string | null): Promise<void> {
    const { callId, tenant } = run.ctx;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') { this.answer(run, e.callId, { refused: 'not listening' }); return; }
    if (periodRequests(record) > assistantLimits().maxRequests) { await this.refuse(run, e.callId, 'request limit reached'); return; }
    const atMs = run.session?.kind === 'scripted' ? this.now() : (judgedAt ?? run.sessionStartedAt + e.atMs);
    // (a) The asker: the server's own record of who spoke.
    // The asker judged at the delegation (audit S2) when there was one; otherwise the latest addressing line before the call.
    const asker = e.askedBy ?? (judgedAsker !== undefined ? judgedAsker : await this.findAsker(callId, atMs).then((f) => (f.ok ? f.userId : null)));
    if (!asker) {
      // No line addressed Milo, or the one that did has no single speaker: nobody is asked to confirm anything.
      await this.refuse(run, e.callId, 'could not tell who asked');
      if (this.now() - run.lastUnaskedNoticeAt >= UNASKED_NOTICE_EVERY_MS) {
        run.lastUnaskedNoticeAt = this.now();
        await postReply(callId, { text: UNASKED_REPLY, askedBy: 'unknown', askedByName: 'the call' }).catch(() => null);
      }
      return;
    }
    trace('call.asker', { call: e.callId, asker, judgedAt: atMs });
    if (!canSpeakOnRecord(record, asker)) { await this.refuse(run, e.callId, 'not addressed'); return; }
    // (b) The name lock: the asker said the name in the window before the call.
    const lines = (await this.store.lines(callId, Math.max(0, record.nextSeq - 1 - 100), 100)).filter((l) => !this.echoOf(run, l));
    if (!nameLock(lines, asker, atMs, ASKER_WINDOW_MS)) { await this.refuse(run, e.callId, 'not addressed'); return; }
    run.addressedCalls.add(e.callId); run.gate.poke();
    // (b2) At most MAX_CALLS_PER_REQUEST calls per addressed request: text inside a record must not be able to lead the
    // model into an open-ended chain of reads. A request is the asker plus the line that addressed Milo in the window.
    const addressing = [...lines].reverse().find((l) => (l.userId === asker || l.speakers?.includes(asker) === true) && l.at <= atMs && l.at >= atMs - ASKER_WINDOW_MS && findAddress(l.text) !== null);
    const requestKey = `${asker}|${addressing?.seq ?? 0}`;
    const made = (run.requestCalls.get(requestKey) ?? 0) + 1;
    run.requestCalls.set(requestKey, made);
    if (run.requestCalls.size > 200) run.requestCalls.delete(run.requestCalls.keys().next().value as string);
    if (made > MAX_CALLS_PER_REQUEST) { await this.refuse(run, e.callId, 'too many steps'); return; }
    const askerName = await nameOf(asker);
    const name = e.name;
    if (!voiceTool(name)) { await this.refuse(run, e.callId, 'unknown tool'); return; }
    // The arguments are model output: an object, and small.
    const argsOk = e.args !== null && typeof e.args === 'object' && !Array.isArray(e.args) && Buffer.byteLength(JSON.stringify(e.args)) <= MAX_ARGS_BYTES;
    // (c) The asker's own role.
    const roles = await this.deps.rolesOf(asker, tenant);
    const allowed = run.policy.mayUseTool(run.call, { userId: asker, roles }, name);
    if (!allowed) {
      trace('call.refused', { call: e.callId, why: 'role' });
      this.answer(run, e.callId, { refused: `not allowed for ${askerName}` });
      await this.store.bumpRefused(callId);
      // The reason goes to the asker alone (their notifications); the call sees only a neutral line that puts nothing on them.
      await postPrivately(callId, asker, { text: NOT_PERMITTED_PRIVATE }).catch(() => false);
      await postReply(callId, { text: NOT_PERMITTED_PUBLIC, askedBy: asker, askedByName: askerName });
      return;
    }
    if (!argsOk) { await this.refuse(run, e.callId, 'invalid arguments'); return; }
    // (d) Read or write; private tools are decision 6's list.
    const kind = classifyCall(name, e.args);
    if (!kind) { await this.refuse(run, e.callId, 'unknown tool'); return; }
    // (d2) A write that names someone other than the asker needs their consent too: a proposal, not the asker's card
    // (named-people.ts). A write that names only the asker, or nobody, goes on to the card below unchanged.
    if (kind === 'write') {
      const said = peopleSaid(name, e.args);
      if (said === null) { await this.refuse(run, e.callId, 'not reviewed for consent'); return; }
      if (said.length) {
        const found = await resolvePeople(said, asker, await this.rosterOf(record), this.deps.directory ?? defaultDirectory);
        if (!found.ok) { await this.refuse(run, e.callId, found.why); return; }
        if (found.others.length) { await this.proposeNamed(run, e, asker, found.others); return; }
      }
    }
    // (e) The turn.
    const now = this.now();
    const turnId = `t-${newId()}`;
    const actionId = kind === 'write' ? `a-${turnId}` : undefined;
    const turn: AssistantTurn = {
      turnId, callId, askedBy: asker, tool: { name, args: e.args }, kind, status: 'pending', ...(actionId ? { actionId } : {}),
      createdAt: now, expiresAt: now + (kind === 'write' ? WRITE_TURN_TTL_MS : READ_TURN_TTL_MS),
    };
    await this.store.createTurn(turn);
    trace('call.turn', { call: e.callId, turn: turnId, kind, private: isPrivateRead(name, e.args) });
    if (kind === 'write') {
      const { summary, detail, title, does } = describeCall(name, e.args);
      const posted = await postAction(callId, { actionId: actionId!, askedBy: asker, askedByName: askerName, summary, ...(title ? { title } : {}), ...(does ? { does } : {}), ...(detail.length ? { detail } : {}), tool: { name, argsDigest: hashToolArgs(e.args) } });
      if (!posted) {
        await this.store.moveTurn(callId, turnId, { from: ['pending'], to: 'expired' });
        this.answer(run, e.callId, { error: `${ASSISTANT_NAME} could not offer that action.` });
        return;
      }
      // The card says "Waiting for <name>": Milo may say it, but its words about the card are not posted again (card: true).
      this.answer(run, e.callId, { status: 'waiting_for_confirmation', person: askerName }, { asker, visibility: 'public', card: true });
      return;
    }
    run.turnCalls.set(turnId, e.callId);
    run.holding.add(e.callId);
  }

  /** Everyone who held a seat while Milo was in the call, everyone seated now and the inviter, by display name. */
  private async rosterOf(record: AssistantRecord): Promise<RosterEntry[]> {
    let seated: string[] = [];
    try { seated = (await callChatRuntime().seatedUsers(record.callId)).filter((u) => u.active).map((u) => u.userId); } catch { /* the seat roster is best effort here */ }
    const ids = [...new Set([...record.attendees, ...seated, record.invitedBy])];
    return Promise.all(ids.map(async (userId) => ({ userId, name: await nameOf(userId).catch(() => userId) })));
  }

  /**
   * The proposal an asked write that names other people becomes: the frozen call as its outcome, those people named, the asker
   * its executor. Milo is told whose consent it needs; the card in the chat is the proposal's own (chat.ts). Nothing is logged.
   */
  private async proposeNamed(run: CallRun, e: SessionEvents['toolCall'], asker: string, others: ReadonlyArray<RosterEntry & { role: PersonRole }>): Promise<void> {
    if (others.length > MAX_NAMED) { await this.refuse(run, e.callId, 'too many people'); return; }
    const people = await Promise.all(others.map(async (o) => ({ ...o, name: o.name && o.name !== o.userId ? o.name : await nameOf(o.userId) })));
    const a = e.args as Record<string, unknown>;
    // An update's own sentence says nothing of what it changes: its statement says what changes, in words, and names the row only
    // by its title (a typed record reference such as "work-item:wi-12" is never shown).
    const base = e.name === 'update' ? updateStatement(a) : describeCall(e.name, e.args).summary;
    try {
      await createProposal(this.store, {
        callId: run.ctx.callId, tenant: run.ctx.tenant, statement: namedStatement(base, people, MAX_STATEMENT_CHARS),
        outcome: { kind: 'tool', name: e.name, args: e.args }, named: people.map((p) => p.userId), executor: asker, source: 'asked', askedBy: asker, at: this.now(),
      });
    } catch (err) {
      if (!(err instanceof ProposalInputError)) throw err;
      this.answer(run, e.callId, { error: `${ASSISTANT_NAME} could not offer that.` });
      return;
    }
    const names = people.map((p) => p.name);
    this.answer(run, e.callId, { status: 'waiting_for_consent', people: names, say: consentStatus(names) }, { asker, visibility: 'public' });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The asker's browser: turns, results, card decisions

  /** The turns the browser of `userId` should run now: pending reads and running writes that have not expired and nobody has claimed. */
  async turnsFor(callId: string, userId: string): Promise<AssistantTurn[]> {
    const now = this.now();
    return (await this.store.listTurns(callId, { askedBy: userId, statuses: ['pending', 'running'] }))
      .filter((t) => t.expiresAt > now && t.claimId === undefined && ((t.kind === 'write') === (t.status === 'running')));
  }

  /**
   * One of the asker's browsers claims a turn before running it (audit B6): exactly one claim per turn, and only the asker may
   * make it. Null when the turn is not the caller's or unknown (a 404); `{ conflict }` when it is not runnable now, expired or
   * already claimed (a 409). The result must carry the returned `claimId`.
   */
  async claimTurn(callId: string, turnId: string, userId: string): Promise<{ turn: AssistantTurn } | { conflict: string } | null> {
    const turn = await this.store.getTurn(callId, turnId);
    if (!turn || turn.askedBy !== userId) return null;
    if (turn.proposalId && turn.status === 'running' && turn.claimId === undefined && turn.expiresAt > this.now()) {
      // A consented proposal: the executor's rights are checked again now, as they run it (and it must still be running this turn).
      const check = await checkBeforeClaim(this.proposalDeps, turn);
      if (!check.ok) {
        await this.store.moveTurn(callId, turnId, { from: ['running'], to: check.why === 'gone' ? 'expired' : 'declined' });
        return { conflict: check.why === 'gone' ? 'expired' : 'not allowed' };
      }
    }
    const claimed = await this.store.claimTurn(callId, turnId, { claimId: randomBytes(12).toString('hex'), claimedAt: this.now() }, this.now());
    if (claimed) return { turn: claimed };
    const now = (await this.store.getTurn(callId, turnId)) ?? turn;
    return { conflict: now.claimId !== undefined ? 'claimed' : now.expiresAt <= this.now() ? 'expired' : now.status === 'pending' && now.kind === 'write' ? 'waiting for confirmation' : now.status };
  }

  /**
   * The asker's browser finished a turn. `result.output` is already size-checked by the route. Null when the turn is not
   * the caller's, unknown, or no longer waiting for a result (answered once: a second result is a conflict).
   */
  async submitResult(callId: string, turnId: string, userId: string, result: { ok: boolean; claimId: string; output?: unknown; error?: string }):
    Promise<{ turn: AssistantTurn } | { conflict: TurnStatus | 'claim' } | null> {
    const turn = await this.store.getTurn(callId, turnId);
    if (!turn || turn.askedBy !== userId) return null;
    // Only the browser that claimed the turn can finish it (audit B6): no claim, or another claim, is a conflict.
    if (turn.claimId === undefined || turn.claimId !== result.claimId) return { conflict: 'claim' };
    const waiting: TurnStatus = turn.kind === 'write' ? 'running' : 'pending';
    if (turn.status !== waiting || turn.expiresAt <= this.now()) return { conflict: turn.status === waiting ? 'expired' : turn.status };
    const moved = await this.store.moveTurn(callId, turnId, { from: [waiting], to: result.ok ? 'done' : 'failed' });
    if (!moved) return { conflict: (await this.store.getTurn(callId, turnId))?.status ?? 'expired' };
    const run = this.runs.get(callId);
    if (turn.proposalId) {
      // A consented proposal: its card reads the proposal; nothing is said in the call or told to the session.
      await finishProposal(this.proposalDeps, turn, result);
      return { turn: moved };
    }
    if (turn.kind === 'write') {
      const text = result.ok ? capText((result.output as { say?: unknown } | null)?.say ?? 'Done.', 300) : capText(result.error ?? 'It did not work.', 300);
      if (turn.actionId) await moveAction(callId, turn.actionId, { from: ['waiting', 'confirmed'], to: result.ok ? 'done' : 'failed', by: userId, resultText: text }).catch(() => null);
      // The card keeps the asker's own sentence; the shared session only ever gets a fixed one (low finding: the browser's words are not model input).
      this.tellSession(run, result.ok ? 'The action you offered was done.' : 'The action you offered did not work.');
      return { turn: moved };
    }
    const modelCallId = run?.turnCalls.get(turnId);
    if (turn.kind === 'private-read') {
      // Decision 6, audit B2: a private answer never passes through the shared session. The model is told only that it was
      // answered privately (its continuation is muted); the asker gets their own sentence in the chat, and the call a fixed line.
      if (run && modelCallId) {
        run.turnCalls.delete(turnId);
        this.answer(run, modelCallId, result.ok ? { status: 'answered_privately' } : { error: 'It did not work.' });
      }
      const say = result.ok ? plainSentence((result.output as { say?: unknown } | null)?.say, PRIVATE_SAY_MAX) : '';
      await postPrivately(callId, userId, { text: result.ok ? (say || PRIVATE_FALLBACK) : PRIVATE_FAILED }).catch(() => false);
      if (result.ok) await postReply(callId, { text: `Answered privately for ${await nameOf(userId)}.`, askedBy: userId, askedByName: await nameOf(userId) }).catch(() => null);
      return { turn: moved };
    }
    if (run && modelCallId) {
      run.turnCalls.delete(turnId);
      // The result is data. It goes to the session as the tool's output and nowhere else.
      this.answer(run, modelCallId, result.ok ? (result.output ?? null) : { error: capText(result.error ?? 'It did not work.', 300) }, { asker: turn.askedBy, visibility: 'public' });
    }
    return { turn: moved };
  }

  /** The asker confirmed or declined an action card (the decision route calls this after it moved the card). */
  async onDecision(callId: string, actionId: string, decision: 'confirm' | 'decline'): Promise<void> {
    const turn = (await this.store.listTurns(callId, { statuses: ['pending'] })).find((t) => t.actionId === actionId);
    if (!turn) return;
    const run = this.runs.get(callId);
    // Once the card is decided, anything Milo says next is news (done, declined): it is posted as usual.
    if (run) for (const c of [run.reply, ...run.replyById.values()]) if (c) delete c.card;
    if (decision === 'confirm') { await this.store.moveTurn(callId, turn.turnId, { from: ['pending'], to: 'running' }); return; }
    const moved = await this.store.moveTurn(callId, turn.turnId, { from: ['pending'], to: 'declined' });
    if (moved) this.tellSession(run, `${await nameOf(turn.askedBy)} declined the action you offered. It was not done.`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Time

  /**
   * Expire every turn in any call whose time is up, whether or not a run is live in this process: after Milo left (the minutes'
   * `m-` cards) and after a restart there is no run, and the cards must still settle (audit M9).
   */
  async sweepTurns(limit = 200): Promise<number> {
    const due = await this.store.dueTurns(this.now(), limit);
    for (const t of due) await this.expireTurn(this.runs.get(t.callId) ?? null, t);
    return due.length;
  }

  /** Expire turns whose time is up; answers the reads that were waiting. Tests call this with a moved clock. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const run of [...this.runs.values()]) {
      // One run's error is its own: the others still get their heartbeat, ceiling and expiry.
      try { await this.tickRun(run, now); } catch (e) { console.warn('[meeting-assistant] tick failed', (e as Error).message); }
    }
  }

  private async tickRun(run: CallRun, now: number): Promise<void> {
    if (run.finished) return;
    if (now - run.attendanceAt >= ATTENDANCE_EVERY_MS) { run.attendanceAt = now; await this.snapshotAttendance(run.ctx.callId); }
    if (now - run.heartbeatAt >= HEARTBEAT_EVERY_MS) await this.heartbeat(run);
    await this.checkCeiling(run);
    if (run.finished) return;
    if (run.session && run.expiresAt !== null && now >= run.expiresAt - SESSION_EXPIRY_MARGIN_MS) await this.replaceSession(run, 'planned replacement before the provider expiry', false);
    if (run.finished) return;
    await this.checkHearing(run, now);
    if (run.finished) return;
    const due = (await this.store.listTurns(run.ctx.callId, { statuses: ['pending', 'running'] })).filter((t) => t.expiresAt <= now);
    for (const t of due) await this.expireTurn(run, t);
  }

  /**
   * The deaf watchdog. Milo can sit in a call `listening` and hear nothing, silent and invisible: the tap stopped posting (its token
   * died, the media server dropped it), or audio flows and the session never gives a transcript of it. The watch applies only while a
   * session is open on real audio, Milo is not speaking, and someone who may be heard (the inviter, or a person who acknowledged)
   * holds an active seat; otherwise its minute starts again. A minute with no audio while the armer says the tap is up arms it again
   * (media.ts `rearm`; a tap still being made is the armer's own to report, after its own minute); a minute with no transcript that
   * held DEAF_VOICED_MS of voice replaces the session, counted, so a session that keeps coming back deaf ends in
   * giveUp through `reopen`. The call is told once per stall. A tap that still cannot be made a minute after it was armed again leaves
   * through giveUp; a tap that exists and carries nothing is a quiet room (every microphone off), and Milo stays.
   */
  private async checkHearing(run: CallRun, now: number): Promise<void> {
    const callId = run.ctx.callId;
    if (!run.session || run.session.kind === 'scripted' || !this.deps.audio || run.speech.speakingAt(now)) { run.watchFrom = now; return; }
    const audioDue = now - Math.max(run.heardAt, run.watchFrom) >= DEAF_AFTER_MS;
    const transcriptsDue = now - Math.max(run.transcribedAt, run.watchFrom) >= DEAF_AFTER_MS
      && voicedSince(run.timeline, now - DEAF_AFTER_MS - run.sessionStartedAt) >= DEAF_VOICED_MS;
    if (!audioDue && !transcriptsDue) return;
    const taps = audioDue ? await (this.deps.taps?.() ?? Promise.resolve(null)).catch(() => null) : null;
    if (audioDue && run.deaf?.kind === 'audio') {
      // Armed again a while ago and still nothing: leave once the tap could not be made for a whole minute and people wait to be heard.
      if (now - run.deaf.at >= DEAF_AFTER_MS && taps && taps.hearing(callId) !== 'ok' && await this.anyoneToHear(callId)) await this.giveUp(run);
      return;
    }
    // A tap the armer is still making (or has already said it cannot make) is the armer's to report: the watch starts once it says the tap is up.
    if (audioDue && taps && taps.hearing(callId) !== 'ok') { run.watchFrom = now; return; }
    const kind = audioDue && taps ? 'audio' : transcriptsDue ? 'transcripts' : null;
    if (kind === null) return;
    if (!(await this.anyoneToHear(callId))) { run.watchFrom = now; return; }
    if (run.finished || !run.session) return;
    run.watchFrom = now; // one recovery per stall: a tick that runs alongside this one does not act on it again
    const told = run.deaf !== null;
    if (kind === 'audio') {
      if (!(await taps!.rearm(callId))) return; // not armed against a media server here: nothing to arm again, nothing to watch
      console.warn(`[meeting-assistant] no audio has reached ${callId} for a minute; arming its tap again`);
      run.deaf = { kind, at: now };
      if (!told) await postNoticeQuietly(callId, CANNOT_HEAR_NOTICE);
      return;
    }
    run.deaf = { kind, at: now };
    if (!told) await postNoticeQuietly(callId, CANNOT_HEAR_NOTICE);
    await this.replaceSession(run, 'no transcript of the voices it hears', true);
  }

  /** Does someone Milo may hear (the inviter, or a person who acknowledged) hold an active seat? False when the record is not listening or the roster cannot be read. */
  private async anyoneToHear(callId: string): Promise<boolean> {
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') return false;
    try {
      return (await this.seatsOf(callId)).some((u) => u.active && (u.userId === record.invitedBy || record.acked.includes(u.userId)));
    } catch { return false; }
  }

  private seatsOf(callId: string): Promise<Array<{ userId: string; active: boolean }>> {
    return this.deps.seats ? this.deps.seats(callId) : callChatRuntime().seatedUsers(callId);
  }

  /**
   * Write "this process was alive now" on the call's record, with the usage so far (the open session's included), so a boot that finds
   * the record still `listening` can close the listening period here and settle what was spent (audit M5). Best effort.
   */
  private async heartbeat(run: CallRun): Promise<void> {
    run.heartbeatAt = this.now();
    try {
      await this.store.patchSession(run.ctx.callId, {
        lastAliveAt: run.heartbeatAt, sessionKind: run.sessionKind,
        usageSeconds: run.totals.seconds + run.usageSeconds, tokensIn: run.totals.input + run.tokens.input,
        tokensOut: run.totals.output + run.tokens.output, tokensCached: run.totals.cached + run.tokens.cached,
      }, { period: run.period });
    } catch (e) { console.warn('[meeting-assistant] heartbeat failed', (e as Error).message); }
  }

  /** Shutdown: one last heartbeat for every live run, so the reconcile that follows closes each period at this moment. */
  async heartbeatAll(): Promise<void> { for (const run of [...this.runs.values()]) if (!run.finished) await this.heartbeat(run); }
  hasRuns(): boolean { return this.runs.size > 0; }
  callIds(): string[] { return [...this.runs.keys()]; }

  /** Everyone who holds an ACTIVE seat right now was present while Milo was (audit M1); departed rows are never counted. */
  private async snapshotAttendance(callId: string): Promise<void> {
    try { for (const u of await this.seatsOf(callId)) if (u.active) await this.store.attend(callId, u.userId); } catch { /* the seat roster is best effort here */ }
  }

  /** Five minutes before the ceiling, say so once; at the ceiling, leave with a notice (the listening time counts, a pause does not). */
  private async checkCeiling(run: CallRun): Promise<void> {
    const callId = run.ctx.callId;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') return;
    const limits = await limitsOfCall(policyCallOf(record));
    const s = sessionOf(record, limits.maxSeconds);
    const left = s.ceilingSeconds - listeningSecondsOf(record, this.now());
    if (left <= 0) {
      await this.snapshotAttendance(callId);
      const done = await this.store.transition(callId, { from: ['listening'], to: 'left', by: 'system', at: this.now() });
      if (!done) return;
      await postNoticeQuietly(callId, `${ASSISTANT_NAME} left because this call reached its ${Math.round(s.ceilingSeconds / 60)}-minute limit.`, { leaving: true });
      this.deps.intake().stop(callId);
      await this.stop(callId, 'limit');
    } else if (left <= CEILING_WARNING_SECONDS && !s.warned) {
      await this.store.patchSession(callId, { warned: true });
      // Said according to whether more time can still be added, and naming the inviter for the people who cannot extend.
      const canExtend = s.ceilingSeconds < limits.hardMaxSeconds;
      await postNoticeQuietly(callId, canExtend
        ? `${ASSISTANT_NAME} leaves in 5 minutes. Anyone who can invite ${ASSISTANT_NAME} can extend its time; if you can't, ask ${await nameOf(record.invitedBy)}.`
        : `${ASSISTANT_NAME} leaves in 5 minutes; this call cannot be extended further.`);
    }
  }

  /**
   * Add the default minutes to the call's ceiling, up to the hard maximum, and hold the money for them. Returns the new
   * ceiling, or why not: the call is over, the maximum is reached, or the inviter's budget refused the hold.
   */
  async extend(callId: string, by: { sub: string }, confirmOverUserBudget = false):
    Promise<{ ok: true; ceilingSeconds: number; addedSeconds: number } | { ok: false; why: 'no-assistant' | 'left' | 'at-maximum' } | { ok: false; why: 'refused'; refusal: Extract<ReserveOutcome, { ok: false }>['refusal'] }> {
    // Two extensions of one call at once would each read the same hold list and the later write would drop the other's hold id.
    const before = this.extending.get(callId) ?? Promise.resolve();
    const mine = before.then(() => this.extendOnce(callId, by, confirmOverUserBudget));
    const tail = mine.then(() => undefined, () => undefined);
    this.extending.set(callId, tail);
    void tail.then(() => { if (this.extending.get(callId) === tail) this.extending.delete(callId); });
    return mine;
  }

  private async extendOnce(callId: string, by: { sub: string }, confirmOverUserBudget: boolean):
    Promise<{ ok: true; ceilingSeconds: number; addedSeconds: number } | { ok: false; why: 'no-assistant' | 'left' | 'at-maximum' } | { ok: false; why: 'refused'; refusal: Extract<ReserveOutcome, { ok: false }>['refusal'] }> {
    const record = await this.store.get(callId);
    if (!record) return { ok: false, why: 'no-assistant' };
    if (record.state === 'left') return { ok: false, why: 'left' };
    const limits = await limitsOfCall(policyCallOf(record));
    const s = sessionOf(record, limits.maxSeconds);
    const next = Math.min(limits.hardMaxSeconds, s.ceilingSeconds + limits.maxSeconds);
    const added = next - s.ceilingSeconds;
    if (added <= 0) return { ok: false, why: 'at-maximum' };
    const payer = payerOf(record);
    const held = await assistantSpend().reserve({
      callId, tenant: record.tenant, inviterId: payer.actorId, initiativeId: payer.initiativeId, source: payer.source, seconds: added, part: s.extensions + 1,
      // Going past a budget is the budget owner's choice: only the person the hold is against (the inviter) can confirm it (audit M6).
      ...(confirmOverUserBudget && by.sub === payer.actorId ? { confirmOverUserBudget: true } : {}),
    });
    if (!held.ok) return { ok: false, why: 'refused', refusal: held.refusal };
    await this.store.patchSession(callId, { ceilingSeconds: next, warned: false, extensions: s.extensions + 1, holds: held.holdId ? [...s.holds, held.holdId] : s.holds });
    await postNoticeQuietly(callId, `${await nameOf(by.sub)} extended ${ASSISTANT_NAME}'s time by ${Math.round(added / 60)} minutes.`);
    return { ok: true, ceilingSeconds: next, addedSeconds: added };
  }

  private async expireOpenTurns(run: CallRun, readsOnly: boolean, cause: ExpiryCause): Promise<void> {
    for (const t of await this.store.listTurns(run.ctx.callId, { statuses: ['pending', 'running'] })) {
      if (!readsOnly || t.kind !== 'write') await this.expireTurn(run, t, cause);
    }
  }

  /**
   * Expire one turn and update its card. `run` is the call's live run, or null when there is none (Milo has left, or the server
   * restarted): the card is still settled, there is just no session to tell and no model call to answer (audit M9).
   */
  private async expireTurn(run: CallRun | null, turn: AssistantTurn, given: ExpiryCause = 'timeout'): Promise<void> {
    const callId = turn.callId;
    const moved = await this.store.moveTurn(callId, turn.turnId, { from: ['pending', 'running'], to: 'expired' });
    if (!moved) return;
    // A consented proposal's turn hands the proposal back to `consented`: its card says why; nothing is said in the call.
    if (turn.proposalId) { await expireProposalTurn(this.proposalDeps, turn); return; }
    const cause = run ? given : await this.causeWithoutRun(turn, given);
    const askerName = await nameOf(turn.askedBy);
    const why = EXPIRY_WORDS[cause];
    if (turn.kind === 'write') {
      if (turn.actionId) {
        // Claimed but no result: it may or may not have run, so the card must not say it did not (audit B6). Ended because Milo
        // left, was dismissed, hit its limit, lost its connection or was restarted: that cause, never the asker. Otherwise
        // confirmed but never claimed: the asker's browser was not there; never confirmed: nobody decided in time.
        const resultText = turn.claimId !== undefined ? `${ASSISTANT_NAME} could not confirm whether this was done. Check before trying again.`
          : why.card ?? (turn.status === 'running' ? `${askerName} confirmed this, but their browser was not available to run it.` : `${askerName} did not confirm this in time.`);
        await moveAction(callId, turn.actionId, { from: ['waiting', 'confirmed'], to: 'expired', by: 'system', resultText }).catch(() => null);
      }
      this.tellSession(run, `The action offered to ${askerName} expired without being done.`);
      return;
    }
    if (run) {
      const modelCallId = run.turnCalls.get(turn.turnId);
      run.turnCalls.delete(turn.turnId);
      if (modelCallId) this.answer(run, modelCallId, { error: why.model });
    }
    // Posted even when Milo has just left (the record is already `left` by the time the run stops): the asker is told.
    await postReply(callId, { text: why.chat(askerName), askedBy: turn.askedBy, askedByName: askerName }, { leaving: true }).catch(() => null);
  }

  /**
   * A turn found due with no live run in this process: Milo left the call before it ended (a turn made before the leave), or the
   * service restarted under a call that is still on. A card offered after Milo left (the minutes' cards) keeps its own cause.
   */
  private async causeWithoutRun(turn: AssistantTurn, given: ExpiryCause): Promise<ExpiryCause> {
    if (given !== 'timeout') return given;
    const record = await this.store.get(turn.callId).catch(() => null);
    if (!record) return given;
    if (record.state === 'left') return turn.createdAt < (record.leftAt ?? Infinity) ? 'left' : given;
    return 'restarted';
  }

  // -------------------------------------------------------------------------------------------------------------
  // Mock-only: a tool call attributed by the caller (the dev route). Goes through every check above.

  devToolCall(callId: string, askedBy: string, name: string, args: unknown): string | null {
    const session = this.runs.get(callId)?.session as (LiveMeetingSession & { emitToolCall?: (a: string, n: string, args: unknown) => string }) | null | undefined;
    if (!session || typeof session.emitToolCall !== 'function') return null;
    return session.emitToolCall(askedBy, name, args);
  }
}

// -----------------------------------------------------------------------------------------------------------------

/** The org directory by display name, for a named person who never held a seat; empty when it cannot be read. */
async function defaultDirectory(): Promise<RosterEntry[]> {
  try { return (await listUsers()).map((u) => ({ userId: u.id, name: u.displayName })); } catch { return []; }
}

export async function defaultRolesOf(userId: string, tenant: string): Promise<string[]> {
  try { return (await getUser(userId))?.grants?.[tenant] ?? []; } catch { return []; }
}

async function defaultActionAllowed(userId: string, role: string, tenant: string, action: string): Promise<boolean> {
  const { isAllowed } = await import('../authz.js');
  return isAllowed({ sub: userId, role, tenant }, action);
}

/** The decide rule asked of the initiative for each of the person's roles; any one that may decide (and Cedar agrees) is enough. */
async function defaultMayDecide(userId: string, tenant: string, initiativeId: string): Promise<boolean> {
  const [{ mayDecideDecision }, { isAllowed }] = await Promise.all([import('../decision-authority.js'), import('../authz.js')]);
  for (const role of await defaultRolesOf(userId, tenant)) {
    const session = { sub: userId, role, tenant, grants: {}, iat: 0 } as unknown as Parameters<typeof mayDecideDecision>[0];
    const verdict = await mayDecideDecision(session, { projectId: initiativeId, participants: [] });
    if (verdict.ok && await isAllowed({ sub: userId, role, tenant }, 'DecideDecision', { decidesThis: verdict.decidesThis })) return true;
  }
  return false;
}

let runtime: AssistantRuntime | null = null;
let proposalHook: (() => void) | null = null;
/** Consented proposals run through the process's runtime, whichever it is now; subscribed once, when a runtime first exists. */
function hookProposals(): void {
  proposalHook ??= onProposalConsented(async (p) => { await runtime?.startProposal(p.callId, p.id); });
  hookProposalNotices();
}
export function assistantRuntime(): AssistantRuntime {
  hookProposals();
  if (runtime) return runtime;
  const watcher = new DecisionWatcher(defaultWatcherDeps({
    store: assistantStore, clock: Date.now,
    assistantAnswering: (callId) => runtime?.assistantAnswering(callId) ?? false,
    isEcho: (callId, line) => runtime?.isEchoLine(callId, line) ?? false,
  }));
  return (runtime = new AssistantRuntime({
    store: assistantStore, intake: assistantIntake, clock: Date.now, makeSession, rolesOf: defaultRolesOf, onFinished: async (e) => { await settleFinished(e); void finishMinutes(e.callId); },
    audio: assistantAudio(), watcher,
    // As the restart reconcile does: only a process with the media settings has taps of its own to arm again.
    taps: async () => { const media = await import('./media.js'); return media.mediaConfig() ? media.tapArmer() : null; },
  }));
}
/**
 * The turn expiry sweep for a running server: every `everyMs`, expire what is due in any call, live run or not. Unref'd, like the
 * retention sweep. `timers` is injectable for tests. Returns the stopper.
 */
export function startTurnSweep(everyMs = 30_000, runtimeOf: () => AssistantRuntime = assistantRuntime, timers: { set: typeof setInterval; clear: typeof clearInterval } = { set: setInterval, clear: clearInterval }): () => void {
  // A deployment that never ran the migration has no tables: say so once, not every 30 seconds.
  let logged = false;
  const timer = timers.set(() => { void runtimeOf().sweepTurns().catch((e: unknown) => { if (logged) return; logged = true; console.warn('[meeting-assistant] turn sweep failed (will keep trying quietly)', (e as Error).message); }); }, everyMs);
  (timer as { unref?: () => void }).unref?.();
  return () => timers.clear(timer);
}
/** The process's runtime if one was ever made; never makes one (shutdown must not create what it is about to stop). */
export function peekAssistantRuntime(): AssistantRuntime | null { return runtime; }
export function setAssistantRuntime(next: AssistantRuntime | null): void { void runtime?.dispose(); runtime = next; if (next) hookProposals(); }

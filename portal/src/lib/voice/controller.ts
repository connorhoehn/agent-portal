// The dock's session controller: the client's frames in, the phase machine,
// the tool runner and the confirm card out (docs/voice-navigator-spec.md §3,
// §5, §7). React-free (VoiceFooterPane subscribes through
// useSyncExternalStore), so the whole loop runs under `node --test` against
// a mock mint.
//
// The tool loop, per delegation (§1 "P3 tool result"):
//   session.delegation.created           -> executing
//   response.event / output_item.done    -> prepare the call (schema, tenant,
//      { function_call }                    can()); a confirm tool with a real
//                                           runner shows the card (confirming),
//                                           anything else runs at once
//   the call settles                     -> response.item.create with the
//                                           shaped output; a /events row with
//                                           the args' sha256
//   nested response.completed, and no    -> exactly one response.create
//      call of the delegation still open
//   the continuation's response.completed -> the delegation is done
//      with nothing new to answer
// `response.completed` arrives BEFORE the result is sent (V1), so it is never
// read as "the call is done"; a result that settles first waits for it (and
// COMPLETION_GRACE_MS, should it never come).
//
// A confirm tool with a planner (actions.ts: computer, message, call;
// work.ts: queue_work; records.ts: decide, create, update) runs it first, reads only, so the card shows the resolved
// target and the composed command; a planner may end the call without a card
// (a refusal, several matching names). Nothing acts before the confirm, and a
// cancel answers { confirmed: false } and runs nothing.
//
// Money (§7): the controller meters elapsed/60 × the mint's rate against the
// hold, privately (the owner's rule: no dollar figure in the dock while a
// session runs, so the snapshot carries none); at 90% the voice says how many
// minutes are left once (commentary), at 100% (or the mint's maxSeconds) the
// dock hangs up itself with reason `cutoff`. A mint that answers 409 on the
// user's budget shows a card ("This session will exceed your budget by $x");
// Confirm mints again with confirmOverUserBudget. The user's daily voice
// minutes (G13) are the server's: a mint refused on them is the dock's
// `unavailable` reason (client.ts dailyMinutesText), and a session they cut
// short (the mint's `dailyMinutesLeft`) says how much of today is left.
//
// Confirming by voice (sweep 2 M2): only the user's first utterance after the
// card decides, and only once it has ended (a quiet UTTERANCE_GAP_MS, or the
// next word starting UTTERANCE_SPLIT_MS after the last one in the audio): an
// affirmation at its start confirms ("yes", "yeah", "yep", "confirm", "do
// it", "go ahead"; "ok", "okay" and "sure" only as the whole utterance), and
// any utterance with "instead", "no", "cancel", "wait" (and the like) cancels
// as soon as it is heard. Anything else leaves the card to a click.
//
// Every card the dock raises carries a fresh `requestId` (the library's
// VoicePending / VoicePendingChoice key, 2.510.5), so two requests with one
// title never share a card's state. The choice card no longer moves the phase:
// the library opens it on `pendingChoice` alone.
//
// The delegation's context (G31, contextWindow.ts): the model is sent each
// result in its compact form (no links, lists cut to fit), the page note only
// when the page changes (one current note), and the dock counts what a
// delegation reads (contextEstimate).
//
// The session log (G20, sessionEvents.ts): every phase change, refusal,
// confirm and choice shown or decided, tool call, cutoff and error is an
// event with the server's kind, batched to POST /:id/events at most once per
// 500 ms; the tool-call row carries the result's structured summary (counts,
// never the spoken line). No transcript text ever leaves the dock.
//
// Noticing the dock (G32, G33 item 4): when a confirm or choice card opens the
// dock pulses its control once (the library's `pulse`, 2.510.6). A confirm card
// also gets a silent note asking the voice for its card line (G40: "Say confirm
// to send.", or "Click confirm on the card to …" where only a click decides); if the voice has not said it within
// CARD_LINE_WAIT_MS the dock appends it as commentary itself, once. After a
// tool result, IDLE_PULSE_MS of no user input while the voice is silent pulses
// once more and says nothing: the voice speaks unprompted only for inbound
// events (G23).
//
// Dropped sessions (G35): every close says why (CloseWhy: the page going away,
// the connection failing, a hidden page behind a transport failure, the user).
// A session the page or the connection ended (never one the user ended) is
// resumable for RESUME_MS: its id goes to the host's ResumeStore (the pane's
// sessionStorage) at once, synchronously, since a page that unloads never
// sees the close's answer; the snapshot's `resumable` names it while the
// window lasts and `start({ resume: true })` mints with `resumeOf`, so the
// server links the rows, and tells the voice it continues an earlier session.
//
// Inbound awareness (G23, inbound.ts): a new direct message or notification
// during a live session is a silent note at once (sender, where, the first
// 120 characters, its ref) and one spoken line once the user is not
// mid-utterance (no words for INBOUND_QUIET_MS and the microphone quiet),
// waited for at most INBOUND_WAIT_MS; the voice speaks unprompted only here.
//
// Fewer cards (G41): once the user confirmed a message to a conversation, a
// later message to the same one in this session (no attachment, a tool the
// user may confirm by voice) runs without a card; its confirmed event says
// `by: 'session'` and `coveredBy` the first card's call. A new target, an
// attachment or a click-only tool always shows a card.
//
// Bounded requests (G43, sweep 6): one user turn (from one `input` frame to the
// next) runs at most MAX_CALLS_PER_DELEGATION tool calls across however many
// delegations the voice opens (a search that only changes its query counts
// double); the next call is answered `too-many-calls` with stop: true and
// `say: TOO_MANY_LINE`, and any further delegation in the same turn is
// refused alike.
//
// Stopped rounds (G59): a round with a terminal answer (too many calls, a
// navigation G51, a repeat refusal G29, a second failure G48) is still
// continued with one response.create, as every round is: a delegation whose
// outputs are never continued never resolves, and the Live API keeps the
// voice silent for the rest of the session (vs_d69bbb23, vs_5144e356). The
// continuation says the stop's line; a call it makes anyway is refused before
// it runs; after MAX_STOPPED_CONTINUATIONS the dock logs `delegation-stuck`
// and still continues every output (G64); a model still calling after
// MAX_RUNAWAY_CONTINUATIONS gets the session restarted. G60 watches every delegation for
// DELEGATION_EMPTY_MS: no call and no word from the voice after it completed
// sends DELEGATION_EMPTY_NOTE (silent) and logs `delegation-empty`. G65: the
// count runs from the delegation's last activity (a call, a result, the
// continuation, a progress frame), never while a call runs, once per
// delegation, and a delegation that called and completed is never empty. G61 counts
// the user's utterances the voice let pass (no word, no delegation; words
// for a card or a running call do not count): UNANSWERED_UTTERANCES of them
// log `unanswered` and raise the restart card ("Not answering: restart
// voice"), whose Confirm ends the session and starts one resuming it.
//
// Diagnostics without words (G63, diagnostics.ts): each finished user
// utterance is a `heard` row (word count, audio ms, and whether the voice
// answered, delegated, it resolved a card, or nothing came within 8 s), each
// voice utterance a `spoke` row (and what it followed), plus the voice's
// context ratio, the frame types the dock drops, mute changes and the meter
// per 30 s. Numbers and enums only; the middleware refuses anything else.
//
// Phase dwell (G36): the phase the dock shows (and logs) holds at least
// PHASE_DWELL_MS. A change inside the window waits for its end and is then
// taken from the machine as it stands, so a flap (listening, speaking,
// thinking within one millisecond) becomes one change or none, and no two
// phase events are ever closer than PHASE_DWELL_MS.

import { VoiceClient, type ClientEvent, type CloseCause, type CloseWhy, type MediaFactory, type StopReason, type TransportCause, type VoiceFrame, type VoiceMint } from './client.ts';
import { MIC_QUIET_MS, SPEAKING_LEVEL, initialMachine, phaseAt, reduce, sessionOpen, type MachineEvent, type MachineState, type VoicePhase } from './machine.ts';
import {
  channelTag, cancelledResult, confirmLine, confirmModeOf, hashToolArgs, localHref, needsConfirm, type CardAnswer, openableHref, planPreparedCall, prepareToolCall, refused, runPreparedCall, spokenOrdinal, toolAvailable,
  type ConfirmPlan, type PreparedCall, type ToolContext, type ToolResult, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';
import { VOICE_PLANNERS, VOICE_RUNNERS } from './actions.ts';
import { DEFAULT_TOAST_SECONDS } from './work.ts';
import { VoiceEventLog, argShape, refusalCode, resultSummary, type DockEvent } from './sessionEvents.ts';
import { FAILED_TWICE_NEXT, FailureGuard, RETRY_NEXT, RefusalGuard, STOP_NEXT, withFailure, withNext } from './refusals.ts';
import { inboundLine, inboundNote, type InboundItem } from './inbound.ts';
import { SessionDiagnostics } from './diagnostics.ts';
import { DelegationContext, PAGE_NOTE_REPLACES, briefOutput, modelOutput, summaryLine, verbosityNote, withSay, type Verbosity } from './contextWindow.ts';

export const TICK_MS = 100;
export const COMPLETION_GRACE_MS = 1500;
export const BUDGET_WARN_RATIO = 0.9;
/** G23: the user counts as mid-utterance until this long after their last word (and the microphone is quiet). */
export const INBOUND_QUIET_MS = 1200;
/** G23: how long an inbound line waits for the user to finish before it is left to the note alone. */
export const INBOUND_WAIT_MS = 10_000;
const INBOUND_RECHECK_MS = 400;

/** G43: the calls one delegation may make; the next is refused and ends it. */
export const MAX_CALLS_PER_DELEGATION = 4;
/** What the user hears when a delegation runs out of calls. */
export const TOO_MANY_LINE = 'Say what you want in one sentence.';
/**
 * G59: the continuations a stopped round still gets. A stopped round's outputs are always continued (the Live API keeps
 * the voice silent while a delegation's call has no continuation); a call the continuation makes anyway is refused
 * before it runs, and after this many the dock logs `delegation-stuck` (G64: and still continues every output).
 */
export const MAX_STOPPED_CONTINUATIONS = 2;
/** G64: a stopped delegation still calling after this many continuations restarts the session (resuming it). */
export const MAX_RUNAWAY_CONTINUATIONS = 8;
/** G60: a delegation (or a continuation) that called nothing and left the voice silent this long gets the note. */
export const DELEGATION_EMPTY_MS = 6000;
/** G60: a response that completed this recently may still be on its way to the voice: wait this long more. */
export const DELEGATION_ANSWER_GRACE_MS = 2000;
/** G60: the silent note when a delegation produced nothing to say. */
export const DELEGATION_EMPTY_NOTE = 'The last request reached the backend, but nothing ran and nothing came back to say. Answer the user now in one short sentence from what you already know, or say you could not do it and ask them to say it another way.';
/** G61: this many utterances in a row with no word and no delegation from the voice is a session that stopped answering. */
export const UNANSWERED_UTTERANCES = 3;
/** G61: words this far apart (wall clock) begin a new utterance. */
export const UTTERANCE_APART_MS = 1500;
/** G61: how long after the last utterance the voice has to answer before the session counts as not answering. */
export const UNANSWERED_WAIT_MS = 5000;
/** G61: the card id of the restart card (not a tool call). */
export const STALLED_CARD = 'voice-stalled';
/** G61: the restart card's words. */
export const STALLED_TEXT = {
  title: 'Not answering: restart voice',
  detail: 'The voice has not answered your last three requests. Restart picks up where you left off.',
  hint: 'Click Confirm to restart.',
} as const;

/** The least time a shown phase holds before the next one replaces it (G36). */
export const PHASE_DWELL_MS = 300;
/** The phases of a live session, the only ones that flap: the dwell holds one of these against another. */
const LIVE_PHASES: ReadonlySet<VoicePhase> = new Set<VoicePhase>(['listening', 'thinking', 'executing', 'speaking', 'confirming']);
/** How long the snapshot's `pulse` stays true: one library pulse (600 ms) per flip. */
export const PULSE_MS = 700;
/** After a tool result: this long with no user input and a silent voice pulses the dock once (G33 item 4). */
export const IDLE_PULSE_MS = 6000;
/** How long the voice has to say the card line itself before the dock appends it (G32). */
export const CARD_LINE_WAIT_MS = 2500;
/** G40: the hint the card shows under its text, per who may answer it. */
export const CARD_HINT = { voice: 'Say confirm, or cancel.', click: 'Click Confirm on the card; say cancel to drop it.' } as const;
/** How long a session the page or the connection dropped can be resumed (G35). */
export const RESUME_MS = 60_000;
/** The note a resumed session starts with. */
export const RESUME_NOTE = 'This session continues one that dropped a moment ago; the user may pick up where they left off. Earlier results are not in this session: read again what you need.';
/** The causes after which a session is resumable: the page went away or the connection failed, never the user's own end. */
const RESUMABLE: ReadonlySet<CloseCause> = new Set<CloseCause>(['pagehide', 'beforeunload', 'visibilitychange', 'ice-failed', 'ice-disconnected', 'peer-closed', 'channel-closed']);

/** Where the dock keeps a dropped session's id for RESUME_MS (sessionStorage in the browser: it survives a reload of the tab). */
/** Sweep 8: automatic runaway restarts per resume chain. */
export const MAX_RUNAWAY_RESTARTS = 1;
export const RUNAWAY_STOPPED_LINE = 'Voice stopped: it kept calling tools on its own. Start it again when you are ready.';
export interface ResumeRecord { sessionId: string; at: number; /** The workspace it was minted in (G44): never resumed from another. */ tenant?: string }
export interface ResumeStore {
  load(): ResumeRecord | null;
  save(r: ResumeRecord): void;
  clear(): void;
}

/** The silent note a confirm card sends the voice, with the line it asks for (G32, G40). */
export const cardNote = (line: string): string => `A confirm card is open in the dock and nothing happens until the user answers it. Say exactly: "${line}" and then wait.`;
/** The voice's own words that count as having said the card line. */
const CARD_SAID = /\bconfirm\b|\bcard\b/i;

/** The closed vocabulary a spoken answer is logged as (G40): the matched word, never the utterance. */
export function confirmPhrase(utterance: string): string | null {
  const t = utterance.toLowerCase();
  const cancel = /\b(instead|no|nope|cancel|wait|stop|don'?t|never ?mind)\b/.exec(t)?.[1];
  if (cancel) return cancel.replace(/\s+/g, ' ');
  const yes = /^[\s"'“]*(yes|yeah|yep|confirmed|confirm|do it|go ahead|ok|okay|sure)\b/.exec(t)?.[1];
  return yes ?? null;
}
const MAX_TURNS = 50;

export type ToolStatus = 'running' | 'done' | 'refused' | 'failed';

export interface VoiceTurnView {
  id: string;
  role: 'you' | 'assistant';
  text: string;
  at: number;
  toolCalls?: Array<{ name: string; status: ToolStatus; summary: string }>;
}

export interface VoicePendingView {
  callId: string;
  /** Unique per card raised (the library remounts the card when it changes). */
  requestId: number;
  tool: string;
  title: string;
  /** A line, or lines (a forecast, the fields a create sets). */
  detail?: string | string[];
  /** A decision (decide): the library's approve / reject toggle and note; Confirm answers `{ decision, note }`. */
  fields?: { decision: 'approve' | 'reject'; notePlaceholder?: string };
  /** G40: the line the card shows under its text (who may answer it), and that policy. Absent on the budget card. */
  hint?: string;
  confirmBy?: 'voice' | 'click';
}

/**
 * Several records matched a name (open's `ambiguous`, catalogue v2 V2-4): the
 * library's VoiceChoiceCard shows them; the user picks by click or by saying
 * the number, which the dock passes to the card as `ordinal`.
 */
export interface VoiceChoiceView {
  id: string;
  /** Unique per card raised, from the same counter as VoicePendingView's. */
  requestId: number;
  title: string;
  candidates: ReadonlyArray<{ title: string; subtitle?: string; kind?: string; href?: string }>;
  /** 1-based, set when the user said a number; the card chooses that row. */
  ordinal?: number;
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  level: number;
  outputLevel: number;
  elapsedSeconds: number;
  pending: VoicePendingView | null;
  /** The numbered choice an ambiguous name left, or null. */
  choice: VoiceChoiceView | null;
  lastLine: { role: 'you' | 'assistant'; text: string } | null;
  turns: readonly VoiceTurnView[];
  muted: boolean;
  /** Why unavailable, or why the last session ended early. */
  reason: string | null;
  /** The figure the last close reported, once it has. */
  closedSeconds: number | null;
  /** The session this dock minted last (live or ended), for the on-device transcript keep; null before any mint. */
  sessionId: string | null;
  /** True for PULSE_MS each time the dock asks for notice (a card opened, or silence after a result): VoiceDock's `pulse`. */
  pulse: boolean;
  /** A dropped session that a start now resumes (G35), within RESUME_MS of the drop; else null. */
  resumable: string | null;
}

type Timer = unknown;

export interface ControllerOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  media: MediaFactory | null;
  /** The tool context at call time (tenant, role, can(), the router). */
  toolContext(): ToolContext;
  runners?: Readonly<Record<string, VoiceToolRunner>>;
  /** What runs before a confirm card (default: actions.ts VOICE_PLANNERS); a tool without one shows describeConfirm's card. */
  planners?: Readonly<Record<string, VoiceToolPlanner>>;
  /** The card's wording, over the planner's own and defaultConfirmText. */
  describeConfirm?(call: PreparedCall, plan: ConfirmPlan | null): { title: string; detail?: string | string[] } | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  /** Re-evaluate time-based phases, levels and the budget. Default: an interval of TICK_MS. */
  autoTick?: boolean;
  closeWaitMs?: number;
  /**
   * The page context note (G21, pageContext.ts pageContextNote): tenant, page,
   * the record in view and its visible rows. Appended silently on start, on
   * every notePage() (navigation, a page publishing its rows) and after every
   * tool result, once per distinct text.
   */
  pageContext?(): string | null;
  /** The spoken length this device chose (G33, contextWindow.ts voiceVerbosity); terse when absent. */
  verbosity?(): Verbosity;
  /** Where a dropped session's id is kept for RESUME_MS (G35); without one nothing is resumable. */
  resume?: ResumeStore;
  /** Whether the page is hidden now (document.visibilityState): a transport drop behind a hidden page is `visibilitychange`. */
  hidden?(): boolean;
  /** The workspace the shell is in now (G44): a kept session from another one is not resumable here. */
  tenant?(): string;
  /** G63: epoch milliseconds for a `now()` reading (the `atMs` the heard and spoke rows carry); default the wall clock. */
  epoch?(at: number): number;
}

interface CallRecord { name: string; status: 'confirming' | 'running' | 'answered' }
/**
 * `stopped`: a call of this round was terminal (a repeat refusal G29, too many calls G43, a navigation G51, failed twice
 * G48): every later call of the delegation is refused before it runs. `closing` (G59): the continuations sent since.
 */
interface DelegationRecord {
  calls: Map<string, CallRecord>; completed: boolean; unanswered: number; grace: Timer | null; stopped: boolean; closing: number;
}
/** One user turn (G43, G51): the calls it used, its searches' shapes, whether it was stopped, and the page it opened. */
interface Turn { used: number; searches: Set<string>; stopped: boolean; navigated?: string; navigatedRef?: string }
/**
 * G60/G65: one delegation watched for an empty answer, for its whole life: its last activity (a call issued, a tool
 * result sent, a continuation sent, a response-progress frame), whether it ever called, when its current response
 * completed, whether that response is a continuation, and whether the watch is done (it fired, or it was answered).
 */
interface EmptyWatch {
  timer: Timer | null; lastActivity: number; called: boolean; completedAt: number | null; continuation: boolean; done: boolean;
}
/** What the card has heard: the first utterance after it, and whether that utterance has ended. */
interface Heard { text: string; lastEndMs: number | null; quiet: Timer | null; done: boolean }
interface Pending {
  callId: string; delegationId: string; call: PreparedCall; plan: ConfirmPlan | null; startedAt: number; heard: Heard; view: VoicePendingView;
  /** G40: who may answer, the line the voice asks with, when the card opened, and whether a spoken yes was already told to click. */
  mode: 'voice' | 'click'; line: string; shownAt: number; toldToClick?: boolean;
}

/** The card id of a mint that waits on the user's budget (not a tool call). */
export const BUDGET_CARD = 'voice-budget';

/** The 409 card: how far over the session goes, from the mint's estimate and what the budget has left. */
export function budgetConfirmText(b: { estimateUsd: number | null; remainingUsd: number | null; reason: string | null }): { title: string; detail: string } {
  const over = b.estimateUsd != null && b.remainingUsd != null ? Math.max(0, b.estimateUsd - Math.max(0, b.remainingUsd)) : null;
  const usd = (v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(2).replace(/\.00$/, '')}`;
  return {
    title: 'Over your budget',
    detail: over != null && over > 0
      ? `This session will exceed your budget by ${usd(over)}. Start it anyway?`
      : `${b.reason ?? 'This session goes over your budget.'} Start it anyway?`,
  };
}

/** Wall-clock quiet after the last word that ends the utterance. */
export const UTTERANCE_GAP_MS = 700;
/** An audio gap between two words (start_ms − the last end_ms) that starts a new utterance. */
export const UTTERANCE_SPLIT_MS = 300;

const AFFIRM = /^[\s"'“]*(yes|yeah|yep|confirm(ed)?|do it|go ahead)\b/i;
const BARE_OK = /^[\s"'“]*(ok|okay|sure)[\s.!,"'”]*$/i;
const CANCEL = /\b(instead|no|nope|cancel|wait|stop|don'?t|never ?mind)\b/i;

/**
 * The card's answer from the first utterance after it: `cancel` as soon as a
 * cancelling word is heard, `confirm` only once the utterance has ended and
 * starts with an affirmation (or is only "ok", "okay" or "sure"), else null.
 */
export function confirmDecision(utterance: string, ended: boolean): 'confirm' | 'cancel' | null {
  if (CANCEL.test(utterance)) return 'cancel';
  if (!ended) return null;
  return AFFIRM.test(utterance) || BARE_OK.test(utterance) ? 'confirm' : null;
}

/** The default card wording per tool, before (or without) a planner: the tool and its arguments, as plain text. */
export function defaultConfirmText(call: PreparedCall): { title: string; detail?: string } {
  const a = call.args;
  if (call.spec.name === 'message') {
    const target = (a['target'] ?? {}) as Record<string, unknown>;
    const where = target['kind'] === 'dm' ? String(target['name']) : channelTag(String(target['name']));
    return { title: `Post to ${where}`, detail: String(a['text'] ?? '') };
  }
  if (call.spec.name === 'computer' && a['action'] === 'start') {
    const ids = Array.isArray(a['initiatives']) ? (a['initiatives'] as string[]) : [];
    return { title: ids.length === 1 ? `Start a computer for ${ids[0]}` : `Start ${ids.length} computers`, detail: `${ids.join(', ')}. A running computer bills idle time until it stops.` };
  }
  if (call.spec.name === 'computer' && a['action'] === 'run') {
    return { title: `Run on ${String(a['computer'])}`, detail: String(a['phrase']).replace(/-/g, ' ') };
  }
  const detail = Object.entries(a).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
  return { title: call.spec.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), ...(detail ? { detail } : {}) };
}

export class VoiceController {
  private machine: MachineState = initialMachine;
  private client: VoiceClient | null = null;
  private mint: VoiceMint | null = null;
  private delegations = new Map<string, DelegationRecord>();
  private pending: Pending | null = null;
  private choice: (VoiceChoiceView & { heard: string }) | null = null;
  private choiceSeq = 0;
  /** One per card raised (confirm, choice, budget): the library's requestId. */
  private requestSeq = 0;
  private budgetCard: VoicePendingView | null = null;
  private turns: VoiceTurnView[] = [];
  private turnSeq = 0;
  /** The first turn number of the session minted last: the turns the on-device keep saves under its id. */
  private sessionTurnFrom = 1;
  /** The last page context the voice was given, so the same page is not appended twice. */
  private lastPageNote: string | null = null;
  private levels = { input: 0, output: 0 };
  private muted = false;
  private warned = false;
  private lastToastSeconds = DEFAULT_TOAST_SECONDS;
  private elapsedFrozen: number | null = null;
  private closedSeconds: number | null = null;
  /** Sessions this dock minted and the seconds their close reported (for a mint's `session-open` 409). */
  private ownSessions = new Map<string, number>();
  private snapshot: VoiceSnapshot;
  private listeners = new Set<() => void>();
  private ticker: Timer | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly runners: Readonly<Record<string, VoiceToolRunner>>;
  private readonly planners: Readonly<Record<string, VoiceToolPlanner>>;
  /** The session log's queue (sessionEvents.ts): batched, one request per 500 ms at most. */
  private readonly log: VoiceEventLog;
  /** G63: heard/spoke outcomes, context, dropped frames and the microphone, as numbers (diagnostics.ts). */
  private readonly diag: SessionDiagnostics;
  /** The calls refused in this session (G29): the second identical one is terminal. */
  private readonly refusals = new RefusalGuard();
  /** G48: the calls that failed in this session: retried once, and only when the user asked again. */
  private readonly failures = new FailureGuard();
  /** The dock's model of what a delegation reads (G31): recent results in full, older ones as a line, one page note. */
  private readonly context = new DelegationContext();
  /** G32 / G33 item 4: the pulse flag, its reset timer, the idle watch after a result, and what the voice said since a card opened. */
  private pulsing = false;
  private pulseTimer: Timer | null = null;
  private idleArmed = false;
  private idleTimer: Timer | null = null;
  private cardLineTimer: Timer | null = null;
  private saidSinceCard = '';
  /** G35: the dropped session a start resumes, and the timer that retires it after RESUME_MS. */
  private resumeRecord: ResumeRecord | null = null;
  private resumeTimer: Timer | null = null;
  /** Sweep 8: automatic runaway restarts made in this resume chain; a click (any start that is not a restart) begins a new chain. */
  private runawayRestarts = 0;
  /** The session being minted resumes one (the started note says so). */
  private resuming: string | null = null;
  /** The workspace the session minted last was minted in (G44). */
  private mintTenant: string | null = null;
  /** G43: the calls this user turn used (weighted), its searches' shapes without the query, and whether it was stopped. */
  /** `navigated` (G51): this user turn opened a page or a record; it is done, and any further call is refused. */
  private turn: Turn = { used: 0, searches: new Set(), stopped: false };
  /** The turn each running call was made in (G59): its answer marks that turn, not whichever is current when it lands. */
  private callTurns = new Map<string, Turn>();
  /** G60: the delegations watched for an empty answer, and when the voice last spoke. */
  private watches = new Map<string, EmptyWatch>();
  private lastVoiceAt: number | null = null;
  /** G61: utterances heard since the voice last answered, when the last word was heard, the check, and the restart card. */
  private unheard = 0;
  private lastHeardAt: number | null = null;
  private unheardTimer: Timer | null = null;
  private stalledCard: VoicePendingView | null = null;
  /** G41: the conversations a message card was confirmed for this session, and the call that confirmed each. */
  private coveredTargets = new Map<string, string>();
  /** G36: the phase shown and logged, since when, and the timer that re-reads the machine when a dwell ends. */
  private shownPhase: VoicePhase = 'off';
  private shownAt = Number.NEGATIVE_INFINITY;
  private dwellTimer: Timer | null = null;

  private readonly opts: ControllerOptions;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.runners = opts.runners ?? VOICE_RUNNERS;
    this.planners = opts.planners ?? VOICE_PLANNERS;
    this.log = new VoiceEventLog({ fetch: opts.fetch, now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer });
    this.diag = new SessionDiagnostics({
      emit: (data) => this.emit({ kind: 'client', data }), now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      ...(opts.epoch ? { epoch: opts.epoch } : {}),
    });
    this.loadResume();
    this.snapshot = this.build();
  }

  // ── store ────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): VoiceSnapshot => this.snapshot;

  /** Re-read levels, phases that depend on time, and the budget. */
  tick(): void {
    if (this.client && this.machine.base === 'live') {
      const l = this.client.levels();
      this.levels = { input: l.input, output: l.output };
      this.dispatch({ type: 'levels', at: this.now(), input: l.input, output: l.output }, false);
      this.diag.levelSample(l.input, this.muted);
      // The voice audibly talking is an answer (G60, G61), whether or not its transcript reached the data channel.
      if (l.output > SPEAKING_LEVEL) this.voiceAnswered(this.now());
      this.checkBudget();
    }
    this.publish();
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /** `resume`: mint as the continuation of the dropped session the snapshot names (G35); otherwise any kept one is forgotten. */
  async start(opts: { confirmOverUserBudget?: boolean; resume?: boolean; chain?: boolean } = {}): Promise<void> {
    if (sessionOpen(this.machine)) return;
    if (!opts.chain) this.runawayRestarts = 0;
    const resumeOf = opts.resume ? this.currentResumable() : null;
    this.forgetResume();
    this.reset();
    this.resuming = resumeOf;
    this.mintTenant = this.opts.tenant?.() ?? null;
    this.dispatch({ type: 'start' });
    const client = new VoiceClient({
      fetch: this.opts.fetch, media: this.opts.media, onEvent: (e) => this.onClientEvent(client, e),
      now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      knownSeconds: (id) => this.ownSessions.get(id) ?? null,
      ...(this.opts.closeWaitMs !== undefined ? { closeWaitMs: this.opts.closeWaitMs } : {}),
    });
    // A transport drop behind a hidden page is the page's doing (G35): say so, and keep the transport's own cause.
    client.dropCause = (transport: TransportCause): CloseWhy => (this.opts.hidden?.() ? { cause: 'visibilitychange', transport } : { cause: transport });
    this.client = client;
    if (this.opts.autoTick !== false) this.startTicker();
    await client.start({ ...(opts.confirmOverUserBudget ? { confirmOverUserBudget: true } : {}), ...(resumeOf ? { resumeOf } : {}) });
  }

  /**
   * End the session. `why` (G35) is what the close reports as its cause; by default the user's own end for
   * `closed`, else the reason. A page or connection cause keeps the session resumable for RESUME_MS, saved now.
   */
  async stop(reason: StopReason = 'closed', why?: CloseWhy | CloseCause): Promise<void> {
    const client = this.client;
    if (!client || !sessionOpen(this.machine)) return;
    const given: CloseWhy | undefined = typeof why === 'string' ? { cause: why } : why;
    const cause: CloseWhy | undefined = given ?? (reason === 'closed' ? { cause: 'user' } : reason === 'dropped' ? undefined : { cause: reason });
    if (cause && RESUMABLE.has(cause.cause)) this.keepResumable(client);
    // A card still up is answered as cancelled so the row records it.
    if (this.pending) this.resolvePending(false, 'click');
    this.clearChoice();
    // G63: the open utterances and windows are written before the close.
    this.diag.flush();
    this.dispatch({ type: 'stop' });
    await client.stop(reason, cause);
  }

  toggle(): Promise<void> {
    return sessionOpen(this.machine) ? this.stop('closed') : this.start();
  }

  toggleMute(): void {
    if (!this.client || this.machine.base !== 'live') return;
    this.muted = !this.muted;
    this.client.setMuted(this.muted);
    this.diag.mic(this.muted, 'user');
    this.publish();
  }

  /** `answer`: what a card with fields answered on a click (its toggle and note); a voice "yes" leaves the arguments standing. */
  confirm(by: 'voice' | 'click' = 'click', answer?: CardAnswer): void {
    if (this.budgetCard) { this.budgetCard = null; void this.start({ confirmOverUserBudget: true }); return; }
    if (this.stalledCard && !this.pending) { void this.restart(); return; }
    this.resolvePending(true, by, answer);
  }
  cancel(by: 'voice' | 'click' = 'click'): void {
    if (this.stalledCard && !this.pending) {
      this.emit({ kind: 'client', data: { event: 'unanswered-dismissed' } });
      this.clearStalled();
      return;
    }
    if (this.budgetCard) {
      this.budgetCard = null;
      this.dispatch({ type: 'unavailable', reason: 'Not started: this session would go over your budget.' });
      return;
    }
    this.resolvePending(false, by);
  }

  /**
   * G61: end this session and start one that resumes it (the server links the rows, the voice is told it continues).
   * The restart card's Confirm; the close is the user's own (they clicked it), the resume is kept here, not by cause.
   * G64: also the dock's own way out of a delegation whose model will not stop calling (`runaway`).
   */
  async restart(cause: 'unanswered' | 'runaway' = 'unanswered'): Promise<void> {
    const client = this.client;
    if (!client || this.machine.base !== 'live') return;
    this.emit({ kind: 'client', data: { event: 'restart', cause } });
    this.clearStalled();
    const id = client.mint?.sessionId;
    if (this.opts.resume) this.keepResumable(client);
    else if (id) this.resumeRecord = { sessionId: id, at: this.now(), ...(this.mintTenant ? { tenant: this.mintTenant } : {}) };
    await this.stop('closed', 'user');
    await this.start({ resume: true, chain: true });
  }

  /**
   * Sweep 8: the dock restarts a runaway session by itself once per resume chain. A model that runs away again after
   * the resume ends the session as unavailable with a line, and only a click starts another (which begins a new chain).
   */
  private async runawayRestart(): Promise<void> {
    if (this.runawayRestarts >= MAX_RUNAWAY_RESTARTS) {
      this.emit({ kind: 'client', data: { event: 'restart', cause: 'runaway-capped' } });
      await this.stop('closed', 'user');
      this.runawayRestarts = 0;
      this.dispatch({ type: 'unavailable', reason: RUNAWAY_STOPPED_LINE });
      return;
    }
    this.runawayRestarts += 1;
    await this.restart('runaway');
  }

  /**
   * A background job queue_work queued has ended (G19, work.ts): while the
   * session is live the voice says it (session.commentary.append) and the
   * transcript keeps the line; after it, the toast and the notification carry it.
   */
  noteJobOutcome(line: string): void {
    if (this.machine.base !== 'live' || !this.client) return;
    this.context.note(line.length + 15);
    this.commentary(this.client, `Tell the user: ${line}`);
    this.addLine('assistant', line);
  }

  /**
   * Something reached the user (G23, inbound.ts): the voice gets the note now and says the one line once the user is
   * not mid-utterance (or never, after INBOUND_WAIT_MS of talking). Nothing outside a live session.
   */
  noteInbound(item: InboundItem): void {
    const client = this.client;
    if (this.machine.base !== 'live' || !client) return;
    this.noteContext(inboundNote(item));
    const started = this.now();
    const sayWhenQuiet = () => {
      if (client !== this.client || this.machine.base !== 'live') return;
      if (this.midUtterance()) {
        if (this.now() - started >= INBOUND_WAIT_MS) { this.emit({ kind: 'client', data: { event: 'inbound', kind: item.kind, spoken: false } }); return; }
        this.setTimer(sayWhenQuiet, INBOUND_RECHECK_MS);
        return;
      }
      const line = inboundLine(item);
      this.context.note(line.length + 50);
      this.commentary(client, `Tell the user in one short line, then wait for them: ${line}`);
      this.addLine('assistant', line);
      this.emit({ kind: 'client', data: { event: 'inbound', kind: item.kind, spoken: true } });
    };
    sayWhenQuiet();
  }

  /** The user is talking: words within INBOUND_QUIET_MS, or the microphone active within the machine's quiet window. */
  private midUtterance(): boolean {
    const now = this.now();
    const m = this.machine;
    return (m.lastInputAt != null && now - m.lastInputAt < INBOUND_QUIET_MS) || (m.lastMicActiveAt != null && now - m.lastMicActiveAt < MIC_QUIET_MS);
  }

  /** How long a job toast stays once its job ends: the last mint's VOICE_TOAST_SECONDS, else the default. */
  toastSeconds(): number {
    return this.lastToastSeconds;
  }

  /**
   * The user picked row `index` of the choice card (by click, or the card acting on the spoken ordinal): open its
   * href, which the open runner built and checked, after the same in-portal, in-tenant check; the voice learns it silently.
   */
  choose(index: number): void {
    const c = this.choice;
    const picked = c?.candidates[index];
    this.clearChoice();
    if (c) this.emit({ kind: 'client', data: { event: 'choice-decided', requestId: c.requestId, index, candidates: c.candidates.length, by: c.ordinal ? 'voice' : 'click' } });
    if (c?.ordinal) this.diag.cardResolved();
    if (!c || !picked?.href) return;
    const ctx = this.toolContext();
    if (!openableHref(picked.href, ctx)) return;
    ctx.navigate(picked.href);
    this.addLine('assistant', `Opened ${picked.title}`);
    this.noteContext(`The user chose "${picked.title}" from the numbered choice; it is now open. Do not open it again.`);
  }

  cancelChoice(): void {
    if (this.choice) this.emit({ kind: 'client', data: { event: 'choice-cancelled', requestId: this.choice.requestId } });
    this.clearChoice();
  }

  /** The choice card opens on `pendingChoice` alone (ui-components 2.510.5), so it never touches the phase. */
  private clearChoice(): void {
    if (!this.choice) return;
    this.choice = null;
    this.publish();
  }

  /** The page in view, for the voice (G21): appended when it differs from the last one it was given. */
  notePage(): void {
    if (this.machine.base !== 'live' || !this.client) return;
    const text = this.opts.pageContext?.() ?? null;
    if (!text || text === this.lastPageNote) return;
    this.lastPageNote = text;
    // G31: one current page note, replaced rather than added to; sent only when the page in view changed.
    const note = `${text}\n${PAGE_NOTE_REPLACES}`;
    this.context.pageNote(note);
    this.client.appendThinking(note);
  }

  /** Silent page context for the voice (§1: session.thinking.append, delegation_id null). */
  noteContext(text: string): void {
    if (this.machine.base !== 'live' || !this.client) return;
    this.context.note(text.length);
    this.client.appendThinking(text);
  }

  /**
   * The delegation context as the dock counts it (G31, contextWindow.ts): `windowChars` is what a delegation reads
   * under the window (recent results in full, older ones as a line, the current page note, the transcript), `sentChars`
   * everything the dock sent; `turns` the delegations so far. Base (instructions and tools) not included.
   */
  contextEstimate(): { windowChars: number; sentChars: number; turns: number } {
    return { windowChars: this.context.windowChars(), sentChars: this.context.sentChars(), turns: this.context.turnCount };
  }

  /** The turns of the session minted last (the strip may still show an earlier session's): what the on-device keep saves. */
  sessionTurns(): readonly VoiceTurnView[] {
    return this.turns.filter((t) => Number(t.id.slice(1)) >= this.sessionTurnFrom);
  }

  clearTurns(): void {
    this.turns = [];
    this.publish();
  }

  dispose(): void {
    this.stopTicker();
    this.disarmIdle();
    this.clearCardLine();
    if (this.pulseTimer != null) this.clearTimer(this.pulseTimer);
    if (this.resumeTimer != null) this.clearTimer(this.resumeTimer);
    if (this.dwellTimer != null) this.clearTimer(this.dwellTimer);
    if (this.unheardTimer != null) this.clearTimer(this.unheardTimer);
    this.log.dispose();
    void this.stop('dropped');
    this.listeners.clear();
  }

  // ── client events ────────────────────────────────────────────────────────

  private onClientEvent(client: VoiceClient, e: ClientEvent): void {
    if (client !== this.client) return;
    switch (e.type) {
      case 'minted':
        this.mint = e.mint;
        // G44: only a resume the server linked (the mint echoes resumeOf) is announced and told to the voice.
        if (this.resuming && e.mint.resumeOf !== this.resuming) {
          this.emit({ kind: 'client', data: { event: 'resume-unlinked' } });
          this.resuming = null;
        }
        this.sessionTurnFrom = this.turnSeq + 1;
        if (typeof e.mint.toastSeconds === 'number' && e.mint.toastSeconds > 0) this.lastToastSeconds = e.mint.toastSeconds;
        if (e.mint.dailyMinutesLeft != null) {
          const m = Math.max(1, e.mint.dailyMinutesLeft);
          this.addLine('assistant', `About ${m} minute${m === 1 ? '' : 's'} of voice left today.`);
        }
        this.publish();
        return;
      case 'unavailable':
        this.stopTicker();
        this.dispatch({ type: 'unavailable', reason: e.reason });
        return;
      case 'budget-confirm':
        this.stopTicker();
        this.budgetCard = { callId: BUDGET_CARD, requestId: ++this.requestSeq, tool: 'voice_session', ...budgetConfirmText(e) };
        this.dispatch({ type: 'budget-confirm' });
        return;
      case 'failed':
        this.stopTicker();
        this.dispatch({ type: 'failed', reason: e.reason });
        return;
      case 'dropped':
        this.keepResumable(client);
        this.emit({ kind: 'error', data: { source: 'connection', event: 'dropped', reason: e.cause, hidden: this.opts.hidden?.() ?? false } });
        this.addLine('assistant', 'The voice connection dropped.');
        return;
      case 'ended':
        this.diag.flush();
        this.elapsedFrozen = client.elapsedSeconds();
        this.closedSeconds = e.seconds;
        if (client.mint && e.seconds != null) {
          this.ownSessions.set(client.mint.sessionId, e.seconds);
          if (this.ownSessions.size > 10) this.ownSessions.delete(this.ownSessions.keys().next().value!);
        }
        this.clearDelegations();
        this.disarmIdle();
        this.clearCardLine();
        this.stopTicker();
        this.dispatch({ type: 'closed', reason: e.reason === 'cutoff' ? 'The session reached its budget and was ended.' : e.reason === 'dropped' ? 'The connection dropped.' : null });
        return;
      case 'frame':
        this.onFrame(client, e.frame);
    }
  }

  private onFrame(client: VoiceClient, f: VoiceFrame): void {
    const at = this.now();
    switch (f.kind) {
      case 'started':
        this.emit({ kind: 'started' });
        this.dispatch({ type: 'started' });
        // G33: the device's spoken length, as context (the browser cannot append instructions).
        this.noteContext(verbosityNote(this.opts.verbosity?.() ?? 'terse'));
        // G35: a resumed session says so (the mint linked the rows when it was the user's own).
        if (this.resuming) { this.emit({ kind: 'client', data: { event: 'resumed', resumeOf: this.resuming } }); this.noteContext(RESUME_NOTE); this.resuming = null; }
        this.notePage();
        return;
      case 'input':
        this.context.speech(f.text.length);
        // The user answered: the idle watch after a result stands down (G33 item 4), and a new turn has its own calls (G43).
        this.disarmIdle();
        this.turn = { used: 0, searches: new Set(), stopped: false };
        this.heard(at);
        this.diag.userWords(f.text, f.startMs, f.endMs);
        this.appendTurn('you', f.text, at);
        this.dispatch({ type: 'input', at });
        if (this.pending) this.hearForPending(f.text, f.startMs, f.endMs);
        else if (this.choice) this.hearForChoice(f.text);
        return;
      case 'output':
        this.context.speech(f.text.length);
        this.voiceAnswered(at);
        this.diag.voiceWords(f.text, f.startMs, f.endMs);
        if (this.pending) this.saidSinceCard += f.text;
        // The voice is still talking: the 6 s of silence count from its last word.
        if (this.idleArmed) this.scheduleIdle(IDLE_PULSE_MS);
        this.appendTurn('assistant', f.text, at);
        this.dispatch({ type: 'output', at });
        return;
      case 'delegation':
        if (!this.delegations.has(f.delegationId)) {
          this.emit({ kind: 'delegation', data: { delegationId: f.delegationId } });
          this.diag.delegated();
          this.context.newTurn();
          this.watchEmpty(f.delegationId);
        }
        // The voice took the request (G61): it is answering.
        this.answeredByVoice();
        this.delegation(f.delegationId);
        this.dispatch({ type: 'delegation', id: f.delegationId });
        return;
      case 'call':
        void this.onCall(client, f.delegationId ?? `solo_${f.callId}`, f.callId, f.name, f.arguments);
        return;
      case 'response-completed':
        if (f.delegationId) { this.watchCompleted(f.delegationId); this.onCompleted(client, f.delegationId); }
        return;
      case 'response-failed':
        if (f.delegationId) { this.watchCompleted(f.delegationId); this.closeDelegation(f.delegationId); }
        return;
      case 'muted':
        // G63: the provider's word on the microphone, logged when it disagrees with the dock's.
        if (f.muted !== this.muted) this.diag.mic(f.muted, 'provider');
        this.muted = f.muted;
        this.publish();
        return;
      case 'error':
        // An error for one of our own events (a tool result, a context append) does not end the session.
        this.emit({ kind: 'error', data: { source: 'provider', message: f.message } });
        this.addLine('assistant', `Voice error: ${f.message}`);
        return;
      case 'usage':
        if (f.contextRatio != null) this.diag.contextRatio(f.contextRatio, f.seconds);
        this.publish();
        return;
      case 'other':
        this.diag.droppedFrame(f.type);
        this.publish();
        return;
      case 'closed':
      case 'audio':
      case 'ack':
      case 'response-progress':
        // G65: the backend is still producing this delegation's response: it is not idle.
        if (f.kind === 'response-progress' && f.delegationId) this.watchActivity(f.delegationId);
        this.publish();
    }
  }

  // ── the tool loop ────────────────────────────────────────────────────────

  private delegation(id: string): DelegationRecord {
    let rec = this.delegations.get(id);
    if (!rec) {
      rec = { calls: new Map(), completed: false, unanswered: 0, grace: null, stopped: false, closing: 0 };
      this.delegations.set(id, rec);
    }
    return rec;
  }

  private async onCall(client: VoiceClient, delegationId: string, callId: string, name: string, rawArgs: string): Promise<void> {
    const rec = this.delegation(delegationId);
    if (rec.calls.has(callId)) return;
    if (!this.machine.openDelegations.includes(delegationId)) this.dispatch({ type: 'delegation', id: delegationId });
    rec.calls.set(callId, { name, status: 'running' });
    // G60: a call is something to say. G65: and it is activity; the watch waits while it runs.
    this.watchActivity(delegationId, { called: true });
    // The call's shape (its enum arguments, a ref's kind), never its words: four open-shells read apart from four starts.
    this.emit({ kind: 'tool-call', tool: name, data: { callId, ...argShape(name, rawArgs) } });
    const startedAt = this.now();
    const ctx = this.toolContext();
    // G43: a delegation that has used its calls is told to stop. G59: a stopped round is still continued (maybeContinue),
    // so the delegation can end in the one line its stop output asks for; the voice speaks it, the dock adds nothing.
    const turn = this.turn;
    this.callTurns.set(callId, turn);
    // G51: a navigation ended this request; another page (or anything else) waits for the user's next words. Only a
    // read of the page just opened ("open this initiative, what should I work on") may follow.
    if (turn.navigated !== undefined && !readsThisPage(name, rawArgs, turn.navigatedRef)) {
      rec.stopped = true;
      const say = turn.navigated || 'The page is open.';
      await this.answer(client, delegationId, callId, name, withNext(refused('This request already opened a page, so nothing more runs for it. Say the one line about that page and call nothing more.', { code: 'navigated', say, stop: true }), name, ctx), startedAt, rawArgs);
      return;
    }
    const weight = callWeight(turn, name, rawArgs);
    if (turn.stopped || rec.stopped || turn.used + weight > MAX_CALLS_PER_DELEGATION) {
      rec.stopped = true;
      turn.stopped = true;
      const res = withNext(refused('Too many calls for one request.', { code: 'too-many-calls', say: TOO_MANY_LINE, stop: true }), name, ctx);
      await this.answer(client, delegationId, callId, name, res, startedAt, rawArgs);
      return;
    }
    turn.used += weight;
    const prepared = prepareToolCall(name, rawArgs, ctx);
    if (!prepared.ok) {
      await this.answer(client, delegationId, callId, name, prepared.result, startedAt, rawArgs);
      return;
    }
    const call = prepared.call;
    // G48: a call that failed runs again only once, and only after the user asked (a new turn); never on the model's own.
    const retry = this.failures.check(name, call.args, turn);
    if (retry) {
      await this.answer(client, delegationId, callId, name, withNext(refused(retry.reason, { code: retry.code }), name, ctx), startedAt, call.args);
      return;
    }
    // A dropped `command` (§6) is its own refused row: the attempt is on record, its text is not (§9).
    if (call.ignored?.length) {
      const sessionId = client.mint?.sessionId;
      void hashToolArgs({ ignored: call.ignored }).then((argsSha256) => { if (sessionId) this.log.toolCall(sessionId, { tool: name, argsSha256, outcome: 'refused', durationMs: 0 }, { outcome: 'refused', ignored: call.ignored!.length }); });
    }
    if (needsConfirm(call) && toolAvailable(name, this.runners)) {
      // The delegation asks one call at a time (parallel_tool_calls: false); a second card would hide the first.
      if (this.pending) {
        await this.answer(client, delegationId, callId, name, withNext(refused('Another action is waiting for the user to confirm. Ask again after it.'), name, ctx), startedAt, call.args);
        return;
      }
      let plan: ConfirmPlan | null = null;
      if (this.planners[name]) {
        this.attachTool(name, 'running', call.spec.says);
        this.dispatch({ type: 'call-running', callId });
        const planned = await planPreparedCall(call, ctx, this.planners);
        if (client !== this.client || this.machine.base !== 'live') return;
        if (planned && 'result' in planned) {
          await this.answer(client, delegationId, callId, name, planned.result, startedAt, call.args);
          return;
        }
        plan = planned?.plan ?? null;
        if (this.pending) {
          await this.answer(client, delegationId, callId, name, withNext(refused('Another action is waiting for the user to confirm. Ask again after it.'), name, ctx), startedAt, call.args);
          return;
        }
      }
      // G41: a message to a conversation the user already confirmed this session needs no second card.
      // A retry of a failed message is never covered: the card shows again so the text is confirmed afresh.
      const covered = this.failures.has(name, call.args) ? null : this.coveredBy(name, call, plan);
      if (covered) {
        this.emit({ kind: 'confirmed', tool: name, data: { callId, by: 'session', coveredBy: covered, afterMs: 0 } });
        await this.execute(client, delegationId, callId, call, startedAt, ctx, undefined, plan, undefined, covered);
        return;
      }
      rec.calls.set(callId, { name, status: 'confirming' });
      const described = this.opts.describeConfirm?.(call, plan) ?? (plan ? { title: plan.title, ...(plan.detail ? { detail: plan.detail } : {}) } : defaultConfirmText(call));
      // G40: the card says who may answer it, in its own hint line under Confirm / Cancel (ui-components 2.514.1).
      const mode = plan?.confirmBy === 'voice' ? 'voice' : confirmModeOf(call);
      const text = { ...described, hint: CARD_HINT[mode], confirmBy: mode };
      this.pending = { callId, delegationId, call, plan, startedAt, heard: { text: '', lastEndMs: null, quiet: null, done: false },
        mode, line: confirmLine(call, mode), shownAt: this.now(),
        view: { callId, requestId: ++this.requestSeq, tool: name, ...text, ...(plan?.fields ? { fields: plan.fields } : {}) } };
      this.attachTool(name, 'running', text.title);
      this.emit({ kind: 'confirm-shown', tool: name, data: { requestId: this.pending.view.requestId, callId, by: mode, ...(plan?.fields ? { fields: true } : {}) } });
      this.dispatch({ type: 'confirm-shown', callId });
      this.cardOpened(client);
      return;
    }
    await this.execute(client, delegationId, callId, call, startedAt, ctx);
  }

  /** G41: the call that confirmed this message's conversation earlier in the session, when it covers this one; else null. */
  private coveredBy(name: string, call: PreparedCall, plan: ConfirmPlan | null): string | null {
    if (name !== 'message' || confirmModeOf(call) !== 'voice' || !plan?.data || typeof plan.data !== 'object') return null;
    const d = plan.data as { channel?: unknown; attachment?: unknown };
    if (typeof d.channel !== 'string' || d.attachment) return null;
    return this.coveredTargets.get(d.channel) ?? null;
  }

  private async execute(client: VoiceClient, delegationId: string, callId: string, call: PreparedCall, startedAt: number, ctx: ToolContext, confirmedBy?: 'voice' | 'click', plan?: ConfirmPlan | null, answer?: CardAnswer, coveredBy?: string): Promise<void> {
    this.attachTool(call.spec.name, 'running', call.spec.says);
    this.dispatch({ type: 'call-running', callId });
    // A card without fields carries no answer, whatever the click sent.
    const given = plan?.fields ? answer : undefined;
    let res = await runPreparedCall(call, ctx, this.runners, plan?.data, given);
    if (confirmedBy) res = { ...res, output: { ...res.output, confirmed: true, by: confirmedBy, ...(given ? { decision: given.decision } : {}) } };
    if (coveredBy) res = { ...res, output: { ...res.output, confirmed: true, by: 'session', covered: 'confirmed for this conversation earlier in the session' } };
    // G41: a confirmed message covers its conversation for the rest of the session (no attachment).
    if (confirmedBy && call.spec.name === 'message' && res.outcome === 'done' && plan?.data && typeof plan.data === 'object') {
      const d = plan.data as { channel?: unknown; attachment?: unknown };
      if (typeof d.channel === 'string' && !d.attachment && !this.coveredTargets.has(d.channel)) this.coveredTargets.set(d.channel, callId);
    }
    // A post that failed no longer stands as confirmed: the conversation needs its card again.
    if (call.spec.name === 'message' && res.outcome === 'failed' && plan?.data && typeof plan.data === 'object') {
      const d = plan.data as { channel?: unknown };
      if (typeof d.channel === 'string') this.coveredTargets.delete(d.channel);
    }
    await this.answer(client, delegationId, callId, call.spec.name, res, startedAt, call.args, confirmedBy);
  }

  private async answer(client: VoiceClient, delegationId: string, callId: string, name: string, given: ToolResult, startedAt: number, args: unknown, confirmedBy?: 'voice' | 'click'): Promise<void> {
    // G59: the turn this call was made in (a card's answer can land after the user spoke again).
    const turn = this.callTurns.get(callId) ?? this.turn;
    this.callTurns.delete(callId);
    if (client !== this.client || this.machine.base !== 'live') return;
    // G47: a failed call (or a route's brake) says why: its code, its gate and the one line to say.
    let res = withFailure(given, name);
    // G48: a failure may be retried once when the user asks; the second failure of the same call ends the round.
    if (res.outcome === 'failed') {
      const { last } = this.failures.failed(name, args, turn);
      res = { ...res, output: { ...res.output, next: last ? FAILED_TWICE_NEXT : RETRY_NEXT, ...(last ? { stop: true } : {}) } };
    } else if (res.outcome === 'done') this.failures.succeeded(name, args);
    // G51: a navigation that ends the request (open's stop) closes the turn to further calls, but a read of the record
    // it opened ("open Alpha, what are its decisions": get with that ref) is that page's read (vs_5144e356).
    if (name === 'open' && res.outcome === 'done' && res.output['stop'] === true) {
      turn.navigated = typeof res.output['say'] === 'string' ? res.output['say'] : '';
      if (typeof res.output['ref'] === 'string') turn.navigatedRef = res.output['ref'];
    }
    // G29: the second identical refused call of the session is terminal. Its output says stop and the round is stopped:
    // its continuation (G59: always sent, or the voice falls silent for good) may only say the refusal; any further call
    // of the delegation is refused before it runs.
    const verdict = res.outcome === 'refused' ? this.refusals.refused(name, args, res.output) : null;
    if (verdict?.terminal) {
      res = { ...res, output: { ...res.output, stop: true, next: STOP_NEXT } };
      this.delegation(delegationId).stopped = true;
    }
    // G48: the second failure of the same call stops the round alike.
    if (res.outcome === 'failed' && res.output['stop'] === true) this.delegation(delegationId).stopped = true;
    // G31: the model gets the compact form (no links, lists cut to fit); the strip, the log and the kept rows the full one.
    // G33: list, search and get hand the model the count, three rows, `more` and a ready `say` line, unless `detail`.
    const wire = JSON.stringify(modelOutput(briefOutput(name, args, withSay(name, res.outcome, res.output, res.summary))));
    client.sendToolOutput(callId, wire);
    this.diag.resultSent();
    this.context.result(wire.length, summaryLine(name, res.summary));
    this.armIdle();
    // The repeat is on the log; the continuation says the refusal (STOP_NEXT), so the dock does not say it again.
    if (verdict?.speak) this.emit({ kind: 'client', data: { event: 'refusal-repeated', tool: name, reason: refusalCode(res.output) } });
    // The page the result left the user on (G21), before the continuation reads it.
    this.notePage();
    this.noteChoice(res);
    const rec = this.delegation(delegationId);
    rec.calls.set(callId, { name, status: 'answered' });
    rec.unanswered += 1;
    // G65: a tool result sent is activity; the next call may take the model a while to issue.
    this.watchActivity(delegationId);
    this.attachTool(name, res.outcome === 'done' ? 'done' : res.outcome === 'failed' ? 'failed' : 'refused', res.summary);
    this.dispatch({ type: 'call-done', callId });
    // The refusal's code (no-grant, budget, ambiguous, not-on-this-page…), never its sentence.
    if (res.outcome === 'refused') this.emit({ kind: 'refused', tool: name, data: { tool: name, reason: refusalCode(res.output), callId } });
    // The row keeps a hash of the arguments, never the arguments (§9), and the result's counts, never its spoken line.
    const sessionId = client.mint?.sessionId;
    const durationMs = Math.max(0, Math.round(this.now() - startedAt));
    const summary = { ...argShape(name, args), ...resultSummary(res.outcome, res.output) };
    void hashToolArgs(args).then((argsSha256) => {
      if (sessionId) this.log.toolCall(sessionId, { tool: name, argsSha256, outcome: res.outcome, durationMs, ...(confirmedBy ? { confirmedBy } : {}) }, summary);
    });
    this.maybeContinue(client, delegationId);
  }

  /** An ambiguous result whose candidates each open on a page becomes the choice card; any other answered call clears it. */
  private noteChoice(res: ToolResult): void {
    const cands = res.output['kind'] === 'ambiguous' && Array.isArray(res.output['candidates']) ? res.output['candidates'] as Array<Record<string, unknown>> : null;
    const rows = cands?.filter((c) => typeof c['title'] === 'string' && typeof c['href'] === 'string' && localHref(c['href'] as string)) ?? [];
    // G62: one candidate is not a choice; a card needs at least two rows to choose between.
    if (cands && rows.length > 1 && rows.length === cands.length) {
      this.clearChoice();
      this.choice = {
        id: `choice-${++this.choiceSeq}`, requestId: ++this.requestSeq, heard: '',
        title: 'Which one?',
        candidates: rows.map((c) => ({
          title: c['title'] as string, href: c['href'] as string,
          ...(typeof c['subtitle'] === 'string' ? { subtitle: c['subtitle'] } : {}), ...(typeof c['kind'] === 'string' ? { kind: c['kind'] } : {}),
        })),
      };
      this.emit({ kind: 'client', data: { event: 'choice-shown', requestId: this.choice.requestId, candidates: rows.length } });
      this.pulseOnce('card');
    } else this.clearChoice();
    this.publish();
  }

  private onCompleted(client: VoiceClient, delegationId: string): void {
    const rec = this.delegations.get(delegationId);
    if (!rec) return;
    rec.completed = true;
    this.maybeContinue(client, delegationId);
  }

  private maybeContinue(client: VoiceClient, delegationId: string): void {
    const rec = this.delegations.get(delegationId);
    if (!rec) return;
    const open = [...rec.calls.values()].some((c) => c.status !== 'answered');
    if (open) return;
    if (rec.unanswered > 0) {
      if (!rec.completed) {
        // The result settled before the response that asked for it completed: wait for it, bounded.
        if (rec.grace == null) {
          rec.grace = this.setTimer(() => { rec.grace = null; rec.completed = true; this.maybeContinue(client, delegationId); }, COMPLETION_GRACE_MS);
        }
        return;
      }
      if (rec.grace != null) { this.clearTimer(rec.grace); rec.grace = null; }
      // G59: a stopped round (G29 repeat, G43 too many, G51 navigated, G48 failed twice) is continued like any other.
      // Without the response.create the delegation never resolves and the Live API keeps the voice silent for the rest
      // of the session (vs_d69bbb23 01:41:41, vs_5144e356 13:29:44). Its output told the delegation to stop and say one
      // line; a call it makes anyway is refused before it runs; after MAX_STOPPED_CONTINUATIONS the dock gives up on it.
      // G64: the dock never lets a delegation go without its continuation (that was G59's hang again: vs_d69bbb23 seq
      // 193, vs_f86d7b03 59, vs_9b06806f 50 in the replay suite). Past MAX_STOPPED_CONTINUATIONS it logs
      // `delegation-stuck` once and keeps continuing; past MAX_RUNAWAY_CONTINUATIONS a model that will not stop gets
      // the session restarted (resuming it), which ends the delegation on the server.
      if (rec.stopped) {
        if (rec.closing === MAX_STOPPED_CONTINUATIONS) this.emit({ kind: 'client', data: { event: 'delegation-stuck', delegationId } });
        if (rec.closing >= MAX_RUNAWAY_CONTINUATIONS) {
          this.closeDelegation(delegationId);
          void this.runawayRestart();
          return;
        }
        rec.closing += 1;
      }
      // One response.create for every output of this round (§1).
      rec.unanswered = 0;
      rec.completed = false;
      rec.calls.clear();
      client.requestResponse();
      // G60/G65: the continuation is the same delegation's: its one watch goes on from now (never a fresh one).
      this.watchActivity(delegationId, { continuation: true });
      return;
    }
    // The continuation (or a delegation that called nothing) completed: it is done.
    if (rec.completed) this.closeDelegation(delegationId);
  }

  private closeDelegation(id: string): void {
    const rec = this.delegations.get(id);
    if (rec?.grace != null) this.clearTimer(rec.grace);
    this.delegations.delete(id);
    this.dispatch({ type: 'delegation-done', id });
  }

  private clearDelegations(): void {
    for (const rec of this.delegations.values()) if (rec.grace != null) this.clearTimer(rec.grace);
    this.delegations.clear();
    for (const w of this.watches.values()) if (w.timer != null) this.clearTimer(w.timer);
    this.watches.clear();
    this.callTurns.clear();
  }

  // ── G60: a delegation that ends with nothing to say ─────────────────────

  /**
   * Watch a delegation from its creation, for its whole life (G65: one watch, so it fires at most once): no activity
   * and no running call for DELEGATION_EMPTY_MS, or no word from the voice after a delegation that never called
   * completed, is empty.
   */
  private watchEmpty(id: string): void {
    if (this.watches.has(id)) return;
    const w: EmptyWatch = { timer: null, lastActivity: this.now(), called: false, completedAt: null, continuation: false, done: false };
    this.watches.set(id, w);
    this.scheduleEmpty(id, w, DELEGATION_EMPTY_MS);
  }

  private scheduleEmpty(id: string, w: EmptyWatch, ms: number): void {
    if (w.timer != null) this.clearTimer(w.timer);
    w.timer = this.setTimer(() => this.checkEmpty(id, w), Math.max(0, ms));
  }

  /**
   * G65: the delegation did something (a call issued, a tool result sent, a continuation sent, a response-progress
   * frame): the DELEGATION_EMPTY_MS count starts again. A continuation is a new response that has not completed yet.
   */
  private watchActivity(id: string, opts: { called?: boolean; continuation?: boolean } = {}): void {
    const w = this.watches.get(id);
    if (!w || w.done) return;
    w.lastActivity = this.now();
    if (opts.called) w.called = true;
    if (opts.continuation) { w.continuation = true; w.completedAt = null; }
    this.scheduleEmpty(id, w, DELEGATION_EMPTY_MS);
  }

  private watchCompleted(id: string): void {
    const w = this.watches.get(id);
    if (w && !w.done && w.completedAt == null) w.completedAt = this.now();
  }

  /** A call of this delegation is still running (or waiting on its card): the delegation is working, not empty. */
  private callRunning(id: string): boolean {
    const rec = this.delegations.get(id);
    return !!rec && [...rec.calls.values()].some((c) => c.status !== 'answered');
  }

  /**
   * The watch is due. Never while a call runs (its result re-arms the watch), never within DELEGATION_EMPTY_MS of the
   * delegation's last activity (G65: a search finished and the model took 7 s to issue the next one; the old watch,
   * re-armed fresh at the continuation, nudged the voice mid-work twice). A delegation that called and completed is
   * never empty; one that called nothing and completed a moment ago gets DELEGATION_ANSWER_GRACE_MS more, and the
   * voice's words after it completed answer it. Otherwise the voice is told, silently, to answer or to say it could
   * not, and the log says `delegation-empty` (vs_71839299 13:49:41, vs_0d1c427b 13:53:04): once per delegation.
   */
  private checkEmpty(id: string, w: EmptyWatch): void {
    w.timer = null;
    if (this.watches.get(id) !== w || w.done) return;
    if (this.machine.base !== 'live') { w.done = true; return; }
    if (this.callRunning(id)) return;
    const now = this.now();
    const quiet = now - w.lastActivity;
    if (quiet < DELEGATION_EMPTY_MS) { this.scheduleEmpty(id, w, DELEGATION_EMPTY_MS - quiet); return; }
    if (w.completedAt != null) {
      if (w.called) { w.done = true; return; }
      const since = now - w.completedAt;
      if (since < DELEGATION_ANSWER_GRACE_MS) { this.scheduleEmpty(id, w, DELEGATION_ANSWER_GRACE_MS - since); return; }
      if (this.lastVoiceAt != null && this.lastVoiceAt >= w.completedAt) { w.done = true; return; }
    }
    w.done = true;
    this.emit({ kind: 'client', data: { event: 'delegation-empty', delegationId: id, completed: w.completedAt != null, continuation: w.continuation } });
    this.noteContext(DELEGATION_EMPTY_NOTE);
  }

  // ── G61: a session that stopped answering ───────────────────────────────

  /** The voice spoke (a transcript word, or its audio above the speaking level): it is answering. */
  private voiceAnswered(at: number): void {
    this.lastVoiceAt = at;
    this.answeredByVoice();
  }

  private answeredByVoice(): void {
    this.unheard = 0;
    if (this.unheardTimer != null) { this.clearTimer(this.unheardTimer); this.unheardTimer = null; }
    if (this.stalledCard) this.clearStalled();
  }

  /**
   * A word from the user. Words UTTERANCE_APART_MS after the last one begin an utterance; UNANSWERED_UTTERANCES of them
   * with no word and no delegation from the voice in between, and UNANSWERED_WAIT_MS after the last, is a session that
   * stopped answering (vs_89fba6d6 13:56:38 to 14:00:25). Words for a card (confirm, a choice) or during a running
   * call are not requests to the voice and do not count.
   */
  private heard(at: number): void {
    const forDock = this.pending != null || this.choice != null || this.stalledCard != null || this.machine.runningCalls.length > 0;
    const fresh = this.lastHeardAt == null || at - this.lastHeardAt >= UTTERANCE_APART_MS;
    this.lastHeardAt = at;
    if (forDock) return;
    if (fresh) this.unheard += 1;
    if (this.unheardTimer != null) this.clearTimer(this.unheardTimer);
    this.unheardTimer = this.setTimer(() => { this.unheardTimer = null; this.checkUnanswered(); }, UNANSWERED_WAIT_MS);
  }

  private checkUnanswered(): void {
    if (this.unheard < UNANSWERED_UTTERANCES || this.machine.base !== 'live' || this.pending || this.choice || this.stalledCard) return;
    this.emit({ kind: 'client', data: { event: 'unanswered', utterances: this.unheard } });
    this.stalledCard = { callId: STALLED_CARD, requestId: ++this.requestSeq, tool: 'voice_session', ...STALLED_TEXT };
    this.pulseOnce('card');
    this.publish();
  }

  private clearStalled(): void {
    this.unheard = 0;
    if (!this.stalledCard) return;
    this.stalledCard = null;
    this.publish();
  }


  /** "The second one": the card is told the ordinal and chooses it (once per value); a number past the rows is ignored. */
  private hearForChoice(text: string): void {
    const c = this.choice;
    if (!c) return;
    c.heard += text;
    const n = spokenOrdinal(c.heard);
    if (n == null || n > c.candidates.length || c.ordinal === n) return;
    this.choice = { ...c, ordinal: n };
    this.publish();
  }

  /** The first utterance after the card decides it (confirmDecision); a later one is the voice's, not the card's. */
  /**
   * The card listens until it resolves (sweep 6): each utterance after it is heard whole; a cancelling word cancels
   * as soon as it is heard, an affirmation decides once the utterance ends, anything else is let go and the next
   * utterance is heard afresh. The voice's own card line picked up by the microphone is never an answer.
   */
  private hearForPending(text: string, startMs: number | null, endMs: number | null): void {
    const p = this.pending;
    if (!p) return;
    let h = p.heard;
    // The next word starts well after the last one ended: that utterance is over, and this word begins the next.
    if (h.text.trim() && startMs != null && h.lastEndMs != null && startMs - h.lastEndMs >= UTTERANCE_SPLIT_MS) {
      this.endUtterance(p);
      if (this.pending !== p) return;
      h = p.heard;
    }
    h.text += text;
    if (endMs != null) h.lastEndMs = endMs;
    if (!echoesCardLine(h.text, p.line) && confirmDecision(h.text, false) === 'cancel') { this.resolvePending(false, 'voice'); return; }
    if (h.quiet != null) this.clearTimer(h.quiet);
    h.quiet = this.setTimer(() => { h.quiet = null; if (this.pending === p && p.heard === h) this.endUtterance(p); }, UTTERANCE_GAP_MS);
  }

  private endUtterance(p: Pending): void {
    const h = p.heard;
    if (h.done) return;
    h.done = true;
    if (h.quiet != null) { this.clearTimer(h.quiet); h.quiet = null; }
    // The voice's own line through the speaker (no echo cancellation, an external mic) is not the user's answer.
    if (echoesCardLine(h.text, p.line)) { this.listenAgain(p); return; }
    const decision = confirmDecision(h.text, true);
    // G40: a click-only card (computer, decide, an access request) is never confirmed by voice: the voice says to click, once.
    if (decision === 'confirm' && p.mode === 'click') { this.tellToClick(p); return; }
    if (decision) { this.resolvePending(decision === 'confirm', 'voice'); return; }
    this.listenAgain(p);
  }

  /** The card hears the next utterance afresh (a cancel still cancels it). */
  private listenAgain(p: Pending): void {
    if (this.pending === p) p.heard = { text: '', lastEndMs: null, quiet: null, done: false };
  }

  private tellToClick(p: Pending): void {
    this.emit({ kind: 'client', data: { event: 'click-required', requestId: p.view.requestId, tool: p.call.spec.name, phrase: confirmPhrase(p.heard.text) } });
    // Keep listening: a spoken cancel after this still cancels (sweep 6).
    this.listenAgain(p);
    if (p.toldToClick || !this.client) return;
    p.toldToClick = true;
    this.context.note(p.line.length + 40);
    this.commentary(this.client, `Tell the user, in these words: ${p.line}`);
    this.addLine('assistant', p.line);
  }

  private resolvePending(confirmed: boolean, by: 'voice' | 'click', answer?: CardAnswer): void {
    const p = this.pending;
    const client = this.client;
    if (!p || !client) return;
    if (p.heard.quiet != null) { this.clearTimer(p.heard.quiet); p.heard.quiet = null; }
    this.pending = null;
    this.clearCardLine();
    // G40: the matched word of a spoken answer (the closed vocabulary, never the utterance) and how long the card waited.
    const phrase = by === 'voice' ? confirmPhrase(p.heard.text) : null;
    this.emit({ kind: confirmed ? 'confirmed' : 'cancelled', tool: p.call.spec.name, data: {
      requestId: p.view.requestId, by, callId: p.callId, afterMs: Math.max(0, Math.round(this.now() - p.shownAt)), ...(phrase ? { phrase } : {}),
    } });
    this.dispatch({ type: 'confirm-resolved', callId: p.callId });
    if (by === 'voice') this.diag.cardResolved();
    if (confirmed) {
      void this.execute(client, p.delegationId, p.callId, p.call, p.startedAt, this.toolContext(), by, p.plan, answer);
    } else {
      void this.answer(client, p.delegationId, p.callId, p.call.spec.name, cancelledResult(by), p.startedAt, p.call.args, by);
    }
  }

  // ── money (§7) ───────────────────────────────────────────────────────────

  private budget(): { usedUsd: number; holdUsd: number } | null {
    if (!this.mint) return null;
    const used = Math.round((this.elapsed() / 60) * this.mint.budget.usdPerMinute * 10_000) / 10_000;
    return { usedUsd: used, holdUsd: this.mint.budget.holdUsd };
  }

  private checkBudget(): void {
    const b = this.budget();
    const mint = this.mint;
    if (!b || !mint || !this.client) return;
    // The ratio from the unrounded spend: the meter's 4-place figure can sit just under 90% for a whole tick.
    const ratio = b.holdUsd > 0 ? ((this.elapsed() / 60) * mint.budget.usdPerMinute) / b.holdUsd : 0;
    const timeRatio = mint.maxSeconds > 0 ? this.elapsed() / mint.maxSeconds : 0;
    if (ratio >= 1 || timeRatio >= 1) {
      this.emit({ kind: 'client', data: { event: 'cutoff', by: ratio >= 1 ? 'budget' : 'time', elapsedSeconds: Math.floor(this.elapsed()) } });
      void this.stop('cutoff');
      return;
    }
    if (!this.warned && (ratio >= BUDGET_WARN_RATIO || timeRatio >= BUDGET_WARN_RATIO)) {
      this.warned = true;
      this.emit({ kind: 'client', data: { event: 'budget-warning', by: ratio >= BUDGET_WARN_RATIO ? 'budget' : 'time' } });
      const leftSec = Math.min(
        mint.budget.usdPerMinute > 0 ? ((b.holdUsd - b.usedUsd) / mint.budget.usdPerMinute) * 60 : Infinity,
        mint.maxSeconds - this.elapsed(),
      );
      const minutes = Math.max(1, Math.round(leftSec / 60));
      const line = `About ${minutes} minute${minutes === 1 ? '' : 's'} left on this voice session.`;
      this.commentary(this.client, `Tell the user: ${line}`);
      this.addLine('assistant', line);
    }
  }

  private elapsed(): number {
    return this.elapsedFrozen ?? this.client?.elapsedSeconds() ?? 0;
  }

  // ── transcript ───────────────────────────────────────────────────────────

  private appendTurn(role: 'you' | 'assistant', text: string, at: number): void {
    if (!text) return;
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === role && !last.toolCalls?.length) {
      this.turns = [...this.turns.slice(0, -1), { ...last, text: last.text + text }];
    } else {
      this.pushTurn({ id: `t${++this.turnSeq}`, role, text: text.trimStart(), at });
    }
  }

  private pushTurn(turn: VoiceTurnView): void {
    this.turns = [...this.turns, turn].slice(-MAX_TURNS);
  }

  private addLine(role: 'you' | 'assistant', text: string): void {
    this.pushTurn({ id: `t${++this.turnSeq}`, role, text, at: this.now() });
    this.publish();
  }

  /** A tool call in the transcript: replaces the newest running entry of the same tool, else joins the latest turn. */
  private attachTool(name: string, status: ToolStatus, summary: string): void {
    const entry = { name, status, summary };
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const calls = this.turns[i]!.toolCalls ?? [];
      const j = calls.map((c) => (c.name === name && c.status === 'running')).lastIndexOf(true);
      if (j >= 0) {
        const next = [...this.turns];
        next[i] = { ...this.turns[i]!, toolCalls: calls.map((c, k) => (k === j ? entry : c)) };
        this.turns = next;
        return;
      }
    }
    const last = this.turns[this.turns.length - 1];
    if (!last) { this.pushTurn({ id: `t${++this.turnSeq}`, role: 'assistant', text: '', at: this.now(), toolCalls: [entry] }); return; }
    this.turns = [...this.turns.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), entry] }];
  }

  // ── resuming a dropped session (G35) ─────────────────────────────────────

  /** The session this client minted, kept for RESUME_MS: written at once (the page may be unloading). */
  private keepResumable(client: VoiceClient): void {
    const id = client.mint?.sessionId;
    if (!id || !this.opts.resume) return;
    const rec: ResumeRecord = { sessionId: id, at: this.now(), ...(this.mintTenant ? { tenant: this.mintTenant } : {}) };
    try { this.opts.resume.save(rec); } catch { /* storage refused: nothing to resume */ }
    this.resumeRecord = rec;
    this.armResumeExpiry();
    this.publish();
  }

  private loadResume(): void {
    let rec: ResumeRecord | null = null;
    try { rec = this.opts.resume?.load() ?? null; } catch { rec = null; }
    if (rec && typeof rec.sessionId === 'string' && typeof rec.at === 'number' && this.now() - rec.at < RESUME_MS) {
      this.resumeRecord = rec;
      this.armResumeExpiry();
    } else if (rec) { try { this.opts.resume?.clear(); } catch { /* nothing kept */ } }
  }

  private currentResumable(): string | null {
    const r = this.resumeRecord;
    if (!r || this.now() - r.at >= RESUME_MS) return null;
    // G44: a session minted in another workspace is never resumed here (the server would not link it either).
    const here = this.opts.tenant?.();
    return r.tenant && here && r.tenant !== here ? null : r.sessionId;
  }

  private armResumeExpiry(): void {
    if (this.resumeTimer != null) this.clearTimer(this.resumeTimer);
    const r = this.resumeRecord;
    if (!r) return;
    this.resumeTimer = this.setTimer(() => { this.resumeTimer = null; this.forgetResume(); this.publish(); }, Math.max(0, r.at + RESUME_MS - this.now()));
  }

  private forgetResume(): void {
    if (this.resumeTimer != null) this.clearTimer(this.resumeTimer);
    this.resumeTimer = null;
    if (this.resumeRecord) { try { this.opts.resume?.clear(); } catch { /* nothing kept */ } }
    this.resumeRecord = null;
  }

  // ── noticing the dock (G32, G33 item 4) ─────────────────────────────────

  /** One pulse of the dock's control: `pulse` true for PULSE_MS (the library animates once per flip to true). */
  private pulseOnce(cause: 'card' | 'idle'): void {
    if (this.pulsing) return;
    this.pulsing = true;
    this.emit({ kind: 'client', data: { event: 'pulse', cause } });
    this.publish();
    this.pulseTimer = this.setTimer(() => { this.pulseTimer = null; this.pulsing = false; this.publish(); }, PULSE_MS);
  }

  /** A confirm card opened: pulse, ask the voice for its line, and say it ourselves if it has not within CARD_LINE_WAIT_MS. */
  private cardOpened(client: VoiceClient): void {
    this.disarmIdle();
    this.pulseOnce('card');
    this.saidSinceCard = '';
    const p = this.pending;
    if (!p) return;
    this.noteContext(cardNote(p.line));
    this.clearCardLine();
    this.cardLineTimer = this.setTimer(() => {
      this.cardLineTimer = null;
      if (this.pending !== p || client !== this.client || this.machine.base !== 'live') return;
      if (CARD_SAID.test(this.saidSinceCard)) return;
      this.context.note(p.line.length + 40);
      this.commentary(client, `Tell the user, in these words: ${p.line}`);
      this.addLine('assistant', p.line);
      this.emit({ kind: 'client', data: { event: 'card-line', requestId: p.view.requestId } });
    }, CARD_LINE_WAIT_MS);
  }

  private clearCardLine(): void {
    if (this.cardLineTimer != null) this.clearTimer(this.cardLineTimer);
    this.cardLineTimer = null;
  }

  /** A result went to the voice: watch for IDLE_PULSE_MS of silence from both sides. */
  private armIdle(): void {
    this.idleArmed = true;
    this.scheduleIdle(IDLE_PULSE_MS);
  }

  private scheduleIdle(ms: number): void {
    if (this.idleTimer != null) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => { this.idleTimer = null; this.idleCheck(); }, ms);
  }

  private disarmIdle(): void {
    this.idleArmed = false;
    if (this.idleTimer != null) this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Six seconds after the result (or the voice's last word): the user has said
   * nothing. While the voice is still talking or the backend still working,
   * wait another round; a card already pulsed for itself. Otherwise pulse once
   * and say nothing (no commentary, no response).
   */
  private idleCheck(): void {
    if (!this.idleArmed || this.machine.base !== 'live') return;
    if (this.pending || this.choice) { this.disarmIdle(); return; }
    const phase = phaseAt(this.machine, this.now());
    if (phase === 'speaking' || phase === 'executing' || phase === 'thinking') { this.scheduleIdle(IDLE_PULSE_MS); return; }
    this.disarmIdle();
    this.pulseOnce('idle');
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /** The page's tool context, with the session this dock minted last (per-session memory: G30's shell tabs). */
  private toolContext(): ToolContext {
    const ctx = this.opts.toolContext();
    return { ...ctx, sessionId: this.mint?.sessionId ?? null };
  }

  private reset(): void {
    this.diag.reset();
    this.turn = { used: 0, searches: new Set(), stopped: false };
    this.clearDelegations();
    this.lastVoiceAt = null;
    this.lastHeardAt = null;
    this.unheard = 0;
    if (this.unheardTimer != null) this.clearTimer(this.unheardTimer);
    this.unheardTimer = null;
    this.stalledCard = null;
    this.coveredTargets.clear();
    this.disarmIdle();
    this.clearCardLine();
    this.refusals.reset();
    this.failures.reset();
    this.context.reset();
    this.pending = null;
    this.choice = null;
    this.budgetCard = null;
    this.mint = null;
    this.lastPageNote = null;
    this.warned = false;
    this.muted = false;
    this.elapsedFrozen = null;
    this.closedSeconds = null;
    this.levels = { input: 0, output: 0 };
  }

  /** Spoken context (session.commentary.append): what the voice says next follows it (G63 `spoke` after `commentary`). */
  private commentary(client: VoiceClient, text: string): void {
    client.appendCommentary(text);
    this.diag.commentarySent();
  }

  /** One event of the session log (sessionEvents.ts), once a mint has named the session. */
  private emit(e: DockEvent): void {
    const id = this.mint?.sessionId;
    if (id) this.log.add(id, e);
  }

  private dispatch(e: MachineEvent, publish = true): void {
    this.machine = reduce(this.machine, e);
    if (publish) this.publish();
  }

  private startTicker(): void {
    this.stopTicker();
    const loop = () => { this.ticker = this.setTimer(loop, TICK_MS); this.tick(); };
    this.ticker = this.setTimer(loop, TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker != null) this.clearTimer(this.ticker);
    this.ticker = null;
  }

  /**
   * The phase to show now (G36): the machine's, unless the shown one has held for less than PHASE_DWELL_MS; then the
   * shown one stays and the machine is read again when the dwell ends (whatever it says then wins, so flaps coalesce).
   */
  private settlePhase(): VoicePhase {
    const raw = phaseAt(this.machine, this.now());
    if (raw === this.shownPhase) return raw;
    const held = this.now() - this.shownAt;
    // Only one live phase against another waits: connecting, the budget card, ended and unavailable show at once.
    if (held >= PHASE_DWELL_MS || !LIVE_PHASES.has(raw) || !LIVE_PHASES.has(this.shownPhase) || this.machine.base !== 'live') {
      this.shownPhase = raw;
      this.shownAt = this.now();
      return raw;
    }
    if (this.dwellTimer == null) this.dwellTimer = this.setTimer(() => { this.dwellTimer = null; this.publish(); }, PHASE_DWELL_MS - held);
    return this.shownPhase;
  }

  private build(): VoiceSnapshot {
    const phase = this.settlePhase();
    const live = this.machine.base === 'live';
    const last = [...this.turns].reverse().find((t) => t.text.trim());
    return {
      phase,
      level: live ? round(this.levels.input) : 0,
      outputLevel: live ? round(this.levels.output) : 0,
      elapsedSeconds: Math.floor(this.elapsed()),
      pending: this.pending?.view ?? this.budgetCard ?? this.stalledCard ?? null,
      choice: this.choice ? { id: this.choice.id, requestId: this.choice.requestId, title: this.choice.title, candidates: this.choice.candidates, ...(this.choice.ordinal ? { ordinal: this.choice.ordinal } : {}) } : null,
      lastLine: last ? { role: last.role, text: last.text.trim() } : null,
      turns: this.turns,
      muted: this.muted,
      reason: this.machine.reason,
      closedSeconds: this.closedSeconds,
      sessionId: this.mint?.sessionId ?? null,
      pulse: this.pulsing,
      resumable: sessionOpen(this.machine) ? null : this.currentResumable(),
    };
  }

  private publish(): void {
    const next = this.build();
    const prev = this.snapshot;
    if (prev.phase === next.phase && prev.level === next.level && prev.outputLevel === next.outputLevel
      && prev.elapsedSeconds === next.elapsedSeconds && prev.pending === next.pending && prev.turns === next.turns
      && prev.choice?.id === next.choice?.id && prev.choice?.ordinal === next.choice?.ordinal
      && prev.lastLine?.text === next.lastLine?.text && prev.muted === next.muted && prev.reason === next.reason
      && prev.closedSeconds === next.closedSeconds && prev.sessionId === next.sessionId && prev.pulse === next.pulse && prev.resumable === next.resumable) return;
    if (prev.phase !== next.phase) this.emit({ kind: 'client', data: { event: 'phase', phase: next.phase, from: prev.phase } });
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;

/** G43: one call's weight against the delegation's budget: a search that only changes its query counts double. */
/**
 * G51: the one call a navigation lets follow in its turn: list or get of the page in view (scope "this-page"), or a get
 * of the record it opened by that record's ref (vs_5144e356: open Alpha, then get Alpha's decisions, was refused).
 */
function readsThisPage(name: string, raw: string, openedRef?: string): boolean {
  if (name !== 'list' && name !== 'get') return false;
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return a['scope'] === 'this-page' || (name === 'get' && openedRef != null && a['ref'] === openedRef);
  } catch { return false; }
}

function callWeight(rec: { searches: Set<string> }, name: string, raw: string): number {
  if (name !== 'search') return 1;
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(raw) as Record<string, unknown>; } catch { return 1; }
  const { query: _q, ...rest } = args;
  const shape = JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
  const seen = rec.searches.has(shape);
  rec.searches.add(shape);
  return seen ? 2 : 1;
}

/** Whether what was heard is the card's own line coming back through the microphone (sweep 6), not the user. */
export function echoesCardLine(heard: string, line: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const h = norm(heard);
  if (h.length < 6) return false;
  return norm(line).startsWith(h) || /\b(say confirm to|click confirm on the card)\b/.test(h);
}

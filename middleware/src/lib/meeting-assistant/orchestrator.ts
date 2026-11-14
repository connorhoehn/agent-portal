// The meeting assistant's brain (docs/meeting-assistant-design.md decisions 3 to 7, 11). One `CallRun` per listening call
// owns the live session, and `AssistantRuntime` owns the runs. Everything a model says is data; every rule that matters is here:
//
//   * ASKER. Decided by the server. Scripted session: the `askedBy` the server itself passed to `sendText` for the request.
//     Real session: the latest attributed transcript line in the 20 seconds before the call. Nothing the model says names a person.
//   * NAME LOCK. The asker must have said the name (`nameLock`) in those 20 seconds, or the call is refused, counted and not posted.
//   * ROLE. The tool must be in the voice catalogue for the asker's own tenant and role, and not in MEETING_EXCLUDED_TOOLS.
//   * NEVER EXECUTE. The server runs no tool. A call becomes a `turn` for the asker's browser: a read runs at once there, a write
//     waits behind a card only the asker can confirm. The result comes back through submitResult, and is handed to the session as
//     data, never posted raw and never read as an instruction.
//   * ONE ANSWER. Every tool call the session raises is answered exactly once, by `answer()`: it flips the call from 'open' to
//     'answered' BEFORE it sends, so a late result, an expiry and a refusal can race and only one is sent. A call is left open on
//     purpose only for a read turn, and then the turn's result, its expiry, or the session closing settles it (an unanswered call
//     stalls the session). The `finally` of `onToolCall` answers anything still open that no turn holds.
//   * PAUSE. While paused the session is closed (it does not bill) and nothing is sent anywhere; resume opens a new session
//     carrying the last minutes of the transcript. An unexpected close is replaced the same way, at most 3 times per call.
import { randomBytes } from 'node:crypto';
import { getUser } from '../../providers/identity.js';
import { hashToolArgs, voiceTool } from '../voice/catalogue.js';
import { NOVA_NAME } from './chat-types.js';
import {
  nameOf, postAction, postNoticeQuietly, postPrivately, postReply, moveAction,
} from './chat.js';
import { MEETING_EXCLUDED_TOOLS, PRIVATE_TOOLS, meetingBackendInstructions, meetingFunctionTools, meetingInstructions, meetingTools } from './instructions.js';
import { VoicedTimeline, attribute } from './attribution.js';
import { OUT_RATE } from './mixer.js';
import type { AudioIntake } from './audio-intake.js';
import { assistantAudio } from './audio-select.js';
import { findAddress, nameLock, type DetectorEvent } from './detector.js';
import { assistantIntake } from './intake-select.js';
import { assistantStore } from './store-select.js';
import { callChatRuntime } from '../call-chat.js';
import { CEILING_WARNING_SECONDS, assistantLimits } from './limits.js';
import { finishMinutes } from './minutes-service.js';
import { assistantSpend, listeningSecondsOf, settleFinished, type ReserveOutcome } from './spend.js';
import type { AssistantStore } from './store.js';
import type { LineIntake } from './intake.js';
import { canSpeakOnRecord } from './intake.js';
import { makeSession } from './session-select.js';
import type { LiveMeetingSession, SessionEvents } from './session.js';
import { sessionOf, type AssistantRecord, type AssistantTurn, type TurnKind, type TurnStatus } from './types.js';

export const READ_TURN_TTL_MS = 90_000;
export const WRITE_TURN_TTL_MS = 10 * 60_000;
/** How far back from a tool call the asker is looked for and the name lock reads (decision 3). */
export const ASKER_WINDOW_MS = 20_000;
/** Tool calls one addressed request may make; the next is refused with "too many steps". */
export const MAX_CALLS_PER_REQUEST = 3;
export const TYPED_UNSUPPORTED_REPLY = 'I can only hear spoken requests in this call. Say my name and ask aloud.';
/** A call chat message that addresses Nova: it starts with the name and a comma, colon or space, or mentions @Nova. */
export const addressesNova = (text: string): boolean => /^\s*@?nova(?:[,:\s]|$)/i.test(text) || /(^|[^\w])@nova\b/i.test(text);
export const MAX_REPLACEMENTS = 3;
/** A failed replacement is retried after each of these delays; when they are spent Nova leaves (audit B9). */
export const REPLACEMENT_RETRY_MS: readonly number[] = [1000, 3000, 9000];
/** The voice speaks a short acknowledgement the moment it delegates; output this soon after a delegation is not posted. */
export const ACK_WINDOW_MS = 3000;
export const MAX_ARGS_BYTES = 4096;
export const MAX_RESULT_BYTES = 16 * 1024;
const RECENT_TRANSCRIPT_MS = 5 * 60_000;
const RECENT_TRANSCRIPT_LINES = 60;

export interface StartContext {
  callId: string;
  tenant: string;
  inviterId: string;
  /** Display names in the call. */
  roster: readonly string[];
  /** The call's record name (an initiative's name), or null. */
  recordName: string | null;
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
  audio?: Pick<AudioIntake, 'attach' | 'suspend' | 'detach'>;
  /** Sleep for `ms` (replacement retries, the turn sweep's tests); injectable so tests never wait. */
  wait?: (ms: number) => Promise<void>;
}

export interface FinishedEvent {
  callId: string;
  usageSeconds: number;
  tokens: { input: number; output: number; cached: number };
  /** Which session ran; only the provider's own figures are `reported` in the ledger. */
  sessionKind: 'openai' | 'scripted';
}

type CallState = 'open' | 'answered' | 'dropped';

/**
 * A reply belongs to the tool call the server answered, not to the call as a whole (audit B1). `answer()` queues one of these for
 * the spoken continuation that follows. People speaking in between never change who a queued reply belongs to. `muted` means the
 * continuation is not posted (a refused call, a private answer, an expired read).
 */
export interface ReplyContext {
  modelCallId: string;
  asker: string | null;
  visibility: 'public' | 'muted';
  answeredAt: number;
}
/** A reply context older than this is dropped, never applied. */
export const REPLY_CONTEXT_TTL_MS = 20_000;
/** The "could not tell who asked" reply is posted at most this often per call. */
export const UNASKED_NOTICE_EVERY_MS = 30_000;
/** How often the seat roster is read to record who is present while Nova is. */
export const ATTENDANCE_EVERY_MS = 15_000;
export const UNASKED_REPLY = 'I could not tell who asked. Please ask again.';

/** One call's live state. Plain data plus the session; every behaviour is a method of the runtime. */
interface CallRun {
  ctx: StartContext;
  session: LiveMeetingSession | null;
  unsubscribers: Array<() => void>;
  /** Session timeline start on the wall clock, and a counter that makes caption ids unique across sessions. */
  sessionStartedAt: number;
  sessionNo: number;
  pieceNo: number;
  timeline: VoicedTimeline;
  calls: Map<string, CallState>;
  /** The model's call id behind each turn that is waiting on the asker's browser. */
  turnCalls: Map<string, string>;
  /** Tool calls made so far for each addressed request, keyed by asker and the line that addressed Nova (decision: a cap on chained calls). */
  requestCalls: Map<string, number>;
  /** People already told that typed requests are not heard in this call. */
  typedNoticed: Set<string>;
  holding: Set<string>;
  /** Replies waiting for the model's spoken continuation, oldest first. */
  replies: ReplyContext[];
  lastUnaskedNoticeAt: number;
  attendanceAt: number;
  delegationAt: number;
  answeredSinceDelegation: boolean;
  intentionalClose: boolean;
  /** Final usage of the session that just closed; added into the totals once. */
  usageSeconds: number;
  tokens: { input: number; output: number; cached: number };
  totals: { seconds: number; input: number; output: number; cached: number };
  replacements: number;
  sessionKind: 'openai' | 'scripted';
  /** Serialises session changes (pause, resume, replacement) so two never overlap. */
  chain: Promise<void>;
  finished: boolean;
}

/** What a private read posts when the asker's browser sent no sentence of its own. */
export const PRIVATE_FALLBACK = 'Your answer is ready; open the page to see it.';
export const PRIVATE_SAY_MAX = 600;
/** One plain-text line of at most `max` characters: control characters dropped, whitespace collapsed. */
const plainSentence = (v: unknown, max: number): string => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const newId = (): string => randomBytes(5).toString('hex');
const capText = (v: unknown, n: number): string => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The kind of a tool call from the catalogue's own `confirm` flag (an argument value in `noConfirm` skips the card), and decision 6's private list. */
export function classifyCall(name: string, args: unknown): TurnKind | null {
  const tool = voiceTool(name);
  if (!tool) return null;
  if (tool.confirm) {
    const skip = tool.noConfirm && args && typeof args === 'object'
      ? Object.entries(tool.noConfirm).some(([arg, values]) => values.includes(String((args as Record<string, unknown>)[arg] ?? '')))
      : false;
    if (!skip) return 'write';
  }
  return PRIVATE_TOOLS.has(name) ? 'private-read' : 'read';
}

const KIND_LABELS: Readonly<Record<string, string>> = { 'work-item': 'work item', 'saved-search': 'saved search', 'access-request': 'access request' };

/** A human line and a few detail lines for a write's card. Built from the catalogue's own names and the call's own arguments. */
export function describeCall(name: string, args: unknown): { summary: string; detail: string[] } {
  const a = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const fields = a['fields'] && typeof a['fields'] === 'object' ? a['fields'] as Record<string, unknown> : {};
  const detail = Object.entries({ ...fields, ...Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'fields' && k !== 'kind')) })
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 8).map(([k, v]) => `${k}: ${capText(String(v), 120)}`);
  if (name === 'create') {
    const kind = capText(a['kind'], 40), title = capText(fields['title'] ?? fields['name'], 120);
    const label = KIND_LABELS[kind] ?? (kind || 'record');
    return { summary: `Create a ${label}${title ? ` titled "${title}"` : ''}`, detail };
  }
  const tool = voiceTool(name);
  const says = tool?.says?.replace(/ once you confirm\.?$/i, '').replace(/\.$/, '') ?? '';
  return { summary: says || `Run ${name}`, detail };
}

export class AssistantRuntime {
  private readonly runs = new Map<string, CallRun>();
  private subscribedTo: LineIntake | null = null;
  private unsubscribeIntake: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly deps: RuntimeDeps, private readonly opts: { tickMs?: number } = {}) {}

  private get store(): AssistantStore { return this.deps.store(); }
  private now(): number { return this.deps.clock(); }
  private wait(ms: number): Promise<void> {
    return this.deps.wait ? this.deps.wait(ms) : new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
  }

  isRunning(callId: string): boolean { const r = this.runs.get(callId); return !!r && !r.finished; }
  hasSession(callId: string): boolean { return !!this.runs.get(callId)?.session; }
  /** Tests and the dev route: the scripted session of a call, if that is what it has. */
  sessionOf(callId: string): LiveMeetingSession | null { return this.runs.get(callId)?.session ?? null; }

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle

  /** Start the live session for a call. Throws when the session cannot start; nothing is left running then. */
  async start(ctx: StartContext): Promise<void> {
    if (this.runs.has(ctx.callId)) return;
    this.watchIntake();
    const run: CallRun = {
      ctx, session: null, unsubscribers: [], sessionStartedAt: 0, sessionNo: 0, pieceNo: 0, timeline: new VoicedTimeline(),
      calls: new Map(), turnCalls: new Map(), requestCalls: new Map(), typedNoticed: new Set(), holding: new Set(), replies: [], lastUnaskedNoticeAt: -Infinity, attendanceAt: -Infinity,
      delegationAt: -Infinity, answeredSinceDelegation: true, intentionalClose: false, usageSeconds: 0, tokens: { input: 0, output: 0, cached: 0 },
      totals: { seconds: 0, input: 0, output: 0, cached: 0 }, replacements: 0, sessionKind: 'scripted', chain: Promise.resolve(), finished: false,
    };
    this.runs.set(ctx.callId, run);
    try { await this.openSession(run, []); } catch (e) { this.runs.delete(ctx.callId); throw e; }
    await this.openListening(ctx.callId);
    this.armTimer();
  }

  /** A listening period begins (a no-op when one is open, or when there is no record yet: the invite writes it with the period open). */
  private async openListening(callId: string): Promise<void> {
    const record = await this.store.get(callId);
    if (record && record.state === 'listening' && sessionOf(record).listeningSince == null) await this.store.patchSession(callId, { listeningSince: this.now() });
  }

  /** The open listening period ends: its seconds join the total. */
  private async closeListening(callId: string): Promise<void> {
    const record = await this.store.get(callId);
    if (!record) return;
    const s = sessionOf(record);
    if (s.listeningSince == null) return;
    await this.store.patchSession(callId, { listeningSeconds: listeningSecondsOf(record, this.now()), listeningSince: null });
  }

  async pause(callId: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    await this.serial(run, async () => { await this.closeSession(run, 'pause'); run.replies = []; });
    await this.closeListening(callId);
  }

  async resume(callId: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    await this.serial(run, async () => {
      if (run.session) return;
      await this.openSession(run, await this.recentLines(callId));
    });
    await this.openListening(callId);
  }

  /** Dismissed or left: close the session, expire what is open, tell the spend settlement. Idempotent. */
  async stop(callId: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || run.finished) return;
    run.finished = true;
    await this.serial(run, async () => { await this.closeSession(run, 'stop'); });
    await this.expireOpenTurns(run, false);
    await this.closeListening(callId);
    this.runs.delete(callId);
    if (!this.runs.size) this.disarmTimer();
    await this.deps.onFinished?.({
      callId, usageSeconds: run.totals.seconds, tokens: { input: run.totals.input, output: run.totals.output, cached: run.totals.cached }, sessionKind: run.sessionKind,
    });
  }

  async dispose(): Promise<void> {
    this.disarmTimer();
    this.unsubscribeIntake?.(); this.unsubscribeIntake = null; this.subscribedTo = null;
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
    this.unsubscribeIntake = intake.onEvents((callId, events) => this.onDetector(callId, events));
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
    // The context shows people by display name, whatever the source put in `speakerName`.
    const recent = lines.filter((l) => l.at >= floor);
    return Promise.all(recent.map(async (l) => (l.userId && (!l.speakerName || l.speakerName === l.userId) ? { ...l, speakerName: await nameOf(l.userId) } : l)));
  }

  private async openSession(run: CallRun, recent: Awaited<ReturnType<AssistantRuntime['recentLines']>>): Promise<void> {
    const session = this.deps.makeSession(this.deps.clock);
    if (!session) throw new Error('no live session is available in this process');
    run.sessionNo += 1; run.pieceNo = 0; run.timeline = new VoicedTimeline();
    run.usageSeconds = 0; run.tokens = { input: 0, output: 0, cached: 0 };
    run.calls = new Map(); run.turnCalls = new Map(); run.holding = new Set(); run.replies = []; run.intentionalClose = false;
    run.delegationAt = -Infinity; run.answeredSinceDelegation = true;
    this.wire(run, session);
    run.sessionKind = session.kind;
    await session.start({
      instructions: meetingInstructions({ tenant: run.ctx.tenant, roster: run.ctx.roster, recordName: run.ctx.recordName, recent }),
      tools: meetingFunctionTools(run.ctx.tenant),
      backendInstructions: meetingBackendInstructions(run.ctx.tenant),
    });
    run.session = session;
    run.sessionStartedAt = this.now();
    // The mixer's clock starts with the session's: its frames are the provider's audio timeline, and the timeline below is fed on it.
    this.deps.audio?.attach(run.ctx.callId, {
      append: (pcm) => { try { run.session?.appendAudio(pcm); } catch { /* the close handler reports it */ } },
      placed: (userId, pcm, atMs) => run.timeline.feed(userId, pcm, OUT_RATE, atMs),
    });
  }

  /** Close the current session on purpose; fold its usage into the totals; expire reads that were waiting on it. */
  private async closeSession(run: CallRun, why: 'pause' | 'stop'): Promise<void> {
    const session = run.session;
    if (!session) return;
    run.intentionalClose = true;
    run.session = null;
    // Paused or left: the audio token dies with the session, before anything else.
    this.deps.audio?.detach(run.ctx.callId);
    try { await session.close(); } catch (e) { console.warn('[meeting-assistant] session close failed', (e as Error).message); }
    this.foldUsage(run);
    for (const off of run.unsubscribers.splice(0)) off();
    // A read waiting on its asker has no session to answer now; a write behind its card does not need one.
    if (why === 'pause') await this.expireOpenTurns(run, true);
  }

  private foldUsage(run: CallRun): void {
    run.totals.seconds += run.usageSeconds; run.totals.input += run.tokens.input; run.totals.output += run.tokens.output; run.totals.cached += run.tokens.cached;
    run.usageSeconds = 0; run.tokens = { input: 0, output: 0, cached: 0 };
    void this.store.patchSession(run.ctx.callId, { usageSeconds: run.totals.seconds, tokensIn: run.totals.input, tokensOut: run.totals.output, tokensCached: run.totals.cached }).catch(() => undefined);
  }

  private wire(run: CallRun, session: LiveMeetingSession): void {
    const guard = <E>(fn: (e: E) => Promise<void> | void) => (e: E) => {
      void Promise.resolve().then(() => fn(e)).catch((err: unknown) => console.warn('[meeting-assistant] session event failed', (err as Error).message));
    };
    run.unsubscribers.push(
      session.on('inputTranscript', guard((e: SessionEvents['inputTranscript']) => this.onInput(run, e))),
      session.on('outputTranscript', guard((e: SessionEvents['outputTranscript']) => this.onOutput(run, e))),
      session.on('delegation', () => { run.delegationAt = this.now(); run.answeredSinceDelegation = false; }),
      session.on('toolCall', guard((e: SessionEvents['toolCall']) => this.onToolCall(run, e))),
      session.on('usage', (e) => {
        run.usageSeconds = Math.max(run.usageSeconds, e.seconds);
        if (e.backendTokens) run.tokens = { input: e.backendTokens.inputTokens, output: e.backendTokens.outputTokens, cached: e.backendTokens.cachedTokens };
      }),
      session.on('closed', guard((e: SessionEvents['closed']) => this.onClosed(run, session, e.reason))),
      session.on('error', (e) => console.warn('[meeting-assistant] session error', e.message)),
    );
  }

  private async onClosed(run: CallRun, session: LiveMeetingSession, reason: string): Promise<void> {
    if (run.intentionalClose || run.finished || run.session !== session) return;
    // An unexpected close (decision 11): replace the session with the last minutes of the call as context, a few times at most.
    run.session = null;
    this.deps.audio?.suspend(run.ctx.callId); // the tap stays, its audio waits for the new session (and its time base)
    this.foldUsage(run);
    for (const off of run.unsubscribers.splice(0)) off();
    await this.expireOpenTurns(run, true);
    const record = await this.store.get(run.ctx.callId);
    if (!record || record.state !== 'listening') return;
    if (run.replacements >= MAX_REPLACEMENTS) { await this.giveUp(run); return; }
    run.replacements += 1;
    await this.store.patchSession(run.ctx.callId, { replacements: run.replacements });
    console.warn(`[meeting-assistant] replacing session for ${run.ctx.callId} (${reason}), replacement ${run.replacements}`);
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

  /** Nova has no session and cannot get one: leave with a notice, stop intake and audio, settle spend and write the minutes (once). */
  private async giveUp(run: CallRun): Promise<void> {
    const callId = run.ctx.callId;
    await this.snapshotAttendance(callId);
    const done = await this.store.transition(callId, { from: ['listening'], to: 'left', by: 'system', at: this.now() });
    if (!done) return;
    await postNoticeQuietly(callId, `${NOVA_NAME} lost its connection and has left the call. Anyone can invite ${NOVA_NAME} again.`, { leaving: true });
    this.deps.intake().stop(callId);
    this.deps.audio?.detach(callId);
    await this.stop(callId);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Audio (the sink and the mixer are package 6; these are the two doors it uses)

  /** One participant's own audio, for the voiced timeline. Only a person who may speak on the record is tracked. */
  async feedParticipantAudio(callId: string, userId: string, pcm: Buffer, sampleRate: number): Promise<void> {
    const run = this.runs.get(callId);
    if (!run || !run.session) return;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening' || !canSpeakOnRecord(record, userId)) return;
    run.timeline.feed(userId, pcm, sampleRate, this.now() - run.sessionStartedAt);
  }

  /** The mix of acknowledged speakers, 24 kHz mono PCM16. Dropped while paused (there is no session then). */
  appendMixedAudio(callId: string, pcm24kMono: Buffer): boolean {
    const run = this.runs.get(callId);
    if (!run?.session) return false;
    run.session.appendAudio(pcm24kMono);
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------
  // What the session says

  private async onInput(run: CallRun, e: SessionEvents['inputTranscript']): Promise<void> {
    const who = attribute(run.timeline.intervals(), { startMs: e.startMs, endMs: e.endMs });
    run.pieceNo += 1;
    await this.deps.intake().handle(run.ctx.callId, {
      userId: who.userId, text: e.text, at: run.sessionStartedAt + e.endMs, startMs: e.startMs, endMs: e.endMs,
      captionId: `live:${run.sessionNo}:${run.pieceNo}`,
      ...(who.speakers.length > 1 ? { speakers: who.speakers } : {}),
    });
  }

  /**
   * Who addressed Nova (audit B3): the speaker of the latest stored line in the window before `atMs` that addresses Nova by the
   * detector's own rule. A line with no person, or voiced by more than one, says nobody.
   */
  private async findAsker(callId: string, atMs: number): Promise<{ ok: true; userId: string } | { ok: false }> {
    const record = await this.store.get(callId);
    if (!record) return { ok: false };
    const lines = await this.store.lines(callId, Math.max(0, record.nextSeq - 1 - 100), 100);
    const addressing = lines.filter((l) => l.at <= atMs && l.at >= atMs - ASKER_WINDOW_MS && findAddress(l.text) !== null);
    const last = addressing[addressing.length - 1];
    if (!last || last.userId === null || (last.speakers?.length ?? 0) > 1) return { ok: false };
    return { ok: true, userId: last.userId };
  }

  /** The reply context for a final output transcript: the exact call when the session says which, else the oldest unexpired one. */
  private takeReply(run: CallRun, inReplyTo: string | undefined): ReplyContext | 'none' | 'dropped' {
    const now = this.now();
    run.replies = run.replies.filter((c) => now - c.answeredAt < REPLY_CONTEXT_TTL_MS);
    if (inReplyTo !== undefined) {
      const i = run.replies.findIndex((c) => c.modelCallId === inReplyTo);
      return i < 0 ? 'dropped' : run.replies.splice(i, 1)[0]!;
    }
    return run.replies.shift() ?? 'none';
  }

  private async onOutput(run: CallRun, e: SessionEvents['outputTranscript']): Promise<void> {
    if (!e.final || !e.text.trim() || run.finished) return;
    // The short acknowledgement the voice speaks as it delegates is not an answer, and takes nothing from the queue.
    if (!run.answeredSinceDelegation && this.now() - run.delegationAt < ACK_WINDOW_MS) return;
    // Taken before any await, so two outputs keep their order.
    const ctx = this.takeReply(run, e.inReplyTo);
    if (ctx === 'dropped') return;
    let asker: string | null;
    if (ctx !== 'none') {
      if (ctx.visibility === 'muted' || !ctx.asker) return;
      asker = ctx.asker;
    } else {
      // A plain answer with no tool call: whoever addressed Nova last, and only if that line says who.
      const record = await this.store.get(run.ctx.callId);
      if (record && record.requests > assistantLimits().maxRequests) return;
      const found = await this.findAsker(run.ctx.callId, this.now());
      if (!found.ok) return;
      asker = found.userId;
    }
    const record = await this.store.get(run.ctx.callId);
    if (!record || record.state === 'left') return;
    await postReply(run.ctx.callId, { text: e.text.slice(0, 1500), askedBy: asker, askedByName: await nameOf(asker) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // The detector's requests (and pause or dismiss spoken in the call)

  private async onDetector(callId: string, events: DetectorEvent[]): Promise<void> {
    const run = this.runs.get(callId);
    if (!run) return;
    for (const e of events) {
      if (e.type === 'request') {
        // Past the per-call cap Nova says so once and ignores further requests (the cap counts what the detector found).
        const record = await this.store.get(callId);
        if (record && record.requests > assistantLimits().maxRequests) {
          if (!sessionOf(record).limitNoticed) {
            await this.store.patchSession(callId, { limitNoticed: true });
            await postNoticeQuietly(callId, `${NOVA_NAME} has reached its limit of ${assistantLimits().maxRequests} requests for this call and will not answer more.`);
          }
          continue;
        }
        // The scripted session answers typed text; the real one hears the same request in the audio and needs nothing.
        const session = run.session;
        if (session?.acceptsText) {
          try { session.sendText(e.askedBy, e.text); } catch (err) { console.warn('[meeting-assistant] sendText failed', (err as Error).message); }
        }
      } else if (e.type === 'command') {
        const record = await this.store.get(callId);
        if (!record) continue;
        if (record.state === 'paused') await this.pause(callId);
        else if (record.state === 'left') await this.stop(callId);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // A typed request in the call chat (after the message is stored; the caller never waits for this)

  /**
   * A seated person typed a message to Nova. A session that takes text (the scripted one) gets it as the person's own
   * line, so the detector and the name lock treat it like speech; one that cannot (the real one) is told once per person
   * per call, in chat, that only spoken requests are heard.
   */
  async onTypedMessage(callId: string, userId: string, text: string): Promise<void> {
    const run = this.runs.get(callId);
    if (!run?.session || run.finished || !addressesNova(text)) return;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') return;
    if (run.session.acceptsText) { await this.deps.intake().handle(callId, { userId, text, at: this.now() }); return; }
    if (run.typedNoticed.has(userId)) return;
    run.typedNoticed.add(userId);
    await postReply(callId, { text: TYPED_UNSUPPORTED_REPLY, askedBy: userId, askedByName: await nameOf(userId) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Tool calls

  /** The one place a tool call is answered. True when this call sent the answer. */
  private answer(run: CallRun, modelCallId: string, output: unknown, reply: { asker: string; visibility: 'public' } | null = null): boolean {
    if (run.calls.get(modelCallId) !== 'open') return false;
    run.calls.set(modelCallId, 'answered');
    run.holding.delete(modelCallId);
    run.answeredSinceDelegation = true;
    const sent = run.session?.answerToolCall(modelCallId, typeof output === 'string' ? output : JSON.stringify(output)) ?? false;
    // The spoken continuation that follows belongs to THIS call: public and labelled for its asker, or muted (the default).
    if (sent) run.replies.push({ modelCallId, asker: reply?.asker ?? null, visibility: reply ? reply.visibility : 'muted', answeredAt: this.now() });
    return sent;
  }

  /** Refuse a call: answered with the reason, counted on the record, and nothing posted (its follow-up speech is muted too). */
  private async refuse(run: CallRun, modelCallId: string, why: string): Promise<void> {
    this.answer(run, modelCallId, { refused: why });
    await this.store.bumpRefused(run.ctx.callId);
  }

  private async onToolCall(run: CallRun, e: SessionEvents['toolCall']): Promise<void> {
    const id = e.callId;
    if (run.calls.has(id)) return;
    run.calls.set(id, 'open');
    try {
      await this.handleToolCall(run, e);
    } catch (err) {
      console.warn('[meeting-assistant] tool call failed', (err as Error).message);
      this.answer(run, id, { error: 'Nova could not run that.' });
    } finally {
      // Anything still open that no turn is holding gets an answer now: an unanswered call stalls the session.
      if (run.calls.get(id) === 'open' && !run.holding.has(id)) this.answer(run, id, { error: 'Nova could not run that.' });
    }
  }

  private async handleToolCall(run: CallRun, e: SessionEvents['toolCall']): Promise<void> {
    const { callId, tenant } = run.ctx;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') { this.answer(run, e.callId, { refused: 'not listening' }); return; }
    if (record.requests > assistantLimits().maxRequests) { await this.refuse(run, e.callId, 'request limit reached'); return; }
    const atMs = run.session?.kind === 'scripted' ? this.now() : run.sessionStartedAt + e.atMs;
    // (a) The asker: the server's own record of who spoke.
    const asker = e.askedBy ?? await this.findAsker(callId, atMs).then((f) => (f.ok ? f.userId : null));
    if (!asker) {
      // No line addressed Nova, or the one that did has no single speaker: nobody is asked to confirm anything.
      await this.refuse(run, e.callId, 'could not tell who asked');
      if (this.now() - run.lastUnaskedNoticeAt >= UNASKED_NOTICE_EVERY_MS) {
        run.lastUnaskedNoticeAt = this.now();
        await postReply(callId, { text: UNASKED_REPLY, askedBy: 'unknown', askedByName: 'the call' }).catch(() => null);
      }
      return;
    }
    if (!canSpeakOnRecord(record, asker)) { await this.refuse(run, e.callId, 'not addressed'); return; }
    // (b) The name lock: the asker said the name in the window before the call.
    const lines = await this.store.lines(callId, Math.max(0, record.nextSeq - 1 - 100), 100);
    if (!nameLock(lines, asker, atMs, ASKER_WINDOW_MS)) { await this.refuse(run, e.callId, 'not addressed'); return; }
    // (b2) At most MAX_CALLS_PER_REQUEST calls per addressed request: text inside a record must not be able to lead the
    // model into an open-ended chain of reads. A request is the asker plus the line that addressed Nova in the window.
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
    const allowed = !MEETING_EXCLUDED_TOOLS.has(name) && roles.some((role) => meetingTools(tenant, role).some((t) => t.name === name));
    if (!allowed) {
      this.answer(run, e.callId, { refused: `not allowed for ${askerName}` });
      await this.store.bumpRefused(callId);
      await postReply(callId, { text: `${askerName} cannot do that here.`, askedBy: asker, askedByName: askerName });
      return;
    }
    if (!argsOk) { await this.refuse(run, e.callId, 'invalid arguments'); return; }
    // (d) Read or write; private tools are decision 6's list.
    const kind = classifyCall(name, e.args);
    if (!kind) { await this.refuse(run, e.callId, 'unknown tool'); return; }
    // (e) The turn.
    const now = this.now();
    const turnId = `t-${newId()}`;
    const actionId = kind === 'write' ? `a-${turnId}` : undefined;
    const turn: AssistantTurn = {
      turnId, callId, askedBy: asker, tool: { name, args: e.args }, kind, status: 'pending', ...(actionId ? { actionId } : {}),
      createdAt: now, expiresAt: now + (kind === 'write' ? WRITE_TURN_TTL_MS : READ_TURN_TTL_MS),
    };
    await this.store.createTurn(turn);
    if (kind === 'write') {
      const { summary, detail } = describeCall(name, e.args);
      const posted = await postAction(callId, { actionId: actionId!, askedBy: asker, askedByName: askerName, summary, ...(detail.length ? { detail } : {}), tool: { name, argsDigest: hashToolArgs(e.args) } });
      if (!posted) {
        await this.store.moveTurn(callId, turnId, { from: ['pending'], to: 'expired' });
        this.answer(run, e.callId, { error: 'Nova could not offer that action.' });
        return;
      }
      this.answer(run, e.callId, { status: 'waiting_for_confirmation', person: askerName }, { asker, visibility: 'public' });
      return;
    }
    run.turnCalls.set(turnId, e.callId);
    run.holding.add(e.callId);
  }

  // -------------------------------------------------------------------------------------------------------------
  // The asker's browser: turns, results, card decisions

  /** The turns the browser of `userId` should run now: pending reads and running writes that have not expired. */
  async turnsFor(callId: string, userId: string): Promise<AssistantTurn[]> {
    const now = this.now();
    return (await this.store.listTurns(callId, { askedBy: userId, statuses: ['pending', 'running'] }))
      .filter((t) => t.expiresAt > now && ((t.kind === 'write') === (t.status === 'running')));
  }

  /**
   * The asker's browser finished a turn. `result.output` is already size-checked by the route. Null when the turn is not
   * the caller's, unknown, or no longer waiting for a result (answered once: a second result is a conflict).
   */
  async submitResult(callId: string, turnId: string, userId: string, result: { ok: boolean; output?: unknown; error?: string }):
    Promise<{ turn: AssistantTurn } | { conflict: TurnStatus } | null> {
    const turn = await this.store.getTurn(callId, turnId);
    if (!turn || turn.askedBy !== userId) return null;
    const waiting: TurnStatus = turn.kind === 'write' ? 'running' : 'pending';
    if (turn.status !== waiting || turn.expiresAt <= this.now()) return { conflict: turn.status === waiting ? 'expired' : turn.status };
    const moved = await this.store.moveTurn(callId, turnId, { from: [waiting], to: result.ok ? 'done' : 'failed' });
    if (!moved) return { conflict: (await this.store.getTurn(callId, turnId))?.status ?? 'expired' };
    const run = this.runs.get(callId);
    if (turn.kind === 'write') {
      const text = result.ok ? capText((result.output as { say?: unknown } | null)?.say ?? 'Done.', 300) : capText(result.error ?? 'It did not work.', 300);
      if (turn.actionId) await moveAction(callId, turn.actionId, { from: ['waiting', 'confirmed'], to: result.ok ? 'done' : 'failed', by: userId, resultText: text }).catch(() => null);
      run?.session?.appendContext(`The action you offered ${result.ok ? 'was done' : 'did not work'}: ${text}`);
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
      await postPrivately(callId, userId, { text: result.ok ? (say || PRIVATE_FALLBACK) : 'Nova could not get that.' }).catch(() => false);
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
    if (decision === 'confirm') { await this.store.moveTurn(callId, turn.turnId, { from: ['pending'], to: 'running' }); return; }
    const moved = await this.store.moveTurn(callId, turn.turnId, { from: ['pending'], to: 'declined' });
    if (moved) run?.session?.appendContext(`${await nameOf(turn.askedBy)} declined the action you offered. It was not done.`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Time

  /** Expire turns whose time is up; answers the reads that were waiting. Tests call this with a moved clock. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const run of [...this.runs.values()]) {
      if (run.finished) continue;
      if (now - run.attendanceAt >= ATTENDANCE_EVERY_MS) { run.attendanceAt = now; await this.snapshotAttendance(run.ctx.callId); }
      await this.checkCeiling(run);
      if (run.finished) continue;
      const due = (await this.store.listTurns(run.ctx.callId, { statuses: ['pending', 'running'] })).filter((t) => t.expiresAt <= now);
      for (const t of due) await this.expireTurn(run, t);
    }
  }

  /** Everyone who holds an ACTIVE seat right now was present while Nova was (audit M1); departed rows are never counted. */
  private async snapshotAttendance(callId: string): Promise<void> {
    try { for (const u of await callChatRuntime().seatedUsers(callId)) if (u.active) await this.store.attend(callId, u.userId); } catch { /* the seat roster is best effort here */ }
  }

  /** Five minutes before the ceiling, say so once; at the ceiling, leave with a notice (the listening time counts, a pause does not). */
  private async checkCeiling(run: CallRun): Promise<void> {
    const callId = run.ctx.callId;
    const record = await this.store.get(callId);
    if (!record || record.state !== 'listening') return;
    const s = sessionOf(record, assistantLimits().maxSeconds);
    const left = s.ceilingSeconds - listeningSecondsOf(record, this.now());
    if (left <= 0) {
      await this.snapshotAttendance(callId);
      const done = await this.store.transition(callId, { from: ['listening'], to: 'left', by: 'system', at: this.now() });
      if (!done) return;
      await postNoticeQuietly(callId, `${NOVA_NAME} left because this call reached its ${Math.round(s.ceilingSeconds / 60)}-minute limit. Anyone who can invite ${NOVA_NAME} can invite again.`, { leaving: true });
      this.deps.intake().stop(callId);
      await this.stop(callId);
    } else if (left <= CEILING_WARNING_SECONDS && !s.warned) {
      await this.store.patchSession(callId, { warned: true });
      await postNoticeQuietly(callId, `${NOVA_NAME} leaves in 5 minutes. Anyone who can invite ${NOVA_NAME} can extend.`);
    }
  }

  /**
   * Add the default minutes to the call's ceiling, up to the hard maximum, and hold the money for them. Returns the new
   * ceiling, or why not: the call is over, the maximum is reached, or the inviter's budget refused the hold.
   */
  async extend(callId: string, by: { sub: string }, confirmOverUserBudget = false):
    Promise<{ ok: true; ceilingSeconds: number; addedSeconds: number } | { ok: false; why: 'no-assistant' | 'left' | 'at-maximum' } | { ok: false; why: 'refused'; refusal: Extract<ReserveOutcome, { ok: false }>['refusal'] }> {
    const record = await this.store.get(callId);
    if (!record) return { ok: false, why: 'no-assistant' };
    if (record.state === 'left') return { ok: false, why: 'left' };
    const limits = assistantLimits();
    const s = sessionOf(record, limits.maxSeconds);
    const next = Math.min(limits.hardMaxSeconds, s.ceilingSeconds + limits.maxSeconds);
    const added = next - s.ceilingSeconds;
    if (added <= 0) return { ok: false, why: 'at-maximum' };
    const held = await assistantSpend().reserve({
      callId, tenant: record.tenant, inviterId: record.invitedBy, initiativeId: record.initiativeId, seconds: added, part: s.extensions + 1,
      ...(confirmOverUserBudget ? { confirmOverUserBudget: true } : {}),
    });
    if (!held.ok) return { ok: false, why: 'refused', refusal: held.refusal };
    await this.store.patchSession(callId, { ceilingSeconds: next, warned: false, extensions: s.extensions + 1, holds: held.holdId ? [...s.holds, held.holdId] : s.holds });
    await postNoticeQuietly(callId, `${await nameOf(by.sub)} extended ${NOVA_NAME}'s time by ${Math.round(added / 60)} minutes.`);
    return { ok: true, ceilingSeconds: next, addedSeconds: added };
  }

  private async expireOpenTurns(run: CallRun, readsOnly: boolean): Promise<void> {
    for (const t of await this.store.listTurns(run.ctx.callId, { statuses: ['pending', 'running'] })) {
      if (!readsOnly || t.kind !== 'write') await this.expireTurn(run, t);
    }
  }

  private async expireTurn(run: CallRun, turn: AssistantTurn): Promise<void> {
    const moved = await this.store.moveTurn(run.ctx.callId, turn.turnId, { from: ['pending', 'running'], to: 'expired' });
    if (!moved) return;
    const askerName = await nameOf(turn.askedBy);
    if (turn.kind === 'write') {
      if (turn.actionId) {
        // Confirmed but never run: the asker's browser was not there. Never confirmed: nobody decided in time.
        const resultText = turn.status === 'running' ? `${askerName} confirmed this, but their browser was not available to run it.` : `${askerName} did not confirm this in time.`;
        await moveAction(run.ctx.callId, turn.actionId, { from: ['waiting', 'confirmed'], to: 'expired', by: 'system', resultText }).catch(() => null);
      }
      run.session?.appendContext(`The action offered to ${askerName} expired without being done.`);
      return;
    }
    const modelCallId = run.turnCalls.get(turn.turnId);
    run.turnCalls.delete(turn.turnId);
    if (modelCallId) this.answer(run, modelCallId, { error: 'the person who asked is not available' });
    await postReply(run.ctx.callId, { text: `${askerName} is not available to run that, so I could not finish it.`, askedBy: turn.askedBy, askedByName: askerName }).catch(() => null);
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

export async function defaultRolesOf(userId: string, tenant: string): Promise<string[]> {
  try { return (await getUser(userId))?.grants?.[tenant] ?? []; } catch { return []; }
}

let runtime: AssistantRuntime | null = null;
export function assistantRuntime(): AssistantRuntime {
  return (runtime ??= new AssistantRuntime({
    store: assistantStore, intake: assistantIntake, clock: Date.now, makeSession, rolesOf: defaultRolesOf, onFinished: async (e) => { await settleFinished(e); void finishMinutes(e.callId); },
    audio: assistantAudio(),
  }));
}
export function setAssistantRuntime(next: AssistantRuntime | null): void { void runtime?.dispose(); runtime = next; }

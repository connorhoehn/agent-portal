// The real live session: the provider's primary WebSocket (docs/voice-navigator-spec.md §1, "The Live API, as V1
// measured it"). Only the OpenAI-specific event shapes live here and in lib/voice/openai.ts; the orchestrator sees
// the LiveMeetingSession interface.
//
// Wire, as recorded in the spec (nothing here is guessed):
//   out  session.start { event_id, session }                       session = liveSocketSessionBody(...): model, instructions,
//                                                                    audio { format pcm 24000, output voice }, delegation.responses.tools
//   in   session.started { session: { id } }  |  error { code, message }
//   out  session.input_audio.append { audio: <base64 PCM16 24 kHz mono> }       no commit, no acknowledgement
//   in   session.input_transcript.delta / session.output_transcript.delta { delta, start_ms, end_ms }
//   in   session.delegation.created { offset_ms, delegation }       the voice handed the request to the backend
//   in   response.event { event: { type: 'response.output_item.done', item: { type: 'function_call', call_id, name, arguments } } }
//   out  response.item.create { event_id, item: { type: 'function_call_output', call_id, output } }, then ONE response.create { event_id }
//   in   session.usage.updated / session.closed { usage: { seconds } }          cumulative seconds
//   in   nested response.completed { response: { id, usage } }                  backend tokens, each response id once
//   out  session.thinking.append { event_id, delegation_id: null, content }     silent context
//   out  session.close                                                          then session.closed; HTTPS hangup as the fallback
//   out  session.commentary.append { event_id, delegation_id: null, content }  spoken context: what `say` sends (the server's words)
//
// `sayVerbatim` (the server's own words, said verbatim: an interview's approved question). The provider's audio and transcript carry no id
// of the response they belong to, so the utterance a `say` produced is found by position: the first one to BEGIN FROM QUIET (no
// voiced audio running, no output utterance open) after the request claims it. Its frames and its final transcript carry `say: id`
// from that start until both its transcript has been flushed and its audio has ended (`last`), then the request's `ended` is called. A claim
// can be wrong (the model spoke something else first); that is safe because the caller relays nothing until the transcript of what
// was claimed equals the words it asked for (orchestrator.ts `sayHeldText`), and an utterance that runs on into other words fails
// that check. The provider streams a spoken line's words as its audio plays and stalls part way through a sentence (measured 17
// November: 1 to 2 s with neither words nor voice), so a claimed utterance is NOT ended by the ordinary 900 ms of output quiet: it
// ends once its words equal the words asked for and both sides have been quiet `saySettleMs`, or after `sayGapMs` of quiet on both
// sides whatever it says. Words that arrive after its transcript closed but before its audio ended join it (a run-on fails the check).
// The words are sent framed as a line to read aloud (`readAloudContent`), and the session's instructions say what such a line is.
// The line is sent only from QUIET (nobody speaking: no person's turn being heard, no output utterance open, no voice running, no
// claimed utterance, no line sent and not yet claimed, no delegated work whose answer the voice will speak, and no reply the voice
// may still be about to give to a turn that just ended), one line at a time: the provider does not speak a commentary that lands
// while its own response is running (measured 18 November, the spoken repeat: the model had begun its own answer to "can you
// repeat the question?", which policy drops, and the line sent meanwhile was never said). A request made while the session is
// busy waits, unsent, for the next quiet. Busy counts only what there is evidence of. Where the provider MAY be about to answer and
// no event says it will, the session waits `answerWaitMs` (one timer) for the evidence: after a person's turn is flushed (the Live
// API sends no response.created or input-committed for the voice's own reply: spec §1, "There is no thinking event"), after a
// delegation (recorded, docs/voice/live-events.jsonl: one the provider answers gets its nested response.created 0 to 3 ms later;
// in the 18 November interview film two delegations got no response.event at all, and only input deltas and usage followed),
// and after a continuation is asked for with response.create (recorded: its response.created 123 to 427 ms later). The wait
// ends early at the evidence (a response.created, the voice's first words or voice) or at the next input delta (a new turn). The
// evidence itself keeps it busy for as long as it lasts: a response created and not yet ended, an output utterance, a function
// call awaiting its output. A response ends at any terminal event the Responses stream can carry (completed, the only one recorded;
// failed, incomplete, cancelled; an error in its envelope, which without a response id ends every running one), at the close, and
// at the latest `responseStuckMs` after it was created, so a lost terminal event never holds a line for the rest of a session. The provider acknowledges a commentary (`session.commentary.appended`, with the
// provider-timeline `start_ms` it was taken in at): a line that is spoken is taken in as its utterance begins; one taken in
// part way through an utterance already running was ABSORBED into it and will not be said, so the request ends there with no
// words (the caller posts it in the chat only) instead of waiting out its bound. `cancelSay` forgets a request the caller gave
// up on, so it never claims a later, unrelated utterance (it used to: a withheld line's request stayed queued and took the next
// answer's frames).
//
// Transcripts arrive only as DELTAS (no "done" event is documented). Input is cut into pieces: at a sentence end, at a gap of
// more than `gapMs`, at a delegation, at close, and after `idleFlushMs` of quiet. Output is cut into UTTERANCES: one runs from its
// first delta until 900 ms pass with no output delta, or the session closes; people speaking never end or split it. Typed requests: the spec records no text-input event, so `sendText` is not supported.
//
// The key never leaves lib/voice/openai.ts; nothing here logs a transcript or a tool argument.
import {
  hangupLiveSession, liveSocketSessionBody, LIVE_SOCKET_OPEN, openLiveSocket, type LiveSocket,
} from '../voice/openai.js';
import {
  MAX_PROVIDER_ERRORS, SessionEmitter, SessionTextUnsupported, type BackendTokens, type LiveMeetingSession, type ProviderErrorInfo, type SessionStartInput,
} from './session.js';
import { trace } from './trace.js';
import { readAloudContent, saidVerbatim } from './approved-speech.js';

export interface OpenAiLiveSessionOptions {
  model: string;
  /** A built-in voice name or a `voice_…` id; null = the model's default. */
  voice: string | null;
  delegationModel: string;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  idleFlushMs?: number;
  gapMs?: number;
  /** Quiet on the output side that ends one spoken utterance (default 900 ms). */
  utteranceGapMs?: number;
  /** Quiet (no words, no voice) that ends an utterance claimed by a `say` whose words are not yet the ones asked for (default 2500 ms). */
  sayGapMs?: number;
  /** Quiet that ends a claimed utterance whose words already equal the ones asked for (default 600 ms). */
  saySettleMs?: number;
  /**
   * How long the session waits for evidence that the provider is answering, after a person's turn, a delegation or a continuation
   * asked for, before it counts as quiet (default 1000 ms).
   */
  answerWaitMs?: number;
  /** The most a response of the second model counts as running without a terminal event (default 30 s). */
  responseStuckMs?: number;
  /** Timer functions, injectable so a test can move time by hand. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  clock?: () => number;
  /** The HTTPS fallback when `session.closed` never arrives. */
  hangup?: (providerSessionId: string) => Promise<boolean>;
}

/** One output frame is at most 100 ms of PCM16 mono 24 kHz. */
export const OUTPUT_FRAME_BYTES = 4800;
/** Silence that follows the last voiced frame and is still relayed, so an utterance does not end mid-word (300 ms = 3 frames). */
export const OUTPUT_TAIL_FRAMES = 3;
/** A frame whose RMS (of the 16-bit samples) is at or under this is silence. The provider's silent frames are all zero. */
export const OUTPUT_VOICED_RMS = 100;

/** RMS of the little-endian 16-bit samples in `pcm`. */
export function pcm16Rms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

const SENTENCE_END = /[.!?]["')\]]*\s*$/;
/** A provider code, type or parameter name only when it looks like one: never free text. */
const shortCode = (v: unknown): string | null => (typeof v === 'string' && /^[\w.:\[\]-]{1,64}$/.test(v) ? v : null);
const responseIdOf = (raw: unknown): string | null => { const id = (raw as { id?: unknown } | undefined)?.id; return typeof id === 'string' && id ? id : null; };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface SayRequest { id: string; text: string; ended: (transcript: string | null) => void; sent?: () => void; askedAt: number; eventId?: string; acked?: boolean }
interface Part { text: string; startMs: number; endMs: number }
interface Piece { text: string; startMs: number; endMs: number; parts: Part[] }
/** One thing Milo said: from its first output delta to 900 ms of output quiet. Times are on the session timeline (ms since `session.started`). */
interface Utterance {
  text: string; startedAt: number; endedAt: number; inputsBefore: number;
  /** The provider-timeline `start_ms` of its first words. */
  firstMs: number;
  /** The `say` request this utterance belongs to. */ say?: string;
}
/** A commentary taken in this long (provider timeline) after the running utterance's first words was absorbed into it. */
export const SAY_ABSORBED_AFTER_MS = 400;

/**
 * What a socket `error` event carries, as one short line: the event's or its error's message (the `ws` package words a refused
 * upgrade as "Unexpected server response: <status>", which is the HTTP status). Never headers, never the key.
 */
export function socketErrorCause(ev: unknown): string {
  const e = ev as { message?: unknown; error?: { message?: unknown; code?: unknown } } | null | undefined;
  const parts = [e?.error?.message, e?.message, e?.error?.code].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const text = [...new Set(parts)].join(' / ') || 'no detail from the socket';
  const key = process.env['OPENAI_API_KEY'];
  return (key ? text.split(key).join('[key]') : text).replace(/\s+/g, ' ').slice(0, 200);
}

export class OpenAiLiveSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  providerSessionId: string | null = null;
  /** Provider `error` events, codes only, the latest MAX_PROVIDER_ERRORS. */
  readonly providerErrors: ProviderErrorInfo[] = [];

  private socket: LiveSocket | null = null;
  private opened = false;
  private started = false;
  private ended = false;
  private startedWall = 0;
  private eventSeq = 0;
  private readonly open = new Set<string>();
  private readonly seenResponses = new Set<string>();
  private tokens: BackendTokens = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  private seconds = 0;
  private input: Piece | null = null;
  /** The turn heard so far and not yet flushed (the voice gate reads it; never stored or logged). */
  pendingInputText(): string { return this.input?.text.replace(/\s+/g, ' ').trim() ?? ''; }
  private output: Utterance | null = null;
  private outputTimer: unknown = null;
  /** A delegation began and its work has not produced its first message or function call yet. */
  private awaitingItem = false;
  /** The second model's responses running (by id, from their response.created), each with its safety expiry: the voice speaks what they produce. */
  private readonly responses = new Map<string, ReturnType<typeof setTimeout>>();
  /** The provider may be about to answer (a turn, a delegation, a continuation) and no event has said it is yet. */
  private answerWait: ReturnType<typeof setTimeout> | null = null;
  /** Input transcripts emitted so far. */
  private inputCount = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Output audio: silent frames still owed after the last voiced one, and the frame counter. Audio is never kept. */
  private tailLeft = 0;
  private audioSeq = 0;
  /** `say` requests sent and not yet claimed by an utterance, oldest first. */
  private sayQueue: SayRequest[] = [];
  /** `say` requests made while the session was busy, not yet sent, oldest first (sent at the next quiet). */
  private sayWaiting: SayRequest[] = [];

  /** The `say` request whose utterance is being emitted now. */
  private saying: { id: string; text: string; ended: (transcript: string | null) => void; textDone: boolean; audioDone: boolean; transcript: string | null; eventId?: string; acked?: boolean } | null = null;
  private closing: Promise<void> | null = null;
  private onClosed: (() => void) | null = null;
  private fail: ((e: Error) => void) | null = null;
  private succeed: (() => void) | null = null;
  private readonly clock: () => number;

  constructor(private readonly opts: OpenAiLiveSessionOptions) {
    super();
    this.clock = opts.clock ?? Date.now;
  }

  async start(input: SessionStartInput): Promise<void> {
    if (this.socket) throw new Error('session already started');
    const socket = openLiveSocket();
    this.socket = socket;
    const started = new Promise<void>((resolve, reject) => { this.succeed = resolve; this.fail = reject; });
    const timer = setTimeout(() => this.fail?.(new Error('the live session did not start in time')), this.opts.startTimeoutMs ?? 10_000);
    timer.unref?.();
    socket.addEventListener('open', () => {
      this.opened = true;
      this.send({
        type: 'session.start', event_id: this.eventId(),
        session: liveSocketSessionBody({
          model: this.opts.model, instructions: input.instructions, delegationInstructions: input.backendInstructions,
          voice: this.opts.voice, delegationModel: this.opts.delegationModel, tools: input.tools,
        }),
      });
    });
    socket.addEventListener('message', (msg: { data?: unknown }) => this.onMessage(msg?.data));
    socket.addEventListener('error', (ev: unknown) => {
      const cause = socketErrorCause(ev);
      // Once a close was asked for (or the session already ended), a socket error is the hang-up itself, not news: stay quiet,
      // and still let the drop path release the close waiting on it.
      if (this.closing === null && !this.ended) console.warn('[meeting-assistant] live socket error', cause);
      this.fail?.(new Error(`the live socket failed: ${cause}`)); this.dropped('socket-error');
    });
    socket.addEventListener('close', () => { this.fail?.(new Error('the live socket closed before the session started')); this.dropped('socket-closed'); });
    try { await started; } catch (e) { this.finish('start-failed'); try { socket.close(1000); } catch { /* already closed */ } throw e; } finally { clearTimeout(timer); }
  }

  appendAudio(pcm24kMono: Buffer): void {
    if (this.ended || !this.opened || pcm24kMono.length === 0) return;
    this.send({ type: 'session.input_audio.append', audio: pcm24kMono.toString('base64') });
  }

  sendText(_userId: string, _text: string): void { throw new SessionTextUnsupported(); }

  answerToolCall(callId: string, output: string): boolean {
    if (this.ended || !this.open.delete(callId)) return false;
    this.send({ type: 'response.item.create', event_id: this.eventId(), item: { type: 'function_call_output', call_id: callId, output } });
    // One continuation per round: only when no other call of the round is still waiting (spec, "Outbound result").
    if (this.open.size === 0) { this.send({ type: 'response.create', event_id: this.eventId() }); this.waitForAnswer(); }
    return true;
  }

  appendContext(text: string): boolean {
    if (this.ended || !this.opened) return false;
    this.send({ type: 'session.thinking.append', event_id: this.eventId(), delegation_id: null, content: text.slice(0, 2000) });
    return true;
  }

  /**
   * Say the server's words aloud (session.ts `sayVerbatim`): sent as spoken commentary once the session is quiet (now, or after the
   * response running now); the next utterance from quiet after it is sent is claimed for it. `sent` is called when it goes out.
   */
  sayVerbatim(id: string, text: string, ended: (transcript: string | null) => void, sent?: () => void): boolean {
    if (this.ended || !this.opened || !text.trim()) return false;
    this.sayWaiting.push({ id, text, ended, askedAt: this.sinceStart(), ...(sent ? { sent } : {}) });
    trace('say.asked', { t: this.sinceStart(), queued: this.sayQueue.length, waiting: this.sayWaiting.length, busy: this.busy() });
    this.pumpSay();
    return true;
  }

  /** Forget a `say` request the caller gave up on (withheld): unsent, or sent and not yet claimed. A claimed one runs out as it is. */
  cancelSay(id: string): void {
    const before = this.sayQueue.length + this.sayWaiting.length;
    this.sayQueue = this.sayQueue.filter((r) => r.id !== id);
    this.sayWaiting = this.sayWaiting.filter((r) => r.id !== id);
    if (this.sayQueue.length + this.sayWaiting.length !== before) trace('say.cancelled', { t: this.sinceStart() });
    this.pumpSay();
  }

  /**
   * Not quiet: a person's turn is being heard, the provider is saying something (an utterance open, its voice still running, a
   * claimed one not yet over), a line already sent has not been claimed yet, a response of the second model is running or a
   * function call awaits its output, or the provider may be about to answer and the wait for its evidence is not over.
   */
  private busy(): boolean {
    return this.input !== null || this.answerWait !== null || this.output !== null || this.tailLeft > 0 || this.saying !== null || this.sayQueue.length > 0
      || this.open.size > 0 || this.responses.size > 0;
  }

  /** The provider may be about to answer: count as busy for `answerWaitMs` unless its evidence comes first. */
  private waitForAnswer(): void {
    this.endAnswerWait();
    this.answerWait = setTimeout(() => { this.answerWait = null; this.pumpSay(); }, this.opts.answerWaitMs ?? 1000);
    this.answerWait.unref?.();
  }

  /** The evidence came (or a new turn began): the wait is over. */
  private endAnswerWait(): void {
    if (this.answerWait) { clearTimeout(this.answerWait); this.answerWait = null; }
  }

  /** At quiet: send the oldest waiting `say` line (the next goes at the next quiet, after this one is over). */
  private pumpSay(): void {
    if (this.ended || this.closing !== null || !this.opened || this.busy() || this.sayWaiting.length === 0) return;
    const r = this.sayWaiting.shift()!;
    r.eventId = this.eventId();
    this.send({ type: 'session.commentary.append', event_id: r.eventId, delegation_id: null, content: readAloudContent(r.text.slice(0, 1800)) });
    this.sayQueue.push(r);
    trace('say.sent', { t: this.sinceStart(), waitedMs: this.sinceStart() - r.askedAt, waiting: this.sayWaiting.length });
    try { r.sent?.(); } catch { /* the caller's bound stands */ }
  }

  /**
   * The provider took a commentary in. Its request is the one whose event id it names; only an acknowledgement that names no id
   * falls to the oldest sent and not yet acknowledged (one naming an id no line was sent with is some other commentary's).
   * Taken in part way through an utterance already running (claimed for it or not), it was absorbed there: the request ends with
   * no words, and the utterance's remaining frames are nobody's.
   */
  private onCommentaryAppended(ev: Record<string, unknown>): void {
    const id = typeof ev['client_event_id'] === 'string' ? ev['client_event_id'] : null;
    const all = [...this.sayQueue, ...(this.saying ? [this.saying] : [])];
    const r = id !== null ? all.find((x) => x.eventId === id) : all.find((x) => x.eventId !== undefined && !x.acked);
    if (!r) return;
    r.acked = true;
    const o = this.output;
    const at = num(ev['start_ms']);
    if (!o || typeof ev['start_ms'] !== 'number' || at - o.firstMs <= SAY_ABSORBED_AFTER_MS) return;
    if (o.say !== undefined && o.say !== r.id) return; // another line's utterance: this one is still to come
    trace('say.absorbed', { t: this.sinceStart(), intoMs: at - o.firstMs });
    if (this.saying?.id === r.id) this.saying = null;
    this.sayQueue = this.sayQueue.filter((x) => x.id !== r.id);
    if (o.say === r.id) { const { say: _drop, ...rest } = o; this.output = rest; }
    try { r.ended(null); } catch (e) { console.warn('[meeting-assistant] say listener threw', (e as Error).message); }
  }

  close(): Promise<void> {
    return (this.closing ??= this.doClose());
  }

  // ---------------------------------------------------------------------------------------------------------------

  private eventId(): string { this.eventSeq += 1; return `ma_${this.eventSeq}`; }

  private send(ev: Record<string, unknown>): void {
    const s = this.socket;
    if (!s || s.readyState !== LIVE_SOCKET_OPEN) return;
    try { s.send(JSON.stringify(ev)); } catch { /* the close handler reports it */ }
  }

  private async doClose(): Promise<void> {
    if (this.ended) return;
    this.flushInput(); this.flushOutput();
    const waited = new Promise<void>((resolve) => { this.onClosed = resolve; });
    this.send({ type: 'session.close' });
    const timer = setTimeout(() => this.onClosed?.(), this.opts.closeTimeoutMs ?? 5000);
    timer.unref?.();
    await waited;
    clearTimeout(timer);
    if (!this.ended) {
      // No `session.closed`: hang up over HTTPS so it cannot keep billing, and report what we last knew.
      const id = this.providerSessionId;
      if (id) { try { await (this.opts.hangup ?? hangupLiveSession)(id); } catch { /* best effort */ } }
      // The provider never confirmed its last figure: book at least the wall clock, as the dropped path does.
      if (this.started) this.bookWallClock();
      this.finish('close-timeout');
    }
    try { this.socket?.close(1000); } catch { /* already closed */ }
  }

  /**
   * The socket ended and the server did not ask for it. The provider may still hold the session open and keep billing, so hang up
   * over HTTPS (best effort, once), and report usage as the larger of the provider's last figure and the wall clock since
   * `session.started`, rounded up; the report says when the wall clock won.
   */
  private dropped(reason: string): void {
    if (this.ended) return;
    if (this.closing === null && this.started) {
      this.bookWallClock();
      const id = this.providerSessionId;
      if (id) { void Promise.resolve().then(() => (this.opts.hangup ?? hangupLiveSession)(id)).catch(() => undefined); }
    }
    this.finish(reason);
  }

  /** Emit `closed` once, and release anyone waiting on the close. */
  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.clearOutputTimer();
    this.endAnswerWait();
    this.responseOver(null);
    this.input = null; this.output = null; this.open.clear(); this.awaitingItem = false;
    this.sayQueue = []; this.sayWaiting = []; this.saying = null;
    this.emit('closed', { reason });
    this.onClosed?.();
  }

  private onMessage(data: unknown): void {
    let ev: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return;
      ev = parsed as Record<string, unknown>;
    } catch { return; }
    const type = ev['type'];
    if (type !== 'session.output_audio.delta') {
      const inner = type === 'response.event' ? (ev['event'] as { type?: unknown } | undefined)?.type : undefined;
      const item = type === 'response.event' ? ((ev['event'] as { item?: { type?: unknown; call_id?: unknown } } | undefined)?.item) : undefined;
      trace('provider', {
        type: typeof type === 'string' ? type : 'unknown', t: this.started ? this.sinceStart() : null,
        startMs: typeof ev['start_ms'] === 'number' ? ev['start_ms'] : undefined, endMs: typeof ev['end_ms'] === 'number' ? ev['end_ms'] : undefined,
        offsetMs: typeof ev['offset_ms'] === 'number' ? ev['offset_ms'] : undefined,
        inner: typeof inner === 'string' ? inner : undefined, item: typeof item?.type === 'string' ? item.type : undefined,
        callId: typeof item?.call_id === 'string' ? item.call_id : undefined,
        sentenceEnd: type === 'session.input_transcript.delta' && typeof ev['delta'] === 'string' ? SENTENCE_END.test(ev['delta']) : undefined,
      });
    }
    switch (type) {
      case 'session.started': {
        const id = (ev['session'] as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string' && /^[\w-]{1,200}$/.test(id)) this.providerSessionId = id;
        this.noteExpiry(ev);
        this.startedWall = this.clock();
        this.started = true;
        this.succeed?.();
        return;
      }
      case 'session.input_transcript.delta': this.onDelta('input', ev); return;
      case 'session.output_transcript.delta': this.onDelta('output', ev); return;
      case 'session.delegation.created': {
        this.flushInput('delegation');
        this.awaitingItem = true;
        this.waitForAnswer();
        this.emit('delegation', { atMs: this.sinceStart() });
        return;
      }
      case 'response.event': this.onResponseEvent(ev['event']); return;
      case 'session.commentary.appended': this.onCommentaryAppended(ev); return;
      case 'session.usage.updated': this.onUsage(ev); return;
      case 'session.output_audio.delta': this.onAudio(ev['delta']); return;
      case 'session.closed': {
        this.noteExpiry(ev);
        this.onUsage(ev);
        this.flushInput(); this.flushOutput();
        const reason = ev['reason'];
        this.finish(typeof reason === 'string' && /^[\w.-]{1,40}$/.test(reason) ? reason : 'closed');
        return;
      }
      case 'error': {
        const code = (ev['code'] ?? (ev['error'] as { code?: unknown } | undefined)?.code);
        // The provider's message text can echo what was said in the call: only a code-shaped value is ever kept or logged.
        const message = shortCode(code) ?? 'error';
        const err = ev['error'] as { code?: unknown; param?: unknown; type?: unknown } | undefined;
        const info: ProviderErrorInfo = { code: shortCode(code), param: shortCode(ev['param'] ?? err?.param), type: shortCode(err?.type) };
        this.providerErrors.push(info);
        if (this.providerErrors.length > MAX_PROVIDER_ERRORS) this.providerErrors.shift();
        if (!this.started) { this.fail?.(new Error(message)); return; }
        this.emit('error', { message, info });
        return;
      }
      default: return;
    }
  }

  /** `session.expires_at` on `session.started` / `session.closed`: epoch seconds or milliseconds, or an ISO string. */
  private noteExpiry(ev: Record<string, unknown>): void {
    const raw = (ev['session'] as { expires_at?: unknown } | undefined)?.expires_at;
    let at = NaN;
    if (typeof raw === 'number') at = raw < 1e11 ? raw * 1000 : raw;
    else if (typeof raw === 'string') at = /^\d+$/.test(raw) ? (Number(raw) < 1e11 ? Number(raw) * 1000 : Number(raw)) : Date.parse(raw);
    if (Number.isFinite(at) && at > 0) this.emit('expires', { atMs: at });
  }

  /**
   * The model's audio: the provider sends one 100 ms frame for every input frame, ALL ZERO unless the model is speaking
   * (measured 13 November). Silence is dropped here so nothing is relayed while it is quiet; a voiced frame and the 300 ms
   * after it go out, the last of them marked `last`. The bytes are decoded, passed on, and forgotten: never logged or written.
   */
  private onAudio(delta: unknown): void {
    if (this.ended || typeof delta !== 'string' || !delta) return;
    const whole = Buffer.from(delta, 'base64');
    const usable = whole.length - (whole.length % 2);
    for (let at = 0; at < usable; at += OUTPUT_FRAME_BYTES) {
      const pcm = whole.subarray(at, Math.min(usable, at + OUTPUT_FRAME_BYTES));
      if (pcm16Rms(pcm) > OUTPUT_VOICED_RMS) {
        if (this.tailLeft === 0) { trace('voice.start', { t: this.sinceStart() }); this.endAnswerWait(); if (!this.output) this.claimSay(); }
        this.tailLeft = OUTPUT_TAIL_FRAMES;
        // A claimed utterance's voice still running: its words are not over yet, whatever their pace.
        if (this.output?.say && this.outputTimer !== null) this.armOutput();
      }
      else if (this.tailLeft === 0) continue;
      else this.tailLeft -= 1;
      this.audioSeq += 1;
      const last = this.tailLeft === 0;
      const say = this.saying?.id;
      this.emit('outputAudio', { pcm: Buffer.from(pcm), seq: this.audioSeq, ...(last ? { last: true as const } : {}), ...(say ? { say } : {}) });
      if (this.saying) { this.saying.audioDone = last; this.endSayIfDone(); }
      if (last) this.pumpSay();
    }
  }

  /** The session is quiet and something begins: the oldest waiting `say` request claims it. */
  private claimSay(): void {
    if (this.saying || this.sayQueue.length === 0) return;
    const next = this.sayQueue.shift()!;
    this.saying = { id: next.id, text: next.text, ended: next.ended, textDone: false, audioDone: true, transcript: null, ...(next.eventId ? { eventId: next.eventId } : {}), ...(next.acked ? { acked: true } : {}) };
    trace('say.claimed', { t: this.sinceStart() });
  }

  /** Both halves of the claimed utterance are out: its transcript flushed and its audio ended. */
  private endSayIfDone(): void {
    const s = this.saying;
    if (!s || !s.textDone || !s.audioDone) return;
    this.saying = null;
    try { s.ended(s.transcript); } catch (e) { console.warn('[meeting-assistant] say listener threw', (e as Error).message); }
    this.pumpSay();
  }

  /** Report usage as the larger of the provider's last figure and the wall clock since `session.started`, rounded up. */
  private bookWallClock(): void {
    const wall = Math.ceil(this.sinceStart() / 1000);
    const estimated = wall > this.seconds;
    if (estimated) this.seconds = wall;
    this.emit('usage', { seconds: this.seconds, backendTokens: { ...this.tokens }, ...(estimated ? { estimated: true } : {}) });
  }

  private sinceStart(): number { return Math.max(0, this.clock() - this.startedWall); }

  private onDelta(side: 'input' | 'output', ev: Record<string, unknown>): void {
    const delta = typeof ev['delta'] === 'string' ? ev['delta'] : '';
    if (!delta) return;
    const startMs = num(ev['start_ms']), endMs = Math.max(startMs, num(ev['end_ms']));
    const gapMs = this.opts.gapMs ?? 1000;
    if (side === 'input') {
      // A new turn: whatever answer was awaited did not come before it. Input never ends or splits an utterance of Milo's: only output quiet does.
      this.endAnswerWait();
      if (this.input && startMs - this.input.endMs > gapMs) this.flushInput('gap');
      const part = { text: delta, startMs, endMs };
      this.input = this.input ? { text: this.input.text + delta, startMs: this.input.startMs, endMs, parts: [...this.input.parts, part] } : { text: delta, startMs, endMs, parts: [part] };
      if (SENTENCE_END.test(this.input.text)) this.flushInput('sentence'); else this.armIdle();
    } else {
      const at = this.sinceStart();
      // Milo beginning to speak means the turn it answers is over: what was heard so far is a line now, stored before this
      // utterance is judged (the provider's input deltas come in small pieces, and its idle flush would land after a short answer).
      // Words after a claimed utterance's transcript closed while its voice still runs: they are its words (a run-on fails the check).
      const s = this.saying;
      if (!this.output && s && s.textDone && !s.audioDone) {
        s.transcript = `${s.transcript ?? ''} ${delta}`.replace(/\s+/g, ' ').trim();
        this.emit('outputTranscript', { text: s.transcript, final: false, say: s.id });
        return;
      }
      if (!this.output) {
        this.flushInput('output');
        this.endAnswerWait();
        // From quiet (no voice running): this utterance may be the one a `say` asked for. With the voice already running under a claim,
        // these are that utterance's words.
        if (this.tailLeft === 0) this.claimSay();
      }
      const say = this.output ? this.output.say : this.saying && !this.saying.textDone ? this.saying.id : undefined;
      this.output = this.output ? { ...this.output, text: this.output.text + delta, endedAt: at } : { text: delta, startedAt: at, endedAt: at, firstMs: startMs, inputsBefore: this.inputCount, ...(say ? { say } : {}) };
      this.emit('outputTranscript', { text: this.output.text.trim(), final: false, ...(say ? { say } : {}) });
      this.armOutput();
    }
  }

  private clearOutputTimer(): void {
    if (this.outputTimer === null) return;
    const t = this.opts.timers;
    if (t) t.clear(this.outputTimer); else clearTimeout(this.outputTimer as ReturnType<typeof setTimeout>);
    this.outputTimer = null;
  }

  private armOutput(): void {
    this.clearOutputTimer();
    const fire = () => { this.outputTimer = null; this.onOutputQuiet(); };
    const ms = this.outputGapMs();
    const t = this.opts.timers;
    if (t) this.outputTimer = t.set(fire, ms);
    else { const h = setTimeout(fire, ms); h.unref?.(); this.outputTimer = h; }
  }

  /** The quiet that ends the open utterance: the ordinary gap, or a claimed one's (settle when its words are complete, else the long gap). */
  private outputGapMs(): number {
    const p = this.output, s = this.saying;
    if (!p?.say || !s || s.id !== p.say) return this.opts.utteranceGapMs ?? 900;
    return saidVerbatim(s.text, p.text) ? (this.opts.saySettleMs ?? 600) : (this.opts.sayGapMs ?? 2500);
  }

  /** Output quiet: the utterance ends, unless it is a claimed one whose voice is still running (then the wait starts again). */
  private onOutputQuiet(): void {
    if (this.output?.say && this.saying?.id === this.output.say && this.tailLeft > 0) { this.armOutput(); return; }
    this.flushOutput();
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.flushInput('idle'); }, this.opts.idleFlushMs ?? 1500);
    this.idle.unref?.();
  }

  private flushInput(why = 'closed'): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const p = this.input; this.input = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) {
      trace('input.flush', { t: this.sinceStart(), startMs: p.startMs, endMs: p.endMs, why, parts: p.parts.length });
      this.inputCount += 1;
      this.emit('inputTranscript', { text, startMs: p.startMs, endMs: p.endMs, ...(p.parts.length > 1 ? { parts: p.parts } : {}), ...(why === 'output' || why === 'delegation' ? { turnEnded: true as const } : {}) });
    }
    // The person's turn is over. Not when Milo's own output or a delegation is what ended it: the provider is answering then. A turn
    // that ended on its own may still get the voice's reply, which no event announces: the line waits `answerWaitMs` for it first.
    if (why === 'output' || why === 'delegation') return;
    if (p && text && why !== 'closed') { this.waitForAnswer(); return; }
    this.pumpSay();
  }

  private flushOutput(): void {
    this.clearOutputTimer();
    const p = this.output; this.output = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) { trace('output.flush', { t: this.sinceStart(), startedAt: p.startedAt, endedAt: p.endedAt }); this.emit('outputTranscript', { text, final: true, startedAt: p.startedAt, endedAt: p.endedAt, inputsBefore: p.inputsBefore, ...(p.say ? { say: p.say } : {}) }); }
    if (p?.say && this.saying?.id === p.say) { this.saying.textDone = true; this.saying.transcript = text || null; this.endSayIfDone(); }
    this.pumpSay();
  }

  private onResponseEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    if (e['type'] === 'response.created') {
      const id = (e['response'] as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && id && !this.responses.has(id)) {
        const expiry = setTimeout(() => { trace('response.expired', { t: this.sinceStart() }); this.responseOver(id); }, this.opts.responseStuckMs ?? 30_000);
        expiry.unref?.();
        this.responses.set(id, expiry);
      }
      this.endAnswerWait();
      return;
    }
    if (e['type'] === 'response.failed' || e['type'] === 'response.incomplete' || e['type'] === 'response.cancelled') {
      this.responseOver(responseIdOf(e['response']));
      return;
    }
    if (e['type'] === 'error') {
      const id = typeof e['response_id'] === 'string' ? e['response_id'] : responseIdOf(e['response']);
      this.responseOver(id);
      return;
    }
    if (e['type'] === 'response.output_item.added') {
      const kind = (e['item'] as Record<string, unknown> | undefined)?.['type'];
      if (this.awaitingItem && (kind === 'message' || kind === 'function_call')) { this.awaitingItem = false; this.emit('delegationReady', { atMs: this.sinceStart(), item: kind }); }
      // Every message the second model writes is then spoken by the voice (a delegated answer, or what follows a tool result).
      if (kind === 'message') this.emit('messageReady', { atMs: this.sinceStart() });
      return;
    }
    if (e['type'] === 'response.output_item.done') {
      const item = e['item'] as Record<string, unknown> | undefined;
      if (item?.['type'] !== 'function_call') return;
      const callId = item['call_id'], name = item['name'];
      if (typeof callId !== 'string' || !/^[\w-]{1,128}$/.test(callId) || typeof name !== 'string' || !/^[\w-]{1,64}$/.test(name)) return;
      let args: unknown = null;
      try { args = JSON.parse(typeof item['arguments'] === 'string' ? item['arguments'] : 'null'); } catch { /* null: the orchestrator refuses it */ }
      if (this.open.has(callId)) return;
      this.open.add(callId);
      this.emit('toolCall', { callId, name, args, atMs: this.sinceStart() });
    } else if (e['type'] === 'response.completed') {
      this.responseOver(responseIdOf(e['response']));
      const response = e['response'] as { id?: unknown; usage?: Record<string, unknown> } | undefined;
      const id = typeof response?.id === 'string' ? response.id : null;
      const usage = response?.usage;
      if (!usage || typeof usage !== 'object' || (id && this.seenResponses.has(id))) return;
      if (id) this.seenResponses.add(id);
      const cached = num((usage['input_tokens_details'] as { cached_tokens?: unknown } | undefined)?.cached_tokens);
      this.tokens = {
        inputTokens: this.tokens.inputTokens + Math.floor(num(usage['input_tokens'])),
        outputTokens: this.tokens.outputTokens + Math.floor(num(usage['output_tokens'])),
        cachedTokens: this.tokens.cachedTokens + Math.floor(cached),
      };
    }
  }

  /** A response of the second model ended (by id; null: every running one): its work no longer keeps the session busy. */
  private responseOver(id: string | null): void {
    for (const [rid, expiry] of this.responses) {
      if (id !== null && rid !== id) continue;
      clearTimeout(expiry);
      this.responses.delete(rid);
    }
    this.pumpSay();
  }

  private onUsage(ev: Record<string, unknown>): void {
    const sec = (ev['usage'] as { seconds?: unknown } | undefined)?.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 && sec > this.seconds) this.seconds = sec;
    this.emit('usage', { seconds: this.seconds, backendTokens: { ...this.tokens } });
  }
}

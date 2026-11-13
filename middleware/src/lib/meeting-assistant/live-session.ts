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
//
// Transcripts arrive only as DELTAS (no "done" event is documented), so this class cuts pieces: at a sentence end, at a
// gap of more than `gapMs` on the session timeline, when the other direction speaks, at a delegation, at close, and after
// `idleFlushMs` of quiet. Typed requests: the spec records no text-input event, so `sendText` is not supported.
//
// The key never leaves lib/voice/openai.ts; nothing here logs a transcript or a tool argument.
import {
  hangupLiveSession, liveSocketSessionBody, LIVE_SOCKET_OPEN, openLiveSocket, type LiveSocket,
} from '../voice/openai.js';
import {
  SessionEmitter, SessionTextUnsupported, type BackendTokens, type LiveMeetingSession, type SessionStartInput,
} from './session.js';

export interface OpenAiLiveSessionOptions {
  model: string;
  /** A built-in voice name or a `voice_…` id; null = the model's default. */
  voice: string | null;
  delegationModel: string;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  idleFlushMs?: number;
  gapMs?: number;
  clock?: () => number;
  /** The HTTPS fallback when `session.closed` never arrives. */
  hangup?: (providerSessionId: string) => Promise<boolean>;
}

const SENTENCE_END = /[.!?]["')\]]*\s*$/;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface Piece { text: string; startMs: number; endMs: number }

export class OpenAiLiveSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  providerSessionId: string | null = null;

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
  private output: Piece | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
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
    socket.addEventListener('error', () => { this.fail?.(new Error('the live socket failed')); this.finish('socket-error'); });
    socket.addEventListener('close', () => { this.fail?.(new Error('the live socket closed before the session started')); this.finish('socket-closed'); });
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
    if (this.open.size === 0) this.send({ type: 'response.create', event_id: this.eventId() });
    return true;
  }

  appendContext(text: string): boolean {
    if (this.ended || !this.opened) return false;
    this.send({ type: 'session.thinking.append', event_id: this.eventId(), delegation_id: null, content: text.slice(0, 2000) });
    return true;
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
      this.finish('close-timeout');
    }
    try { this.socket?.close(1000); } catch { /* already closed */ }
  }

  /** Emit `closed` once, and release anyone waiting on the close. */
  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.input = null; this.output = null; this.open.clear();
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
    switch (type) {
      case 'session.started': {
        const id = (ev['session'] as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string' && /^[\w-]{1,200}$/.test(id)) this.providerSessionId = id;
        this.startedWall = this.clock();
        this.started = true;
        this.succeed?.();
        return;
      }
      case 'session.input_transcript.delta': this.onDelta('input', ev); return;
      case 'session.output_transcript.delta': this.onDelta('output', ev); return;
      case 'session.delegation.created': {
        this.flushInput();
        this.emit('delegation', { atMs: this.sinceStart() });
        return;
      }
      case 'response.event': this.onResponseEvent(ev['event']); return;
      case 'session.usage.updated': this.onUsage(ev); return;
      case 'session.closed': {
        this.onUsage(ev);
        this.flushInput(); this.flushOutput();
        const reason = ev['reason'];
        this.finish(typeof reason === 'string' && /^[\w.-]{1,40}$/.test(reason) ? reason : 'closed');
        return;
      }
      case 'error': {
        const code = (ev['code'] ?? (ev['error'] as { code?: unknown } | undefined)?.code);
        const message = `${typeof code === 'string' ? code : 'error'}: ${typeof ev['message'] === 'string' ? ev['message'].slice(0, 200) : ''}`;
        if (!this.started) { this.fail?.(new Error(message)); return; }
        this.emit('error', { message });
        return;
      }
      default: return;
    }
  }

  private sinceStart(): number { return Math.max(0, this.clock() - this.startedWall); }

  private onDelta(side: 'input' | 'output', ev: Record<string, unknown>): void {
    const delta = typeof ev['delta'] === 'string' ? ev['delta'] : '';
    if (!delta) return;
    const startMs = num(ev['start_ms']), endMs = Math.max(startMs, num(ev['end_ms']));
    const gapMs = this.opts.gapMs ?? 1000;
    if (side === 'input') {
      this.flushOutput();
      if (this.input && startMs - this.input.endMs > gapMs) this.flushInput();
      this.input = this.input ? { text: this.input.text + delta, startMs: this.input.startMs, endMs } : { text: delta, startMs, endMs };
      if (SENTENCE_END.test(this.input.text)) this.flushInput(); else this.armIdle();
    } else {
      this.flushInput();
      if (this.output && startMs - this.output.endMs > gapMs) this.flushOutput();
      this.output = this.output ? { text: this.output.text + delta, startMs: this.output.startMs, endMs } : { text: delta, startMs, endMs };
      this.emit('outputTranscript', { text: this.output.text.trim(), final: false });
      this.armIdle();
    }
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.flushInput(); this.flushOutput(); }, this.opts.idleFlushMs ?? 1500);
    this.idle.unref?.();
  }

  private flushInput(): void {
    const p = this.input; this.input = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) this.emit('inputTranscript', { text, startMs: p.startMs, endMs: p.endMs });
  }

  private flushOutput(): void {
    const p = this.output; this.output = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) this.emit('outputTranscript', { text, final: true });
  }

  private onResponseEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
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

  private onUsage(ev: Record<string, unknown>): void {
    const sec = (ev['usage'] as { seconds?: unknown } | undefined)?.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 && sec > this.seconds) this.seconds = sec;
    this.emit('usage', { seconds: this.seconds, backendTokens: { ...this.tokens } });
  }
}

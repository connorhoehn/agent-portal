// The voice navigator's session client (docs/voice-navigator-spec.md §1, §3),
// lifted from the prototype's WebRTC page (chatgpt-live-voice/index.html):
// microphone -> RTCPeerConnection with the `oai-events` data channel -> SDP
// offer -> POST /api/voice/sessions (the middleware holds the key and returns
// the SDP answer, §2) -> remote audio element; input and output level meters
// as 0..1; hang-up through `session.close` and then POST /:id/close with the
// seconds, so the hold settles.
//
// Every data-channel frame goes through `parseFrame`, in the shapes V1
// recorded against the real Live API (docs/voice/live-events.jsonl):
// `session.delegation.created`, then `response.event` envelopes whose inner
// `response.output_item.done` carries `{ type: 'function_call', call_id, name,
// arguments }` (never the arguments-done event, which has no name). A result
// goes back as `response.item.create { item: { type: 'function_call_output',
// call_id, output } }` and one `response.create`.
//
// Under MOCK_VOICE the mint answers `mock: true` with a `mockScript`; the
// client then plays those frames through the same parser on timers (no
// WebRTC, no microphone), replaying `onResponseCreate` after each
// response.create and `onClose` after session.close, so every phase runs
// under `node --test`.
//
// `session.instructions.append` is deliberately missing: the mint's
// data-channel allowlist leaves it (and session.update) to the server, so
// the browser cannot rewrite the instructions (§1 "What this changes").

export const VOICE_API = '/api/voice/sessions';
export const CLOSE_WAIT_MS = 5000;

export interface MockFrame { atMs: number; event: Record<string, unknown> }
export interface MockScript { onStart: MockFrame[]; onResponseCreate: MockFrame[]; onClose: MockFrame[] }

/** The mint's 201 body (middleware/src/routes/voice.ts). */
export interface VoiceMint {
  sessionId: string;
  voiceSessionId: string;
  holdId: string;
  maxSeconds: number;
  expiresAt: string;
  sdp: string;
  mock: boolean;
  model: string;
  voice: string | null;
  toolsEnabled: boolean;
  tools: string[];
  budget: { holdUsd: number; usdPerMinute: number };
  mockScript?: MockScript;
}

export type StopReason = 'closed' | 'dropped' | 'cutoff' | 'tenant-switch';

// ── inbound frames ──────────────────────────────────────────────────────────

export type VoiceFrame =
  | { kind: 'started'; sessionId: string | null }
  | { kind: 'input'; text: string; startMs: number | null; endMs: number | null }
  | { kind: 'output'; text: string; startMs: number | null; endMs: number | null }
  | { kind: 'audio' }
  | { kind: 'delegation'; delegationId: string; responseId: string | null; target: string | null }
  | { kind: 'call'; delegationId: string | null; callId: string; name: string; arguments: string }
  | { kind: 'response-completed'; delegationId: string | null; responseId: string | null }
  | { kind: 'response-failed'; delegationId: string | null; responseId: string | null; message: string }
  | { kind: 'response-progress'; delegationId: string | null; type: string }
  | { kind: 'usage'; seconds: number }
  | { kind: 'closed'; reason: string | null; seconds: number | null }
  | { kind: 'muted'; muted: boolean }
  | { kind: 'ack'; type: string; clientEventId: string | null }
  | { kind: 'error'; message: string; code: string | null; param: string | null; clientEventId: string | null }
  | { kind: 'other'; type: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strOr = (v: unknown, d: string | null = null): string | null => (typeof v === 'string' ? v : d);
const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One data-channel message (a JSON string, or an already-parsed event) as a frame; null when it is not an event. */
export function parseFrame(data: unknown): VoiceFrame | null {
  let ev: unknown = data;
  if (typeof data === 'string') {
    try { ev = JSON.parse(data); } catch { return null; }
  }
  if (!isObj(ev) || typeof ev['type'] !== 'string') return null;
  const type = ev['type'];
  switch (type) {
    case 'session.started':
      return { kind: 'started', sessionId: isObj(ev['session']) ? strOr(ev['session']['id']) : null };
    case 'session.input_transcript.delta':
    case 'session.output_transcript.delta':
      return {
        kind: type === 'session.input_transcript.delta' ? 'input' : 'output',
        text: strOr(ev['delta'], '') ?? '', startMs: numOr(ev['start_ms']), endMs: numOr(ev['end_ms']),
      };
    case 'session.output_audio.delta':
      return { kind: 'audio' };
    case 'session.delegation.created': {
      const d = isObj(ev['delegation']) ? ev['delegation'] : {};
      const id = strOr(d['id']);
      return id ? { kind: 'delegation', delegationId: id, responseId: strOr(d['response_id']), target: strOr(d['target']) } : { kind: 'other', type };
    }
    case 'response.event': {
      const delegationId = strOr(ev['delegation_id']);
      const inner = isObj(ev['event']) ? ev['event'] : {};
      const innerType = strOr(inner['type'], '') ?? '';
      if (innerType === 'response.output_item.done' && isObj(inner['item']) && inner['item']['type'] === 'function_call') {
        const item = inner['item'];
        const callId = strOr(item['call_id']), name = strOr(item['name']);
        if (callId && name) return { kind: 'call', delegationId, callId, name, arguments: strOr(item['arguments'], '') ?? '' };
      }
      const response = isObj(inner['response']) ? inner['response'] : {};
      if (innerType === 'response.completed') return { kind: 'response-completed', delegationId, responseId: strOr(response['id']) };
      if (innerType === 'response.failed') {
        const err = isObj(response['error']) ? response['error'] : {};
        return { kind: 'response-failed', delegationId, responseId: strOr(response['id']), message: strOr(err['message'], 'the backend response failed') ?? '' };
      }
      return { kind: 'response-progress', delegationId, type: innerType };
    }
    case 'session.usage.updated': {
      const seconds = isObj(ev['usage']) ? numOr(ev['usage']['seconds']) : null;
      return seconds == null ? { kind: 'other', type } : { kind: 'usage', seconds };
    }
    case 'session.closed':
      return { kind: 'closed', reason: strOr(ev['reason']), seconds: isObj(ev['usage']) ? numOr(ev['usage']['seconds']) : null };
    case 'session.input_audio.muted':
    case 'session.input_audio.unmuted':
      return { kind: 'muted', muted: type === 'session.input_audio.muted' };
    case 'session.thinking.appended':
    case 'session.commentary.appended':
    case 'session.instructions.appended':
      return { kind: 'ack', type, clientEventId: strOr(ev['client_event_id']) };
    case 'error': {
      const err = isObj(ev['error']) ? ev['error'] : {};
      return {
        kind: 'error', message: strOr(err['message'], 'voice session error') ?? '', code: strOr(err['code']), param: strOr(err['param']),
        clientEventId: strOr(err['client_event_id']) ?? strOr(ev['client_event_id']),
      };
    }
    default:
      return { kind: 'other', type };
  }
}

// ── outbound events (only the data-channel allowlist's client events) ───────

export type ClientEventName = 'session.close' | 'session.input_audio.mute' | 'session.input_audio.unmute'
  | 'response.item.create' | 'response.create' | 'session.thinking.append' | 'session.commentary.append';

export const toolOutputEvent = (callId: string, output: string): Obj =>
  ({ type: 'response.item.create', item: { type: 'function_call_output', call_id: callId, output } });
/** Context the voice reads silently. delegation_id is always null under Responses delegation (V1: a non-null one is refused). */
export const thinkingEvent = (content: string): Obj => ({ type: 'session.thinking.append', delegation_id: null, content });
/** Context the voice speaks. */
export const commentaryEvent = (content: string): Obj => ({ type: 'session.commentary.append', delegation_id: null, content });

// ── mint refusals ───────────────────────────────────────────────────────────

/** `unavailable`: will not work by retrying now (no key, no grant, budget, no mic). `failed`: try again. */
export type StartFailure = { kind: 'unavailable' | 'failed'; reason: string };

export function mintFailure(status: number, body: unknown): StartFailure {
  const b = isObj(body) ? body : {};
  const error = strOr(b['error']);
  if (b['code'] === 'voice-demo-refused') return { kind: 'unavailable', reason: 'Voice is not available to the demo identity. Sign in.' };
  if (b['reason'] === 'budget') return { kind: 'unavailable', reason: `Your budget does not cover a voice session: ${error ?? 'refused'}` };
  if (error === 'voice-unavailable') {
    return b['reason'] === 'no-key'
      ? { kind: 'unavailable', reason: 'Voice unavailable: no key on this deployment' }
      : { kind: 'failed', reason: 'The voice provider refused the session. Try again shortly.' };
  }
  if (status === 401) return { kind: 'unavailable', reason: 'Sign in to use voice.' };
  if (status === 403) return { kind: 'unavailable', reason: 'Your role has no voice access in this workspace.' };
  if (status === 429) return { kind: 'failed', reason: 'Too many voice sessions just now. Wait a minute.' };
  if (status === 400) return { kind: 'unavailable', reason: 'This browser could not offer a microphone session.' };
  return { kind: 'failed', reason: `Voice could not start (HTTP ${status}).` };
}

// ── the browser half (WebRTC + WebAudio), behind an interface for tests ─────

export interface MediaSession {
  /** The local SDP offer (after ICE gathering). */
  offer: string;
  applyAnswer(sdp: string): Promise<void>;
  send(text: string): boolean;
  /** Microphone and remote audio, 0..1. */
  levels(): { input: number; output: number };
  setMuted(muted: boolean): void;
  close(): void;
}

export interface MediaHandlers {
  onMessage(data: string): void;
  /** The channel or the peer connection died. */
  onDrop(): void;
}

export type MediaFactory = (handlers: MediaHandlers) => Promise<MediaSession>;

export class MediaUnavailable extends Error {}

function rmsLevel(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3);
}

function waitForIce(pc: RTCPeerConnection, ms = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const finish = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, ms);
  });
}

/** The real browser media path, or null where the browser has no WebRTC or microphone API. */
export function browserMedia(): MediaFactory | null {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  return async (handlers) => {
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      throw new MediaUnavailable(`Microphone unavailable: ${(err as Error)?.message || 'permission denied'}`);
    }
    const audioCtx = new AudioContext();
    const inAnalyser = audioCtx.createAnalyser();
    inAnalyser.fftSize = 512;
    audioCtx.createMediaStreamSource(mic).connect(inAnalyser);
    let outAnalyser: AnalyserNode | null = null;
    const buf = new Uint8Array(new ArrayBuffer(512));
    const audio = document.createElement('audio');
    audio.autoplay = true;
    const pc = new RTCPeerConnection();
    let dropped = false;
    const drop = () => { if (!dropped) { dropped = true; handlers.onDrop(); } };
    pc.addEventListener('track', (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream;
      outAnalyser = audioCtx.createAnalyser();
      outAnalyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(outAnalyser);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) drop();
    });
    mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
    // The data channel must exist before the offer is created.
    const dc = pc.createDataChannel('oai-events');
    dc.addEventListener('message', (e) => handlers.onMessage(typeof e.data === 'string' ? e.data : ''));
    dc.addEventListener('close', drop);
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    let closed = false;
    return {
      offer: pc.localDescription?.sdp ?? '',
      applyAnswer: (sdp) => pc.setRemoteDescription({ type: 'answer', sdp }),
      send: (text) => { if (dc.readyState !== 'open') return false; dc.send(text); return true; },
      levels: () => ({ input: rmsLevel(inAnalyser, buf), output: outAnalyser ? rmsLevel(outAnalyser, buf) : 0 }),
      setMuted: (muted) => mic.getAudioTracks().forEach((t) => { t.enabled = !muted; }),
      close: () => {
        if (closed) return;
        closed = true; dropped = true;
        try { dc.close(); } catch { /* already closed */ }
        pc.close();
        mic.getTracks().forEach((t) => t.stop());
        audio.srcObject = null;
        void audioCtx.close().catch(() => {});
      },
    };
  };
}

// ── the client ──────────────────────────────────────────────────────────────

export type ClientEvent =
  | { type: 'minted'; mint: VoiceMint }
  | { type: 'unavailable'; reason: string }
  | { type: 'failed'; reason: string }
  | { type: 'frame'; frame: VoiceFrame }
  | { type: 'dropped' }
  | { type: 'ended'; reason: StopReason; seconds: number | null };

/** A tool-call row (POST /:id/events): the arguments' hash only, never the arguments (§9). */
export interface ToolCallReport {
  tool: string;
  argsSha256: string;
  outcome: 'done' | 'refused' | 'failed' | 'cancelled';
  durationMs: number;
  confirmedBy?: 'voice' | 'click';
}

type Timer = unknown;

export interface VoiceClientOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The browser media path; null = none (tests, or a browser without WebRTC: only a mock mint can run). */
  media: MediaFactory | null;
  onEvent(e: ClientEvent): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  closeWaitMs?: number;
}

export class VoiceClient {
  mint: VoiceMint | null = null;
  /** Cumulative seconds from the last session.usage.updated / session.closed. */
  usageSeconds: number | null = null;
  private media: MediaSession | null = null;
  private startedAt: number | null = null;
  private mintedAt: number | null = null;
  private seq = 0;
  private timers = new Set<Timer>();
  private closedWaiter: (() => void) | null = null;
  private sawClosed = false;
  private finished = false;
  private live = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  private readonly opts: VoiceClientOptions;

  constructor(opts: VoiceClientOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Microphone (when there is one), offer, mint, answer. Reports `minted` or a refusal through onEvent. */
  async start(): Promise<void> {
    if (this.opts.media) {
      try {
        this.media = await this.opts.media({ onMessage: (d) => this.deliver(d), onDrop: () => this.onDrop() });
      } catch (err) {
        this.opts.onEvent({ type: 'unavailable', reason: err instanceof MediaUnavailable ? err.message : 'This browser cannot open a voice session.' });
        return;
      }
    }
    let res: Response;
    let body: unknown;
    try {
      res = await this.opts.fetch(VOICE_API, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.media ? { sdp: this.media.offer } : {}),
      });
      body = await res.json().catch(() => null);
    } catch {
      this.teardown();
      this.opts.onEvent({ type: 'failed', reason: 'The server could not be reached.' });
      return;
    }
    if (!res.ok) {
      this.teardown();
      const f = mintFailure(res.status, body);
      this.opts.onEvent({ type: f.kind, reason: f.reason });
      return;
    }
    const mint = body as VoiceMint;
    this.mint = mint;
    this.mintedAt = this.now();
    this.live = true;
    this.opts.onEvent({ type: 'minted', mint });
    if (mint.mock) {
      // The scripted session: no media at all (§6). A real microphone opened for the offer is released.
      this.media?.close();
      this.media = null;
      this.play(mint.mockScript?.onStart ?? []);
      return;
    }
    if (!this.media) {
      this.live = false;
      this.opts.onEvent({ type: 'unavailable', reason: 'This browser cannot open a microphone session.' });
      return;
    }
    try {
      await this.media.applyAnswer(mint.sdp);
    } catch {
      await this.stop('dropped');
    }
  }

  get mocked(): boolean { return this.mint?.mock === true; }

  /** Seconds since session.started (or since the mint, when it never started). */
  elapsedSeconds(): number {
    const from = this.startedAt ?? this.mintedAt;
    return from == null ? 0 : Math.max(0, (this.now() - from) / 1000);
  }

  levels(): { input: number; output: number } {
    return this.media?.levels() ?? { input: 0, output: 0 };
  }

  /** Send one allowlisted client event; returns its event_id, or null when nothing is open. */
  send(event: Obj & { type: ClientEventName }): string | null {
    if (!this.live) return null;
    const id = `voice_${++this.seq}`;
    const ev = { event_id: id, ...event };
    if (this.mocked) {
      if (ev.type === 'response.create') this.play(this.mint?.mockScript?.onResponseCreate ?? []);
      if (ev.type === 'session.close') this.play(this.mint?.mockScript?.onClose ?? []);
      return id;
    }
    return this.media?.send(JSON.stringify(ev)) ? id : null;
  }

  sendToolOutput(callId: string, output: string): string | null {
    return this.send(toolOutputEvent(callId, output) as Obj & { type: 'response.item.create' });
  }

  requestResponse(): string | null {
    return this.send({ type: 'response.create' });
  }

  appendThinking(content: string): string | null {
    return this.send(thinkingEvent(content) as Obj & { type: 'session.thinking.append' });
  }

  appendCommentary(content: string): string | null {
    return this.send(commentaryEvent(content) as Obj & { type: 'session.commentary.append' });
  }

  setMuted(muted: boolean): void {
    this.media?.setMuted(muted);
    this.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
  }

  /** POST /:id/events. Best-effort: a lost row never breaks the session. */
  async reportToolCall(row: ToolCallReport): Promise<void> {
    if (!this.mint) return;
    try {
      await this.opts.fetch(`${VOICE_API}/${encodeURIComponent(this.mint.sessionId)}/events`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row),
      });
    } catch { /* the row is telemetry */ }
  }

  /**
   * Hang up: session.close and wait (bounded) for session.closed, release the
   * media, then POST /:id/close with the seconds, exactly once.
   */
  async stop(reason: StopReason = 'closed'): Promise<void> {
    if (this.finished || !this.mint) { this.teardown(); return; }
    if (this.live && reason !== 'dropped' && !this.sawClosed) {
      const closed = new Promise<void>((resolve) => { this.closedWaiter = resolve; });
      const sent = this.send({ type: 'session.close' });
      if (sent) {
        await Promise.race([closed, new Promise<void>((resolve) => {
          const t = this.setTimer(resolve, this.opts.closeWaitMs ?? CLOSE_WAIT_MS);
          this.timers.add(t);
        })]);
      }
    }
    await this.finish(reason);
  }

  private async finish(reason: StopReason): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const seconds = this.reportedSeconds();
    this.teardown();
    const mint = this.mint!;
    try {
      await this.opts.fetch(`${VOICE_API}/${encodeURIComponent(mint.sessionId)}/close`, {
        method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, reason }),
      });
    } catch { /* the reaper settles a session whose close never arrived (§7) */ }
    this.opts.onEvent({ type: 'ended', reason, seconds });
  }

  /** The figure the close reports: the provider's cumulative usage when known, else the wall clock. */
  private reportedSeconds(): number {
    return Math.ceil(Math.max(this.usageSeconds ?? 0, this.elapsedSeconds()));
  }

  private onDrop(): void {
    if (!this.live || this.finished) return;
    this.opts.onEvent({ type: 'dropped' });
    void this.finish('dropped');
  }

  private deliver(data: string): void {
    if (this.finished) return;
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.kind === 'started' && this.startedAt == null) this.startedAt = this.now();
    if (frame.kind === 'usage') this.usageSeconds = frame.seconds;
    if (frame.kind === 'closed') {
      if (frame.seconds != null) this.usageSeconds = frame.seconds;
      this.sawClosed = true;
    }
    this.opts.onEvent({ type: 'frame', frame });
    if (frame.kind === 'closed') {
      const waiter = this.closedWaiter;
      this.closedWaiter = null;
      // Closed by the provider (expiry) with nobody hanging up: settle it here.
      if (waiter) waiter(); else void this.finish('closed');
    }
  }

  private play(frames: MockFrame[]): void {
    for (const f of frames) {
      const t = this.setTimer(() => { this.timers.delete(t); this.deliver(JSON.stringify(f.event)); }, f.atMs);
      this.timers.add(t);
    }
  }

  private teardown(): void {
    this.live = false;
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    this.media?.close();
    this.media = null;
    const waiter = this.closedWaiter;
    this.closedWaiter = null;
    waiter?.();
  }
}

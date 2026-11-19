// The voice harness's pieces: clips, the real-time feeder, our own voice-activity check, the Live session (through the
// middleware's own client: lib/voice/openai.ts openLiveSocket + liveSocketSessionBody) and a provider transcription stream.
// Nothing here logs a key, an audio payload or the model's audio: output frames are reduced to their RMS on arrival.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { liveSocketSessionBody, openLiveSocket, type LiveSocket } from '../../middleware/src/lib/voice/openai.js';

export const RATE = 24_000;
export const FRAME_MS = 100;
export const FRAME_BYTES = (RATE * 2 * FRAME_MS) / 1000; // 4,800
export const VOICED_RMS = 100; // live-session.ts OUTPUT_VOICED_RMS: the provider's silent frames are all zero
export const USD_PER_LIVE_MINUTE = 0.05; // middleware/src/lib/voice/config.ts VOICE_USD_PER_MINUTE (gpt-live-1 list price)
export const USD_PER_TRANSCRIBE_MINUTE = 0.017; // gpt-live-transcribe model page

export const now = (): number => performance.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Load OPENAI_API_KEY from an env file into this process only. Never printed. */
export function loadKey(envFile: string): void {
  if (process.env['OPENAI_API_KEY']) return;
  if (!existsSync(envFile)) throw new Error('env file not found');
  const m = readFileSync(envFile, 'utf8').match(/^OPENAI_API_KEY=(.*)$/m);
  const v = m ? m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  if (!v || v.includes('REPLACE_ME')) throw new Error('no OPENAI_API_KEY in the env file');
  process.env['OPENAI_API_KEY'] = v;
}

/** A 24 kHz mono PCM16 WAV's samples (the data chunk). */
export function readWav(path: string): Buffer {
  const b = readFileSync(path);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4); const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      const ch = b.readUInt16LE(at + 10); const rate = b.readUInt32LE(at + 12); const bits = b.readUInt16LE(at + 22);
      if (ch !== 1 || rate !== RATE || bits !== 16) throw new Error(`${path}: need mono ${RATE} Hz PCM16`);
    }
    if (id === 'data') return b.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

export function rms(pcm: Buffer, from = 0, to = pcm.length): number {
  let sum = 0; let n = 0;
  for (let i = from; i + 1 < to; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n += 1; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Offset (ms) of the first voiced 10 ms window in a frame, or -1. */
export function voicedOnsetMs(pcm: Buffer): number {
  const win = (RATE * 2) / 100;
  for (let at = 0; at + win <= pcm.length; at += win) if (rms(pcm, at, at + win) > VOICED_RMS) return (at / win) * 10;
  return -1;
}

/**
 * Our own voice-activity check on ONE person's clean audio: voiced = a 20 ms window over `threshold`; it reports the
 * end of speech once `quietMs` of unvoiced audio follows voiced audio. Fed the exact frames the session is fed.
 */
export class Vad {
  private voicedSeen = false; private quiet = 0; private fired = false;
  constructor(private readonly quietMs: number, private readonly threshold = 300) {}
  reset(): void { this.voicedSeen = false; this.quiet = 0; this.fired = false; }
  /** Returns true once, on the frame where `quietMs` of quiet after speech is reached. */
  push(pcm: Buffer): boolean {
    const win = (RATE * 2) / 50;
    for (let at = 0; at + win <= pcm.length; at += win) {
      if (rms(pcm, at, at + win) > this.threshold) { this.voicedSeen = true; this.quiet = 0; this.fired = false; }
      else if (this.voicedSeen) this.quiet += 20;
    }
    if (this.voicedSeen && !this.fired && this.quiet >= this.quietMs) { this.fired = true; return true; }
    return false;
  }
}

export interface Logger { (row: Record<string, unknown>): void }
export function jsonlLogger(path: string | null): Logger {
  return (row) => { if (path) appendFileSync(path, JSON.stringify(row) + '\n'); };
}

export interface LiveEvents {
  /** First voiced output 10 ms window: wall time it arrived + its offset in the frame. */
  onVoice?: (atWall: number) => void;
  onOutputText?: (text: string, atWall: number) => void;
  onInputText?: (text: string, atWall: number, ev: Record<string, unknown>) => void;
  onOther?: (ev: Record<string, unknown>, atWall: number) => void;
}

/**
 * One Live session over the primary WebSocket, started with the middleware's own session body. `extra` is merged into the
 * session object (the probe of fields the session may take); a refusal before the start rejects `start()` with the code.
 */
export class LiveProbe {
  socket: LiveSocket | null = null;
  started = false; startedWall = 0; closed = false; usageSeconds = 0; closeReason = '';
  errors: Array<{ code: string; param?: string; message?: string; atWall: number }> = [];
  outputVoiced = false; lastVoiceWall = 0; framesIn = 0; voicedFramesIn = 0;
  constructor(private readonly ev: LiveEvents = {}) {}

  start(input: { instructions: string; voice?: string | null; extra?: Record<string, unknown>; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const socket = openLiveSocket(); this.socket = socket;
    const body = { ...liveSocketSessionBody({ model: process.env['VOICE_LIVE_MODEL'] || 'gpt-live-1', instructions: input.instructions, delegationInstructions: '', voice: input.voice ?? 'marin', delegationModel: null, tools: [] }), ...(input.extra ?? {}) };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('start timeout')), input.timeoutMs ?? 10_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'session.start', event_id: 'harness_start', session: body })));
      socket.addEventListener('close', () => { this.closed = true; clearTimeout(t); if (!this.started) reject(new Error(this.errors[0]?.code ?? 'closed before start')); });
      socket.addEventListener('error', () => { /* the close follows */ });
      socket.addEventListener('message', (m: { data?: unknown }) => {
        const atWall = now();
        let e: Record<string, unknown>;
        try { e = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data as ArrayBuffer).toString('utf8')) as Record<string, unknown>; } catch { return; }
        const type = e['type'];
        if (type === 'session.output_audio.delta') { this.onAudio(e['delta'], atWall); return; }
        if (type === 'session.started') { this.started = true; this.startedWall = atWall; clearTimeout(t); resolve((e['session'] ?? {}) as Record<string, unknown>); return; }
        if (type === 'session.usage.updated' || type === 'session.closed') {
          const s = (e['usage'] as { seconds?: unknown } | undefined)?.seconds; if (typeof s === 'number') this.usageSeconds = Math.max(this.usageSeconds, s);
          if (type === 'session.closed') { this.closeReason = String(e['reason'] ?? ''); this.closed = true; }
        }
        if (type === 'error') {
          const err = (e['error'] ?? e) as { code?: unknown; param?: unknown; message?: unknown };
          this.errors.push({ code: String(err.code ?? e['code'] ?? 'error'), ...(err.param ? { param: String(err.param) } : {}), ...(typeof err.message === 'string' ? { message: err.message.slice(0, 400) } : {}), atWall });
          if (!this.started) { clearTimeout(t); reject(new Error(`${String(err.code ?? 'error')}${err.param ? ` (${String(err.param)})` : ''}: ${typeof err.message === 'string' ? err.message.slice(0, 160) : ''}`)); }
        }
        if (type === 'session.output_transcript.delta' && typeof e['delta'] === 'string') this.ev.onOutputText?.(e['delta'], atWall);
        else if (type === 'session.input_transcript.delta' && typeof e['delta'] === 'string') this.ev.onInputText?.(e['delta'], atWall, e);
        else this.ev.onOther?.(e, atWall);
      });
    });
  }

  private onAudio(delta: unknown, atWall: number): void {
    if (typeof delta !== 'string') return;
    const pcm = Buffer.from(delta, 'base64'); // reduced to timing at once; never kept
    this.framesIn += 1;
    const onset = voicedOnsetMs(pcm);
    if (onset >= 0) {
      this.voicedFramesIn += 1; this.lastVoiceWall = atWall; this.outputVoiced = true;
      this.ev.onVoice?.(atWall + onset);
    }
  }

  /** Whether voice is running now (a voiced frame within `ms`). */
  speakingWithin(ms: number): boolean { return this.lastVoiceWall > 0 && now() - this.lastVoiceWall < ms; }

  send(ev: Record<string, unknown>): void { try { this.socket?.send(JSON.stringify(ev)); } catch { /* closed */ } }
  append(pcm: Buffer): void { this.send({ type: 'session.input_audio.append', audio: pcm.toString('base64') }); }

  async close(): Promise<void> {
    if (!this.socket) return;
    if (!this.closed) {
      this.send({ type: 'session.close' });
      const until = now() + 4000;
      while (!this.closed && now() < until) await sleep(50);
    }
    try { this.socket.close(1000); } catch { /* closed */ }
  }
}

/**
 * The provider's transcription stream (Realtime transcription session, gpt-live-transcribe, no turn detection: we commit at
 * our own end of speech). One per person.
 */
export class TranscribeProbe {
  socket: WebSocket | null = null; ready = false; closed = false; errors: string[] = [];
  constructor(private readonly onDelta: (text: string, atWall: number, kind: 'delta' | 'completed') => void) {}
  start(opts: { delay?: string; keywords?: string[]; languages?: string[] }): Promise<void> {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) throw new Error('no key');
    const Ctor = (globalThis as unknown as { WebSocket: new (u: string, i: unknown) => WebSocket }).WebSocket;
    const ws = new Ctor('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${key}` } });
    this.socket = ws;
    const transcription: Record<string, unknown> = { model: process.env['TRANSCRIBE_MODEL'] || 'gpt-live-transcribe' };
    if (opts.delay) transcription['delay'] = opts.delay;
    if (opts.keywords) transcription['keywords'] = opts.keywords;
    if (opts.languages) transcription['languages'] = opts.languages;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('transcription start timeout')), 10_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: RATE }, transcription, turn_detection: null } } } })));
      ws.addEventListener('close', () => { this.closed = true; clearTimeout(t); if (!this.ready) reject(new Error(this.errors[0] ?? 'closed')); });
      ws.addEventListener('message', (m: MessageEvent) => {
        const atWall = now();
        let e: Record<string, unknown>;
        try { e = JSON.parse(String(m.data)) as Record<string, unknown>; } catch { return; }
        const type = String(e['type']);
        if (type === 'session.updated' || type === 'transcription_session.updated') { if (!this.ready) { this.ready = true; clearTimeout(t); resolve(); } }
        else if (type === 'conversation.item.input_audio_transcription.delta') this.onDelta(String(e['delta'] ?? ''), atWall, 'delta');
        else if (type === 'conversation.item.input_audio_transcription.completed') this.onDelta(String(e['transcript'] ?? ''), atWall, 'completed');
        else if (type === 'error') {
          const err = (e['error'] ?? {}) as { code?: unknown; message?: unknown; param?: unknown };
          this.errors.push(`${String(err.code ?? 'error')} ${String(err.param ?? '')} ${String(err.message ?? '').slice(0, 160)}`);
          if (!this.ready) { clearTimeout(t); reject(new Error(this.errors.at(-1))); }
        }
      });
    });
  }
  append(pcm: Buffer): void { try { this.socket?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })); } catch { /* closed */ } }
  commit(): void { try { this.socket?.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch { /* closed */ } }
  close(): void { try { this.socket?.close(1000); } catch { /* closed */ } this.closed = true; }
}

export function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round(s[i]!);
}

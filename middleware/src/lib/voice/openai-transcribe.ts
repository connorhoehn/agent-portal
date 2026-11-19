// One provider transcription stream for one person (hands-free Milo's listening side; a port of the probe's TranscribeProbe).
//
// Realtime transcription session (`?intent=transcription`), model `gpt-live-transcribe`, `delay: minimal` and the name's spellings as
// `keywords` (the probe: the name 212 ms median / 393 ms p90 after it is spoken, 23/24 right), no provider turn detection. The
// stream commits at its own end of speech: an energy check on the person's clean audio (a 20 ms window over RMS 300 is voiced),
// `quietMs` of quiet after speech commits, and a run of speech longer than `maxSegmentMs` is committed where it is. Deltas arrive
// before the commit; the commit's `completed` is the final.
//
// Times are the stream's own ms: byte count of audio appended / 48. The key stays here (read from the environment at open, put in
// the socket's header, never in a return value, an error or a log line). Audio is never logged; only counts are.

import type { PersonTranscriber } from '../meeting-assistant/handsfree/types.js';

const RATE = 24_000;
const BYTES_PER_MS = (RATE * 2) / 1000;
const WINDOW_BYTES = (RATE * 2) / 50; // 20 ms
const VOICED_RMS = 300;

export const TRANSCRIBE_DEFAULTS = Object.freeze({
  model: 'gpt-live-transcribe',
  delay: 'minimal',
  /** Quiet after speech that ends a segment. Longer than the "Hey Milo, <pause>" gap the probe saw cut at 350 ms. */
  quietMs: 600,
  maxSegmentMs: 15_000,
  openTimeoutMs: 10_000,
});

/** The stream cannot be opened at all (no key, no WebSocket): a configuration error, never retried. */
export class TranscribeConfigError extends Error {
  readonly config = true;
  constructor(message: string) { super(message); this.name = 'TranscribeConfigError'; }
}

/** The part of a WebSocket this uses (Node 22's built-in, or a test's fake). */
export interface TranscribeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void;
}
export type TranscribeSocketCtor = new (url: string, init: { headers: Record<string, string> }) => TranscribeSocket;

const builtin = (): TranscribeSocketCtor | null =>
  ((globalThis as { WebSocket?: unknown }).WebSocket as TranscribeSocketCtor | undefined) ?? null;
let socketCtor: () => TranscribeSocketCtor | null = builtin;
/** Tests: replace the WebSocket constructor (null = the built-in one). */
export function _setTranscribeWebSocket(ctor: TranscribeSocketCtor | null): void { socketCtor = ctor ? () => ctor : builtin; }

function apiKey(): string | null {
  const v = (process.env['OPENAI_API_KEY'] ?? '').trim();
  return v && !v.includes('REPLACE_ME') ? v : null;
}
function wsBase(): string {
  return ((process.env['OPENAI_BASE_URL'] ?? '').trim() || 'https://api.openai.com/v1').replace(/\/$/, '').replace(/^http/, 'ws');
}

function rms(pcm: Buffer, from: number, to: number): number {
  let sum = 0; let n = 0;
  for (let i = from; i + 1 < to; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n += 1; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** End-of-speech check on one person's audio, in stream ms. */
export class SegmentVad {
  private voicedAt: number | null = null; // start of the open segment
  private lastVoicedEnd = 0;
  private pos = 0; // stream ms of the audio pushed so far
  private carry = Buffer.alloc(0);
  constructor(private readonly quietMs: number, private readonly maxSegmentMs: number) {}
  /** Feed audio; returns the segments it closed, as [startMs, endMs] (end = the last voiced window's end). */
  push(pcm: Buffer): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    const buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    let at = 0;
    for (; at + WINDOW_BYTES <= buf.length; at += WINDOW_BYTES) {
      const start = this.pos; this.pos += 20;
      if (rms(buf, at, at + WINDOW_BYTES) > VOICED_RMS) {
        if (this.voicedAt === null) this.voicedAt = start;
        this.lastVoicedEnd = this.pos;
        if (this.pos - this.voicedAt >= this.maxSegmentMs) { out.push([this.voicedAt, this.pos]); this.voicedAt = null; }
      } else if (this.voicedAt !== null && this.pos - this.lastVoicedEnd >= this.quietMs) {
        out.push([this.voicedAt, this.lastVoicedEnd]); this.voicedAt = null;
      }
    }
    this.carry = Buffer.from(buf.subarray(at));
    return out;
  }
}

type Listener = (e: never) => void;

export interface OpenAiTranscriberOptions {
  keywords: readonly string[];
  /** Counts only (never audio, never text): opened, errors, commits. */
  log?: (row: Record<string, unknown>) => void;
  quietMs?: number;
  maxSegmentMs?: number;
  openTimeoutMs?: number;
}

/**
 * Open one stream. Resolves once the provider accepted the session; rejects with TranscribeConfigError when it cannot be opened at
 * all, or a plain Error when the provider refused or did not answer in time (the listening side may retry those).
 */
export function openOpenAiTranscriber(opts: OpenAiTranscriberOptions): Promise<PersonTranscriber> {
  const key = apiKey();
  const Ctor = socketCtor();
  if (!key || !Ctor) return Promise.reject(new TranscribeConfigError('no OpenAI key or WebSocket available'));
  const log = opts.log ?? (() => {});
  const vad = new SegmentVad(opts.quietMs ?? TRANSCRIBE_DEFAULTS.quietMs, opts.maxSegmentMs ?? TRANSCRIBE_DEFAULTS.maxSegmentMs);
  const listeners: Record<'delta' | 'final' | 'closed', Set<Listener>> = { delta: new Set(), final: new Set(), closed: new Set() };
  const emit = (type: 'delta' | 'final' | 'closed', e: unknown): void => {
    for (const fn of [...listeners[type]]) { try { (fn as (x: unknown) => void)(e); } catch (err) { log({ event: 'transcribe-listener-threw', type, error: String(err).slice(0, 120) }); } }
  };

  let streamBytes = 0;
  let ready = false;
  let closed = false;
  let closedEmitted = false;
  // Segments committed (in order) that no provider item is bound to yet, and the binding of item ids to segments.
  const unbound: Array<{ start: number; end: number }> = [];
  const items = new Map<string, { start: number; end: number } | null>();
  const itemOrder: string[] = [];
  const bind = (itemId: string): void => {
    if (items.has(itemId)) { if (items.get(itemId) === null && unbound.length) items.set(itemId, unbound.shift()!); return; }
    items.set(itemId, unbound.shift() ?? null);
    itemOrder.push(itemId);
    while (itemOrder.length > 64) items.delete(itemOrder.shift()!);
  };

  const ws = new Ctor(`${wsBase()}/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${key}` } });
  const send = (o: unknown): boolean => {
    if (closed) return false;
    try { ws.send(JSON.stringify(o)); return true; } catch { return false; }
  };
  const finish = (error: string | null): void => {
    closed = true;
    if (closedEmitted) return;
    closedEmitted = true;
    emit('closed', { error });
  };

  const transcriber: PersonTranscriber = {
    append(pcm: Buffer): void {
      if (closed || !ready || pcm.length === 0) return;
      const body = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
      if (!send({ type: 'input_audio_buffer.append', audio: body.toString('base64') })) return;
      streamBytes += body.length;
      for (const [start, end] of vad.push(body)) {
        unbound.push({ start, end });
        // An item may already be waiting for its segment (deltas came first).
        const waiting = itemOrder.find((id) => items.get(id) === null);
        if (waiting) items.set(waiting, unbound.shift()!);
        send({ type: 'input_audio_buffer.commit' });
        log({ event: 'transcribe-commit', startMs: start, endMs: end, streamMs: Math.round(streamBytes / BYTES_PER_MS) });
      }
    },
    on(type: 'delta' | 'final' | 'closed', fn: Listener): () => void {
      listeners[type].add(fn);
      return () => { listeners[type].delete(fn); };
    },
    close(): Promise<void> {
      if (closedEmitted) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(() => { finish(null); resolve(); }, 1_000);
        (t as { unref?: () => void }).unref?.();
        transcriber.on('closed', () => { clearTimeout(t); resolve(); });
        closed = true;
        try { ws.close(1000); } catch { finish(null); }
      });
    },
  } as PersonTranscriber;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail('transcription start timeout'); try { ws.close(1000); } catch { /* gone */ } }, opts.openTimeoutMs ?? TRANSCRIBE_DEFAULTS.openTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let settled = false;
    const fail = (msg: string): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); closed = true; closedEmitted = true;
      reject(new Error(msg));
    };
    ws.addEventListener('open', () => {
      send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: RATE },
              transcription: { model: process.env['TRANSCRIBE_MODEL'] || TRANSCRIBE_DEFAULTS.model, delay: TRANSCRIBE_DEFAULTS.delay, keywords: [...opts.keywords], languages: ['en'] },
              turn_detection: null,
            },
          },
        },
      });
    });
    ws.addEventListener('error', () => { if (!settled) fail('transcription socket error'); });
    ws.addEventListener('close', (ev: { code?: number }) => {
      if (!settled) { fail(`transcription closed before start (${String(ev?.code ?? '')})`); return; }
      finish(closed && ready ? null : `closed ${String(ev?.code ?? '')}`);
    });
    ws.addEventListener('message', (m: { data: unknown }) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(String(m.data)) as Record<string, unknown>; } catch { return; }
      const type = String(e['type']);
      if (type === 'session.updated' || type === 'transcription_session.updated') {
        if (!settled) { settled = true; ready = true; clearTimeout(timer); log({ event: 'transcribe-open' }); resolve(transcriber); }
        return;
      }
      const itemId = typeof e['item_id'] === 'string' ? e['item_id'] : '';
      if (type === 'input_audio_buffer.committed' && itemId) { bind(itemId); return; }
      if (type === 'conversation.item.input_audio_transcription.delta') {
        if (!itemId) return;
        bind(itemId);
        emit('delta', { itemId, delta: String(e['delta'] ?? ''), streamMs: Math.round(streamBytes / BYTES_PER_MS) });
        return;
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        if (!itemId) return;
        bind(itemId);
        const seg = items.get(itemId) ?? null;
        const nowMs = Math.round(streamBytes / BYTES_PER_MS);
        emit('final', { itemId, text: String(e['transcript'] ?? ''), startStreamMs: seg?.start ?? nowMs, endStreamMs: seg?.end ?? nowMs });
        return;
      }
      if (type === 'error') {
        const err = (e['error'] ?? {}) as { code?: unknown; type?: unknown };
        const code = String(err.code ?? err.type ?? 'error').slice(0, 80);
        log({ event: 'transcribe-error', code });
        if (!settled) fail(code);
      }
    });
  });
}

/** The listening side's factory over the real stream. */
export function openAiTranscriberFactory(log?: (row: Record<string, unknown>) => void) {
  return (input: { callId: string; userId: string; keywords: readonly string[] }): Promise<PersonTranscriber> =>
    openOpenAiTranscriber({ keywords: input.keywords, log: log ? (row) => log({ ...row, callId: input.callId }) : undefined });
}

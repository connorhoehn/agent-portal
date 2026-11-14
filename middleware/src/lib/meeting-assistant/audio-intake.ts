// The PCM sink behind the media server's per-participant taps (docs/meeting-assistant-design.md, decisions 1, 2, 8, 9).
//
// The media server POSTs each participant's own 16 kHz mono s16le audio, 200 ms at a time, to a URL that carries an
// unguessable per-call token. This module is everything between that POST and the live session:
//
//   token + channel check ──► rate limit ──► who is this participant ──► has that person acknowledged? ──► mixer ──► session
//
// It never awaits anything on the request path: a chunk is checked against in-memory state, resampled into the call's
// mixer, and the answer goes back in microseconds. The mixer emits frames on a timer, and that is the only thing that
// touches the provider.
//
// The authority, in one place:
//   * The sink token is the only thing that lets audio in. 32 random bytes, base64url; the plain value exists only in
//     the URL handed to the media server, and what is kept (here and on the assistant record) is its SHA-256. It is
//     compared in constant time, bound to the call's channel (`X-Channel-Arn` must match), and dead the moment the
//     session is detached (pause, leave, replacement), so a resumed call gets a new token and a new tap.
//   * A participant id means a person only through a binding the person made themselves for their own seat
//     (`bindParticipant`; the route checks the id is theirs). An unmapped participant's audio is dropped, never mixed.
//   * A person who has not acknowledged the notice (and is not the inviter) is dropped before the timeline and the mixer.
//   * Audio lives only in the mixer's ring. This module writes no file and logs no audio.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CallMixer, type MixerStats } from './mixer.js';
import type { AssistantStore } from './store.js';
import { sessionOf, type AssistantRecord } from './types.js';

export const MAX_CHUNK_BYTES = 64 * 1024;
export const SINK_SAMPLE_RATE = 16_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_IDS_PER_USER = 8;
const MAX_IDS_PER_CALL = 64;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();
export const newSinkToken = (): string => randomBytes(32).toString('base64url');

export interface AudioCounters {
  chunks: number;
  /** Chunks whose participant id is bound to nobody. */
  unmappedChunks: number;
  /** Chunks from a person who has not acknowledged the notice. */
  unackedChunks: number;
  /** Chunks that arrived while the record was not listening. */
  notListeningChunks: number;
  lateChunks: number;
  overrunChunks: number;
  mixedChunks: number;
}
const zeroCounters = (): AudioCounters => ({ chunks: 0, unmappedChunks: 0, unackedChunks: 0, notListeningChunks: 0, lateChunks: 0, overrunChunks: 0, mixedChunks: 0 });

/** Where one call's mixed audio and per-speaker audio go; the orchestrator supplies it when a session opens. */
export interface AudioSink {
  /** One 100 ms frame of 24 kHz mono PCM for the session. */
  append(pcm24k: Buffer): void;
  /** A participant's own audio as mixed, on the session timeline. */
  placed(userId: string, pcm24k: Buffer, atMs: number): void;
}

interface Gate { listening: boolean; acked: ReadonlySet<string>; invitedBy: string }

interface Armed {
  callId: string;
  hash: Buffer;
  channelArn: string;
  gate: Gate;
  counters: AudioCounters;
  base: AudioCounters;
  dirty: boolean;
  bucket: { tokens: number; at: number };
  syncSeq: number;
  lastSync: number;
  lastFlush: number;
}

/** One open live session's audio side: the mixer and the clock that drives it. */
interface Attached { mixer: CallMixer; timer: ReturnType<typeof setInterval> | null }

export type Admission = 'ok' | 'unknown' | 'limited';
export type ChunkResult = 'mixed' | 'unmapped' | 'unacked' | 'not-listening' | 'late' | 'overrun' | 'bad-format' | 'unknown';

export interface AudioIntakeOptions {
  clock?: () => number;
  /** How often mixers emit and gates refresh; 0 turns the timer off (tests call `tick`). */
  tickMs?: number;
  /** Chunks per second one token may send (a tap sends five per speaker). */
  ratePerSecond?: number;
  burst?: number;
}

export class AudioIntake {
  private readonly byHash = new Map<string, Armed>();
  private readonly byCall = new Map<string, Armed>();
  private readonly clock: () => number;
  private readonly tickMs: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(private readonly store: () => AssistantStore, opts: AudioIntakeOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.tickMs = opts.tickMs ?? 50;
    this.rate = opts.ratePerSecond ?? 100;
    this.burst = opts.burst ?? 200;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lifecycle

  /**
   * Make a fresh token for a call's channel and return it (the one place the plain value exists). Any earlier token for
   * the call is dead from this moment. Counters carry on from what the record already holds. Audio is admitted only while
   * a session is attached.
   */
  async arm(callId: string, channelArn: string): Promise<string> {
    const previous = this.byCall.get(callId);
    if (previous) this.byHash.delete(previous.hash.toString('base64url'));
    const token = newSinkToken();
    const hash = hashToken(token);
    const record = await this.store().get(callId);
    const kept = record ? sessionOf(record) : null;
    if (!this.bindings.has(callId)) this.bindings.set(callId, new Map(Object.entries(kept?.participants ?? {})));
    const base: AudioCounters = { ...zeroCounters(), unmappedChunks: kept?.unmappedChunks ?? 0, unackedChunks: kept?.unackedChunks ?? 0, lateChunks: kept?.lateChunks ?? 0 };
    const armed: Armed = {
      callId, hash, channelArn, gate: { listening: false, acked: new Set(), invitedBy: '' },
      counters: zeroCounters(), base, dirty: false,
      bucket: { tokens: this.burst, at: this.clock() }, syncSeq: 0, lastSync: -Infinity, lastFlush: this.clock(),
    };
    this.byHash.set(hash.toString('base64url'), armed);
    this.byCall.set(callId, armed);
    await this.syncGate(armed);
    await this.store().patchSession(callId, { sinkTokenHash: hash.toString('base64url') }).catch(() => undefined);
    return token;
  }

  /** The call's token is dead (the tap is the caller's to delete). Idempotent. */
  disarm(callId: string): void {
    const armed = this.byCall.get(callId);
    if (!armed) return;
    this.byHash.delete(armed.hash.toString('base64url'));
    this.byCall.delete(callId);
    void this.flush(armed);
    void this.store().patchSession(callId, { sinkTokenHash: null }).catch(() => undefined);
    for (const l of [...this.deadListeners]) { try { l(callId); } catch (e) { console.warn('[meeting-assistant] audio listener failed', (e as Error).message); } }
  }

  /** Be told when a call's token dies (paused, left, ceiling, call end). The tap armer deletes the tap then. */
  onDead(listener: (callId: string) => void): () => void { this.deadListeners.add(listener); return () => { this.deadListeners.delete(listener); }; }
  private readonly deadListeners = new Set<(callId: string) => void>();

  /**
   * A live session opened for the call: a mixer on a fresh time base starts. (Replacing a session is detach then attach,
   * which is how the time base resets.) Audio is admitted once the call is also armed.
   */
  attach(callId: string, sink: AudioSink): void {
    this.suspend(callId);
    const mixer = new CallMixer({ clock: this.clock, onFrame: (f) => sink.append(f), onPlaced: (u, pcm, at) => sink.placed(u, pcm, at) });
    let timer: ReturnType<typeof setInterval> | null = null;
    if (this.tickMs > 0) {
      timer = setInterval(() => { void this.tick(callId); }, this.tickMs);
      timer.unref?.();
    }
    this.sessions.set(callId, { mixer, timer });
  }

  /** The session is gone for now (a reconnect is coming): the mixer closes and chunks answer 404 until `attach`; the token still lives. */
  suspend(callId: string): void {
    const attached = this.sessions.get(callId);
    if (!attached) return;
    attached.mixer.close();
    if (attached.timer) clearInterval(attached.timer);
    this.sessions.delete(callId);
  }

  /** Paused or left: the mixer is gone and the call's token is dead at once. */
  detach(callId: string): void {
    this.suspend(callId);
    this.disarm(callId);
  }

  private readonly sessions = new Map<string, Attached>();

  isArmed(callId: string): boolean { return this.byCall.has(callId); }

  // -------------------------------------------------------------------------------------------------------------
  // Who is who

  /** Bind a media participant id to a person. The caller (the route) has already shown the id is theirs. */
  async bindParticipant(callId: string, participantId: string, userId: string): Promise<'bound' | 'taken' | 'too-many'> {
    let map = this.bindings.get(callId);
    if (!map) {
      const record = await this.store().get(callId);
      map = this.bindings.get(callId) ?? new Map(Object.entries(record ? sessionOf(record).participants ?? {} : {}));
      this.bindings.set(callId, map);
    }
    const owner = map.get(participantId);
    if (owner && owner !== userId) return 'taken';
    if (owner === userId) return 'bound';
    const mine = [...map.values()].filter((u) => u === userId).length;
    if (mine >= MAX_IDS_PER_USER || map.size >= MAX_IDS_PER_CALL) return 'too-many';
    map.set(participantId, userId);
    await this.store().patchSession(callId, { participants: Object.fromEntries(map) }).catch(() => undefined);
    return 'bound';
  }

  userOf(callId: string, participantId: string): string | null { return this.bindings.get(callId)?.get(participantId) ?? null; }
  private readonly bindings = new Map<string, Map<string, string>>();

  /** Pick up the record's state now (an acknowledgement, a pause, a resume). Never awaited on the request path. */
  async refresh(callId: string): Promise<void> {
    const armed = this.byCall.get(callId);
    if (armed) await this.syncGate(armed);
  }

  /** The latest read wins: a slower, older read that finishes after a newer one is thrown away. */
  private async syncGate(armed: Armed): Promise<void> {
    const seq = (armed.syncSeq += 1);
    armed.lastSync = this.clock();
    try {
      const record = await this.store().get(armed.callId);
      if (seq === armed.syncSeq) armed.gate = gateOf(record);
    } catch { /* keep the last gate; a failed read never opens it */ }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The request path (synchronous)

  /**
   * The cheap answer before a body is read: is this a live token for this channel, and may it send? Unknown, dead, wrong
   * channel and not-yet-attached all look the same ('unknown'), so a caller learns nothing about which it was.
   */
  admit(token: string, channelArn: string | undefined): Admission {
    const armed = this.lookup(token, channelArn);
    if (!armed) return 'unknown';
    const now = this.clock();
    const b = armed.bucket;
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate); b.at = now;
    if (b.tokens < 1) return 'limited';
    b.tokens -= 1;
    return 'ok';
  }

  private lookup(token: string, channelArn: string | undefined): Armed | null {
    const hash = TOKEN_RE.test(token) ? hashToken(token) : hashToken('invalid');
    const armed = TOKEN_RE.test(token) ? this.byHash.get(hash.toString('base64url')) : undefined;
    // Constant-time comparison of the digests, and of the channel, against the stored values (or a dummy of the same length).
    const stored = armed?.hash ?? Buffer.alloc(32);
    const same = timingSafeEqual(stored, hash) && !!armed;
    const want = Buffer.from(armed?.channelArn ?? '');
    const got = Buffer.from(channelArn ?? '');
    const sameChannel = want.length === got.length && timingSafeEqual(want, got);
    if (!armed || !same || !sameChannel || !this.sessions.has(armed.callId)) return null;
    return armed;
  }

  /**
   * One chunk. Everything is decided from memory; the mixer does the rest. The body is `pcm_s16le`, mono, 16 kHz, and an
   * odd trailing byte is ignored.
   */
  accept(token: string, h: { channelArn?: string; participantId?: string; sampleRate?: string; encoding?: string; channels?: string }, body: Buffer): ChunkResult {
    const armed = this.lookup(token, h.channelArn);
    const mixer = armed ? this.sessions.get(armed.callId)?.mixer : undefined;
    if (!armed || !mixer) return 'unknown';
    const c = armed.counters; c.chunks += 1; armed.dirty = true;
    if (Number(h.sampleRate) !== SINK_SAMPLE_RATE || (h.encoding ?? 'pcm_s16le') !== 'pcm_s16le' || Number(h.channels ?? 1) !== 1 || body.length < 2 || body.length > MAX_CHUNK_BYTES) return 'bad-format';
    const gate = armed.gate;
    if (!gate.listening) { c.notListeningChunks += 1; return 'not-listening'; }
    const userId = this.bindings.get(armed.callId)?.get((h.participantId ?? '').slice(0, 256));
    if (!userId) { c.unmappedChunks += 1; return 'unmapped'; }
    if (userId !== gate.invitedBy && !gate.acked.has(userId)) { c.unackedChunks += 1; return 'unacked'; }
    const placed = mixer.push(userId, body.length % 2 ? body.subarray(0, body.length - 1) : body);
    if (placed === 'late') { c.lateChunks += 1; return 'late'; }
    if (placed === 'overrun') { c.overrunChunks += 1; return 'overrun'; }
    if (placed === 'rejected') return 'bad-format';
    c.mixedChunks += 1;
    return 'mixed';
  }

  // -------------------------------------------------------------------------------------------------------------
  // The clock

  /** Emit the call's due frames, refresh its gate, flush its counters now and then. The timer calls this; tests call it with a fake clock. */
  async tick(callId?: string): Promise<void> {
    const ids = callId ? [callId] : [...this.sessions.keys()];
    for (const id of ids) {
      this.sessions.get(id)?.mixer.tick();
      const armed = this.byCall.get(id);
      if (!armed) continue;
      const now = this.clock();
      if (now - armed.lastSync >= 500) { if (callId) void this.syncGate(armed); else await this.syncGate(armed); }
      if (armed.dirty && now - armed.lastFlush >= 5000) void this.flush(armed);
    }
  }

  /** Write the counters to the record (absolute values, so a repeat is harmless). */
  async flush(armed: Armed | string): Promise<void> {
    const a = typeof armed === 'string' ? this.byCall.get(armed) : armed;
    if (!a) return;
    a.dirty = false; a.lastFlush = this.clock();
    const stats = this.sessions.get(a.callId)?.mixer.stats;
    await this.store().patchSession(a.callId, {
      unmappedChunks: a.base.unmappedChunks + a.counters.unmappedChunks,
      unackedChunks: a.base.unackedChunks + a.counters.unackedChunks,
      lateChunks: a.base.lateChunks + a.counters.lateChunks + (stats?.lateChunks ?? 0),
    }).catch(() => undefined);
  }

  /** What the mock world's dev route shows about a call's audio (never the token itself). */
  describe(callId: string): { armed: boolean; attached: boolean; channelArn: string | null; counters: AudioCounters | null; mixer: MixerStats | null; bound: Record<string, string> } {
    const armed = this.byCall.get(callId);
    const attached = this.sessions.get(callId);
    return { armed: !!armed, attached: !!attached, channelArn: armed?.channelArn ?? null, counters: armed ? { ...armed.counters } : null,
      mixer: attached ? { ...attached.mixer.stats } : null, bound: Object.fromEntries(this.bindings.get(callId) ?? []) };
  }

  countersOf(callId: string): AudioCounters | null {
    const a = this.byCall.get(callId);
    return a ? { ...a.counters } : null;
  }

  /** The call is over: forget who was who. */
  forget(callId: string): void { this.detach(callId); this.bindings.delete(callId); }

  dispose(): void { for (const id of [...this.sessions.keys()]) this.detach(id); this.bindings.clear(); }
}

export function gateOf(record: AssistantRecord | null): Gate {
  if (!record || record.state !== 'listening') return { listening: false, acked: new Set(), invitedBy: record?.invitedBy ?? '' };
  return { listening: true, acked: new Set(record.acked), invitedBy: record.invitedBy };
}

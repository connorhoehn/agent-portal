// Hands-free Milo, listening side (lane A): one transcription stream and one 10 s ring per consenting person.
//
// Fed by the mixer's per-person audio (`AudioSink.placed`, audio-intake.ts), it
//   * re-cuts each person's pieces into session frames (person-buffer.ts), writes the ring and emits `frame`, synchronously;
//   * streams those frames to that person's transcription stream only while they speak: from a voiced frame (with a short lead of
//     the frames before it) until a second of quiet after, so a quiet person costs nothing (the provider bills the audio it is
//     sent). The stream stays contiguous from its ms 0: gaps up to 1 s as silence, longer gaps skipped and remembered as a break,
//     so stream ms convert back to session ms exactly;
//   * finds Milo's name on each DELTA (`findAddress`, with the forms the provider mishears normalised first) and emits `name` once
//     per sentence, then `sentence` and `line` at the final.
// Nothing outside this file sees stream ms. Nothing here stores audio.

import { NAME_SPELLINGS, findAddress } from '../detector.js';
import { PersonRing } from './person-buffer.js';
import {
  HANDSFREE,
  type HandsfreeClock,
  type ListeningEvents,
  type ListeningSide,
  type PersonTranscriber,
  type TranscriberFactory,
} from './types.js';

/**
 * How the provider has written the name that `NAME_SPELLINGS` does not hold (the probe: "Nilo", "Nylo", and "Mylo" without the
 * keyword). Normalised to the name before `findAddress`, so its own rules (possessives, "milo grain", thanks) judge them the same.
 */
export const MISHEARD_FORMS: readonly string[] = ['nilo', 'nylo', 'milow', 'mylow', 'meelo', 'mielo'];
const MISHEARD = new RegExp(`(^|[^\\p{L}\\p{N}_])(${MISHEARD_FORMS.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
const NAME = NAME_SPELLINGS[0] ?? 'milo';
export const normaliseName = (text: string): string => text.replace(MISHEARD, (_m, pre: string, w: string) => `${pre}${w[0] === w[0]!.toUpperCase() ? NAME[0]!.toUpperCase() + NAME.slice(1) : NAME}`);

/** The keywords each stream opens with: the name's spellings, capitalised as a name. */
export const NAME_KEYWORDS: readonly string[] = NAME_SPELLINGS.map((s) => s[0]!.toUpperCase() + s.slice(1));

/**
 * Gaps in a person's audio up to this long are streamed as silence; longer ones are skipped (a break in the stream's timeline). Also
 * how much of the quiet after speech is streamed: the stream's own end-of-speech check (openai-transcribe.ts, 600 ms) must hear it.
 */
const STREAM_FILL_MS = 1_000;
/** Streaming starts this far before the first voiced frame (the frames just before it), so a soft first syllable is not cut. */
const STREAM_LEAD_MS = 300;
const LEAD_FRAMES = STREAM_LEAD_MS / HANDSFREE.frameMs;
/**
 * A person's audio this far behind the clock has stopped (the mixer places a chunk at most 400 ms late, mixer.ts `lateMs`): the tick
 * streams silence in its place, up to STREAM_FILL_MS past their last audio.
 */
const STOPPED_AFTER_MS = 500;
const SILENT_FRAME = Buffer.alloc(HANDSFREE.frameBytes);
/** While a stream opens, at most this much of the person's audio is held for it. */
const OPEN_QUEUE_MS = 2_000;
/** Speech onset: a 20 ms window over this RMS after `ONSET_QUIET_MS` of quiet starts a sentence. */
const ONSET_RMS = 300;
const ONSET_QUIET_MS = 600;
/** The sentence start reported is this much before the onset, so the first syllable is not cut. */
const ONSET_LEAD_MS = 100;
const REOPEN_DELAY_MS = 250;
const CLOSE_WAIT_MS = 2_000;

export interface ListeningOptions {
  callId: string;
  transcriber: TranscriberFactory;
  clock: HandsfreeClock;
  /**
   * Whether this person acknowledged the recording notice and allows the transcript, now. Asked at every `open` and for every
   * placed frame, so it must be cheap and synchronous; false (also for an unknown person or an unreadable answer) drops the
   * frame, and a lane that is open closes, so an acknowledgement withdrawn mid-call stops their transcription at once.
   */
  consented: (userId: string) => boolean;
  /** Epoch ms (for `HeardLine.at`). */
  epochNow?: () => number;
  /** Counts and states only: never audio, never transcript text. */
  log?: (row: Record<string, unknown>) => void;
}

interface Sentence { id: string; text: string; named: boolean; startMs: number; lastMs: number }

interface Lane {
  userId: string;
  speakerName: string;
  ring: PersonRing;
  stream: PersonTranscriber | null;
  generation: number;
  opening: boolean;
  queue: Array<{ pcm: Buffer; atMs: number }>;
  /** Breaks of the current stream: from stream ms `streamMs` on, session ms = streamMs + offset. Ascending. */
  breaks: Array<{ streamMs: number; offset: number }>;
  streamMs: number;
  /** Session ms just past the last frame streamed (the person's audio, or the tick's silence after it), or null before the first. */
  lastStreamedEnd: number | null;
  /** Session ms just past the person's last frame of audio streamed (not the tick's silence). */
  lastHeardEnd: number | null;
  /** Frames are streamed while they start before this (session ms): a second past the last voiced frame. */
  gateUntil: number;
  /** The last few frames, for the lead streamed before a voiced frame. */
  recent: Array<{ pcm: Buffer; atMs: number }>;
  sentences: Map<string, Sentence>;
  sentenceSeq: number;
  lastSentenceEndMs: number;
  onsets: number[];
  quietMs: number;
  voiced: boolean;
  reopens: number[];
  retry: unknown;
  unsubs: Array<() => void>;
  down: boolean;
}

const windowRms = (pcm: Buffer, from: number, to: number): number => {
  let sum = 0; let n = 0;
  for (let i = from; i + 1 < to; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; n += 1; }
  return n ? Math.sqrt(sum / n) : 0;
};

export function createListeningSide(opts: ListeningOptions): ListeningSide {
  const log = opts.log ?? (() => {});
  const epochNow = opts.epochNow ?? Date.now;
  const lanes = new Map<string, Lane>();
  /** People refused for no consent (at open or mid-call), by speaker name: their lane opens when the check says yes again. */
  const refused = new Map<string, string>();
  const listeners: { [K in keyof ListeningEvents]: Set<(e: ListeningEvents[K]) => void> } = {
    line: new Set(), name: new Set(), sentence: new Set(), words: new Set(), lane: new Set(), frame: new Set(),
  };
  let silenced = false;
  let closing: Promise<void> | null = null;

  const emit = <K extends keyof ListeningEvents>(type: K, e: ListeningEvents[K]): void => {
    if (silenced) return;
    for (const fn of [...listeners[type]]) {
      try { fn(e); } catch (err) { log({ event: 'listening-listener-threw', type, error: String(err).slice(0, 120) }); }
    }
  };

  const toSession = (lane: Lane, streamMs: number): number => {
    let offset = lane.breaks[0]?.offset ?? 0;
    for (const b of lane.breaks) { if (b.streamMs <= streamMs) offset = b.offset; else break; }
    return Math.round(streamMs + offset);
  };

  /** Track sentence onsets; true when any 20 ms window of the frame is voiced. */
  const trackOnset = (lane: Lane, pcm: Buffer, atMs: number): boolean => {
    const win = (HANDSFREE.sampleRate * 2) / 50;
    let any = false;
    for (let at = 0, ms = atMs; at + win <= pcm.length; at += win, ms += 20) {
      if (windowRms(pcm, at, at + win) > ONSET_RMS) {
        any = true;
        if (!lane.voiced && (lane.quietMs >= ONSET_QUIET_MS || lane.onsets.length === 0)) {
          lane.onsets.push(ms);
          if (lane.onsets.length > 32) lane.onsets.shift();
        }
        lane.voiced = true; lane.quietMs = 0;
      } else {
        lane.quietMs += 20;
        if (lane.quietMs >= ONSET_QUIET_MS) lane.voiced = false;
      }
    }
    return any;
  };

  /**
   * The frames of this one to send its stream: none while the person is quiet; at a voiced frame after quiet, the lead before it
   * (never a frame already sent); then everything until STREAM_FILL_MS past the last voiced frame.
   */
  const gate = (lane: Lane, f: { pcm: Buffer; atMs: number }, voiced: boolean): Array<{ pcm: Buffer; atMs: number }> => {
    const out: Array<{ pcm: Buffer; atMs: number }> = [];
    if (voiced) {
      if (f.atMs >= lane.gateUntil) {
        const sent = Math.max(lane.lastStreamedEnd ?? -Infinity, f.atMs - STREAM_LEAD_MS);
        for (const r of lane.recent) if (r.atMs >= sent && r.atMs < f.atMs) out.push(r);
      }
      lane.gateUntil = f.atMs + HANDSFREE.frameMs + STREAM_FILL_MS;
    }
    if (f.atMs < lane.gateUntil) out.push(f);
    lane.recent.push(f);
    if (lane.recent.length > LEAD_FRAMES) lane.recent.shift();
    return out;
  };

  /** Where a sentence first heard at `atMs` began: the latest onset at or before it, never before the last sentence's end. */
  const sentenceStart = (lane: Lane, atMs: number): number => {
    let onset: number | null = null;
    for (const o of lane.onsets) if (o <= atMs) onset = o;
    const start = onset === null ? atMs : onset - ONSET_LEAD_MS;
    return Math.max(0, Math.max(start, lane.lastSentenceEndMs));
  };

  const streamFrame = (lane: Lane, pcm: Buffer, atMs: number): void => {
    // Already streamed: the tick's silence stood in for audio that came later than the mixer allows.
    if (lane.lastStreamedEnd !== null && atMs < lane.lastStreamedEnd) return;
    if (lane.lastStreamedEnd === null) {
      lane.breaks = [{ streamMs: lane.streamMs, offset: atMs - lane.streamMs }];
    } else {
      const gap = atMs - lane.lastStreamedEnd;
      if (gap > STREAM_FILL_MS) lane.breaks.push({ streamMs: lane.streamMs, offset: atMs - lane.streamMs });
      else if (gap > 0) {
        const silence = Buffer.alloc((gap / HANDSFREE.frameMs) * HANDSFREE.frameBytes);
        lane.stream!.append(silence);
        lane.streamMs += gap;
      }
    }
    lane.stream!.append(pcm);
    lane.streamMs += HANDSFREE.frameMs;
    lane.lastStreamedEnd = atMs + HANDSFREE.frameMs;
  };

  const handleDelta = (lane: Lane, gen: number, e: { itemId: string; delta: string; streamMs: number }): void => {
    if (gen !== lane.generation || lanes.get(lane.userId) !== lane) return;
    const atMs = toSession(lane, e.streamMs);
    let s = lane.sentences.get(e.itemId);
    if (!s) {
      lane.sentenceSeq += 1;
      s = { id: `${lane.userId}:${lane.generation}:${lane.sentenceSeq}`, text: '', named: false, startMs: sentenceStart(lane, atMs), lastMs: atMs };
      lane.sentences.set(e.itemId, s);
    }
    s.text += e.delta;
    s.lastMs = atMs;
    emit('words', { userId: lane.userId, sentenceId: s.id, delta: e.delta, atMs });
    if (!s.named) {
      const hit = findAddress(normaliseName(s.text));
      if (hit?.addressed) {
        s.named = true;
        emit('name', { userId: lane.userId, sentenceStartMs: s.startMs, nameEndMs: atMs, textSoFar: s.text, sentenceId: s.id });
      }
    }
  };

  const handleFinal = (lane: Lane, gen: number, e: { itemId: string; text: string; startStreamMs: number; endStreamMs: number }): void => {
    if (gen !== lane.generation || lanes.get(lane.userId) !== lane) return;
    const endMs = toSession(lane, e.endStreamMs);
    let s = lane.sentences.get(e.itemId);
    if (!s) {
      lane.sentenceSeq += 1;
      s = { id: `${lane.userId}:${lane.generation}:${lane.sentenceSeq}`, text: '', named: false, startMs: Math.max(toSession(lane, e.startStreamMs), lane.lastSentenceEndMs), lastMs: endMs };
    }
    lane.sentences.delete(e.itemId);
    finishSentence(lane, s, e.text || s.text, endMs);
  };

  /** A sentence is over: its final, or its stream closed under it (then it ends with the words heard so far, at its last word). */
  const finishSentence = (lane: Lane, s: Sentence, said: string, endMs: number): void => {
    const text = said.trim();
    const startMs = Math.min(s.startMs, endMs);
    lane.lastSentenceEndMs = Math.max(lane.lastSentenceEndMs, endMs);
    if (!text) return;
    if (!s.named) {
      const hit = findAddress(normaliseName(text));
      if (hit?.addressed) {
        s.named = true;
        emit('name', { userId: lane.userId, sentenceStartMs: startMs, nameEndMs: endMs, textSoFar: text, sentenceId: s.id });
      }
    }
    emit('sentence', { userId: lane.userId, sentenceId: s.id, text, startMs, endMs, named: s.named });
    emit('line', {
      callId: opts.callId, userId: lane.userId, participantId: lane.userId, speakerName: lane.speakerName, text,
      at: epochNow(), captionId: `hf:${s.id}`, startMs, endMs,
    });
  };

  const setDown = (lane: Lane, reason: 'closed' | 'reopen-limit'): void => {
    lane.down = true;
    emit('lane', { userId: lane.userId, state: 'down', reason });
  };

  const scheduleReopen = (lane: Lane): void => {
    if (lanes.get(lane.userId) !== lane || closing) return;
    const now = opts.clock.nowMs();
    lane.reopens = lane.reopens.filter((t) => now - t < 60_000);
    if (lane.reopens.length >= HANDSFREE.reopenPerMinute) {
      setDown(lane, 'reopen-limit');
      const wait = 60_000 - (now - lane.reopens[0]!);
      log({ event: 'listening-reopen-limit', userId: lane.userId, waitMs: Math.round(wait) });
      lane.retry = opts.clock.setTimeout(() => { lane.retry = null; scheduleReopen(lane); }, Math.max(REOPEN_DELAY_MS, wait));
      return;
    }
    lane.reopens.push(now);
    lane.retry = opts.clock.setTimeout(() => { lane.retry = null; void connect(lane).catch(() => {}); }, REOPEN_DELAY_MS);
  };

  const connect = async (lane: Lane): Promise<void> => {
    lane.generation += 1;
    const gen = lane.generation;
    lane.opening = true;
    let stream: PersonTranscriber;
    try {
      stream = await opts.transcriber({ callId: opts.callId, userId: lane.userId, keywords: NAME_KEYWORDS });
    } catch (err) {
      lane.opening = false;
      if ((err as { config?: unknown })?.config === true) throw err;
      log({ event: 'listening-open-failed', userId: lane.userId });
      if (gen === lane.generation && lanes.get(lane.userId) === lane) { if (!lane.down) setDown(lane, 'closed'); scheduleReopen(lane); }
      return;
    }
    if (gen !== lane.generation || lanes.get(lane.userId) !== lane || closing) { void stream.close().catch(() => {}); return; }
    lane.opening = false;
    lane.stream = stream;
    lane.streamMs = 0;
    lane.lastStreamedEnd = null;
    lane.lastHeardEnd = null;
    lane.breaks = [];
    lane.sentences.clear();
    lane.unsubs.forEach((u) => u());
    lane.unsubs = [
      stream.on('delta', (e) => handleDelta(lane, gen, e)),
      stream.on('final', (e) => handleFinal(lane, gen, e)),
      stream.on('closed', (e) => {
        if (gen !== lane.generation || lanes.get(lane.userId) !== lane || closing) return;
        log({ event: 'listening-stream-closed', userId: lane.userId, error: e.error ? String(e.error).slice(0, 80) : null });
        lane.stream = null;
        // Its open sentences will never get a final from this stream: they end here, as heard.
        const open = [...lane.sentences.values()]; lane.sentences.clear();
        for (const s of open) finishSentence(lane, s, s.text, s.lastMs);
        setDown(lane, 'closed');
        scheduleReopen(lane);
      }),
    ];
    const queued = lane.queue; lane.queue = [];
    lane.down = false;
    emit('lane', { userId: lane.userId, state: 'up' });
    // Audio held while the stream opened: the newest OPEN_QUEUE_MS of it, in order.
    for (const f of queued) streamFrame(lane, f.pcm, f.atMs);
  };

  /** Fail closed: a check that throws or answers anything but true is no consent. */
  const consentedNow = (userId: string): boolean => { try { return opts.consented(userId) === true; } catch { return false; } };
  /** Close a lane: its ring, queue and stream go, and nothing it had not finalised is reported. */
  const dropLane = (userId: string, reason: 'left' | 'no-consent'): void => {
    const lane = lanes.get(userId);
    if (!lane) return;
    lanes.delete(userId);
    lane.generation += 1;
    lane.ring.clear();
    lane.queue = [];
    if (lane.retry) opts.clock.clearTimeout(lane.retry);
    lane.unsubs.forEach((u) => u());
    const s = lane.stream; lane.stream = null;
    if (s) void s.close().catch(() => {});
    emit('lane', { userId, state: 'down', reason });
  };

  const side: ListeningSide = {
    placed(userId, pcm24k, atMs) {
      if (closing) return;
      const lane = lanes.get(userId);
      if (!lane) {
        // Someone refused earlier who has acknowledged since (a new period's notice): their lane opens; this frame is not kept.
        const name = refused.get(userId);
        if (name !== undefined && consentedNow(userId)) void side.open(userId, name).catch(() => undefined);
        return;
      }
      if (!consentedNow(userId)) {
        log({ event: 'listening-no-consent', userId });
        refused.set(userId, lane.speakerName);
        dropLane(userId, 'no-consent');
        return;
      }
      for (const f of lane.ring.write(pcm24k, atMs)) {
        const voiced = trackOnset(lane, f.pcm, f.atMs);
        emit('frame', { userId, pcm: f.pcm, atMs: f.atMs });
        for (const g of gate(lane, f, voiced)) {
          if (lane.stream) { streamFrame(lane, g.pcm, g.atMs); lane.lastHeardEnd = g.atMs + HANDSFREE.frameMs; }
          else if (lane.opening) {
            lane.queue.push(g);
            while (lane.queue.length > OPEN_QUEUE_MS / HANDSFREE.frameMs) lane.queue.shift();
          }
        }
      }
    },

    async open(userId, speakerName) {
      if (closing || lanes.has(userId)) return;
      if (!consentedNow(userId)) {
        log({ event: 'listening-no-consent', userId });
        refused.set(userId, speakerName);
        emit('lane', { userId, state: 'down', reason: 'no-consent' });
        return;
      }
      refused.delete(userId);
      const lane: Lane = {
        userId, speakerName, ring: new PersonRing(), stream: null, generation: 0, opening: false, queue: [], breaks: [], streamMs: 0,
        lastStreamedEnd: null, lastHeardEnd: null, gateUntil: -Infinity, recent: [], sentences: new Map(), sentenceSeq: 0, lastSentenceEndMs: 0, onsets: [], quietMs: 0, voiced: false,
        reopens: [], retry: null, unsubs: [], down: false,
      };
      lanes.set(userId, lane);
      try {
        await connect(lane);
      } catch (err) {
        if (lanes.get(userId) === lane) lanes.delete(userId);
        throw err;
      }
    },

    closeLane(userId) { refused.delete(userId); dropLane(userId, 'left'); },

    tick() {
      if (closing) return;
      const now = opts.clock.nowMs();
      for (const lane of lanes.values()) {
        if (!lane.stream || lane.lastStreamedEnd === null || lane.lastHeardEnd === null) continue;
        // Up to a second past their last voiced frame: someone quiet when their audio stopped is sent nothing.
        const upTo = Math.min(now - STOPPED_AFTER_MS, lane.lastHeardEnd + STREAM_FILL_MS, lane.gateUntil);
        while (lane.lastStreamedEnd + HANDSFREE.frameMs <= upTo) streamFrame(lane, SILENT_FRAME, lane.lastStreamedEnd);
      }
    },

    preRoll(userId, fromMs, toMs) {
      const lane = lanes.get(userId);
      if (!lane) return [];
      return lane.ring.read(fromMs, opts.clock.nowMs() - HANDSFREE.ringMs, toMs);
    },

    on(type, fn) {
      const set = listeners[type] as Set<typeof fn>;
      set.add(fn);
      return () => { set.delete(fn); };
    },

    close() {
      if (closing) return closing;
      const streams: PersonTranscriber[] = [];
      for (const lane of lanes.values()) {
        lane.generation += 1;
        lane.ring.clear();
        if (lane.retry) opts.clock.clearTimeout(lane.retry);
        lane.unsubs.forEach((u) => u());
        if (lane.stream) streams.push(lane.stream);
        lane.stream = null;
      }
      lanes.clear();
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bounded = new Promise<void>((r) => { timer = setTimeout(r, CLOSE_WAIT_MS); (timer as { unref?: () => void }).unref?.(); });
        await Promise.race([Promise.allSettled(streams.map((s) => s.close())).then(() => {}), bounded]);
        if (timer) clearTimeout(timer);
        silenced = true;
      })();
      return closing;
    },
  };
  return side;
}

// Hands-free Milo, listening side: one person's rolling ring of their own audio, in memory only (never written, logged or traced).
//
// The mixer places a person's audio in pieces of any length at any session millisecond (mixer.ts onPlaced). The ring re-cuts them
// into the session's 100 ms frames (frame k covers [k*100, (k+1)*100)) and keeps the last `HANDSFREE.ringMs` of them. A frame is
// handed back from `write` the moment it is complete, in session order; a short gap (up to `fillGapMs`) is filled with silence so
// the person's frames stay contiguous, a longer one starts a fresh run (the ring holds no silence for a person who was away).

import { HANDSFREE } from './types.js';

const BYTES_PER_MS = (HANDSFREE.sampleRate * 2) / 1000; // 48
const FRAME_BYTES = HANDSFREE.frameBytes;
const RING_FRAMES = HANDSFREE.ringMs / HANDSFREE.frameMs;

export interface RingFrame { pcm: Buffer; atMs: number }

export class PersonRing {
  /** Frame index -> its 4,800 bytes. Only the last RING_FRAMES indices are kept. */
  private readonly frames = new Map<number, Buffer>();
  /** Session byte position of the next byte expected, or null before the first piece. */
  private cursor: number | null = null;
  /** The frame being filled (index and bytes so far), or null. */
  private partial: { idx: number; buf: Buffer; filled: number } | null = null;
  private newest = -1;

  constructor(private readonly fillGapMs = 1_000) {}

  /** Index of the newest complete frame, or -1. */
  get newestFrame(): number { return this.newest; }

  /**
   * Place one piece. Returns the frames this piece completed (silence-filled gaps included), oldest first. Bytes before the cursor
   * (audio already placed) are dropped; an odd byte is dropped.
   */
  write(pcm: Buffer, atMs: number): RingFrame[] {
    const out: RingFrame[] = [];
    if (!Number.isFinite(atMs) || atMs < 0) return out;
    let start = Math.round((atMs * BYTES_PER_MS) / 2) * 2;
    let body = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    if (this.cursor !== null) {
      if (start < this.cursor) { body = body.subarray(Math.min(body.length, this.cursor - start)); start = this.cursor; }
      if (body.length === 0) return out;
      const gap = start - this.cursor;
      if (gap > this.fillGapMs * BYTES_PER_MS) {
        // A fresh run: finish the open frame with silence, then begin again at the new piece's frame.
        if (this.partial) this.finish(out);
        this.cursor = null;
      } else if (gap > 0) {
        this.push(Buffer.alloc(gap), out);
      }
    }
    if (this.cursor === null) {
      const frameStart = Math.floor(start / FRAME_BYTES) * FRAME_BYTES;
      this.cursor = frameStart;
      this.partial = null;
      if (start > frameStart) this.push(Buffer.alloc(start - frameStart), out);
    }
    this.push(body, out);
    return out;
  }

  /**
   * Frames from `fromMs` (rounded down to a frame) through the newest complete frame, oldest first, missing frames as silence,
   * never reaching further back than `floorMs` or the ring. Copies.
   */
  read(fromMs: number, floorMs = -Infinity): Buffer[] {
    if (this.newest < 0) return [];
    const lowest = Math.max(this.newest - RING_FRAMES + 1, 0, Number.isFinite(floorMs) ? Math.ceil(floorMs / HANDSFREE.frameMs) : 0);
    const from = Math.max(Math.floor(Math.max(0, fromMs) / HANDSFREE.frameMs), lowest);
    const out: Buffer[] = [];
    for (let i = from; i <= this.newest; i += 1) {
      const f = this.frames.get(i);
      out.push(f ? Buffer.from(f) : Buffer.alloc(FRAME_BYTES));
    }
    return out;
  }

  /** Drop everything at once (the person left or the lane closed). */
  clear(): void {
    this.frames.clear();
    this.cursor = null;
    this.partial = null;
    this.newest = -1;
  }

  private push(bytes: Buffer, out: RingFrame[]): void {
    let at = 0;
    while (at < bytes.length) {
      if (!this.partial) {
        const idx = Math.floor((this.cursor ?? 0) / FRAME_BYTES);
        this.partial = { idx, buf: Buffer.alloc(FRAME_BYTES), filled: (this.cursor ?? 0) - idx * FRAME_BYTES };
      }
      const p = this.partial;
      const n = Math.min(FRAME_BYTES - p.filled, bytes.length - at);
      bytes.copy(p.buf, p.filled, at, at + n);
      p.filled += n;
      at += n;
      this.cursor = (this.cursor ?? 0) + n;
      if (p.filled === FRAME_BYTES) this.complete(out);
    }
  }

  /** Pad the open frame with silence and complete it. */
  private finish(out: RingFrame[]): void {
    const p = this.partial;
    if (!p) return;
    this.cursor = (p.idx + 1) * FRAME_BYTES;
    p.filled = FRAME_BYTES;
    this.complete(out);
  }

  private complete(out: RingFrame[]): void {
    const p = this.partial!;
    this.partial = null;
    this.frames.set(p.idx, p.buf);
    if (p.idx > this.newest) this.newest = p.idx;
    for (const k of this.frames.keys()) if (k <= this.newest - RING_FRAMES) this.frames.delete(k);
    out.push({ pcm: p.buf, atMs: p.idx * HANDSFREE.frameMs });
  }
}

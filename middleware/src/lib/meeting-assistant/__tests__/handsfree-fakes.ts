// Fakes of the hands-free lanes' interfaces (types.ts) for lane B's tests: a fake clock, a scripted listening side, scripted rules,
// and a recording talking side and relay. No audio leaves memory; frames are tagged by their fill byte (one byte per person).
import { HANDSFREE, type Admission, type HandsfreeClock, type HandsfreeRules, type ListeningEvents, type ListeningSide, type OverlapVerdict, type TalkingSide, type TriggerVerdict } from '../handsfree/types.js';

export class FakeClock implements HandsfreeClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private next = 1;
  nowMs(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.next++; this.timers.push({ at: this.t + Math.max(0, ms), fn, id }); return id; }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter((x) => x.id !== h); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (!due || due.at > end) break;
      this.timers.shift();
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

export const frame = (tag: number): Buffer => Buffer.alloc(HANDSFREE.frameBytes, tag);
export const tagOf = (b: Buffer): number => b[0] ?? 0;

export class FakeListening implements Pick<ListeningSide, 'preRoll' | 'on' | 'placed' | 'open' | 'closeLane' | 'close'> {
  private readonly ls = new Map<string, Set<(e: never) => void>>();
  /** Per person, frames by their session ms. */
  readonly rings = new Map<string, Map<number, Buffer>>();
  readonly opened: string[] = [];
  readonly closedLanes: string[] = [];
  closed = false;
  constructor(private readonly clock: FakeClock) {}
  on<K extends keyof ListeningEvents>(type: K, fn: (e: ListeningEvents[K]) => void): () => void {
    const set = this.ls.get(type) ?? new Set(); set.add(fn as (e: never) => void); this.ls.set(type, set);
    return () => { set.delete(fn as (e: never) => void); };
  }
  emit<K extends keyof ListeningEvents>(type: K, e: ListeningEvents[K]): void { for (const fn of [...(this.ls.get(type) ?? [])]) (fn as (x: ListeningEvents[K]) => void)(e); }
  /** One person's 100 ms frame at the current time: into the ring, then the `frame` event. */
  speak(userId: string, tag: number): void {
    const at = Math.floor(this.clock.nowMs() / 100) * 100;
    const pcm = frame(tag);
    const ring = this.rings.get(userId) ?? new Map(); ring.set(at, pcm); this.rings.set(userId, ring);
    this.emit('frame', { userId, pcm, atMs: at });
  }
  placed(userId: string, pcm: Buffer, atMs: number): void { this.emit('frame', { userId, pcm, atMs }); }
  async open(userId: string): Promise<void> { this.opened.push(userId); }
  closeLane(userId: string): void { this.closedLanes.push(userId); }
  preRoll(userId: string, fromMs: number, toMs = Infinity): Buffer[] {
    const ring = this.rings.get(userId);
    if (!ring) return [];
    const now = this.clock.nowMs();
    const out: Buffer[] = [];
    for (let at = Math.max(Math.floor(fromMs / 100) * 100, now - HANDSFREE.ringMs); at <= now && at < toMs; at += 100) { const f = ring.get(at); if (f) out.push(f); }
    return out;
  }
  async close(): Promise<void> { this.closed = true; }
}

export class FakeRules implements HandsfreeRules {
  admission = new Map<string, Admission>();
  verdictFor: (s: { userId: string; text: string; via: 'name' | 'follow-up' }) => TriggerVerdict | Promise<TriggerVerdict> = () => ({ kind: 'request' });
  overlapFor: (heard: string, saying: string) => OverlapVerdict = () => 'barge-in';
  readonly verdicts: Array<{ userId: string; text: string; via: string }> = [];
  async admit(_call: unknown, userId: string): Promise<Admission> { return this.admission.get(userId) ?? 'route'; }
  async verdict(_call: unknown, s: { userId: string; text: string; via: 'name' | 'follow-up' }): Promise<TriggerVerdict> { this.verdicts.push(s); return this.verdictFor(s); }
  overlap(heard: string, saying: string): OverlapVerdict { return this.overlapFor(heard, saying); }
}

export class FakeTalking implements Pick<TalkingSide, 'feed' | 'setAsker' | 'say'> {
  /** Each tick's frames, in order. */
  readonly ticks: Buffer[][] = [];
  asker: string | null = null;
  /** The asker is routed but not judged yet (tool calls wait). */
  pending = false;
  readonly askers: Array<string | null> = [];
  readonly said: string[] = [];
  feed(frames: readonly Buffer[]): void { this.ticks.push([...frames]); }
  setAsker(userId: string | null, pending = false): void { this.asker = userId; this.pending = pending; this.askers.push(userId); }
  say(_id: string, text: string): boolean { this.said.push(text); return true; }
  /** Every frame the session heard so far, as tags (0 = silence). */
  heard(): number[] { return this.ticks.flat().map(tagOf); }
}

export class FakeRelay {
  readonly pushed: Array<{ tag: number; last: boolean }> = [];
  clears = 0;
  push(pcm: Buffer, last: boolean): void { this.pushed.push({ tag: tagOf(pcm), last }); }
  clear(): void { this.clears += 1; }
}

/** Let the router's awaited admission and verdict promises settle. */
export const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

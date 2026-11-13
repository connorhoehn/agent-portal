// Caption intake: attributed captions from the source -> the rules for storing a line -> the
// detector -> pending requests and spoken commands (docs/meeting-assistant-design.md, decisions 4, 8, 9).
//
// A caption is stored only when ALL of these hold:
//   * an assistant record exists for the call and its state is `listening` (paused, left, never invited: nothing stored);
//   * the speaker is the inviter, or has acknowledged the transcription notice (POST .../assistant/ack).
//     Everyone else who is or was seated, including people already present when the invite was sent, owes
//     an ack first. An un-acked speaker's caption is dropped whole: not stored, not shown to the detector;
//   * it has words (whitespace collapsed, empty dropped, capped at MAX_LINE_CHARS) and its captionId is new.
// Filler slivers ("Thank you.") ARE stored; the detector is what ignores them.
//
// Detector output is applied here: a request is added to the record's pending queue, a pause or dismiss
// command is applied to the state as the speaker who said it.
import { createHash } from 'node:crypto';
import { transcriptSource, type TranscriptSource, type Unsubscribe } from './transcript-source.js';
import { RequestDetector, type DetectorEvent } from './detector.js';
import { MAX_LINE_CHARS, type AssistantStore } from './store.js';
import type { AssistantRecord, RawLine, TranscriptLine } from './types.js';

export type IntakeOutcome =
  | { stored: TranscriptLine; events: DetectorEvent[] }
  | { stored: null; reason: 'no-assistant' | 'not-listening' | 'not-acknowledged' | 'empty' | 'duplicate'; events: [] };

export interface IntakeOptions {
  clock?: () => number;
  /** How often open requests are checked for their quiet time; 0 turns the timer off (tests call `tick`). */
  tickMs?: number;
  source?: () => TranscriptSource;
}

export const canSpeakOnRecord = (record: AssistantRecord, userId: string): boolean =>
  userId === record.invitedBy || record.acked.includes(userId);

export function captionIdFor(callId: string, c: RawLine, at: number): string {
  return c.captionId?.trim() || createHash('sha1').update(`${callId}|${c.userId}|${at}|${c.text}`).digest('hex').slice(0, 24);
}

export class LineIntake {
  private readonly detectors = new Map<string, RequestDetector>();
  private readonly subscriptions = new Map<string, Unsubscribe>();
  private readonly clock: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly source: () => TranscriptSource;
  private readonly listeners = new Set<(callId: string, events: DetectorEvent[]) => void | Promise<void>>();

  constructor(private readonly store: AssistantStore, opts: IntakeOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.tickMs = opts.tickMs ?? 250;
    this.source = opts.source ?? transcriptSource;
  }

  /** Begin listening on the call's caption stream. Throws TranscriptSourceNotConfigured when there is no source. */
  start(callId: string): void {
    if (this.subscriptions.has(callId)) return;
    this.subscriptions.set(callId, this.source().subscribe(callId, async (id, caption) => { await this.handle(id, caption); }));
    if (!this.detectors.has(callId)) this.detectors.set(callId, new RequestDetector(callId, this.clock));
    if (!this.timer && this.tickMs > 0) {
      this.timer = setInterval(() => { void this.tick().catch((e: unknown) => console.warn('[meeting-assistant] tick failed', e)); }, this.tickMs);
      this.timer.unref?.();
    }
  }

  stop(callId: string): void {
    this.subscriptions.get(callId)?.();
    this.subscriptions.delete(callId);
    this.detectors.delete(callId);
    if (!this.subscriptions.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  isListening(callId: string): boolean { return this.subscriptions.has(callId); }
  dispose(): void { for (const id of [...this.subscriptions.keys()]) this.stop(id); }

  async handle(callId: string, raw: RawLine): Promise<IntakeOutcome> {
    const record = await this.store.get(callId);
    if (!record) return { stored: null, reason: 'no-assistant', events: [] };
    if (record.state !== 'listening') return { stored: null, reason: 'not-listening', events: [] };
    // A piece nobody was voiced for (userId null) has no one to hold an acknowledgement; only acknowledged audio is mixed in.
    if (raw.userId !== null && !canSpeakOnRecord(record, raw.userId)) {
      await this.store.attend(callId, raw.userId);
      return { stored: null, reason: 'not-acknowledged', events: [] };
    }
    const text = raw.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);
    if (!text) return { stored: null, reason: 'empty', events: [] };
    const at = Number.isFinite(raw.at) ? Number(raw.at) : this.clock();
    const stored = await this.store.appendLine({
      callId, userId: raw.userId, participantId: raw.participantId ?? '', speakerName: raw.speakerName?.trim() || raw.userId || '',
      text, at, captionId: captionIdFor(callId, { ...raw, text }, at),
      ...(Number.isFinite(raw.startMs) ? { startMs: Number(raw.startMs) } : {}),
      ...(Number.isFinite(raw.endMs) ? { endMs: Number(raw.endMs) } : {}),
      ...(raw.speakers?.length ? { speakers: [...new Set(raw.speakers.filter((x) => typeof x === 'string' && x))].slice(0, 16) } : {}),
    });
    if (!stored) return { stored: null, reason: 'duplicate', events: [] };
    const detector = this.detectors.get(callId) ?? this.newDetector(callId);
    const events = detector.push(stored);
    await this.apply(callId, events);
    return { stored, events };
  }

  /** Close requests whose quiet time has passed, for every call being listened to. */
  async tick(): Promise<DetectorEvent[]> {
    const all: DetectorEvent[] = [];
    for (const [callId, detector] of this.detectors) {
      const events = detector.tick();
      if (events.length) { await this.apply(callId, events); all.push(...events); }
    }
    return all;
  }

  private newDetector(callId: string): RequestDetector {
    const d = new RequestDetector(callId, this.clock);
    this.detectors.set(callId, d);
    return d;
  }

  /** Hear what the detector decided, after the intake has applied it (requests queued, pause and dismiss done). */
  onEvents(listener: (callId: string, events: DetectorEvent[]) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async apply(callId: string, events: DetectorEvent[]): Promise<void> {
    await this.applyEvents(callId, events);
    if (!events.length) return;
    for (const l of [...this.listeners]) {
      try { await l(callId, events); } catch (e) { console.warn('[meeting-assistant] intake listener failed', (e as Error).message); }
    }
  }

  private async applyEvents(callId: string, events: DetectorEvent[]): Promise<void> {
    for (const e of events) {
      if (e.type === 'request') {
        await this.store.addRequest(callId, { id: `rq-${e.lines[0]}-${e.lines[e.lines.length - 1]}`, askedBy: e.askedBy, text: e.text,
          lines: e.lines, startedAt: e.startedAt, endedAt: e.endedAt });
      } else if (e.type === 'command') {
        const change = e.command === 'pause'
          ? { from: ['listening'] as const, to: 'paused' as const }
          : { from: ['invited', 'listening', 'paused'] as const, to: 'left' as const };
        const done = await this.store.transition(callId, { ...change, by: e.by, at: this.clock() });
        if (done) {
          // Nothing half-heard carries across a pause, and a dismissed assistant stops listening altogether.
          this.detectors.set(callId, new RequestDetector(callId, this.clock));
          if (e.command === 'dismiss') this.stop(callId);
        }
      }
    }
  }
}

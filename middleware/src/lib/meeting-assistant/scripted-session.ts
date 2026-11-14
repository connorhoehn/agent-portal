// The mock world's stand-in for the live model (docs/meeting-assistant-design.md, decision 12): no audio, no model,
// no network. The orchestrator hands it each request the detector found, WITH the person who asked (the server's own
// record of who spoke, never anything the session says), and it answers by a small rule table, so walks and tests
// need no provider. Usage is the seconds it was open, so the ledger shows a realistic entry.
import { OUTPUT_FRAME_BYTES, OUTPUT_TAIL_FRAMES } from './live-session.js';
import {
  SessionEmitter, type LiveMeetingSession, type SessionStartInput,
} from './session.js';

export type ScriptStep =
  | { say: string }
  | { call: { name: string; args: Record<string, unknown> } };

export interface ScriptRule {
  id: string;
  /** Matched against the request with its end punctuation and a leading "please" removed. */
  match: RegExp;
  run(m: RegExpMatchArray): ScriptStep;
}

export const SCRIPT_FALLBACK = 'I can help with work items, search and budgets in this walk.';

/** The whole rule table; first match wins. Exported so tests and the journey read the same rules. */
export const SCRIPT_RULES: readonly ScriptRule[] = [
  { id: 'arithmetic', match: /^what(?:'s| is) (?:two|2) plus (?:two|2)$/i, run: () => ({ say: 'Four.' }) },
  {
    // The catalogue's work-item form takes a title, an initiative and a type; there is no assignee field, so a spoken
    // "assign it to …" is dropped here the way the real model would have to drop it.
    id: 'create-work-item', match: /^create a work item for (.+?)(?: and assign it to (.+))?$/i,
    run: (m) => ({ call: { name: 'create', args: { kind: 'work-item', fields: { title: m[1]!.trim().slice(0, 200) } } } }),
  },
  {
    id: 'budget', match: /^(?:how much (?:budget|money) do i have(?: left)?|what(?:'s| is) my budget|how much (?:have i|did i) spen[dt](?: this month)?)$/i,
    run: () => ({ call: { name: 'budget', args: { scope: 'me' } } }),
  },
  { id: 'search', match: /^(?:find|search for|search) (.+)$/i, run: (m) => ({ call: { name: 'search', args: { query: m[1]!.trim().slice(0, 200) } } }) },
];

export function scriptFor(text: string): ScriptStep {
  const t = text.trim().replace(/[.!?\s]+$/, '').replace(/^please[,\s]+/i, '').trim();
  for (const rule of SCRIPT_RULES) {
    const m = rule.match.exec(t);
    if (m) return rule.run(m);
  }
  return { say: SCRIPT_FALLBACK };
}

/** What the scripted model says once a tool result comes back; it never repeats the data. */
export function scriptedSpeech(output: string): string {
  let parsed: unknown = null;
  try { parsed = JSON.parse(output); } catch { /* plain text */ }
  const o = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  if (o['status'] === 'waiting_for_confirmation') return `I have asked ${typeof o['person'] === 'string' ? o['person'] : 'the person who asked'} to confirm.`;
  if (typeof o['refused'] === 'string') return 'I cannot do that here.';
  if (typeof o['error'] === 'string') return 'I could not get that.';
  return 'Here is the result.';
}

/** The synthetic "voice" of the scripted session: 600 ms of a 440 Hz sine at low level, in 100 ms frames, then the 300 ms silent tail. */
export const SCRIPT_TONE_FRAMES = 6;
export function scriptToneFrames(): Buffer[] {
  const perFrame = OUTPUT_FRAME_BYTES / 2;
  const frames: Buffer[] = [];
  for (let f = 0; f < SCRIPT_TONE_FRAMES + OUTPUT_TAIL_FRAMES; f += 1) {
    const buf = Buffer.alloc(OUTPUT_FRAME_BYTES);
    if (f < SCRIPT_TONE_FRAMES) {
      for (let i = 0; i < perFrame; i += 1) buf.writeInt16LE(Math.round(2000 * Math.sin((2 * Math.PI * 440 * (f * perFrame + i)) / 24_000)), i * 2);
    }
    frames.push(buf);
  }
  return frames;
}

export class ScriptedSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'scripted' as const;
  readonly acceptsText = true;
  /** Everything the orchestrator sent as silent context, for tests. */
  readonly contexts: string[] = [];
  startInput: SessionStartInput | null = null;
  private readonly open = new Set<string>();
  private startedAt = 0;
  private ended = false;
  private seq = 0;
  private audioSeq = 0;

  constructor(private readonly clock: () => number = Date.now) { super(); }

  async start(input: SessionStartInput): Promise<void> {
    this.startInput = input;
    this.startedAt = this.clock();
  }

  appendAudio(): void { /* the scripted session never hears anything */ }

  sendText(userId: string, text: string): void {
    if (this.ended) return;
    const step = scriptFor(text);
    queueMicrotask(() => {
      if (this.ended) return;
      if ('say' in step) { this.speak(step.say); return; }
      this.emitToolCall(userId, step.call.name, step.call.args);
    });
  }

  /** A spoken reply: its words, then the synthetic tone so a walk or a test can watch the relay with no provider. */
  private speak(text: string, inReplyTo?: string): void {
    this.emit('outputTranscript', { text, final: true, ...(inReplyTo ? { inReplyTo } : {}) });
    const frames = scriptToneFrames();
    frames.forEach((pcm, i) => {
      if (this.ended) return;
      this.audioSeq += 1;
      this.emit('outputAudio', { pcm, seq: this.audioSeq, ...(i === frames.length - 1 ? { last: true as const } : {}) });
    });
  }

  /** A tool call the way the backend would raise it, attributed by the caller (the orchestrator's own record of who asked). */
  emitToolCall(askedBy: string, name: string, args: unknown): string {
    this.seq += 1;
    const callId = `sc_${this.seq}`;
    this.open.add(callId);
    this.emit('delegation', { atMs: this.clock() - this.startedAt });
    this.emit('toolCall', { callId, name, args, atMs: this.clock() - this.startedAt, askedBy });
    return callId;
  }

  answerToolCall(callId: string, output: string): boolean {
    if (this.ended || !this.open.delete(callId)) return false;
    const text = scriptedSpeech(output);
    queueMicrotask(() => { if (!this.ended) this.speak(text, callId); });
    return true;
  }

  appendContext(text: string): boolean {
    if (this.ended) return false;
    this.contexts.push(text);
    return true;
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.open.clear();
    this.emit('usage', { seconds: Math.max(0, Math.floor((this.clock() - this.startedAt) / 1000)) });
    this.emit('closed', { reason: 'close_requested' });
  }
}

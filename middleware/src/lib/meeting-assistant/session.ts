// The live session the meeting assistant listens through (docs/meeting-assistant-design.md, decisions 1, 3, 11, 12).
//
// ONE interface, two implementations: `OpenAiLiveSession` (live-session.ts, the provider's WebSocket) and
// `ScriptedSession` (scripted-session.ts, the mock world's rule table, no model, no audio). The orchestrator
// (orchestrator.ts) talks only to this interface, so every rule that matters (who asked, the name lock, the role
// check, the single answer to each tool call) lives there and holds for both.
//
// Trust. Everything a session emits is data from a model or a provider: transcript text, a tool name and its
// arguments. None of it names a person except `toolCall.askedBy`, which only the scripted session sets, from the
// `userId` the SERVER gave `sendText`. The real session never sets it; the orchestrator works the asker out itself.
import type { ResponsesFunctionTool } from '../voice/catalogue.js';

export interface SessionStartInput {
  /** What the voice is told (the front model). */
  instructions: string;
  /** The catalogue the delegation backend may call (the union for the call's tenant; the server filters per asker). */
  tools: readonly ResponsesFunctionTool[];
  /** What the delegation backend is told. */
  backendInstructions: string;
}

export interface BackendTokens { inputTokens: number; outputTokens: number; cachedTokens: number }

export interface SessionEvents {
  /** One piece of what the call said, with its offsets on the session's own timeline (ms since `start`). */
  inputTranscript: { text: string; startMs: number; endMs: number };
  /** What Nova said. `final: false` is the text so far; `final: true` ends the piece. */
  outputTranscript: { text: string; final: boolean; /** For a final utterance: when it began and when its last word arrived, in ms on the session timeline (the same clock as a tool call's `atMs`). */ startedAt?: number; endedAt?: number; /** The model call this speech continues, when the session can say exactly (the scripted one can; the provider's transcript events carry no id). */ inReplyTo?: string };
  /** The delegation backend called a function. `atMs` is the session timeline when it arrived. */
  toolCall: { callId: string; name: string; args: unknown; atMs: number; askedBy?: string };
  /** The model handed a request to the backend (it speaks a short acknowledgement about now). */
  delegation: { atMs: number };
  /** Cumulative seconds the session has run, and the backend tokens so far when the provider reported them. */
  usage: { seconds: number; backendTokens?: BackendTokens; /** True when `seconds` is the server's own wall-clock estimate (an unexpected close). */ estimated?: boolean };
  /** What Nova said aloud: PCM16 mono 24 kHz, at most 100 ms, VOICED frames only (silence is dropped at the source). `seq` counts frames from 1 per session. Never stored or logged. */
  outputAudio: { pcm: Buffer; seq: number; /** True on the final frame of an utterance (the end of the tail after the last voiced frame). */ last?: true };
  /** The provider told us when the session ends (epoch ms). */
  expires: { atMs: number };
  closed: { reason: string };
  error: { message: string };
}
export type SessionEventName = keyof SessionEvents;
export type SessionListener<K extends SessionEventName> = (event: SessionEvents[K]) => void;

export class SessionTextUnsupported extends Error {
  constructor() { super('This session cannot take a typed request; the spoken path is the only one'); this.name = 'SessionTextUnsupported'; }
}

export interface LiveMeetingSession {
  readonly kind: 'openai' | 'scripted';
  /** True when `sendText` works. The real session cannot (no text input event is documented). */
  readonly acceptsText: boolean;
  start(input: SessionStartInput): Promise<void>;
  /** 24 kHz mono 16-bit PCM, as the provider takes it. Ignored by the scripted session. */
  appendAudio(pcm24kMono: Buffer): void;
  /** A typed request from `userId`. Throws SessionTextUnsupported when `acceptsText` is false. */
  sendText(userId: string, text: string): void;
  /** The result of a tool call. True when it was sent; false when the call was unknown, already answered, or the session is closed. */
  answerToolCall(callId: string, output: string): boolean;
  /** Silent context for the model ("the card was declined"). False when the session cannot take it. */
  appendContext(text: string): boolean;
  /** Ends the session, resolving once `closed` has been emitted (or a bounded wait passed). Idempotent. */
  close(): Promise<void>;
  on<K extends SessionEventName>(type: K, listener: SessionListener<K>): () => void;
}

/** The tiny typed emitter both sessions use. A listener that throws never stops the others. */
export class SessionEmitter {
  private readonly listeners = new Map<string, Set<(e: never) => void>>();

  on<K extends SessionEventName>(type: K, listener: SessionListener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (e: never) => void);
    this.listeners.set(type, set);
    return () => { set.delete(listener as (e: never) => void); };
  }

  protected emit<K extends SessionEventName>(type: K, event: SessionEvents[K]): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) {
      try { (l as SessionListener<K>)(event); } catch (e) { console.warn(`[meeting-assistant] session listener for ${type} threw`, (e as Error).message); }
    }
  }
}

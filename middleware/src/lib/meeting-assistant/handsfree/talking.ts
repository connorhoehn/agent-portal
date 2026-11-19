// Hands-free Milo: the talking side (types.ts `TalkingSide`). The live session wrapped so it hears only what the router feeds it,
// and so every tool call it emits names the routed person as `askedBy` (null: none, which the orchestrator refuses as unasked).
//
// It is also a `LiveMeetingSession`, so the orchestrator wires it exactly as it wires the session today (events, answers, usage);
// only two things differ: `appendAudio` (the room mix) is dropped, since the router's `feed` is the only way audio reaches the
// session, and `toolCall.askedBy` is the server's own record of who was routed, never the session's.
import { SessionEmitter, type LiveMeetingSession, type SessionEventName, type SessionEvents, type SessionStartInput } from '../session.js';
import type { TalkingSide } from './types.js';

const EVENTS: readonly SessionEventName[] = ['inputTranscript', 'outputTranscript', 'toolCall', 'delegation', 'delegationReady', 'messageReady', 'usage', 'outputAudio', 'expires', 'closed', 'error'];

export class HandsfreeTalking extends SessionEmitter implements LiveMeetingSession, TalkingSide {
  private asker: string | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(readonly inner: LiveMeetingSession) {
    super();
    for (const type of EVENTS) {
      this.offs.push(inner.on(type, ((e: SessionEvents[typeof type]) => this.forward(type, e)) as never));
    }
  }

  get kind(): LiveMeetingSession['kind'] { return this.inner.kind; }
  get acceptsText(): boolean { return this.inner.acceptsText; }
  get providerErrors(): LiveMeetingSession['providerErrors'] { return this.inner.providerErrors; }

  private forward<K extends SessionEventName>(type: K, e: SessionEvents[K]): void {
    if (type === 'toolCall') {
      const { askedBy: _theirs, ...call } = e as SessionEvents['toolCall'];
      this.emit('toolCall', this.asker ? { ...call, askedBy: this.asker } : call);
      return;
    }
    this.emit(type, e);
  }

  // TalkingSide ----------------------------------------------------------------------------------------------------------------

  feed(frames: readonly Buffer[]): void {
    for (const f of frames) { try { this.inner.appendAudio(f); } catch { /* the close handler reports it */ } }
  }

  say(id: string, text: string, ended: (transcript: string | null) => void): boolean {
    return this.inner.sayVerbatim?.(id, text, ended) ?? false;
  }

  setAsker(userId: string | null): void { this.asker = userId; }
  currentAsker(): string | null { return this.asker; }

  // LiveMeetingSession ---------------------------------------------------------------------------------------------------------

  start(input: SessionStartInput): Promise<void> { return this.inner.start(input); }
  /** The room mix: never reaches a hands-free session (only `feed` does). */
  appendAudio(_pcm: Buffer): void { /* dropped */ }
  sendText(userId: string, text: string): void { this.inner.sendText(userId, text); }
  answerToolCall(callId: string, output: string, opts?: { continue?: boolean }): boolean { return this.inner.answerToolCall(callId, output, opts); }
  resumeTools(): void { this.inner.resumeTools?.(); }
  appendContext(text: string): boolean { return this.inner.appendContext(text); }
  sayVerbatim(id: string, text: string, ended: (transcript: string | null) => void, sent?: () => void): boolean {
    return this.inner.sayVerbatim?.(id, text, ended, sent) ?? false;
  }
  cancelSay(id: string): void { this.inner.cancelSay?.(id); }
  pendingInputText(): string { return this.inner.pendingInputText(); }

  async close(): Promise<void> {
    try { await this.inner.close(); } finally { for (const off of this.offs.splice(0)) off(); }
  }
}

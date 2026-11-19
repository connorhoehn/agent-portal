// Hands-free Milo: one call's run (types.ts `HandsfreeRun`). Wires the listening side (lane A), the rules (lane C), the router and
// the talking side together; the orchestrator holds one of these per hands-free call and hands it the session's events.
//
//   sink.placed ─► listening ─(frame, name, words, sentence)─► router ─(feed)─► talking ─► provider
//   sink.append ─► router.tick (the 100 ms clock; the room mix itself is dropped)
//   listening 'line' ─► onLine (the orchestrator stores it; the coach and minutes read the rows unchanged)
//   session outputAudio / outputTranscript / turn end ─► router ─► relay
import { Router, type RelayPort } from './router.js';
import type { HandsfreeClock, HandsfreeRules, HandsfreeRun, HeardLine, HoldResult, ListeningSide, RouteState, RouterEvents, TalkingSide } from './types.js';
import type { PolicyCall } from '../policy.js';

export interface HandsfreeRuntimeDeps {
  call: PolicyCall;
  clock: HandsfreeClock;
  listening: ListeningSide;
  rules: HandsfreeRules;
  talking: TalkingSide;
  relay: RelayPort;
  /** A finished line with its exact speaker: the orchestrator assigns `seq` and stores it. */
  onLine: (line: HeardLine) => void;
  /** A person's display name, for their lane (the first audio of someone not yet joined opens one). */
  nameOf: (userId: string) => Promise<string>;
  trace?: (event: string, data: Record<string, unknown>) => void;
}

export class HandsfreeRuntime implements HandsfreeRun {
  readonly router: Router;
  readonly sink: HandsfreeRun['sink'];
  private readonly joined = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private closing: Promise<void> | null = null;

  constructor(private readonly deps: HandsfreeRuntimeDeps) {
    this.router = new Router({ clock: deps.clock, call: deps.call, rules: deps.rules, listening: deps.listening, talking: deps.talking, relay: deps.relay, ...(deps.trace ? { trace: deps.trace } : {}) });
    this.offs.push(deps.listening.on('line', (l) => { if (!this.closing) deps.onLine(l); }));
    this.sink = {
      append: () => { if (!this.closing) this.router.tick(); },
      placed: (userId, pcm, atMs) => {
        if (this.closing) return;
        // Audio exists only for people who acknowledged the notice: the first piece of someone new opens their lane.
        if (!this.joined.has(userId)) { this.joined.add(userId); void deps.nameOf(userId).catch(() => userId).then((name) => this.open(userId, name)); }
        deps.listening.placed(userId, pcm, atMs);
      },
    };
  }

  state(): RouteState { return this.router.state(); }
  on<K extends keyof RouterEvents>(type: K, fn: (e: RouterEvents[K]) => void): () => void { return this.router.on(type, fn); }

  holdPress(userId: string): Promise<HoldResult> {
    if (this.closing) return Promise.resolve({ ok: false, reason: 'not-running' });
    return this.router.holdPress(userId);
  }
  holdRelease(userId: string): void { this.router.holdRelease(userId); }
  holdCancel(userId: string): void { this.router.holdCancel(userId); }

  say(id: string, text: string, ended: (transcript: string | null) => void): boolean {
    if (this.closing) return false;
    return this.deps.talking.say(id, text, ended);
  }

  personJoined(userId: string, speakerName: string): void {
    if (this.closing) return;
    this.joined.add(userId);
    this.open(userId, speakerName);
  }

  personLeft(userId: string): void {
    this.joined.delete(userId);
    this.deps.listening.closeLane(userId);
    this.router.personLeft(userId);
  }

  // The session's events (the orchestrator forwards them) ---------------------------------------------------------------------

  /** The provider closed the routed person's turn (an input transcript that ended it, or a delegation). */
  turnEnded(): void { this.router.turnEnded(); }
  outputAudio(pcm: Buffer, last: boolean, say?: string): void { this.router.outputAudio(pcm, last, say); }
  outputText(text: string): void { this.router.outputText(text); }

  close(): Promise<void> {
    this.closingAll ??= Promise.allSettled([this.closeListening(), this.deps.talking.close()]).then(() => undefined);
    return this.closingAll;
  }
  private closingAll: Promise<void> | null = null;

  /** Stop routing and close the listening side, leaving the talking side (the orchestrator's session) to its owner. Idempotent. */
  closeListening(): Promise<void> {
    if (!this.closing) {
      this.router.close();
      for (const off of this.offs.splice(0)) off();
      this.closing = this.deps.listening.close().catch(() => undefined);
    }
    return this.closing;
  }

  private open(userId: string, name: string): void {
    if (this.closing || !this.joined.has(userId)) return;
    this.deps.listening.open(userId, name).catch((e: unknown) => this.deps.trace?.('hf.lane.error', { userId, error: (e as Error).name }));
  }
}

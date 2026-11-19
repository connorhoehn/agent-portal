// Hands-free Milo: one call's run (types.ts `HandsfreeRun`). Wires the listening side (lane A), the rules (lane C), the router and
// the talking side together; the orchestrator holds one of these per hands-free call and hands it the session's events.
//
//   sink.placed ─► listening ─(frame, name, words, sentence)─► router ─(feed)─► talking ─► provider
//   sink.append ─► router.tick (the 100 ms clock; the room mix itself is dropped)
//   listening 'line' ─► onLine (the orchestrator stores it; the coach and minutes read the rows unchanged)
//   session outputAudio / outputTranscript / turn end ─► router ─► relay
import { Router, type RelayPort } from './router.js';
import { HANDSFREE, type HandsfreeClock, HandsfreeRules, HandsfreeRun, HeardLine, HoldResult, ListeningSide, RouteState, RouterEvents, TalkingSide } from './types.js';
import type { PolicyCall } from '../policy.js';

/**
 * Idle (nobody routed), the router feeds the session quiet once a replay's lead is paid back. The session needs only enough of it to
 * close a turn it may still hold open (a dropped mention); after that it is fed one frame per keepalive interval. The session bills
 * by the minute of its life either way (probe: fed nothing, muted or silence alike), so this saves the socket, not the price.
 */
const IDLE_QUIET_MS = 2_000;
const IDLE_KEEPALIVE_MS = 10_000;

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
  /** A fixed verdict's server line (router.ts `RouterDeps.sayFixed`). */
  sayFixed?: (userId: string, line: string) => void;
  /** The session is working on a request (router.ts `RouterDeps.working`). */
  working?: () => boolean;
  trace?: (event: string, data: Record<string, unknown>) => void;
}

export class HandsfreeRuntime implements HandsfreeRun {
  readonly router: Router;
  readonly sink: HandsfreeRun['sink'];
  private readonly joined = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private closing: Promise<void> | null = null;
  /** Quiet fed in the current idle stretch (ms), and when a frame was last fed while idle. */
  private idleFedMs = 0;
  private idleFedAt = -Infinity;

  constructor(private readonly deps: HandsfreeRuntimeDeps) {
    const t = deps.talking;
    const talking: TalkingSide = {
      feed: (frames) => this.feed(frames),
      say: (id, text, ended) => t.say(id, text, ended),
      setAsker: (userId, pending) => t.setAsker(userId, pending),
      close: () => t.close(),
    };
    this.router = new Router({ clock: deps.clock, call: deps.call, rules: deps.rules, listening: deps.listening, talking, relay: deps.relay, ...(deps.sayFixed ? { sayFixed: deps.sayFixed } : {}), ...(deps.working ? { working: deps.working } : {}), ...(deps.trace ? { trace: deps.trace } : {}) });
    this.offs.push(deps.listening.on('line', (l) => { if (!this.closing) deps.onLine(l); }));
    this.sink = {
      append: () => { if (!this.closing) { deps.listening.tick(); this.router.tick(); } },
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
  outputText(text: string, final = false): void { this.router.outputText(text, final); }

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

  /** The router's frames to the session, less the idle quiet past what closes a turn (IDLE_QUIET_MS), bar a keepalive frame. */
  private feed(frames: readonly Buffer[]): void {
    if (this.router.state().phase !== 'idle') { this.idleFedMs = 0; this.deps.talking.feed(frames); return; }
    const now = this.deps.clock.nowMs();
    const kept: Buffer[] = [];
    for (const f of frames) {
      if (this.idleFedMs < IDLE_QUIET_MS) this.idleFedMs += HANDSFREE.frameMs;
      else if (now - this.idleFedAt < IDLE_KEEPALIVE_MS) continue;
      kept.push(f); this.idleFedAt = now;
    }
    if (kept.length) this.deps.talking.feed(kept);
  }

  private open(userId: string, name: string): void {
    if (this.closing || !this.joined.has(userId)) return;
    this.deps.listening.open(userId, name).catch((e: unknown) => this.deps.trace?.('hf.lane.error', { userId, error: (e as Error).name }));
  }
}

// ── A standalone run for the voice gate (scripts/voice-harness/gate-port-runtime.mts) ──────────────────────────────────────────
// The real runtime (router, lane A's listening side over the provider's transcription stream, lane C's rules, the live session
// with delegation) with no orchestrator around it: a fake relay sink, the gate's own record and family. Nothing is stored.

export interface StandaloneRunInput {
  callId: string;
  speakers: Array<{ userId: string; name: string }>;
  /** False: `cand` (any speaker id starting with "cand") gets fixed lines only, as an interview's candidate without pad help. */
  candidateMayAsk: boolean;
  instructions: string;
  /** Milo's voice as it plays out (one 100 ms tick's worth per call, on the run's clock; silence included). */
  relay: (pcm24k: Buffer, atMs: number, kind: 'model' | 'fixed') => void;
  onTool: (name: string, askedBy: string | null, atMs: number) => void;
  onRouted: (userId: string, atMs: number, mixed: boolean) => void;
  /** What Milo said in an utterance any of whose audio was relayed (its final text, once). */
  onText?: (text: string, atMs: number) => void;
  /** Codes and ids only (the router's trace plus the session's turn events), for a measuring run. */
  trace?: (event: string, data: Record<string, unknown>) => void;
}

export interface StandaloneRun extends HandsfreeRun {
  /** The player's tick: the run's clock is set to `atMs` (session ms) and the router and the relay's playout advance. */
  tick(atMs: number): void;
}

export const GATE_FIXED_REFUSAL = 'Sorry, I can only tell you the time left or repeat the question.';

/**
 * The gate's family: `cand*` gets fixed lines only when the candidate may not ask, and a fixed "time" line is its one held answer.
 * Nothing a routed person says is ever held (`mayBeHeld` false), so the gate measures the early release at the first output frame.
 */
export function gateFamily(candidateMayAsk: boolean, isCandidate: (userId: string) => boolean) {
  return {
    admit: async (userId: string) => (!candidateMayAsk && isCandidate(userId) ? 'fixed-lines' as const : 'route' as const),
    heldAnswer: async (r: { text: string; admission: string }) => (r.admission === 'fixed-lines' && /time/i.test(r.text) ? 'There are twenty minutes left.' : null),
    mayBeHeld: (_r: { text: string }) => false,
    refusal: GATE_FIXED_REFUSAL,
    instructions: () => null,
  };
}

export async function startHandsfreeRun(input: StandaloneRunInput): Promise<StandaloneRun> {
  const [{ OpenAiLiveSession }, { voiceConfig }, { createListeningSide }, { createHandsfreeRules }, { openAiTranscriberFactory }, { HandsfreeTalking }, { HANDSFREE_TURN_RULES }, { policyForLobby }] = await Promise.all([
    import('../live-session.js'), import('../../voice/config.js'), import('./listening.js'), import('./rules.js'),
    import('../../voice/openai-transcribe.js'), import('./talking.js'), import('../instructions.js'), import('../policy.js'),
  ]);
  const FRAME_BYTES = 4800;
  let tickAt = 0; let tickWall = Date.now();
  const clock: HandsfreeClock = {
    nowMs: () => tickAt + (Date.now() - tickWall),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const call: PolicyCall = { callId: input.callId, lobby: null, tenant: 'gate' };
  const names = input.speakers.map((s) => s.name);
  const isCandidate = (userId: string): boolean => userId.startsWith('cand');
  const base = policyForLobby(null);
  const family = gateFamily(input.candidateMayAsk, isCandidate);
  const policy = Object.create(base, { handsfree: { value: () => family }, acknowledgement: { value: () => 'in-call-notice' } }) as typeof base;
  const record = { callId: input.callId, state: 'listening', acked: [...input.speakers.map((s) => s.userId), 'room'] } as unknown as import('../types.js').AssistantRecord;

  const cfg = voiceConfig();
  if (!cfg.delegationModel) throw new Error('no delegation model configured');
  const inner = new OpenAiLiveSession({ model: cfg.model, voice: cfg.voice, delegationModel: cfg.delegationModel, clock: Date.now });
  const talking = new HandsfreeTalking(inner);
  let run: HandsfreeRuntime | null = null;
  const ownerOf = (): string | null => { const st = run?.state(); return st && st.phase !== 'idle' ? st.userId : null; };
  const feed = talking.feed.bind(talking);
  talking.feed = (frames) => { const who = ownerOf(); if (who) for (const _f of frames) input.onRouted(who, clock.nowMs(), false); feed(frames); };

  // The relay sink: a playout queue, one tick's worth played per tick (a cleared relay drops what has not played).
  let queue: Array<{ pcm: Buffer; kind: 'model' | 'fixed' }> = [];
  let nextKind: 'model' | 'fixed' = 'model';
  // The relayed utterance's words: kept until any of its audio is relayed (the verdict may hold it), then told once.
  let uttText: string | null = null; let uttPushed = false;
  const flushText = (): void => { if (uttText !== null && uttPushed) { input.onText?.(uttText, clock.nowMs()); uttText = null; uttPushed = false; } };
  const listening = createListeningSide({ callId: input.callId, transcriber: openAiTranscriberFactory(), clock, consented: () => true });
  const rules = createHandsfreeRules({ record: async () => record, policy: () => policy, roster: () => names, admitWaitMs: 150 });
  run = new HandsfreeRuntime({
    call, clock, listening, rules, talking,
    relay: { push: (pcm) => { queue.push({ pcm, kind: nextKind }); uttPushed = true; flushText(); }, clear: () => { queue = []; } },
    onLine: () => undefined,
    nameOf: async (userId) => input.speakers.find((s) => s.userId === userId)?.name ?? userId,
    ...(input.trace ? { trace: input.trace } : {}),
  });
  const tr = (event: string, data: Record<string, unknown> = {}): void => input.trace?.(event, { ...data, callId: input.callId, atMs: clock.nowMs() });
  listening.on('sentence', (e) => tr('l.sentence', { userId: e.userId }));
  listening.on('name', (e) => tr('l.name', { userId: e.userId }));
  run.on('state', (st) => tr('state', { phase: st.phase }));
  run.on('drop', (e) => tr('drop', e as unknown as Record<string, unknown>));
  inner.on('inputTranscript', (e) => { tr('s.input', { turnEnded: !!e.turnEnded }); if (e.turnEnded) run?.turnEnded(); });
  inner.on('delegation', () => { tr('s.delegation'); run?.turnEnded(); });
  inner.on('outputTranscript', (e) => {
    if (e.say === undefined) run?.outputText(e.text, e.final);
    if (e.final && e.say === undefined) { uttText = e.text; flushText(); }
  });
  let outN = 0;
  inner.on('outputAudio', (e) => { if (outN++ % 20 === 0 || e.last) tr('s.audio', { last: !!e.last, queued: queue.length }); nextKind = e.say !== undefined ? 'fixed' : 'model'; run?.outputAudio(e.pcm, e.last === true, e.say); });
  talking.on('toolCall', (e) => { input.onTool(e.name, e.askedBy ?? null, clock.nowMs()); inner.answerToolCall(e.callId, JSON.stringify({ ok: true })); });

  await talking.start({
    instructions: [input.instructions, HANDSFREE_TURN_RULES, 'You have one tool through the backend: to add a note, delegate the request; never say you added it yourself.'].join('\n\n'),
    tools: [{ type: 'function', name: 'add_note', description: 'Add a short note to the meeting notes.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'the note' } }, required: ['text'], additionalProperties: false }, strict: true } as never],
    backendInstructions: 'When asked to add a note, call add_note once, then confirm in a few words.',
  });
  for (const s of input.speakers) run.personJoined(s.userId, s.name);

  const hf = run;
  const play = (atMs: number): void => {
    let owed = FRAME_BYTES; const parts: Buffer[] = []; let kind: 'model' | 'fixed' = 'model';
    while (owed > 0 && queue.length) {
      const head = queue[0]!; kind = head.kind;
      if (head.pcm.length <= owed) { parts.push(head.pcm); owed -= head.pcm.length; queue.shift(); }
      else { parts.push(head.pcm.subarray(0, owed)); head.pcm = head.pcm.subarray(owed); owed = 0; }
    }
    if (parts.length) input.relay(Buffer.concat(parts), atMs, kind);
  };
  return Object.assign(hf, {
    tick(atMs: number): void { tickAt = atMs; tickWall = Date.now(); hf.sink.append(Buffer.alloc(0)); play(atMs); },
  }) as StandaloneRun;
}

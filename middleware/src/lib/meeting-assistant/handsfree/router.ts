// Hands-free Milo: the router, the one floor (types.ts `RouteState`). It decides, every 100 ms tick, which person's audio the
// talking session hears (nobody's, one person's pre-roll replayed within the provider's rate limit, or one person live), and, for
// every frame the session says, whether it is relayed now, held for the rules' verdict, or dropped.
//
//   idle ──name (admitted: route)──► routing ──provider closes the turn / first output──► answering ──last frame──► follow-up (10 s)
//     ▲            hold press ───────┘                                                     │ barge-in, mention, aside, timeout   │
//     └────────────────────────────────────────────────────────────────────────────────────┴──────── window ends ──────────────┘
//
// Rules it keeps (the plan's lane B tests): nothing reaches the session before a trigger; replays stay within 1.2x and 5 s ahead
// (a token bucket: 1.2 ms of audio per ms, 5 s deep; idle ticks send nothing until the lead is paid back); one person at a time and
// never two mixed; a second person's "Milo" while the floor is held keeps one sentence (the latest) and replays it once the floor is
// free; a barge-in clears the relay inside the frame that carried it; every state change tells the talking side who the asker is.
// Synchronous on the frame path; only admission and verdicts are awaited, never inside a tick.
import { HANDSFREE, type Admission, type HandsfreeClock, type HandsfreeRules, type ListeningSide, type RelayDrop, type RouteState, type RouterEvents, type TalkingSide, type TriggerVerdict } from './types.js';
import type { PolicyCall } from '../policy.js';

/** A routed turn the provider never answers is given up this long after its speech ended (or the hold was released). */
export const ROUTE_GIVE_UP_MS = 12_000;
/** Audio per tick, and the bucket's depth, in ms of audio. */
const TICK_MS = HANDSFREE.frameMs;
const BUCKET_MS = HANDSFREE.replayBurstMs;
/** The most frames waiting to go to the session (a ring's worth): older ones are dropped first. */
const MAX_QUEUED_FRAMES = HANDSFREE.ringMs / HANDSFREE.frameMs;
const SILENCE = Buffer.alloc(HANDSFREE.frameBytes);
const MAX_KEPT_VERDICTS = 64;

export interface RelayPort {
  push(pcm: Buffer, last: boolean): void;
  clear(): void;
}

export interface RouterDeps {
  clock: HandsfreeClock;
  call: PolicyCall;
  rules: HandsfreeRules;
  listening: Pick<ListeningSide, 'preRoll' | 'on'>;
  talking: Pick<TalkingSide, 'feed' | 'setAsker' | 'say'>;
  relay: RelayPort;
  /** Say a fixed verdict's line for `userId` (the orchestrator posts it with the approved mark and says it as approved words). Absent: `talking.say`. */
  sayFixed?: (userId: string, line: string) => void;
  /** Codes and ids only (never words or audio). */
  trace?: (event: string, data: Record<string, unknown>) => void;
}

type Via = 'name' | 'follow-up' | 'hold';
interface Turn {
  userId: string;
  via: Via;
  /** The sentence that opened the turn (null: a hold, or a follow-up whose first words have not come yet). */
  sentenceId: string | null;
  /** Null while the rules have not answered. A hold is a request by definition. */
  verdict: TriggerVerdict | null;
  /** Output frames waiting for the verdict, and when the first arrived. */
  held: Array<{ pcm: Buffer; last: boolean }>;
  verdictTimer: unknown;
  /** The hold ran out once while the person was still talking: the early reply was dropped and the turn kept. */
  reheld?: boolean;
  /** Opened inside the asker's follow-up window: Milo's echo goes back to it (when it ends, and the request it carried). */
  window?: { untilMs: number; verdict: TriggerVerdict | null };
}

type Listener<K extends keyof RouterEvents> = (e: RouterEvents[K]) => void;
interface Queued { userId: string; sentenceId: string; sentenceStartMs: number; atMs: number; endMs?: number }

export class Router {
  private st: RouteState = { phase: 'idle' };
  private turn: Turn | null = null;
  /** Frames owed to the session for the routed person (pre-roll first, then live), oldest first. */
  private out: Buffer[] = [];
  /** The routed person's live frames are taken (false after a hold is released: the provider hears quiet and closes the turn). */
  private live = false;
  private tokens: number = BUCKET_MS;
  private lastTickMs: number;
  /** Milo's voice is playing out until this session ms (each relayed frame adds 100 ms after the previous one). */
  private playingUntil = 0;
  /** A relayed utterance has started and its last frame has not come. */
  private uttering = false;
  /** The session is mid-utterance (a frame came, its last has not), relayed or not. */
  private speaking = false;
  /** The rest of the session's current utterance is unheard (its turn was dropped, or nobody asked for it). */
  private dropUtt = false;
  /** When each person's last words arrived (session ms): still talking, for a hold that runs out mid-sentence. */
  private readonly lastWordsMs = new Map<string, number>();
  /**
   * What Milo's current piece of speech has said so far, and the piece before it (the echo check's `saying`: an echo trails his
   * voice). A piece ends with its final transcript; the next words start a new one. Never cleared by playout, so words the verdict
   * held still count once their frames play.
   */
  private saying = '';
  private said = '';
  private pieceDone = false;
  /** Words heard so far per `${userId}|${sentenceId}` (the echo / barge-in check's `heard`). */
  private heard = new Map<string, string>();
  private verdicts = new Map<string, TriggerVerdict>();
  /** Sentences of people admitted only to fixed lines, named: their final text gets a verdict and maybe a server line. */
  private fixedSentences = new Set<string>();
  /** One queued sentence (latest wins): when it was queued, and where it ended once its final came. */
  private queued: Queued | null = null;
  private admitting: string | null = null;
  private holder: string | null = null;
  private holdTimer: unknown = null;
  private windowTimer: unknown = null;
  private giveUpTimer: unknown = null;
  private sayNo = 0;
  private closed = false;
  private readonly listeners = new Map<string, Set<(e: never) => void>>();
  private readonly offs: Array<() => void>;

  constructor(private readonly deps: RouterDeps) {
    this.lastTickMs = deps.clock.nowMs();
    const l = deps.listening;
    this.offs = [
      l.on('frame', (e) => this.onFrame(e.userId, e.pcm)),
      l.on('name', (e) => { void this.onName(e.userId, e.sentenceId, e.sentenceStartMs, e.nameEndMs, e.textSoFar); }),
      l.on('words', (e) => this.onWords(e.userId, e.sentenceId, e.delta)),
      l.on('sentence', (e) => this.onSentence(e.userId, e.sentenceId, e.text, e.named, e.startMs, e.endMs)),
      l.on('lane', (e) => { if (e.state === 'down' && e.reason === 'left') this.personLeft(e.userId); }),
    ];
  }

  state(): RouteState { return this.st; }

  on<K extends keyof RouterEvents>(type: K, fn: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn as (e: never) => void);
    this.listeners.set(type, set);
    return () => { set.delete(fn as (e: never) => void); };
  }

  /** Milo's voice is playing (triggers are ignored, words are checked for barge-in). */
  playing(): boolean { return this.uttering || this.deps.clock.nowMs() < this.playingUntil; }

  /** Something that began at `atMs` may be Milo's voice heard back: it started while he played or inside the echo grace after. */
  private inEchoTail(atMs: number): boolean { return this.playing() || atMs < this.playingUntil + HANDSFREE.echoGraceMs; }

  /** Is this text (heard in someone's mic) Milo's own words coming back? */
  private echoes(text: string): boolean {
    const saying = this.said ? `${this.said} ${this.saying}` : this.saying;
    return !!saying && this.deps.rules.overlap(text, saying) === 'echo';
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The tick: what the session hears

  /** The mixer's 100 ms append: feed the talking side this tick's frames. */
  tick(): void {
    if (this.closed) return;
    const now = this.deps.clock.nowMs();
    this.tokens = Math.min(BUCKET_MS, this.tokens + Math.max(0, now - this.lastTickMs) * HANDSFREE.replayMaxRate);
    this.lastTickMs = now;
    const frames: Buffer[] = [];
    while (this.out.length && this.tokens >= TICK_MS) { frames.push(this.out.shift()!); this.tokens -= TICK_MS; }
    if (!frames.length && this.tokens >= (this.st.phase === 'idle' ? BUCKET_MS : TICK_MS)) {
      // Routed with nothing owed: quiet, so the provider can close the turn. Idle: quiet only once a replay's lead is paid back.
      frames.push(SILENCE); this.tokens -= TICK_MS;
    }
    this.deps.talking.feed(frames);
  }

  private onFrame(userId: string, pcm: Buffer): void {
    if (this.closed || !this.live || this.st.phase === 'idle' || this.st.userId !== userId) return;
    this.out.push(pcm);
    if (this.out.length > MAX_QUEUED_FRAMES) this.out.shift();
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Triggers

  private async onName(userId: string, sentenceId: string, sentenceStartMs: number, nameEndMs: number, textSoFar: string): Promise<void> {
    if (this.closed) return;
    // Milo's own voice in a mic says his name: no trigger while he plays (barge-in is the words' check, not the name's).
    if (this.playing()) { this.trace('name.ignored', { userId, why: 'playing' }); return; }
    // Just after he stops, the name may still be his voice coming back (an introduction): his own words are no trigger.
    if (this.inEchoTail(sentenceStartMs) && this.echoes(textSoFar)) { this.trace('name.ignored', { userId, why: 'echo' }); return; }
    const st = this.st;
    if (st.phase !== 'idle' && st.userId === userId) {
      // The person already routed names Milo again: the same floor, now a named turn on this sentence.
      if (st.phase === 'follow-up' || !this.turn || this.turn.sentenceId === null || this.turn.via === 'follow-up') this.openTurn(userId, 'name', sentenceId);
      return;
    }
    // Someone else's follow-up window is not a held floor: a new name takes it (the window is a courtesy to the asker, not a hold).
    const busy = (): boolean => (this.st.phase !== 'idle' && this.st.phase !== 'follow-up') || !!this.holder;
    if (busy() || (this.admitting && this.admitting !== userId)) { this.queue(userId, sentenceId, sentenceStartMs); return; }
    this.admitting = userId;
    let admission: Admission;
    try { admission = await this.admit(userId); } finally { this.admitting = null; }
    if (this.closed) return;
    if (admission === 'fixed-lines') { this.keepFixed(userId, sentenceId); return; }
    if (admission !== 'route') { this.trace('name.denied', { userId }); return; }
    if (busy()) { this.queue(userId, sentenceId, sentenceStartMs); return; }
    this.startRoute(userId, 'name', sentenceId, Math.max(sentenceStartMs, nameEndMs - HANDSFREE.preRollMaxMs));
  }

  private queue(userId: string, sentenceId: string, sentenceStartMs: number): void {
    this.queued = { userId, sentenceId, sentenceStartMs, atMs: this.deps.clock.nowMs() };
    this.emit('queued', { userId, sentenceStartMs });
  }

  /** The queued sentence, unless it has waited past `queueKeepMs` (then it is let go: replaying it now would be stale words). */
  private liveQueue(): Queued | null {
    const q = this.queued;
    if (q && this.deps.clock.nowMs() - q.atMs > HANDSFREE.queueKeepMs) { this.queued = null; this.trace('queue.expired', { userId: q.userId }); return null; }
    return q;
  }

  /** The rules' admission within its budget; late or failed is `deny`. */
  private admit(userId: string): Promise<Admission> {
    return new Promise<Admission>((resolve) => {
      const t = this.deps.clock.setTimeout(() => resolve('deny'), HANDSFREE.admitWaitMs);
      this.deps.rules.admit(this.deps.call, userId).then(
        (a) => { this.deps.clock.clearTimeout(t); resolve(a); },
        () => { this.deps.clock.clearTimeout(t); resolve('deny'); },
      );
    });
  }

  private keepFixed(userId: string, sentenceId: string): void {
    this.fixedSentences.add(`${userId}|${sentenceId}`);
    if (this.fixedSentences.size > MAX_KEPT_VERDICTS) this.fixedSentences.delete(this.fixedSentences.values().next().value as string);
    // Their sentence may already be final (the admission is asked after the name's delta; the final can overtake it).
  }

  private startRoute(userId: string, via: Via, sentenceId: string | null, fromMs: number | null, toMs = Infinity): void {
    this.clearWindow();
    this.out = fromMs === null ? [] : this.deps.listening.preRoll(userId, fromMs, toMs).slice(-MAX_QUEUED_FRAMES);
    this.live = !Number.isFinite(toMs);
    this.openTurn(userId, via, sentenceId);
    this.trace('route', { userId, via, preRollFrames: this.out.length });
  }

  private openTurn(userId: string, via: Via, sentenceId: string | null): void {
    this.clearWindow();
    const prior = this.turn;
    if (prior && prior.verdictTimer !== null) this.deps.clock.clearTimeout(prior.verdictTimer);
    const known = sentenceId ? this.verdicts.get(`${userId}|${sentenceId}`) ?? null : null;
    const st = this.st;
    const window = st.phase === 'follow-up' && st.userId === userId ? { untilMs: st.untilMs, verdict: prior?.verdict ?? null } : prior?.userId === userId ? prior.window : undefined;
    this.turn = { userId, via, sentenceId, verdict: via === 'hold' ? { kind: 'request' } : known, held: [], verdictTimer: null, ...(window ? { window } : {}) };
    this.setState({ phase: 'routing', userId, via, sinceMs: this.deps.clock.nowMs() });
    if (this.turn.verdict) this.applyVerdict(this.turn, this.turn.verdict);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // What people say (words, finished sentences)

  private onWords(userId: string, sentenceId: string, delta: string): void {
    if (this.closed) return;
    const key = `${userId}|${sentenceId}`;
    const heard = `${this.heard.get(key) ?? ''}${delta}`;
    this.lastWordsMs.set(userId, this.deps.clock.nowMs());
    this.heard.set(key, heard);
    if (this.heard.size > MAX_KEPT_VERDICTS) this.heard.delete(this.heard.keys().next().value as string);
    if (this.playing()) {
      const v = this.deps.rules.overlap(heard, this.saying);
      if (v === 'barge-in') { this.bargeIn(userId); return; }
      if (v === 'echo') return;
    }
    // The asker speaks again inside their window: a follow-up turn on this sentence (judged when it is final).
    if (this.st.phase === 'follow-up' && this.st.userId === userId) this.openTurn(userId, 'follow-up', sentenceId);
    else if (this.turn && this.turn.userId === userId && this.turn.via === 'follow-up' && this.turn.sentenceId === null) this.turn.sentenceId = sentenceId;
  }

  private onSentence(userId: string, sentenceId: string, text: string, named: boolean, startMs: number, endMs: number): void {
    if (this.closed) return;
    this.heard.delete(`${userId}|${sentenceId}`);
    // Milo's own words coming back through this mic (it began while he played or just after): not a request of anyone's.
    if (this.inEchoTail(startMs) && this.echoes(text)) { this.echoed(userId, sentenceId); return; }
    const key = `${userId}|${sentenceId}`;
    if (this.fixedSentences.delete(key) || (named && this.isFixedPending(userId))) { void this.judgeFixed(userId, text); return; }
    const t = this.turn;
    const mine = t && t.userId === userId && (t.sentenceId === sentenceId || (t.sentenceId === null && t.via === 'follow-up'));
    const queuedMine = this.queued && this.queued.userId === userId && this.queued.sentenceId === sentenceId;
    if (!mine && !queuedMine) return;
    if (queuedMine && this.queued) this.queued.endMs = endMs;
    if (t && mine && t.via === 'hold') { this.armGiveUp(); return; }
    const via: 'name' | 'follow-up' = mine && t?.via === 'follow-up' && !named ? 'follow-up' : 'name';
    if (mine) this.armGiveUp();
    void this.judge(userId, sentenceId, text, via);
  }

  /** A fixed-lines person named Milo but their admission is still being asked: judged the same way. */
  private isFixedPending(userId: string): boolean { return this.admitting === userId; }

  private async judge(userId: string, sentenceId: string, text: string, via: 'name' | 'follow-up'): Promise<void> {
    let v: TriggerVerdict;
    try { v = await this.deps.rules.verdict(this.deps.call, { userId, text, via }); } catch { v = { kind: 'mention' }; }
    if (this.closed) return;
    const key = `${userId}|${sentenceId}`;
    this.verdicts.set(key, v);
    if (this.verdicts.size > MAX_KEPT_VERDICTS) this.verdicts.delete(this.verdicts.keys().next().value as string);
    const t = this.turn;
    if (t && t.userId === userId && t.sentenceId === sentenceId && t.verdict === null) this.applyVerdict(t, v);
    else if (this.queued && this.queued.userId === userId && this.queued.sentenceId === sentenceId && v.kind !== 'request') this.queued = null;
  }

  private async judgeFixed(userId: string, text: string): Promise<void> {
    let v: TriggerVerdict;
    try { v = await this.deps.rules.verdict(this.deps.call, { userId, text, via: 'name' }); } catch { return; }
    if (this.closed || v.kind !== 'fixed') return;
    this.sayFixed(userId, v.line);
  }

  private applyVerdict(t: Turn, v: TriggerVerdict): void {
    t.verdict = v;
    if (t.verdictTimer !== null) { this.deps.clock.clearTimeout(t.verdictTimer); t.verdictTimer = null; }
    if (v.kind === 'request') { this.syncAsker(); const held = t.held.splice(0); for (const f of held) this.relayFrame(f.pcm, f.last); return; }
    if (v.kind === 'fixed') { this.drop(v.kind); this.sayFixed(t.userId, v.line); return; }
    this.drop(v.kind);
  }

  /** A server line: the orchestrator's held-text path when given (posted with the approved mark, logged by the family), else said here. */
  private sayFixed(userId: string, line: string): void {
    if (this.deps.sayFixed) { this.deps.sayFixed(userId, line); return; }
    this.sayNo += 1;
    this.deps.talking.say(`hf-fixed-${this.sayNo}`, line, () => undefined);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // What the session says

  /** The provider closed the routed person's turn (its input transcript ended the turn, or it handed the request on). */
  turnEnded(): void {
    if (this.st.phase === 'routing') this.setState({ ...this.st, phase: 'answering' });
  }

  /** Milo's words so far in this piece (output transcript; `final` ends the piece). A `say` utterance's words count too: they are what plays. */
  outputText(text: string, final = false): void {
    if (this.pieceDone) { this.said = this.saying; this.pieceDone = false; }
    this.saying = text;
    if (final) this.pieceDone = true;
  }

  /** One frame of the session's voice. `say` frames (server-held words) are relayed as they are; the rest follow the floor. */
  outputAudio(pcm: Buffer, last: boolean, say?: string): void {
    if (this.closed) return;
    if (say !== undefined) { this.relayFrame(pcm, last, true); return; }
    this.speaking = !last;
    if (this.dropUtt) { if (last) this.dropUtt = false; return; }
    const t = this.turn;
    // Nobody asked: the whole utterance is unheard (a turn opened while it runs never takes its tail).
    if (!t || this.st.phase === 'idle') { this.dropUtt = !last; return; }
    if (this.st.phase === 'routing') this.setState({ ...this.st, phase: 'answering' });
    if (this.st.phase === 'follow-up') this.setState({ phase: 'answering', userId: t.userId, via: t.via, sinceMs: this.deps.clock.nowMs() });
    this.clearGiveUp();
    if (t.verdict === null) {
      t.held.push({ pcm, last });
      if (t.verdictTimer === null) t.verdictTimer = this.deps.clock.setTimeout(() => { t.verdictTimer = null; if (this.turn === t && t.verdict === null) this.verdictLate(t); }, HANDSFREE.verdictWaitMs);
      return;
    }
    if (t.verdict.kind === 'request') this.relayFrame(pcm, last);
  }

  /**
   * The hold ran out with no verdict. The provider answers a pause inside a long sentence: when the person is still talking (words
   * in the last 1.5 s), that early reply is dropped unheard and the turn kept (once), so the end of the sentence is still routed and
   * answered; otherwise the turn is dropped as before.
   */
  private verdictLate(t: Turn): void {
    const talking = this.deps.clock.nowMs() - (this.lastWordsMs.get(t.userId) ?? -Infinity) <= 1_500;
    if (!t.reheld && talking && this.st.phase === 'answering') {
      t.reheld = true; t.held = [];
      this.dropUtt = this.speaking;
      this.setState({ phase: 'routing', userId: t.userId, via: this.st.via, sinceMs: this.deps.clock.nowMs() });
      this.armGiveUp();
      this.trace('verdict.rehold', { userId: t.userId });
      return;
    }
    t.verdict = { kind: 'mention' };
    this.drop('verdict-timeout');
  }

  private relayFrame(pcm: Buffer, last: boolean, said = false): void {
    const now = this.deps.clock.nowMs();
    this.uttering = !last;
    this.playingUntil = Math.max(now, this.playingUntil) + TICK_MS;
    this.deps.relay.push(pcm, last);
    if (last && !said) this.answerEnded();
  }

  /** The relayed answer's last frame: the asker keeps the floor for the follow-up window, unless someone is queued. */
  private answerEnded(): void {
    const t = this.turn;
    if (!t || this.st.phase === 'idle') return;
    if (this.liveQueue()) { this.toIdle(); return; }
    this.openWindow(t.userId, this.playingUntil + HANDSFREE.followUpMs, t.verdict);
  }

  /**
   * The asker's follow-up window until `untilMs`. Until they speak again, more output is the request it carries going on (a delegated
   * answer after its acknowledgement).
   */
  private openWindow(userId: string, untilMs: number, verdict: TriggerVerdict | null): void {
    this.live = true;
    this.turn = { userId, via: 'follow-up', sentenceId: null, verdict, held: [], verdictTimer: null };
    this.setState({ phase: 'follow-up', userId, untilMs });
    this.clearWindow();
    this.windowTimer = this.deps.clock.setTimeout(() => { this.windowTimer = null; if (this.st.phase === 'follow-up') this.toIdle(); }, untilMs - this.deps.clock.nowMs());
  }

  /**
   * A sentence that was Milo's echo: never judged. A turn it opened is undone: what the session said to it is dropped unheard, and
   * the asker's follow-up window it interrupted goes on as it was; otherwise the floor is free.
   */
  private echoed(userId: string, sentenceId: string): void {
    this.trace('echo', { userId });
    if (this.queued?.userId === userId && this.queued.sentenceId === sentenceId) this.queued = null;
    const t = this.turn;
    if (!t || t.userId !== userId || this.st.phase === 'follow-up') return; // nothing opened (the window itself goes on)
    if (t.sentenceId !== sentenceId && !(t.sentenceId === null && t.via === 'follow-up')) return;
    if (t.via === 'hold') return;
    if (t.verdictTimer !== null) { this.deps.clock.clearTimeout(t.verdictTimer); t.verdictTimer = null; }
    t.held = [];
    this.dropUtt = this.speaking;
    const w = t.window;
    if (w && w.untilMs > this.deps.clock.nowMs()) { this.clearGiveUp(); this.openWindow(userId, w.untilMs, w.verdict); return; }
    this.drop('echo');
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Stopping

  private bargeIn(userId: string): void {
    const t = this.turn;
    this.deps.relay.clear();
    this.playingUntil = this.deps.clock.nowMs();
    this.emit('drop', { userId: t?.userId ?? userId, reason: 'barge-in', atMs: this.deps.clock.nowMs() });
    this.dropUtt = this.speaking;
    this.uttering = false;
    if (t && t.userId === userId && this.st.phase !== 'idle') {
      // The asker talks over Milo: the rest of this utterance is dropped and what they say now is a new turn of theirs.
      this.openTurn(userId, 'follow-up', null);
      return;
    }
    this.toIdle();
  }

  /** Drop the current turn's relay (mention, aside, timeout, fixed, stop, hold cancel) and free the floor. */
  private drop(reason: RelayDrop): void {
    const t = this.turn;
    if (!t) return;
    t.held = [];
    if (t.verdictTimer !== null) { this.deps.clock.clearTimeout(t.verdictTimer); t.verdictTimer = null; }
    if (this.uttering || reason === 'hold-cancel' || reason === 'stop') { this.deps.relay.clear(); this.playingUntil = this.deps.clock.nowMs(); }
    // The session may talk on, unheard, to the end of its utterance.
    this.dropUtt = this.speaking;
    this.uttering = false;
    this.emit('drop', { userId: t.userId, reason, atMs: this.deps.clock.nowMs() });
    this.toIdle();
  }

  private toIdle(): void {
    const prior = this.turn;
    if (prior?.verdictTimer) this.deps.clock.clearTimeout(prior.verdictTimer);
    this.clearWindow(); this.clearGiveUp(); this.clearHold();
    this.out = []; this.live = false;
    this.turn = null;
    this.setState({ phase: 'idle' });
    const q = this.liveQueue();
    if (q) { this.queued = null; void this.dequeue(q); }
  }

  /** The queued sentence gets the floor: replayed from its start (within the ring) to its end once final, else on into live audio. */
  private async dequeue(q: Queued): Promise<void> {
    const v = this.verdicts.get(`${q.userId}|${q.sentenceId}`);
    if (v && v.kind !== 'request') return;
    this.admitting = q.userId;
    let a: Admission;
    try { a = await this.admit(q.userId); } finally { this.admitting = null; }
    if (this.closed || a !== 'route' || this.st.phase !== 'idle' || this.holder) return;
    this.startRoute(q.userId, 'name', q.sentenceId, Math.max(q.sentenceStartMs, this.deps.clock.nowMs() - HANDSFREE.ringMs + HANDSFREE.frameMs), q.endMs ?? Infinity);
    if (q.endMs !== undefined) this.armGiveUp();
  }

  private armGiveUp(): void {
    this.clearGiveUp();
    const t = this.turn;
    this.giveUpTimer = this.deps.clock.setTimeout(() => { this.giveUpTimer = null; if (this.turn === t && this.st.phase === 'routing') this.drop('stop'); }, ROUTE_GIVE_UP_MS);
  }

  private clearGiveUp(): void { if (this.giveUpTimer !== null) { this.deps.clock.clearTimeout(this.giveUpTimer); this.giveUpTimer = null; } }
  private clearWindow(): void { if (this.windowTimer !== null) { this.deps.clock.clearTimeout(this.windowTimer); this.windowTimer = null; } }
  private clearHold(): void { if (this.holdTimer !== null) { this.deps.clock.clearTimeout(this.holdTimer); this.holdTimer = null; } this.holder = null; }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The hold button (same floor, no name, no verdict)

  async holdPress(userId: string): Promise<{ ok: true } | { ok: false; reason: 'busy' | 'not-admitted' | 'not-running' | 'already-holding' }> {
    if (this.closed) return { ok: false, reason: 'not-running' };
    if (this.holder === userId) return { ok: false, reason: 'already-holding' };
    const busy = (): boolean => this.holder !== null || (this.st.phase !== 'idle' && this.st.userId !== userId) || (this.admitting !== null && this.admitting !== userId);
    if (busy()) return { ok: false, reason: 'busy' };
    const a = await this.admit(userId);
    if (this.closed) return { ok: false, reason: 'not-running' };
    if (a !== 'route') return { ok: false, reason: 'not-admitted' };
    if (this.holder === userId) return { ok: false, reason: 'already-holding' };
    if (busy()) return { ok: false, reason: 'busy' };
    this.queued = this.queued?.userId === userId ? null : this.queued;
    this.startRoute(userId, 'hold', null, null);
    this.holder = userId;
    this.holdTimer = this.deps.clock.setTimeout(() => { this.holdTimer = null; this.holdRelease(userId); }, HANDSFREE.holdMaxMs);
    return { ok: true };
  }

  holdRelease(userId: string): void {
    if (this.holder !== userId) return;
    if (this.holdTimer !== null) { this.deps.clock.clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.holder = null;
    // The provider hears quiet from here and closes the turn; the answer is relayed (a hold needs no verdict).
    this.live = false;
    this.armGiveUp();
  }

  holdCancel(userId: string): void {
    if (this.holder !== userId) return;
    this.holder = null;
    this.drop('hold-cancel');
  }

  /** The person left the call: their floor and their queued sentence go. */
  personLeft(userId: string): void {
    if (this.queued?.userId === userId) this.queued = null;
    if (this.holder === userId) this.holder = null;
    if (this.st.phase !== 'idle' && this.st.userId === userId) this.drop('stop');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const t = this.turn;
    if (t?.verdictTimer) this.deps.clock.clearTimeout(t.verdictTimer);
    this.clearWindow(); this.clearGiveUp(); this.clearHold();
    this.out = []; this.turn = null; this.queued = null;
    for (const off of this.offs.splice(0)) off();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------------------

  private setState(s: RouteState): void {
    this.st = s;
    this.syncAsker();
    this.emit('state', s);
  }

  /**
   * Who a tool call is for: the routed person once their turn is a request (a hold is one), pending while the rules have not
   * judged it (the talking side holds the call), nobody otherwise. A name alone never authorises a tool (review 1, item 1).
   */
  private syncAsker(): void {
    const t = this.turn;
    if (this.st.phase === 'idle' || !t) this.deps.talking.setAsker(null);
    else if (t.verdict === null) this.deps.talking.setAsker(t.userId, true);
    else this.deps.talking.setAsker(t.verdict.kind === 'request' ? t.userId : null);
  }

  private emit<K extends keyof RouterEvents>(type: K, e: RouterEvents[K]): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      try { (fn as Listener<K>)(e); } catch (err) { console.warn(`[meeting-assistant] hands-free ${type} listener threw`, (err as Error).message); }
    }
    if (type !== 'state') this.trace(`hf.${type}`, { userId: (e as { userId?: string }).userId ?? null, ...(type === 'drop' ? { reason: (e as RouterEvents['drop']).reason } : {}) });
  }

  private trace(event: string, data: Record<string, unknown>): void { this.deps.trace?.(event, data); }
}

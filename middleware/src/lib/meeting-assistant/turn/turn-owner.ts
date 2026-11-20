// The turn owner: every finished sentence, from each person's own lane, through the floor to Decide, Act and Speak
// (docs/milo-rebuild/REBUILD-REVIEW.md "Amended phase 1", 1B; risks 2, 4, 5, 7 and 8).
//
//   listening (sentence, words, frame, line) ─► lane rules ─► floor ─► decide ─► act ─► speak ─► relay
//
// What it keeps, in code:
//   * Lanes. A sentence that is Milo's own line heard back, or a second lane's copy of someone else's sentence, is dropped before
//     anything else: it is not judged, not context and not stored as that person's words (barge.ts).
//   * The gate. A sentence reaches Decide only when its speaker holds the button, or it holds a spelling of the name (a tenant
//     may add a follow-up window with `followUpMs`; interviews has none); never for a person the tenant gives no role; never while
//     paused (floor.ts).
//   * One turn. A new onset from the asker before Milo's audio has started suspends their turn; their next sentence is merged with
//     it and decided as one. `keep_listening` waits for the rest the same way. A turn that has acted is never merged.
//   * Silence. Act speaks `cannot_help` only for the name or a hold; a wait that ends with nothing more is silence.
//   * Talking over Milo. Words in any mic that are not his own stop the line (the row is marked `partly`); the asker's window
//     then runs from the stop.
//   * Once. A sentence is acted on once (Act's key is the sentence id) and the same write asked again within 10 s is skipped.
//
// It stands where the hands-free runtime stood (`HandsfreeRun`: the sink, the floor view, the hold button, `say`), so the routes and
// the portal bar do not change. Timers and time are the clock's (session ms), so the judge drives it on a fake clock.
import type { HandsfreeClock, HandsfreeRun, HeardLine as StoredLine, HoldResult, ListeningSide, RouteState, RouterEvents, WordsEvent } from '../handsfree/types.js';
import type { PolicyCall } from '../policy.js';
import type { SpeechBackend } from '../../voice/speech.js';
import { act, type ActDeps, type ActResult } from './act.js';
import { ECHO_TAIL_MS, MicWatch, creditedLane, isMiloEcho, onTwoLanes, overlapOf, wordsOf, type LaneSentence, type PlayedLine } from './barge.js';
import { decide, type DecideDeps } from './decide.js';
import { Floor, HOLD_MAX_MS, QUEUE_KEEP_MS, asksToResume } from './floor.js';
import { Mouth, type SpeakDeps, type SpeakResult } from './speak.js';
import { VOICE_FRAME_MS } from '../voice.js';
import type { Decision, HeardLine, MiloAction, SpokenLine, TurnPolicy, TurnSentence } from './types.js';

/** A suspended turn goes on by itself this long after the asker's last onset or words (the onset was a cough, or never became a sentence). */
export const ONSET_WAIT_MS = 2_500;
/** After `keep_listening`, the rest of the request is waited for this long; then it is dropped in silence. */
export const KEEP_LISTENING_MS = 8_000;
/** A sentence whose words are also arriving on another lane waits this long for that lane's final before it is credited. */
export const TWO_LANE_WAIT_MS = 1_500;
/** The same writing tool with the same arguments from the same person inside this long is one request heard twice. */
export const WRITE_REPEAT_MS = 10_000;
/** An onset in a mic straight after one in another mic is that voice arriving through a speaker, not this person starting. */
const ONSET_LEAK_MS = 400;
/** A line waits this long for people to stop speaking before its first audio; a line nobody asked for is dropped then. */
export const GAP_WAIT_MS = 4_000;
/** An answer someone asked for stays queued this long for a gap; after it, it is in the log and the chat only. */
export const ANSWER_KEEP_MS = 30_000;
const GAP_POLL_MS = 100;
const RECENT_MAX = 60;
const KEPT_MS = 30_000;

type Via = TurnSentence['via'];
let owners = 0;

/** The one switch: MILO_TURN_OWNER=1 puts a call whose policy has the turn contract (interviews) on the turn owner. Off: today's path. */
export function turnOwnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['MILO_TURN_OWNER'] ?? '').trim();
  return v === '1' || v === 'true';
}

/** One finished sentence from one person's lane (the listening side's `sentence` event). */
export interface OwnerSentence { userId: string; sentenceId: string; text: string; startMs: number; endMs: number }

/** What one sentence came to: what Decide chose, what Act did and how the line (if any) was said. For traces, tests and the judge. */
export interface TurnRecord { sentence: TurnSentence; decision: Decision; result: ActResult; said: SpeakResult | null }

export interface TurnOwnerDeps {
  call: PolicyCall;
  policy: TurnPolicy;
  /** Session ms and timers. */
  clock: HandsfreeClock;
  /** The per-person listening side; absent, sentences are handed in (`sentence`, `words`, `onset`). */
  listening?: ListeningSide | null;
  /** Milo's voice out to the call. */
  relay: { push(pcm: Buffer, last: boolean): void; clear(): void };
  /** Post a line to the call's chat before it is said. */
  post?: SpeakDeps['post'];
  voice?: SpeechBackend;
  /** May Milo's voice be heard now (the call's voice is on and not held)? False: lines are logged and posted, never said. Absent: yes. */
  voiceOn?: () => boolean;
  decide?: DecideDeps;
  act?: ActDeps;
  /** A person's line to store: never Milo's echo, never a second lane's copy. */
  onLine?: (l: StoredLine) => void;
  nameOf?: (userId: string) => Promise<string>;
  /** `pause_listening` and `leave_call`, already checked against the asker's role. */
  onPause?: (by: string) => void;
  onLeave?: (by: string) => void;
  onTurn?: (t: TurnRecord) => void;
  trace?: (event: string, data: Record<string, unknown>) => void;
}

interface Turn {
  who: string;
  via: Via;
  text: string;
  sentence: TurnSentence;
  /** Superseded: its sentence was merged into a newer turn, or it was cancelled. Nothing more of it happens. */
  dead: boolean;
  /** The asker started speaking again before audio: it waits here until their sentence is merged or the wait runs out. */
  suspended: { timer: unknown; go: () => void } | null;
  /** Act has run and did something: the turn can no longer be merged. */
  committed: boolean;
  /** Its line has started to play. */
  audio: boolean;
  line: string | null;
}

interface Final extends LaneSentence { id: string; turn: Turn | null }

export class TurnOwner implements HandsfreeRun {
  readonly sink: HandsfreeRun['sink'];
  private readonly floor: Floor;
  private readonly mouth: Mouth;
  private readonly mics: MicWatch;
  private turn: Turn | null = null;
  private queued: { s: Final; via: Via; recent: HeardLine[]; atMs: number } | null = null;
  /** After keep_listening: the words so far, waiting for the rest. */
  private readonly waiting = new Map<string, { text: string; via: Via; timer: unknown }>();
  private recent: HeardLine[] = [];
  private lastAction: MiloAction | null = null;
  private played: PlayedLine[] = [];
  private playing: PlayedLine | null = null;
  private finals: Final[] = [];
  /** Words arriving per lane for a sentence that has not finished. */
  private readonly flight = new Map<string, { sentenceId: string; text: string; firstMs: number; start: number | null }>();
  private readonly finalWaiters = new Set<() => void>();
  private readonly verdicts = new Map<string, Promise<boolean>>();
  private readonly lastOnset = new Map<string, number>();
  /** The line whose first audio is waiting for people to stop speaking, and who asked for it. */
  private gapWait: { askedBy: string } | null = null;
  private readonly lastWrite = new Map<string, { key: string; atMs: number }>();
  private readonly joined = new Set<string>();
  private intake: Promise<void> = Promise.resolve();
  private holdTimer: unknown = null;
  private windowTimer: unknown = null;
  private sayNo = 0;
  /**
   * This owner's mark on its sentence ids. A listening side numbers its sentences from 1, and a call gets a new one with every session
   * (a pause, a replacement, an invitation back): without the mark, Act's once-per-sentence key would take a new sentence for an old one.
   */
  private readonly scope = `${Date.now().toString(36)}.${++owners}`;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<(e: never) => void>>();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly deps: TurnOwnerDeps) {
    const { clock, listening } = deps;
    this.floor = new Floor(() => clock.nowMs(), (s) => this.emit('state', s), Math.max(0, deps.policy.followUpMs ?? 0));
    this.mics = new MicWatch((userId) => this.onset(userId));
    this.mouth = new Mouth({
      push: (pcm, last) => deps.relay.push(pcm, last),
      clear: () => deps.relay.clear(),
      ...(deps.post ? { post: deps.post } : {}),
      ...(deps.voice ? { voice: deps.voice } : {}),
      now: () => clock.nowMs(),
      sleep: (ms) => new Promise<void>((r) => { clock.setTimeout(() => r(), ms); }),
      onPlay: (ev) => this.onPlay(ev),
      clearToStart: (line, signal) => this.clearToStart(line, signal),
    });
    this.sink = {
      append: () => { if (!this.closed) listening?.tick(); },
      placed: (userId, pcm, atMs) => {
        if (this.closed || !listening) return;
        if (!this.joined.has(userId)) { this.joined.add(userId); void (deps.nameOf?.(userId) ?? Promise.resolve(userId)).catch(() => userId).then((name) => this.personJoined(userId, name)); }
        listening.placed(userId, pcm, atMs);
      },
    };
    if (listening) {
      this.offs.push(
        listening.on('frame', (e) => this.mics.trackMic(e.userId, e.pcm, e.atMs)),
        listening.on('words', (e) => this.words(e)),
        listening.on('sentence', (e) => this.sentence(e)),
        listening.on('line', (l) => this.line(l)),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The view and the events (today's floor surface)

  state(): RouteState { return this.floor.state(); }
  get paused(): boolean { return this.floor.paused; }
  get speaking(): boolean { return this.playing !== null; }

  on<K extends keyof RouterEvents>(type: K, fn: (e: RouterEvents[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn as (e: never) => void);
    this.listeners.set(type, set);
    return () => { set.delete(fn as (e: never) => void); };
  }
  private emit<K extends keyof RouterEvents>(type: K, e: RouterEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) { try { (fn as (e: RouterEvents[K]) => void)(e); } catch { /* a listener never stops the turn */ } }
  }
  private trace(event: string, data: Record<string, unknown> = {}): void { this.deps.trace?.(event, data); }
  private now(): number { return this.deps.clock.nowMs(); }

  // ---------------------------------------------------------------------------------------------------------------------------
  // What people say

  /** Words arriving in someone's transcript: an onset for their turn in flight, and the check for talking over Milo. */
  words(e: WordsEvent): void {
    if (this.closed) return;
    let f = this.flight.get(e.userId);
    if (!f || f.sentenceId !== e.sentenceId) {
      f = { sentenceId: e.sentenceId, text: '', firstMs: this.now(), start: this.mics.speechStartBefore(e.userId, e.atMs) };
      this.flight.set(e.userId, f);
      this.onset(e.userId);
    }
    f.text += e.delta;
    const t = this.turn;
    if (t?.suspended && t.who === e.userId) this.suspend(t); // still talking: the wait counts from their last words
    const p = this.playing;
    if (!p) return;
    // Words of a sentence begun before he started (the question's tail) are not talking over him.
    if (f.firstMs < p.startMs || (f.start !== null && f.start < p.startMs)) return;
    const v = overlapOf(f.text, p.text);
    if (v === 'barge-in') this.bargeIn(e.userId);
  }

  /** `userId` started speaking again. Before Milo's audio, their turn waits for what they say. */
  onset(userId: string): void {
    if (this.closed) return;
    const now = this.now();
    // Someone else's onset a moment ago: this mic is hearing them through a speaker.
    for (const [who, at] of this.lastOnset) if (who !== userId && now - at >= 0 && now - at < ONSET_LEAK_MS) return;
    this.lastOnset.set(userId, now);
    const t = this.turn;
    if (t && t.who === userId && !t.dead && !t.audio && !t.committed) { this.trace('turn.onset', { via: t.via }); this.suspend(t); }
  }

  private suspend(t: Turn): void {
    if (t.suspended) this.deps.clock.clearTimeout(t.suspended.timer);
    const go = t.suspended?.go ?? (() => {});
    const timer = this.deps.clock.setTimeout(() => this.unsuspend(t), ONSET_WAIT_MS);
    if (t.suspended) t.suspended.timer = timer; else t.suspended = { timer, go };
  }
  private unsuspend(t: Turn): void {
    const s = t.suspended;
    if (!s) return;
    this.deps.clock.clearTimeout(s.timer);
    t.suspended = null;
    s.go();
  }
  /** Resolves once the turn is not suspended (at once when it is not). */
  private settled(t: Turn): Promise<void> {
    if (!t.suspended) return Promise.resolve();
    return new Promise<void>((r) => { const s = t.suspended!; const before = s.go; s.go = () => { before(); r(); }; });
  }

  /** A finished sentence from one person's lane. Resolves when it has been handed on (a turn it opens runs on by itself). */
  sentence(e: OwnerSentence): Promise<void> {
    if (this.closed || !e.text.trim()) return Promise.resolve();
    // The lane's start can be the end of the person's sentence before this one (it missed the onset): the mic says where they began,
    // which is what a hold, an echo, a second lane's copy and talking over Milo are all judged by.
    const s: Final = { id: e.sentenceId, who: e.userId, text: e.text.trim(), startMs: this.mics.sentenceStart(e.userId, Math.min(e.startMs, e.endMs), e.endMs), endMs: e.endMs, turn: null };
    if (this.flight.get(e.userId)?.sentenceId === e.sentenceId) this.flight.delete(e.userId);
    // Known at once, in arrival order, so a copy on another lane sees it however long this one's own checks take.
    this.finals.push(s);
    this.finals = this.finals.filter((f) => f.endMs > s.endMs - KEPT_MS);
    for (const w of [...this.finalWaiters]) w();
    let keep!: (v: boolean) => void;
    this.verdicts.set(s.id, new Promise<boolean>((r) => { keep = r; }));
    if (this.verdicts.size > 200) this.verdicts.delete(this.verdicts.keys().next().value as string);
    const done = this.intake.then(() => this.take(s, keep)).catch((err: unknown) => { keep(true); this.trace('turn.error', { error: (err as Error).name }); });
    this.intake = done;
    return done;
  }

  /** A stored line follows its sentence's verdict: an echo or a second lane's copy is nobody's words. */
  private line(l: StoredLine): void {
    const id = l.captionId?.startsWith('hf:') ? l.captionId.slice(3) : null;
    const v = id ? this.verdicts.get(id) : undefined;
    if (!v) { this.deps.onLine?.(l); return; }
    void v.then((keep) => { if (keep && !this.closed) this.deps.onLine?.(l); });
  }

  private async take(s: Final, keep: (v: boolean) => void): Promise<void> {
    if (this.closed) { keep(false); return; }
    // 1. Whose words are these? Milo's own line heard back, or another lane's sentence, is dropped here.
    if (isMiloEcho(s, this.playedNow())) { this.trace('turn.echo', { userId: s.who }); keep(false); this.drop(s); return; }
    if (!(await this.creditedHere(s))) { this.trace('turn.two-lane', { userId: s.who }); keep(false); this.drop(s); return; }
    keep(true);
    const before = this.recent.slice();
    this.recent.push({ userId: s.who, text: s.text, atMs: s.endMs });
    if (this.recent.length > RECENT_MAX) this.recent.shift();

    // 2. Paused: only a named request to listen again is heard.
    if (this.floor.paused) { if (asksToResume(s.text)) this.resume(); return; }

    // 3. A sentence heard whole while Milo speaks, with no words seen for it, is checked for talking over him as words are.
    const p = this.playing;
    if (p && s.startMs >= p.startMs && overlapOf(s.text, p.text) === 'barge-in') this.bargeIn(s.who);

    // 4. The asker's turn has not been heard yet, or is waiting for the rest: this sentence is more of the same request.
    const t = this.turn;
    if (t && t.who === s.who && !t.dead && !t.audio && !t.committed) {
      this.kill(t);
      this.open(s, `${t.text} ${s.text}`, t.via, before);
      return;
    }
    const w = this.waiting.get(s.who);
    if (w) {
      this.deps.clock.clearTimeout(w.timer);
      this.waiting.delete(s.who);
      this.open(s, `${w.text} ${s.text}`, w.via, before);
      return;
    }

    // 5. The gate: a hold or the name (and, only where the tenant sets one, the asker's follow-up window). Nothing else reaches a model.
    const via = this.floor.route(s.who, s.text, s.startMs);
    if (!via) return;
    if ((await this.deps.policy.roleOf(this.deps.call, s.who).catch(() => null)) === null) { this.trace('turn.no-role', {}); return; }
    if (this.turn && !this.turn.dead) {
      // Their earlier answer has not started (people are still speaking): what they ask now replaces it.
      if (this.gapWait && this.gapWait.askedBy === s.who && this.turn.who === s.who) { this.trace('turn.speak.replaced', {}); this.mouth.stopCurrent(); }
      // The floor is taken: one sentence waits (the latest wins).
      this.queued = { s, via, recent: before, atMs: this.now() };
      this.emit('queued', { userId: s.who, sentenceStartMs: s.startMs });
      return;
    }
    this.open(s, s.text, via, before);
  }

  private drop(s: Final): void { this.finals = this.finals.filter((f) => f !== s); }

  private playedNow(): PlayedLine[] {
    const now = this.now();
    this.played = this.played.filter((p) => p.endMs === null || p.endMs > now - KEPT_MS);
    return this.played;
  }

  /**
   * Is this lane the one the sentence is credited to? True when no other lane carries it. When another lane's words in flight look
   * like the same sentence, that lane's final is waited for (bounded) first. A copy whose turn has already acted keeps the turn.
   */
  private async creditedHere(s: Final): Promise<boolean> {
    const flying = [...this.flight].some(([who, f]) => who !== s.who && this.now() - f.firstMs <= 5_000 && wordsOf(f.text).length >= 2 && overlapOf(f.text, s.text) === 'echo');
    if (flying && !this.copyOf(s)) {
      await new Promise<void>((r) => {
        const done = (): void => { this.finalWaiters.delete(check); this.deps.clock.clearTimeout(timer); r(); };
        const check = (): void => { if (this.copyOf(s)) done(); };
        const timer = this.deps.clock.setTimeout(done, TWO_LANE_WAIT_MS);
        this.finalWaiters.add(check);
      });
    }
    const other = this.copyOf(s);
    if (!other) return true;
    const rank = new Map<string, number>();
    for (const who of [s.who, other.who]) rank.set(who, await this.authority(who));
    const mine = creditedLane(s, other, (who) => rank.get(who) ?? -1) === s;
    const ot = other.turn;
    if (!mine) return false;
    if (!ot || ot.dead) return true;
    // The copy was heard first and already has the turn: it is taken back unless it has acted.
    if (ot.committed || ot.audio) return false;
    this.kill(ot);
    if (this.turn === ot) { this.turn = null; this.floor.free(); }
    return true;
  }
  private copyOf(s: Final): Final | null { return this.finals.find((f) => f !== s && onTwoLanes(f, s)) ?? null; }
  /** How much a person may ask for: their tools; -1 for someone the tenant gives no role. */
  private async authority(who: string): Promise<number> {
    const { call, policy } = this.deps;
    const role = await policy.roleOf(call, who).catch(() => null);
    if (role === null) return -1;
    return (await policy.toolsFor(call, { userId: who, role }).catch(() => [])).length;
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // One turn: decide, act, speak

  private kill(t: Turn): void { t.dead = true; this.unsuspend(t); }

  private open(s: Final, text: string, via: Via, recent: HeardLine[]): void {
    const turn: Turn = { who: s.who, via, text, sentence: { id: `${this.scope}/${s.id}`, who: s.who, text, atMs: s.endMs, via }, dead: false, suspended: null, committed: false, audio: false, line: null };
    s.turn = turn;
    this.turn = turn;
    this.floor.deciding(turn.who, via);
    void this.run(turn, recent)
      .catch((err: unknown) => this.trace('turn.error', { error: (err as Error).name }))
      .finally(() => { if (this.turn === turn) { this.turn = null; this.next(); } });
  }

  /** The floor is free: the waiting sentence, if it is still fresh; else the holder, the window or nobody. */
  private next(): void {
    const q = this.queued;
    this.queued = null;
    this.floor.free();
    this.armWindow();
    if (q && !this.closed && !this.floor.paused && this.now() - q.atMs <= QUEUE_KEEP_MS) this.open(q.s, q.s.text, q.via, q.recent);
  }

  private async run(turn: Turn, recent: HeardLine[]): Promise<void> {
    const { call, policy } = this.deps;
    const decision = await decide({ call, policy, sentence: turn.sentence, recent, lastAction: this.lastAction }, this.deps.decide);
    await this.settled(turn);
    if (turn.dead || this.closed) return;
    const write = await this.writeKey(turn, decision);
    const last = this.lastWrite.get(turn.who);
    if (write && last && last.key === write && this.now() - last.atMs < WRITE_REPEAT_MS) { this.trace('turn.write-repeat', {}); return; }
    if (turn.dead || this.closed) return;
    turn.committed = true; // while Act runs the turn is neither merged nor suspended: what it logs is said
    const result = await act({ call, policy, sentence: turn.sentence, decision, isCurrent: () => !turn.dead && !this.closed }, { now: () => this.now(), ...this.deps.act });
    if (write && result.tool && !result.skipped) this.lastWrite.set(turn.who, { key: write, atMs: this.now() });
    if (this.closed) return;
    const record = (said: SpeakResult | null): void => { try { this.deps.onTurn?.({ sentence: turn.sentence, decision, result, said }); } catch { /* the record never stops the turn */ } };
    if (result.effect === 'keep-listening') { turn.committed = false; this.waitForRest(turn); record(null); return; }
    turn.committed = result.tool !== null && (result.line !== null || result.effect !== null || result.action !== null);
    if (result.action) this.lastAction = result.action;
    if (result.effect === 'cancel') this.cancelAll(turn.who);
    if (result.effect === 'pause') this.pause(turn.who);
    if (result.effect === 'leave') { this.mouth.stopAll(); this.deps.onLeave?.(turn.who); }
    if (result.line === null || !result.tool) {
      // Milo did something for them without a line (a write): their window runs from now.
      if (result.action && !result.effect) this.floor.answered(turn.who, this.now());
      record(null);
      return;
    }
    turn.line = result.line;
    this.floor.speaking(turn.who, turn.via);
    const line: SpokenLine = { text: result.line, askedBy: turn.who, tool: result.tool, sentenceId: turn.sentence.id };
    turn.audio = true; // from here a new sentence is a new turn, and talking over him is a barge-in
    const said = await this.mouth.say({ call, policy: this.speakPolicy(), line, ...(result.logged ? { logged: { rowId: null } } : {}) });
    if (this.playing?.text === line.text) this.endPlaying(said.playEndMs ?? this.now());
    if (said.outcome !== 'not-logged' && !this.floor.paused) this.floor.answered(turn.who, said.playEndMs ?? this.now());
    record(said);
  }

  /** The same writing tool with the same arguments from the same person, moments after it ran: one request heard twice. */
  private async writeKey(turn: Turn, d: Decision): Promise<string | null> {
    if (d.kind !== 'tool' || d.core) return null;
    const tools = await this.deps.policy.toolsFor(this.deps.call, { userId: turn.who, role: d.role }).catch(() => []);
    return tools.find((t) => t.name === d.tool)?.writes ? `${d.tool}|${JSON.stringify(d.args)}` : null;
  }

  private waitForRest(turn: Turn): void {
    const old = this.waiting.get(turn.who);
    if (old) this.deps.clock.clearTimeout(old.timer);
    const timer = this.deps.clock.setTimeout(() => { if (this.waiting.get(turn.who)?.timer === timer) { this.waiting.delete(turn.who); this.trace('turn.rest-never-came', {}); } }, KEEP_LISTENING_MS);
    this.waiting.set(turn.who, { text: turn.text, via: turn.via, timer });
  }

  /** The tenant's log and money hold for a line; with the call's voice off no hold is asked for, so the line is posted and not said. */
  private speakPolicy(): Pick<TurnPolicy, 'logSpoken' | 'markSpoken' | 'holdSpeech'> {
    const p = this.deps.policy;
    if (this.deps.voiceOn?.() !== false) return p;
    return { logSpoken: (c, l) => p.logSpoken(c, l), ...(p.markSpoken ? { markSpoken: (c, id, l, o) => p.markSpoken!(c, id, l, o) } : {}), holdSpeech: async () => null };
  }

  /**
   * Milo never starts a line while a person is speaking. Before a line's first audio every mic is checked: someone speaking, it
   * waits for a gap (`SPEAKING_TAIL_MS` with no voice in any mic). No gap in `GAP_WAIT_MS`: a line nobody asked for (the fixed
   * cannot-help line) is dropped; an answer someone asked for stays queued up to `ANSWER_KEEP_MS`. Either way the line is already
   * in the log and the chat. Voice inside his last line's echo tail is his own, heard back, and holds nothing.
   */
  private async clearToStart(line: SpokenLine, signal: AbortSignal): Promise<{ go: boolean; waitedMs: number }> {
    const from = this.now();
    const asked = line.tool !== 'cannot_help';
    const lastEnd = this.played.reduce((m, p) => Math.max(m, p.endMs ?? -Infinity), -Infinity);
    let waiting = false; let told = false;
    try {
      for (;;) {
        const waitedMs = this.now() - from;
        if (signal.aborted || this.closed) return { go: false, waitedMs };
        const speakers = this.mics.speakingAt(this.now(), lastEnd + ECHO_TAIL_MS);
        if (!speakers.length) { if (waiting) this.trace('turn.speak.waited', { tool: line.tool, waitedMs }); return { go: true, waitedMs }; }
        if (!waiting) { waiting = true; this.gapWait = { askedBy: line.askedBy }; this.trace('turn.speak.wait', { tool: line.tool, speakers: speakers.length }); }
        if (waitedMs >= (asked ? ANSWER_KEEP_MS : GAP_WAIT_MS)) { this.trace('turn.speak.no-gap', { tool: line.tool, asked, waitedMs }); return { go: false, waitedMs }; }
        if (asked && !told && waitedMs >= GAP_WAIT_MS) { told = true; this.trace('turn.speak.still-waiting', { tool: line.tool, waitedMs }); }
        await new Promise<void>((r) => { this.deps.clock.setTimeout(() => r(), GAP_POLL_MS); });
      }
    } finally { this.gapWait = null; }
  }

  private onPlay(ev: { kind: 'start' | 'end'; line: SpokenLine; atMs: number }): void {
    if (ev.kind === 'start') { this.playing = { text: ev.line.text, startMs: ev.atMs, endMs: null }; this.played.push(this.playing); return; }
    this.endPlaying(ev.atMs);
  }
  private endPlaying(atMs: number): void {
    if (this.playing) { this.playing.endMs = atMs; this.playing = null; }
  }

  /** Someone talks over Milo: the line stops where it is (Speak marks it `partly`); the asker's window runs from now. */
  private bargeIn(userId: string): void {
    if (!this.playing) return;
    const t = this.turn;
    this.trace('turn.barge-in', { byAsker: t?.who === userId });
    this.endPlaying(this.now() + VOICE_FRAME_MS);
    this.mouth.stopAll();
    if (t && t.audio && !t.dead) this.floor.answered(t.who, this.now());
    this.emit('drop', { userId: t?.who ?? userId, reason: 'barge-in', atMs: this.now() });
  }

  private cancelAll(by: string): void {
    this.mouth.stopAll();
    this.endPlaying(this.now());
    for (const w of this.waiting.values()) this.deps.clock.clearTimeout(w.timer);
    this.waiting.clear();
    this.queued = null;
    this.floor.endWindow();
    this.emit('drop', { userId: by, reason: 'stop', atMs: this.now() });
  }

  private pause(by: string): void {
    this.cancelAll(by);
    this.floor.paused = true;
    this.floor.dropHold(this.floor.holderId ?? '');
    this.trace('turn.paused', {});
    this.deps.onPause?.(by);
  }
  /** Listen again (a named request while paused, or the tenant's own resume). */
  resume(): void { if (!this.floor.paused) return; this.floor.paused = false; this.trace('turn.resumed', {}); this.floor.tell(); }

  private armWindow(): void {
    if (this.windowTimer !== null) { this.deps.clock.clearTimeout(this.windowTimer); this.windowTimer = null; }
    const s = this.floor.state();
    if (s.phase !== 'follow-up') return;
    this.windowTimer = this.deps.clock.setTimeout(() => { this.windowTimer = null; this.floor.tell(); }, Math.max(0, s.untilMs - this.now()) + 1);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The hold button, "Have Milo ask", people coming and going

  async holdPress(userId: string): Promise<HoldResult> {
    if (this.closed || this.floor.paused) return { ok: false, reason: 'not-running' };
    if (this.floor.holderId === userId) return { ok: false, reason: 'already-holding' };
    const { call, policy } = this.deps;
    const role = await policy.roleOf(call, userId).catch(() => null);
    if (role === null || !policy.mayHold(call, role)) return { ok: false, reason: 'not-admitted' };
    const busy = this.floor.holderId ?? this.floor.busyWith;
    if (busy && busy !== userId) return { ok: false, reason: 'busy' };
    if (this.playing) this.bargeIn(userId); // they want his ear, not his voice
    this.floor.hold(userId);
    this.holdTimer = this.deps.clock.setTimeout(() => this.holdRelease(userId), HOLD_MAX_MS);
    return { ok: true };
  }
  holdRelease(userId: string): void {
    if (this.floor.holderId !== userId) return;
    if (this.holdTimer !== null) { this.deps.clock.clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.floor.release(userId);
  }
  holdCancel(userId: string): void {
    if (this.floor.holderId !== userId && !this.floor.holding(userId)) return;
    if (this.holdTimer !== null) { this.deps.clock.clearTimeout(this.holdTimer); this.holdTimer = null; }
    const t = this.turn;
    if (t && t.who === userId && t.via === 'hold') { this.kill(t); if (t.audio) this.mouth.stopAll(); }
    this.floor.dropHold(userId);
    this.emit('drop', { userId, reason: 'hold-cancel', atMs: this.now() });
  }

  /** Server-approved words (already logged and posted by whoever asked), said now through the same mouth, outside any turn. */
  sayLine(text: string, askedBy: string): Promise<SpeakResult> {
    this.sayNo += 1;
    const line: SpokenLine = { text, askedBy, tool: 'say', sentenceId: `say:${this.sayNo}` };
    return this.mouth.say({ call: this.deps.call, policy: this.speakPolicy(), line, logged: { rowId: null } }).then((said) => {
      if (this.playing?.text === text) this.endPlaying(said.playEndMs ?? this.now());
      return said;
    });
  }
  say(_id: string, text: string, ended: (transcript: string | null) => void): boolean {
    if (this.closed || this.floor.paused) return false;
    void this.sayLine(text, '').then((r) => ended(r.outcome === 'spoken' ? text : null), () => ended(null));
    return true;
  }

  personJoined(userId: string, speakerName: string): void {
    if (this.closed) return;
    this.joined.add(userId);
    this.deps.listening?.open(userId, speakerName).catch((e: unknown) => this.trace('turn.lane.error', { userId, error: (e as Error).name }));
  }
  personLeft(userId: string): void {
    this.joined.delete(userId);
    this.deps.listening?.closeLane(userId);
    this.mics.forget(userId);
    this.flight.delete(userId);
    this.lastOnset.delete(userId);
    const w = this.waiting.get(userId);
    if (w) { this.deps.clock.clearTimeout(w.timer); this.waiting.delete(userId); }
    if (this.queued?.s.who === userId) this.queued = null;
    if (this.floor.holding(userId)) this.holdCancel(userId);
    if (this.turn?.who === userId && !this.turn.committed) this.kill(this.turn);
    this.floor.endWindow(userId);
  }

  /** Stop listening and speaking; resolves when the listening side is closed. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.mouth.stopAll();
    if (this.turn) this.kill(this.turn);
    for (const w of this.waiting.values()) this.deps.clock.clearTimeout(w.timer);
    this.waiting.clear();
    for (const w of [...this.finalWaiters]) w();
    if (this.holdTimer !== null) this.deps.clock.clearTimeout(this.holdTimer);
    if (this.windowTimer !== null) this.deps.clock.clearTimeout(this.windowTimer);
    for (const off of this.offs.splice(0)) off();
    this.closing = (this.deps.listening?.close() ?? Promise.resolve()).catch(() => undefined);
    return this.closing;
  }
}

// Hands-free router (lane B): the one floor, on a fake clock with a scripted listening side and rules (fakes of lanes A and C).
import { Router, ROUTE_GIVE_UP_MS } from '../handsfree/router.js';
import { HANDSFREE, type RouteState } from '../handsfree/types.js';
import { FakeClock, FakeListening, FakeRelay, FakeRules, FakeTalking, frame, settle } from './handsfree-fakes.js';

const UNA = 'u-una', HUGO = 'u-hugo';
/** A plain echo rule for these tests (the real one is lane C's, rules.ts): the heard words inside Milo's, in order, are his echo. */
const norm = (t: string) => t.toLowerCase().replace(/[^a-z' ]+/g, ' ').trim().replace(/\s+/g, ' ');
const overlapOf = (heard: string, saying: string): 'echo' | 'barge-in' => (norm(heard) && ` ${norm(saying)} `.includes(` ${norm(heard)} `) ? 'echo' : 'barge-in');
const T_UNA = 1, T_HUGO = 2, T_MILO = 9;

function world() {
  const clock = new FakeClock();
  const listening = new FakeListening(clock);
  const rules = new FakeRules();
  const talking = new FakeTalking();
  const relay = new FakeRelay();
  const work = { open: false };
  const router = new Router({ clock, call: { callId: 'c1', lobby: null, tenant: 't' }, rules, listening, talking, relay, working: () => work.open });
  const states: RouteState[] = [];
  const drops: string[] = [];
  router.on('state', (s) => states.push(s));
  router.on('drop', (d) => drops.push(d.reason));
  /** One 100 ms step: the given people speak a frame, then the mixer ticks. */
  const step = (who: Array<[string, number]> = []) => { clock.advance(100); for (const [u, t] of who) listening.speak(u, t); router.tick(); };
  const talk = (u: string, t: number, n: number) => { for (let i = 0; i < n; i++) step([[u, t]]); };
  const quiet = (n: number) => { for (let i = 0; i < n; i++) step(); };
  /** Milo says `n` frames (the last marked last). */
  const milo = (n: number, say?: string) => { for (let i = 0; i < n; i++) { router.outputAudio(frame(T_MILO), i === n - 1, say); } };
  const name = (u: string, sid: string, startMs: number, nameEndMs = clock.nowMs()) => listening.emit('name', { userId: u, sentenceId: sid, sentenceStartMs: startMs, nameEndMs, textSoFar: 'Milo' });
  const sentence = (u: string, sid: string, text: string, named = true, startMs = 0) => listening.emit('sentence', { userId: u, sentenceId: sid, text, startMs, endMs: clock.nowMs(), named });
  const words = (u: string, sid: string, delta: string) => listening.emit('words', { userId: u, sentenceId: sid, delta, atMs: clock.nowMs() });
  return { clock, listening, rules, talking, relay, router, states, drops, step, talk, quiet, milo, name, sentence, words, work };
}

describe('hands-free router', () => {
  it('sends nothing of anyone before a trigger (idle ticks carry only silence)', () => {
    const w = world();
    w.talk(UNA, T_UNA, 30);
    w.talk(HUGO, T_HUGO, 30);
    expect(w.talking.heard().every((t) => t === 0)).toBe(true);
    expect(w.router.state()).toEqual({ phase: 'idle' });
    expect(w.talking.asker).toBeNull();
  });

  it('replays the pre-roll from the sentence start, then live, within 1.2x and 5 s ahead', async () => {
    const w = world();
    w.quiet(50);
    const start = w.clock.nowMs();
    w.talk(UNA, T_UNA, 40); // 4 s of speech before the name is detected
    w.name(UNA, 's1', start);
    await settle();
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA, via: 'name' });
    expect(w.talking.asker).toBe(UNA);
    const before = w.talking.ticks.length;
    w.talk(UNA, T_UNA, 60);
    const routed = w.talking.ticks.slice(before);
    // First tick: the burst (at most 5 s of audio); every later window keeps within 1.2x real time plus the 5 s burst.
    expect(routed[0]!.length * 100).toBeLessThanOrEqual(HANDSFREE.replayBurstMs);
    expect(routed[0]!.length).toBeGreaterThanOrEqual(30);
    let sent = 0;
    routed.forEach((t, i) => { sent += t.length * 100; expect(sent).toBeLessThanOrEqual(HANDSFREE.replayBurstMs + HANDSFREE.replayMaxRate * (i + 1) * 100); });
    // Only Una's frames, in order, all 100 frames she spoke (40 pre-roll + 60 live), never anyone else's.
    const tags = routed.flat().map((b) => b[0]);
    expect(tags.every((t) => t === T_UNA)).toBe(true);
    expect(tags.length).toBeGreaterThanOrEqual(95);
  });

  it('pays a replay lead back on idle ticks (nothing sent until the bucket is full again)', async () => {
    const w = world();
    const start = w.clock.nowMs();
    w.talk(UNA, T_UNA, 45);
    w.name(UNA, 's1', start); await settle();
    w.step(); // the burst
    w.router.holdCancel(UNA); // not holding: no-op
    w.router.personLeft(UNA); // floor freed
    const before = w.talking.ticks.length;
    w.quiet(5);
    expect(w.talking.ticks.slice(before).every((t) => t.length === 0)).toBe(true);
  });

  it('holds Milo\'s answer for the verdict and relays it on request', async () => {
    const w = world();
    let resolve!: (v: { kind: 'request' }) => void;
    w.rules.verdictFor = () => new Promise((r) => { resolve = r; });
    w.talk(UNA, T_UNA, 10);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, what time is it?');
    w.router.turnEnded();
    expect(w.router.state()).toMatchObject({ phase: 'answering', userId: UNA });
    w.milo(3);
    expect(w.relay.pushed).toHaveLength(0);
    resolve({ kind: 'request' }); await settle();
    expect(w.relay.pushed.map((p) => p.tag)).toEqual([T_MILO, T_MILO, T_MILO]);
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
  });

  it('drops a mention: nothing relayed, the floor goes back to idle, the session talks on unheard', async () => {
    const w = world();
    w.rules.verdictFor = () => ({ kind: 'mention' });
    w.talk(UNA, T_UNA, 10);
    w.name(UNA, 's1', 0); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.sentence(UNA, 's1', "I saw Milo's summary"); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.router.outputAudio(frame(T_MILO), true);
    expect(w.relay.pushed).toHaveLength(0);
    expect(w.drops).toEqual(['mention']);
    expect(w.router.state()).toEqual({ phase: 'idle' });
  });

  it('drops the answer when no verdict comes within 800 ms of its first frame', async () => {
    const w = world();
    w.rules.verdictFor = () => new Promise(() => undefined);
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, hi');
    w.router.outputAudio(frame(T_MILO), false);
    w.clock.advance(HANDSFREE.verdictWaitMs);
    expect(w.drops).toEqual(['verdict-timeout']);
    expect(w.relay.pushed).toHaveLength(0);
  });

  it('a hold that runs out while the person is still talking drops the early reply but keeps the turn (once)', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.router.outputAudio(frame(T_MILO), false); // the provider answered a pause mid-sentence
    w.words(UNA, 's1', 'Milo, add a note that');
    w.clock.advance(HANDSFREE.verdictWaitMs);
    expect(w.drops).toEqual([]);
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA });
    expect(w.relay.pushed).toHaveLength(0);
    w.router.outputAudio(frame(T_MILO), true); // the rest of the early reply: unheard
    w.sentence(UNA, 's1', 'Milo, add a note that we finished.'); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    expect(w.relay.pushed).toHaveLength(1);
  });

  it('a fixed verdict says the server line and drops the session\'s own words', async () => {
    const w = world();
    w.rules.verdictFor = () => ({ kind: 'fixed', line: 'You have twelve minutes left.' });
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.sentence(UNA, 's1', 'Milo, how long is left?'); await settle();
    expect(w.talking.said).toEqual(['You have twelve minutes left.']);
    expect(w.relay.pushed).toHaveLength(0);
    expect(w.talking.asker).toBeNull();
  });

  it('a fixed verdict goes to the held-text path when the orchestrator gives one (for the asker, never the session)', async () => {
    const clock = new FakeClock();
    const listening = new FakeListening(clock);
    const rules = new FakeRules();
    rules.verdictFor = () => ({ kind: 'fixed', line: 'Ten minutes left.' });
    const talking = new FakeTalking();
    const fixed: Array<[string, string, boolean]> = [];
    new Router({ clock, call: { callId: 'c1', lobby: null, tenant: 't' }, rules, listening, talking, relay: new FakeRelay(), sayFixed: (u, l, a) => fixed.push([u, l, a]) });
    listening.emit('name', { userId: UNA, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 0, textSoFar: 'Milo' }); await settle();
    listening.emit('sentence', { userId: UNA, sentenceId: 's1', text: 'Milo, how long?', startMs: 0, endMs: 0, named: true }); await settle();
    // It answers the routed turn the session is hearing: sent without waiting behind that turn or the session's reply to it.
    expect(fixed).toEqual([[UNA, 'Ten minutes left.', true]]);
    expect(talking.said).toEqual([]);
  });

  it('a follow-up routes only the asker, needs no name, and closes 10 s after the last relayed frame', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.quiet(1); // the pre-roll goes
    w.sentence(UNA, 's1', 'Milo, capital of France?'); await settle();
    w.milo(2);
    const s = w.router.state();
    expect(s).toMatchObject({ phase: 'follow-up', userId: UNA });
    const before = w.talking.ticks.length;
    w.talk(HUGO, T_HUGO, 5);
    w.words(UNA, 's2', 'And Germany?');
    w.talk(UNA, T_UNA, 5);
    const tags = w.talking.ticks.slice(before).flat().map((b) => b[0]);
    expect(tags).not.toContain(T_HUGO);
    expect(tags.filter((t) => t === T_UNA)).toHaveLength(5);
    w.sentence(UNA, 's2', 'And Germany?', false); await settle();
    expect(w.rules.verdicts.at(-1)).toEqual({ userId: UNA, text: 'And Germany?', via: 'follow-up' });
    w.milo(1);
    expect(w.relay.pushed).toHaveLength(3);
    const until = (w.router.state() as { untilMs: number }).untilMs;
    w.clock.advance(until - w.clock.nowMs() - 1);
    expect(w.router.state().phase).toBe('follow-up');
    w.clock.advance(1);
    expect(w.router.state()).toEqual({ phase: 'idle' });
  });

  it("someone else saying the name inside the asker's follow-up window takes the floor at once (the window is not a hold)", async () => {
    const w = world();
    const queued: string[] = [];
    w.router.on('queued', (q) => queued.push(q.userId));
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.quiet(1);
    w.sentence(UNA, 's1', 'Milo, capital of France?'); await settle();
    w.milo(2);
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
    w.talk(HUGO, T_HUGO, 3);
    w.name(HUGO, 'h1', 0); await settle();
    expect(queued).toEqual([]);
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: HUGO, via: 'name' });
  });

  it('an aside inside the window is dropped and closes the window', async () => {
    const w = world();
    w.rules.verdictFor = (s) => (s.via === 'follow-up' ? { kind: 'aside' } : { kind: 'request' });
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, hi'); await settle();
    w.milo(1);
    w.clock.advance(200); // his voice has played out
    w.words(UNA, 's2', 'Hugo, can you share');
    w.router.outputAudio(frame(T_MILO), false);
    w.sentence(UNA, 's2', 'Hugo, can you share your screen?', false); await settle();
    expect(w.drops).toEqual(['aside']);
    expect(w.router.state()).toEqual({ phase: 'idle' });
    expect(w.relay.pushed).toHaveLength(1);
  });

  it('a second "Milo" while the floor is held is queued once (latest wins), never mixed, and replayed after', async () => {
    const w = world();
    const queued: string[] = [];
    w.router.on('queued', (q) => queued.push(q.userId));
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, one'); await settle();
    const hugoStart = w.clock.nowMs();
    w.talk(HUGO, T_HUGO, 5);
    w.name(HUGO, 'h1', hugoStart); await settle();
    w.name(HUGO, 'h2', hugoStart + 200); await settle();
    expect(queued).toEqual([HUGO, HUGO]);
    // While Una holds the floor the session hears no Hugo.
    expect(w.talking.heard()).not.toContain(T_HUGO);
    w.milo(2); // Una's answer ends: the floor goes to the queued sentence, not to Una's window
    await settle();
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: HUGO });
    expect(w.talking.asker).toBe(HUGO);
    const before = w.talking.ticks.length;
    w.step([[UNA, T_UNA]]);
    const tags = w.talking.ticks.slice(before).flat().map((b) => b[0]);
    expect(tags).not.toContain(T_UNA);
    expect(tags.filter((t) => t === T_HUGO).length).toBeGreaterThanOrEqual(3); // h2 from +200 ms
    // No tick ever carried two people.
    for (const t of w.talking.ticks) expect(new Set(t.map((b) => b[0]).filter((x) => x !== 0)).size).toBeLessThanOrEqual(1);
  });

  it("a queued sentence is replayed only to its end (not what its speaker says after it), then the session hears quiet", async () => {
    const w = world();
    const T_LATER = 7;
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, one'); await settle();
    const hugoStart = w.clock.nowMs();
    w.talk(HUGO, T_HUGO, 20);
    w.name(HUGO, 'h1', hugoStart); await settle();
    w.sentence(HUGO, 'h1', 'Milo, and the second thing?', true, hugoStart); await settle();
    w.talk(HUGO, T_LATER, 30); // Hugo goes on talking to the room
    w.milo(2); // Una's answer ends: the queued sentence gets the floor
    await settle();
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: HUGO });
    const before = w.talking.ticks.length;
    for (let i = 0; i < 30; i++) w.step([[HUGO, T_LATER]]);
    const tags = w.talking.ticks.slice(before).flat().map((b) => b[0]);
    // All of the sentence (the fake stamps a frame where its 100 ms ends, so the last one sits on the sentence's end), nothing after.
    expect(tags.filter((t) => t === T_HUGO).length).toBeGreaterThanOrEqual(19);
    expect(tags).not.toContain(T_LATER);
    expect(tags.slice(-5).every((t) => t === 0)).toBe(true);
  });

  it('a queued "Milo" older than 8 s is let go when the floor frees (stale words are not replayed)', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, tell me a long story'); await settle();
    const hugoStart = w.clock.nowMs();
    w.talk(HUGO, T_HUGO, 10);
    w.name(HUGO, 'h1', hugoStart); await settle();
    for (let i = 0; i < 85; i++) { w.router.outputAudio(frame(T_MILO), false); w.step(); } // 8.5 s of answer
    w.router.outputAudio(frame(T_MILO), true);
    await settle();
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
    expect(w.talking.heard()).not.toContain(T_HUGO);
  });

  it("an answer whose last frame never comes ends 2 s after its last frame: the relay is closed and the asker's window opens", async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, what time is it?'); await settle();
    w.router.turnEnded();
    for (let i = 0; i < 3; i++) w.router.outputAudio(frame(T_MILO), false);
    w.quiet(HANDSFREE.answerQuietMs / 100 - 1);
    expect(w.router.state().phase).toBe('answering');
    w.quiet(2);
    expect(w.relay.pushed.at(-1)).toMatchObject({ last: true });
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
  });

  it('an utterance cut off upstream (its last frame never reaches the router) does not swallow the next answer', async () => {
    const w = world();
    w.rules.verdictFor = (x) => (x.userId === UNA ? { kind: 'mention' } : { kind: 'request' });
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.sentence(UNA, 's1', "I saw Milo's notes"); await settle(); // dropped; the session talks on, its tail never arrives
    w.quiet(25);
    w.talk(HUGO, T_HUGO, 3);
    w.name(HUGO, 'h1', w.clock.nowMs() - 300); await settle();
    w.sentence(HUGO, 'h1', 'Milo, what time is it?'); await settle();
    w.milo(2);
    expect(w.relay.pushed.map((p) => p.tag)).toEqual([T_MILO, T_MILO]);
  });

  it('answering with no frame at all (dropped upstream) frees the floor after 2 s, but not while a tool call is open', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, add a task'); await settle();
    w.work.open = true;
    w.router.turnEnded();
    w.quiet(40);
    expect(w.router.state().phase).toBe('answering');
    w.work.open = false;
    w.quiet(21);
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
  });

  it('a routed turn whose sentence never lands is given up 12 s after the last words (not 12 s after the route began)', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    for (let i = 0; i < 15; i++) { w.quiet(10); w.words(UNA, 's1', ' and'); } // a long question: 15 s of words
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA });
    w.clock.advance(ROUTE_GIVE_UP_MS - 1);
    expect(w.router.state().phase).toBe('routing');
    w.clock.advance(2);
    expect(w.router.state()).toEqual({ phase: 'idle' });
    expect(w.drops).toEqual(['stop']);
  });

  it('barge-in clears the relay inside the frame that carried it; echo does not', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, tell me a story'); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.router.outputText('Once upon a time');
    w.rules.overlapFor = (heard) => (heard.includes('upon') ? 'echo' : 'barge-in');
    w.words(HUGO, 'h1', 'upon a time');
    expect(w.relay.clears).toBe(0);
    // A name in Milo's own voice coming back through a mic triggers nothing while he plays.
    w.name(HUGO, 'h1', 0); await settle();
    expect(w.router.state()).toMatchObject({ userId: UNA });
    w.words(HUGO, 'h2', 'stop');
    expect(w.relay.clears).toBe(1);
    expect(w.drops).toEqual(['barge-in']);
    // The session talks on unheard to the end of its utterance.
    w.router.outputAudio(frame(T_MILO), false);
    w.router.outputAudio(frame(T_MILO), true);
    expect(w.relay.pushed).toHaveLength(1);
    // And the next question is routed and answered.
    w.name(HUGO, 'h3', w.clock.nowMs()); await settle();
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: HUGO });
    w.sentence(HUGO, 'h3', 'Milo, what time is it?'); await settle();
    w.milo(1);
    expect(w.relay.pushed).toHaveLength(2);
  });

  it("Milo's words held for the verdict still count as what he is saying once they play (his echo is not a barge-in)", async () => {
    const w = world();
    w.rules.overlapFor = overlapOf;
    let resolve!: (v: { kind: 'request' }) => void;
    w.rules.verdictFor = () => new Promise((r) => { resolve = r; });
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, what is blocking auth?');
    w.router.outputText('The cookie bug is blocking auth.', true);
    w.router.outputAudio(frame(T_MILO), false);
    w.router.outputAudio(frame(T_MILO), false);
    resolve({ kind: 'request' }); await settle();
    expect(w.relay.pushed).toHaveLength(2);
    w.words(HUGO, 'h1', 'the cookie bug is blocking');
    expect(w.drops).toEqual([]);
    expect(w.relay.clears).toBe(0);
  });

  it("Milo's voice heard back after his last frame (the echo tail) is not a follow-up: his reply to it is dropped and the window kept", async () => {
    const w = world();
    w.rules.overlapFor = overlapOf;
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, what is blocking auth?'); await settle();
    w.router.outputText('The cookie bug is blocking auth.', true);
    w.milo(3);
    const window = w.router.state();
    expect(window).toMatchObject({ phase: 'follow-up', userId: UNA });
    const echoStart = w.clock.nowMs() + 100;
    w.quiet(6); // past the last frame's playout, inside the tail
    expect(w.router.playing()).toBe(false);
    w.words(UNA, 'e1', 'the cookie bug is');
    w.router.outputAudio(frame(T_MILO), false); // the session answering its own echo
    w.sentence(UNA, 'e1', 'The cookie bug is blocking auth.', false, echoStart); await settle();
    w.router.outputAudio(frame(T_MILO), true);
    expect(w.relay.pushed).toHaveLength(3);
    expect(w.rules.verdicts.map((v) => v.text)).not.toContain('The cookie bug is blocking auth.');
    expect(w.router.state()).toEqual(window);
    // A real follow-up in the same window is still heard and answered.
    w.words(UNA, 'f1', 'And who owns it?');
    w.sentence(UNA, 'f1', 'And who owns it?', false, w.clock.nowMs()); await settle();
    w.milo(1);
    expect(w.relay.pushed).toHaveLength(4);
  });

  it("a name in Milo's echo tail (his own words naming himself) triggers nothing", async () => {
    const w = world();
    w.rules.overlapFor = overlapOf;
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, who are you?'); await settle();
    w.router.outputText("I'm Milo, I take the notes.", true);
    w.milo(2);
    w.quiet(5); // past the last frame's playout, inside the tail
    expect(w.router.playing()).toBe(false);
    // Hugo's open speakers: the name comes back in his mic.
    w.listening.emit('name', { userId: HUGO, sentenceId: 'h1', sentenceStartMs: w.clock.nowMs() - 600, nameEndMs: w.clock.nowMs(), textSoFar: "I'm Milo, I take" });
    await settle();
    expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
  });

  it('the asker barging in keeps the floor; the rest of the old utterance is never relayed', async () => {
    const w = world();
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0); await settle();
    w.sentence(UNA, 's1', 'Milo, tell me a story'); await settle();
    w.router.outputAudio(frame(T_MILO), false);
    w.words(UNA, 's2', 'okay stop');
    expect(w.relay.clears).toBe(1);
    expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA, via: 'follow-up' });
    w.router.outputAudio(frame(T_MILO), true); // tail of the old answer
    expect(w.relay.pushed).toHaveLength(1);
  });

  it('askedBy follows the routed person on every state change', async () => {
    const w = world();
    w.talk(HUGO, T_HUGO, 5);
    w.name(HUGO, 'h1', 0); await settle();
    // Routed but not yet judged: the asker is pending (the talking side holds tool calls until the verdict).
    expect([w.talking.asker, w.talking.pending]).toEqual([HUGO, true]);
    w.sentence(HUGO, 'h1', 'Milo, add a task'); await settle();
    expect([w.talking.asker, w.talking.pending]).toEqual([HUGO, false]);
    w.router.turnEnded();
    expect(w.talking.asker).toBe(HUGO);
    w.milo(1);
    expect(w.talking.asker).toBe(HUGO); // follow-up window
    w.clock.advance(HANDSFREE.followUpMs + 200);
    expect(w.talking.asker).toBeNull();
    expect(w.talking.askers.every((a) => a === HUGO || a === null)).toBe(true);
  });

  it('the asker is confirmed only by a request verdict: a mention or an aside leaves nobody to attribute a tool call to', async () => {
    const w = world();
    w.rules.verdictFor = (x) => (x.text.includes('summary') ? { kind: 'mention' } : { kind: 'aside' });
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 'u1', 0); await settle();
    expect([w.talking.asker, w.talking.pending]).toEqual([UNA, true]);
    w.sentence(UNA, 'u1', "Milo's summary is wrong, delete that item"); await settle();
    expect(w.talking.asker).toBeNull();
    // A hold is a request by definition: confirmed at once.
    expect(await w.router.holdPress(UNA)).toEqual({ ok: true });
    expect([w.talking.asker, w.talking.pending]).toEqual([UNA, false]);
    expect(w.talking.askers.filter((a) => a !== null).length).toBeGreaterThan(0);
  });

  it('a person admitted to fixed lines is never routed; their named sentence gets the server line only', async () => {
    const w = world();
    w.rules.admission.set(UNA, 'fixed-lines');
    w.rules.verdictFor = () => ({ kind: 'fixed', line: 'Ten minutes left.' });
    w.talk(UNA, T_UNA, 10);
    w.name(UNA, 's1', 0); await settle();
    w.talk(UNA, T_UNA, 10);
    w.sentence(UNA, 's1', 'Milo, how long is left?'); await settle();
    expect(w.talking.heard()).not.toContain(T_UNA);
    expect(w.talking.said).toEqual(['Ten minutes left.']);
    expect(w.router.state()).toEqual({ phase: 'idle' });
  });

  it('denied or slow admission routes nothing', async () => {
    const w = world();
    w.rules.admit = () => new Promise(() => undefined);
    w.talk(UNA, T_UNA, 5);
    w.name(UNA, 's1', 0);
    w.clock.advance(HANDSFREE.admitWaitMs); await settle();
    w.talk(UNA, T_UNA, 5);
    expect(w.talking.heard()).not.toContain(T_UNA);
    expect(w.router.state()).toEqual({ phase: 'idle' });
  });

  describe('early release on a provisional request (review 1, item 9)', () => {
    it('relays from the first output frame when the words so far are a provisional request; the asker stays pending until the final verdict', async () => {
      const w = world();
      let resolve!: (v: { kind: 'request' }) => void;
      w.rules.verdictFor = () => new Promise((r) => { resolve = r; });
      w.rules.provisionalFor = (s) => (s.text.startsWith('Milo, what') ? 'request' : null);
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.words(UNA, 's1', "Milo, what's the capital of France");
      w.router.turnEnded();
      w.milo(2);
      expect(w.relay.pushed.map((p) => p.tag)).toEqual([T_MILO, T_MILO]);
      expect(w.talking.asker).toBe(UNA);
      expect(w.talking.pending).toBe(true); // tool calls still wait for the final verdict
      expect(w.rules.provisionals[0]).toEqual({ userId: UNA, text: "Milo, what's the capital of France", via: 'name' });
      w.clock.advance(HANDSFREE.verdictWaitMs + 100); // no verdict timeout once released
      expect(w.drops).toEqual([]);
      w.sentence(UNA, 's1', "Milo, what's the capital of France?");
      resolve({ kind: 'request' }); await settle();
      expect(w.talking.pending).toBe(false);
      expect(w.talking.asker).toBe(UNA);
    });

    it('uses the final text when the sentence is already final, and holds as before when there is no provisional request', async () => {
      const w = world();
      w.rules.verdictFor = () => new Promise(() => undefined);
      w.rules.provisionalFor = () => null;
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.sentence(UNA, 's1', 'Milo, hi');
      w.milo(2);
      expect(w.relay.pushed).toHaveLength(0);
      expect(new Set(w.rules.provisionals.map((p) => p.text))).toEqual(new Set(['Milo, hi']));
    });

    it('frames held on too few words are released once the words so far (or the final text) make a provisional request', async () => {
      const w = world();
      w.rules.verdictFor = () => new Promise(() => undefined);
      w.rules.provisionalFor = (s) => (s.text.includes('capital') ? 'request' : null);
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.words(UNA, 's1', 'Milo, what');
      w.milo(2);
      expect(w.relay.pushed).toHaveLength(0);
      w.sentence(UNA, 's1', "Milo, what's the capital of Peru?");
      expect(w.relay.pushed).toHaveLength(2);
      w.clock.advance(HANDSFREE.verdictWaitMs + 100);
      expect(w.drops).toEqual([]);
    });

    it('a final mention after an early release clears the relay and frees the floor', async () => {
      const w = world();
      let resolve!: (v: { kind: 'mention' }) => void;
      w.rules.verdictFor = () => new Promise((r) => { resolve = r; });
      w.rules.provisionalFor = () => 'request';
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.words(UNA, 's1', 'Milo, what');
      w.milo(2);
      expect(w.relay.pushed).toHaveLength(2);
      w.sentence(UNA, 's1', 'Milo, what a day it was yesterday.');
      resolve({ kind: 'mention' }); await settle();
      expect(w.relay.clears).toBe(1);
      expect(w.drops).toEqual(['mention']);
      expect(w.router.state()).toEqual({ phase: 'idle' });
      expect(w.talking.asker).toBeNull();
      w.router.outputAudio(frame(T_MILO), true);
      expect(w.relay.pushed).toHaveLength(2); // the rest is unheard
    });

    it('an early answer that finished before a final mention does not leave its window open', async () => {
      const w = world();
      let resolve!: (v: { kind: 'mention' }) => void;
      w.rules.verdictFor = () => new Promise((r) => { resolve = r; });
      w.rules.provisionalFor = () => 'request';
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.words(UNA, 's1', 'Milo, what');
      w.milo(3);
      expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
      w.sentence(UNA, 's1', 'Milo, what a day.');
      resolve({ kind: 'mention' }); await settle();
      expect(w.router.state()).toEqual({ phase: 'idle' });
      expect(w.talking.asker).toBeNull();
    });

    it('a follow-up turn warms the asker\'s admission so its early verdict can use it', async () => {
      const w = world();
      w.rules.provisionalFor = () => 'request';
      w.talk(UNA, T_UNA, 10);
      w.name(UNA, 's1', 0); await settle();
      w.sentence(UNA, 's1', 'Milo, what is two plus two?'); await settle();
      w.milo(3);
      expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
      w.quiet(5); // his voice has played out
      const admits = w.rules.admits;
      w.words(UNA, 's2', 'And three');
      expect(w.rules.admits).toBe(admits + 1);
    });
  });

  describe('barge-in by voice: the relay pauses on a voiced onset in a mic that is not Milo\'s echo (review 1, item 8)', () => {
    /** A 100 ms frame of a square wave at `amp` (RMS = amp). */
    const tone = (amp: number): Buffer => { const b = Buffer.alloc(HANDSFREE.frameBytes); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2); return b; };
    /** Milo's loudness, frame by frame: speech with short dips, and a 400 ms pause at frames 20-23. */
    const MILO_AMPS = Array.from({ length: 50 }, (_, i) => (i >= 20 && i < 24 ? 0 : i % 4 === 3 ? 400 : 2_500 + (i % 5) * 300));

    /** Una asked; Milo answers 5 s (relayed at once, playing out in real time). */
    async function answering() {
      const w = world();
      w.talk(UNA, T_UNA, 5);
      w.name(UNA, 's1', 0); await settle();
      w.sentence(UNA, 's1', 'Milo, tell me a story'); await settle();
      const t0 = w.clock.nowMs();
      MILO_AMPS.forEach((a, i) => w.router.outputAudio(tone(a), i === MILO_AMPS.length - 1));
      w.router.outputText('Once upon a time there was a fox');
      /** One 100 ms step with Hugo's mic at `amp`. */
      const hugo = (amp: number) => { w.clock.advance(100); w.listening.placed(HUGO, tone(amp), w.clock.nowMs()); w.router.tick(); };
      /** What Milo's playout put in a mic `lag` frames later, scaled (an open speaker). */
      const leak = (lag: number) => MILO_AMPS[Math.round((w.clock.nowMs() - t0) / 100) - lag] ?? 0;
      return { ...w, t0, hugo, leak };
    }

    it('a clean mic\'s 200 ms of voice pauses the relay (not cleared for good); words that talk over him confirm it', async () => {
      const w = await answering();
      expect(w.relay.pushed).toHaveLength(MILO_AMPS.length);
      for (let i = 0; i < 25; i++) w.hugo(0);
      expect(w.relay.clears).toBe(0);
      w.hugo(3_000);
      expect(w.relay.clears).toBe(0); // 100 ms is not an onset
      w.hugo(3_000);
      expect(w.relay.clears).toBe(1); // paused at 200 ms
      expect(w.drops).toEqual([]);
      expect(w.router.playing()).toBe(true);
      w.rules.overlapFor = () => 'barge-in';
      w.words(HUGO, 'h1', 'hang on a second');
      expect(w.drops).toEqual(['barge-in']);
      const pushed = w.relay.pushed.length;
      w.clock.advance(3_000);
      w.router.tick();
      expect(w.relay.pushed).toHaveLength(pushed); // what was paused is never played
    });

    it('his own words heard back (echo) resume the relay where it paused', async () => {
      const w = await answering();
      for (let i = 0; i < 25; i++) w.hugo(0);
      w.hugo(3_000); w.hugo(3_000);
      expect(w.relay.clears).toBe(1);
      const before = w.relay.pushed.length;
      w.rules.overlapFor = () => 'echo';
      w.words(HUGO, 'h1', 'upon a time');
      expect(w.drops).toEqual([]);
      // The frames not yet played are relayed again, in order, and the answer's last frame still ends it.
      const again = w.relay.pushed.slice(before);
      expect(again.length).toBeGreaterThanOrEqual(MILO_AMPS.length - 28);
      expect(again.at(-1)!.last).toBe(true);
    });

    it('a pause no words confirm is resumed after 1.5 s', async () => {
      const w = await answering();
      for (let i = 0; i < 25; i++) w.hugo(0);
      w.hugo(3_000); w.hugo(3_000);
      const before = w.relay.pushed.length;
      for (let i = 0; i < 14; i++) w.hugo(0);
      expect(w.relay.pushed).toHaveLength(before);
      w.hugo(0); w.hugo(0);
      expect(w.relay.pushed.length).toBeGreaterThan(before);
      expect(w.drops).toEqual([]);
    });

    it('a mic whose loudness follows his earlier playout (leaky) stays words-only; a mic with no history too', async () => {
      const w = await answering();
      for (let i = 0; i < 30; i++) w.hugo(Math.round(w.leak(2) * 0.4));
      expect(w.relay.clears).toBe(0); // its echo after the pause is an onset, but the mic is leaky
      const fresh = await answering();
      fresh.hugo(3_000); fresh.hugo(3_000); fresh.hugo(3_000);
      expect(fresh.relay.clears).toBe(0); // nothing of his playout heard in that mic yet: no way to tell
    });

    it('a mic too new to judge (his first line: under 15 bins of his playout) pauses on its onset; words that talk over him confirm it', async () => {
      // Gate fixed-barge, 19 November: "Milo, stop" 600 ms into a server line that was his first audio waited ~1 s for its words.
      const fresh = await answering();
      for (let i = 0; i < 6; i++) fresh.hugo(0); // quiet through his first 600 ms
      fresh.hugo(3_000); fresh.hugo(3_000); fresh.hugo(3_000);
      expect(fresh.relay.clears).toBe(1);
      expect(fresh.drops).toEqual([]);
      fresh.rules.overlapFor = () => 'barge-in';
      fresh.words(HUGO, 'h1', 'Milo stop');
      expect(fresh.drops).toEqual(['barge-in']);
    });

    it('a mic too new to judge whose onset was his own echo: the words resume him, and that mic is words-only from then on', async () => {
      const w = await answering();
      for (let i = 0; i < 6; i++) w.hugo(0);
      w.hugo(3_000); w.hugo(3_000);
      expect(w.relay.clears).toBe(1);
      const before = w.relay.pushed.length;
      w.rules.overlapFor = () => 'echo';
      w.words(HUGO, 'h1', 'once upon a time');
      expect(w.drops).toEqual([]);
      expect(w.relay.pushed.length).toBeGreaterThan(before); // never stopped by his own echo
      for (let i = 0; i < 4; i++) w.hugo(0);
      w.hugo(3_000); w.hugo(3_000); w.hugo(3_000);
      expect(w.relay.clears).toBe(1); // a mic heard echoing him does not pause him again
    });

    it('a mic too new to judge that was loud through most of his playout so far is taken as leaky (no pause)', async () => {
      const w = await answering();
      for (let i = 0; i < 8; i++) w.hugo(Math.round(w.leak(1) * 0.5));
      w.hugo(3_000); w.hugo(3_000); w.hugo(3_000);
      expect(w.relay.clears).toBe(0);
    });
  });

  describe('hold', () => {
    it('routes at once with no name or verdict, and uses the same floor (one holder)', async () => {
      const w = world();
      expect(await w.router.holdPress(UNA)).toEqual({ ok: true });
      expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA, via: 'hold' });
      expect(await w.router.holdPress(UNA)).toEqual({ ok: false, reason: 'already-holding' });
      expect(await w.router.holdPress(HUGO)).toEqual({ ok: false, reason: 'busy' });
      w.talk(UNA, T_UNA, 5);
      expect(w.talking.heard().filter((t) => t === T_UNA)).toHaveLength(5);
      w.router.holdRelease(UNA);
      w.talk(UNA, T_UNA, 3);
      expect(w.talking.heard().filter((t) => t === T_UNA)).toHaveLength(5); // released: the provider hears quiet
      w.milo(2);
      expect(w.relay.pushed).toHaveLength(2);
      expect(w.rules.verdicts).toHaveLength(0);
    });

    it('a name trigger while someone holds is queued, never mixed', async () => {
      const w = world();
      await w.router.holdPress(UNA);
      w.talk(HUGO, T_HUGO, 3);
      w.name(HUGO, 'h1', 0); await settle();
      expect(w.router.state()).toMatchObject({ userId: UNA });
      expect(await w.router.holdPress(HUGO)).toEqual({ ok: false, reason: 'busy' });
    });

    it('cancel drops the relay; not admitted is refused; the cap releases at 30 s', async () => {
      const w = world();
      w.rules.admission.set(HUGO, 'fixed-lines');
      expect(await w.router.holdPress(HUGO)).toEqual({ ok: false, reason: 'not-admitted' });
      await w.router.holdPress(UNA);
      w.router.outputAudio(frame(T_MILO), false);
      w.router.holdCancel(UNA);
      expect(w.drops).toEqual(['hold-cancel']);
      expect(w.relay.clears).toBe(1);
      expect(w.router.state()).toEqual({ phase: 'idle' });
      w.router.outputAudio(frame(T_MILO), true);
      await w.router.holdPress(UNA);
      w.clock.advance(HANDSFREE.holdMaxMs);
      w.talk(UNA, T_UNA, 2);
      const tail = w.talking.ticks.slice(-2).flat().map((b) => b[0]);
      expect(tail).not.toContain(T_UNA);
      w.clock.advance(ROUTE_GIVE_UP_MS);
      expect(w.router.state()).toEqual({ phase: 'idle' });
    });
  });

  describe('film fixes (HF-FILM-DIAG, 19 Nov)', () => {
    /** A fixed verdict for Una, handed to the orchestrator's held-text path; the line's frames come back tagged with a say id. */
    function fixedWorld() {
      const clock = new FakeClock();
      const listening = new FakeListening(clock);
      const rules = new FakeRules();
      rules.verdictFor = () => ({ kind: 'fixed', line: 'About 12 minutes are left in this round.' });
      const talking = new FakeTalking();
      const relay = new FakeRelay();
      const fixed: Array<[string, string]> = []; const turns: boolean[] = [];
      const router = new Router({ clock, call: { callId: 'c1', lobby: null, tenant: 't' }, rules, listening, talking, relay, sayFixed: (u, l, a) => { fixed.push([u, l]); turns.push(a); } });
      const drops: string[] = [];
      router.on('drop', (d) => drops.push(d.reason));
      const step = (who: Array<[string, number]> = []) => { clock.advance(100); for (const [u, t] of who) listening.speak(u, t); router.tick(); };
      const words = (u: string, sid: string, delta: string) => listening.emit('words', { userId: u, sentenceId: sid, delta, atMs: clock.nowMs() });
      const line = (n: number, id = 'say_1') => { for (let i = 0; i < n; i++) router.outputAudio(frame(T_MILO), i === n - 1, id); };
      const ask = async (text = 'Milo, how long is left?') => {
        listening.emit('name', { userId: UNA, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 0, textSoFar: 'Milo' }); await settle();
        listening.emit('sentence', { userId: UNA, sentenceId: 's1', text, startMs: 0, endMs: clock.nowMs(), named: true }); await settle();
      };
      return { clock, listening, rules, talking, relay, router, fixed, turns, drops, step, words, line, ask };
    }

    it('fix 1: a server line relayed through the router is Milo playing: words over it are a barge-in, and the rest of the line is dropped', async () => {
      const w = fixedWorld();
      for (let i = 0; i < 5; i++) w.step([[UNA, T_UNA]]);
      await w.ask();
      w.router.outputText('About 12 minutes are left in this round.', true);
      for (let i = 0; i < 3; i++) w.router.outputAudio(frame(T_MILO), false, 'say_1');
      expect(w.router.playing()).toBe(true);
      w.words(HUGO, 'h1', 'stop stop');
      expect(w.drops).toContain('barge-in');
      const before = w.relay.pushed.length;
      w.line(4);
      expect(w.relay.pushed.length).toBe(before);
    });

    it('fix 2: the follow-up window opens after a fixed line for its asker (no name needed), and the session\'s own words in it stay unheard', async () => {
      const w = fixedWorld();
      for (let i = 0; i < 5; i++) w.step([[UNA, T_UNA]]);
      await w.ask();
      expect(w.fixed).toEqual([[UNA, 'About 12 minutes are left in this round.']]);
      w.line(5);
      expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
      expect(w.talking.asker).toBeNull();
      // The session's own (unrouted) reply inside the window is not relayed and does not take the window.
      w.router.outputAudio(frame(T_MILO), false); w.router.outputAudio(frame(T_MILO), true);
      expect(w.relay.pushed).toHaveLength(5);
      expect(w.router.state()).toMatchObject({ phase: 'follow-up', userId: UNA });
      // Una asks again without the name: routed as her follow-up.
      w.clock.advance(1_000 + HANDSFREE.echoGraceMs);
      w.rules.verdictFor = () => ({ kind: 'request' });
      w.words(UNA, 's2', 'and can you read the question');
      expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA, via: 'follow-up' });
    });

    it('fix 2: a fixed-lines person (a candidate without pad help) still gets no window', async () => {
      const w = fixedWorld();
      w.rules.admission.set(UNA, 'fixed-lines');
      await w.ask();
      expect(w.fixed).toHaveLength(1);
      // Never routed: the session hears no turn of theirs, so the line waits behind whatever it is hearing.
      expect(w.turns).toEqual([false]);
      w.line(5);
      expect(w.router.state()).toEqual({ phase: 'idle' });
    });

    it("fix 3: late words of a sentence begun before Milo started (the hold's own) are no barge-in; a sentence begun after is", async () => {
      const w = world();
      expect(await w.router.holdPress(UNA)).toEqual({ ok: true });
      w.talk(UNA, T_UNA, 10);
      w.words(UNA, 'u1', 'Milo can you');
      w.router.holdRelease(UNA);
      w.quiet(5);
      w.router.turnEnded();
      w.router.outputAudio(frame(T_MILO), false);
      w.router.outputText('Hello, I am Milo');
      // His deltas arrive about a second late: more words of the sentence he began while holding.
      w.clock.advance(50);
      w.words(UNA, 'u1', ' introduce yourself to the candidate please');
      expect(w.drops).toEqual([]);
      w.router.outputAudio(frame(T_MILO), false);
      expect(w.relay.pushed).toHaveLength(2);
      w.words(HUGO, 'h1', 'stop');
      expect(w.drops).toEqual(['barge-in']);
    });

    it('fix 4: a routed request the family holds is answered on the words so far, once (the final sentence is not judged again)', async () => {
      const w = fixedWorld();
      w.rules.mayBeFixedFor = (s) => /left/.test(s.text);
      for (let i = 0; i < 5; i++) w.step([[UNA, T_UNA]]);
      w.words(UNA, 's1', 'Milo, how much time');
      w.listening.emit('name', { userId: UNA, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 0, textSoFar: 'Milo, how much time' }); await settle();
      expect(w.rules.verdicts).toHaveLength(0);
      w.words(UNA, 's1', ' is left'); await settle();
      expect(w.rules.verdicts).toEqual([{ userId: UNA, text: 'Milo, how much time is left', via: 'name' }]);
      expect(w.fixed).toHaveLength(1);
      expect(w.router.state()).toEqual({ phase: 'idle' });
      w.listening.emit('sentence', { userId: UNA, sentenceId: 's1', text: 'Milo, how much time is left?', startMs: 0, endMs: w.clock.nowMs(), named: true }); await settle();
      expect(w.rules.verdicts).toHaveLength(1);
      expect(w.fixed).toHaveLength(1);
    });

    it('fix 4: an early verdict that is not fixed changes nothing (the final verdict decides)', async () => {
      const w = fixedWorld();
      w.rules.mayBeFixedFor = () => true;
      w.rules.verdictFor = () => ({ kind: 'request' });
      for (let i = 0; i < 5; i++) w.step([[UNA, T_UNA]]);
      w.listening.emit('name', { userId: UNA, sentenceId: 's1', sentenceStartMs: 0, nameEndMs: 0, textSoFar: 'Milo' }); await settle();
      w.words(UNA, 's1', 'Milo, what is the time complexity'); await settle();
      expect(w.router.state()).toMatchObject({ phase: 'routing', userId: UNA });
      w.listening.emit('sentence', { userId: UNA, sentenceId: 's1', text: 'Milo, what is the time complexity?', startMs: 0, endMs: w.clock.nowMs(), named: true }); await settle();
      w.router.outputAudio(frame(T_MILO), true);
      expect(w.relay.pushed).toHaveLength(1);
    });

    it("fix 6: a server line coming mutes the session's own preamble: what has not played is cleared, the rest is unheard, the line plays", async () => {
      const w = world();
      w.talk(UNA, T_UNA, 5);
      w.name(UNA, 's1', 0); await settle();
      w.sentence(UNA, 's1', 'Milo, introduce yourself'); await settle();
      w.router.outputAudio(frame(T_MILO), false);
      expect(w.relay.pushed).toHaveLength(1);
      w.router.serverLine(true);
      expect(w.relay.clears).toBe(1);
      w.router.outputAudio(frame(T_MILO), false); w.router.outputAudio(frame(T_MILO), true);
      expect(w.relay.pushed).toHaveLength(1);
      w.milo(3, 'say_1');
      expect(w.relay.pushed).toHaveLength(4);
      // The line over, the session is heard again.
      w.router.outputAudio(frame(T_MILO), true);
      expect(w.relay.pushed).toHaveLength(5);
    });
  });
});

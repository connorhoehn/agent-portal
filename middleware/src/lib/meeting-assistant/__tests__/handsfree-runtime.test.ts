// Hands-free talking side and run (lane B): the session hears only what the router feeds, tool calls carry the routed asker, and
// the run wires the listening side, the router and the session's events together. Fakes of lanes A and C (handsfree-fakes.ts).
import { HandsfreeTalking } from '../handsfree/talking.js';
import { HandsfreeRuntime } from '../handsfree/runtime.js';
import { SessionEmitter, type LiveMeetingSession, type SessionEvents } from '../session.js';
import type { HeardLine } from '../handsfree/types.js';
import { FakeClock, FakeListening, FakeRelay, FakeRules, frame, settle } from './handsfree-fakes.js';

class InnerSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  appended: Buffer[] = [];
  said: string[] = [];
  closed = 0;
  async start(): Promise<void> { /* open */ }
  appendAudio(pcm: Buffer): void { this.appended.push(pcm); }
  sendText(): void { throw new Error('no text'); }
  answerToolCall(): boolean { return true; }
  appendContext(): boolean { return true; }
  sayVerbatim(_id: string, text: string): boolean { this.said.push(text); return true; }
  pendingInputText(): string { return ''; }
  async close(): Promise<void> { this.closed += 1; this.emit('closed', { reason: 'closed' }); }
  fire<K extends keyof SessionEvents>(type: K, e: SessionEvents[K]): void { this.emit(type, e); }
}

describe('hands-free talking side', () => {
  it('drops the room mix, forwards only fed frames, and stamps askedBy with the routed person', () => {
    const inner = new InnerSession();
    const talking = new HandsfreeTalking(inner);
    const calls: Array<SessionEvents['toolCall']> = [];
    talking.on('toolCall', (e) => calls.push(e));
    talking.appendAudio(frame(1));
    expect(inner.appended).toHaveLength(0);
    talking.feed([frame(2), frame(2)]);
    talking.feed([]);
    expect(inner.appended).toHaveLength(2);
    // Idle: no asker (the session's own claim is never taken).
    inner.fire('toolCall', { callId: 'a', name: 'x', args: {}, atMs: 0, askedBy: 'u-model-said' });
    talking.setAsker('u-una');
    inner.fire('toolCall', { callId: 'b', name: 'x', args: {}, atMs: 1 });
    talking.setAsker(null);
    inner.fire('toolCall', { callId: 'c', name: 'x', args: {}, atMs: 2 });
    expect(calls.map((c) => c.askedBy ?? null)).toEqual([null, 'u-una', null]);
  });

  it('holds tool calls while the asker is pending and releases them with askedBy only when the request is confirmed', () => {
    const inner = new InnerSession();
    const talking = new HandsfreeTalking(inner);
    const calls: Array<SessionEvents['toolCall']> = [];
    talking.on('toolCall', (e) => calls.push(e));
    talking.setAsker('u-una', true);
    inner.fire('toolCall', { callId: 'a', name: 'x', args: {}, atMs: 0 });
    expect(calls).toHaveLength(0);
    talking.setAsker('u-una');
    expect(calls.map((c) => [c.callId, c.askedBy ?? null])).toEqual([['a', 'u-una']]);
    // A mention (or anything but a request): what was held goes out unasked, which the orchestrator refuses.
    talking.setAsker('u-hugo', true);
    inner.fire('toolCall', { callId: 'b', name: 'x', args: {}, atMs: 1 });
    talking.setAsker(null);
    // Pending for one person, then routed to another: the first person's held calls are not the second's.
    talking.setAsker('u-una', true);
    inner.fire('toolCall', { callId: 'c', name: 'x', args: {}, atMs: 2 });
    talking.setAsker('u-hugo', true);
    talking.setAsker('u-hugo');
    expect(calls.map((c) => [c.callId, c.askedBy ?? null])).toEqual([['a', 'u-una'], ['b', null], ['c', null]]);
  });

  it('passes every other event through, and says server words verbatim', async () => {
    const inner = new InnerSession();
    const talking = new HandsfreeTalking(inner);
    const seen: string[] = [];
    talking.on('outputAudio', () => seen.push('audio'));
    talking.on('inputTranscript', () => seen.push('input'));
    talking.on('closed', () => seen.push('closed'));
    inner.fire('outputAudio', { pcm: frame(9), seq: 1 });
    inner.fire('inputTranscript', { text: 'hi', startMs: 0, endMs: 1 });
    expect(talking.say('s1', 'Ten minutes left.', () => undefined)).toBe(true);
    await talking.close();
    expect(seen).toEqual(['audio', 'input', 'closed']);
    expect(inner.said).toEqual(['Ten minutes left.']);
  });
});

describe('hands-free run', () => {
  function run() {
    const clock = new FakeClock();
    const listening = new FakeListening(clock);
    const placed: string[] = [];
    listening.placed = (u) => { placed.push(u); };
    const rules = new FakeRules();
    const inner = new InnerSession();
    const talking = new HandsfreeTalking(inner);
    const relay = new FakeRelay();
    const lines: HeardLine[] = [];
    const hf = new HandsfreeRuntime({ call: { callId: 'c1', lobby: null, tenant: 't' }, clock, listening: listening as never, rules, talking, relay, onLine: (l) => lines.push(l), nameOf: async (u) => `name of ${u}` });
    return { clock, listening, placed, rules, inner, talking, relay, lines, hf };
  }

  it('opens a lane on a person\'s first audio, ticks the talking side on the mix, and stores heard lines', async () => {
    const w = run();
    w.hf.sink.placed('u-una', frame(1), 0);
    w.hf.sink.placed('u-una', frame(1), 100);
    await settle();
    expect(w.listening.opened).toEqual(['u-una']);
    expect(w.placed).toEqual(['u-una', 'u-una']);
    w.clock.advance(100);
    w.hf.sink.append(frame(5)); // the room mix: never reaches the session
    expect(w.inner.appended.every((b) => b[0] === 0)).toBe(true);
    w.listening.emit('line', { callId: 'c1', userId: 'u-una', participantId: 'p', speakerName: 'Una', text: 'hello', at: 1, captionId: 'x', startMs: 0, endMs: 900 });
    expect(w.lines.map((l) => l.userId)).toEqual(['u-una']);
  });

  it('a hold routes the holder and a tool call during it is theirs; a second holder is refused', async () => {
    const w = run();
    const calls: Array<string | null> = [];
    w.talking.on('toolCall', (e) => calls.push(e.askedBy ?? null));
    expect(await w.hf.holdPress('u-una')).toEqual({ ok: true });
    expect(await w.hf.holdPress('u-hugo')).toEqual({ ok: false, reason: 'busy' });
    expect(w.hf.state()).toMatchObject({ phase: 'routing', userId: 'u-una', via: 'hold' });
    w.inner.fire('toolCall', { callId: 'a', name: 'x', args: {}, atMs: 0 });
    w.hf.holdRelease('u-una');
    w.hf.outputAudio(frame(9), true);
    expect(w.relay.pushed).toHaveLength(1);
    expect(calls).toEqual(['u-una']);
  });

  it('idle, the session is fed only the quiet that closes a turn, then a keepalive frame every 10 s; routed, every tick', async () => {
    const w = run();
    const idle = (ms: number): void => { for (let t = 0; t < ms; t += 100) { w.clock.advance(100); w.hf.sink.append(frame(5)); } };
    idle(60_000);
    // 2 s of quiet once the replay lead is paid back, then one frame per 10 s: not 55 s of silence.
    expect(w.inner.appended.length).toBeGreaterThan(0);
    expect(w.inner.appended.length).toBeLessThanOrEqual(20 + 6);
    expect(w.inner.appended.every((b) => b.every((x) => x === 0))).toBe(true);
    // Routed (a hold): fed every tick again.
    expect(await w.hf.holdPress('u-una')).toEqual({ ok: true });
    const before = w.inner.appended.length;
    idle(1_000);
    expect(w.inner.appended.length - before).toBe(10);
    // Back to idle: the quiet that closes the turn is fed again, then nothing but the keepalive.
    w.hf.holdCancel('u-una');
    const after = w.inner.appended.length;
    idle(30_000);
    expect(w.inner.appended.length - after).toBeGreaterThanOrEqual(20);
    expect(w.inner.appended.length - after).toBeLessThanOrEqual(20 + 4);
  });

  it('close closes both sides once and refuses holds after', async () => {
    const w = run();
    await Promise.all([w.hf.close(), w.hf.close()]);
    expect(w.listening.closed).toBe(true);
    expect(w.inner.closed).toBe(1);
    expect(await w.hf.holdPress('u-una')).toEqual({ ok: false, reason: 'not-running' });
  });
});

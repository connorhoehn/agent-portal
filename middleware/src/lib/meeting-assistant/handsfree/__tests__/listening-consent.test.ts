// The hands-free listening side asks the audio intake's gate per speaker (ledger M-9): the same acknowledgements the tap drops
// chunks by, read from memory at every lane open and every placed frame, failing closed.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../chat.js', () => ({
  nameOf: async (id: string) => id, postReply: async () => ({ id: 'm' }), postPrivately: async () => true, postNoticeQuietly: async () => undefined,
  postAction: async () => ({ message: { id: 'm' }, created: true }), moveAction: async () => null,
}));

import { AudioIntake } from '../../audio-intake.js';
import type { AssistantStore } from '../../store.js';
import type { AssistantRecord } from '../../types.js';
import { createListeningSide } from '../listening.js';
import { productionHandsfree } from '../../orchestrator.js';
import { HANDSFREE, type HandsfreeClock, type ListeningEvents, type PersonTranscriber } from '../types.js';

const CALL = 'call-consent';
const ARN = 'arn:test:channel/consent';

class FakeClock implements HandsfreeClock {
  t = 0;
  nowMs(): number { return this.t; }
  setTimeout(): unknown { return 0; }
  clearTimeout(): void { /* nothing scheduled */ }
}

class CountingStream implements PersonTranscriber {
  appended = 0; closed = false;
  append(pcm: Buffer): void { if (!this.closed) this.appended += pcm.length; }
  on(): () => void { return () => undefined; }
  get streamMs(): number { return this.appended / 48; }
  async close(): Promise<void> { this.closed = true; }
}

const voiced = (ms: number): Buffer => { const b = Buffer.alloc(ms * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 3000 : -3000, i); return b; };

/** A store whose record the test edits in place, and whose reads the test can make fail. */
function fakeStore(acked: string[]) {
  const state = { record: { callId: CALL, state: 'listening', invitedBy: 'u-ana', acked } as unknown as AssistantRecord, fail: false };
  const store = {
    get: async () => { if (state.fail) throw new Error('read failed'); return state.record; },
    patchSession: async () => state.record,
  } as unknown as AssistantStore;
  return { state, store };
}

async function setup(acked: string[]) {
  const { state, store } = fakeStore(acked);
  const audio = new AudioIntake(() => store, { tickMs: 0 });
  await audio.arm(CALL, ARN);
  const clock = new FakeClock();
  const streams = new Map<string, CountingStream>();
  const side = createListeningSide({
    callId: CALL, clock, consented: (u) => audio.hears(CALL, u),
    transcriber: async (input) => { const s = new CountingStream(); streams.set(input.userId, s); return s; },
  });
  const lanes: Array<ListeningEvents['lane']> = [];
  side.on('lane', (e) => lanes.push(e));
  let at = 0;
  const feed = (user: string, ms: number): void => {
    const pcm = voiced(ms);
    for (let o = 0; o < pcm.length; o += HANDSFREE.frameBytes) { clock.t = at; side.placed(user, pcm.subarray(o, o + HANDSFREE.frameBytes), at); at += HANDSFREE.frameMs; }
  };
  return { state, audio, side, streams, lanes, feed };
}

describe('the listening side asks the intake whom it may hear', () => {
  it('a speaker who acknowledged is transcribed', async () => {
    const t = await setup(['u-ben']);
    await t.side.open('u-ben', 'Ben');
    t.feed('u-ben', 1000);
    expect(t.streams.get('u-ben')!.appended).toBeGreaterThan(0);
    t.audio.dispose();
  });

  it('a speaker who has not acknowledged gets no lane and no stream; unknown ids and other calls are no too', async () => {
    const t = await setup(['u-ben']);
    await t.side.open('u-cy', 'Cy');
    t.feed('u-cy', 1000);
    expect(t.streams.has('u-cy')).toBe(false);
    expect(t.lanes).toEqual([{ userId: 'u-cy', state: 'down', reason: 'no-consent' }]);
    expect(t.audio.hears(CALL, '')).toBe(false);
    expect(t.audio.hears('another-call', 'u-ben')).toBe(false);
    expect(t.audio.hears(CALL, 'u-ana')).toBe(true); // the inviter acknowledged by inviting, as the tap treats them
    t.audio.dispose();
  });

  it('a failed read drops: a lane that was open closes at the next frame, and nothing new opens', async () => {
    const t = await setup(['u-ben']);
    await t.side.open('u-ben', 'Ben');
    t.feed('u-ben', 500);
    const before = t.streams.get('u-ben')!.appended;
    t.state.fail = true;
    await t.audio.refresh(CALL);
    t.feed('u-ben', 1000);
    expect(t.streams.get('u-ben')!.appended).toBe(before);
    expect(t.streams.get('u-ben')!.closed).toBe(true);
    expect(t.lanes).toContainEqual({ userId: 'u-ben', state: 'down', reason: 'no-consent' });
    await t.side.open('u-ben', 'Ben');
    expect(t.lanes[t.lanes.length - 1]).toEqual({ userId: 'u-ben', state: 'down', reason: 'no-consent' });
    // A read that succeeds again hears them again.
    t.state.fail = false;
    await t.audio.refresh(CALL);
    expect(t.audio.hears(CALL, 'u-ben')).toBe(true);
    t.audio.dispose();
  });

  it('an acknowledgement withdrawn mid-call stops their transcription at once', async () => {
    const t = await setup(['u-ben']);
    await t.side.open('u-ben', 'Ben');
    t.feed('u-ben', 500);
    const before = t.streams.get('u-ben')!.appended;
    expect(before).toBeGreaterThan(0);
    t.state.record = { ...t.state.record, acked: [] } as AssistantRecord; // a new period starts the acknowledgements again
    await t.audio.refresh(CALL);
    t.feed('u-ben', 1000);
    expect(t.streams.get('u-ben')!.appended).toBe(before);
    expect(t.streams.get('u-ben')!.closed).toBe(true);
    // Acknowledged again (the new period's notice): the next frame opens a fresh lane and they are transcribed again.
    const first = t.streams.get('u-ben')!;
    t.state.record = { ...t.state.record, acked: ['u-ben'] } as AssistantRecord;
    await t.audio.refresh(CALL);
    t.feed('u-ben', 100);
    await new Promise((r) => setImmediate(r));
    t.feed('u-ben', 1000);
    const second = t.streams.get('u-ben')!;
    expect(second).not.toBe(first);
    expect(second.appended).toBeGreaterThan(0);
    t.audio.dispose();
  });

  it('a call that stops listening hears nobody, the inviter included', async () => {
    const t = await setup(['u-ben']);
    t.state.record = { ...t.state.record, state: 'paused' } as AssistantRecord;
    await t.audio.refresh(CALL);
    expect(t.audio.hears(CALL, 'u-ana')).toBe(false);
    expect(t.audio.hears(CALL, 'u-ben')).toBe(false);
    t.audio.dispose();
  });
});

describe('productionHandsfree', () => {
  it('wires the listening side to the consent check it is given, per speaker, never a constant yes', async () => {
    const asked: Array<[string, string]> = [];
    const { listening } = productionHandsfree({ callId: CALL, lobby: null, tenant: 'orgiq' }, new FakeClock(), () => [], (c, u) => { asked.push([c, u]); return false; });
    const lanes: Array<ListeningEvents['lane']> = [];
    listening.on('lane', (e) => lanes.push(e));
    await listening.open('u-cy', 'Cy');
    expect(asked).toEqual([[CALL, 'u-cy']]);
    expect(lanes).toEqual([{ userId: 'u-cy', state: 'down', reason: 'no-consent' }]);
    await listening.close();
  });
});

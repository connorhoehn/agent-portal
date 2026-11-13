// The intake: the rules for storing a line, and what the detector's events do to the record.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource, TranscriptSourceNotConfigured, notConfiguredTranscriptSource } from '../transcript-source.js';
import type { AssistantRecord } from '../types.js';

let now = 1_000_000;
let store: MemoryAssistantStore;
let source: MockTranscriptSource;
let intake: LineIntake;
const base = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-1', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-vera', invitedAt: 1,
  pausedBy: null, leftAt: null, leftBy: null, acked: ['u-vera'], attendees: ['u-vera', 'u-release'], presentAtInvite: ['u-vera', 'u-release'],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], ...over,
});
beforeEach(async () => {
  now = 1_000_000;
  store = new MemoryAssistantStore(); source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  await store.create(base());
  intake.start('call-1');
});
afterEach(() => intake.dispose());
const inject = (userId: string, text: string, extra: Record<string, unknown> = {}) => source.inject('call-1', { userId, text, ...extra });
const get = async () => (await store.get('call-1'))!;

it('stores the inviter\'s lines at once, and nobody else\'s until they acknowledge', async () => {
  await inject('u-vera', 'we start with the retry logic');
  await inject('u-release', 'agreed');
  expect((await store.lines('call-1', 0, 10)).map((l) => l.userId)).toEqual(['u-vera']);
  expect((await get()).attendees).toContain('u-release');
  await store.ack('call-1', 'u-release');
  await inject('u-release', 'now I have acknowledged');
  expect((await store.lines('call-1', 0, 10)).map((l) => l.text)).toEqual(['we start with the retry logic', 'now I have acknowledged']);
});

it('a person who joined after the invite is held to the same gate, and the gate also hides them from the detector', async () => {
  await inject('u-late', 'Nova, summarise the call please.');
  now += 5000;
  await intake.tick();
  expect(await store.lines('call-1', 0, 10)).toEqual([]);
  expect((await get()).pendingRequests).toEqual([]);
  expect((await get()).attendees).toContain('u-late');
});

it('stores nothing while paused or after leaving, and nothing for a call without an assistant', async () => {
  await store.transition('call-1', { from: ['listening'], to: 'paused', by: 'u-release', at: 1 });
  await inject('u-vera', 'said while paused');
  expect((await get()).linesStored).toBe(0);
  expect(await intake.handle('call-9', { userId: 'u-vera', text: 'x' })).toMatchObject({ stored: null, reason: 'no-assistant' });
  await store.transition('call-1', { from: ['paused'], to: 'left', by: 'u-vera', at: 2 });
  expect(await intake.handle('call-1', { userId: 'u-vera', text: 'after' })).toMatchObject({ reason: 'not-listening' });
});

it('drops empty text, repeated caption ids, and trims runaway text; keeps fillers in the transcript', async () => {
  expect(await intake.handle('call-1', { userId: 'u-vera', text: '   ' })).toMatchObject({ reason: 'empty' });
  await inject('u-vera', 'Thank you.', { captionId: 'k1' });
  expect(await intake.handle('call-1', { userId: 'u-vera', text: 'Thank you.', captionId: 'k1' })).toMatchObject({ reason: 'duplicate' });
  await inject('u-vera', 'x'.repeat(5000), { captionId: 'k2' });
  const lines = await store.lines('call-1', 0, 10);
  expect(lines.map((l) => l.text.length)).toEqual([10, 2000]);
});

it('defaults the caption id, speaker name and time, and keeps offsets and overlapped speakers', async () => {
  await inject('u-vera', 'hello there', { startMs: 100, endMs: 900, speakers: ['u-vera', 'u-release', 'u-vera'] });
  const [l] = await store.lines('call-1', 0, 1);
  expect(l).toMatchObject({ speakerName: 'u-vera', at: now, startMs: 100, endMs: 900, speakers: ['u-vera', 'u-release'] });
  expect(l!.captionId).toHaveLength(24);
});

it('a request split across lines becomes one pending request once the speaker goes quiet', async () => {
  await inject('u-vera', 'we are done. Nova, please.');
  now += 1000;
  await inject('u-vera', 'write up a short incident summary and');
  now += 1000;
  await inject('u-vera', 'assign it to Priya.');
  expect((await get()).pendingRequests).toEqual([]);
  now += 1500;
  await intake.tick();
  const r = await get();
  expect(r.requests).toBe(1);
  expect(r.pendingRequests[0]).toMatchObject({ askedBy: 'u-vera', lines: [1, 2, 3], text: 'please. write up a short incident summary and assign it to Priya.' });
});

it('"Nova, stop listening" pauses as that speaker; "Nova, leave" dismisses and stops listening', async () => {
  await store.ack('call-1', 'u-release');
  await inject('u-release', 'Nova, stop listening.');
  expect(await get()).toMatchObject({ state: 'paused', pausedBy: 'u-release' });
  await store.transition('call-1', { from: ['paused'], to: 'listening', by: 'u-vera', at: 1 });
  await inject('u-release', 'Nova, leave.');
  expect(await get()).toMatchObject({ state: 'left', leftBy: 'u-release' });
  expect(intake.isListening('call-1')).toBe(false);
  expect(await source.inject('call-1', { userId: 'u-vera', text: 'anyone there' })).toBe(0);
});

it('without a source the assistant cannot start listening, plainly', () => {
  const dead = new LineIntake(store, { tickMs: 0, source: notConfiguredTranscriptSource });
  expect(() => dead.start('call-1')).toThrow(TranscriptSourceNotConfigured);
});

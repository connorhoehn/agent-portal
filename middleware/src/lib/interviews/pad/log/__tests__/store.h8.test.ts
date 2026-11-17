// A long round against the pad log's caps (lib/interviews/pad/log: rules.ts `capPost`, service.ts `appendPadEvents`; row I4.3,
// decision 12; OWED O-244, lane H8). The page posts one edit event per keystroke, so a long round can reach the 20,000 events
// an interview keeps. This pins what happens there: the edits stop, and so do the snapshots (the event cap is checked first and
// counts snapshots too), so the record's playback (frames from snapshots) and the coach's code (the latest snapshot) stop at the
// moment of the cap. The plan's reading of the line, "past the cap the edits stop, the snapshots keep coming", is `it.failing`
// and a finding: changing the caps is not this lane's.
jest.mock('../../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../../mock/core/index.js';
import { MemoryPadLogStore, setPadLogStore, type NewPadEvent } from '../store.js';
import { MAX_EVENTS_PER_INTERVIEW, MAX_SNAPSHOTS_PER_INTERVIEW, type PadEventIn } from '../rules.js';
import { appendPadEvents, latestPadSnapshot } from '../index.js';

const IV = 'iv-h8-long-round';
const at = '2026-11-17T10:00:00.000Z';
const W = { id: 'guest:inv-h8', side: 'candidate' as const };
const edit = (i: number): NewPadEvent => ({
  at, clientAt: at, whoId: W.id, side: 'candidate', kind: 'edit', from: i, inserted: 1, deleted: 0, length: i + 1, lines: null, via: null, language: null, questionId: null, text: null,
});
const snap = (text: string): PadEventIn => ({ kind: 'snapshot', clientAt: at, text });
const keystroke = (i: number): PadEventIn => ({ kind: 'edit', clientAt: at, from: i, inserted: 1, deleted: 0, length: i + 1 });

let store: MemoryPadLogStore;
beforeEach(() => {
  fixtureRegistry.resetAll('default');
  store = new MemoryPadLogStore();
  setPadLogStore(store);
});
afterAll(() => setPadLogStore(null));

/** A round of keystrokes up to `n` events, with one snapshot early on (as the reporter's first 30 s would send). */
async function longRound(n: number): Promise<void> {
  await appendPadEvents(IV, W, [snap('def solve():\n    pass\n')]);
  await store.append(IV, Array.from({ length: n - 1 }, (_, i) => edit(i)));
}

it('one event below the cap: a snapshot still lands, and it is what the coach reads', async () => {
  await longRound(MAX_EVENTS_PER_INTERVIEW - 1);
  expect(await appendPadEvents(IV, W, [snap('def solve():\n    return 42\n')])).toBe(1);
  expect((await latestPadSnapshot(IV))!.text).toContain('return 42');
  expect((await store.counts(IV)).events).toBe(MAX_EVENTS_PER_INTERVIEW);
});

it('at the cap: a post of keystrokes is accepted as none; nothing more is stored', async () => {
  await longRound(MAX_EVENTS_PER_INTERVIEW);
  expect(await appendPadEvents(IV, W, Array.from({ length: 50 }, (_, i) => keystroke(i)))).toBe(0);
  expect((await store.counts(IV)).events).toBe(MAX_EVENTS_PER_INTERVIEW);
});

it('pinned today: at the event cap a snapshot is dropped too, so the playback and the coach keep the last one before the cap', async () => {
  await longRound(MAX_EVENTS_PER_INTERVIEW);
  expect(await appendPadEvents(IV, W, [snap('def solve():\n    return 42\n')])).toBe(0);
  expect((await latestPadSnapshot(IV))!.text).toBe('def solve():\n    pass\n');
});

it('the snapshot cap alone: past 400 snapshots the edits keep coming', async () => {
  await store.append(IV, Array.from({ length: MAX_SNAPSHOTS_PER_INTERVIEW }, () => ({ ...edit(0), kind: 'snapshot' as const, from: null, inserted: null, deleted: null, length: null, text: 'x' })));
  expect(await appendPadEvents(IV, W, [snap('dropped'), keystroke(1), keystroke(2)])).toBe(2);
  expect((await latestPadSnapshot(IV))!.text).toBe('x');
});

// OWED O-244's reading: "past the cap the edits stop, the snapshots keep coming, and the record's playback still has its
// frames". The event cap counts snapshots and is checked first, so they stop with the edits.
it.failing('past the event cap the edits stop but a snapshot still lands (the playback keeps its frames)', async () => {
  await longRound(MAX_EVENTS_PER_INTERVIEW);
  expect(await appendPadEvents(IV, W, [keystroke(1), snap('def solve():\n    return 42\n')])).toBe(1);
  expect((await latestPadSnapshot(IV))!.text).toContain('return 42');
});

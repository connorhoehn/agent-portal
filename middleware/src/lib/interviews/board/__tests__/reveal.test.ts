// The lead's reveal of a provided design, logged once per question and only once the board holds it (./reveal.ts).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { MemoryPadLogStore, setPadLogStore, type PadLogStore } from '../../pad/log/store.js';
import { MAX_EVENTS_PER_INTERVIEW } from '../../pad/log/rules.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { recordReveal, revealStatus, revealedQuestionIds } from '../reveal.js';

const lead = { id: 'u-lead', side: 'panel' as const };
let store: PadLogStore;
beforeEach(() => { fixtureRegistry.resetAll('empty'); store = new MemoryPadLogStore(); setPadLogStore(store); });
afterEach(() => { fixtureRegistry.resetAll('default'); setPadLogStore(null); });

describe('the reveal of a provided design', () => {
  it('logs nothing on the ask; the ack logs it once, and a second ask or ack says it is already shown', async () => {
    expect(await revealStatus('iv-1', 'q-t')).toBe('new');
    expect((await store.counts('iv-1')).events).toBe(0);
    expect(await recordReveal('iv-1', lead, 'q-t')).toBe('logged');
    expect(await revealStatus('iv-1', 'q-t')).toBe('already');
    expect(await recordReveal('iv-1', lead, 'q-t')).toBe('already');
    expect(await revealedQuestionIds('iv-1')).toEqual(['q-t']);
    expect((await store.listAfter('iv-1', 0, 10)).map((r) => [r.kind, r.questionId, r.side, r.whoId])).toEqual([['reveal', 'q-t', 'panel', 'u-lead']]);
  });

  it('keeps each question apart', async () => {
    await recordReveal('iv-1', lead, 'q-a');
    expect(await revealStatus('iv-1', 'q-b')).toBe('new');
    expect(await recordReveal('iv-1', lead, 'q-b')).toBe('logged');
    expect(await revealedQuestionIds('iv-1')).toEqual(['q-a', 'q-b']);
  });

  it('says so when the log is at its event cap, on the ask and on the ack, instead of showing an unrecorded reveal', async () => {
    jest.spyOn(store, 'counts').mockResolvedValue({ events: MAX_EVENTS_PER_INTERVIEW, snapshots: 0, lastSeq: MAX_EVENTS_PER_INTERVIEW });
    expect(await revealStatus('iv-1', 'q-t')).toBe('full');
    expect(await recordReveal('iv-1', lead, 'q-t')).toBe('full');
    expect(await revealedQuestionIds('iv-1')).toEqual([]);
  });
});

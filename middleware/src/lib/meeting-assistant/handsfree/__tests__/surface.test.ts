// Hands-free Milo, lane D: what the routes do with a call's run (surface.ts). The run is a fake of types.ts `HandsfreeRun`.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
import { floorOf, holdAction, mayHold } from '../surface.js';
import type { HandsfreeRules, HandsfreeRun, HoldResult, RouteState } from '../types.js';

function fakeRun(state: RouteState, press: HoldResult = { ok: true }) {
  const calls: string[] = [];
  const run = {
    state: () => state,
    holdPress: async (u: string) => { calls.push(`press:${u}`); return press; },
    holdRelease: (u: string) => { calls.push(`release:${u}`); },
    holdCancel: (u: string) => { calls.push(`cancel:${u}`); },
  } as unknown as HandsfreeRun;
  return { run, calls };
}
const names = async (id: string) => ({ hugo: 'Hugo', una: 'Una' } as Record<string, string>)[id] ?? id;
const CALL = { callId: 'c1', lobby: 'orgiq:initiative:p', tenant: 'orgiq' };

describe('the floor for the surface', () => {
  it('names who is talking to Milo while their audio is routed or answered, and nobody otherwise', async () => {
    expect(await floorOf(null, names)).toEqual({ handsfree: false, floor: null });
    expect(await floorOf(fakeRun({ phase: 'idle' }).run, names)).toEqual({ handsfree: true, floor: null });
    expect(await floorOf(fakeRun({ phase: 'routing', userId: 'hugo', via: 'hold', sinceMs: 5 }).run, names))
      .toEqual({ handsfree: true, floor: { userId: 'hugo', name: 'Hugo', via: 'hold', phase: 'routing' } });
    expect(await floorOf(fakeRun({ phase: 'answering', userId: 'una', via: 'name', sinceMs: 5 }).run, names))
      .toEqual({ handsfree: true, floor: { userId: 'una', name: 'Una', via: 'name', phase: 'answering' } });
    // The follow-up window is the asker's courtesy, not a held floor: nothing is shown.
    expect(await floorOf(fakeRun({ phase: 'follow-up', userId: 'una', untilMs: 9 }).run, names)).toEqual({ handsfree: true, floor: null });
  });

  it('a name that cannot be read is "Someone", never an id', async () => {
    const out = await floorOf(fakeRun({ phase: 'routing', userId: 'guest:abc', via: 'hold', sinceMs: 0 }).run, async () => { throw new Error('x'); });
    expect(out.floor?.name).toBe('The candidate'); // an interview's guest id
    expect((await floorOf(fakeRun({ phase: 'routing', userId: 'u-x', via: 'hold', sinceMs: 0 }).run, async (id) => id)).floor?.name).toBe('Someone');
  });
});

describe('the hold routes', () => {
  it('no hands-free run: 409, nothing is asked', async () => {
    expect(await holdAction(null, 'hugo', 'press', names)).toMatchObject({ status: 409, body: { code: 'NOT_HANDSFREE' } });
  });

  it('press routes the holder; release and cancel go to the run as the same person', async () => {
    const { run, calls } = fakeRun({ phase: 'routing', userId: 'hugo', via: 'hold', sinceMs: 0 });
    expect(await holdAction(run, 'hugo', 'press', names)).toMatchObject({ status: 200, body: { holding: true, floor: { userId: 'hugo' } } });
    expect(await holdAction(run, 'hugo', 'release', names)).toMatchObject({ status: 200, body: { holding: false } });
    expect(await holdAction(run, 'hugo', 'cancel', names)).toMatchObject({ status: 200, body: { holding: false } });
    expect(calls).toEqual(['press:hugo', 'release:hugo', 'cancel:hugo']);
  });

  it('a second holder is refused busy, with who holds the floor', async () => {
    const { run } = fakeRun({ phase: 'routing', userId: 'hugo', via: 'hold', sinceMs: 0 }, { ok: false, reason: 'busy' });
    expect(await holdAction(run, 'una', 'press', names)).toMatchObject({ status: 409, body: { code: 'BUSY', floor: { name: 'Hugo' } } });
  });

  it('someone not admitted is refused 403; a press while already holding or a stopped run is 409', async () => {
    expect(await holdAction(fakeRun({ phase: 'idle' }, { ok: false, reason: 'not-admitted' }).run, 'g', 'press', names)).toMatchObject({ status: 403, body: { code: 'NOT_ADMITTED' } });
    expect(await holdAction(fakeRun({ phase: 'idle' }, { ok: false, reason: 'already-holding' }).run, 'g', 'press', names)).toMatchObject({ status: 409, body: { code: 'ALREADY_HOLDING' } });
    expect(await holdAction(fakeRun({ phase: 'idle' }, { ok: false, reason: 'not-running' }).run, 'g', 'press', names)).toMatchObject({ status: 409, body: { code: 'NOT_HANDSFREE' } });
  });
});

describe('who sees the button', () => {
  const rules = (a: 'route' | 'fixed-lines' | 'deny') => ({ admit: async () => a } as unknown as HandsfreeRules);
  it('only someone the rules route (a candidate without pad help gets fixed lines: no button), and never without a run', async () => {
    const { run } = fakeRun({ phase: 'idle' });
    expect(await mayHold(run, CALL, 'hugo', rules('route'))).toBe(true);
    expect(await mayHold(run, CALL, 'guest:x', rules('fixed-lines'))).toBe(false);
    expect(await mayHold(run, CALL, 'carol', rules('deny'))).toBe(false);
    expect(await mayHold(null, CALL, 'hugo', rules('route'))).toBe(false);
    expect(await mayHold(run, CALL, 'hugo', { admit: async () => { throw new Error('x'); } } as unknown as HandsfreeRules)).toBe(false);
  });
});

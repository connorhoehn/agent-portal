// Fire-guard ordering — the brakes between a trigger and a run. The ordering
// is the contract: off/paused refuses with no run row, the run cap skips
// (visibly) before cost is even considered, and only the daily budget flips
// the bot's own state. These pin that a bot in several bad states at once
// reports the right one.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { decideFire, renderPrompt, type FireGuardInput } from '../bot-runner.js';

function bot(over: Partial<FireGuardInput> = {}): FireGuardInput {
  return {
    enabled: true, pausedReason: null, maxRunsPerDay: 4,
    budgetPerDayUsd: null, todayRunCount: 0, todaySpendUsd: 0,
    ...over,
  };
}

describe('decideFire', () => {
  it('fires a healthy bot', () => {
    expect(decideFire(bot())).toEqual({ kind: 'fire' });
  });

  it('refuses a disabled bot without recording anything', () => {
    expect(decideFire(bot({ enabled: false }))).toMatchObject({ kind: 'refuse' });
  });

  it('refuses a paused bot and surfaces the stored reason', () => {
    const d = decideFire(bot({ pausedReason: 'daily budget reached' }));
    expect(d.kind).toBe('refuse');
    expect((d as { reason: string }).reason).toMatch(/daily budget reached/);
  });

  it('skips at the run cap — a visible skipped run, not a silent nothing', () => {
    expect(decideFire(bot({ maxRunsPerDay: 4, todayRunCount: 4 }))).toMatchObject({
      kind: 'skip', reason: expect.stringMatching(/max runs per day/) as string,
    });
  });

  it('pauses at the daily budget, with the exact reason the roster shows', () => {
    expect(decideFire(bot({ budgetPerDayUsd: 5, todaySpendUsd: 5 }))).toEqual({
      kind: 'pause', reason: 'daily budget reached',
    });
  });

  it('does not pause when no daily budget is set, however much was spent', () => {
    expect(decideFire(bot({ budgetPerDayUsd: null, todaySpendUsd: 999 }))).toEqual({ kind: 'fire' });
  });

  it('checks disabled before the run cap — an off bot must never look "capped"', () => {
    expect(decideFire(bot({ enabled: false, todayRunCount: 99 }))).toMatchObject({ kind: 'refuse' });
  });

  it('checks the run cap before the budget — the cap is the cost-independent brake', () => {
    const d = decideFire(bot({ todayRunCount: 4, budgetPerDayUsd: 1, todaySpendUsd: 2 }));
    expect(d.kind).toBe('skip');
  });
});

describe('renderPrompt', () => {
  it('appends the one-shot instruction on its own paragraph', () => {
    expect(renderPrompt('Hunt tech debt.', 'focus on the auth module'))
      .toBe('Hunt tech debt.\n\nFor this run specifically: focus on the auth module');
  });

  it('leaves the mission untouched when there is no instruction', () => {
    expect(renderPrompt('Hunt tech debt.')).toBe('Hunt tech debt.');
  });
});

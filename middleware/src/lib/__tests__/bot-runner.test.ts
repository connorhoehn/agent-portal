// Fire-guard ordering — the brakes between a trigger and a run. The ordering
// is the contract: off/paused refuses with no run row, the run cap skips
// (visibly) before cost is even considered, and only the daily budget flips
// the bot's own state. These pin that a bot in several bad states at once
// reports the right one.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import {
  decideFire, renderPrompt, decideConcurrency, botMaxConcurrent, decideRunBudget,
  type FireGuardInput,
} from '../bot-runner.js';

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

  it('refuses maxRunsPerDay 0 — "never fires" is configuration, not a cap reached today', () => {
    const d = decideFire(bot({ maxRunsPerDay: 0, todayRunCount: 0 }));
    expect(d).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/never fires/) as string });
  });
});

describe('decideRunBudget', () => {
  it('proceeds with no per-run budget set', () => {
    expect(decideRunBudget(null, 99, false)).toEqual({ kind: 'proceed' });
    expect(decideRunBudget(undefined, 99, false)).toEqual({ kind: 'proceed' });
  });

  it('proceeds when the estimate p75 is within budget', () => {
    expect(decideRunBudget(1.0, 0.8, false)).toEqual({ kind: 'proceed' });
    expect(decideRunBudget(1.0, 1.0, false)).toEqual({ kind: 'proceed' }); // at the line is within
  });

  it('demands confirmation when the estimate exceeds the budget', () => {
    const d = decideRunBudget(1.0, 1.5, false);
    expect(d.kind).toBe('confirm');
    expect((d as { reason: string }).reason).toMatch(/\$1\.50/);
    expect((d as { reason: string }).reason).toMatch(/\$1\.00/);
    expect((d as { reason: string }).reason).toMatch(/confirmOverBudget/);
  });

  it('an explicit confirmation overrides the gate — the budget is soft', () => {
    expect(decideRunBudget(1.0, 1.5, true)).toEqual({ kind: 'proceed' });
  });

  it('a zero budget over-budgets any positive estimate', () => {
    expect(decideRunBudget(0, 0.01, false)).toMatchObject({ kind: 'confirm' });
    expect(decideRunBudget(0, 0, false)).toEqual({ kind: 'proceed' });
  });
});

describe('decideConcurrency', () => {
  it('proceeds below the ceiling', () => {
    expect(decideConcurrency(0, 3)).toEqual({ kind: 'proceed' });
    expect(decideConcurrency(2, 3)).toEqual({ kind: 'proceed' });
  });

  it('refuses at the ceiling, naming the limit in the reason the skipped run records', () => {
    expect(decideConcurrency(3, 3)).toEqual({
      kind: 'refuse', reason: 'concurrency ceiling (3) reached',
    });
  });

  it('refuses above the ceiling — a count that overshot must not slip through', () => {
    expect(decideConcurrency(7, 3)).toMatchObject({ kind: 'refuse' });
  });

  it('judges against BOT_MAX_CONCURRENT by default', () => {
    const prev = process.env['BOT_MAX_CONCURRENT'];
    try {
      delete process.env['BOT_MAX_CONCURRENT'];
      expect(botMaxConcurrent()).toBe(3);
      expect(decideConcurrency(3)).toMatchObject({ kind: 'refuse' });
      process.env['BOT_MAX_CONCURRENT'] = '5';
      expect(botMaxConcurrent()).toBe(5);
      expect(decideConcurrency(3)).toEqual({ kind: 'proceed' });
      expect(decideConcurrency(5)).toMatchObject({
        kind: 'refuse', reason: 'concurrency ceiling (5) reached',
      });
      // Unusable values fall back rather than opening the gate wide or shut.
      process.env['BOT_MAX_CONCURRENT'] = '0';
      expect(botMaxConcurrent()).toBe(3);
      process.env['BOT_MAX_CONCURRENT'] = 'many';
      expect(botMaxConcurrent()).toBe(3);
    } finally {
      if (prev === undefined) delete process.env['BOT_MAX_CONCURRENT'];
      else process.env['BOT_MAX_CONCURRENT'] = prev;
    }
  });
});

describe('renderPrompt', () => {
  it('appends the one-shot instruction on its own paragraph, before the contract', () => {
    const p = renderPrompt('Hunt tech debt.', 'focus on the auth module');
    expect(p).toContain('Hunt tech debt.\n\nFor this run specifically: focus on the auth module');
    expect(p.indexOf('For this run specifically')).toBeLessThan(p.indexOf('UNCOMMITTED'));
  });

  it('always appends the pipeline contract — a self-committing agent escapes capture', () => {
    const p = renderPrompt('Hunt tech debt.');
    expect(p).toContain('Hunt tech debt.');
    expect(p).toContain('do not run git commit');
    expect(p).toContain('UNCOMMITTED');
  });
});

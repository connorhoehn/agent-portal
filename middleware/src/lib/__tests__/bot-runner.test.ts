// Fire-guard ordering — the brakes between a trigger and a run. The ordering
// is the contract: off/paused refuses with no run row, the run cap skips
// (visibly) before cost is even considered, and only the daily budget flips
// the bot's own state. These pin that a bot in several bad states at once
// reports the right one.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

// fireBot's wiring tests drive the DB-touching edges through mocks; the rest of
// each provider stays real (requireActual) so no other loaded module loses an
// export it imports at load time. Only the functions the fire path reaches are
// overridden.
jest.mock('../../providers/bots.js', () => ({
  ...jest.requireActual('../../providers/bots.js'),
  getBot: jest.fn(),
  createBotRun: jest.fn(),
  markBotRan: jest.fn(),
  countRunningRuns: jest.fn(),
  runCostSamples: jest.fn(),
}));
jest.mock('../../providers/budgets.js', () => ({
  ...jest.requireActual('../../providers/budgets.js'),
  getBudget: jest.fn(),
}));
jest.mock('../../providers/agent-jobs.js', () => ({
  ...jest.requireActual('../../providers/agent-jobs.js'),
  enqueueJob: jest.fn(),
}));

import {
  decideFire, renderPrompt, decideConcurrency, botMaxConcurrent, decideRunBudget,
  decideAllocation, decideEnvelope, decideBotFireAllocation, decideGrantScopedDispatch,
  fireBot, botChangeRequester,
  type FireGuardInput, type EnvelopeState,
} from '../bot-runner.js';
import {
  getBot, createBotRun, markBotRan, countRunningRuns, runCostSamples, type Bot,
} from '../../providers/bots.js';
import { getBudget } from '../../providers/budgets.js';
import { enqueueJob } from '../../providers/agent-jobs.js';

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
    // Its own flag, not the shared one: confirming a per-run cap must not be
    // spendable as a confirmation of the initiative's allocation.
    expect((d as { reason: string }).reason).toMatch(/confirmOverRunBudget/);
  });

  it('an explicit confirmation overrides the gate — the budget is soft', () => {
    expect(decideRunBudget(1.0, 1.5, true)).toEqual({ kind: 'proceed' });
  });

  it('a zero budget over-budgets any positive estimate', () => {
    expect(decideRunBudget(0, 0.01, false)).toMatchObject({ kind: 'confirm' });
    expect(decideRunBudget(0, 0, false)).toEqual({ kind: 'proceed' });
  });
});

describe('decideAllocation', () => {
  // Unbudgeted is not zero-budget. An initiative nobody has funded must stay
  // dispatchable — the Budgets page surfaces it as a blind spot instead.
  it('proceeds when the initiative has no allocation', () => {
    expect(decideAllocation({ allocatedUsd: null, spentUsd: 500 }, 99, false)).toEqual({ kind: 'proceed' });
  });

  it('proceeds while the estimate fits the remaining allocation', () => {
    expect(decideAllocation({ allocatedUsd: 30, spentUsd: 10 }, 5, false)).toEqual({ kind: 'proceed' });
    // Exactly consuming the remainder is within it.
    expect(decideAllocation({ allocatedUsd: 30, spentUsd: 10 }, 20, false)).toEqual({ kind: 'proceed' });
  });

  it('demands confirmation when the estimate overruns what is left', () => {
    const d = decideAllocation({ allocatedUsd: 30, spentUsd: 25 }, 8, false);
    expect(d.kind).toBe('confirm');
    expect((d as { reason: string }).reason).toMatch(/\$5\.00 left/);
    expect((d as { reason: string }).reason).toMatch(/confirmOverAllocation/);
  });

  it('reports an exhausted allocation differently from a partial overrun', () => {
    const d = decideAllocation({ allocatedUsd: 30, spentUsd: 30 }, 1, false);
    expect((d as { reason: string }).reason).toMatch(/exhausted/);
    // Overspent past the allocation is still "exhausted", not a negative remainder.
    const over = decideAllocation({ allocatedUsd: 30, spentUsd: 44 }, 1, false);
    expect((over as { reason: string }).reason).toMatch(/exhausted/);
  });

  // Soft, like the per-run cap: this gates human-initiated work, and a hard
  // stop with no override would strand an SME mid-sprint.
  it('an explicit confirmation overrides the brake', () => {
    expect(decideAllocation({ allocatedUsd: 30, spentUsd: 30 }, 99, true)).toEqual({ kind: 'proceed' });
  });

  // ── Weak forecasts still brake ────────────────────────────────────────────
  // The brake used to be handed only a per-point (scaled) forecast, and when
  // none existed the caller skipped it entirely. These pin the replacement
  // rule: judge whatever forecast exists, on its p75, and let the confidence
  // shape the sentence rather than the verdict.

  it('brakes on a prior — the historyless first dispatch is the point of it', () => {
    // p-rag-search's real numbers: $5 allocated, nothing spent, and a sonnet-
    // tier prior of $0.15–$1.50 because nothing has ever run here.
    const d = decideAllocation(
      { allocatedUsd: 5, spentUsd: 4.2 },
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect(d.kind).toBe('confirm');
    expect(d).toMatchObject({ confidence: 'prior' });
    expect((d as { reason: string }).reason).toMatch(/\$0\.15–\$1\.50/);
    expect((d as { reason: string }).reason).toMatch(/\$0\.80 left/);
    expect((d as { reason: string }).reason).toMatch(/no history for this model yet/);
  });

  it('tests p75, not p25 — a low end that fits does not excuse the range', () => {
    // The whole failure being fixed: on p25 this proceeds and the brake sleeps
    // through every first dispatch. On p75 it asks.
    const d = decideAllocation(
      { allocatedUsd: 5, spentUsd: 4 },
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect(d.kind).toBe('confirm');
    expect((d as { reason: string }).reason).toMatch(/may not fit/);
  });

  it('escalates the wording when even the low end overruns', () => {
    const d = decideAllocation(
      { allocatedUsd: 5, spentUsd: 4.95 },
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect((d as { reason: string }).reason).toMatch(/even the low end/);
  });

  it('hedges an unscaled run-level range as a bracket, not a measurement', () => {
    const d = decideAllocation(
      { allocatedUsd: 30, spentUsd: 28 },
      { costUsdP75: 4, costUsdP25: 1, confidence: 'run-history' },
      false,
    );
    expect(d).toMatchObject({ confidence: 'run-history' });
    expect((d as { reason: string }).reason).toMatch(/not scaled to this item's size/);
    expect((d as { reason: string }).reason).toMatch(/pick a cheaper model/);
  });

  // Size-aware evidence earns a flat number. No hedging, and the wording the
  // portal already renders stays byte-identical.
  it('states a scaled forecast plainly', () => {
    const d = decideAllocation(
      { allocatedUsd: 30, spentUsd: 25 },
      { costUsdP75: 8, costUsdP25: 3, confidence: 'scaled' },
      false,
    );
    expect((d as { reason: string }).reason).toBe(
      "estimated $8.00 exceeds the $5.00 left of this initiative's $30.00 allocation — raise it or pass confirmOverAllocation",
    );
  });

  // Exhaustion is a fact about the ledger. No forecast could fit, so the
  // refusal must not sound like it depends on one.
  it('never hedges an exhausted allocation, however weak the forecast', () => {
    const d = decideAllocation(
      { allocatedUsd: 5, spentUsd: 5 },
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect((d as { reason: string }).reason).toBe(
      "this initiative's $5.00 allocation is exhausted ($5.00 spent) — raise the allocation or pass confirmOverAllocation",
    );
  });

  // Clients split the reason on its first ' — ' to separate claim from remedy;
  // an em dash inside the confidence note would truncate the claim.
  it('keeps a single em dash in every reason', () => {
    for (const confidence of ['scaled', 'run-history', 'prior'] as const) {
      const d = decideAllocation(
        { allocatedUsd: 5, spentUsd: 4 }, { costUsdP75: 3, costUsdP25: 1, confidence }, false,
      );
      expect((d as { reason: string }).reason.split(' — ')).toHaveLength(2);
    }
  });

  it('still ignores a weak forecast when the initiative is unbudgeted', () => {
    expect(decideAllocation(
      { allocatedUsd: null, spentUsd: 500 },
      { costUsdP75: 99, costUsdP25: 1, confidence: 'prior' },
      false,
    )).toEqual({ kind: 'proceed' });
  });
});

// ─── The sprint envelope ─────────────────────────────────────────────────────
//
// budget_grants rendered on the Budgets page and nothing checked it. These pin
// the replacement — and, just as importantly, pin what it refuses to claim: the
// burn is only ever the runs recorded as dispatched by this caller, never the
// initiative's spend in the window (which the Budgets page deliberately does
// NOT present as anyone's burn), and an absent attribution column means the
// burn is UNKNOWN rather than zero.

describe('decideEnvelope', () => {
  function envelope(over: Partial<EnvelopeState> = {}): EnvelopeState {
    return {
      allocatedUsd: 30, attributedSpentUsd: 0, attributionAvailable: true,
      // Deliberately the seed's own shape: real sprint names carry an em dash.
      sprintName: 'Sprint 98 — Span metrics', ...over,
    };
  }
  const reason = (d: unknown): string => (d as { reason: string }).reason;

  it('proceeds while the forecast fits what the caller has left', () => {
    expect(decideEnvelope(envelope({ attributedSpentUsd: 20 }), 5, false)).toEqual({ kind: 'proceed' });
    // Exactly consuming the remainder is within it — same line as the others.
    expect(decideEnvelope(envelope({ attributedSpentUsd: 20 }), 10, false)).toEqual({ kind: 'proceed' });
  });

  it('demands its OWN confirmation when the forecast overruns the remainder', () => {
    const d = decideEnvelope(envelope({ attributedSpentUsd: 25 }), 8, false);
    expect(d.kind).toBe('confirm');
    expect(reason(d)).toMatch(/\$5\.00 left of your \$30\.00 envelope on Sprint 98/);
    expect(reason(d)).toMatch(/confirmOverEnvelope/);
    // Not the other two gates' flags — one confirmation, one fence.
    expect(reason(d)).not.toMatch(/confirmOverAllocation|confirmOverRunBudget/);
  });

  it('names the envelope generically when the grant has no sprint', () => {
    const d = decideEnvelope(envelope({ sprintName: null, attributedSpentUsd: 29 }), 8, false);
    expect(reason(d)).toMatch(/your \$30\.00 sprint envelope/);
  });

  it('is soft — an explicit confirmation dispatches', () => {
    expect(decideEnvelope(envelope({ attributedSpentUsd: 30 }), 99, true)).toEqual({ kind: 'proceed' });
  });

  // ── What the burn is, said out loud, every time ───────────────────────────
  // A burn of $2 out of $30 is NOT "this SME has barely spent". It is "$2 of
  // spend is recorded as theirs". Every non-exhausted refusal carries that
  // caveat, because the number is small by construction.
  it('says the burn counts only runs recorded as dispatched by the caller', () => {
    const d = decideEnvelope(envelope({ attributedSpentUsd: 28 }), 8, false);
    expect(reason(d)).toMatch(/counting only runs recorded as dispatched by you/);
  });

  it('reports a spent-out envelope as a fact, with no forecast talk', () => {
    const d = decideEnvelope(
      envelope({ attributedSpentUsd: 30 }),
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect(reason(d)).toBe(
      'your $30.00 envelope on Sprint 98 – Span metrics is spent out ($30.00 dispatched by you)'
      + ' — ask for a larger envelope or pass confirmOverEnvelope',
    );
    // Overspent past the envelope is still "spent out", never a negative left.
    expect(reason(decideEnvelope(envelope({ attributedSpentUsd: 44 }), 1, false))).toMatch(/spent out/);
  });

  // ── Attribution missing: unknown, never zero ──────────────────────────────
  // The honest failure mode. Without the column nothing can be said about how
  // much of the envelope is gone, so the only surviving claim is about its
  // SIZE — and the refusal states plainly that nothing is counted against it,
  // rather than implying a full envelope.
  describe('when bot_runs carries no attribution yet', () => {
    const blind = () => envelope({ attributionAvailable: false, attributedSpentUsd: 0 });

    it('does not brake a forecast that fits the whole envelope', () => {
      expect(decideEnvelope(blind(), 29.99, false)).toEqual({ kind: 'proceed' });
    });

    it('brakes only a forecast bigger than the envelope itself, and says why', () => {
      const d = decideEnvelope(blind(), 40, false);
      expect(d.kind).toBe('confirm');
      expect(reason(d)).toMatch(/exceeds your \$30\.00 envelope on Sprint 98 . Span metrics outright/);
      expect(reason(d)).toMatch(/no run here is recorded as dispatched by anyone yet/);
      expect(reason(d)).toMatch(/nothing is counted against it/);
      expect(reason(d)).toMatch(/confirmOverEnvelope/);
    });

    it('never claims a burn it cannot support', () => {
      const d = decideEnvelope(blind(), 40, false);
      expect(reason(d)).not.toMatch(/spent out|left of/);
    });
  });

  // ── Confidence shapes the sentence, never the verdict ─────────────────────
  // Same discipline as decideAllocation: p75 is what is tested, whatever the
  // forecast is worth, and the wording is what changes.

  it('tests p75, not p25 — a low end that fits does not excuse the range', () => {
    const d = decideEnvelope(
      envelope({ attributedSpentUsd: 29 }),
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect(d).toMatchObject({ kind: 'confirm', confidence: 'prior' });
    expect(reason(d)).toMatch(/may not fit/);
    expect(reason(d)).toMatch(/no history for this model yet/);
  });

  it('escalates the wording when even the low end overruns', () => {
    const d = decideEnvelope(
      envelope({ attributedSpentUsd: 29.95 }),
      { costUsdP75: 1.5, costUsdP25: 0.15, confidence: 'prior' },
      false,
    );
    expect(reason(d)).toMatch(/even the low end/);
  });

  it('hedges an unscaled run-level range as a bracket, not a measurement', () => {
    const d = decideEnvelope(
      envelope({ attributedSpentUsd: 28 }),
      { costUsdP75: 4, costUsdP25: 1, confidence: 'run-history' },
      false,
    );
    expect(d).toMatchObject({ confidence: 'run-history' });
    expect(reason(d)).toMatch(/not scaled to this item's size/);
    expect(reason(d)).toMatch(/pick a cheaper model/);
  });

  it('states a scaled forecast plainly', () => {
    const d = decideEnvelope(
      envelope({ attributedSpentUsd: 25 }),
      { costUsdP75: 8, costUsdP25: 3, confidence: 'scaled' },
      false,
    );
    expect(reason(d)).toBe(
      'estimated $8.00 exceeds the $5.00 left of your $30.00 envelope on Sprint 98 – Span metrics'
      + ' (counting only runs recorded as dispatched by you)'
      + ' — ask for a larger envelope or pass confirmOverEnvelope',
    );
  });

  // Clients split the reason on its first ' — ' to separate claim from remedy.
  it('keeps a single em dash in every reason', () => {
    const forecasts = [
      { costUsdP75: 99, costUsdP25: 1, confidence: 'prior' as const },
      { costUsdP75: 99, costUsdP25: 1, confidence: 'run-history' as const },
      { costUsdP75: 99, costUsdP25: 1, confidence: 'scaled' as const },
    ];
    const states = [
      envelope({ attributedSpentUsd: 25 }),
      envelope({ attributedSpentUsd: 30 }),
      envelope({ attributionAvailable: false }),
    ];
    for (const f of forecasts) {
      for (const st of states) {
        const d = decideEnvelope(st, f, false);
        expect(reason(d).split(' — ')).toHaveLength(2);
      }
    }
  });
});

// ─── The opt-in bot-fire allocation brake ────────────────────────────────────
//
// Gap 2 from the operating model, decided deliberately: OFF by default (bot
// spend is the maintenance FLOOR an allocation is read against, not a braked
// figure), and when opted in it SKIPS a firing — the bot-appropriate visible
// brake — rather than 409-confirming (no human to confirm a cron trigger) or
// self-pausing (which would strand the rest of the period's maintenance).

describe('decideBotFireAllocation', () => {
  const base = {
    enforceAllocation: true, allocatedUsd: 30, spentUsd: 10, projectedCostUsd: 5,
  };

  it('is a no-op unless the bot opted in — bot spend is the floor by default', () => {
    // Even a firing that would blow the allocation proceeds when enforcement is off.
    expect(decideBotFireAllocation({ ...base, enforceAllocation: false, projectedCostUsd: 999 }))
      .toEqual({ kind: 'proceed' });
  });

  it('does not brake an unbudgeted initiative — unbudgeted is not zero', () => {
    expect(decideBotFireAllocation({ ...base, allocatedUsd: null, projectedCostUsd: 999 }))
      .toEqual({ kind: 'proceed' });
  });

  it('proceeds while the projection fits the remaining allocation', () => {
    expect(decideBotFireAllocation({ ...base, projectedCostUsd: 20 })).toEqual({ kind: 'proceed' });
    // Exactly consuming the remainder is within it.
    expect(decideBotFireAllocation({ ...base, projectedCostUsd: 20, spentUsd: 10 }))
      .toEqual({ kind: 'proceed' });
  });

  it('skips (never pauses) when the projection overruns the remainder', () => {
    const d = decideBotFireAllocation({ ...base, spentUsd: 28, projectedCostUsd: 5 });
    expect(d.kind).toBe('skip');
    expect((d as { reason: string }).reason).toMatch(/\$2\.00 left/);
    expect((d as { reason: string }).reason).toMatch(/skipped/);
  });

  it('reports an exhausted allocation as a fact, not a projection overrun', () => {
    const d = decideBotFireAllocation({ ...base, spentUsd: 30, projectedCostUsd: 1 });
    expect((d as { reason: string }).reason).toMatch(/exhausted/);
    // Overspent past the allocation is still "exhausted", not a negative remainder.
    expect((decideBotFireAllocation({ ...base, spentUsd: 44, projectedCostUsd: 1 }) as { reason: string }).reason)
      .toMatch(/exhausted/);
  });
});

// ─── Grant-scoped dispatch authorization ─────────────────────────────────────
//
// Gap 1: DispatchAgentRun is role-wide, so an sme could dispatch anywhere. This
// scopes it to initiatives the sme holds an active grant on — a HARD verdict
// (allow/deny → 403), not a soft brake: a missing grant is missing
// authorization, not a forecast to override.

describe('decideGrantScopedDispatch', () => {
  it('allows an sme who holds an active grant here', () => {
    expect(decideGrantScopedDispatch({ role: 'sme', hasActiveGrant: true }))
      .toEqual({ kind: 'allow' });
  });

  it('denies an sme with no grant at all here, naming the initiative', () => {
    const d = decideGrantScopedDispatch({
      role: 'sme', hasActiveGrant: false, hasAnyGrant: false, initiativeName: 'Observability Platform',
    });
    expect(d.kind).toBe('deny');
    expect((d as { reason: string }).reason).toMatch(/no active sprint grant on Observability Platform/);
    expect((d as { reason: string }).reason).toMatch(/ask the release manager/);
    // Hard authorization — no confirmFlag to wave it through.
    expect((d as { reason: string }).reason).not.toMatch(/confirmOver/);
  });

  // The bug: an SME who DOES hold a grant, but on a not-yet-active (planned)
  // sprint, was told "you hold no active sprint grant — ask the release manager
  // for a grant" — sent to request something they already have. The reword must
  // say the grant exists and its sprint hasn't started, and must NOT tell them
  // to ask for a grant.
  it('denies an sme whose grant is on a not-yet-active sprint with the right words', () => {
    const d = decideGrantScopedDispatch({
      role: 'sme', hasActiveGrant: false, hasAnyGrant: true, initiativeName: 'Observability Platform',
    });
    expect(d.kind).toBe('deny');
    const reason = (d as { reason: string }).reason;
    expect(reason).toMatch(/you hold a sprint grant on Observability Platform/);
    expect(reason).toMatch(/sprint has not started yet/);
    // Do not send them to request a grant they already hold.
    expect(reason).not.toMatch(/ask the release manager for a grant/);
    // Still a hard authorization deny — no override flag.
    expect(reason).not.toMatch(/confirmOver/);
  });

  it('falls back to a generic place when the initiative name is unknown', () => {
    const noGrant = decideGrantScopedDispatch({ role: 'sme', hasActiveGrant: false, hasAnyGrant: false });
    expect((noGrant as { reason: string }).reason).toMatch(/no active sprint grant here/);
    const planned = decideGrantScopedDispatch({ role: 'sme', hasActiveGrant: false, hasAnyGrant: true });
    expect((planned as { reason: string }).reason).toMatch(/you hold a sprint grant here/);
  });

  it('treats an omitted hasAnyGrant as no-grant-at-all — the safe fallback wording', () => {
    const d = decideGrantScopedDispatch({ role: 'sme', hasActiveGrant: false });
    expect((d as { reason: string }).reason).toMatch(/no active sprint grant/);
    expect((d as { reason: string }).reason).toMatch(/ask the release manager/);
  });

  it('always allows the roles that allocate/administer — they need no grant', () => {
    for (const role of ['org-leader', 'hr-admin', 'admin'] as const) {
      expect(decideGrantScopedDispatch({ role, hasActiveGrant: false })).toEqual({ kind: 'allow' });
    }
  });

  it('does not grant-scope an unknown or absent role — not this check\'s to deny', () => {
    expect(decideGrantScopedDispatch({ role: undefined, hasActiveGrant: false })).toEqual({ kind: 'allow' });
    expect(decideGrantScopedDispatch({ role: null, hasActiveGrant: false })).toEqual({ kind: 'allow' });
    expect(decideGrantScopedDispatch({ role: 'member', hasActiveGrant: false })).toEqual({ kind: 'allow' });
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

// ─── fireBot: the opt-in allocation brake, wired ─────────────────────────────
//
// The pure decideBotFireAllocation is proven above; these pin the WIRING inside
// fireBot: default-off is a genuine no-op (no budget read, no forecast, fires
// normally), and when a bot opts in a cron firing over its initiative's
// remaining allocation records a *skipped* bot_run (the run cap's path, reused —
// not a new terminal state) and does not enqueue. An initiative-target bot is
// used throughout so the fire path is markBotRan → enqueueJob → createBotRun,
// with no devbox workspace to stand up.

const mGetBot = getBot as jest.Mock;
const mCreateBotRun = createBotRun as jest.Mock;
const mMarkBotRan = markBotRan as jest.Mock;
const mCountRunning = countRunningRuns as jest.Mock;
const mRunSamples = runCostSamples as jest.Mock;
const mGetBudget = getBudget as jest.Mock;
const mEnqueueJob = enqueueJob as jest.Mock;

/** A fireable initiative-target bot; `sonnet`'s static prior (no history) puts
 *  the p75 projection at $1.50, so a test picks whether it fits by the budget. */
function fireableBot(over: Partial<Bot> = {}): Bot {
  return {
    id: 'b-1', name: 'Dep bumps', template: 'story', prompt: 'Bump deps.',
    agentProjectId: null, agentProjectRepo: null,
    orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
    model: 'sonnet', trigger: 'cron', cronExpr: '0 6 * * *', enabled: true,
    budgetPerRunUsd: null, budgetPerDayUsd: null, maxRunsPerDay: 4, requiresReview: true,
    enforceAllocation: false, createdBy: null, createdAt: '2026-08-01T00:00:00Z',
    lastRunAt: null, pausedReason: null, todaySpendUsd: 0, todayRunCount: 0,
    ...over,
  };
}

describe('fireBot — opt-in allocation brake', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mCountRunning.mockResolvedValue(0);
    mMarkBotRan.mockResolvedValue(undefined);
    mRunSamples.mockResolvedValue(null); // no history → the model's static prior
    mEnqueueJob.mockResolvedValue({ id: 'job-1' });
    mCreateBotRun.mockResolvedValue({ id: 'run-1' });
  });

  it('default-off is a pure no-op — no budget read, no forecast, fires normally', async () => {
    mGetBot.mockResolvedValue(fireableBot({ enforceAllocation: false }));

    const res = await fireBot('b-1', { trigger: 'cron' });

    expect(res.ok).toBe(true);
    // The brake never ran: it read neither the allocation nor a forecast.
    expect(mGetBudget).not.toHaveBeenCalled();
    expect(mRunSamples).not.toHaveBeenCalled();
    // And the firing dispatched for real (queued a job), not a skipped row.
    expect(mEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mCreateBotRun).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }));
    expect(mCreateBotRun).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('opted-in + projection over the remainder records a skipped run and does NOT dispatch', async () => {
    mGetBot.mockResolvedValue(fireableBot({ enforceAllocation: true }));
    // $2 allocated, $1.50 spent → $0.50 left; the sonnet prior p75 ($1.50) overruns it.
    mGetBudget.mockResolvedValue({ allocatedUsd: 2, spentThisPeriodUsd: 1.5 });

    const res = await fireBot('b-1', { trigger: 'cron' });

    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/skipped/);
    expect(mCreateBotRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    // Braked before dispatch: no job queued.
    expect(mEnqueueJob).not.toHaveBeenCalled();
  });

  it('opted-in + projection fits the remainder fires normally', async () => {
    mGetBot.mockResolvedValue(fireableBot({ enforceAllocation: true }));
    mGetBudget.mockResolvedValue({ allocatedUsd: 30, spentThisPeriodUsd: 0 });

    const res = await fireBot('b-1', { trigger: 'cron' });

    expect(res.ok).toBe(true);
    expect(mEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mCreateBotRun).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('opted-in but the initiative is unbudgeted does NOT skip — unbudgeted is not zero', async () => {
    mGetBot.mockResolvedValue(fireableBot({ enforceAllocation: true }));
    mGetBudget.mockResolvedValue(null); // no allocation row for this initiative

    const res = await fireBot('b-1', { trigger: 'cron' });

    expect(res.ok).toBe(true);
    expect(mEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mCreateBotRun).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('leaves a hand-driven (manual) fire untouched even when opted in', async () => {
    mGetBot.mockResolvedValue(fireableBot({ enforceAllocation: true, trigger: 'manual' }));
    // A budget tight enough to skip a cron fire — but this is manual, so the
    // brake must not even look at it.
    mGetBudget.mockResolvedValue({ allocatedUsd: 2, spentThisPeriodUsd: 1.5 });

    const res = await fireBot('b-1', { trigger: 'manual' });

    expect(res.ok).toBe(true);
    expect(mGetBudget).not.toHaveBeenCalled();
    expect(mEnqueueJob).toHaveBeenCalledTimes(1);
  });
});

// DE-43: who a bot run's captured change answers to.
describe('botChangeRequester', () => {
  it('is whoever pressed run for a manual or marketplace firing', () => {
    expect(botChangeRequester({ createdBy: 'u-nora' }, 'u-eli')).toBe('u-eli');
  });
  it('is the bot\'s creator for a cron firing nobody pressed', () => {
    expect(botChangeRequester({ createdBy: 'u-nora' }, null)).toBe('u-nora');
    expect(botChangeRequester({ createdBy: 'u-nora' })).toBe('u-nora');
  });
  it('is null only when neither is known', () => {
    expect(botChangeRequester({ createdBy: null }, null)).toBeNull();
  });
});

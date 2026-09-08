// `safeExec`, and the one caller that must never use it.
//
// The helper is narrower than its name: it swallows exactly ONE class of error
// — the relation not existing — so a cluster that predates
// `agent_bots_schema.sql` renders an empty roster instead of a 500, and every
// other failure still propagates. That much is a deliberate, defensible
// contract and it is kept.
//
// What was wrong is that its one swallowed class produced two answers spelled
// the same way, and one caller turned the swallowed answer into a NUMBER a
// safety brake is judged against:
//
//   * `listBots` → `{ bots: [] }` meant "no bots configured" (ordinary; the
//     page invites you to create one) and "there is no bots table" (the page
//     invites you to create one into a table that is not there).
//   * `countRunningRuns` → no rows → `toNum(undefined)` → **0 running**, which
//     is the entire input to the global concurrency ceiling in
//     lib/bot-runner.ts. The brake read its own blindness as full headroom.
//
// The first is fixed with the same envelope as everything else in this slice.
// The second cannot be: a count is a scalar and "unknown" is not a number, so
// it must fail loudly instead — which is the rule this module already applied
// to writes, now applied to the one read that is really a decision.

const exec = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...a: unknown[]) => exec(...a) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../budgets.js', () => ({ spendPredicateSql: () => '1=1', listGrants: jest.fn(), getBudget: jest.fn() }));
jest.mock('../work-items.js', () => ({ getWorkItem: jest.fn(), mockWorkItemProjectId: jest.fn() }));
jest.mock('../projects.js', () => ({ mockProjectName: jest.fn() }));

import { countRunningRuns, listBotsResult, listBotRunsResult } from '../bots.js';

const MISSING_TABLE = 'relation "bots" does not exist';
const BOT_UUID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => exec.mockReset());

describe('listBotsResult', () => {
  it('a genuinely empty roster carries no marker', async () => {
    exec.mockResolvedValue([]);
    expect(await listBotsResult()).toEqual({ items: [] });
  });

  it('a missing bots table is the same empty roster, saying so', async () => {
    exec.mockRejectedValue(new Error(MISSING_TABLE));
    const r = await listBotsResult();
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.error).toMatch(/bots schema not applied/);
  });

  it('still does not swallow anything else — a timeout is a real error', async () => {
    // The narrowness is the reason the helper is worth keeping. If this ever
    // starts resolving, `safeExec` has quietly become a blanket catch.
    exec.mockRejectedValue(new Error('Communications link failure'));
    await expect(listBotsResult()).rejects.toThrow(/Communications link failure/);
  });
});

describe('listBotRunsResult', () => {
  it('"this bot has never fired" and "there is no bot_runs table" are different answers', async () => {
    exec.mockResolvedValue([]);
    const quiet = await listBotRunsResult(BOT_UUID);
    exec.mockRejectedValue(new Error('relation "bot_runs" does not exist'));
    const broken = await listBotRunsResult(BOT_UUID);
    expect(quiet.items).toEqual(broken.items);
    expect(quiet.degraded).toBeUndefined();
    expect(broken.degraded).toBe(true);
  });
});

describe('countRunningRuns — the brake that must not swallow', () => {
  it('counts what the database says', async () => {
    exec.mockResolvedValue([{ n: 3 }]);
    expect(await countRunningRuns()).toBe(3);
  });

  it('THROWS on a missing bot_runs table rather than reporting zero in flight', async () => {
    // Through safeExec this resolved to 0, and `decideConcurrency(0)` admitted
    // every dispatch. A ceiling that cannot count must refuse, not wave
    // everything through — and it is cheap to be wrong about, since a missing
    // bot_runs means `createBotRun` could not have recorded the run either.
    exec.mockRejectedValue(new Error('relation "bot_runs" does not exist'));
    await expect(countRunningRuns()).rejects.toThrow(/does not exist/);
  });

  it('never answers 0 for a failed read of any kind', async () => {
    for (const message of [MISSING_TABLE, 'AccessDenied', 'timeout']) {
      exec.mockRejectedValue(new Error(message));
      await expect(countRunningRuns()).rejects.toThrow();
    }
  });
});

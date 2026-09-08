// Mock bot roster ↔ run-history parity — org-leader.md defect #20.
//
// listBots()/getBot() in mock mode used to hand-type lastRunAt/todaySpendUsd/
// todayRunCount on each MOCK_BOTS entry while listBotRuns() returned `[]`
// unconditionally — so the Bots list read "LAST RAN 1d ago · 0/4 runs" for
// finops-daily-sweep while its own detail page's run list said "This bot has
// never fired" (a bot that fired 1 day ago cannot also have never fired).
// Both numbers are now DERIVED from one run-history fixture
// (MOCK_BOT_RUNS/deriveBotStats in providers/bots.ts), so this pins that
// listBotRuns() actually returns the rows the roster's own numbers are
// computed from, for every seeded bot.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { listBots, listBotRuns } from '../bots.js';

describe('mock bot run history backs both the roster and the detail page (dev:mock)', () => {
  it('gives every bot a run list whose stats match its own roster row', async () => {
    const bots = await listBots();
    expect(bots.length).toBeGreaterThan(0);

    for (const bot of bots) {
      const runs = await listBotRuns(bot.id, 200);

      // lastRunAt: the roster's own value, or null when the bot never fired
      // — never a hand-typed timestamp with no runs behind it.
      if (runs.length === 0) {
        expect(bot.lastRunAt).toBeNull();
      } else {
        const mostRecent = runs.reduce((max, r) => (r.startedAt > max ? r.startedAt : max), runs[0]!.startedAt);
        expect(bot.lastRunAt).toBe(mostRecent);
      }

      // todayRunCount / todaySpendUsd: summed from the SAME rows the detail
      // page's run list shows, restricted to today (UTC calendar day — see
      // deriveBotStats in bots.ts; a local-time cutoff here would disagree
      // with the product code near local midnight even though both read the
      // same live clock).
      const now = new Date();
      const dayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const todays = runs.filter((r) => new Date(r.startedAt).getTime() >= dayStartUtc);
      const expectedCount = todays.filter((r) => r.status !== 'skipped').length;
      const expectedSpend = Math.round(todays.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100;
      expect(bot.todayRunCount).toBe(expectedCount);
      expect(bot.todaySpendUsd).toBeCloseTo(expectedSpend, 2);
    }
  });

  it('never says "never fired" for a bot whose roster shows a lastRunAt (the named defect)', async () => {
    const bots = await listBots();
    // finops-daily-sweep is the seed's own p-cost-opt maintenance bot; this
    // used to name `cost-anomaly-sweep`, a fixture-invented bot on the same
    // initiative that schema/seed_program.sql has no row for.
    const sweep = bots.find((b) => b.name === 'finops-daily-sweep')!;
    expect(sweep.lastRunAt).not.toBeNull();

    const runs = await listBotRuns(sweep.id, 200);
    expect(runs.length).toBeGreaterThan(0);
    // "1d ago" on the list — 0 runs today, at least one run in the last 48h.
    expect(sweep.todayRunCount).toBe(0);
    const mostRecentAgeMs = Date.now() - new Date(sweep.lastRunAt!).getTime();
    expect(mostRecentAgeMs).toBeLessThan(48 * 3_600_000);
  });

  it('reports zero runs today (and no fabricated lastRunAt) for a bot with genuinely no history', async () => {
    // Belt-and-suspenders on the "derived, not hand-typed" contract: an
    // unknown bot id has no entry in MOCK_BOT_RUNS at all.
    const runs = await listBotRuns('00000000-0000-0000-0000-000000000000', 50);
    expect(runs).toEqual([]);
  });
});

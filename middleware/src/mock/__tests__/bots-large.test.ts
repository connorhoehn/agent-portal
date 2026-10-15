// mock/bots.ts's `large` branch on `botRuns`.
//
// WHY THIS EXISTS. `listBotRuns`/`listBotRunsResult`/`listBotRunsForBotsResult`
// (providers/bots.ts) all cap a single bot's run history at 200 rows — the
// seed gives every bot only 6-10 runs across ~30 days, so nothing offline
// could reach that cap.

import { botRuns, seededRunsByBotId } from '../bots.js';
import { fixtureRegistry } from '../core/index.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('botRuns large scenario', () => {
  it('is bigger than default, and every seeded bot individually passes the 200-run cap', () => {
    const seeded = botRuns.rows('default');
    const large = botRuns.rows('large');
    expect(large.length).toBeGreaterThan(seeded.length);

    const byBot = new Map<string, number>();
    for (const run of large) byBot.set(run.botId ?? '', (byBot.get(run.botId ?? '') ?? 0) + 1);
    // Every bot the seed names, not just the busiest one.
    const seededBotIds = Object.keys(seededRunsByBotId());
    expect(seededBotIds.length).toBeGreaterThan(0);
    for (const botId of seededBotIds) {
      expect(byBot.get(botId) ?? 0).toBeGreaterThan(200);
    }
  });

  it('every large run has a well-formed id and jobId, unique, and keeps the seed cost when a template supplied one', () => {
    const large = botRuns.rows('large');
    const ids = new Set(large.map((r) => r.id));
    expect(ids.size).toBe(large.length);
    // Bot history only. The two in-flight marketplace runs (bot-less, no job
    // yet — mock/bots.ts `inFlightMarketplaceRuns`) ride along in every
    // non-empty world and are pinned by their own shape below.
    const inFlight = large.filter((r) => r.botId === null && r.status === 'running');
    expect(inFlight.map((r) => r.status)).toEqual(['running', 'running']);
    // The finished marketplace dispatches (mock/bots.ts `finishedMarketplaceRuns`)
    // are bot-less too, but they settled with a cost.
    for (const run of large.filter((r) => r.botId === null && r.status !== 'running')) {
      expect(run.status).toBe('done');
      expect(typeof run.costUsd).toBe('number');
      expect(run.jobId).toBeNull();
    }
    for (const run of inFlight) {
      expect(run.jobId).toBeNull();
      expect(run.costUsd).toBeNull();
    }
    for (const run of large.filter((r) => r.botId !== null)) {
      expect(run.id).toMatch(/^[0-9a-f-]+-run-\d+$/);
      // A skipped firing never dispatched, so it has no job to link to.
      if (run.status === 'skipped') expect(run.jobId).toBeNull();
      else expect(run.jobId).toMatch(/^job-.+-\d+$/);
      expect(typeof run.costUsd === 'number' || run.costUsd === null).toBe(true);
    }
  });

  it('the extra rows extend history further into the past, never touching "today"', () => {
    const seeded = botRuns.rows('default');
    const large = botRuns.rows('large');
    const seededIds = new Set(seeded.map((r) => r.id));
    const extra = large.filter((r) => !seededIds.has(r.id));
    expect(extra.length).toBeGreaterThan(0);
    const now = Date.now();
    for (const run of extra) {
      const startedAtMs = new Date(run.startedAt).getTime();
      expect(startedAtMs).toBeLessThan(now);
    }
  });

  it('reset restores the seeded run count', () => {
    fixtureRegistry.resetAll('large');
    expect(botRuns.rows().length).toBeGreaterThan(200 * Object.keys(seededRunsByBotId()).length * 0.5);

    fixtureRegistry.resetAll('default');
    expect(botRuns.rows()).toEqual(botRuns.rows('default'));
    expect(botRuns.rows().length).toBeLessThan(200);
  });
});

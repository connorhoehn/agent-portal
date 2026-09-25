// The maintenance-bot fleet and its `bot_runs` history, offline.
//
// These rows were three module-level arrays inside providers/bots.ts:
// `MOCK_BOT_RUNS` (the seeded cron history), `MOCK_BOTS` (the roster) and
// `MOCK_LIVE_RUNS` (every run this process recorded). They moved here for the
// reasons the floor exists (docs/mock-floor.md):
//
//   1. NOTHING COULD PUT THEM BACK. A write-capture sweep can only replay a
//      write it can undo, and `POST /api/__mock/reset` walks the fixture
//      registry — which none of the three were in. So pausing a bot, resuming
//      one, or dispatching a run left the world permanently changed, and the
//      sweep had to refuse those routes or replay them as echo-backs (writing a
//      value straight back so the row ends byte-identical), which proves
//      nothing. Behind a fixture, every one of them is undone by a reset.
//   2. THE TIMESTAMPS WERE BAKED AT IMPORT. An array literal at module scope
//      calls the clock once, when the process boots. A frozen-clock test
//      therefore needed `jest.resetModules()` before the freeze, and a
//      long-running `dev:mock` drifted: "2 runs today" meant two runs on the day
//      the server started. A fixture's rows factory runs on first READ and again
//      after every reset, so the history is stamped against the instant the
//      request (or the frozen test) is actually asking about.
//   3. `POST /api/bots` had no mock branch at all — createBot returned null,
//      the route read that as a failure and answered 503, so creating a bot was
//      simply dead offline. A create has to mutate something, and mutating a
//      bare module array is the "auditor damages shared state and warns the next
//      auditor" problem the scenario plane exists to end.
//
// WHAT IS SEED AND WHAT IS SESSION. Two fixtures, deliberately, because Aurora
// has one `bot_runs` table written by two different things:
//   `botRuns`     — the ~30 days of cron history schema/seed_program.sql seeds.
//                   Reproducible; a reset rebuilds it.
//   `liveBotRuns` — every run `createBotRun` recorded in this process. A reset
//                   drops them, which is exactly what restarting the middleware
//                   already did. Readers sum BOTH (see `allMockRuns`), because
//                   Postgres does not care which of them wrote a row.

import { clock, defineFixture, latestBy, sumBy, todayInUtc, toRecord, groupBy } from './core/index.js';
import { liveArrayView, liveRecordView } from './live-view.js';
import type { Bot, BotRun } from '../providers/bots.js';

// ─── The seeded run history ──────────────────────────────────────────────────

/**
 * A run that happened EARLIER TODAY, `hoursAgo` hours back.
 *
 * The clamp is the whole point, and it is the clock's own (`keepWithinToday`,
 * mock/core/clock.ts) rather than a second hand-rolled copy of the same
 * arithmetic: the offset is flavor for the demo narrative ("2 runs today"), not
 * a promise the run really happened that long ago, so it is clamped to the
 * elapsed part of the UTC day. Without it, obs-nightly-maintenance's "14 hours
 * ago" today-run reads as yesterday's for the first ~14 UTC hours of a day (and
 * auth-dep-watch/llm-evals-nightly's "3 hours ago" for the first 3) — the exact
 * shape of bug `deriveBotStats`' UTC cutoff below fixes on the read side; this
 * fixes it on the write side, so a run stamped "today" is never further into the
 * past than "today" extends.
 */
function todayAt(hoursAgo: number): string {
  return clock.hoursAgo(hoursAgo, { keepWithinToday: true });
}

/** A run on a previous day — the seed's `NOW() - INTERVAL 'N days'`. */
function daysBack(days: number): string {
  return clock.daysAgo(days);
}

function genRun(botId: string, seq: number, startedAtIso: string, costUsd: number, jobPrefix: string): BotRun {
  const startedAt = new Date(startedAtIso);
  const finishedAt = new Date(startedAt.getTime() + 4 * 60_000);
  return {
    id: `${botId}-run-${seq}`,
    botId,
    trigger: 'cron',
    runId: null,
    jobId: `job-${jobPrefix}-${seq}`,
    workItemId: null,
    status: 'done',
    costUsd,
    // Null, not 'bedrock', because schema/seed_program.sql does not write the
    // column and this fixture mirrors that seed. These rows are exactly the
    // history the migration deliberately leaves un-backfilled, so offline they
    // must read the same way they read on the cluster: cost recorded, provenance
    // not. Typing 'bedrock' here would make the one state the column exists to
    // expose — "we do not know what served this" — unreachable in dev:mock.
    modelProvider: null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    // What a real run's outcome records beside the reason (lib/devbox-runner.ts
    // OutcomeSummary): how many turns it took and how many tools it called.
    // Deterministic from the sequence so the derived tool-call strip on the
    // Automate pages has rows to draw under dev:mock — a fixture that said
    // "0 tools" for every finished maintenance run made that strip
    // unreachable offline. Cost stays as seeded; a $0.20 run of three or
    // four calls is the shape the cluster's own rows have.
    outcome: { reason: 'scheduled maintenance', turns: 2 + (seq % 3), toolCalls: 3 + (seq % 4) },
    dispatchedBy: null,
  };
}

// A run history per bot, mirroring the ~30 days of bot_runs CLAUDE.md documents
// schema/seed_program.sql seeding for the maintenance bots. lastRunAt /
// todaySpendUsd / todayRunCount are DERIVED from these rows (deriveBotStats
// below) rather than typed by hand on each roster entry — before that fix the
// list read "LAST RAN 1d ago · 0/4 runs" (from a hand-typed lastRunAt) while
// `listBotRuns()` returned `[]` unconditionally in mock mode, so the detail
// page's own run list said "This bot has never fired" for the very same bot
// (org-leader.md defect #20). One array backs both.
//
// The `jobPrefix` passed to genRun is NOT free text: schema/seed_program.sql
// names every cron-minted job `job-<slug>-maint-N`, and a run-history row
// renders a link to /iq/work/<jobId>. A prefix this fixture invented
// (`job-auth-dep-*`, `job-llm-eval-*`) produced links that open an id Aurora can
// never have, so the same click worked offline and 404'd on the real cluster.
// Each prefix below is the seed's own, and the sequence count stays within the
// number of jobs the seed actually mints for that bot.
function seededRunsByBot(): Record<string, BotRun[]> {
  return {
    // obs-nightly-maintenance — 2 runs today (0.16 + 0.10 = 0.26), then a
    // roughly-every-4-days cadence back to 27 days. Seed: job-obs-maint-1..10.
    '32970d0a-e28e-5100-8fb0-a5cbb87dac99': [
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 1, todayAt(1), 0.16, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 2, todayAt(14), 0.10, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 3, daysBack(3), 0.20, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 4, daysBack(7), 0.28, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 5, daysBack(11), 0.19, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 6, daysBack(15), 0.31, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 7, daysBack(19), 0.22, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 8, daysBack(23), 0.27, 'obs-maint'),
      genRun('32970d0a-e28e-5100-8fb0-a5cbb87dac99', 9, daysBack(27), 0.18, 'obs-maint'),
    ],
    // auth-dep-watch — 1 run today (0.11), weekday-ish cadence back to 28 days.
    // Seed: job-auth-maint-1..8.
    '697c6a52-72e2-57f7-8e44-062ab9935336': [
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 1, todayAt(3), 0.11, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 2, daysBack(4), 0.09, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 3, daysBack(8), 0.13, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 4, daysBack(12), 0.10, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 5, daysBack(16), 0.08, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 6, daysBack(20), 0.14, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 7, daysBack(24), 0.09, 'auth-maint'),
      genRun('697c6a52-72e2-57f7-8e44-062ab9935336', 8, daysBack(28), 0.11, 'auth-maint'),
    ],
    // llm-evals-nightly — 1 run today (0.74), nightly cadence back to 24 days.
    // Seed: job-llm-maint-1..9, so the history stops at 9 rather than minting a
    // tenth id the seed has no job for.
    'affd22b0-b348-5436-9eff-2b8d5206d601': [
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 1, todayAt(3), 0.74, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 2, daysBack(1), 0.68, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 3, daysBack(2), 0.71, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 4, daysBack(5), 0.79, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 5, daysBack(8), 0.66, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 6, daysBack(12), 0.70, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 7, daysBack(16), 0.73, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 8, daysBack(20), 0.69, 'llm-maint'),
      genRun('affd22b0-b348-5436-9eff-2b8d5206d601', 9, daysBack(24), 0.65, 'llm-maint'),
    ],
    // inference-canary-nightly — 3 runs today (0.20 + 0.14 + 0.08 = 0.42), then
    // a nightly-ish cadence back to 22 days. Seed: job-inf-maint-1..7.
    '1edd9a68-e432-5dc2-b89d-93867bd090da': [
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 1, todayAt(0.4), 0.20, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 2, todayAt(5), 0.14, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 3, todayAt(10), 0.08, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 4, daysBack(2), 0.12, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 5, daysBack(4), 0.09, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 6, daysBack(6), 0.15, 'inf-maint'),
      genRun('1edd9a68-e432-5dc2-b89d-93867bd090da', 7, daysBack(9), 0.11, 'inf-maint'),
    ],
    // finops-daily-sweep — the "ran recently, nothing today" case: it last fired
    // ~26h ago (so "1d ago" on the roster) with 0 runs today, which is what the
    // list and the detail page's run list must BOTH say (org-leader.md #20 was
    // "1d ago" beside "this bot has never fired"). Seed: job-cost-maint-1..11.
    '4448041c-0350-5d7f-930e-7dbcd87a149f': [
      genRun('4448041c-0350-5d7f-930e-7dbcd87a149f', 1, clock.hoursAgo(26), 0.18, 'cost-maint'),
      genRun('4448041c-0350-5d7f-930e-7dbcd87a149f', 2, daysBack(3), 0.22, 'cost-maint'),
    ],

    // ── The seven bots the roster used to omit ────────────────────────────────
    //
    // This fixture mirrored 5 of schema/seed_program.sql's 12 maintenance bots
    // and said so in a comment, which made the omission honest but not harmless:
    // spend is DERIVED from these rows (providers/budgets.ts), so p-soc2,
    // p-feature-store and p-mobile-redesign each derived $0 against a real
    // monthly allocation, four more initiatives never appeared on the ledger at
    // all, and the org summary's by-model and by-trigger cards had exactly one
    // row each — a breakdown that cannot demonstrate a breakdown.
    //
    // Unlike the five above (whose costs and "N runs today" cadence are demo
    // narrative), every row below is the seed's OWN run history: the same job
    // ids, the same `NOW() - INTERVAL 'N days'` offsets, the same cost to four
    // decimal places. A mock that invents a number Aurora cannot produce is the
    // bug this whole floor exists to stop, and there was no reason to invent one
    // when the seed already had the rows.

    // stream-lag-watch (p-realtime-analytics) — seed: job-rta-maint-1..6.
    '15a4eb8e-743b-57f8-835b-3a7aac701702': [
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 1, daysBack(1), 0.1392, 'rta-maint'),
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 2, daysBack(6), 0.1916, 'rta-maint'),
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 3, daysBack(11), 0.0646, 'rta-maint'),
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 4, daysBack(16), 0.1978, 'rta-maint'),
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 5, daysBack(21), 0.1132, 'rta-maint'),
      genRun('15a4eb8e-743b-57f8-835b-3a7aac701702', 6, daysBack(26), 0.1460, 'rta-maint'),
    ],
    // feature-drift-nightly (p-feature-store) — seed: job-fs-maint-1..7.
    '88d1fd78-0618-5431-865e-027db71adb27': [
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 1, daysBack(1), 0.2848, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 2, daysBack(5), 0.1440, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 3, daysBack(9), 0.1596, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 4, daysBack(13), 0.1043, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 5, daysBack(17), 0.2034, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 6, daysBack(21), 0.2126, 'fs-maint'),
      genRun('88d1fd78-0618-5431-865e-027db71adb27', 7, daysBack(25), 0.2774, 'fs-maint'),
    ],
    // mobile-e2e-nightly (p-mobile-redesign) — seed: job-mob-maint-1..6. This is
    // the maintenance floor under Mia Singh's (p-030, program-owner) own
    // initiative, which the ledger reported as $0 while allocating $15/month.
    '5168695c-fa7e-5ca0-9218-ffa4453947a9': [
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 1, daysBack(1), 0.2073, 'mob-maint'),
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 2, daysBack(6), 0.1568, 'mob-maint'),
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 3, daysBack(11), 0.0755, 'mob-maint'),
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 4, daysBack(16), 0.1915, 'mob-maint'),
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 5, daysBack(21), 0.2045, 'mob-maint'),
      genRun('5168695c-fa7e-5ca0-9218-ffa4453947a9', 6, daysBack(26), 0.1022, 'mob-maint'),
    ],
    // a11y-audit-weekly (p-design-v3) — weekly, so only 4 rows. Seed:
    // job-ds-maint-1..4.
    'a0a4b025-3e67-5004-8b8a-05a3d4f2028d': [
      genRun('a0a4b025-3e67-5004-8b8a-05a3d4f2028d', 1, daysBack(1), 0.1499, 'ds-maint'),
      genRun('a0a4b025-3e67-5004-8b8a-05a3d4f2028d', 2, daysBack(8), 0.1952, 'ds-maint'),
      genRun('a0a4b025-3e67-5004-8b8a-05a3d4f2028d', 3, daysBack(15), 0.3790, 'ds-maint'),
      genRun('a0a4b025-3e67-5004-8b8a-05a3d4f2028d', 4, daysBack(22), 0.3011, 'ds-maint'),
    ],
    // rag-index-health (p-rag-search) — the cheapest floor in the fleet, on a
    // COMPLETED initiative: shipped work still costs money to keep alive, which
    // is the point docs/program-operating-model.md makes about maintenance.
    // Seed: job-rag-maint-1..5.
    'f595b10b-5f52-50d0-81a0-9117e9334fb4': [
      genRun('f595b10b-5f52-50d0-81a0-9117e9334fb4', 1, daysBack(1), 0.1331, 'rag-maint'),
      genRun('f595b10b-5f52-50d0-81a0-9117e9334fb4', 2, daysBack(7), 0.0774, 'rag-maint'),
      genRun('f595b10b-5f52-50d0-81a0-9117e9334fb4', 3, daysBack(13), 0.1478, 'rag-maint'),
      genRun('f595b10b-5f52-50d0-81a0-9117e9334fb4', 4, daysBack(19), 0.0911, 'rag-maint'),
      genRun('f595b10b-5f52-50d0-81a0-9117e9334fb4', 5, daysBack(25), 0.0725, 'rag-maint'),
    ],
    // compliance-evidence-cron (p-soc2) — seed: job-soc2-maint-1..8.
    '28006587-cf6f-5a60-a68c-6a574ba7cb5d': [
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 1, daysBack(1), 0.1739, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 2, daysBack(4), 0.1409, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 3, daysBack(7), 0.1548, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 4, daysBack(10), 0.1017, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 5, daysBack(13), 0.1694, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 6, daysBack(16), 0.1726, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 7, daysBack(19), 0.0934, 'soc2-maint'),
      genRun('28006587-cf6f-5a60-a68c-6a574ba7cb5d', 8, daysBack(22), 0.0707, 'soc2-maint'),
    ],
    // api-contract-watch (p-design-system-api) — seed: job-dsapi-maint-1..6.
    '402eb3d6-0cf2-55a4-b5b5-deb9be35b01f': [
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 1, daysBack(1), 0.0662, 'dsapi-maint'),
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 2, daysBack(6), 0.0764, 'dsapi-maint'),
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 3, daysBack(11), 0.1715, 'dsapi-maint'),
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 4, daysBack(16), 0.1701, 'dsapi-maint'),
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 5, daysBack(21), 0.0814, 'dsapi-maint'),
      genRun('402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', 6, daysBack(26), 0.2112, 'dsapi-maint'),
    ],
  };
}

// `listBotRuns`/`listBotRunsResult`/`listBotRunsForBotsResult` (providers/
// bots.ts) all cap at 200 runs PER BOT — every seeded bot has only 6-10, so
// nothing offline could reach that cap. `largeBotRuns` extends each bot's own
// history further back using the SAME `genRun` the seed uses, deriving the
// job-id prefix and per-run cost from that bot's own last seeded run (a real
// jobId pattern, not an invented one) rather than typing a new corpus.
const LARGE_EXTRA_RUNS_PER_BOT = 220;

function largeBotRuns(): BotRun[] {
  const seeded = seededRunsByBot();
  const out: BotRun[] = [];
  for (const [botId, runs] of Object.entries(seeded)) {
    out.push(...runs);
    const template = runs[runs.length - 1];
    if (!template) continue;
    const prefixMatch = /^job-(.+)-\d+$/.exec(template.jobId ?? '');
    const jobPrefix = prefixMatch ? prefixMatch[1]! : botId;
    for (let i = 0; i < LARGE_EXTRA_RUNS_PER_BOT; i += 1) {
      const seq = runs.length + i + 1;
      // Continue the seed's own cadence further into the past — `daysBack`
      // rather than `todayAt`, so "today" stays exactly what the seed says it
      // is and only the OLDER history grows.
      out.push(genRun(botId, seq, daysBack(31 + i), template.costUsd ?? 0.1, jobPrefix));
    }
  }
  return out;
}

/**
 * Two marketplace runs in flight right now, on Observability Platform.
 *
 * WHY THEY EXIST. The Initiatives page reads "2 agents running" for
 * Observability (docs/design/initiative-variants-*, decision D3). That number
 * used to be a typed `activeAgents: 2` on the initiative fixture — rule 1's
 * exact bug: a count beside a run table with no running row in it, so the rail
 * said two agents were working while the Agents tab, the active-runs badge and
 * the concurrency ceiling all saw none. The count is now derived from these
 * rows, so it is true everywhere at once.
 *
 * Shape: what `createBotRun` records for a marketplace dispatch
 * (lib/bot-runner.ts — `botId: null`, `trigger: 'marketplace'`, a work item,
 * no cost yet), on the two `in_progress` items of the initiative's current
 * sprint. `jobId` null keeps them out of the `bot_runs` parity entity (which
 * keys on job_id) and out of mock/agent-jobs.ts (which mints a job per jobId).
 * `dispatchedBy` null: no envelope burns down for them — they carry no cost.
 *
 * They are not in schema/seed_program.sql, so a seeded Aurora reads "Idle" for
 * Observability. That is a documented divergence (docs/mock-floor.md), not
 * drift: a seed cannot hold a run "in flight" without it being in flight
 * forever, and the reconcile/sweep arms would rightly fail it on first boot.
 * Offline, both of those arms are no-ops (lib/bot-runner.ts), so these stay
 * running until a reset re-stamps them. They take two of the three concurrency
 * slots (lib/bot-runner.ts `botMaxConcurrent`), so one more offline dispatch
 * still fits.
 */
function inFlightMarketplaceRuns(): BotRun[] {
  const inFlight = (id: string, workItemId: string, minutesAgo: number): BotRun => ({
    id,
    botId: null,
    trigger: 'marketplace',
    runId: null,
    jobId: null,
    workItemId,
    status: 'running',
    costUsd: null,
    modelProvider: null,
    startedAt: clock.hoursAgo(minutesAgo / 60),
    finishedAt: null,
    outcome: {},
    dispatchedBy: null,
  });
  return [
    // "Span-metrics connector feeding RED dashboards" — Layla Hassan, 8 points.
    inFlight('run-inflight-obs-e1-s3', 'wi-obs-e1-s3', 18),
    // "Collector OOMs under burst ingest when queue is unbounded" — Eli Garcia.
    inFlight('run-inflight-obs-e1-b5', 'wi-obs-e1-b5', 42),
  ];
}

/**
 * The seeded cron history — one FLAT list, because `bot_runs` is one table.
 *
 * `default` — the ~30 days schema/seed_program.sql writes for the twelve
 *             maintenance bots, plus the two in-flight marketplace runs
 *             (`inFlightMarketplaceRuns` — mock-only, see there).
 * `empty`   — a fleet that has never fired. Declared explicitly: an undeclared
 *             scenario falls back to `default`, and this is the state the
 *             "no runs yet" copy on the roster and the detail page is for.
 * `large`   — every bot's history extended to 220+ runs, past the 200-row
 *             per-bot cap `listBotRuns` and friends apply.
 */
export const botRuns = defineFixture<BotRun>({
  key: 'bot-runs',
  scenarios: {
    default: () => [...Object.values(seededRunsByBot()).flat(), ...inFlightMarketplaceRuns()],
    empty: () => [],
    large: () => [...largeBotRuns(), ...inFlightMarketplaceRuns()],
  },
});

/**
 * Runs THIS process recorded — the other half of the same table.
 *
 * Kept separate from `botRuns` on purpose. That one is a seed and must stay
 * reproducible; this one is session state, and a reset dropping it is exactly
 * what restarting the middleware already did. Registering it is what makes a
 * dispatch in `dev:mock` undoable: before this, a replayed
 * `POST /api/bots/dispatch-work` left a permanent row on the initiative's
 * ledger, its activity graph and its sprint envelope.
 */
export const liveBotRuns = defineFixture<BotRun>({
  key: 'bot-runs-live',
  scenarios: { default: () => [] },
});

/** Seeded history and session rows together — what Postgres sees as `bot_runs`. */
export function allMockRuns(): BotRun[] {
  return [...botRuns.rows(), ...liveBotRuns.rows()];
}

/** The seeded history for one bot, in seed order. */
export function seededRunsFor(botId: string): BotRun[] {
  return botRuns.rows().filter((r) => r.botId === botId);
}

/** Session rows for one bot. */
export function liveRunsFor(botId: string): BotRun[] {
  return liveBotRuns.rows().filter((r) => r.botId === botId);
}

/**
 * The seeded history grouped by bot — a SELECTOR over the flat rows, never a
 * second stored copy. Kept because providers/agent-jobs.ts mints a matching mock
 * `agent_jobs` row per run and reads the history that way.
 */
export function seededRunsByBotId(): Record<string, BotRun[]> {
  // Bot-less rows (the in-flight marketplace runs) are nobody's bot history,
  // so they are not grouped under an invented 'unassigned' bot id.
  return toRecord(groupBy(botRuns.rows().filter((r) => r.botId !== null), (r) => r.botId as string));
}

// ─── The roster ──────────────────────────────────────────────────────────────

/**
 * lastRunAt / todaySpendUsd / todayRunCount from a bot's own run history —
 * mirroring the real BOT_SELECT lateral's semantics (calendar-day "today",
 * skipped runs excluded from the count but not from the spend total) so a mock
 * bot's roster numbers are judged the exact same way a real one's are.
 *
 * "Today" is `todayInUtc`, the floor's single definition of the word, and it
 * buckets in UTC because Aurora's `date_trunc('day', NOW())` truncates in the
 * session timezone, which is UTC. A local-time cutoff here drifts from the real
 * predicate on any host not itself in UTC and, on a laptop, silently drops the
 * most-recent run out of "today" for the first few local hours after midnight
 * (activity.test.ts caught exactly that).
 */
export function deriveBotStats(runs: readonly BotRun[]): Pick<Bot, 'lastRunAt' | 'todaySpendUsd' | 'todayRunCount'> {
  const todays = todayInUtc(runs, 'startedAt');
  return {
    lastRunAt: latestBy(runs, 'startedAt')?.startedAt ?? null,
    todaySpendUsd: sumBy(todays, 'costUsd', { digits: 2 }),
    todayRunCount: todays.filter((r) => r.status !== 'skipped').length,
  };
}

/** The reason every seeded bot carries in schema/seed_program.sql's
 *  `paused_reason` — spelled once so the fixture cannot drift from it. */
export const SEED_PAUSED_REASON = 'awaiting repo provisioning — un-pause once the repository exists';

type BotSeed = Partial<Bot> & Pick<Bot, 'id' | 'name' | 'template' | 'prompt' | 'orgProjectId' | 'orgProjectName'>;

function mockBot(over: BotSeed): Bot {
  return {
    agentProjectId: null, agentProjectRepo: null,
    model: 'us.amazon.nova-lite-v1:0', trigger: 'cron', cronExpr: '0 6 * * *',
    // Parked by default, exactly as the seed writes them — see the roster note
    // below. An entry that wants to be live has to say so and own why.
    enabled: false, budgetPerRunUsd: 0.5, budgetPerDayUsd: 2, maxRunsPerDay: 4,
    requiresReview: true, enforceAllocation: false, createdBy: 'u-rachel',
    createdAt: clock.daysAgo(45),
    pausedReason: SEED_PAUSED_REASON,
    ...deriveBotStats(seededRunsFor(over.id)),
    ...over,
  };
}

// Mirrors schema/seed_program.sql's maintenance bots so dev:mock shows the same
// fleet the Queue page reports on — the SAME bot ids, the same budgets and,
// critically, the same PARKED state.
//
// Every seeded bot is `enabled = FALSE` with `paused_reason = 'awaiting repo
// provisioning …'` on purpose (CLAUDE.md, "Program operating model"):
// initBotScheduler registers every enabled cron bot at boot and the fleet
// dispatcher claims queued jobs as soon as a box is idle, so an enabled bot here
// fires against repositories that do not exist yet. This fixture used to flip
// three of them to `enabled: true` "so the queue's bots panel has motion
// offline" — a fixture that demonstrates the exact configuration the seed
// documents as unsafe, and one a developer copying dev:mock state into Aurora
// would carry across. Parked is the honest state: a roster reading "0 enabled"
// over real run history is the product working, not a broken page.
//
// Their run HISTORY is unaffected — a parked bot that fired before it was parked
// still has runs, which is exactly the seed's shape too.
function seededBots(): Bot[] {
  return [
    mockBot({ id: '32970d0a-e28e-5100-8fb0-a5cbb87dac99', name: 'obs-nightly-maintenance', template: 'bug',
      prompt: 'Nightly maintenance for the observability stack: bump collector and SDK dependencies, triage flaky pipeline tests, lint dashboards for broken panels.',
      orgProjectId: 'p-observability', orgProjectName: 'Observability Platform' }),
    // 0.4/1.5, not 0.5/2 — these are the exact numbers decideRunBudget and the
    // daily brake compare against, so a fixture that rounds them up demonstrates
    // a money gate the seeded bot does not have.
    mockBot({ id: '697c6a52-72e2-57f7-8e44-062ab9935336', name: 'auth-dep-watch', template: 'bug',
      prompt: 'Weekday dependency and CVE watch for the auth service: bump patch versions, flag security advisories as critical.',
      orgProjectId: 'p-auth-migration', orgProjectName: 'Auth Migration', cronExpr: '0 5 * * 1-5',
      budgetPerRunUsd: 0.4, budgetPerDayUsd: 1.5 }),
    mockBot({ id: 'affd22b0-b348-5436-9eff-2b8d5206d601', name: 'llm-evals-nightly', template: 'story',
      prompt: 'Re-run the golden-set eval suite against the live prompt versions; summarize score drift per agent.',
      orgProjectId: 'p-llm-platform', orgProjectName: 'LLM Application Platform', cronExpr: '30 4 * * *',
      budgetPerRunUsd: 0.8, budgetPerDayUsd: 3 }),
    // These last two used to be `pr-review-analyst` (p-inference-platform) and
    // `cost-anomaly-sweep` (p-cost-opt) — invented bots on real initiatives that
    // already have their own seeded maintenance mission. Mirrored to the seed's
    // rows: an id here has to be an id Aurora can produce.
    mockBot({ id: '1edd9a68-e432-5dc2-b89d-93867bd090da', name: 'inference-canary-nightly', template: 'bug',
      prompt: 'Nightly canary of every served model version: latency and error deltas against the previous build, rollback recommendation on breach.',
      orgProjectId: 'p-inference-platform', orgProjectName: 'Inference Platform', cronExpr: '15 3 * * *',
      budgetPerRunUsd: 0.4, budgetPerDayUsd: 1.5 }),
    mockBot({ id: '4448041c-0350-5d7f-930e-7dbcd87a149f', name: 'finops-daily-sweep', template: 'bug',
      prompt: "Daily spend sweep: diff yesterday's cost by service against the 7-day baseline, flag anomalies over 20%, and list untagged resources created in the last day.",
      orgProjectId: 'p-cost-opt', orgProjectName: 'Cost Optimization', cronExpr: '0 7 * * *',
      budgetPerRunUsd: 0.3, budgetPerDayUsd: 1 }),

    // The remaining seven of schema/seed_program.sql's twelve maintenance bots.
    // Ids, names, missions, cron expressions and per-run/per-day budgets are the
    // seed's, so a fixture bot is always a bot Aurora can produce — and so the
    // money gates a demo exercises offline are the gates the seeded bot really
    // carries. See the matching block in seededRunsByBot for why the omission
    // was not harmless.
    mockBot({ id: '15a4eb8e-743b-57f8-835b-3a7aac701702', name: 'stream-lag-watch', template: 'bug',
      prompt: 'Watch consumer lag and checkpoint duration; when lag trends past threshold, profile the hot operator and file a bug with the trace.',
      orgProjectId: 'p-realtime-analytics', orgProjectName: 'Real-time Analytics Pipeline', cronExpr: '15 */6 * * *',
      budgetPerRunUsd: 0.25, budgetPerDayUsd: 1.2 }),
    mockBot({ id: '88d1fd78-0618-5431-865e-027db71adb27', name: 'feature-drift-nightly', template: 'story',
      prompt: 'Nightly drift check across production feature groups; summarize distribution shifts and file a story when retraining is warranted.',
      orgProjectId: 'p-feature-store', orgProjectName: 'ML Feature Store', cronExpr: '45 3 * * *',
      budgetPerRunUsd: 0.35, budgetPerDayUsd: 1.2 }),
    mockBot({ id: '5168695c-fa7e-5ca0-9218-ffa4453947a9', name: 'mobile-e2e-nightly', template: 'bug',
      prompt: 'Run the end-to-end suite on both platforms nightly; quarantine flaky specs with a linked issue and keep the suite under 20 minutes.',
      orgProjectId: 'p-mobile-redesign', orgProjectName: 'Mobile App Redesign', cronExpr: '0 2 * * *',
      budgetPerRunUsd: 0.3, budgetPerDayUsd: 1 }),
    mockBot({ id: 'a0a4b025-3e67-5004-8b8a-05a3d4f2028d', name: 'a11y-audit-weekly', template: 'bug',
      prompt: 'Weekly accessibility audit of the component library: contrast, focus order, ARIA completeness; file one bug per component regression.',
      orgProjectId: 'p-design-v3', orgProjectName: 'Design System v3', cronExpr: '0 8 * * 1',
      budgetPerRunUsd: 0.45, budgetPerDayUsd: 1 }),
    mockBot({ id: 'f595b10b-5f52-50d0-81a0-9117e9334fb4', name: 'rag-index-health', template: 'bug',
      prompt: 'Verify index freshness and citation link integrity; re-embed documents whose sources changed.',
      orgProjectId: 'p-rag-search', orgProjectName: 'RAG Knowledge Search', cronExpr: '0 9 * * *',
      // The seed gives this one its OWN park reason — its initiative is
      // finished, which is a different remedy from "provision the repo". The
      // blanket default overwrote it, so an operator read the wrong fix.
      pausedReason: 'initiative completed — bot parked',
      budgetPerRunUsd: 0.2, budgetPerDayUsd: 0.6 }),
    mockBot({ id: '28006587-cf6f-5a60-a68c-6a574ba7cb5d', name: 'compliance-evidence-cron', template: 'story',
      prompt: 'Weekday evidence sweep: snapshot IAM diffs, change-management records, and backup verifications into the evidence store.',
      orgProjectId: 'p-soc2', orgProjectName: 'SOC2 Compliance', cronExpr: '0 6 * * 1-5',
      budgetPerRunUsd: 0.25, budgetPerDayUsd: 0.8 }),
    mockBot({ id: '402eb3d6-0cf2-55a4-b5b5-deb9be35b01f', name: 'api-contract-watch', template: 'bug',
      prompt: 'Weekday contract check: diff the published component API against consumers, flag breaking drift, and verify codemods still apply.',
      orgProjectId: 'p-design-system-api', orgProjectName: 'Design System API', cronExpr: '30 7 * * 1-5',
      budgetPerRunUsd: 0.25, budgetPerDayUsd: 0.8 }),
  ];
}

/**
 * The maintenance fleet.
 *
 * `default` — schema/seed_program.sql's twelve bots, all parked.
 * `empty`   — no bot has been created yet. Declared explicitly, because that is
 *             the state the "create your first bot" copy is for, and it is now
 *             reachable: `POST /api/bots` has a mock branch that pushes here.
 */
export const bots = defineFixture<Bot>({
  key: 'bots',
  scenarios: {
    default: () => seededBots(),
    empty: () => [],
    // The roster that feeds the queue. An unreadable roster is not an empty
    // one: scheduled maintenance may still be firing while the page shows no
    // bots at all.
    error: () => { throw new Error('bots unavailable: relation does not exist'); },
  },
});

// ─── Compatibility views ─────────────────────────────────────────────────────
//
// `MOCK_BOTS` and `MOCK_BOT_RUNS` are read across module boundaries
// (providers/agent-jobs.ts, providers/budgets.ts, providers/activity.ts and
// several suites). They stay, as LIVE views onto the fixtures rather than the
// arrays they used to be, so a reset reaches those readers too — see
// mock/live-view.ts for why a captured array would go stale.

/** The roster, live. Mutating a row here mutates the fixture (and a reset undoes it). */
export const MOCK_BOTS: Bot[] = liveArrayView(() => bots.rows());

/** The SEEDED history, grouped by bot id. Session rows are not in here — they
 *  are in `liveBotRuns`, and every money reader sums both via `allMockRuns`. */
export const MOCK_BOT_RUNS: Record<string, BotRun[]> = liveRecordView(() => seededRunsByBotId());

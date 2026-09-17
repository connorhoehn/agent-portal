// Named crawl targets — the rows "Ingest sources" (`/admin/ingest/crawl`)
// lists, seeded for `dev:mock`.
//
// WHY THIS EXISTS. `lib/crawl-targets.ts::listCrawlTargets()` read straight
// from a module-level array hydrated from `crawl-targets.json` on disk — a
// file that does not exist offline, so `initCrawlTargets()` always started
// from `[]` and `GET /api/ingest/crawl-targets` answered `{"targets":[]}` in
// every dev:mock demo. Contract rule 5: an unbuilt feature and an unseeded
// one looked identical.
//
// ⚠️ THE SAFETY POINT. `initCrawlTargets()` calls `registerTask()` for every
// target it loads, and `registerTask` schedules a REAL `node-cron` job that
// fires `startCrawl()` on a timer. Seeding rows with `enabled: true` +
// `cronExpr` set is not by itself safe to wire into that loop: `crawler.ts`'s
// `runFetchMode` ('fetch' mode) does a raw, UNCONDITIONAL `fetch(url)` with no
// `config.mock` gate anywhere in it — so even with `MOCK_AGENTCORE=true`, a
// live cron tick against a `mode: 'fetch'` target reaches the real internet.
// ('browser'/'browser_spa' modes route through the mocked `agentcore`
// provider and are inert offline, but 'fetch' mode is not, and a fixture
// cannot assume every target a demo later adds will avoid it.)
//
// The fix lives in `lib/crawl-targets.ts::registerTask`, which now returns
// immediately whenever `config.mock.aurora` is true — for every target, not
// only the ones seeded here, and regardless of `enabled`/`cronExpr`/`mode`.
// That is the "don't call registerTask under mock at all" branch rather than
// "seed only disabled targets": seeding-only-disabled would still leave a
// demo user free to flip a target's `enabled` toggle (or add a new
// `mode: 'fetch'` target with a cron) and get a live timer hitting the public
// internet from a laptop running `dev:mock`. Gating the whole function is the
// only branch that is actually safe, so these rows are free to seed a
// currently-enabled, currently-scheduled target — it is exactly the state the
// "Ingest sources" page should be able to show — without ever reaching a real
// `cron.schedule` call.
//
// WHAT IS SEEDED. Three targets covering what the page renders differently:
// a scheduled + enabled target (cron set), an on-demand-only + enabled target
// (no cron — cronExpr null is its own state), and a disabled target (paused).
// Every `lastRunId` here points at a row that really exists in
// `ingest-crawls.ts`'s `crawlSessionRows` — see that file for why
// `lastStatus` is 'running' on all three regardless of how each referenced
// run actually ended.

import { clock, defineFixture } from './core/index.js';
import type { CrawlTarget } from '../lib/crawler-types.js';

function seedTargets(): CrawlTarget[] {
  return [
    // Scheduled + enabled — currently mid-run (crawl-mock-0004, 'running').
    {
      id: 'target-mock-0001',
      label: 'AWS Well-Architected docs',
      startUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
      maxPages: 25,
      mode: 'browser',
      includePattern: '^(/wellarchitected)(/|$)',
      sameOriginOnly: true,
      cronExpr: '0 3 * * 1',
      enabled: true,
      createdAt: clock.daysAgo(30),
      lastRunId: 'crawl-mock-0004',
      lastRunAt: clock.hoursAgo(0.2),
      // `recordTargetRun` is called exactly once, synchronously right after
      // `startCrawl()` returns — while the session is still `running`, before
      // the background loop has had a chance to reach a terminal state — and
      // nothing in crawl-targets.ts ever updates it again. So a target's
      // `lastStatus` freezes at 'running' from the moment it is dispatched
      // and stays there forever, even once the referenced crawl finishes.
      // This is real production behaviour (see `lib/crawl-targets.ts` and
      // `lib/crawler.ts::startCrawl`), not a seeding shortcut — target-0002
      // and target-0003 below deliberately keep it even though their runs
      // have since gone terminal.
      lastStatus: 'running',
      nextRunAt: null, // cron-parser not available; the real code always leaves this null too.
    },
    // On-demand only (no cron) + enabled — last run failed (crawl-mock-0002).
    {
      id: 'target-mock-0002',
      label: 'Internal engineering wiki',
      startUrl: 'https://wiki.internal.example.com/engineering',
      maxPages: 40,
      mode: 'fetch',
      includePattern: null,
      sameOriginOnly: true,
      cronExpr: null,
      enabled: true,
      createdAt: clock.daysAgo(14),
      lastRunId: 'crawl-mock-0002',
      lastRunAt: clock.hoursAgo(20),
      lastStatus: 'running', // stale — see target-mock-0001's comment.
      nextRunAt: null,
    },
    // Scheduled but PAUSED (enabled: false) — last run was cancelled
    // (crawl-mock-0003). Exercises the disabled-target state the page has to
    // render differently from an active one.
    {
      id: 'target-mock-0003',
      label: 'Product changelog',
      startUrl: 'https://changelog.example.com',
      maxPages: 15,
      mode: 'browser_spa',
      includePattern: null,
      sameOriginOnly: true,
      cronExpr: '0 */6 * * *',
      enabled: false,
      createdAt: clock.daysAgo(60),
      lastRunId: 'crawl-mock-0003',
      lastRunAt: clock.daysAgo(5),
      lastStatus: 'running', // stale — see target-mock-0001's comment.
      nextRunAt: null,
    },
  ];
}

/**
 * The offline crawl-target list.
 *
 * `empty` is the honest state for a brand-new demo before anyone has
 * configured a source to crawl.
 */
export const crawlTargetRows = defineFixture<CrawlTarget>({
  key: 'ingest-crawl-targets',
  scenarios: {
    default: seedTargets,
    empty: () => [],
  },
});

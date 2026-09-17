// The three ingest-pipeline surfaces that were blank in the whole dev:mock
// demo — "Ingest sources" (crawl targets), "Ingest runs" (crawl history) and
// "Ingest schedule" — each backed by a plain in-memory store with no mock
// branch at all. See ingest-crawl-targets.ts / ingest-crawls.ts /
// ingest-schedules.ts for the full story; these tests pin the PROPERTIES the
// seed exists for (contract rule 5, and the devbox-fleet precedent in
// devbox-fleet-fixture.test.ts), not the row contents.
//
// THE SAFETY PROPERTY IS THE POINT: `initCrawlTargets()` (and
// `initScheduler()`) call `registerTask()` for every row they load, and that
// schedules a REAL `node-cron` job. `crawl-targets.ts::registerTask` and
// `ingest-scheduler.ts::registerTask` are both gated on `config.mock.aurora`
// now — this file proves it by mocking `node-cron` and asserting `schedule`
// is never called while booting a mock world that DOES seed an
// enabled+cronExpr row (target-mock-0001, ingest-schedule-mock-0001).

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, cloudwatch: true, guardrails: true }, aurora: {}, foundation: {} },
}));

const scheduleMock = jest.fn((..._args: unknown[]) => ({ stop: jest.fn() }));
jest.mock('node-cron', () => ({
  __esModule: true,
  default: {
    schedule: (expr: string, fn: () => void, opts: unknown) => scheduleMock(expr, fn, opts),
    validate: (expr: string) => (jest.requireActual('node-cron') as { validate: (e: string) => boolean }).validate(expr),
  },
}));

import { fixtureRegistry, freezeClock, unfreezeClock } from '../core/index.js';
import { crawlTargetRows } from '../ingest-crawl-targets.js';
import { crawlSessionRows } from '../ingest-crawls.js';
import { ingestScheduleRows } from '../ingest-schedules.js';
import { kbDataSourceRows } from '../knowledge-base.js';
import {
  initCrawlTargets, listCrawlTargets, rehydrateMockCrawlTargets,
} from '../../lib/crawl-targets.js';
import { listCrawls, rehydrateMockCrawls } from '../../lib/crawler.js';
import { initScheduler, listSchedules, rehydrateMockSchedules } from '../../lib/ingest-scheduler.js';

const AT = '2026-09-17T12:00:00.000Z';
let restore: () => void;

beforeEach(() => {
  restore = freezeClock(AT);
  fixtureRegistry.resetAll('default');
  scheduleMock.mockClear();
});
afterEach(() => {
  restore();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

describe('the three ingest stores are seeded, not empty by construction', () => {
  it('crawl targets, crawls and schedules all have rows', () => {
    expect(crawlTargetRows.rows().length).toBeGreaterThan(0);
    expect(crawlSessionRows.rows().length).toBeGreaterThan(0);
    expect(ingestScheduleRows.rows().length).toBeGreaterThan(0);
  });

  it('all three declare `empty` — an undeclared scenario silently falls back to `default`', () => {
    expect(crawlTargetRows.rows('empty')).toEqual([]);
    expect(crawlSessionRows.rows('empty')).toEqual([]);
    expect(ingestScheduleRows.rows('empty')).toEqual([]);
  });
});

describe('cross-store coherence', () => {
  it('every crawl session with a targetId points at a target that actually exists', () => {
    const targetIds = new Set(crawlTargetRows.rows().map((t) => t.id));
    for (const session of crawlSessionRows.rows()) {
      if (session.targetId !== null) expect(targetIds.has(session.targetId)).toBe(true);
    }
  });

  it('at least one crawl session has no target — the ad-hoc "no target" case is real, not assumed away', () => {
    expect(crawlSessionRows.rows().some((s) => s.targetId === null)).toBe(true);
  });

  it('every target with a lastRunId points at a crawl session that actually exists', () => {
    const sessionIds = new Set(crawlSessionRows.rows().map((s) => s.id));
    for (const target of crawlTargetRows.rows()) {
      if (target.lastRunId !== null) expect(sessionIds.has(target.lastRunId)).toBe(true);
    }
  });

  it('every schedule references a data source that /api/ingest/data-sources actually seeds', () => {
    const dataSourceIds = new Set(kbDataSourceRows.rows().map((d) => d.id));
    for (const schedule of ingestScheduleRows.rows()) {
      expect(dataSourceIds.has(schedule.dataSourceId)).toBe(true);
    }
  });
});

describe('state coverage — each page renders these differently, so more than one is seeded', () => {
  it('crawl sessions cover completed, failed, cancelled and running', () => {
    const statuses = new Set(crawlSessionRows.rows().map((s) => s.status));
    expect(statuses.has('completed')).toBe(true);
    expect(statuses.has('failed')).toBe(true);
    expect(statuses.has('cancelled')).toBe(true);
    expect(statuses.has('running')).toBe(true);
  });

  it('a running session has no completedAt; a terminal one does', () => {
    for (const s of crawlSessionRows.rows()) {
      if (s.status === 'running') expect(s.completedAt).toBeNull();
      else expect(s.completedAt).not.toBeNull();
    }
  });

  it('schedules cover both enabled and disabled', () => {
    const enabled = ingestScheduleRows.rows().map((s) => s.enabled);
    expect(enabled.some((e) => e === true)).toBe(true);
    expect(enabled.some((e) => e === false)).toBe(true);
  });

  it('crawl targets cover enabled and disabled, and scheduled (cronExpr set) vs on-demand (null)', () => {
    const rows = crawlTargetRows.rows();
    expect(rows.some((t) => t.enabled === false)).toBe(true);
    expect(rows.some((t) => t.cronExpr !== null)).toBe(true);
    expect(rows.some((t) => t.cronExpr === null)).toBe(true);
  });
});

describe('every timestamp comes from the frozen clock', () => {
  it('crawl targets', () => {
    const now = Date.parse(AT);
    for (const t of crawlTargetRows.rows()) {
      expect(Date.parse(t.createdAt)).toBeLessThanOrEqual(now);
      if (t.lastRunAt) expect(Date.parse(t.lastRunAt)).toBeLessThanOrEqual(now);
    }
  });

  it('crawl sessions', () => {
    const now = Date.parse(AT);
    for (const s of crawlSessionRows.rows()) {
      expect(Date.parse(s.startedAt)).toBeLessThanOrEqual(now);
      if (s.completedAt) expect(Date.parse(s.completedAt)).toBeGreaterThanOrEqual(Date.parse(s.startedAt));
      for (const p of s.pages) expect(Date.parse(p.crawledAt)).toBeLessThanOrEqual(now);
    }
  });

  it('schedules', () => {
    const now = Date.parse(AT);
    for (const s of ingestScheduleRows.rows()) {
      expect(Date.parse(s.createdAt)).toBeLessThanOrEqual(now);
      if (s.lastRunAt) expect(Date.parse(s.lastRunAt)).toBeLessThanOrEqual(now);
    }
  });
});

describe('the read seam: lib/crawl-targets.ts, lib/crawler.ts, lib/ingest-scheduler.ts', () => {
  it('listCrawlTargets/listCrawls/listSchedules return the seeded rows under mock', () => {
    initCrawlTargets();
    initScheduler();
    expect(listCrawlTargets().length).toBeGreaterThan(0);
    expect(listCrawls().length).toBeGreaterThan(0);
    expect(listSchedules().length).toBeGreaterThan(0);
  });

  it('no seeded target — enabled, with a cronExpr — ever registers a real cron task', () => {
    // target-mock-0001 is enabled with a cronExpr set (see ingest-crawl-targets.ts),
    // and ingest-schedule-mock-0001 is enabled with a cronExpr set too — both
    // exist specifically to prove this, not to dodge it.
    expect(crawlTargetRows.rows().some((t) => t.enabled && t.cronExpr)).toBe(true);
    expect(ingestScheduleRows.rows().some((s) => s.enabled && s.cronExpr)).toBe(true);

    initCrawlTargets();
    initScheduler();

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  describe('the mock-control reset seam', () => {
    it('mutating targets/crawls/schedules is visible on the next read, and rehydrate puts the seed back', () => {
      initCrawlTargets();
      initScheduler();

      const before = listCrawlTargets().length;
      listCrawlTargets().pop(); // mutate the live array the way a DELETE route would
      expect(listCrawlTargets().length).toBe(before - 1);

      expect(rehydrateMockCrawlTargets()).toBe(crawlTargetRows.rows().length);
      expect(listCrawlTargets().length).toBe(before);
    });

    it('rehydrateMockCrawls restores the seeded session count after a mutation', () => {
      initCrawlTargets();
      const before = listCrawls().length;
      // Simulate a demo mutation the way cancelCrawl or a completed run would.
      const target = listCrawls()[0];
      if (target) target.status = 'failed';

      expect(rehydrateMockCrawls()).toBe(crawlSessionRows.rows().length);
      expect(listCrawls().length).toBe(before);
    });

    it('rehydrateMockSchedules restores the seeded schedule count after a mutation', () => {
      initScheduler();
      const before = listSchedules().length;
      listSchedules().pop();
      expect(listSchedules().length).toBe(before - 1);

      expect(rehydrateMockSchedules()).toBe(ingestScheduleRows.rows().length);
      expect(listSchedules().length).toBe(before);
    });

    it('all three rehydrate functions are no-ops (return 0) when Aurora is not mocked', () => {
      // A quick, local override — the top-of-file config mock stays `aurora:
      // true` for every other test in this file, so this checks the guard
      // itself rather than relying on a second config mock module.
      const configModule = jest.requireMock('../../config.js') as { config: { mock: { aurora: boolean } } };
      const original = configModule.config.mock.aurora;
      configModule.config.mock.aurora = false;
      try {
        expect(rehydrateMockCrawlTargets()).toBe(0);
        expect(rehydrateMockCrawls()).toBe(0);
        expect(rehydrateMockSchedules()).toBe(0);
      } finally {
        configModule.config.mock.aurora = original;
      }
    });
  });
});

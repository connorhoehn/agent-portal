// Data-source ingestion schedules — the rows "Ingest schedule"
// (`/admin/ingest/schedules`) lists, seeded for `dev:mock`.
//
// WHY THIS EXISTS. `lib/ingest-scheduler.ts` keeps `schedules` as a plain
// module array hydrated from `ingest-schedules.json` on disk, no mock branch
// — so offline it always started from `[]` and `GET /api/ingest/schedules`
// answered `{"schedules":[]}`. Same contract-rule-5 gap as
// `ingest-crawl-targets.ts` and `ingest-crawls.ts`.
//
// SAFETY. `initScheduler()` calls `registerTask()` for every schedule, which
// wires a real `node-cron` job. Unlike the crawl-target cron
// (`ingest-crawl-targets.ts`'s header explains why THAT one is unconditionally
// dangerous), this one's action — `startIngestionJob` — already has its own
// `config.mock.agentcore` branch (`providers/knowledge-base.ts::mockStartJob`)
// that never leaves the process. So a live tick here would not reach AWS.
// `registerTask` is gated on `config.mock.aurora` anyway, for the same reason
// the fleet and the crawl targets are: a `dev:mock` process should hold no
// live timers at all — not because this particular one can escape to the
// internet, but so a demo (or a test run, or `tsx watch`'s reload) never has
// a background cron ticking against seeded rows behind the operator's back.
//
// COHERENCE. Both `dataSourceId` values below are
// `mock/knowledge-base.ts::kbDataSourceRows`' one seeded row
// (`DSMOCK0001AB`, `orgiq-documents-s3`) — the same id `GET
// /api/ingest/data-sources` already returns, so the schedule page's data
// source picker and this list agree on what exists.
//
// STATE COVERAGE. One enabled schedule, one disabled — the toggle state the
// page renders as a switch. Note `lastStatus` on `ingest-schedule-mock-0001`
// is 'STARTING', not 'COMPLETE': `registerTask`'s cron callback records
// `result.status` straight from `startIngestionJob`'s return value, which
// under mock is always `mockStartJob`'s freshly-minted job at `STARTING` —
// nothing polls it to a terminal state afterward. That is real behaviour
// (see `lib/ingest-scheduler.ts`), not an invented shortcut.
// `ingest-schedule-mock-0002` shows the OTHER real outcome the code
// distinguishes on purpose: it fired while a manual sync was already running,
// which `classifyStartJobFailure` reports as a conflict — recorded as
// `'SKIPPED'`, not `'FAILED'`, so a schedule that fired into an in-flight
// sync does not read as broken.

import { clock, defineFixture } from './core/index.js';
import type { IngestSchedule } from '../lib/ingest-scheduler.js';

const DATA_SOURCE_ID = 'DSMOCK0001AB';
const DATA_SOURCE_NAME = 'orgiq-documents-s3';

function seedSchedules(): IngestSchedule[] {
  return [
    // Enabled, fires nightly, last dispatch went through cleanly.
    {
      id: 'ingest-schedule-mock-0001',
      dataSourceId: DATA_SOURCE_ID,
      dataSourceName: DATA_SOURCE_NAME,
      cronExpr: '0 2 * * *',
      label: 'Nightly full resync',
      enabled: true,
      createdAt: clock.daysAgo(45),
      lastRunAt: clock.hoursAgo(7),
      lastJobId: 'IJMOCK0201',
      lastStatus: 'STARTING',
    },
    // Disabled after its last firing landed on an in-flight manual sync.
    {
      id: 'ingest-schedule-mock-0002',
      dataSourceId: DATA_SOURCE_ID,
      dataSourceName: DATA_SOURCE_NAME,
      cronExpr: '0 */4 * * *',
      label: 'Frequent delta sync (paused)',
      enabled: false,
      createdAt: clock.daysAgo(20),
      lastRunAt: clock.daysAgo(6),
      lastJobId: null,
      lastStatus: 'SKIPPED',
    },
  ];
}

/**
 * The offline ingestion-schedule list.
 *
 * `empty` is the honest state before anyone has configured a recurring sync.
 */
export const ingestScheduleRows = defineFixture<IngestSchedule>({
  key: 'ingest-schedules',
  scenarios: {
    default: seedSchedules,
    empty: () => [],
  },
});

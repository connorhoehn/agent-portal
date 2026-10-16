// The lab loop's durable half — fleet memory and human consults, offline.
//
// `MOCK_EXPERIENCES` and `MOCK_CONSULTS` were two bare `[]`s inside
// providers/lab.ts, each with a module-level `expSeq`/`conSeq` counter beside
// it. Three things were wrong with that, and they compound:
//
//   1. NOTHING COULD BE UNDONE. `POST /api/lab/experiences`,
//      `POST /api/lab/consults` and `POST /api/lab/consults/:id/answer` all
//      append or mutate, and `POST /api/__mock/reset` reached none of them —
//      an auditor's consult stayed on the Work page until the process
//      restarted.
//   2. THE COUNTERS OUTLIVED THE ROWS. `++expSeq` is monotonic in the process,
//      so after a reset the store would be empty while the next id was
//      `exp-mock-9`. `nextMockExperienceId` below reads the high-water mark off
//      the live rows instead, which is right in both directions — the same fix
//      mock/org-findings.ts made for `find-mock-N`.
//   3. THE STORE WAS EMPTY, so `GET /api/lab/experiences` returned `[]` and an
//      unbuilt feature and an unseeded one looked identical (contract.ts #5).
//      The write sweep could not even synthesise a body for
//      `POST /api/rediscovery/outcomes`, because it picks an `experienceId`
//      off that list and the list had nothing in it.
//
// AGE IS THE CLAIM FOR AN EXPERIENCE, NOT THE DAY — fleet memory is ranked by
// relevance and rendered as prose ("19 days ago"), nothing buckets it by
// calendar day — so the experiences below take a plain `clock.daysAgo`.
//
// A CONSULT IS DIFFERENT, and it is the one place on this surface where the
// clock is load-bearing rather than decorative: `expireStale` expires a
// `pending` consult 30 minutes after `createdAt`, on read. So the seeded
// pending consult is stamped minutes ago, not hours — a seed stamped
// `hoursAgo(3)` would arrive already `expired` and the Work page's "waiting on
// you" panel would be empty in every fresh process. The seeded one is also
// given a long lifetime (`SEEDED_CONSULT_LIFETIME_MS`): a demo that sits open
// for an hour must not lose the question it is about to show. Consults opened
// by a run still expire after 30 minutes; `POST /api/__mock/reset` re-stamps
// the seeded one.

import { clock, defineFixture } from './core/index.js';
// Type-only, so it is erased at compile: providers/lab.ts imports the fixtures
// below at run time, and a value import back the other way would be a genuine
// cycle rather than a shared shape.
import type { LabConsult, LabExperience } from '../providers/lab.js';

/**
 * How long a SEEDED pending consult stays pending, by id — the demo's open
 * question about the cutover order outlives a long walkthrough. Keyed here, not
 * on the row: the wire shape of a consult has no such field, and the real path
 * has none (providers/lab.ts `consultLifetimeMs`).
 */
export const SEEDED_CONSULT_LIFETIME_MS: Readonly<Record<string, number>> = { 'con-mock-1': 3 * 24 * 60 * 60 * 1000 };

/**
 * What the fleet has learned, across repos on purpose: the point of fleet
 * memory is that the answer to today's problem is usually somewhere else.
 * Every `kind` the store accepts is represented, because a kind filter with no
 * rows behind it is indistinguishable from a broken query.
 *
 * These are deliberately the same incidents mock/promotions.ts clusters into
 * candidates — an observation and the pattern it feeds are two views of one
 * event, and inventing a second, disjoint cast would make the ladder's own
 * story unreadable.
 */
function seedExperiences(): LabExperience[] {
  return [
    {
      id: 'exp-mock-1',
      sessionId: 'sess-mock-ingest-checkpoint-00000000000001', boxId: 'box-mock-0006',
      repo: 'orgiq-data-platform', initiativeId: null,
      kind: 'worked',
      title: 'Resuming from the checkpointed page cursor finishes an interrupted nightly ingest',
      body: 'The vendor export rate-limited the load a third of the way in. Resuming from the '
          + 'cursor in the load ledger completed it in one pass with no duplicate rows, and the '
          + 'counts matched the source manifest.',
      tags: ['ingest', 'checkpoint', 'rate-limit'],
      createdAt: clock.daysAgo(6),
    },
    {
      id: 'exp-mock-2',
      sessionId: 'sess-mock-partner-quarantine-000000000001', boxId: 'box-mock-0006',
      // The shared loaders belong to none of the demo's business initiatives,
      // so null is the honest "no initiative context" (as con-mock-3 below).
      repo: 'orgiq-data-platform', initiativeId: null,
      kind: 'failed',
      title: 'One malformed row failed the whole nightly partner batch',
      body: 'A partner file carried one row with an unescaped quote. The parser raised, the '
          + 'transaction rolled back and the entire batch stayed in the landing bucket overnight.',
      tags: ['ingest', 'quarantine'],
      createdAt: clock.daysAgo(12),
    },
    {
      id: 'exp-mock-3',
      sessionId: 'sess-mock-feed-schema-shift-00000000000001', boxId: 'box-mock-0002',
      repo: 'orgiq-data-platform', initiativeId: 'p-data-lake',
      kind: 'gotcha',
      title: 'A vendor column added mid-feed shifted every later column in the transform',
      body: 'The transform selected columns by position, so a new nullable column moved everything '
          + 'after it by one. Nothing raised an error and the dashboards read plausible, wrong '
          + 'numbers for four days.',
      tags: ['schema', 'feeds'],
      createdAt: clock.daysAgo(9),
    },
    {
      id: 'exp-mock-4',
      sessionId: 'sess-mock-backfill-dedupe-0000000000001', boxId: 'box-mock-0002',
      // The same incident as mock/promotions.ts's backfill runbook.
      repo: 'orgiq-data-platform', initiativeId: 'p-realtime-analytics',
      kind: 'decision',
      title: 'Decided to key the backfill upsert on the event id and its payload version',
      body: 'The vendor now reuses an event id for a corrected payload, so an upsert on the id '
          + 'alone kept both versions. Keying on the id and the payload version makes a repeated '
          + 'window change nothing.',
      tags: ['backfill', 'dedupe'],
      createdAt: clock.daysAgo(2),
    },
    {
      id: 'exp-mock-5',
      sessionId: 'sess-mock-session-storage-cache-00000001', boxId: 'box-mock-0004',
      repo: 'orgiq-portal', initiativeId: 'p-observability',
      kind: 'convention',
      title: 'Treat /mnt/workspace as a cache, never a durable store',
      body: 'Session storage is wiped on every runtime version update and after 14 days idle, so '
          + 'every image push resets it. Push work out through git or the command API before the '
          + 'session ends.',
      tags: ['devbox', 'session-storage'],
      createdAt: clock.daysAgo(20),
    },
  ];
}

/**
 * Questions a run put to a human.
 *
 * One `pending` (so the Work page's consult panel has something to render and
 * `POST /api/lab/consults/:id/answer` has something to answer), one already
 * `answered` (so the answered state is auditable without first answering one),
 * and one `expired` (the state nobody produces on purpose and everybody has to
 * render — a poller that crashed and left its question behind).
 *
 * The pending row's age is the load-bearing one: see the header note on
 * `expireStale`.
 */
function seedConsults(): LabConsult[] {
  return [
    {
      id: 'con-mock-1',
      sessionId: 'sess-mock-auth-cutover-order-000000000001', boxId: 'box-mock-0002',
      repo: 'orgiq-auth-service', initiativeId: 'p-auth-migration',
      question: 'Which customer tenant goes first after the rehearsals, the smallest or the riskiest? The cutover sequence cannot be written until that is decided.',
      context: '"Tenant-by-tenant cutover runbook with rollback" is blocked on it. Vera Green escalated "Cutover order for legacy SSO tenants" to Sienna Garcia, the release manager, who decides it.',
      status: 'pending',
      answer: null, answeredBy: null,
      // Minutes, not hours — a pending consult stamped outside the 30-minute
      // window arrives already expired. See the header.
      createdAt: clock.hoursAgo(0.15),
      answeredAt: null,
    },
    {
      id: 'con-mock-2',
      sessionId: 'sess-mock-collector-oom-00000000000000001', boxId: 'box-mock-0006',
      repo: 'orgiq-observability', initiativeId: 'p-observability',
      question: 'Bounding the gateway sending queue at 5,000 batches refuses about 3 percent of healthy spans during a 40k spans/s burst. Is that loss acceptable, or should the queue spill to disk instead?',
      context: '"Collector OOMs under burst ingest when queue is unbounded": the gateway pods are OOM-killed at their 2 GiB limit inside 4 minutes of the burst, losing error spans with everything else.',
      status: 'answered',
      answer: 'Bound it in memory and export otelcol_exporter_enqueue_failed_spans as a metric. A persistent queue moves the failure to a full volume. A refused healthy span you can count beats a collector that dies with the errors in it.',
      answeredBy: 'p-004',
      createdAt: clock.hoursAgo(30),
      answeredAt: clock.hoursAgo(29),
    },
    {
      id: 'con-mock-3',
      sessionId: 'sess-mock-abandoned-poller-0000000000001', boxId: 'box-mock-0004',
      repo: 'orgiq-llm-platform', initiativeId: 'p-llm-platform',
      question: 'The nightly golden-set run found the supervisor prompt in DRAFT differs from the published version. Score the draft, the published one, or both?',
      context: null,
      status: 'expired',
      answer: null, answeredBy: null,
      createdAt: clock.hoursAgo(52),
      answeredAt: null,
    },
  ];
}

/**
 * Fleet memory.
 *
 * `empty` — a brand-new fleet that has learned nothing yet. Declared
 *           explicitly: an undeclared scenario falls back to `default`, and
 *           "no memory for this repo yet" is the copy a recall with no hits
 *           renders — the one state a seeded store can never show.
 */
export const labExperiences = defineFixture<LabExperience>({
  key: 'lab-experiences',
  scenarios: {
    default: seedExperiences,
    empty: () => [],
  },
});

/** Human consults. `empty` is "nothing is waiting on a person right now". */
export const labConsults = defineFixture<LabConsult>({
  key: 'lab-consults',
  scenarios: {
    default: seedConsults,
    empty: () => [],
  },
});

/**
 * The next `exp-mock-N` / `con-mock-N` id, read off the live rows.
 *
 * A module counter is wrong in both directions across a reset — it keeps
 * climbing past ids nothing holds, and a counter reset with the fixture
 * re-mints an id the seed already owns. Only the `-mock-` family is scanned,
 * so nothing minted here can land on a seeded id.
 */
function nextId(prefix: string, ids: Iterable<string>): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function nextMockExperienceId(): string {
  return nextId('exp-mock', labExperiences.rows().map((e) => e.id));
}

export function nextMockConsultId(): string {
  return nextId('con-mock', labConsults.rows().map((c) => c.id));
}

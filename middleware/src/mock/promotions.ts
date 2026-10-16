// The promotions inbox — the ladder's candidate clusters, offline.
//
// These four candidates and their twelve observations were a
// `MOCK_CANDIDATES: PromotionCandidate[]` inside providers/promotions.ts.
// Both floor problems applied at once:
//
//   1. THE WRITES WERE UNDOABLE. `promoteCandidate` and `dismissCandidate`
//      mutate a candidate's `status` — and `dismissCandidate` additionally
//      APPENDS to its `rationale`, so a dismissal is not even idempotent: two
//      dismissals leave two reasons glued to one sentence. Against a bare
//      array those edits outlived every reset, which is exactly the state
//      docs/mock-floor.md quotes an auditor warning the next auditor about
//      ("`promo-aurora-cold-start` is now Promoted until the middleware
//      restarts"). Both writes were refused outright by the wire capture's
//      write policy for that reason.
//   2. THE STAMPS WERE MINTED OFF THE WALL CLOCK. `ago(days)` was
//      `new Date(Date.now() - days * 86_400_000)`, so freezeClock could not
//      pin an observation's age and a test could not assert one.
//
// AGE IS THE CLAIM HERE, NOT THE DAY, so nothing below uses `keepWithinToday`:
// the inbox ranks by support count and renders each observation's age as
// prose ("19 days ago"), and no surface buckets an observation by calendar
// day. A cluster whose first sighting was 58 days ago is meant to read as
// two months old whatever the wall clock says.
//
// IDS ARE PART OF THE CONTRACT. `promo-*` and `obs-*` are addressed by name
// from providers/__tests__/promotions.test.ts and quoted in
// docs/mock-floor.md, so they are written out rather than generated.
//
// `supportCount` AND `sessionCount` ARE NOT STORED HERE, and that is rule 1:
// both were literals sitting beside the very observations they claimed to
// count, and one of them had already drifted —
// `promo-custodian-sg-drift` carried `sessionCount: 3` over three
// observations from two distinct sessions (sess-410 twice, then sess-1201).
// The prose in that candidate's rationale is about a third session whose
// observations the cluster never held. providers/promotions.ts derives both
// numbers off `observations` on every read now, so the pair cannot disagree
// with the rows again; the row type is `SeededCandidate`, which is
// `PromotionCandidate` minus exactly those two fields.

import { clock, defineFixture } from './core/index.js';
// Type-only, so it is erased at compile: providers/promotions.ts imports the
// fixture below at run time, and a value import back the other way would be a
// genuine cycle rather than a shared shape.
import type { Observation, SeededCandidate } from '../providers/promotions.js';

/** `days` before now — sampled inside the rows factory, so a reset re-ages. */
const ago = (days: number): string => clock.daysAgo(days);

/** An observation with the two fields most of them share filled in. */
function obs(over: Pick<Observation, 'id' | 'kind' | 'title' | 'body' | 'sessionId'> & Partial<Observation>): Observation {
  return {
    repo: 'orgiq-data-platform', initiativeId: null, createdAt: ago(3),
    ...over,
  };
}

/**
 * What the lab loop has clustered out of `lab_experiences` and not yet
 * ratified. All four rungs of the ladder are represented on purpose — a
 * `candidate` skill, a `promoted` one, an `insight`, and a `runbook` that
 * drift detection demoted from a skill — because a status tab with no rows is
 * indistinguishable from a broken filter.
 */
function seedCandidates(): SeededCandidate[] {
  return [
  // The ladder's stories are the org's DATA pipelines (ingestion, transforms,
  // backfills): they are what the pipelines tenant's Runbooks page shows, and
  // mock/lab.ts's fleet memory holds the same incidents. The first two carry
  // no initiative (null, "no initiative context": the platform's shared
  // loaders belong to none of the demo's business initiatives).
  {
    id: 'promo-aurora-cold-start',
    proposedKind: 'skill',
    title: 'Resume a nightly ingest from its last checkpoint',
    rationale: 'Three independent runs lost an overnight load to a source API rate limit partway through, and resuming from the last committed page cursor instead of re-pulling from the top finished each one without duplicate rows. A clean, repeatable procedure worth running unattended rather than re-discovering per run.',
    dryRunRunId: null,
    status: 'candidate',
    observations: [
      obs({
        id: 'obs-aurora-1', kind: 'failed', sessionId: 'sess-914', repo: 'orgiq-data-platform',
        title: 'Nightly ingest aborted partway through when the source API rate-limited it',
        body: 'The vendor billing export answered 429 for four minutes. The loader treated it as fatal and left the staging table half filled, with no cursor recorded to resume from.',
        initiativeId: null, createdAt: ago(19),
      }),
      obs({
        id: 'obs-aurora-2', kind: 'decision', sessionId: 'sess-914', repo: 'orgiq-data-platform',
        title: 'Decided to checkpoint the page cursor after every committed batch',
        body: 'Each batch now writes its cursor to the load ledger in the same transaction as its rows, so a resume starts at the next page. Genuine failures still stop the load; only rate limits and timeouts are retried.',
        initiativeId: null, createdAt: ago(19),
      }),
      obs({
        id: 'obs-aurora-3', kind: 'worked', sessionId: 'sess-1032', repo: 'orgiq-data-platform',
        title: 'Resuming from the checkpoint finished a second interrupted load with no duplicate rows',
        body: 'The same rate limit hit the next export a third of the way in. Resuming from the ledger cursor completed it in one pass, and the row counts matched the source manifest.',
        initiativeId: null, createdAt: ago(6),
      }),
    ],
  },
  {
    id: 'promo-arm64-fargate',
    proposedKind: 'skill',
    title: 'Quarantine a malformed batch instead of failing the whole load',
    rationale: 'Three runs across two people independently hit the same failure, traced it to the same cause and shipped the same fix. It was reviewed and dry-run verified, and is now a standing skill the fleet applies without rediscovering it.',
    // Promoted before a dry-run was a recorded run (rule 1, pipelines P2):
    // the verdict predates `pipeline_runs`, so there is no run id to cite and
    // none is invented. Its "dry-run verified" is the reviewer's word, kept in
    // the rationale where it was written.
    dryRunRunId: null,
    status: 'promoted',
    observations: [
      obs({
        id: 'obs-arm64-1', kind: 'failed', sessionId: 'sess-701', repo: 'orgiq-data-platform/ingest',
        title: 'A single malformed row failed the whole nightly partner batch',
        body: 'A partner file carried one row with an unescaped quote. The parser raised, the transaction rolled back and the entire batch stayed in the landing bucket overnight.',
        initiativeId: null, createdAt: ago(41),
      }),
      obs({
        id: 'obs-arm64-2', kind: 'decision', sessionId: 'sess-701', repo: 'orgiq-data-platform/ingest',
        title: 'Decided to route unparseable rows to a quarantine table and keep loading',
        body: 'Rows that fail parsing now land in the quarantine table with their file and line, the batch continues, and the load report lists the quarantined count for a person to review. Strictly better than a silent skip.',
        initiativeId: null, createdAt: ago(41),
      }),
      obs({
        id: 'obs-arm64-3', kind: 'worked', sessionId: 'sess-889', repo: 'orgiq-data-platform/ingest',
        title: 'Quarantine kept the next partner feed loading and surfaced three bad rows for review',
        body: 'The same pattern on a different partner feed: the batch finished on time and the three malformed rows were waiting in quarantine the next morning.',
        initiativeId: null, createdAt: ago(12),
      }),
    ],
  },
  {
    id: 'promo-adot-configurator',
    proposedKind: 'insight',
    title: 'Every source feed needs a pinned schema version',
    rationale: 'A pure fact about how feeds change: no procedure to run, nothing to retry, just something every ingestion definition must declare. That makes it an insight for the review checklist, not a runbook to execute.',
    dryRunRunId: null,
    status: 'candidate',
    observations: [
      obs({
        id: 'obs-adot-1', kind: 'gotcha', sessionId: 'sess-552', repo: 'orgiq-data-platform/transforms',
        title: 'A vendor added a column mid-feed and the transform silently shifted every later column',
        body: 'The events feed gained a nullable column on a Tuesday. The transform selected columns by position, so everything after it moved by one and nothing raised an error.',
        initiativeId: 'p-data-lake', createdAt: ago(27),
      }),
      obs({
        id: 'obs-adot-2', kind: 'gotcha', sessionId: 'sess-552', repo: 'orgiq-data-platform/transforms',
        title: 'The shifted columns reached the dashboards before anyone noticed',
        body: 'It took four days to notice: revenue by region looked plausible, just wrong. Nothing in the load report pointed at the feed.',
        initiativeId: 'p-data-lake', createdAt: ago(27),
      }),
      obs({
        id: 'obs-adot-3', kind: 'convention', sessionId: 'sess-670', repo: 'orgiq-data-platform/transforms',
        title: 'Every ingestion definition must declare the schema version it expects',
        body: 'Confirmed the same silent shift on a second feed that had copied an older transform. Checking the declared version at load time is now a standing review check.',
        initiativeId: 'p-data-lake', createdAt: ago(9),
      }),
    ],
  },
  // `driftedFrom: 'skl-custodian-sg-allowlist'` below is left as is: it points
  // at a skill that was demoted back to runbook (see the rationale), so the id
  // legitimately no longer resolves in mock/prompt-library.ts; it's a
  // historical pointer, not a live FK, and it's pinned by
  // providers/__tests__/promotions.test.ts.
  {
    id: 'promo-custodian-sg-drift',
    proposedKind: 'runbook',
    title: 'Backfill a month of events without duplicating rows',
    rationale: 'Was promoted to a skill after two clean runs of the same backfill (replay the window, upsert on the event id). A third run applied the steps exactly as recorded and still produced duplicates: the vendor had started replaying an event id with a corrected payload. Drift detection caught the mismatch between the skill\'s recorded steps and observed behavior and sent it back down to runbook for a person to update before it runs unattended again.',
    // The failed dry-run the rationale describes ran before dry-runs were
    // recorded as runs; the next one is a `pipeline_runs` row.
    dryRunRunId: null,
    status: 'candidate',
    driftedFrom: 'skl-custodian-sg-allowlist',
    observations: [
      obs({
        id: 'obs-custodian-1', kind: 'gotcha', sessionId: 'sess-410', repo: 'orgiq-data-platform/backfills',
        title: 'Re-running the backfill window loaded the same events twice',
        body: 'A retry replayed two days of events into staging a second time, and the warehouse model counted them twice until the duplicates were removed by hand.',
        initiativeId: 'p-realtime-analytics', createdAt: ago(58),
      }),
      obs({
        id: 'obs-custodian-2', kind: 'worked', sessionId: 'sess-410', repo: 'orgiq-data-platform/backfills',
        title: 'Replaying by event id and upserting on it made the backfill safe to repeat',
        body: 'Reissued the same window with an upsert keyed on the event id: a second run changed nothing. Promoted this to a skill after a second clean run repeated the result.',
        initiativeId: 'p-realtime-analytics', createdAt: ago(58),
      }),
      obs({
        id: 'obs-custodian-3', kind: 'failed', sessionId: 'sess-1201', repo: 'orgiq-data-platform/backfills',
        title: 'The backfill skill ran its recorded steps and duplicates appeared anyway',
        body: 'The same replay-and-upsert pattern, applied by the skill exactly as recorded, inserted duplicates again. The vendor now reuses an event id for a corrected payload, so keying on the id alone kept both versions; the skill\'s steps never accounted for payload versions.',
        initiativeId: 'p-realtime-analytics', createdAt: ago(2),
      }),
    ],
  },
  ];
}

/**
 * The promotions inbox.
 *
 * `empty` — the lab has run and clustered nothing worth promoting. Declared
 *           explicitly: an undeclared scenario falls back to `default`, and
 *           "nothing to review" is the state the inbox's empty copy is written
 *           for — the one state a four-candidate seed can never show.
 * `error` — the inbox cannot be read. Also declared explicitly, and for the
 *           same reason `empty` is: without it `{"scenario":"error"}` left
 *           `/api/promotions` byte-identical to `default`, so the queue's
 *           failed-load state was unreachable over HTTP. `lab_experiences`
 *           is the one real relation underneath this ladder (the clustering
 *           and candidate tables do not exist yet — see providers/
 *           promotions.ts), so that is what the message names.
 */
export const promotionCandidates = defineFixture<SeededCandidate>({
  key: 'promotion-candidates',
  scenarios: {
    default: seedCandidates,
    empty: () => [],
    error: (): never => {
      throw new Error('promotion inbox unavailable: lab_experiences read failed');
    },
  },
});

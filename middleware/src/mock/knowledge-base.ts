// The knowledge base as `dev:mock` sees it: the documents Aurora holds, the
// objects sitting in the documents bucket, the Bedrock data sources bound to
// the KB, and the ingestion jobs that have run against them.
//
// WHY. providers/knowledge-base.ts had no mock branch anywhere, and every one
// of its AWS calls swallows its own failure and returns `[]` / `null`. Offline
// that produced a fully-populated *shape* with nothing in it: `/ingest` said
// "KNOWLEDGE_BASE_ID is not set", `/ingest/jobs` returned `{jobs:[]}`, and
// `/ingest/storage` reported a zero-byte bucket with no name. A reader could
// not tell an unbuilt ingestion pipeline from an unseeded one, and neither
// could a browser auditor.
//
// WHAT IS MIRRORED. There are no `documents` rows in schema/seed.sql — the
// corpus is produced by schema/synth, so the *pipeline* is what there is to
// mirror. Every id, title, `source` value and S3 key below follows
// schema/synth/generate.py + load.py exactly (`adr-<decision id>`,
// `postmortem-<project id>`, `perf-<person id>`, `slack-<project id>-NN`,
// `all-hands-<date>`, under `synth/internal/<type>/<id>.md`), over the
// decisions, projects and people schema/seed.sql actually seeds. The KB and
// data-source ids match mock/kb-registry.ts's default row, so /admin/knowledge
// and /ingest describe one knowledge base rather than two.
//
// NO STORED TOTALS. Document counts, byte totals, per-extension and per-prefix
// breakdowns, "pending since last sync" and every ingestion job's statistics
// are COUNTED from these rows by the provider. A job's `documentsIndexed` is
// the number of documents that existed when it finished — so the "142 indexed"
// tile and the document list underneath it cannot disagree.

import { clock, defineFixture } from './core/index.js';
import type {
  DataSourceSummary,
  IngestedDoc,
  KbSummary,
} from '../providers/knowledge-base.js';

/**
 * The documents bucket. `DOCUMENTS_BUCKET` is unset offline, and an empty
 * bucket name renders as a nameless card — this is the name the Foundation
 * stack gives it in the innovation-lab account (`orgiq-documents-{account}-{region}`).
 */
export const MOCK_DOCUMENTS_BUCKET = 'orgiq-documents-647757222309-us-east-1';

/** One object in the documents bucket, as ListObjectsV2 reports it. */
export interface KbObjectRow {
  key: string;
  sizeBytes: number;
  lastModified: string;
}

/**
 * One ingestion job. Only the facts AWS alone knows live here — the statistics
 * are derived from the document and object rows, because a job's counts are
 * countable from the corpus it ingested. `documentsFailed` comes from the
 * length of `failureReasons`, so a FAILED job cannot claim failures it does
 * not name.
 */
export interface KbIngestionJobRow {
  jobId: string;
  dataSourceId: string;
  /** Bedrock's own enum: STARTING | IN_PROGRESS | COMPLETE | FAILED | STOPPING | STOPPED. */
  status: string;
  startedAt: string;
  /** null while the job is still running — Bedrock reports it once it settles. */
  finishedAt: string | null;
  description: string;
  failureReasons: string[];
}

// ─── Clock helpers ───────────────────────────────────────────────────────────
// Offsets are resolved when a factory runs, never at import (contract rule 3).

const daysAgoPlus = (days: number, minutes = 0): string =>
  new Date(Date.parse(clock.daysAgo(days)) + minutes * 60_000).toISOString();

/**
 * An instant `hours` (plus `minutes`) before now, kept inside the current UTC
 * day — and never in the future.
 *
 * Every caller below is a sub-day offset that *means today*: "this morning's
 * wave" of documents, `uploads/<today>/…` objects, the sync running right now.
 * Booted near UTC midnight an unclamped offset puts all of them on yesterday,
 * and two of them then contradict something else in the same fixture — an
 * object whose key says `uploads/2026-03-12/` carrying a `lastModified` on the
 * 11th, and a "synced this morning" job dated the previous day. `keepWithinToday`
 * is why `clock.hoursAgo` takes the option; this helper was the one path that
 * dropped it.
 *
 * The `minutes` addend is clamped too, because at exactly 00:00 UTC the hours
 * clamp resolves to *now* and adding to it would mint a future timestamp.
 */
const hoursAgoPlus = (hours: number, minutes = 0): string => {
  const base = Date.parse(clock.hoursAgo(hours, { keepWithinToday: true }));
  return new Date(Math.min(base + minutes * 60_000, Date.parse(clock.nowIso()))).toISOString();
};

/** The all-hands recap's id and title carry its date (`all-hands-YYYY-MM-DD`). */
const allHandsDate = (daysAgo: number): string => clock.daysAgo(daysAgo).slice(0, 10);
/** "Oct 13" — the title a person reads; the id above keeps the sortable day. */
const allHandsLabel = (daysAgo: number): string =>
  new Date(clock.daysAgo(daysAgo)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const uri = (prefix: string, id: string): string =>
  `s3://${MOCK_DOCUMENTS_BUCKET}/synth/internal/${prefix}/${id}.md`;

// ─── Documents (Aurora `documents`) ──────────────────────────────────────────

/**
 * The corpus. Two ingestion waves: ten documents landed with the first full
 * sync three weeks ago, four more this morning — which is what makes the job
 * history below tell a story rather than repeat one number.
 */
export const kbDocumentRows = defineFixture<IngestedDoc>({
  key: 'kb-documents',
  scenarios: {
    default: () => {
      const older = daysAgoPlus(21, 34);
      const recent = hoursAgoPlus(6, 8);
      const allHands = (n: number) => `all-hands-${allHandsDate(n)}`;
      return [
        // ── this morning's wave ──
        { id: 'adr-d-vectordb', source: 'adr', sourceUri: uri('adr', 'adr-d-vectordb'),
          title: 'ADR: Vector DB vendor selection', ingestedAt: recent },
        { id: 'perf-p-008', source: 'perf_review', sourceUri: uri('perf_review', 'perf-p-008'),
          title: 'Perf Review: Layla Hassan — Q1 2026', ingestedAt: recent },
        { id: 'slack-p-observability-00', source: 'slack_thread',
          sourceUri: uri('slack', 'slack-p-observability-00'),
          title: '#proj-observability — incident triage in the first 10 minutes', ingestedAt: recent },
        { id: allHands(2), source: 'all_hands', sourceUri: uri('all_hands', allHands(2)),
          title: `All-Hands, ${allHandsLabel(2)}`, ingestedAt: recent },

        // ── the first full sync ──
        { id: 'adr-d-aurora', source: 'adr', sourceUri: uri('adr', 'adr-d-aurora'),
          title: 'ADR: Adopt Aurora over Neptune', ingestedAt: older },
        { id: 'adr-d-otel', source: 'adr', sourceUri: uri('adr', 'adr-d-otel'),
          title: 'ADR: Adopt OpenTelemetry', ingestedAt: older },
        { id: 'adr-d-nova', source: 'adr', sourceUri: uri('adr', 'adr-d-nova'),
          title: 'ADR: Standardize on Nova Pro', ingestedAt: older },
        { id: 'postmortem-p-observability', source: 'postmortem',
          sourceUri: uri('postmortem', 'postmortem-p-observability'),
          title: 'Postmortem: p99 latency spike on write path (Observability Platform)', ingestedAt: older },
        { id: 'postmortem-p-auth-migration', source: 'postmortem',
          sourceUri: uri('postmortem', 'postmortem-p-auth-migration'),
          title: 'Postmortem: auth token cache invalidation race (Auth Migration)', ingestedAt: older },
        { id: 'postmortem-p-rag-search', source: 'postmortem',
          sourceUri: uri('postmortem', 'postmortem-p-rag-search'),
          title: 'Postmortem: vector index rebuild knocked search offline for 40 minutes (RAG Knowledge Search)',
          ingestedAt: older },
        { id: 'perf-p-004', source: 'perf_review', sourceUri: uri('perf_review', 'perf-p-004'),
          title: 'Perf Review: Nora DaSilva — Q1 2026', ingestedAt: older },
        { id: 'perf-p-013', source: 'perf_review', sourceUri: uri('perf_review', 'perf-p-013'),
          title: 'Perf Review: Caleb Turner — Q1 2026', ingestedAt: older },
        { id: 'slack-p-auth-migration-00', source: 'slack_thread',
          sourceUri: uri('slack', 'slack-p-auth-migration-00'),
          title: '#proj-auth-migration — weighing two competing library choices', ingestedAt: older },
        { id: allHands(23), source: 'all_hands', sourceUri: uri('all_hands', allHands(23)),
          title: `All-Hands, ${allHandsLabel(23)}`, ingestedAt: older },
      ];
    },
    // A knowledge base that exists and has never been synced — the state a
    // fresh deploy is actually in, and the one the empty table has to render.
    empty: () => [],
  },
});

// ─── Objects in the documents bucket ─────────────────────────────────────────

/**
 * One S3 object per document, plus two hand-uploaded files that arrived after
 * the last sync — which is what `pendingSinceLastSync` on /ingest exists to
 * show, and it can only be shown by having objects newer than the last job.
 */
export const kbObjectRows = defineFixture<KbObjectRow>({
  key: 'kb-s3-objects',
  scenarios: {
    default: () => {
      const docs = kbDocumentRows.rows();
      const sizeFor = (source: string | null): number => {
        switch (source) {
          case 'adr': return 7_412;
          case 'postmortem': return 11_930;
          case 'perf_review': return 5_268;
          case 'slack_thread': return 3_104;
          default: return 9_845;
        }
      };
      const uploadDay = clock.daysAgo(0).slice(0, 10);
      return [
        ...docs.map((d) => ({
          // The synth loader writes `<s3_prefix>/<id>.md`; sourceUri already
          // spells that, so the key is that URI minus the bucket.
          key: (d.sourceUri ?? '').replace(`s3://${MOCK_DOCUMENTS_BUCKET}/`, ''),
          sizeBytes: sizeFor(d.source),
          lastModified: d.ingestedAt ?? clock.nowIso(),
        })),
        // uploadDocument() writes `uploads/<YYYY-MM-DD>/<safe filename>`.
        { key: `uploads/${uploadDay}/platform-onboarding-runbook.pdf`,
          sizeBytes: 2_204_918, lastModified: hoursAgoPlus(2) },
        { key: `uploads/${uploadDay}/q3-architecture-review.docx`,
          sizeBytes: 148_336, lastModified: hoursAgoPlus(2, 11) },
      ];
    },
    empty: () => [],
  },
});

// ─── The knowledge base itself ───────────────────────────────────────────────

/**
 * A one-row fixture, because a KB that is missing is a state the Ingest page
 * has to render (`lookupKb().state === 'missing'`) and `empty` is how an
 * auditor asks for it without deleting anything.
 */
export const kbSummaryRows = defineFixture<KbSummary>({
  key: 'kb-summary',
  scenarios: {
    default: () => [{
      // Same id mock/kb-registry.ts registers for the `orgiq-default` KB.
      id: 'KBMOCK0001AB',
      name: 'orgiq-knowledge-base',
      status: 'ACTIVE',
      description: 'Org docs, ADRs, postmortems, perf reviews — the OrgIQ fleet reads this one.',
      embeddingModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
      embeddingModel: 'amazon.titan-embed-text-v2:0',
      vectorStore: 'RDS',
      updatedAt: clock.daysAgo(21),
    }],
    // No knowledge base at this id — the "deleted upstream" diagnosis, which
    // is a different operator action from "never configured".
    empty: () => [],
    // "No knowledge base registered" invites provisioning one. A failed read
    // must not, because one may already exist and be serving the fleet.
    error: () => { throw new Error('knowledge_bases unavailable: relation does not exist'); },
  },
});

// ─── Data sources ────────────────────────────────────────────────────────────

export const kbDataSourceRows = defineFixture<DataSourceSummary>({
  key: 'kb-data-sources',
  scenarios: {
    default: () => [{
      // mock/kb-registry.ts's `orgiq-default` dataSourceId.
      id: 'DSMOCK0001AB',
      name: 'orgiq-documents-s3',
      status: 'AVAILABLE',
      description: 'The documents bucket — everything the org has ingested plus portal uploads.',
      type: 'S3',
      sourceUri: `s3://${MOCK_DOCUMENTS_BUCKET}/synth/internal`,
      updatedAt: clock.daysAgo(21),
    }],
    empty: () => [],
  },
});

// ─── Ingestion jobs ──────────────────────────────────────────────────────────

export const kbIngestionJobRows = defineFixture<KbIngestionJobRow>({
  key: 'kb-ingestion-jobs',
  scenarios: {
    // The newest job has SETTLED, and that is a deliberate choice about which
    // world is the default one.
    //
    // The head used to be an IN_PROGRESS job. Harmless while nothing read the
    // status — but once the Knowledge page renders a "sync running" state and
    // `startIngestionJob` refuses a second job the way Bedrock does, a
    // permanently-running head makes the default world one where the primary
    // action can never succeed: every "Sync now" answers 409. It also mutes the
    // story the fixtures above are built to tell, since a running job reports no
    // coverage, so "two files have landed since the last sync" cannot be
    // computed and the "behind" banner is suppressed.
    //
    // Settled head instead, and the running state is reached by DOING it: the
    // default world reads "the index is behind by the two uploads", pressing
    // Sync now succeeds and pushes a STARTING job, the page then shows the
    // running banner, and a second press correctly conflicts. Every state has a
    // path through the UI rather than only through the control plane — which is
    // the opposite of the failure that let the running-sync gap ship.
    default: () => [
      {
        jobId: 'IJMOCK0003', dataSourceId: 'DSMOCK0001AB', status: 'COMPLETE',
        startedAt: hoursAgoPlus(6), finishedAt: hoursAgoPlus(6, 8),
        description: 'Scheduled sync (daily 06:00 UTC)', failureReasons: [],
      },
      {
        jobId: 'IJMOCK0002', dataSourceId: 'DSMOCK0001AB', status: 'FAILED',
        startedAt: daysAgoPlus(3), finishedAt: daysAgoPlus(3, 2),
        description: 'Scheduled sync (daily 06:00 UTC)',
        failureReasons: [
          'Encountered an error while parsing s3://orgiq-documents-647757222309-us-east-1/uploads/scan-0142.pdf: unsupported encoding',
          'Access denied reading s3://orgiq-documents-647757222309-us-east-1/uploads/private/notes.md',
        ],
      },
      {
        jobId: 'IJMOCK0001', dataSourceId: 'DSMOCK0001AB', status: 'COMPLETE',
        startedAt: daysAgoPlus(21), finishedAt: daysAgoPlus(21, 34),
        description: 'First full sync of the org corpus', failureReasons: [],
      },
    ],
    // A knowledge base with a data source and no run history — "never synced",
    // which the page must say differently from "sync failed".
    empty: () => [],
    // The newest job FAILED — the other half of that sentence, and this
    // fixture's reading of the shared `error` scenario ("a surface has to
    // render an error state"). The `default` set already contains a failed run,
    // but not as the newest one, and only the newest is what `syncState`
    // reports; so without this the Knowledge page's failure banner could not be
    // seen without waiting for a real ingestion to break. Same rows, different
    // head — the provider is not down, the last job is.
    error: () => [
      {
        jobId: 'IJMOCK0005', dataSourceId: 'DSMOCK0001AB', status: 'FAILED',
        startedAt: hoursAgoPlus(0.6), finishedAt: hoursAgoPlus(0.6, 4),
        description: 'Manual sync triggered from portal',
        failureReasons: [
          'Access denied reading s3://orgiq-documents-647757222309-us-east-1/synth/internal/: '
          + 'the knowledge base service role cannot list the prefix',
        ],
      },
      {
        jobId: 'IJMOCK0003', dataSourceId: 'DSMOCK0001AB', status: 'COMPLETE',
        startedAt: hoursAgoPlus(6), finishedAt: hoursAgoPlus(6, 8),
        description: 'Scheduled sync (daily 06:00 UTC)', failureReasons: [],
      },
    ],
  },
});

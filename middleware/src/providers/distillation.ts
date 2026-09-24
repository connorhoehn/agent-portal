// Distillation — the shared-memory store's compaction machine.
//
// Every lab session writes typed observations (worked / failed / gotcha /
// decision / convention) into lab_experiences as it goes — many agents,
// concurrently, all the time. That write stream is the whole point: this is
// NOT a cron job with a run log, it is an LSM tree. L0 is the raw write head
// (whatever just landed, duplicates and all). A background compaction process
// riding the distributed-core EventBus continuously merges L0 upward into L1
// (deduped clusters) and, more rarely, L1 into L2 (stable distilled
// artifacts the library serves). Nobody reviews most of this — a human
// reviewing every merge would defeat the reason the machine exists. Humans
// sample a slice of L1 instead, and how big that slice actually is, set
// against how often reviewers disagree with what they see, is the one number
// that says whether "mostly unattended" is still safe.
//
// So this module answers three questions a cron-job framing can't: is a
// level falling behind its writers, how much is compaction actually
// deduping (the number that justifies running it at all), and is the human
// sample calibrated to how much reviewers actually disagree. Promotions
// (promotions.ts) is the older, adjacent surface — the human inbox for
// individual distilled candidates. This is the machine underneath it.
//
// EVERY NUMBER HERE IS COUNTED, NOT STORED. The rows live in
// mock/distillation.ts as scenario-switchable fixtures on the mock floor
// (mock/core/contract.ts); this module holds the selectors over them. That is
// not a style preference — this surface shipped two aggregates that drifted
// from their own rows (tier cards over lists a third their size, a review
// banner of constants that never moved when a sample was decided), and the
// only durable fix is having no number to drift.
//
// Aurora path: the operational rows are Aurora-backed. With config.mock.aurora
// off, listCompactions / getCompaction read distillation_compactions and
// ingest() / levelsView()'s L0 writer count read distillation_ingest_writers
// (schema/distillation_ops_schema.sql, via providers/distillation-store.ts),
// mapped to the same wire types; a failed read is a 503, never an empty list.
// The corpus — observations, clusters, artifacts, facts, reviews — has no
// Aurora path yet and stays mock-first, like promotions.ts and
// design-reviews.ts. With config.mock.aurora on, every read is the fixture.

import { config } from '../config.js';
import { NotFoundError, AppError, ValidationError } from '../lib/async-handler.js';
import { clock, countBy, groupBy, sumBy, utcDayStartMs, DAY_MS } from '../mock/core/index.js';
import { getAsset } from './prompt-library.js';
import {
  observations as observationsFx, clusters as clustersFx, artifacts as artifactsFx,
  facts as factsFx, libraryLinks as libraryLinksFx, compactionJobs as compactionJobsFx,
  reviewSamples as reviewSamplesFx, ingestWriters as ingestWritersFx,
  procedureApplications as procedureApplicationsFx, distillationFixtures, OWNER_BY_REPO,
  type Observation, type Cluster, type Artifact, type ArtifactRow, type Fact, type ReviewSample,
  type CompactionJobRow, type IngestWriter, type ProcedureApplication, type ApplicationOutcome,
  type ObservationKind, type ArtifactStatus, type ArtifactType, type ArtifactClassification,
  type ReviewTargetKind, type ReviewVerdict,
  type Level, type CompactionStatus, type CompactionPhase, type CompactionLogEntry,
  type Lineage, type LineageNode, type LineageEdge, type LineageRelation,
} from '../mock/distillation.js';
import { distillationQueueMessages } from '../mock/distillation-queue.js';
import { distillationEvents } from '../lib/distillation-events.js';
import {
  COMPACTION_QUEUES, MAX_RECEIVES, compactionQueue, ensureCompactionQueues, enqueueCompaction,
} from '../lib/distillation-queue.js';
import { MemoryMessageQueue } from '../lib/memory-queue.js';
import type { QueueMessage } from '../lib/mq-client.js';
import { tierDigest } from '../lib/distillation-digest.js';
import { L2Replica, type ReplicationStatus } from '../lib/distillation-replica.js';
import {
  persistJob, recordWriterWrite, readCompactions, readCompaction, readRecentWriters,
} from './distillation-store.js';

export type {
  Observation, Cluster, Artifact, ArtifactRow, Fact, ReviewSample,
  ArtifactStatus, ArtifactType, ArtifactClassification, ReviewTargetKind, ReviewVerdict, Lineage, LineageNode, LineageEdge,
  Level, CompactionStatus, CompactionJobRow, IngestWriter, ProcedureApplication, ApplicationOutcome,
  CompactionPhase, CompactionLogEntry,
} from '../mock/distillation.js';
export type { ReplicationStatus } from '../lib/distillation-replica.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LevelState {
  level: Level;
  items: number;
  sizeBytes: number;
  /**
   * The oldest row the merge INTO this level has not absorbed yet: for L1 the
   * oldest observation no cluster has claimed, for L2 the oldest cluster no
   * artifact has distilled. L0 is the write head — nothing merges into it, so
   * it reports the same backlog (the batch the next L0→L1 pass will take) with
   * a lag of zero rather than inventing a fault it cannot have.
   */
  oldestAt: string;
  /** Seconds since that row arrived — how far compaction is behind this
   *  level's writers. Zero for L0 (see compactionHealth). */
  lagSeconds: number;
}

export interface IngestState {
  activeWriters: number;
  observationsPerHour: number;
  /** share is 0–1 and should sum to ~1 across the list — "which repos
   *  dominate the write stream right now." */
  topRepos: Array<{ repo: string; share: number }>;
}

/**
 * A compaction pass on the wire. Everything below `status` is COUNTED, not
 * stored: `produced` is the set of clusters/artifacts naming this job as their
 * creator, and the four numbers under it are counted from those rows and their
 * inputs (mock/distillation.ts CompactionJobRow says why). The seeded rows
 * used to type all of it — one claimed `outputItems: 62` beside four produced
 * cluster ids.
 */
export interface CompactionJob {
  id: string;
  /** The level this job merged INTO — L0→L1 jobs are tagged 'L1', L1→L2
   *  jobs are tagged 'L2'. Nothing ever compacts into L0. */
  level: Level;
  startedAt: string;
  finishedAt: string | null;
  status: CompactionStatus;
  inputItems: number;
  outputItems: number;
  dedupedItems: number;
  /** Always a count on the mock path. From Aurora it is the value recorded
   *  when the pass finished, or null for a row written before that column
   *  existed — unknown, never a stand-in zero. */
  bytesReclaimed: number | null;
  costUsd: number;
  error?: string;
  /** What this pass actually made, so a job row can open it: the L1 clusters
   *  or L2 artifacts it created. A failed job (comp-104) produces neither —
   *  its inputs are untouched in the level below, not silently consumed. */
  produced: { cluster_ids: string[]; artifact_ids: string[] };
  // ── The run, as the Activity inspector reads it (spec §3a) ──────────────
  /** When the pass was put on its queue. Equal to startedAt for the seeded
   *  history, which predates the queue. */
  queued_at: string;
  /** The message-queue queue this pass rides (lib/distillation-queue.ts). */
  queue: string;
  /** The repo the pass was scoped to — its FIFO group — or null for all. */
  repo: string | null;
  requested_by: string | null;
  /** What it consumed: observation ids (L1) or cluster ids (L2). While a pass
   *  runs this is the batch it claimed; once it succeeds it is counted back
   *  out of what it produced, so the two can never disagree. */
  input_ids: string[];
  /** What it wrote: the produced cluster/artifact ids, flattened. */
  output_ids: string[];
  log: CompactionLogEntry[];
  /** One sentence: what this run changed in the store. */
  what_changed: string;
  /** finished − started; running = so far; null while still queued. */
  duration_ms: number | null;
  cost_usd: number;
  phase: CompactionPhase;
  /** 0–100 while it runs, 100 once done, null when it failed or never ran. */
  percent: number | null;
  stepLabel: string | null;
  /** Queue deliveries so far. */
  attempts: number;
}

export interface SamplingState {
  l1SampleRatePct: number;
  reviewedLast30d: number;
  agreementRatePct: number;
  queueDepth: number;
}

export type LevelHealthStatus = 'healthy' | 'behind' | 'stalled';

export interface LevelHealth {
  level: Level;
  status: LevelHealthStatus;
  reason: string;
}

export type SamplingVerdictLabel = 'undersampled' | 'calibrated' | 'oversampled';

export interface SamplingVerdict {
  verdict: SamplingVerdictLabel;
  reason: string;
}

// ─── Pure decision rules (unit-tested) ───────────────────────────────────────

/**
 * Redundancy compaction actually removed — the number that justifies running
 * the machine at all. `inputItems <= 0` means the job consumed nothing, which
 * is not "100% efficient", it's undefined: return null rather than a ratio,
 * and let the caller say why (a job that touched nothing tells you nothing
 * about dedupe quality).
 */
export function dedupeRatio(job: Pick<CompactionJob, 'inputItems' | 'dedupedItems'>): number | null {
  if (job.inputItems <= 0) return null;
  return job.dedupedItems / job.inputItems;
}

/**
 * Output items produced per input item consumed, across a set of jobs.
 * Compaction here always shrinks (dedup removes redundancy), so this reads
 * under 1 — it's the LSM-standard name for the ratio, not a claim that this
 * store rewrites more than it's given. Empty/zero-input job sets have no
 * amplification to report, so 0 rather than NaN — consistent with the same
 * divide-by-zero floor used elsewhere in this codebase (see runYield in the
 * git history this module replaced).
 */
export function writeAmplification(jobs: Array<Pick<CompactionJob, 'inputItems' | 'outputItems'>>): number {
  const totalIn = jobs.reduce((sum, j) => sum + j.inputItems, 0);
  if (totalIn <= 0) return 0;
  const totalOut = jobs.reduce((sum, j) => sum + j.outputItems, 0);
  return totalOut / totalIn;
}

// A level idle longer than one compaction cycle is genuinely falling behind
// its writers — 30 minutes is roughly the cadence the mock jobs run at.
// STALL_WINDOW is a different, harsher question: has ANY attempt been made
// recently at all, regardless of pace. Both thresholds are flat across
// levels rather than tuned per level (L2 naturally runs on a slower, batched
// cadence than L1) — deliberately simple until there's real lag data to tune
// against, the same posture design-reviews.ts and the old corpus thresholds
// took.
const LAG_BEHIND_SECONDS = 30 * 60;
const STALL_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Per level: healthy, behind (compaction is running but not keeping pace),
 * or stalled (backlog sitting there and nothing has attempted to clear it
 * recently). L0 is the write head, not a compaction target — nothing ever
 * merges INTO it, so "no compaction ran here" is not a fault; its pressure
 * shows up in ingest volume and in how L1's lag chases it, not in its own
 * status. The reason always names the level and the action, because a bare
 * "stalled" tells an operator nothing about which level or what to do.
 */
export function compactionHealth(levels: LevelState[], jobs: CompactionJob[]): LevelHealth[] {
  // The one clock, so a test can freeze the instant a level goes stale rather
  // than reasoning about wall time.
  const now = clock.now().getTime();
  return levels.map((lvl): LevelHealth => {
    if (lvl.level === 'L0') {
      return {
        level: 'L0',
        status: 'healthy',
        reason: `L0 is the write head — ${lvl.items} raw observations landed and are waiting to be picked up by the next L0→L1 merge.`,
      };
    }

    const levelJobs = jobs.filter((j) => j.level === lvl.level);
    const lastAttempt = levelJobs
      .slice()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const lastAttemptMs = lastAttempt ? Date.parse(lastAttempt.startedAt) : null;
    const hasBacklog = lvl.items > 0 && lvl.lagSeconds > 0;
    const stalled = hasBacklog && (lastAttemptMs == null || now - lastAttemptMs > STALL_WINDOW_MS);

    if (stalled) {
      const hoursSince = lastAttemptMs == null ? null : Math.round((now - lastAttemptMs) / 3_600_000);
      // What is actually waiting for the pass INTO this tier is the tier
      // below's unclaimed rows — not this tier's own row count, which used to
      // be quoted here ("L2 has 11 items waiting" meant 11 guides, while 10
      // patterns were the real backlog).
      const waiting = lvl.level === 'L2' ? pendingClusters().length : pendingObservations().length;
      const waitingLabel = lvl.level === 'L2'
        ? `${waiting} pattern${waiting === 1 ? '' : 's'}`
        : `${waiting} run note${waiting === 1 ? '' : 's'}`;
      return {
        level: lvl.level,
        status: 'stalled',
        reason: hoursSince == null
          ? `${waitingLabel} waiting for ${lvl.level} and no compaction has ever run into it — trigger one by hand.`
          : `${waitingLabel} waiting for ${lvl.level} and no compaction has run into it in ${hoursSince}h — trigger one by hand before the backlog grows further.`,
      };
    }
    if (lvl.lagSeconds > LAG_BEHIND_SECONDS) {
      return {
        level: lvl.level,
        status: 'behind',
        reason: `${lvl.level} is ${Math.round(lvl.lagSeconds / 60)} minutes behind its writers — compaction is running but not keeping pace; watch for it to catch up on the next pass.`,
      };
    }
    return {
      level: lvl.level,
      status: 'healthy',
      reason: `${lvl.level} lag is ${Math.round(lvl.lagSeconds / 60)} minutes — compaction is keeping pace with its writers.`,
    };
  });
}

// The human-in-the-loop dial. Below AGREEMENT_LOW, reviewers are overturning
// merges often enough that the unreviewed majority can't be trusted — raise
// the rate. Above AGREEMENT_HIGH the sample is essentially rubber-stamping
// merges that were already correct — the review budget would catch more real
// problems spent elsewhere, so the rate can drop. SAMPLE_RATE_FLOOR keeps
// "oversampled" from ever recommending a rate so low a human stops seeing
// the tier often enough to matter.
const AGREEMENT_LOW = 0.75;
const AGREEMENT_HIGH = 0.95;
const SAMPLE_RATE_FLOOR_PCT = 2;

/**
 * Should the L1 sample rate move? This is the operationally interesting
 * number on the whole page: a sample nobody disagrees with is spending
 * review time for no signal, and a sample people keep overturning means the
 * other 96% is unaudited and probably wrong too.
 */
export function samplingVerdict(s: SamplingState): SamplingVerdict {
  // Nothing decided yet — so there is no agreement signal, and the branches
  // below would read a 0% rate as "reviewers overturn 100% of what they see"
  // above a queue where nobody has seen anything. That is the same class of
  // contradiction as the old constant banner, just arrived at by arithmetic.
  if (s.reviewedLast30d === 0) {
    if (s.queueDepth === 0) {
      return {
        verdict: 'calibrated',
        reason: 'Nothing has been drawn for review yet — no queue, no decisions, nothing to calibrate. The dial starts saying something once the first merge lands and someone looks at it.',
      };
    }
    return {
      verdict: 'undersampled',
      reason: `${s.queueDepth} sampled item${s.queueDepth === 1 ? '' : 's'} waiting and none decided yet — until someone works the queue the sample is costing review budget and returning no signal about the merges nobody looked at.`,
    };
  }

  const agreement = s.agreementRatePct / 100;
  if (agreement < AGREEMENT_LOW) {
    return {
      verdict: 'undersampled',
      reason: `Reviewers overturn ${(100 - s.agreementRatePct).toFixed(0)}% of what they see at a ${s.l1SampleRatePct}% sample — that's too much disagreement to trust the merges nobody looked at. Raise the L1 sample rate until agreement recovers.`,
    };
  }
  if (agreement > AGREEMENT_HIGH && s.l1SampleRatePct > SAMPLE_RATE_FLOOR_PCT) {
    return {
      verdict: 'oversampled',
      reason: `${s.agreementRatePct}% agreement at a ${s.l1SampleRatePct}% sample means reviewers are essentially rubber-stamping merges that were already correct — the review budget would catch more real problems at a lower rate.`,
    };
  }
  return {
    verdict: 'calibrated',
    reason: `${s.agreementRatePct}% agreement at a ${s.l1SampleRatePct}% sample is the dial doing its job — enough disagreement to prove the sample is finding real problems, not so much that the unreviewed rest should be trusted less.`,
  };
}

// A procedure that succeeded once, long ago, is not proven today: the repo
// under it keeps moving whether or not anyone re-ran the steps. Fourteen
// days is the same window the review banner counts over, and it is flat
// rather than per-repo for the same reason the lag thresholds above are —
// nothing to tune against yet.
const PROVEN_TTL_DAYS = 14;

export type ProcedureHealthStatus = 'proven' | 'drifting' | 'unproven';

export interface ProcedureHealth {
  status: ProcedureHealthStatus;
  reason: string;
}

/** "1h ago" / "3d ago" — the age a reason quotes, never a raw ISO string. */
function ageLabel(iso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < DAY_MS) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / DAY_MS)}d ago`;
}

/**
 * Is a procedure still worth handing to a session? Three answers, decided
 * from counted rows only:
 *
 *   unproven  — no run has ever completed it. A published procedure nobody
 *               has run is a claim, not a capability, and a draft with two
 *               failed runs is the same thing with evidence.
 *   drifting  — it was proven once, but since that success either a run
 *               failed/was abandoned, a `failed`/`gotcha` CLUSTER was minted
 *               in the same repo, or the success is older than
 *               PROVEN_TTL_DAYS. Drift is read at L1, not L0, on purpose:
 *               simulated ingest mints a gotcha in orgiq-auth-service every
 *               minute, so an L0 rule would flip every auth procedure to
 *               drifting within minutes of boot. A cluster is a gotcha that
 *               compaction agreed was a pattern.
 *   proven    — a success, nothing contradicting it since, inside the TTL.
 *
 * The reason always names the counts and the repo, because a bare
 * "drifting" tells the person about to run it nothing about what changed.
 */
export function procedureHealth(p: Omit<ProcedureView, 'health'>, nowMs: number): ProcedureHealth {
  const { runs, repo } = p;
  const where = repo ?? 'its repo';
  if (p.last_succeeded_at === null) {
    if (runs.total === 0) {
      const state = p.artifact.status === 'published' ? 'published' : `in ${p.artifact.status}`;
      return {
        status: 'unproven',
        reason: `${state} ${ageLabel(p.artifact.created_at, nowMs)}, never run to completion — 0 runs.`,
      };
    }
    return {
      status: 'unproven',
      reason: `${runs.total} run${runs.total === 1 ? '' : 's'}, none succeeded — the last stopped ${p.last_applied_at ? ageLabel(p.last_applied_at, nowMs) : 'at an unknown time'}.`,
    };
  }

  const since = ageLabel(p.last_succeeded_at, nowMs);
  const by = p.last_succeeded_by ?? 'an unrecorded session';
  const { failed_runs, new_gotcha_clusters } = p.drift;
  if (failed_runs > 0 || new_gotcha_clusters > 0) {
    const parts: string[] = [];
    if (failed_runs > 0) parts.push(`${failed_runs} run${failed_runs === 1 ? ' failed or was' : 's failed or were'} abandoned`);
    if (new_gotcha_clusters > 0) parts.push(`${new_gotcha_clusters} new failed/gotcha cluster${new_gotcha_clusters === 1 ? '' : 's'} landed in ${where}`);
    return {
      status: 'drifting',
      reason: `last proven ${since} by ${by}; since then ${parts.join(' and ')} — re-run it before trusting it.`,
    };
  }
  if (nowMs - Date.parse(p.last_succeeded_at) > PROVEN_TTL_DAYS * DAY_MS) {
    return {
      status: 'drifting',
      reason: `last proven ${since} by ${by}, older than the ${PROVEN_TTL_DAYS}-day window — nothing has contradicted it, but ${where} has had ${PROVEN_TTL_DAYS} days to move underneath it.`,
    };
  }
  const allSucceeded = runs.succeeded === runs.total;
  return {
    status: 'proven',
    reason: `last proven ${since} by ${by}; ${runs.total} run${runs.total === 1 ? '' : 's'}, ${allSucceeded ? 'all succeeded' : `${runs.succeeded} succeeded`}.`,
  };
}

// ─── Rows, and the selectors over them ───────────────────────────────────────
//
// Every number this module reports is counted here, at read time, from the
// fixtures in mock/distillation.ts. Nothing is stored twice. The two bugs that
// shipped from this surface were both a stored count drifting from its rows —
// tier cards reading 950/180/40 above lists holding 69/22/8, and a review
// banner of fixed constants that never moved when a sample was decided — so
// the fix is structural: there is no number to store.

const observationRows = (): Observation[] => observationsFx.rows();
const clusterRows = (): Cluster[] => clustersFx.rows();
const artifactRows = (): ArtifactRow[] => artifactsFx.rows();
const factRows = (): Fact[] => factsFx.rows();
const jobRows = (): CompactionJobRow[] => compactionJobsFx.rows();
const reviewRows = (): ReviewSample[] => reviewSamplesFx.rows();
const writerRows = (): IngestWriter[] => ingestWritersFx.rows();
const applicationRows = (): ProcedureApplication[] => procedureApplicationsFx.rows();

/** The Library asset an artifact was published as, or null when no link row
 *  exists — `library_item_id: null` on the wire is the ABSENCE of a row in the
 *  links fixture, never a stored null on the artifact. */
function libraryLinkFor(artifactId: string): string | null {
  return libraryLinksFx.rows().find((l) => l.artifact_id === artifactId)?.library_item_id ?? null;
}

/**
 * A card-level confidence for an artifact that never stored one (module note
 * above: "no rollup confidence on Artifact itself" is a gap, but a STORED
 * rollup is exactly the tier-card bug this floor exists to prevent). Mean of
 * the artifact's own facts' confidence — the claims it actually stands on —
 * falling back to the mean of its source clusters' confidence for the rare
 * artifact with no facts yet, and 0 (not 1, not omitted) if neither exists,
 * so an artifact with nothing behind it reads as exactly that rather than as
 * "fully confident" by the absence of a denominator.
 */
const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

function artifactConfidence(row: ArtifactRow): number {
  const factConfidences = factRows().filter((f) => f.artifact_id === row.id).map((f) => f.confidence);
  if (factConfidences.length > 0) return Number(mean(factConfidences).toFixed(2));
  const clusterConfidences = clusterRows().filter((c) => row.cluster_ids.includes(c.id)).map((c) => c.confidence);
  if (clusterConfidences.length > 0) return Number(mean(clusterConfidences).toFixed(2));
  return 0;
}

/** The wire artifact: the stored row plus its Library link and its computed
 *  confidence rollup — the two fields `ArtifactRow` deliberately omits. */
function withLink(row: ArtifactRow): Artifact {
  return { ...row, library_item_id: libraryLinkFor(row.id), confidence: artifactConfidence(row) };
}
const artifactsOnWire = (): Artifact[] => artifactRows().map(withLink);

/**
 * A row's serialized size. `sizeBytes` used to be `items × a bytes-per-item
 * constant`, which is a stored aggregate wearing arithmetic: it reported a
 * size for rows nobody had measured and stayed plausible while the corpus
 * changed underneath it. Measuring the rows cannot drift from the rows.
 */
const rowBytes = (row: unknown): number => Buffer.byteLength(JSON.stringify(row), 'utf8');

/** Oldest row by `created_at`; unparseable stamps are skipped rather than
 *  treated as epoch 0, so one bad row cannot become "waiting since 1970". */
function earliest<Row extends { created_at: string }>(rows: Row[]): Row | undefined {
  let best: Row | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const ms = Date.parse(row.created_at);
    if (Number.isNaN(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = row;
  }
  return best;
}

/** Observations no cluster has claimed — the L0 backlog an L0→L1 pass has left
 *  to do, and the thing L1's lag is actually measured against. */
function pendingObservations(): Observation[] {
  const claimed = clusteredObservationIds();
  return observationRows().filter((o) => !claimed.has(o.id));
}

/** Clusters no artifact has distilled — the L1 backlog, and L2's lag. */
function pendingClusters(): Cluster[] {
  const referenced = referencedClusterIds();
  return clusterRows().filter((c) => !referenced.has(c.id));
}

/**
 * How far behind the merge INTO `level` is. L1 is chasing the unclustered
 * observations, L2 the undistilled clusters; L0 is the write head, so it
 * reports the same batch the next L0→L1 pass will take with a lag of zero —
 * nothing merges into it and it cannot be behind. An empty backlog is not
 * stale: no rows waiting means lag zero and `now` as the watermark, which is
 * what keeps an emptied world from alarming as stalled.
 */
function backlogFor(level: Level): { oldestAt: string; lagSeconds: number } {
  const waiting: Array<{ created_at: string }> = level === 'L2' ? pendingClusters() : pendingObservations();
  const first = earliest(waiting);
  if (!first) return { oldestAt: clock.nowIso(), lagSeconds: 0 };
  const ageSeconds = Math.max(0, Math.round((clock.now().getTime() - Date.parse(first.created_at)) / 1000));
  return { oldestAt: first.created_at, lagSeconds: level === 'L0' ? 0 : ageSeconds };
}

// ── Compaction jobs, counted ────────────────────────────────────────────────
//
// A job row (mock/distillation.ts) says when it ran and whether it worked, and
// nothing else. What it produced is counted from the rows that name it:
// `created_by_compaction_id` points back at the job, so a pass cannot claim
// output the corpus does not contain — which is exactly what the seeded jobs
// used to do, one of them typing `outputItems: 62` beside four produced ids.

/** Bedrock spend per input item merged — the one rate a pass is priced at. */
const COST_PER_INPUT_ITEM_USD = 0.0003;

function producedBy(jobId: string): { clusters: Cluster[]; artifacts: ArtifactRow[] } {
  return {
    clusters: clusterRows().filter((c) => c.created_by_compaction_id === jobId),
    artifacts: artifactRows().filter((a) => a.created_by_compaction_id === jobId),
  };
}

/**
 * What a pass consumed: the observations behind the clusters it made, or the
 * clusters behind the artifacts it made. A FAILED pass produced nothing, so it
 * borrows the batch its retry later merged (`retriedBy`) — those are the
 * inputs it had in hand when it aborted, and they are still countable rows
 * rather than a number somebody wrote into the error message.
 */
function consumedBy(row: CompactionJobRow): { items: number; bytes: number } {
  const { clusters, artifacts } = producedBy(row.status === 'failed' && row.retriedBy ? row.retriedBy : row.id);
  // A pass run by the queue consumer that has not produced anything yet (it is
  // still running, or it failed with no retry) consumed the batch it claimed —
  // ids on the row, resolved against the level below, still counted.
  if (clusters.length === 0 && artifacts.length === 0 && row.inputIds && row.inputIds.length > 0) {
    const claimed = new Set(row.inputIds);
    const rows: unknown[] = row.level === 'L1'
      ? observationRows().filter((o) => claimed.has(o.id))
      : clusterRows().filter((c) => claimed.has(c.id));
    return { items: rows.length, bytes: sumBy(rows, rowBytes) };
  }
  if (row.level === 'L1') {
    const byId = new Map(observationRows().map((o) => [o.id, o]));
    const consumed = clusters.flatMap((c) => c.member_observation_ids.flatMap((id) => {
      const o = byId.get(id);
      return o ? [o] : [];
    }));
    return { items: consumed.length, bytes: sumBy(consumed, rowBytes) };
  }
  const byId = new Map(clusterRows().map((c) => [c.id, c]));
  const consumed = artifacts.flatMap((a) => a.cluster_ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  }));
  return { items: consumed.length, bytes: sumBy(consumed, rowBytes) };
}

/**
 * The wire job: stored fields read through, counted fields counted on every
 * access. Getters rather than a snapshot because a hand-triggered pass is
 * handed back while it is still `running` and finishes a few seconds later —
 * a caller (or a test) holding that object must see the pass complete, not a
 * photograph of the moment it started.
 */
/** "1 note" / "3 notes" — every sentence below counts, so it pluralises. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The unit a pass reads and the unit it writes, in the words the portal uses
 *  for the tiers (run notes → patterns → guides). */
function unitsFor(level: Level): { input: string; output: string } {
  return level === 'L1'
    ? { input: 'run note', output: 'pattern' }
    : { input: 'pattern', output: 'draft guide' };
}

/** The ids a pass consumed. Once it has produced anything (or failed and been
 *  retried) the answer is counted back out of the corpus by consumedBy; before
 *  that it is the batch the consumer claimed, recorded on the row. */
function inputIdsOf(row: CompactionJobRow): string[] {
  const source = row.status === 'failed' && row.retriedBy ? row.retriedBy : row.id;
  const { clusters, artifacts } = producedBy(source);
  if (row.level === 'L1' && clusters.length > 0) return clusters.flatMap((c) => c.member_observation_ids);
  if (row.level === 'L2' && artifacts.length > 0) return artifacts.flatMap((a) => a.cluster_ids);
  return row.inputIds ? row.inputIds.slice() : [];
}

function whatChanged(row: CompactionJobRow): string {
  const { input, output } = unitsFor(row.level);
  const queue = COMPACTION_QUEUES[row.level as CompactableLevel] ?? row.level;
  const scope = row.repo ? ` for ${row.repo}` : '';
  if (row.status === 'queued') return `Waiting on ${queue}${scope} — nothing has changed yet.`;
  if (row.status === 'running') return `In progress${scope}: ${row.stepLabel ?? 'claimed from the queue'} — nothing is written until the pass finishes.`;
  const consumed = consumedBy(row).items;
  if (row.status === 'failed') {
    const below = row.level === 'L1' ? 'L0' : 'L1';
    return `Nothing changed — the pass stopped before writing, so its ${plural(consumed, input)} ${consumed === 1 ? 'is' : 'are'} still waiting in ${below}.`;
  }
  const { clusters, artifacts } = producedBy(row.id);
  const made = row.level === 'L1' ? clusters.length : artifacts.length;
  if (consumed === 0 && made === 0) return `Nothing was waiting${scope} — no new ${output}s.`;
  if (row.level === 'L1') {
    const folded = Math.max(0, consumed - made);
    return `Merged ${plural(consumed, input)} into ${plural(made, output)}${folded > 0 ? `, folding ${plural(folded, 'duplicate')}` : ''}.`;
  }
  return `Distilled ${plural(consumed, input)} into ${plural(made, output)}.`;
}

/**
 * The run log. A pass run by this process wrote its own log as it went. The
 * seeded history predates the queue, so its log is reconstructed from what the
 * row and the corpus say — claim at startedAt, outcome at finishedAt — with
 * every number counted, never quoted from the seed.
 */
function logOf(row: CompactionJobRow): CompactionLogEntry[] {
  if (row.log) return row.log.slice();
  const { input } = unitsFor(row.level);
  const queue = COMPACTION_QUEUES[row.level as CompactableLevel] ?? row.level;
  const consumed = consumedBy(row).items;
  const entries: CompactionLogEntry[] = [
    { at: row.startedAt, level: 'info', message: `Claimed from ${queue}: ${plural(consumed, input)} waiting.` },
  ];
  if (row.finishedAt) {
    entries.push(row.status === 'failed'
      ? { at: row.finishedAt, level: 'error', message: row.error ?? 'The pass failed.' }
      : { at: row.finishedAt, level: 'info', message: whatChanged(row) });
  }
  return entries;
}

function phaseOf(row: CompactionJobRow): CompactionPhase {
  if (row.phase) return row.phase;
  if (row.status === 'succeeded') return 'done';
  if (row.status === 'failed') return 'failed';
  return row.status === 'queued' ? 'queued' : 'claim';
}

function percentOf(row: CompactionJobRow): number | null {
  if (row.percent !== undefined) return row.percent;
  if (row.status === 'succeeded') return 100;
  if (row.status === 'queued') return 0;
  return null;
}

/**
 * The wire job: stored fields read through, counted fields counted on every
 * access. Getters rather than a snapshot because a hand-triggered pass is
 * handed back while it is still `queued` and finishes a few seconds later —
 * a caller (or a test) holding that object must see the pass complete, not a
 * photograph of the moment it started. Getters on an object literal are own
 * enumerable properties, so JSON.stringify serialises every one of them.
 */
function jobView(row: CompactionJobRow): CompactionJob {
  const outputs = () => {
    const p = producedBy(row.id);
    return { ...p, count: p.clusters.length + p.artifacts.length };
  };
  return {
    get id() { return row.id; },
    get level() { return row.level; },
    get startedAt() { return row.startedAt; },
    get finishedAt() { return row.finishedAt; },
    get status() { return row.status; },
    get produced() {
      const p = outputs();
      return { cluster_ids: p.clusters.map((c) => c.id), artifact_ids: p.artifacts.map((a) => a.id) };
    },
    get inputItems() { return consumedBy(row).items; },
    get outputItems() { return outputs().count; },
    get dedupedItems() {
      // A pass that aborted merged nothing: its inputs were abandoned, not
      // deduplicated. Reporting input-minus-output here would credit the
      // seeded failure with a 100% dedupe rate — the exact fiction this
      // module's `dedupeRatio` doc refuses to tell.
      if (row.status !== 'succeeded') return 0;
      return Math.max(0, consumedBy(row).items - outputs().count);
    },
    get bytesReclaimed() {
      if (row.status !== 'succeeded') return 0;
      const p = outputs();
      const producedBytes = sumBy(p.clusters, rowBytes) + sumBy(p.artifacts, rowBytes);
      return Math.max(0, consumedBy(row).bytes - producedBytes);
    },
    get costUsd() { return Number((consumedBy(row).items * COST_PER_INPUT_ITEM_USD).toFixed(4)); },
    get error() {
      if (!row.error) return undefined;
      if (!row.retriedBy) return row.error;
      const { items } = consumedBy(row);
      const unit = row.level === 'L1' ? 'observations' : 'clusters';
      return `${row.error} Its ${items} input ${unit} were left untouched in the level below, and ${row.retriedBy} re-merged them.`;
    },
    get queued_at() { return row.queuedAt ?? row.startedAt; },
    get queue() { return COMPACTION_QUEUES[row.level as CompactableLevel] ?? row.level; },
    get repo() { return row.repo ?? null; },
    get requested_by() { return row.requestedBy ?? null; },
    get input_ids() { return inputIdsOf(row); },
    get output_ids() {
      const p = outputs();
      return [...p.clusters.map((c) => c.id), ...p.artifacts.map((a) => a.id)];
    },
    get log() { return logOf(row); },
    get what_changed() { return whatChanged(row); },
    get duration_ms() {
      if (row.status === 'queued') return null;
      const end = row.finishedAt ? Date.parse(row.finishedAt) : clock.now().getTime();
      return Math.max(0, end - Date.parse(row.startedAt));
    },
    get cost_usd() { return Number((consumedBy(row).items * COST_PER_INPUT_ITEM_USD).toFixed(4)); },
    get phase() { return phaseOf(row); },
    get percent() { return percentOf(row); },
    get stepLabel() { return row.stepLabel ?? null; },
    get attempts() { return row.attempts ?? (row.status === 'queued' ? 0 : 1); },
  };
}

// ── The human sample dial ───────────────────────────────────────────────────

const REVIEWED_WINDOW_DAYS = 30;

/**
 * Every number on the calibration banner, counted from the same review store
 * `/review` lists and `decideReview` mutates — so deciding one sample moves
 * the banner and the queue beneath it together and they cannot disagree
 * (DEFECTS.md org-leader #18). That includes the sample RATE, which used to be
 * a standalone `4`: the banner labels it "% of L1 sampled", and the honest
 * answer to that is how many L1 clusters have actually been drawn for review,
 * not a dial nobody could check. It moves on its own the moment a compaction
 * pass mints clusters no reviewer has seen.
 */
function computeSamplingState(): SamplingState {
  const samples = reviewRows();
  const windowMs = REVIEWED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = clock.now().getTime();
  const inWindow = samples.filter((r) => now - Date.parse(r.sampled_at) <= windowMs);
  const decided = inWindow.filter((r) => r.verdict !== 'pending');
  const agreeCount = countBy(decided, 'verdict').get('agree') ?? 0;
  const queueDepth = countBy(samples, 'verdict').get('pending') ?? 0;

  const clusterIds = new Set(clusterRows().map((c) => c.id));
  const sampledClusters = new Set(
    samples.filter((r) => r.target_kind === 'cluster' && clusterIds.has(r.target_id)).map((r) => r.target_id),
  );

  // One decimal place, e.g. 18/21 -> 85.7 — round rather than truncate so a
  // decision that lands on an exact tenth (e.g. 17/20 -> 85.0) still reads
  // as a plain number, not 85.04999999999999.
  const agreementRatePct = decided.length === 0 ? 0 : Math.round((agreeCount / decided.length) * 1000) / 10;
  return {
    l1SampleRatePct: clusterIds.size === 0 ? 0 : Math.round((sampledClusters.size / clusterIds.size) * 100),
    reviewedLast30d: decided.length,
    agreementRatePct,
    queueDepth,
  };
}

// ─── Simulated write pressure ───────────────────────────────────────────────
// L0 is the write head: sessions keep adding observations while nobody is
// looking. The round-3 audit ran two L0 → L1 compactions in a row and the
// second found nothing left — the mock had no writers. So, at the rate the
// writers fixture adds up to, new observations arrive on a clock: every read
// of levels/items/ingest mints the ones that "landed" since the last tick
// (deterministic, monotonic ids), never more than a tick's worth at once.
// Each one is minted FROM a writer row, so its repo, session, box and
// initiative are that writer's own rather than a second table's invention.

const INGEST_TICK_MS = 60_000;
let ingestSeq = 0;
let ingestLastTick = clock.now().getTime();

/** Mint the observations that arrived since the last tick. Exported for tests. */
export function simulateIngest(nowMs: number = clock.now().getTime()): Observation[] {
  const writers = writerRows();
  const rows = observationRows();
  // Nobody writing, or a corpus an auditor has deliberately emptied: minting
  // here would refill the very surface they asked to see empty, which is the
  // shared-mutable-world problem the scenario control plane exists to end.
  if (writers.length === 0 || rows.length === 0) {
    ingestLastTick = nowMs;
    return [];
  }
  const elapsed = nowMs - ingestLastTick;
  if (elapsed < INGEST_TICK_MS) return [];
  const ticks = Math.min(5, Math.floor(elapsed / INGEST_TICK_MS));
  ingestLastTick += ticks * INGEST_TICK_MS;
  const perTick = Math.max(1, Math.round(sumBy(writers, 'observationsPerHour') / 60));
  const minted: Observation[] = [];
  for (let i = 0; i < ticks * perTick; i += 1) {
    ingestSeq += 1;
    const w = writers[(ingestSeq - 1) % writers.length]!;
    const obs: Observation = {
      id: `obs-9${String(ingestSeq).padStart(3, '0')}`,
      session_id: w.session_id,
      box_id: w.box_id,
      repo: w.repo,
      initiative_id: w.initiative_id,
      ...w.writes,
      created_at: new Date(nowMs - (ticks * perTick - i) * 1000).toISOString(),
    };
    rows.push(obs);
    minted.push(obs);
    recordWriterWrite(w, obs.created_at);
  }
  // An L0 write is a tier change: the realtime publisher re-reads /levels and
  // pushes it on distill:levels (lib/distillation-realtime.ts).
  if (minted.length > 0) distillationEvents.emit('levels');
  return minted;
}

/**
 * Test-only: put every fixture in this domain back to its seed and forget the
 * id counters, so a suite that forces a compaction pass doesn't leak new
 * clusters/artifacts/facts/jobs into a test that runs after it.
 *
 * This is the floor's `reset` with the provider's own counters folded in —
 * `fixtureRegistry.resetAll()` (or the control plane's `POST /api/__mock/reset`)
 * restores the rows, and this adds the two things that are not rows: the mint
 * sequence and the ingest tick.
 */
export function __resetDistillationMock(): void {
  for (const fixture of distillationFixtures) fixture.reset();
  distillationQueueMessages.reset();
  runningJobs.clear();
  injectedFailures = 0;
  // Emptied, not replaced: a running startReplicaSync holds this instance, and
  // a fresh one would be a replica nothing ever syncs.
  void replica?.clear();
  ingestSeq = 0;
  ingestLastTick = clock.now().getTime();
  compactSeq = 0;
  clusterSeq = 0;
  artifactSeq = 0;
  factSeq = 0;
  applicationSeq = 0;
  reviewSeq = 0;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export async function levels(): Promise<LevelState[]> {
  // Aurora path: no level-rollup table yet — mock-first, like promotions.ts.
  void config;
  simulateIngest();
  const rowsFor: Record<Level, unknown[]> = {
    L0: observationRows(),
    L1: clusterRows(),
    L2: artifactsOnWire(),
  };
  // A tier's number is the number of things a person can open under it: the
  // length of the list that tier serves, never a counter kept beside it.
  return (['L0', 'L1', 'L2'] as const).map((level) => ({
    level,
    items: rowsFor[level].length,
    sizeBytes: sumBy(rowsFor[level], rowBytes),
    ...backlogFor(level),
  }));
}

/** A tier's health as the Activity page reads it: `compactionHealth`'s verdict
 *  in the spec's vocabulary (`ok` rather than `healthy`), with the lag it was
 *  decided from. The judgment is still made once, in compactionHealth. */
export interface TierHealth {
  state: 'ok' | 'behind' | 'stalled';
  reason: string;
  lagSeconds: number;
}

/** One tier on /levels (spec §3a): the counted state plus what the tier-flow
 *  strip and the status line need. */
export interface LevelView extends LevelState {
  /** L0: distinct sessions that wrote an observation in the last hour. L1/L2:
   *  distinct compaction passes that wrote a row into the tier in the last
   *  hour — for a tier written by the machine, the pass IS the writer. */
  writers: number;
  /** Rows waiting on the tier's OUTBOUND step: L0 notes no pattern has
   *  claimed, L1 patterns no guide has distilled, L2 draft guides not yet
   *  published to the Library. */
  backlog: number;
  /** When the pass INTO this tier last succeeded; null for L0 (nothing flows
   *  in) or a tier no pass has ever completed. */
  lastCompletedAt: string | null;
  /** Merkle root over (id, updated_at) of the tier's rows — changes iff the
   *  tier's content does (lib/distillation-digest.ts). */
  digest: string;
  health: TierHealth;
}

const WRITERS_WINDOW_MS = 60 * 60 * 1000;

/** /levels, enriched. The realtime `distill:levels` frame carries exactly this
 *  array, so the pushed state and the fetched state are one serializer. */
export async function levelsView(): Promise<{ levels: LevelView[]; health: LevelHealth[] }> {
  const [ls, jobs, storedWriters] = await Promise.all([
    levels(),
    listCompactions(),
    // Aurora: L0's writers are the sessions the writers table saw land a row
    // in the window. Mock: counted from the observation rows below.
    config.mock.aurora ? Promise.resolve(null) : readRecentWriters(WRITERS_WINDOW_MS),
  ]);
  const health = compactionHealth(ls, jobs);
  const now = clock.now().getTime();
  const recent = (iso: string): boolean => now - Date.parse(iso) <= WRITERS_WINDOW_MS;
  const observations = observationRows();
  const clusters = clusterRows();
  const artifacts = artifactsOnWire();

  const writersFor: Record<Level, number> = {
    L0: storedWriters
      ? new Set(storedWriters.map((w) => w.session_id)).size
      : new Set(observations.filter((o) => recent(o.created_at)).map((o) => o.session_id)).size,
    L1: new Set(clusters.filter((c) => recent(c.created_at)).map((c) => c.created_by_compaction_id)).size,
    L2: new Set(artifacts.filter((a) => recent(a.created_at)).map((a) => a.created_by_compaction_id)).size,
  };
  const backlogFor: Record<Level, number> = {
    L0: pendingObservations().length,
    L1: pendingClusters().length,
    L2: artifacts.filter((a) => a.status === 'draft').length,
  };
  const lastCompleted = (level: Level): string | null => {
    const done = jobs.filter((j) => j.level === level && j.status === 'succeeded' && j.finishedAt)
      .map((j) => j.finishedAt!)
      .sort();
    return done[done.length - 1] ?? null;
  };
  const digestRows: Record<Level, Array<{ id: string; stamp: string }>> = {
    L0: observations.map((o) => ({ id: o.id, stamp: o.created_at })),
    L1: clusters.map((c) => ({ id: c.id, stamp: c.updated_at })),
    L2: artifacts.map((a) => ({ id: a.id, stamp: a.updated_at })),
  };
  const digests = await Promise.all(ls.map((l) => tierDigest(digestRows[l.level])));

  const views = ls.map((l, i): LevelView => {
    const h = health.find((x) => x.level === l.level)!;
    return {
      ...l,
      writers: writersFor[l.level],
      backlog: backlogFor[l.level],
      lastCompletedAt: l.level === 'L0' ? null : lastCompleted(l.level),
      digest: digests[i]!,
      health: { state: h.status === 'healthy' ? 'ok' : h.status, reason: h.reason, lagSeconds: l.lagSeconds },
    };
  });
  return { levels: views, health };
}

export async function ingest(): Promise<IngestState> {
  simulateIngest();
  // Aurora: the writers that landed a row in the last hour — the table keeps
  // every writer it has ever seen, so "active" is a window, not a row count.
  const writers: Array<{ repo: string; observationsPerHour: number }> = config.mock.aurora
    ? writerRows()
    : await readRecentWriters(WRITERS_WINDOW_MS);
  const perHour = sumBy(writers, 'observationsPerHour');
  const byRepo = groupBy(writers, 'repo');
  return {
    activeWriters: writers.length,
    observationsPerHour: perHour,
    topRepos: [...byRepo]
      .map(([repo, rows]) => ({
        repo,
        share: perHour === 0 ? 0 : Number((sumBy(rows, 'observationsPerHour') / perHour).toFixed(2)),
      }))
      .sort((a, b) => b.share - a.share || a.repo.localeCompare(b.repo)),
  };
}

export async function listCompactions(opts: { level?: Level; status?: CompactionStatus } = {}): Promise<CompactionJob[]> {
  if (!config.mock.aurora) return readCompactions(opts, clock.now().getTime());
  let rows = jobRows().slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (opts.level) rows = rows.filter((j) => j.level === opts.level);
  if (opts.status) rows = rows.filter((j) => j.status === opts.status);
  return rows.map(jobView);
}

/** One job by id, or null when there is none (the route's 404). */
export async function getCompaction(id: string): Promise<CompactionJob | null> {
  if (!config.mock.aurora) return readCompaction(id, clock.now().getTime());
  return (await listCompactions()).find((j) => j.id === id) ?? null;
}

/** One job as it stands this instant, as plain JSON — what a `distill:jobs`
 *  frame carries. Synchronous on purpose: the phases of a fast pass are
 *  announced back to back, and an async read would see the LAST phase for
 *  every frame instead of each phase in turn. */
export function jobSnapshot(id: string): CompactionJob | null {
  const row = jobRows().find((j) => j.id === id);
  return row ? (JSON.parse(JSON.stringify(jobView(row))) as CompactionJob) : null;
}

export async function sampling(): Promise<SamplingState> {
  return computeSamplingState();
}

/** Levels a compaction can write INTO — L0 is the write head, nothing merges
 *  into it, so it is deliberately excluded from this type. */
export type CompactableLevel = 'L1' | 'L2';

let compactSeq = 0;
let clusterSeq = 0;
let artifactSeq = 0;
let factSeq = 0;
let applicationSeq = 0;
let reviewSeq = 0;

/** Every observation id already claimed by some cluster — the complement is
 *  the L0 backlog an L1 pass has left to do. */
function clusteredObservationIds(): Set<string> {
  const ids = new Set<string>();
  for (const c of clusterRows()) for (const oid of c.member_observation_ids) ids.add(oid);
  return ids;
}

/** Every cluster id already claimed by some artifact — the complement is the
 *  L1 backlog an L2 pass has left to do. */
function referencedClusterIds(): Set<string> {
  const ids = new Set<string>();
  for (const a of artifactRows()) for (const cid of a.cluster_ids) ids.add(cid);
  return ids;
}

// Total over ObservationKind on purpose, and `procedure` is deliberately not
// reachable from it: which type a lone kind maps to is a per-cluster fact,
// whereas "this is a procedure" is a property of the whole CHUNK an L2 pass
// distils (a trigger, an outcome, and enough actions to order). That
// decision is isProceduralChunk below, taken before this table is consulted.
const ARTIFACT_TYPE_FOR_KIND: Record<ObservationKind, ArtifactType> = {
  decision: 'decision',
  convention: 'convention',
  worked: 'runbook',
  failed: 'insight',
  gotcha: 'insight',
};

/** Something bit. */
const TRIGGER_KINDS: ReadonlySet<ObservationKind> = new Set(['failed', 'gotcha']);
/** Something resolved it. */
const OUTCOME_KINDS: ReadonlySet<ObservationKind> = new Set(['worked', 'decision']);
/** Something a session can DO, in order — the raw material of a step. */
const ACTION_KINDS: ReadonlySet<ObservationKind> = new Set(['worked', 'decision', 'convention']);

/**
 * A chunk is procedural when its member observations carry a TRIGGER (kind
 * failed|gotcha: something bit) AND an OUTCOME (kind worked|decision:
 * something resolved it) AND at least two ACTION-shaped members
 * (worked|decision|convention) exist to order into steps. This is the same
 * outcome+trigger shape promotions.ts's classifyPattern uses to tell a
 * runbook from an insight, lifted from one cluster to the chunk an L2 pass
 * distils — a single "it worked" with nothing that went wrong first is a
 * runbook, and a gotcha with nothing that fixed it is an insight; only the
 * pair, with steps to order, is a procedure. Members whose observation is
 * missing from L0 are skipped rather than counted, so a dangling id cannot
 * promote a chunk on its own.
 */
export function isProceduralChunk(chunk: Cluster[], observationsById: Map<string, Observation>): boolean {
  const members = chunk.flatMap((c) => c.member_observation_ids.flatMap((id) => {
    const o = observationsById.get(id);
    return o ? [o] : [];
  }));
  const hasTrigger = members.some((o) => TRIGGER_KINDS.has(o.kind));
  const hasOutcome = members.some((o) => OUTCOME_KINDS.has(o.kind));
  const actions = members.filter((o) => ACTION_KINDS.has(o.kind)).length;
  return hasTrigger && hasOutcome && actions >= 2;
}

/**
 * L0 -> L1: take every observation not already a member of some cluster
 * (oldest first, so the slice is deterministic run to run), group what's
 * available by (repo, kind), and mint one new cluster per group. The pass
 * reports nothing back: the clusters it pushes name it as their creator, so
 * its output, its input and its dedupe are counted off the corpus afterwards
 * — including the honest 0/0/0 when nothing was left to compact.
 */
function runL1Compaction(jobId: string, startedAt: string, batch?: ReadonlySet<string>): void {
  // `batch` is what the consumer claimed. Anything that landed in L0 after the
  // claim waits for the next pass, and anything another pass clustered in the
  // meantime is no longer pending — so a pass writes exactly its own batch.
  const pending = pendingObservations()
    .filter((o) => !batch || batch.has(o.id))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (pending.length === 0) return;

  for (const members of groupBy(pending, (o) => `${o.repo}|${o.kind}`).values()) {
    clusterSeq += 1;
    const id = `cl-9${String(clusterSeq).padStart(2, '0')}`;
    const first = members[0]!;
    const cluster: Cluster = {
      id,
      title: members.length === 1 ? first.title : `${first.title} (+${members.length - 1} more)`,
      summary: members.map((o) => o.title).join('; '),
      kind: first.kind,
      repo: first.repo,
      initiative_id: first.initiative_id,
      tags: [...new Set(members.flatMap((o) => o.tags))],
      member_observation_ids: members.map((o) => o.id),
      confidence: Number(Math.min(0.95, 0.7 + members.length * 0.05).toFixed(2)),
      created_by_compaction_id: jobId,
      created_at: startedAt,
      updated_at: startedAt,
    };
    clusterRows().push(cluster);
  }
}

/** Mint the next fact id — one counter for every fact an L2 pass writes,
 *  step or claim, so ids stay unique across chunks and across types. */
function nextFactId(): string {
  factSeq += 1;
  return `fact-9${String(factSeq).padStart(2, '0')}`;
}

/**
 * The facts of a non-procedural chunk: one `supports` claim per member
 * cluster, evidenced by that cluster's own observations — the shape every
 * seeded runbook/insight/decision/convention already has.
 */
function mintClaimFacts(artifactId: string, chunk: Cluster[]): string[] {
  return chunk.map((c) => {
    const fact: Fact = {
      id: nextFactId(),
      artifact_id: artifactId,
      statement: c.summary,
      subject: c.title,
      predicate: 'supports',
      object: artifactId,
      evidence_observation_ids: c.member_observation_ids.slice(),
      confidence: c.confidence,
      ordinal: null,
    };
    factRows().push(fact);
    return fact.id;
  });
}

/**
 * The facts of a procedural chunk. Steps are the ACTION-shaped member
 * observations across the whole chunk, in the order they were written
 * (created_at, then id — the order a session actually did them), minted as
 * facts with ordinal 1..n, each citing exactly the one observation it was
 * lifted from and carrying its parent cluster's confidence. The trigger
 * observations (failed|gotcha) become plain `supports` claims with no
 * ordinal — the "why" under the steps. Returns the fact ids in step order,
 * claims after, plus the two lists the body is written from.
 */
function mintProcedureFacts(
  artifactId: string, chunk: Cluster[], byId: Map<string, Observation>,
): { factIds: string[]; steps: Observation[]; triggers: Observation[] } {
  const members = chunk.flatMap((c) => c.member_observation_ids.flatMap((id) => {
    const o = byId.get(id);
    return o ? [{ o, cluster: c }] : [];
  }));
  const ordered = members
    .slice()
    .sort((a, b) => a.o.created_at.localeCompare(b.o.created_at) || a.o.id.localeCompare(b.o.id));
  const steps = ordered.filter(({ o }) => ACTION_KINDS.has(o.kind));
  const triggers = ordered.filter(({ o }) => TRIGGER_KINDS.has(o.kind));
  const factIds: string[] = [];
  steps.forEach(({ o, cluster }, i) => {
    const fact: Fact = {
      id: nextFactId(),
      artifact_id: artifactId,
      statement: o.title,
      subject: cluster.title,
      predicate: 'step_of',
      object: artifactId,
      evidence_observation_ids: [o.id],
      confidence: cluster.confidence,
      ordinal: i + 1,
    };
    factRows().push(fact);
    factIds.push(fact.id);
  });
  for (const { o, cluster } of triggers) {
    const fact: Fact = {
      id: nextFactId(),
      artifact_id: artifactId,
      statement: o.title,
      subject: cluster.title,
      predicate: 'supports',
      object: artifactId,
      evidence_observation_ids: [o.id],
      confidence: cluster.confidence,
      ordinal: null,
    };
    factRows().push(fact);
    factIds.push(fact.id);
  }
  return { factIds, steps: steps.map((s) => s.o), triggers: triggers.map((t) => t.o) };
}

/**
 * L1 -> L2: take every cluster not already referenced by some artifact
 * (oldest first), group same-repo clusters into chunks of up to 3, and
 * distil each chunk into one new draft artifact. A chunk that carries a
 * trigger, an outcome and steps to order (isProceduralChunk) becomes a
 * `procedure` whose facts are its ordered steps; any other chunk keeps
 * today's one-fact-per-member-cluster shape and the type its first
 * cluster's kind maps to. Either way the new artifact resolves through
 * getItem/lineageFor/listArtifacts immediately, and has no Library link
 * (nobody has published it) — the absence of a row in the links fixture,
 * not a stored null.
 */
function runL2Compaction(jobId: string, startedAt: string, batch?: ReadonlySet<string>): void {
  const pending = pendingClusters()
    .filter((c) => !batch || batch.has(c.id))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (pending.length === 0) return;
  const byId = new Map(observationRows().map((o) => [o.id, o]));

  for (const clustersInRepo of groupBy(pending, (c) => c.repo).values()) {
    for (let i = 0; i < clustersInRepo.length; i += 3) {
      const chunk = clustersInRepo.slice(i, i + 3);
      artifactSeq += 1;
      const id = `art-9${String(artifactSeq).padStart(2, '0')}`;
      const first = chunk[0]!;
      const procedural = isProceduralChunk(chunk, byId);
      let facts: string[];
      let body_markdown: string;
      if (procedural) {
        const minted = mintProcedureFacts(id, chunk, byId);
        facts = minted.factIds;
        body_markdown =
          `## Steps\n${minted.steps.map((o, n) => `${n + 1}. ${o.title}`).join('\n')}\n\n` +
          `## Why\n${minted.triggers.map((o) => `- ${o.title}`).join('\n')}`;
      } else {
        facts = mintClaimFacts(id, chunk);
        body_markdown = chunk.map((c) => `- ${c.title}: ${c.summary}`).join('\n');
      }
      const artifact: ArtifactRow = {
        id,
        type: procedural ? 'procedure' : ARTIFACT_TYPE_FOR_KIND[first.kind],
        title: chunk.length === 1 ? first.title : `${first.title} (+${chunk.length - 1} more)`,
        summary: chunk.map((c) => c.summary).join(' '),
        body_markdown,
        cluster_ids: chunk.map((c) => c.id),
        facts,
        // A freshly minted draft has no accountable owner assigned by a
        // human yet — OWNER_BY_REPO is the same steward a hand-seeded row
        // for this repo would get, not a second mapping that could drift
        // from it. Classification defaults to the least-permissive labelled
        // tier below 'confidential': nobody has assessed sensitivity yet, so
        // 'public' would overclaim and 'confidential' would overclaim the
        // other way for a chunk that turns out to be routine.
        owner: OWNER_BY_REPO[first.repo] ?? 'Unassigned',
        classification: 'internal',
        status: 'draft',
        reviewed_by: null,
        reviewed_at: null,
        // Nothing has been published or invoked yet — same "absence, not a
        // stored null" posture as library_item_id above it.
        last_used_at: null,
        created_by_compaction_id: jobId,
        created_at: startedAt,
        updated_at: startedAt,
      };
      artifactRows().push(artifact);
    }
  }
}

// ─── Compaction jobs on the queue ───────────────────────────────────────────
//
// `POST /compact` no longer runs a pass on a timer. It writes a `queued` job
// row and sends one message to `distill-compact-l1|l2` (lib/distillation-
// queue.ts) — FIFO, grouped by repo, deduplicated by job id. A consumer loop
// in this process claims the message, runs the pass in phases (each one a
// `distill:jobs` frame), and acks it. The pieces that make that safe:
//
//   - Idempotency is the job id. A redelivered message whose job already
//     finished is acked and noted in the job's log, never run twice. A
//     message whose job is running in this process is left for its lease.
//   - A pass that throws is left unacked: the queue hands it back after the
//     visibility timeout, and after MAX_RECEIVES deliveries the job is marked
//     failed and the queue moves the message to the dead-letter queue.
//   - A reset (`POST /api/__mock/reset`) empties the queue fixture and the job
//     rows together. A pass mid-flight re-checks that its row still exists
//     before writing, so it cannot write into the world the reset restored.
//
// Scheduling on a cadence is `startCompactionScheduler` below, off unless
// DISTILL_COMPACT_INTERVAL_MIN is set: under dev:mock a background pass would
// quietly compact away the backlog an audit came to look at.

/** How long a pass takes end to end, spread across its phases. The audit saw
 *  every Compact resolve to `succeeded` in the same response — no observable
 *  running state. 0 runs the phases back to back (the test seam), and with
 *  the in-process queue compactNow then drains the queue before returning. */
let compactRunMs = 3_000;
export function __setCompactRunMs(ms: number): void { compactRunMs = ms; }

/** Jobs a consumer in this process is running now — a redelivery of one of
 *  these is a slow pass, not a duplicate, and must not be acked from under it. */
const runningJobs = new Set<string>();

interface CompactionMessage { job_id: string; level: CompactableLevel; repo: string | null }

function appendLog(row: CompactionJobRow, level: CompactionLogEntry['level'], message: string): void {
  if (!row.log) row.log = logOf(row);
  row.log.push({ at: clock.nowIso(), level, message });
}

/** Tell the world a job moved: the realtime publisher, and the Aurora mirror. */
function announce(row: CompactionJobRow): void {
  const view = jobView(row);
  persistJob({
    id: view.id, level: view.level, repo: view.repo, status: view.status, phase: view.phase,
    percent: view.percent, requested_by: view.requested_by, queued_at: view.queued_at,
    startedAt: view.startedAt, finishedAt: view.finishedAt, input_ids: view.input_ids,
    output_ids: view.output_ids, log: view.log, what_changed: view.what_changed,
    duration_ms: view.duration_ms, cost_usd: view.cost_usd, attempts: view.attempts,
    stepLabel: view.stepLabel, bytesReclaimed: view.bytesReclaimed,
    ...(view.error ? { error: view.error } : {}),
  });
  distillationEvents.emit('job', row.id);
}

function setPhase(row: CompactionJobRow, phase: CompactionPhase, percent: number | null, stepLabel: string | null): void {
  row.phase = phase;
  row.percent = percent;
  row.stepLabel = stepLabel;
  if (stepLabel) appendLog(row, 'info', stepLabel);
  announce(row);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

/** The batch a pass claims: what is waiting in the level below, in its repo. */
function claimBatch(level: CompactableLevel, repo: string | null): string[] {
  const waiting: Array<{ id: string; repo: string }> = level === 'L1' ? pendingObservations() : pendingClusters();
  return waiting.filter((r) => !repo || r.repo === repo).map((r) => r.id);
}

/** Test seam: fail the next N passes at the write phase, so DLQ behaviour can
 *  be exercised through the real consumer rather than a stubbed one. */
let injectedFailures = 0;
export function __failNextCompactions(n: number): void { injectedFailures = n; }

/** Run one claimed pass. Throws when the pass fails (the caller leaves the
 *  message unacked); returns false when the job vanished mid-run (a reset). */
async function runPass(row: CompactionJobRow, level: CompactableLevel, delivery: number): Promise<boolean> {
  const queue = COMPACTION_QUEUES[level];
  const step = Math.max(0, compactRunMs) / 4;
  const { input } = unitsFor(level);
  row.status = 'running';
  row.startedAt = clock.nowIso();
  row.finishedAt = null;
  row.attempts = delivery;
  row.inputIds = claimBatch(level, row.repo ?? null);
  setPhase(row, 'claim', 5, `Claimed from ${queue} (delivery ${delivery})`);
  if (step > 0) await sleep(step);
  setPhase(row, 'read', 25, `Reading ${plural(row.inputIds.length, `waiting ${input}`)}${row.repo ? ` in ${row.repo}` : ''}`);
  if (step > 0) await sleep(step);
  setPhase(row, 'merge', 60, level === 'L1' ? 'Merging notes by repo and kind' : 'Distilling patterns into draft guides');
  if (step > 0) await sleep(step);
  // A reset between claim and write replaced the job rows: this pass belongs
  // to a world that no longer exists, so it writes nothing into the new one.
  if (!jobRows().includes(row)) return false;
  if (injectedFailures > 0) {
    injectedFailures -= 1;
    throw new Error('compaction write failed (injected)');
  }
  setPhase(row, 'write', 90, level === 'L1' ? 'Writing patterns' : 'Writing draft guides');
  const batch = new Set(row.inputIds);
  if (level === 'L1') runL1Compaction(row.id, row.startedAt, batch);
  else runL2Compaction(row.id, row.startedAt, batch);
  if (step > 0) await sleep(step);
  row.status = 'succeeded';
  row.finishedAt = clock.nowIso();
  row.phase = 'done';
  row.percent = 100;
  row.stepLabel = null;
  appendLog(row, 'info', whatChanged(row));
  announce(row);
  distillationEvents.emit('levels');
  if (level === 'L2') distillationEvents.emit('artifacts');
  return true;
}

/**
 * Handle one delivery. Acks when the work is done or was already done (the
 * idempotent redelivery), leaves it unacked when the pass threw so the queue
 * can hand it back, and marks the job failed on its last allowed delivery.
 */
export async function processCompactionMessage(level: CompactableLevel, msg: QueueMessage): Promise<'ran' | 'duplicate' | 'orphan' | 'busy' | 'failed'> {
  const q = compactionQueue();
  const queue = COMPACTION_QUEUES[level];
  let body: CompactionMessage;
  try {
    body = JSON.parse(msg.body) as CompactionMessage;
  } catch {
    await q.ack(queue, msg.receipt_handle);
    return 'orphan';
  }
  const row = jobRows().find((j) => j.id === body.job_id);
  if (!row) {
    // The job row is gone (a reset, or a message from another process's
    // world). Nothing to run it against — ack so it does not dead-letter.
    await q.ack(queue, msg.receipt_handle);
    return 'orphan';
  }
  if (row.status === 'succeeded' || row.status === 'failed') {
    appendLog(row, 'warn', `Redelivered by ${queue} (delivery ${msg.approximate_receive_count}) after it had already ${row.status} — acknowledged without running again.`);
    announce(row);
    await q.ack(queue, msg.receipt_handle);
    return 'duplicate';
  }
  if (runningJobs.has(row.id)) return 'busy';

  runningJobs.add(row.id);
  try {
    const wrote = await runPass(row, level, msg.approximate_receive_count);
    await q.ack(queue, msg.receipt_handle);
    return wrote ? 'ran' : 'orphan';
  } catch (err) {
    const message = (err as Error).message;
    if (msg.approximate_receive_count >= MAX_RECEIVES) {
      row.status = 'failed';
      row.finishedAt = clock.nowIso();
      row.phase = 'failed';
      row.percent = null;
      row.stepLabel = null;
      row.error = `${message} — gave up after ${plural(msg.approximate_receive_count, 'delivery', 'deliveries')}; the message goes to ${queue}-dlq.`;
      appendLog(row, 'error', row.error);
    } else {
      row.status = 'queued';
      row.phase = 'retrying';
      row.percent = 0;
      row.stepLabel = null;
      appendLog(row, 'warn', `${message} — left on ${queue} for redelivery (delivery ${msg.approximate_receive_count} of ${MAX_RECEIVES}).`);
    }
    announce(row);
    return 'failed';
  } finally {
    runningJobs.delete(row.id);
  }
}

const pumping: Record<CompactableLevel, boolean> = { L1: false, L2: false };

/** Receive and process whatever is deliverable on one queue now. Returns how
 *  many deliveries it handled. Never runs two pumps on one queue at once. */
export async function pumpCompactionQueue(level: CompactableLevel, waitSeconds = 0): Promise<number> {
  if (pumping[level]) return 0;
  pumping[level] = true;
  let handled = 0;
  try {
    await ensureCompactionQueues();
    const q = compactionQueue();
    for (;;) {
      const msgs = await q.receive(COMPACTION_QUEUES[level], { max: 5, ...(waitSeconds > 0 ? { waitSeconds } : {}) });
      if (msgs.length === 0) break;
      for (const msg of msgs) {
        await processCompactionMessage(level, msg);
        handled += 1;
      }
      // Over HTTP a long poll returns as soon as anything arrives; loop only
      // while the queue keeps answering, and let the caller re-poll.
      if (waitSeconds > 0) break;
    }
  } finally {
    pumping[level] = false;
  }
  return handled;
}

/**
 * Force a compaction pass ahead of the background scheduler: write a `queued`
 * job and put it on the queue. `by` is recorded as `requested_by`; `repo`
 * scopes the pass (and its FIFO group) to one repository. The returned view
 * reads through to the row, so the caller watches it run.
 */
export async function compactNow(level: CompactableLevel, by: string, repo: string | null = null): Promise<CompactionJob> {
  compactSeq += 1;
  // The mock id restarts at comp-91 with the process, which is harmless in
  // memory and a primary-key collision in distillation_compactions: a restart
  // would upsert over the previous run's record. With Aurora, the id carries
  // the queue time so it is unique across restarts.
  const jobId = config.mock.aurora
    ? `comp-9${compactSeq}`
    : `comp-${clock.now().getTime().toString(36)}-${compactSeq}`;
  const now = clock.nowIso();
  const row: CompactionJobRow = {
    id: jobId,
    level,
    startedAt: now,
    finishedAt: null,
    status: 'queued',
    queuedAt: now,
    ...(repo ? { repo } : {}),
    requestedBy: by,
    phase: 'queued',
    percent: 0,
    stepLabel: null,
    attempts: 0,
    log: [{ at: now, level: 'info', message: `Queued on ${COMPACTION_QUEUES[level]} by ${by}${repo ? ` for ${repo}` : ''}.` }],
  };
  jobRows().unshift(row);
  announce(row);

  try {
    await enqueueCompaction(level, { job_id: jobId, level, repo });
  } catch (err) {
    row.status = 'failed';
    row.finishedAt = clock.nowIso();
    row.phase = 'failed';
    row.percent = null;
    row.error = `Could not put the pass on ${COMPACTION_QUEUES[level]}: ${(err as Error).message}`;
    appendLog(row, 'error', row.error);
    announce(row);
    throw new AppError(503, row.error);
  }

  // The synchronous seam: with the in-process queue and no run window, drain
  // the queue before answering so a test sees the finished pass — through the
  // real send → receive → run → ack path, not around it.
  if (compactRunMs <= 0 && compactionQueue() instanceof MemoryMessageQueue) {
    while ((await pumpCompactionQueue(level)) > 0) { /* drain */ }
  }
  return jobView(row);
}

let consumerStop: (() => void) | null = null;

/**
 * The consumer loop, started once at boot (index.ts). In-process queue: wake
 * on every send, plus a slow sweep for redeliveries whose lease expired.
 * message-queue over HTTP: one long-poll loop per queue, backing off on error.
 */
export function startCompactionConsumer(): () => void {
  if (consumerStop) return consumerStop;
  const q = compactionQueue();
  const levelsToRun: CompactableLevel[] = ['L1', 'L2'];
  let stopped = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const pumpSoon = (level: CompactableLevel): void => {
    const t = setTimeout(() => { void pumpCompactionQueue(level).catch((err: unknown) => console.warn(`[distill] ${level} consumer:`, (err as Error).message)); }, 0);
    t.unref?.();
  };

  if (q instanceof MemoryMessageQueue) {
    const off = q.onSend((queue) => {
      const level = levelsToRun.find((l) => COMPACTION_QUEUES[l] === queue);
      if (level) pumpSoon(level);
    });
    const sweep = setInterval(() => levelsToRun.forEach(pumpSoon), 5_000);
    sweep.unref?.();
    consumerStop = () => { stopped = true; off(); clearInterval(sweep); consumerStop = null; };
    return consumerStop;
  }

  for (const level of levelsToRun) {
    let backoffMs = 1_000;
    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          await pumpCompactionQueue(level, 10);
          backoffMs = 1_000;
        } catch (err) {
          console.warn(`[distill] ${level} consumer: ${(err as Error).message} — retrying in ${backoffMs}ms`);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    };
    void loop();
  }
  consumerStop = () => { stopped = true; timers.forEach(clearTimeout); consumerStop = null; };
  return consumerStop;
}

/**
 * Re-enqueue passes on a cadence. L1 every DISTILL_COMPACT_INTERVAL_MIN, L2 at
 * DISTILL_COMPACT_L2_INTERVAL_MIN (default 6× the L1 cadence). Off when the L1
 * interval is unset or 0. A level with a pass already queued or running is
 * skipped, so a slow consumer never accumulates a pile of identical passes.
 */
export function startCompactionScheduler(): (() => void) | null {
  const l1Min = Number(process.env['DISTILL_COMPACT_INTERVAL_MIN'] ?? 0);
  if (!Number.isFinite(l1Min) || l1Min <= 0) return null;
  const l2Min = Number(process.env['DISTILL_COMPACT_L2_INTERVAL_MIN'] ?? l1Min * 6);
  const tick = (level: CompactableLevel): void => {
    const open = jobRows().some((j) => j.level === level && (j.status === 'queued' || j.status === 'running'));
    if (open) return;
    void compactNow(level, 'scheduler').catch((err: unknown) => console.warn(`[distill] scheduled ${level} pass:`, (err as Error).message));
  };
  const t1 = setInterval(() => tick('L1'), l1Min * 60_000);
  const t2 = setInterval(() => tick('L2'), Math.max(1, l2Min) * 60_000);
  t1.unref?.();
  t2.unref?.();
  console.log(`[distill] compaction scheduler: L1 every ${l1Min} min, L2 every ${l2Min} min`);
  return () => { clearInterval(t1); clearInterval(t2); };
}

// ─── Navigable knowledge: items, lineage, artifacts, facts, review ─────────
//
// The compaction machine above answers "is the pipeline healthy". This half
// answers the question the goal doc says the old page couldn't: open one L2
// artifact, see which observations and clusters it came from, check a fact
// against its evidence, and reach the Library asset the artifact became.
// Mock-first like the rest of this module — Aurora path documented as
// notMocked below rather than implemented against a table that doesn't
// carry these rows yet (schema/distillation_schema.sql exists but nothing
// reads it live).

/** A level-tagged item — the discriminated shape /items and /items/:id
 *  return, so the portal renders one list/detail component keyed on `level`
 *  instead of three separate response shapes. */
export type DistillationItem =
  | ({ level: 'L0' } & Observation)
  | ({ level: 'L1' } & Cluster)
  | ({ level: 'L2' } & Artifact);

export interface ListItemsQuery {
  level?: Level;
  repo?: string;
  initiative?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface ListItemsResult {
  items: DistillationItem[];
  /** How many rows the filtered query matches, before paging — counted from
   *  the same filtered list the page is sliced from. */
  total: number;
  next_cursor: string | null;
}

function tagObservation(o: Observation): DistillationItem { return { level: 'L0', ...o }; }
function tagCluster(c: Cluster): DistillationItem { return { level: 'L1', ...c }; }
function tagArtifact(a: Artifact): DistillationItem { return { level: 'L2', ...a }; }

function allItems(level?: Level): DistillationItem[] {
  if (level === 'L0') return observationRows().map(tagObservation);
  if (level === 'L1') return clusterRows().map(tagCluster);
  if (level === 'L2') return artifactsOnWire().map(tagArtifact);
  return [
    ...observationRows().map(tagObservation),
    ...clusterRows().map(tagCluster),
    ...artifactsOnWire().map(tagArtifact),
  ];
}

/** An artifact carries no repo/initiative of its own (docs/distillation-goal.md
 *  — it's downstream of clusters, which do); derive it from the first linked
 *  cluster so `repo=`/`initiative=` filtering still reaches L2 items. */
function repoOf(item: DistillationItem): string | undefined {
  if (item.level === 'L2') {
    const c = clusterRows().find((cl) => item.cluster_ids.includes(cl.id));
    return c?.repo;
  }
  return item.repo;
}
function initiativeOf(item: DistillationItem): string | undefined {
  if (item.level === 'L2') {
    const c = clusterRows().find((cl) => item.cluster_ids.includes(cl.id));
    return c?.initiative_id;
  }
  return item.initiative_id;
}

function searchableText(item: DistillationItem): string {
  if (item.level === 'L0') return [item.title, item.body, ...item.tags].join(' ');
  if (item.level === 'L1') return [item.title, item.summary, ...item.tags].join(' ');
  return [item.title, item.summary, item.body_markdown].join(' ');
}

function encodeCursor(id: string): string { return Buffer.from(id, 'utf8').toString('base64url'); }
function decodeCursor(cursor: string): string | null {
  try { return Buffer.from(cursor, 'base64url').toString('utf8'); } catch { return null; }
}

/** The filters /items and /facets share, so a facet count is the number of
 *  rows /items would return with that value selected. */
function filteredItems(q: Omit<ListItemsQuery, 'limit' | 'cursor'>): DistillationItem[] {
  let items = allItems(q.level);
  if (q.repo) items = items.filter((i) => repoOf(i) === q.repo);
  if (q.initiative) items = items.filter((i) => initiativeOf(i) === q.initiative);
  const term = (q.q ?? '').trim().toLowerCase();
  if (term) items = items.filter((i) => searchableText(i).toLowerCase().includes(term));
  return items;
}

export async function listItems(q: ListItemsQuery = {}): Promise<ListItemsResult> {
  simulateIngest();
  // Every row the query matches. filteredItems builds a fresh array, so it is
  // sorted in place; `total` is its length — the whole match, not the page.
  const matched = filteredItems(q);

  // Stable order: newest first, id as the tiebreak — required for a cursor
  // to mean anything across repeated calls with unchanged data.
  matched.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));

  let start = 0;
  if (q.cursor) {
    const afterId = decodeCursor(q.cursor);
    const idx = afterId ? matched.findIndex((i) => i.id === afterId) : -1;
    start = idx >= 0 ? idx + 1 : 0;
  }
  const limit = q.limit ?? 50;
  const page = matched.slice(start, start + limit);
  const next_cursor = start + limit < matched.length && page.length > 0
    ? encodeCursor(page[page.length - 1]!.id)
    : null;
  return { items: page, total: matched.length, next_cursor };
}

export interface FacetValue { value: string; label: string; count: number }
export interface Facets { repos: FacetValue[]; initiatives: FacetValue[]; kinds: FacetValue[] }

/** The kind a row is filtered by: an observation's/cluster's kind, an
 *  artifact's type. */
function kindOf(item: DistillationItem): string {
  return item.level === 'L2' ? item.type : item.kind;
}

/** Initiative display names come from the initiatives the org graph already
 *  runs (providers/projects.ts), loaded lazily so the distillation suites do
 *  not drag that module's dependency tree into every import. */
async function initiativeLabel(id: string): Promise<string> {
  try {
    const { mockProjectName } = await import('./projects.js');
    return mockProjectName(id) ?? id;
  } catch {
    return id;
  }
}

/**
 * GET /facets?level — every repo, initiative and kind present in a level,
 * each with the number of rows /items returns when it is selected. Counted
 * from the rows, sorted by count then label, never a stored list: a facet
 * that is not in the data cannot appear, and one that is cannot be missed.
 */
export async function listFacets(level?: Level): Promise<Facets> {
  simulateIngest();
  const items = filteredItems(level ? { level } : {});
  const tally = async (key: (i: DistillationItem) => string | undefined, label: (v: string) => string | Promise<string>): Promise<FacetValue[]> => {
    const counts = countBy(items.flatMap((i) => { const v = key(i); return v ? [{ v }] : []; }), 'v');
    const out = await Promise.all([...counts].map(async ([value, count]) => ({ value, label: await label(value), count })));
    return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  return {
    repos: await tally(repoOf, (r) => r.split('/').pop() ?? r),
    initiatives: await tally(initiativeOf, initiativeLabel),
    kinds: await tally(kindOf, (k) => k),
  };
}

export async function getItem(id: string): Promise<DistillationItem | null> {
  const o = observationRows().find((x) => x.id === id);
  if (o) return tagObservation(o);
  const c = clusterRows().find((x) => x.id === id);
  if (c) return tagCluster(c);
  const a = artifactsOnWire().find((x) => x.id === id);
  if (a) return tagArtifact(a);
  return null;
}

// ── Lineage ──────────────────────────────────────────────────────────────

function nodeForObservation(o: Observation): LineageNode {
  return {
    id: o.id, kind: 'observation', label: o.title,
    meta: { obsKind: o.kind, repo: o.repo, initiative_id: o.initiative_id, session_id: o.session_id, created_at: o.created_at },
  };
}
function nodeForSession(sessionId: string): LineageNode {
  const sample = observationRows().find((o) => o.session_id === sessionId);
  return {
    id: sessionId, kind: 'session', label: `Session ${sessionId}`,
    meta: sample ? { repo: sample.repo, box_id: sample.box_id } : {},
  };
}
function nodeForCluster(c: Cluster): LineageNode {
  return {
    id: c.id, kind: 'cluster', label: c.title,
    meta: { clusterKind: c.kind, repo: c.repo, initiative_id: c.initiative_id, confidence: c.confidence, memberCount: c.member_observation_ids.length },
  };
}
function nodeForArtifact(a: Artifact): LineageNode {
  return {
    id: a.id, kind: 'artifact', label: a.title,
    meta: { artifactType: a.type, status: a.status, library_item_id: a.library_item_id },
  };
}
function nodeForFact(f: Fact): LineageNode {
  return {
    id: f.id, kind: 'fact', label: f.statement,
    meta: { subject: f.subject, predicate: f.predicate, object: f.object, confidence: f.confidence, ordinal: f.ordinal },
  };
}
/** A run of a procedure. `subtitle` is what the portal's LineageFrame already
 *  reads under a node label, so a run shows its box and age without a
 *  frame change. */
function nodeForApplication(p: ProcedureApplication): LineageNode {
  return {
    id: p.id, kind: 'application', label: `${p.outcome} · ${p.session_id}`,
    meta: {
      outcome: p.outcome, applied_at: p.applied_at, session_id: p.session_id, box_id: p.box_id,
      failed_at_step_id: p.failed_at_step_id,
      // No age here: the portal formats `applied_at` with its one shared
      // relativeTime, and a second formatter baked in server-side read a
      // different number beside the ledger a few lines away.
      subtitle: p.box_id,
    },
  };
}
async function nodeForLibraryItem(id: string): Promise<LineageNode> {
  const asset = await getAsset(id);
  return {
    id, kind: 'library_item', label: asset?.name ?? id,
    meta: asset ? { kind: asset.kind, tier: asset.tier, status: asset.lifecycleStatus } : {},
  };
}

interface GraphEdge { from: string; to: string; relation: LineageRelation; }

/** The whole knowledge graph's adjacency, built fresh per call (the mock
 *  corpus is small — tens of nodes — so there's no reason to cache this). */
function buildAdjacency(): Map<string, Array<{ id: string; edge: GraphEdge }>> {
  const adj = new Map<string, Array<{ id: string; edge: GraphEdge }>>();
  const link = (from: string, to: string, relation: LineageRelation): void => {
    const edge: GraphEdge = { from, to, relation };
    if (!adj.has(from)) adj.set(from, []);
    if (!adj.has(to)) adj.set(to, []);
    adj.get(from)!.push({ id: to, edge });
    adj.get(to)!.push({ id: from, edge });
  };
  for (const o of observationRows()) link(o.id, o.session_id, 'written_by');
  for (const c of clusterRows()) for (const oid of c.member_observation_ids) link(oid, c.id, 'merged_into');
  for (const a of artifactRows()) for (const cid of a.cluster_ids) link(cid, a.id, 'distilled_into');
  for (const f of factRows()) {
    link(f.id, f.artifact_id, 'supports');
    for (const oid of f.evidence_observation_ids) link(oid, f.id, 'supports');
  }
  for (const a of artifactsOnWire()) if (a.library_item_id) link(a.id, a.library_item_id, 'published_as');
  for (const app of applicationRows()) link(app.procedure_id, app.id, 'applied_in');
  return adj;
}

async function resolveNode(id: string): Promise<LineageNode> {
  const o = observationRows().find((x) => x.id === id);
  if (o) return nodeForObservation(o);
  const c = clusterRows().find((x) => x.id === id);
  if (c) return nodeForCluster(c);
  const a = artifactsOnWire().find((x) => x.id === id);
  if (a) return nodeForArtifact(a);
  const f = factRows().find((x) => x.id === id);
  if (f) return nodeForFact(f);
  if (artifactsOnWire().some((x) => x.library_item_id === id)) return nodeForLibraryItem(id);
  // Before the session fallback: an id nothing else claims is treated as a
  // session, so an unchecked application id would render as "Session
  // papp-001" with empty meta rather than as the run it is.
  const app = applicationRows().find((x) => x.id === id);
  if (app) return nodeForApplication(app);
  return nodeForSession(id);
}

/** BFS out from `startId` up to `depth` hops across the whole knowledge
 *  graph (observation <-> session, observation <-> cluster, cluster <->
 *  artifact, evidence-observation <-> fact <-> artifact, artifact <->
 *  library item). Returns an empty graph for an id with no edges at all
 *  rather than throwing — the route layer already 404s an unknown id before
 *  this is called. */
export async function buildLineage(startId: string, depth: number): Promise<Lineage> {
  const adj = buildAdjacency();
  if (!adj.has(startId)) return { nodes: [], edges: [] };

  const visitedNodes = new Set<string>([startId]);
  const visitedEdges = new Map<string, GraphEdge>();
  let frontier = [startId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { id: neighborId, edge } of adj.get(id) ?? []) {
        const key = `${edge.from}|${edge.to}|${edge.relation}`;
        if (!visitedEdges.has(key)) visitedEdges.set(key, edge);
        if (!visitedNodes.has(neighborId)) { visitedNodes.add(neighborId); next.push(neighborId); }
      }
    }
    frontier = next;
  }

  const nodes = await Promise.all([...visitedNodes].map((id) => resolveNode(id)));
  return { nodes, edges: [...visitedEdges.values()] };
}

/** GET /items/:id/lineage — any level, caller-chosen depth. */
export async function lineageFor(id: string, depth: number): Promise<Lineage> {
  return buildLineage(id, depth);
}

/** Can `/items/:id/lineage` be rooted here? Items, and the run nodes the
 *  `applied_in` edge makes reachable from every procedure — "Focus here" on
 *  a run used to 404 because getItem only knows the three tiers. */
export async function isLineageRoot(id: string): Promise<boolean> {
  if (await getItem(id)) return true;
  return applicationRows().some((p) => p.id === id);
}

/** GET /facts/:id/lineage — a fixed, generous depth so a fact's evidence
 *  observations, its artifact, that artifact's clusters and its published
 *  Library item all show up without the caller having to guess a depth. */
export async function factLineage(id: string): Promise<Lineage> {
  return buildLineage(id, 3);
}

// ── Artifacts, review, library provenance ───────────────────────────────

export interface ListArtifactsQuery {
  status?: ArtifactStatus;
  type?: ArtifactType;
  q?: string;
}

export async function listArtifacts(q: ListArtifactsQuery = {}): Promise<Artifact[]> {
  let items = artifactsOnWire();
  if (q.status) items = items.filter((a) => a.status === q.status);
  if (q.type) items = items.filter((a) => a.type === q.type);
  const term = (q.q ?? '').trim().toLowerCase();
  if (term) items = items.filter((a) => [a.title, a.summary, a.body_markdown].join(' ').toLowerCase().includes(term));
  return items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface ListReviewQuery {
  verdict?: ReviewVerdict;
}

/** What a sample is ABOUT, resolved server-side so the queue never shows a
 *  bare `cl-022`. `kind` is the sample's target_kind; `type` is the
 *  artifact's type or the cluster's observation kind. */
export interface ReviewTarget {
  id: string;
  kind: ReviewTargetKind;
  type: string;
  title: string;
  repo: string | null;
  source_count: number;
}

export type ReviewSampleView = ReviewSample & { target: ReviewTarget | null; target_error?: string };

async function resolveReviewTarget(sample: ReviewSample): Promise<Pick<ReviewSampleView, 'target' | 'target_error'>> {
  const item = await getItem(sample.target_id);
  const expected = sample.target_kind === 'artifact' ? 'L2' : 'L1';
  if (!item || item.level !== expected) {
    return { target: null, target_error: `${sample.target_kind} ${sample.target_id} could not be found — it may have been re-distilled or removed since it was sampled.` };
  }
  const sources = await itemSources(item.id);
  return {
    target: {
      id: item.id,
      kind: sample.target_kind,
      type: kindOf(item),
      title: item.title,
      repo: repoOf(item) ?? null,
      source_count: sources?.length ?? 0,
    },
  };
}

export async function listReview(q: ListReviewQuery = {}): Promise<ReviewSampleView[]> {
  let items = reviewRows().slice();
  if (q.verdict) items = items.filter((r) => r.verdict === q.verdict);
  items.sort((a, b) => b.sampled_at.localeCompare(a.sampled_at));
  return Promise.all(items.map(async (r) => ({ ...r, ...(await resolveReviewTarget(r)) })));
}

/** The counts `distill:review` pushes after any sample change — counted from
 *  the same store `/review` lists. */
export function reviewCounts(): { pending: number; decided: number } {
  const byVerdict = countBy(reviewRows(), 'verdict');
  const pending = byVerdict.get('pending') ?? 0;
  return { pending, decided: reviewRows().length - pending };
}

/**
 * pending -> agree|disagree. A sample already decided 409s rather than
 * silently overwriting a prior verdict — same "don't let a second call
 * quietly clobber a decision" posture as promotions' approve/reject.
 */
export async function decideReview(
  id: string, input: { verdict: 'agree' | 'disagree'; note?: string | null }, by: string,
): Promise<ReviewSample> {
  const sample = reviewRows().find((r) => r.id === id);
  if (!sample) throw new NotFoundError(`review sample ${id} not found`);
  if (sample.verdict !== 'pending') {
    throw new AppError(409, `review sample ${id} was already decided (${sample.verdict})`);
  }
  sample.verdict = input.verdict;
  sample.note = input.note ?? null;
  sample.reviewer = by;
  distillationEvents.emit('review');
  return sample;
}

/**
 * POST /artifacts/:id/publish — draft -> published, the one status move this
 * domain lets a person make by hand (retiring or drafting-again has no route
 * yet, same "ship exactly what was asked for" posture as everything else on
 * this floor). Already-published or retired 409s rather than silently
 * no-opping or re-stamping `updated_at` — same "don't let a second call
 * quietly clobber state" posture as `decideReview`.
 */
export async function publishArtifact(id: string, _by: string): Promise<Artifact> {
  const row = artifactRows().find((a) => a.id === id);
  if (!row) throw new NotFoundError(`artifact ${id} not found`);
  if (row.status === 'published') {
    throw new AppError(409, `artifact ${id} is already published`);
  }
  if (row.status === 'retired') {
    throw new AppError(409, `artifact ${id} is retired — publish only applies to a draft`);
  }
  row.status = 'published';
  row.updated_at = clock.nowIso();
  distillationEvents.emit('artifacts');
  distillationEvents.emit('levels');
  return withLink(row);
}

/**
 * POST /review — add a cluster or artifact to the human sample queue by
 * hand, rather than waiting for the next compaction pass's own sampling. The
 * target must actually exist (an artifact or cluster id that resolves), and
 * a target already carrying a pending sample 409s — same "don't double-queue
 * a decision that hasn't been made yet" posture as `decideReview` refusing a
 * second verdict. `by` is who ASKED for the review, recorded in `note`
 * rather than `reviewer` — `reviewer` means who DECIDED it, and this sample
 * hasn't been decided yet.
 */
export async function sampleForReview(
  targetKind: ReviewTargetKind, targetId: string, by: string,
): Promise<ReviewSample> {
  const exists = targetKind === 'artifact'
    ? artifactRows().some((a) => a.id === targetId)
    : clusterRows().some((c) => c.id === targetId);
  if (!exists) throw new NotFoundError(`${targetKind} ${targetId} not found`);
  const already = reviewRows().find((r) => r.target_kind === targetKind && r.target_id === targetId && r.verdict === 'pending');
  if (already) {
    throw new AppError(409, `${targetKind} ${targetId} already has a pending review sample (${already.id})`);
  }
  reviewSeq += 1;
  const sample: ReviewSample = {
    id: `rev-9${String(reviewSeq).padStart(3, '0')}`,
    target_kind: targetKind,
    target_id: targetId,
    sampled_at: clock.nowIso(),
    reviewer: null,
    verdict: 'pending',
    note: `Requested by ${by}`,
  };
  reviewRows().push(sample);
  distillationEvents.emit('review');
  return sample;
}

/** GET /library/:libraryItemId/provenance — the artifact a Library asset was
 *  distilled from, plus its lineage, or null when the asset wasn't
 *  distilled (hand-authored prompts/skills never link back here). */
export async function libraryProvenance(libraryItemId: string): Promise<{ artifact: Artifact; lineage: Lineage } | null> {
  const artifact = artifactsOnWire().find((a) => a.library_item_id === libraryItemId);
  if (!artifact) return null;
  return { artifact, lineage: await buildLineage(artifact.id, 3) };
}

// ─── Procedures: ordered steps, and whether they still hold ────────────────
//
// A `procedure` artifact is an artifact whose facts carry an ordinal. What
// makes it more than a runbook with numbered lines is that sessions RUN it
// and report back (`procedureApplications`), so the store can say whether
// the steps have been proven recently, have drifted since, or were never
// run at all. Every number on that view is counted here from the
// applications and cluster rows on every read; the health verdict is the
// pure rule procedureHealth above, so a test can hand it a shape and a
// clock and check the sentence it produces.

/** How many UTC days of run history the per-day sparkline covers. */
const APPLIED_WINDOW_DAYS = 14;

export interface ProcedureView {
  /** The wire artifact — first so a capture that wants "the id" finds the
   *  procedure's own before any nested one. */
  artifact: Artifact;
  /** The first linked cluster's repo, the same rule repoOf applies to an L2
   *  item; null for a procedure whose clusters are gone. */
  repo: string | null;
  step_count: number;
  runs: { total: number; succeeded: number; failed: number; abandoned: number };
  last_applied_at: string | null;
  last_succeeded_at: string | null;
  /** The session that last ran it to completion — what "proven by" names. */
  last_succeeded_by: string | null;
  /** Runs per UTC day, APPLIED_WINDOW_DAYS buckets oldest → newest. */
  applied_per_day: number[];
  /** What has happened since the last success (or since the artifact was
   *  minted, when it has never succeeded): failed|abandoned runs, and
   *  failed|gotcha CLUSTERS minted in the same repo. See procedureHealth
   *  for why clusters rather than raw observations. */
  drift: { new_gotcha_clusters: number; failed_runs: number };
  health: ProcedureHealth;
}

const HEALTH_ORDER: Record<ProcedureHealthStatus, number> = { drifting: 0, unproven: 1, proven: 2 };

const isProcedure = (a: Artifact): boolean => a.type === 'procedure';

/** The steps of a procedure, in ordinal order. */
function stepsOf(artifactId: string): Fact[] {
  return factRows()
    .filter((f) => f.artifact_id === artifactId && f.ordinal !== null)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}

function procedureView(artifact: Artifact, nowMs: number): ProcedureView {
  const repo = repoOf(tagArtifact(artifact)) ?? null;
  // Newest first, id DESC on a tie — the SAME order listApplications hands the
  // drawer, so "the latest run" means one thing on both surfaces. "Since the
  // last success" is then a POSITION in this list, not a strict timestamp
  // compare: two runs recorded in one clock tick (or under a frozen clock)
  // would otherwise let a failure hide behind the success it followed.
  const apps = applicationRows()
    .filter((p) => p.procedure_id === artifact.id)
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at) || b.id.localeCompare(a.id));
  const byOutcome = countBy(apps, 'outcome');
  const lastSuccessIdx = apps.findIndex((p) => p.outcome === 'succeeded');
  const lastSuccess = lastSuccessIdx >= 0 ? apps[lastSuccessIdx]! : null;
  const runsSinceSuccess = lastSuccessIdx >= 0 ? apps.slice(0, lastSuccessIdx) : apps;
  const since = lastSuccess?.applied_at ?? artifact.created_at;

  const applied_per_day = new Array<number>(APPLIED_WINDOW_DAYS).fill(0);
  const todayStart = utcDayStartMs(nowMs);
  for (const p of apps) {
    const daysBack = Math.floor((todayStart - utcDayStartMs(Date.parse(p.applied_at))) / DAY_MS);
    if (daysBack >= 0 && daysBack < APPLIED_WINDOW_DAYS) applied_per_day[APPLIED_WINDOW_DAYS - 1 - daysBack] += 1;
  }

  const view: Omit<ProcedureView, 'health'> = {
    artifact,
    repo,
    step_count: stepsOf(artifact.id).length,
    runs: {
      total: apps.length,
      succeeded: byOutcome.get('succeeded') ?? 0,
      failed: byOutcome.get('failed') ?? 0,
      abandoned: byOutcome.get('abandoned') ?? 0,
    },
    last_applied_at: apps[0]?.applied_at ?? null,
    last_succeeded_at: lastSuccess?.applied_at ?? null,
    last_succeeded_by: lastSuccess?.session_id ?? null,
    applied_per_day,
    drift: {
      failed_runs: runsSinceSuccess.filter((p) => p.outcome !== 'succeeded').length,
      new_gotcha_clusters: clusterRows().filter((c) =>
        c.repo === repo && TRIGGER_KINDS.has(c.kind) && c.created_at > since).length,
    },
  };
  return { ...view, health: procedureHealth(view, nowMs) };
}

/** GET /procedures — every procedure artifact, the ones needing attention
 *  first (drifting, then unproven, then proven), most recently run first
 *  within a status, id as the tiebreak so the order is stable across reads. */
export async function listProcedures(): Promise<ProcedureView[]> {
  const nowMs = clock.now().getTime();
  return artifactsOnWire()
    .filter(isProcedure)
    .map((a) => procedureView(a, nowMs))
    .sort((a, b) =>
      HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status]
      || (b.last_applied_at ?? '').localeCompare(a.last_applied_at ?? '')
      || a.artifact.id.localeCompare(b.artifact.id));
}

/** GET /procedures/:id — null for an id that is not a procedure artifact,
 *  including an id that is an artifact of some other type: a runbook has no
 *  steps to prove, so it is a 404 here rather than an empty view. */
export async function getProcedure(id: string): Promise<ProcedureView | null> {
  const artifact = artifactsOnWire().find((a) => a.id === id);
  if (!artifact || !isProcedure(artifact)) return null;
  return procedureView(artifact, clock.now().getTime());
}

/** GET /procedures/:id/applications — newest first. */
export async function listApplications(procedureId: string): Promise<ProcedureApplication[] | null> {
  const artifact = artifactsOnWire().find((a) => a.id === procedureId);
  if (!artifact || !isProcedure(artifact)) return null;
  return applicationRows()
    .filter((p) => p.procedure_id === procedureId)
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at) || b.id.localeCompare(a.id));
}

export interface ApplyProcedureInput {
  outcome: ApplicationOutcome;
  failed_at_step_id?: string | null;
  note?: string | null;
}

/**
 * POST /procedures/:id/apply — a session reporting how a run went. The row
 * lands in the registered applications fixture, so `POST /api/__mock/reset`
 * takes it back and the procedure's counted health returns to the seed —
 * the same posture as decideReview. `failed_at_step_id` is checked against
 * the procedure's own steps: a run cannot fail on a step it does not have,
 * and a succeeded run cannot name one at all.
 */
export async function applyProcedure(
  procedureId: string, input: ApplyProcedureInput, by: { sessionId: string; boxId: string },
): Promise<ProcedureApplication> {
  const artifact = artifactsOnWire().find((a) => a.id === procedureId);
  if (!artifact || !isProcedure(artifact)) throw new NotFoundError(`procedure ${procedureId} not found`);

  const stepId = input.failed_at_step_id ?? null;
  if (input.outcome === 'succeeded' && stepId !== null) {
    throw new ValidationError('failed_at_step_id must be null for a succeeded run');
  }
  if (input.outcome === 'abandoned' && stepId !== null) {
    // Only a FAILED run names the step it stopped on; an abandoned run stopped
    // for a reason outside the procedure, and a step id here would make the
    // drawer blame a step the ledger says was never reached.
    throw new ValidationError('failed_at_step_id must be null for an abandoned run');
  }
  if (input.outcome === 'failed' && stepId === null) {
    throw new ValidationError('failed_at_step_id is required for a failed run');
  }
  if (stepId !== null && !stepsOf(procedureId).some((f) => f.id === stepId)) {
    throw new ValidationError(`failed_at_step_id must be a step (an ordinal-bearing fact) of ${procedureId}`);
  }

  applicationSeq += 1;
  const row: ProcedureApplication = {
    id: `papp-9${String(applicationSeq).padStart(3, '0')}`,
    procedure_id: procedureId,
    session_id: by.sessionId,
    box_id: by.boxId,
    repo: repoOf(tagArtifact(artifact)) ?? '',
    applied_at: clock.nowIso(),
    outcome: input.outcome,
    failed_at_step_id: stepId,
    note: input.note ?? null,
  };
  applicationRows().push(row);
  return row;
}

// ─── Sources, sessions, procedure runs (spec §3a) ─────────────────────────
//
// Sources are an item's DIRECT evidence, one hop down — what the Sources
// inspector lists and a reviewer checks a claim against:
//   L2 guide   → its patterns, then the run notes behind them (the notes its
//                facts cite as evidence, and the patterns' own members)
//   L1 pattern → its member run notes
//   L0 note    → the session that wrote it
// Lineage (`/items/:id/lineage`) is the whole graph; this is the short list.

export type SourceKind = 'cluster' | 'observation' | 'session';

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  timestamp: string;
  excerpt: string;
  session_id?: string;
  repo?: string;
}

const EXCERPT_CHARS = 240;

/** First EXCERPT_CHARS of a body, cut at a word boundary. */
function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = flat.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function sourceFromObservation(o: Observation): Source {
  return { id: o.id, kind: 'observation', title: o.title, timestamp: o.created_at, excerpt: excerptOf(o.body), session_id: o.session_id, repo: o.repo };
}

function sourceFromCluster(c: Cluster): Source {
  return { id: c.id, kind: 'cluster', title: c.title, timestamp: c.created_at, excerpt: excerptOf(c.summary), repo: c.repo };
}

/** The notes one session wrote, oldest first — the order it wrote them. */
function sessionNotes(sessionId: string): Observation[] {
  return observationRows()
    .filter((o) => o.session_id === sessionId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Null for an id no tier knows (the route 404s). */
export async function itemSources(id: string): Promise<Source[] | null> {
  const item = await getItem(id);
  if (!item) return null;
  const byObs = new Map(observationRows().map((o) => [o.id, o]));

  if (item.level === 'L0') {
    const notes = sessionNotes(item.session_id);
    return [{
      id: item.session_id,
      kind: 'session',
      title: `Session ${item.session_id}`,
      timestamp: notes[0]?.created_at ?? item.created_at,
      excerpt: `${plural(notes.length, 'run note')} written in ${item.repo} on ${item.box_id}.`,
      session_id: item.session_id,
      repo: item.repo,
    }];
  }

  if (item.level === 'L1') {
    return item.member_observation_ids
      .flatMap((oid) => { const o = byObs.get(oid); return o ? [sourceFromObservation(o)] : []; });
  }

  const patterns = clusterRows().filter((c) => item.cluster_ids.includes(c.id));
  const cited = factRows().filter((f) => f.artifact_id === item.id).flatMap((f) => f.evidence_observation_ids);
  const noteIds = [...new Set([...cited, ...patterns.flatMap((c) => c.member_observation_ids)])];
  const notes = noteIds
    .flatMap((oid) => { const o = byObs.get(oid); return o ? [o] : []; })
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return [...patterns.map(sourceFromCluster), ...notes.map(sourceFromObservation)];
}

export interface SessionRecord {
  id: string;
  repo: string | null;
  box_id: string | null;
  initiative_id: string | null;
  /** The session's first note — when it started writing, as far as the store
   *  can see. */
  started_at: string | null;
  last_at: string | null;
  /** True when the session is in the live write stream right now. */
  writing: boolean;
  notes: Observation[];
}

/** GET /sessions/:id — a run-note session, or null when neither a note nor a
 *  live writer names it. */
export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  simulateIngest();
  const notes = sessionNotes(sessionId);
  const writer = writerRows().find((w) => w.session_id === sessionId);
  if (notes.length === 0 && !writer) return null;
  const first = notes[0];
  return {
    id: sessionId,
    repo: first?.repo ?? writer?.repo ?? null,
    box_id: first?.box_id ?? writer?.box_id ?? null,
    initiative_id: first?.initiative_id ?? writer?.initiative_id ?? null,
    started_at: first?.created_at ?? null,
    last_at: notes[notes.length - 1]?.created_at ?? null,
    writing: Boolean(writer),
    notes,
  };
}

export type StepStatus = 'done' | 'failed' | 'pending' | 'skipped';

export interface ProcedureRun {
  id: string;
  at: string;
  /** The session that ran it. */
  actor: string;
  box_id: string;
  outcome: ApplicationOutcome;
  note: string | null;
  failed_at_step_id: string | null;
  /** One entry per step, in order. A success marks every step done; a failure
   *  marks the steps before it done, its own step failed and the rest pending
   *  (never reached). An abandoned run recorded no step, so every step reads
   *  pending — the ledger cannot say how far it got, and a guess would blame
   *  or credit a step for something nobody saw. */
  steps: Array<{ step_id: string; status: StepStatus }>;
}

/** GET /procedures/:id/runs — newest first; null for a non-procedure id. */
export async function procedureRuns(procedureId: string): Promise<ProcedureRun[] | null> {
  const apps = await listApplications(procedureId);
  if (!apps) return null;
  const steps = stepsOf(procedureId);
  return apps.map((p) => {
    const failedIdx = p.failed_at_step_id ? steps.findIndex((f) => f.id === p.failed_at_step_id) : -1;
    return {
      id: p.id,
      at: p.applied_at,
      actor: p.session_id,
      box_id: p.box_id,
      outcome: p.outcome,
      note: p.note,
      failed_at_step_id: p.failed_at_step_id,
      steps: steps.map((f, i): { step_id: string; status: StepStatus } => {
        if (p.outcome === 'succeeded') return { step_id: f.id, status: 'done' };
        if (p.outcome === 'failed' && failedIdx >= 0) {
          return { step_id: f.id, status: i < failedIdx ? 'done' : i === failedIdx ? 'failed' : 'pending' };
        }
        return { step_id: f.id, status: 'pending' };
      }),
    };
  });
}

// ─── The L2 read replica (lib/distillation-replica.ts) ────────────────────

let replica: L2Replica | null = null;

/** The one L2 replica this process keeps, fed from the artifacts store. */
export function l2Replica(): L2Replica {
  if (!replica) {
    replica = new L2Replica({ primaryRows: () => artifactRows(), now: () => clock.now().getTime() });
  }
  return replica;
}

/** GET /replication — the replica's digest against the primary's. */
export async function replicationStatus(): Promise<ReplicationStatus> {
  return l2Replica().status();
}

let replicaStop: (() => void) | null = null;

/**
 * Start anti-entropy: one sweep now, the syncer's own interval after that,
 * and a debounced sweep whenever L2 changes. A sweep that repaired anything
 * announces a levels change (spec §3d: levels are pushed on replica sync).
 */
export function startReplicaSync(intervalMs = 15_000): () => void {
  if (replicaStop) return replicaStop;
  const r = new L2Replica({ primaryRows: () => artifactRows(), now: () => clock.now().getTime(), intervalMs });
  replica = r;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const sweep = (): void => {
    void r.sync()
      .then((res) => { if (res.keysRepaired > 0) distillationEvents.emit('levels'); })
      .catch((err: unknown) => console.warn('[distill] replica sync:', (err as Error).message));
  };
  const onChange = (): void => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; sweep(); }, 250);
    pending.unref?.();
  };
  distillationEvents.on('artifacts', onChange);
  sweep();
  // Our own interval rather than the syncer's start(): the syncer's timer
  // discards each sweep's result, and the repaired count is what /replication
  // reports.
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  replicaStop = () => {
    distillationEvents.off('artifacts', onChange);
    if (pending) clearTimeout(pending);
    clearInterval(timer);
    replicaStop = null;
  };
  return replicaStop;
}

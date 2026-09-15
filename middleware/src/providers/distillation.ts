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
// Aurora path: lab_experiences exists (schema/lab_loop_schema.sql) but there
// is no compaction-job or level-rollup table yet — mock-first, same as
// promotions.ts and design-reviews.ts.

import { config } from '../config.js';
import { NotFoundError, AppError, ValidationError } from '../lib/async-handler.js';
import { clock, countBy, groupBy, sumBy, utcDayStartMs, DAY_MS } from '../mock/core/index.js';
import { getAsset } from './prompt-library.js';
import {
  observations as observationsFx, clusters as clustersFx, artifacts as artifactsFx,
  facts as factsFx, libraryLinks as libraryLinksFx, compactionJobs as compactionJobsFx,
  reviewSamples as reviewSamplesFx, ingestWriters as ingestWritersFx,
  procedureApplications as procedureApplicationsFx, distillationFixtures,
  type Observation, type Cluster, type Artifact, type ArtifactRow, type Fact, type ReviewSample,
  type CompactionJobRow, type IngestWriter, type ProcedureApplication, type ApplicationOutcome,
  type ObservationKind, type ArtifactStatus, type ArtifactType, type ReviewTargetKind, type ReviewVerdict,
  type Level, type CompactionStatus,
  type Lineage, type LineageNode, type LineageEdge, type LineageRelation,
} from '../mock/distillation.js';

export type {
  Observation, Cluster, Artifact, ArtifactRow, Fact, ReviewSample,
  ArtifactStatus, ArtifactType, ReviewTargetKind, ReviewVerdict, Lineage, LineageNode, LineageEdge,
  Level, CompactionStatus, CompactionJobRow, IngestWriter, ProcedureApplication, ApplicationOutcome,
} from '../mock/distillation.js';

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
  bytesReclaimed: number;
  costUsd: number;
  error?: string;
  /** What this pass actually made, so a job row can open it: the L1 clusters
   *  or L2 artifacts it created. A failed job (comp-104) produces neither —
   *  its inputs are untouched in the level below, not silently consumed. */
  produced: { cluster_ids: string[]; artifact_ids: string[] };
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
      return {
        level: lvl.level,
        status: 'stalled',
        reason: hoursSince == null
          ? `${lvl.level} has ${lvl.items} items waiting and no compaction has ever run against it — trigger one by hand.`
          : `${lvl.level} has ${lvl.items} items waiting and no compaction has run against it in ${hoursSince}h — trigger one by hand before the backlog grows further.`,
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

/** The wire artifact: the stored row plus its Library link. */
function withLink(row: ArtifactRow): Artifact {
  return { ...row, library_item_id: libraryLinkFor(row.id) };
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
  }
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
  ingestSeq = 0;
  ingestLastTick = clock.now().getTime();
  compactSeq = 0;
  clusterSeq = 0;
  artifactSeq = 0;
  factSeq = 0;
  applicationSeq = 0;
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

export async function ingest(): Promise<IngestState> {
  simulateIngest();
  const writers = writerRows();
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
  let rows = jobRows().slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (opts.level) rows = rows.filter((j) => j.level === opts.level);
  if (opts.status) rows = rows.filter((j) => j.status === opts.status);
  return rows.map(jobView);
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
function runL1Compaction(jobId: string, startedAt: string): void {
  const pending = pendingObservations()
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
function runL2Compaction(jobId: string, startedAt: string): void {
  const pending = pendingClusters()
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
        status: 'draft',
        reviewed_by: null,
        reviewed_at: null,
        created_by_compaction_id: jobId,
        created_at: startedAt,
        updated_at: startedAt,
      };
      artifactRows().push(artifact);
    }
  }
}

/**
 * Force a compaction pass ahead of the background scheduler. Unlike the
 * fabricated-counter version this replaced, this one really compacts: an L1
 * pass merges every not-yet-clustered observation into new clusters, an L2
 * pass distils every not-yet-referenced cluster into new draft artifacts —
 * so the level cards, /items, and lineage all agree immediately afterward.
 * `by` is accepted for the route's audit trail, same convention as
 * design-reviews.ts's signoff `byName` and promotions' `approvedBy`.
 */
// How long a hand-triggered pass stays `running` before it completes. The
// audit saw every Compact resolve to `succeeded` in the same response — no
// observable running state, so the page had nothing to show while the
// machine "worked". 0 completes synchronously (the test seam).
let compactRunMs = 3_000;
export function __setCompactRunMs(ms: number): void { compactRunMs = ms; }

/**
 * The pass runs, and the job row records only that it finished. Every number
 * it "produced" is counted afterwards from the rows it pushed — and so is the
 * level's lag, which is now the age of whatever is still waiting rather than a
 * watermark this function has to remember to reset. An empty pass therefore
 * needs no special case: nothing was consumed, so nothing about the backlog
 * changed, and nothing here has to claim otherwise.
 */
function completeCompaction(row: CompactionJobRow, level: CompactableLevel): void {
  if (level === 'L1') runL1Compaction(row.id, row.startedAt);
  else runL2Compaction(row.id, row.startedAt);
  row.status = 'succeeded';
  row.finishedAt = clock.nowIso();
}

export async function compactNow(level: CompactableLevel, by: string): Promise<CompactionJob> {
  void by;
  compactSeq += 1;
  const jobId = `comp-9${compactSeq}`;

  // The job is `running` first: the corpus changes and the produced ids land
  // when it completes, so a page polling /compactions sees the pass happen.
  // The view handed back reads through to this row, so a caller holding it
  // watches the pass finish instead of a snapshot of it starting.
  const row: CompactionJobRow = {
    id: jobId,
    level,
    startedAt: clock.nowIso(),
    finishedAt: null,
    status: 'running',
  };
  jobRows().unshift(row);

  if (compactRunMs <= 0) {
    completeCompaction(row, level);
  } else {
    const timer = setTimeout(() => completeCompaction(row, level), compactRunMs);
    timer.unref?.();
  }
  return jobView(row);
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

export async function listItems(q: ListItemsQuery = {}): Promise<ListItemsResult> {
  simulateIngest();
  let items = allItems(q.level);
  if (q.repo) items = items.filter((i) => repoOf(i) === q.repo);
  if (q.initiative) items = items.filter((i) => initiativeOf(i) === q.initiative);
  const term = (q.q ?? '').trim().toLowerCase();
  if (term) items = items.filter((i) => searchableText(i).toLowerCase().includes(term));

  // Stable order: newest first, id as the tiebreak — required for a cursor
  // to mean anything across repeated calls with unchanged data.
  items = items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));

  let start = 0;
  if (q.cursor) {
    const afterId = decodeCursor(q.cursor);
    const idx = afterId ? items.findIndex((i) => i.id === afterId) : -1;
    start = idx >= 0 ? idx + 1 : 0;
  }
  const limit = q.limit ?? 50;
  const page = items.slice(start, start + limit);
  const next_cursor = start + limit < items.length && page.length > 0
    ? encodeCursor(page[page.length - 1]!.id)
    : null;
  return { items: page, next_cursor };
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
      subtitle: `${p.box_id} · ${ageLabel(p.applied_at, clock.now().getTime())}`,
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

export async function listReview(q: ListReviewQuery = {}): Promise<ReviewSample[]> {
  let items = reviewRows().slice();
  if (q.verdict) items = items.filter((r) => r.verdict === q.verdict);
  return items.sort((a, b) => b.sampled_at.localeCompare(a.sampled_at));
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
  const apps = applicationRows()
    .filter((p) => p.procedure_id === artifact.id)
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at) || a.id.localeCompare(b.id));
  const byOutcome = countBy(apps, 'outcome');
  const lastSuccess = apps.find((p) => p.outcome === 'succeeded') ?? null;
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
      failed_runs: apps.filter((p) => p.outcome !== 'succeeded' && p.applied_at > since).length,
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

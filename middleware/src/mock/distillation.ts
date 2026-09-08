// Distillation knowledge domain — L0 observations, L1 clusters, L2 artifacts,
// the facts an artifact stands on, the human review sample, the compaction
// jobs that produced all of it, and the write stream feeding L0.
//
// providers/distillation.ts models the LSM-tree OPERATIONAL view (level
// sizes, lag, compaction jobs, the sample-rate dial). Everything it reports
// is COUNTED from the rows below — this module exports rows and nothing else.
// It is on the fixture floor (mock/core/contract.ts, docs/mock-floor.md), so
// three rules hold structurally rather than by good intentions:
//
//   1. No typed aggregate. There is no `items`, no `inputItems`, no
//      `dedupedItems`, no `agreementRatePct` and no `share` anywhere in this
//      file. This domain shipped that bug twice — tier cards reading
//      950/180/40 above lists holding 69/22/8, and a review-calibration
//      banner reading fixed constants so deciding one sample made the
//      headline contradict the queue beneath it. A count that lives next to
//      its rows is right the day it is written and wrong the first time
//      either side moves, so the counts live in the provider's selectors and
//      the rows live here.
//   2. Every timestamp comes from `clock` at READ time. The old module wrote
//      `Date.now() - h * 3_600_000` at module scope, so "30 hours ago" meant
//      thirty hours before the process booted — a dev server up for a day
//      drifted the whole corpus out of the story it tells.
//   3. Every collection is a scenario-switchable fixture, so an auditor asks
//      for an empty or a high-volume world (`POST /api/__mock/scenario`)
//      instead of mutating shared state and warning the next auditor.
//
// The corpus tells one consistent story across the four initiatives the org
// graph already runs (schema/seed_program.sql): p-observability (repo
// orgiq-observability), p-auth-migration (orgiq-auth-service), p-llm-platform
// (orgiq-llm-platform) and p-cost-opt (orgiq-finops). 22 clusters group the
// observations written across 9 sessions; the rest are an unclustered backlog
// for compactNow('L1') to actually compact — which is also what L1's lag is
// measured against. 8 artifacts are distilled from a subset of those
// clusters, 5 of them published into REAL Library assets
// (providers/prompt-library.ts MOCK_ASSETS — skill-flaky-test-triage,
// skill-cold-start-aurora, insight-arm64-fargate, lib-csrf-check,
// lib-pii-scan) via the library-links fixture, 2 still draft, 1 retired. 12
// facts cite real observation ids as evidence. The review samples give the
// human sample queue a real backlog and a real history.
//
// L0 observations mirror `lab_experiences` (schema/lab_loop_schema.sql) —
// same kind enum, same shape — but live here rather than reading the real
// table: mock-first, same posture as every other domain in this file. L1
// (clusters) and L2 (artifacts/facts) are new, additive concepts with no
// Aurora table yet outside schema/distillation_schema.sql.

import { clock, defineFixture } from './core/index.js';

// ─── Types (the domain model — docs/distillation-goal.md) ──────────────────

/** L0 write head, L1 deduped clusters, L2 distilled artifacts. */
export type Level = 'L0' | 'L1' | 'L2';

export type CompactionStatus = 'running' | 'succeeded' | 'failed';

export type ObservationKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';

export interface Observation {
  id: string;
  session_id: string;
  box_id: string;
  repo: string;
  initiative_id: string;
  kind: ObservationKind;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

export interface Cluster {
  id: string;
  title: string;
  summary: string;
  kind: ObservationKind;
  repo: string;
  initiative_id: string;
  tags: string[];
  member_observation_ids: string[];
  confidence: number;
  created_by_compaction_id: string;
  created_at: string;
  updated_at: string;
}

export type ArtifactType = 'runbook' | 'insight' | 'convention' | 'decision';
export type ArtifactStatus = 'draft' | 'published' | 'retired';

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  summary: string;
  body_markdown: string;
  cluster_ids: string[];
  /** Fact ids — resolve each via factLineage/getItem, never inlined here, so
   *  a fact has exactly one representation. */
  facts: string[];
  /** The Library asset this artifact was published as, or null. NOT stored on
   *  the row: it is looked up in the library-links fixture when the provider
   *  composes the wire artifact, so "which artifacts are published" is one
   *  table an auditor can empty rather than a field repeated eight times. */
  library_item_id: string | null;
  status: ArtifactStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by_compaction_id: string;
  created_at: string;
  updated_at: string;
}

/** The stored half of an artifact — everything except the Library link. */
export type ArtifactRow = Omit<Artifact, 'library_item_id'>;

/** artifact → Library asset. One row per published artifact, no row for a
 *  draft: `library_item_id: null` on the wire is the ABSENCE of a row here,
 *  never a stored null. */
export interface LibraryLink {
  artifact_id: string;
  library_item_id: string;
}

export interface Fact {
  id: string;
  artifact_id: string;
  statement: string;
  subject: string;
  predicate: string;
  object: string;
  evidence_observation_ids: string[];
  confidence: number;
}

export type ReviewTargetKind = 'cluster' | 'artifact';
export type ReviewVerdict = 'pending' | 'agree' | 'disagree';

export interface ReviewSample {
  id: string;
  target_kind: ReviewTargetKind;
  target_id: string;
  sampled_at: string;
  reviewer: string | null;
  verdict: ReviewVerdict;
  note: string | null;
}

/**
 * A compaction pass, as STORED: when it ran, whether it worked, and nothing
 * it could have been asked to count. What it produced is not written down
 * here either — a cluster/artifact names the job that made it
 * (`created_by_compaction_id`), so `produced`, `inputItems`, `outputItems`,
 * `dedupedItems`, `bytesReclaimed` and `costUsd` are all counted back out of
 * the corpus by the provider. A job row that claimed "outputItems: 62" while
 * naming four produced clusters is exactly the drift this floor exists to
 * make impossible.
 */
export interface CompactionJobRow {
  id: string;
  /** The level this job merged INTO — L0→L1 jobs are tagged 'L1', L1→L2 jobs
   *  are tagged 'L2'. Nothing ever compacts into L0. */
  level: Level;
  startedAt: string;
  finishedAt: string | null;
  status: CompactionStatus;
  /** Why a failed pass failed. The provider appends the input count it can
   *  see, so the sentence can never quote a number the corpus disagrees with. */
  error?: string;
  /** For a failed pass: the job that re-merged its inputs. Its produced rows
   *  are what this one had consumed when it aborted, which is how a failed
   *  job reports a real input count while producing nothing. */
  retriedBy?: string;
}

/**
 * One agent session writing into L0 right now. `activeWriters`,
 * `observationsPerHour` and the `topRepos` shares on the wire are all counted
 * from these rows — the old fixture typed all three, and its repo shares
 * named two repos (`aws-agentcore`, `orgiq-stream-analytics`) that no
 * observation in the corpus was ever written against.
 */
export interface IngestWriter {
  id: string;
  session_id: string;
  box_id: string;
  repo: string;
  initiative_id: string;
  /** This writer's own rate. The fleet rate is the sum, never a typed total. */
  observationsPerHour: number;
  /** What this writer is currently producing — the template simulated ingest
   *  mints from, so a minted observation's repo/session/initiative are the
   *  writer's own rather than a second, unrelated table's. */
  writes: Pick<Observation, 'kind' | 'title' | 'body' | 'tags'>;
}

export type LineageNodeKind = 'observation' | 'session' | 'cluster' | 'artifact' | 'fact' | 'library_item';
export type LineageRelation = 'written_by' | 'merged_into' | 'distilled_into' | 'supports' | 'published_as';

export interface LineageNode {
  id: string;
  kind: LineageNodeKind;
  label: string;
  meta: Record<string, unknown>;
}

export interface LineageEdge {
  from: string;
  to: string;
  relation: LineageRelation;
}

export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

// ─── The seed corpus ─────────────────────────────────────────────────────────
//
// Every builder below is a FACTORY, called on first read and again on every
// reset (fixture floor rule 3: an array literal at module scope bakes its
// timestamps at import). Ids are positional, never drawn from a module-level
// counter — a counter that keeps incrementing across `reset()` hands the same
// seed row a different id on the second read, and half this corpus points at
// its neighbours by id.

const REPO = {
  OBS: 'connorhoehnslalom/orgiq-observability',
  AUTH: 'connorhoehnslalom/orgiq-auth-service',
  LLM: 'connorhoehnslalom/orgiq-llm-platform',
  COST: 'connorhoehnslalom/orgiq-finops',
} as const;

const INITIATIVE = {
  OBS: 'p-observability',
  AUTH: 'p-auth-migration',
  LLM: 'p-llm-platform',
  COST: 'p-cost-opt',
} as const;

/** The 25 seed observation groups, keyed by the cluster each became. The
 *  cluster and fact builders take these groups rather than ids typed a
 *  second time, so a member id cannot point at an observation that is not
 *  there — and the ids stay identical across a reset because `seq` is local
 *  to the call, not a module-level counter. */
type ObservationGroups = Record<'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C19' | 'C20' | 'C7' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12' | 'C13' | 'C14' | 'C15' | 'C22' | 'C16' | 'C17' | 'C18' | 'C21' | 'NEW1' | 'NEW2' | 'NEW3', Observation[]>;

function seedObservationGroups(): ObservationGroups {
  let seq = 0;
  const mkObs = (
    session: string, box: string, repo: string, initiative: string,
    kind: ObservationKind, title: string, body: string, tags: string[], hAgo: number,
  ): Observation => {
    seq += 1;
    return {
      id: `obs-${String(seq).padStart(3, '0')}`,
      session_id: session, box_id: box, repo, initiative_id: initiative,
      kind, title, body, tags, created_at: clock.hoursAgo(hAgo),
    };
  };

  // ── Observability (repo orgiq-observability, initiative p-observability) ──

  const C1 = [
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Gateway+agent OTel topology handles peak ingest at 2x headroom',
      'Deploying gateway collectors in front of per-host agents let us buffer bursts without dropping spans; load-tested at 2x current peak.',
      ['otel', 'rollout'], 30.3),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'decision',
      'Route all OTLP through the collector fleet, not straight to the backend',
      'Sending spans directly from services bypassed sampling and rate limiting; routing everything through the fleet gives us one throttle point.',
      ['otel', 'architecture'], 30.1),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Canary one gateway collector before fleet-wide rollout',
      'Running one gateway collector as a canary for 24h caught a memory leak in an early build before it reached the whole fleet.',
      ['otel', 'rollout', 'canary'], 29.8),
  ];

  const C2 = [
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'decision',
      'Tail-sample everything except errors and p99+ latency',
      "A flat 10% head sample was dropping the traces engineers actually needed during an incident; tail sampling that always keeps errors and slow requests fixed that at a fraction of the storage cost.",
      ['otel', 'sampling'], 29.5),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Sampling decision waits for the whole trace, not the first span',
      "Buffering spans until the trace closes (or a timeout) is what makes an errors-and-p99 policy possible — a per-span decision can't see the outcome yet.",
      ['otel', 'sampling'], 29.2),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'A trace that never closes pins memory in the tail sampler',
      'A stuck downstream call held a trace open indefinitely; added a hard timeout so an incomplete trace still gets flushed and sampled on its partial data.',
      ['otel', 'sampling', 'gotcha'], 28.9),
  ];

  const C3 = [
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Span-metrics connector derives RED metrics straight from spans',
      'Rate/errors/duration dashboards now come from the same OTel pipeline as traces — no separate StatsD emission to keep in sync.',
      ['otel', 'metrics'], 28.5),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'decision',
      'Emit span metrics from the collector, not from application code',
      "Computing RED metrics in the collector means every service gets them for free once it's on OTLP, instead of each team wiring up its own metrics client.",
      ['otel', 'metrics', 'decision'], 28.1),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'convention',
      "Every dashboard panel names its source span's operation name",
      "Panels that only said 'latency' with no operation name were unreadable once ten services shared one dashboard; now every panel title includes the span name it's built from.",
      ['otel', 'dashboards', 'convention'], 27.7),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Span-metrics cardinality capped by dropping high-cardinality attributes at the connector',
      'Including user_id as a metric dimension exploded cardinality; stripping high-cardinality attributes before the metrics connector keeps the series count bounded.',
      ['otel', 'metrics', 'cardinality'], 27.3),
  ];

  const C4 = [
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'failed',
      'Collector OOM-killed during a burst ingest spike',
      'An unbounded in-memory batch queue let a traffic spike from a redeploy storm grow until the collector pod was OOM-killed, dropping every span it held.',
      ['otel', 'incident'], 27.0),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      "A batch processor with no queue limit is not backpressure, it's a memory leak waiting for a spike",
      "The batch processor's default config has no size cap — under normal load that never shows, under a burst it's the difference between throttling and crashing.",
      ['otel', 'gotcha'], 26.6),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Bounded queue + drop-oldest policy survives the same burst without OOMing',
      'Capping the batch queue and dropping the oldest spans under pressure keeps the collector alive; losing old spans during a spike beats losing the collector.',
      ['otel', 'fix'], 26.2),
  ];

  const C5 = [
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'convention',
      "Retire StatsD emission per service, only after its OTel dashboards are trusted",
      'Cutting a service over to OTel-only before its dashboards were validated against the old StatsD numbers left a blind gap during the switch; now the StatsD emitter stays until the new dashboards are signed off.',
      ['statsd', 'decom'], 25.8),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'decision',
      'Keep the StatsD bridge running dual-write during the transition window',
      'Dual-writing to both StatsD and OTel for two sprints per service gave on-call a fallback dashboard if the new pipeline had gaps.',
      ['statsd', 'decom', 'decision'], 25.4),
    mkObs('sess-obs-02', 'box-obs-02', REPO.OBS, INITIATIVE.OBS, 'worked',
      'A decommission checklist per service prevents an alert going dark silently',
      "One service's alerting rule referenced the StatsD metric directly; the checklist now requires re-pointing every alert before that service's StatsD emitter is removed.",
      ['statsd', 'decom', 'checklist'], 25.0),
  ];

  const C6 = [
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'decision',
      'Page on burn rate against the SLO, not a raw error-count threshold',
      "A flat 'more than 50 errors/min' threshold paged during normal traffic peaks and stayed silent during a slow-burning outage on a low-traffic service; burn rate against each service's own SLO fixes both.",
      ['slo', 'alerting'], 24.6),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Multi-window burn-rate alerts catch both fast and slow burns',
      'A fast 5-minute window catches a sharp outage; a slower 1-hour window catches the same budget being eaten gradually. Running both avoids paging on noise from the fast window alone.',
      ['slo', 'alerting'], 24.2),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'A service with no traffic reports a 0% error rate that means nothing',
      'Burn-rate math divides by request volume; a dead service scores a perfect error rate right up until someone notices no requests are landing at all — added a floor on minimum traffic before burn-rate suppresses a raw-volume alert.',
      ['slo', 'gotcha'], 23.8),
    mkObs('sess-obs-01', 'box-obs-01', REPO.OBS, INITIATIVE.OBS, 'convention',
      'Every SLO gets one burn-rate alert pair, defined in the same PR as the SLO',
      'SLOs that shipped without their alert pair went unmonitored for weeks; the convention now ties them together in one review.',
      ['slo', 'convention'], 23.4),
  ];

  const C19 = [
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'Collector integration tests pass alone, flake in parallel CI',
      'Two integration tests bound to the same local port only collided when CI ran them in parallel; sequential runs never reproduced it.',
      ['testing', 'ci', 'flaky'], 9.4),
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Rerun twice and diff the two outcomes before filing a flake as a real bug',
      'Rerunning a suspected-flaky test twice and diffing the failures separates a genuine regression from port contention — quarantining without that check hid a real regression once already.',
      ['testing', 'ci', 'runbook'], 9.1),
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'failed',
      'Quarantining a flaky test without evidence hid a real regression for seed value handling',
      "A test disabled as 'known flaky' was actually catching a real seed-value bug that shipped for a week before someone looked at the diff.",
      ['testing', 'ci', 'gotcha'], 8.8),
  ];

  const C20 = [
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'failed',
      'Collector Fargate task replaced in a loop: exec format error',
      'An x86_64 image on an ARM64 task definition failed its entrypoint immediately; ECS kept replacing the task, masking the real cause behind churn.',
      ['fargate', 'arm64', 'incident'], 8.5),
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'Fargate defaults to x86_64 unless runtimePlatform pins ARM64',
      'Building on Apple Silicon produces an ARM64 image; without an explicit runtimePlatform the task definition still defaults to x86_64 and the mismatch only shows at container start.',
      ['fargate', 'arm64', 'gotcha'], 8.2),
    mkObs('sess-obs-03', 'box-obs-03', REPO.OBS, INITIATIVE.OBS, 'worked',
      'Pinning runtimePlatform to ARM64 is also the cheaper Fargate option',
      "Once the task definition pinned ARM64 explicitly, the collector fleet also got Fargate's ARM64 pricing discount for free.",
      ['fargate', 'arm64', 'cost'], 7.9),
  ];

  // ── Auth migration (repo orgiq-auth-service, initiative p-auth-migration) ──

  const C7 = [
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'Authorization-code + PKCE through a BFF keeps the browser holding only one cookie',
      'Doing the OIDC dance server-side and minting our own session cookie means the browser never sees Cognito tokens directly.',
      ['auth', 'oidc'], 22.9),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'decision',
      'Resolve the OrgIQ user by external_sub first, email second',
      "Matching on the IdP's stable subject claim first, and only falling back to email on first login, avoids re-linking a user if their email changes upstream.",
      ['auth', 'decision'], 22.5),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'The BFF mints the same signed session cookie SSO or not',
      "Keeping one session format regardless of login path means grants, masquerade and Cedar checks don't need an SSO-specific branch anywhere downstream.",
      ['auth', 'sso'], 22.1),
  ];

  const C8 = [
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'decision',
      'Add session_epoch so a tenant/role switch can invalidate old cookies',
      "A stateless signed cookie can't be revoked directly; bumping a stored epoch and rejecting any cookie below it closes the replay window within one refresh cycle.",
      ['auth', 'session'], 21.7),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'Grants refresh every 120s is the practical bound on the replay window',
      'The session middleware’s periodic grants refresh is also where the epoch check runs, so 120s becomes the real-world ceiling on how long a stale cookie survives.',
      ['auth', 'session'], 21.3),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'gotcha',
      'Masquerade must not bump the epoch or it kicks out the person being masqueraded',
      "Bumping epoch on masquerade would invalidate the target user's own live sessions the moment an admin looked at their account; masquerade carries the target's epoch instead.",
      ['auth', 'masquerade', 'gotcha'], 20.9),
  ];

  const C9 = [
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'gotcha',
      'Cognito rejects a non-localhost http callback URL outright',
      'Setting COGNITO_CALLBACK_URL to the deployed middleware’s plain http origin failed at the Cognito side before our code ever ran.',
      ['auth', 'cognito', 'gotcha'], 20.5),
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'decision',
      'Leave the callback unset until an HTTPS origin exists, keep the picker as fallback',
      'Rather than block the whole auth stack on a certificate, the stack leaves COGNITO_CALLBACK_URL unset so the demo picker still works until HTTPS is ready.',
      ['auth', 'decision'], 20.1),
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'Local dev sets the callback to localhost, which Cognito exempts from the HTTPS rule',
      'Cognito’s own docs carve out localhost, so local SSO testing works without a cert while staging/prod need a real HTTPS front door.',
      ['auth', 'local'], 19.7),
  ];

  const C10 = [
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'convention',
      "Cut each tenant over to Cognito on its own schedule, not all at once",
      "A single flag-day cutover risks every tenant's login breaking together if the new path has a bug; tenant-by-tenant migration limits the blast radius to one tenant at a time.",
      ['auth', 'migration', 'convention'], 19.3),
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'decision',
      'Zero forced logouts is a hard requirement for each tenant’s cutover',
      'Existing sessions must keep working through the cutover — the migration plan explicitly forbids a change that logs an active tenant out mid-day.',
      ['auth', 'migration', 'decision'], 18.9),
    mkObs('sess-auth-02', 'box-auth-02', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'A per-tenant feature flag lets support flip a tenant back to SAML if the cutover misbehaves',
      'Keeping the SAML shim reachable behind a flag, instead of deleting it per tenant, turned one early cutover bug into a five-minute rollback instead of an incident.',
      ['auth', 'migration'], 18.5),
  ];

  const C11 = [
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'An LLM evaluator flags CSRF-weakening diffs before a human reviewer sees them',
      'Running every auth-service PR diff through the CSRF evaluator catches token-check removals immediately, instead of relying on a reviewer to notice a missing check in a large diff.',
      ['auth', 'csrf', 'evaluator'], 18.1),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'decision',
      'The CSRF evaluator runs as a pipeline gate, not just an advisory comment',
      'Early on the evaluator only left a comment; PRs still merged with the flagged risk. Making it a required check is what actually stopped a weakening change.',
      ['auth', 'csrf', 'decision'], 17.7),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'gotcha',
      "The evaluator's diff input must stay fenced as untrusted, never inlined into the prompt as instructions",
      "A diff containing text that looked like an instruction ('ignore previous checks') needed to be treated as data the evaluator judges, not as a directive it follows.",
      ['auth', 'csrf', 'gotcha'], 17.3),
    mkObs('sess-auth-01', 'box-auth-01', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'Two sign-offs before promoting the evaluator to endpoint tier',
      'Because the evaluator can block a merge, it went through the same two-signoff design-review gate as any other endpoint-tier asset before it was trusted to run on every PR.',
      ['auth', 'csrf', 'governance'], 16.9),
  ];

  // ── LLM platform (repo orgiq-llm-platform, initiative p-llm-platform) ──

  const C12 = [
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'worked',
      'Agents read their system prompt from Prompt Management on every invocation',
      'A 60-second cache means a Prompt Studio edit reaches the deployed fleet in about a minute, with no image rebuild and no redeploy.',
      ['llm', 'prompts'], 16.5),
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'decision',
      'Fall back to the SYSTEM_PROMPT literal only when the library is unreachable',
      'A hardcoded fallback string means a Bedrock outage degrades an agent to its last-known-good prompt instead of failing every invocation.',
      ['llm', 'prompts', 'decision'], 16.1),
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'worked',
      'Traces record the resolved prompt sha, not just the prompt name',
      'Recording which exact version served a request is what let us tell which prompt edit caused a quality regression, instead of guessing from the timestamp.',
      ['llm', 'observability'], 15.7),
  ];

  const C13 = [
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'failed',
      'Un-paginated ListPrompts call returned only the first page of prompts',
      'The catalog looked complete with a handful of prompts and silently dropped every prompt past the first page — no error, just missing rows.',
      ['llm', 'pagination', 'gotcha'], 15.3),
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'worked',
      "Looping on nextToken until it's empty surfaces the full prompt catalog",
      'Adding the pagination loop (capped at a sane max page count) is what made the library page show every prompt Bedrock actually has.',
      ['llm', 'pagination'], 14.9),
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'convention',
      'Any Bedrock list API in this codebase must be paginated by convention, not by memory',
      'This was the second list-truncation bug found the same way; the convention now gets called out explicitly in review for any new Bedrock list call.',
      ['llm', 'convention'], 14.5),
  ];

  const C14 = [
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'decision',
      'Attach the role-specific guardrail at model-build time, not a single global one',
      'A member and an hr-admin need different guardrails; resolving the role first and attaching its guardrail when the model is built keeps one supervisor Agent object correct for both.',
      ['llm', 'guardrail', 'decision'], 14.1),
    mkObs('sess-llm-01', 'box-llm-01', REPO.LLM, INITIATIVE.LLM, 'worked',
      'Caching one Agent per (tenant, role) avoids rebuilding the model on every request',
      'Since the guardrail and system prompt are both role-scoped, caching by (tenant, role) means only a role switch pays the rebuild cost, not every message.',
      ['llm', 'performance'], 13.7),
  ];

  const C15 = [
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'convention',
      'LLM-as-judge config (model, rubric weights, sample rate) is one SSM parameter, not code',
      'Keeping the judge config in SSM instead of hardcoded means the eval rubric can change without a deploy, and it’s editable from /iq/evaluations.',
      ['llm', 'canary', 'convention'], 12.9),
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'decision',
      'Online evaluation needs both enableEval and enableOnlineEvalConfig context flags',
      'The config resource requires its own exec role and ServiceNames, so it’s a second explicit flag rather than riding along with enableEval automatically.',
      ['llm', 'canary', 'decision'], 12.5),
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'worked',
      'Reading judge_config on every canary ask instead of caching it keeps a rubric edit effective immediately',
      'An earlier cached version of the judge config meant a rubric-weight fix took up to an hour to take effect; reading it fresh removed that lag.',
      ['llm', 'canary'], 12.1),
  ];

  const C22 = [
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'convention',
      'Run the PII evaluator on a document before ingestion, not after',
      'Scanning post-ingestion meant a flagged document had already been embedded and indexed; scanning first means a flagged document never enters the KB pipeline at all.',
      ['llm', 'pii', 'convention'], 11.7),
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'worked',
      'The PII evaluator flags, a human decides — it never auto-redacts',
      "Auto-redaction risked silently mangling a legitimate document; the evaluator's job is to flag for a human reviewer, not to rewrite content on its own.",
      ['llm', 'pii'], 11.3),
    mkObs('sess-llm-02', 'box-llm-02', REPO.LLM, INITIATIVE.LLM, 'decision',
      'PII scanning runs at internal tier, not endpoint — no external caller reaches it directly',
      "Because the ingestion pipeline is the only caller, the evaluator didn't need the two-signoff endpoint-tier bar; internal tier matched its actual blast radius.",
      ['llm', 'pii', 'decision'], 10.9),
  ];

  // ── Cost optimization (repo orgiq-finops, initiative p-cost-opt) ──

  const C16 = [
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'worked',
      'Per-initiative cost showback made an idle-teardown case approvable',
      "Nobody would sign off on tearing down a cluster from a vague 'it's expensive' — attributing the dollar figure to the specific initiative that owned it got the decision made in one meeting.",
      ['finops', 'showback'], 40.2),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'decision',
      'Every dollar of infra and agent spend must be attributable to an initiative, no shared bucket',
      "A shared 'infra' cost line hid which initiative was actually paying for idle capacity; the decision was to eliminate the unattributed bucket entirely.",
      ['finops', 'decision'], 39.8),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'convention',
      'A teardown proposal names the floor it removes and the initiative it was billed to',
      "The proposal template now requires both numbers up front, so an approver isn't chasing them down before they can say yes.",
      ['finops', 'convention'], 39.4),
  ];

  const C17 = [
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'gotcha',
      'OpenSearch Serverless bills 2 OCU minimum even fully idle',
      'A collection with zero search traffic still billed for its 2 OCU floor around the clock — there is no scale-to-zero tier.',
      ['finops', 'opensearch', 'gotcha'], 39.0),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'worked',
      'Budget alarm on OpenSearch is load-bearing, not decorative, because of the OCU floor',
      "Since idle OpenSearch cost can't be optimized away by traffic shaping, the budget alarm is the only thing that catches a forgotten collection before the bill does.",
      ['finops', 'opensearch'], 38.6),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'decision',
      'Consolidate low-traffic collections onto one OpenSearch domain instead of one each',
      'Three near-idle collections each paying the 2 OCU floor cost more than one shared domain sized for their combined traffic.',
      ['finops', 'opensearch', 'decision'], 38.2),
  ];

  const C18 = [
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'gotcha',
      'Aurora Serverless v2 never scales below 0.5 ACU, roughly $45/mo idle',
      'Unlike Lambda-style scale-to-zero, the minimum ACU floor bills continuously even when nothing is querying the cluster.',
      ['finops', 'aurora', 'gotcha'], 37.8),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'worked',
      'Pre-draining the cluster before stack teardown avoids paying the floor after the workload is gone',
      'A destroy script that skips draining Aurora leaves the floor billing until someone notices the cluster is still there with nothing using it.',
      ['finops', 'aurora'], 37.4),
    mkObs('sess-cost-01', 'box-cost-01', REPO.COST, INITIATIVE.COST, 'decision',
      'Treat the ACU floor as a fixed cost line in the initiative budget, not a variable one',
      'Trying to optimize away a fixed floor wastes effort; the budget model now books it as fixed so the showback number is honest instead of noisy.',
      ['finops', 'aurora', 'decision'], 37.0),
  ];

  const C21 = [
    mkObs('sess-cost-02', 'box-cost-02', REPO.COST, INITIATIVE.COST, 'failed',
      'First Data API call to a cold 0.5-ACU cluster failed with HttpEndpointNotEnabled',
      'A script running right after a teardown/rebuild hit the Data API before the endpoint had finished enabling, and failed immediately with no retry.',
      ['finops', 'aurora', 'gotcha'], 10.4),
    mkObs('sess-cost-02', 'box-cost-02', REPO.COST, INITIATIVE.COST, 'worked',
      'A warm-up SELECT 1 before the real query, plus 6x3s retry, clears the cold-start race',
      'Retrying the same transient error six times with a 3-second backoff — after one throwaway warm-up query — reliably gets past the cold-start window.',
      ['finops', 'aurora', 'runbook'], 10.0),
    mkObs('sess-cost-02', 'box-cost-02', REPO.COST, INITIATIVE.COST, 'convention',
      'Genuine SQL errors still fail loud — only the known transient errors get retried',
      "Retrying every failure blindly would hide a real syntax error behind six pointless retries; the retry list is scoped to the specific transient exception names.",
      ['finops', 'aurora', 'convention'], 9.6),
  ];

  // ── Unclustered backlog ──
  // Fresh writes that have landed at L0 but haven't been picked up by an
  // L0->L1 merge yet — every other observation above is already a cluster
  // member, which left compactNow('L1') nothing real to do. These stay
  // unclustered until a compaction pass runs against them, which is exactly
  // the write-head-ahead-of-compaction state the level cards are supposed to
  // be able to show honestly.
  const NEW1 = [
    mkObs('sess-obs-04', 'box-obs-04', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'Span-metrics connector under-counts a burst when the flush interval is too coarse',
      'A 60s flush interval smoothed over a 10s traffic spike on the RED dashboard; halving the interval kept it responsive to short bursts.',
      ['otel', 'metrics', 'gotcha'], 0.6),
    mkObs('sess-obs-04', 'box-obs-04', REPO.OBS, INITIATIVE.OBS, 'gotcha',
      'A collector restart during a rolling deploy drops its in-flight batch silently',
      'Rolling collector pods one at a time still loses whatever batch was buffered at restart; a graceful-drain hook is the fix, not yet clustered with the queue-limit work.',
      ['otel', 'gotcha'], 0.4),
  ];
  const NEW2 = [
    mkObs('sess-auth-03', 'box-auth-03', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'Per-tenant Cognito app clients keep each tenant’s callback allowlist short',
      'Splitting one shared app client into one per tenant means each tenant’s callback list stays auditable instead of growing into one shared list nobody reviews.',
      ['auth', 'cognito'], 0.5),
    mkObs('sess-auth-03', 'box-auth-03', REPO.AUTH, INITIATIVE.AUTH, 'worked',
      'A per-tenant Cognito client also isolates a misconfigured redirect to one tenant',
      'When one tenant’s redirect URI was briefly wrong, only that tenant’s login broke — a shared client would have taken every tenant down together.',
      ['auth', 'cognito'], 0.3),
  ];
  const NEW3 = [
    mkObs('sess-cost-03', 'box-cost-03', REPO.COST, INITIATIVE.COST, 'decision',
      'Tag every ad-hoc Bedrock eval run with the initiative footing the bill',
      'Untagged eval runs were showing up as unattributed spend at month end; tagging at invocation time closes that gap before showback needs to guess.',
      ['finops', 'decision'], 0.7),
    mkObs('sess-cost-03', 'box-cost-03', REPO.COST, INITIATIVE.COST, 'decision',
      'Cap eval-run concurrency per initiative so one team can’t starve the shared budget alarm',
      'A single initiative running unattended evals at full concurrency could trip the account-wide budget alarm before anyone else’s spend even registered.',
      ['finops', 'decision'], 0.2),
  ];

  return { C1, C2, C3, C4, C5, C6, C19, C20, C7, C8, C9, C10, C11, C12, C13, C14, C15, C22, C16, C17, C18, C21, NEW1, NEW2, NEW3 };
}

/** L0, in write order. */
function seedObservations(): Observation[] {
  const g = seedObservationGroups();
  return [
    ...g.C1, ...g.C2, ...g.C3, ...g.C4, ...g.C5, ...g.C6,
    ...g.C19, ...g.C20, ...g.C7, ...g.C8, ...g.C9, ...g.C10,
    ...g.C11, ...g.C12, ...g.C13, ...g.C14, ...g.C15, ...g.C22,
    ...g.C16, ...g.C17, ...g.C18, ...g.C21, ...g.NEW1, ...g.NEW2,
    ...g.NEW3,
  ];
}

// ─── Clusters (L1) ─────────────────────────────────────────────────────────
// `created_by_compaction_id` points at a real CompactionJobRow id below, and
// the provider counts each job's output back out of THESE rows — so a job
// can never claim to have produced more clusters than name it.

function seedClusters(groups: ObservationGroups): Cluster[] {
  return [
    {
      id: 'cl-001',
      title: 'Collector fleet gateway+agent topology rolls out without an ingest gap',
      summary: 'Gateway collectors buffering in front of per-host agents absorb bursts; canarying one collector for 24h catches regressions before fleet-wide rollout.',
      kind: 'worked', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['otel', 'rollout'],
      member_observation_ids: groups.C1.map((o) => o.id),
      confidence: 0.91, created_by_compaction_id: 'comp-101',
      created_at: clock.hoursAgo(0.3), updated_at: clock.hoursAgo(0.3),
    },
    {
      id: 'cl-002',
      title: 'Tail-sampling policy always keeps errors and p99 latency',
      summary: 'Tail sampling that waits for the whole trace, with a timeout so a stuck trace still flushes, keeps every error and slow request at a fraction of head-sampling storage cost.',
      kind: 'decision', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['otel', 'sampling'],
      member_observation_ids: groups.C2.map((o) => o.id),
      confidence: 0.88, created_by_compaction_id: 'comp-101',
      created_at: clock.hoursAgo(0.3), updated_at: clock.hoursAgo(0.3),
    },
    {
      id: 'cl-003',
      title: 'Span-metrics connector feeds RED dashboards, no separate metrics pipeline',
      summary: 'Deriving RED metrics from spans at the collector — with high-cardinality attributes stripped and every panel naming its span — replaces a hand-wired StatsD metrics path.',
      kind: 'worked', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['otel', 'metrics'],
      member_observation_ids: groups.C3.map((o) => o.id),
      confidence: 0.86, created_by_compaction_id: 'comp-101',
      created_at: clock.hoursAgo(0.3), updated_at: clock.hoursAgo(0.3),
    },
    {
      id: 'cl-004',
      title: 'Collector OOMs under burst ingest when the queue is unbounded',
      summary: 'An unbounded batch queue OOM-killed the collector during a redeploy-storm spike; a bounded queue with drop-oldest survives the same burst.',
      kind: 'failed', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['otel', 'incident'],
      member_observation_ids: groups.C4.map((o) => o.id),
      confidence: 0.93, created_by_compaction_id: 'comp-101',
      created_at: clock.hoursAgo(0.3), updated_at: clock.hoursAgo(0.3),
    },
    {
      id: 'cl-005',
      title: 'StatsD decommission goes service by service, never in one cutover',
      summary: 'Dual-writing StatsD and OTel per service until its dashboards are trusted, with a checklist that re-points every alert first, avoids a silent monitoring gap.',
      kind: 'convention', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['statsd', 'decom'],
      member_observation_ids: groups.C5.map((o) => o.id),
      confidence: 0.84, created_by_compaction_id: 'comp-102',
      created_at: clock.hoursAgo(1.5), updated_at: clock.hoursAgo(1.5),
    },
    {
      id: 'cl-006',
      title: 'Alert on error-budget burn rate, not raw error count',
      summary: 'Multi-window burn-rate alerts against each SLO catch both fast and slow outages, with a minimum-traffic floor so a dead service can’t look healthy.',
      kind: 'decision', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['slo', 'alerting'],
      member_observation_ids: groups.C6.map((o) => o.id),
      confidence: 0.89, created_by_compaction_id: 'comp-102',
      created_at: clock.hoursAgo(1.5), updated_at: clock.hoursAgo(1.5),
    },
    {
      id: 'cl-019',
      title: 'Flaky collector-fleet tests only fail under parallel CI runs',
      summary: 'Port contention across parallel integration tests looks like a flake; rerunning twice and diffing outcomes is what tells a real regression apart from CI noise.',
      kind: 'gotcha', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['testing', 'ci', 'flaky'],
      member_observation_ids: groups.C19.map((o) => o.id),
      confidence: 0.87, created_by_compaction_id: 'comp-102',
      created_at: clock.hoursAgo(1.5), updated_at: clock.hoursAgo(1.5),
    },
    {
      id: 'cl-020',
      title: 'Collector-fleet Fargate tasks are ARM64, x86 dies with exec format error',
      summary: 'An Apple-Silicon-built image on an unpinned Fargate task definition fails immediately at container start; pinning runtimePlatform to ARM64 fixes it and is also the cheaper option.',
      kind: 'gotcha', repo: REPO.OBS, initiative_id: INITIATIVE.OBS,
      tags: ['fargate', 'arm64'],
      member_observation_ids: groups.C20.map((o) => o.id),
      confidence: 0.95, created_by_compaction_id: 'comp-103',
      created_at: clock.hoursAgo(4), updated_at: clock.hoursAgo(4),
    },
    {
      id: 'cl-007',
      title: 'Cognito + BFF OIDC replaces the hosted-UI redirect',
      summary: 'A server-side authorization-code+PKCE flow that mints one signed session cookie, resolving the user by external_sub first, keeps the browser and downstream code unchanged whether SSO or the picker signed the user in.',
      kind: 'worked', repo: REPO.AUTH, initiative_id: INITIATIVE.AUTH,
      tags: ['auth', 'oidc'],
      member_observation_ids: groups.C7.map((o) => o.id),
      confidence: 0.9, created_by_compaction_id: 'comp-103',
      created_at: clock.hoursAgo(4), updated_at: clock.hoursAgo(4),
    },
    {
      id: 'cl-008',
      title: 'session_epoch closes the pre-switch cookie replay window',
      summary: 'Bumping a stored epoch on every tenant/role switch, checked on the periodic grants refresh, invalidates old cookies within about 120 seconds — except masquerade, which deliberately carries the target’s epoch.',
      kind: 'decision', repo: REPO.AUTH, initiative_id: INITIATIVE.AUTH,
      tags: ['auth', 'session'],
      member_observation_ids: groups.C8.map((o) => o.id),
      confidence: 0.92, created_by_compaction_id: 'comp-103',
      created_at: clock.hoursAgo(4), updated_at: clock.hoursAgo(4),
    },
    {
      id: 'cl-009',
      title: 'SSO callback must be HTTPS or Cognito rejects it',
      summary: 'A non-localhost http callback fails at Cognito before any app code runs; the stack leaves the callback unset (keeping the picker) until a real HTTPS origin exists, and exempts localhost for local testing.',
      kind: 'gotcha', repo: REPO.AUTH, initiative_id: INITIATIVE.AUTH,
      tags: ['auth', 'cognito'],
      member_observation_ids: groups.C9.map((o) => o.id),
      confidence: 0.8, created_by_compaction_id: 'comp-105',
      created_at: clock.hoursAgo(11), updated_at: clock.hoursAgo(11),
    },
    {
      id: 'cl-010',
      title: 'Retire the SAML shim tenant by tenant, not in one cutover',
      summary: 'Tenant-by-tenant migration with zero forced logouts, and a per-tenant flag to fall back to SAML, limits a cutover bug’s blast radius to one tenant instead of all of them.',
      kind: 'convention', repo: REPO.AUTH, initiative_id: INITIATIVE.AUTH,
      tags: ['auth', 'migration'],
      member_observation_ids: groups.C10.map((o) => o.id),
      confidence: 0.85, created_by_compaction_id: 'comp-105',
      created_at: clock.hoursAgo(11), updated_at: clock.hoursAgo(11),
    },
    {
      id: 'cl-011',
      title: 'Gate auth diffs on the CSRF evaluator before merge',
      summary: 'An LLM evaluator run as a required PR check — with the diff always treated as untrusted, fenced input — catches CSRF-weakening changes that an advisory-only comment let merge anyway; two sign-offs promoted it to endpoint tier.',
      kind: 'worked', repo: REPO.AUTH, initiative_id: INITIATIVE.AUTH,
      tags: ['auth', 'csrf', 'evaluator'],
      member_observation_ids: groups.C11.map((o) => o.id),
      confidence: 0.94, created_by_compaction_id: 'comp-105',
      created_at: clock.hoursAgo(11), updated_at: clock.hoursAgo(11),
    },
    {
      id: 'cl-012',
      title: 'Prompt Management resolves system prompts at runtime, no rebuild needed',
      summary: 'A 60-second cache means a Prompt Studio edit reaches the fleet in about a minute, with a hardcoded fallback for a Bedrock outage and the resolved prompt sha recorded on every trace.',
      kind: 'worked', repo: REPO.LLM, initiative_id: INITIATIVE.LLM,
      tags: ['llm', 'prompts'],
      member_observation_ids: groups.C12.map((o) => o.id),
      confidence: 0.88, created_by_compaction_id: 'comp-106',
      created_at: clock.hoursAgo(18), updated_at: clock.hoursAgo(18),
    },
    {
      id: 'cl-013',
      title: 'ListPrompts truncates silently without a nextToken',
      summary: 'An un-paginated Bedrock ListPrompts call silently drops every prompt past the first page; looping on nextToken (capped at a max page count) is now a codebase-wide convention for any Bedrock list call.',
      kind: 'gotcha', repo: REPO.LLM, initiative_id: INITIATIVE.LLM,
      tags: ['llm', 'pagination'],
      member_observation_ids: groups.C13.map((o) => o.id),
      confidence: 0.9, created_by_compaction_id: 'comp-106',
      created_at: clock.hoursAgo(18), updated_at: clock.hoursAgo(18),
    },
    {
      id: 'cl-014',
      title: 'Guardrail attaches per resolved role, not globally',
      summary: 'Resolving the role first and attaching its guardrail at model-build time, cached one Agent per (tenant, role), keeps one supervisor object correct for every role without rebuilding on every message.',
      kind: 'decision', repo: REPO.LLM, initiative_id: INITIATIVE.LLM,
      tags: ['llm', 'guardrail'],
      member_observation_ids: groups.C14.map((o) => o.id),
      confidence: 0.86, created_by_compaction_id: 'comp-106',
      created_at: clock.hoursAgo(18), updated_at: clock.hoursAgo(18),
    },
    {
      id: 'cl-015',
      title: 'Canary judge config lives in SSM, edited from the portal',
      summary: 'LLM-as-judge model, rubric weights and sample rate live in one SSM parameter read fresh on every ask, so a rubric edit takes effect immediately with no deploy.',
      kind: 'convention', repo: REPO.LLM, initiative_id: INITIATIVE.LLM,
      tags: ['llm', 'canary'],
      member_observation_ids: groups.C15.map((o) => o.id),
      confidence: 0.83, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
    {
      id: 'cl-016',
      title: 'Idle capacity teardown needs a showback number before anyone will approve it',
      summary: 'Attributing every dollar of spend to the initiative that owns it — with a teardown proposal naming both the floor removed and the initiative billed — is what turns a vague "it’s expensive" into an approvable decision.',
      kind: 'worked', repo: REPO.COST, initiative_id: INITIATIVE.COST,
      tags: ['finops', 'showback'],
      member_observation_ids: groups.C16.map((o) => o.id),
      confidence: 0.87, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
    {
      id: 'cl-017',
      title: 'OpenSearch Serverless bills a 2 OCU minimum regardless of traffic',
      summary: 'A collection with zero traffic still bills its 2 OCU floor continuously; consolidating near-idle collections onto one shared domain, with a load-bearing budget alarm, is the fix.',
      kind: 'gotcha', repo: REPO.COST, initiative_id: INITIATIVE.COST,
      tags: ['finops', 'opensearch'],
      member_observation_ids: groups.C17.map((o) => o.id),
      confidence: 0.92, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
    {
      id: 'cl-018',
      title: "Aurora Serverless v2's 0.5 ACU floor bills even at zero load",
      summary: 'Unlike scale-to-zero compute, Aurora Serverless v2 never drops below its 0.5 ACU floor (~$45/mo); pre-draining before teardown and booking the floor as a fixed budget line keeps the showback number honest.',
      kind: 'gotcha', repo: REPO.COST, initiative_id: INITIATIVE.COST,
      tags: ['finops', 'aurora'],
      member_observation_ids: groups.C18.map((o) => o.id),
      confidence: 0.93, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
    {
      id: 'cl-021',
      title: 'First Aurora Data API call after idle needs a warm SELECT 1 and retry',
      summary: 'The first Data API call to a cold 0.5-ACU cluster fails with HttpEndpointNotEnabled; a throwaway warm-up SELECT 1 plus a scoped 6x3s retry on transient errors clears the race without hiding a genuine SQL error.',
      kind: 'gotcha', repo: REPO.COST, initiative_id: INITIATIVE.COST,
      tags: ['finops', 'aurora'],
      member_observation_ids: groups.C21.map((o) => o.id),
      confidence: 0.91, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
    {
      id: 'cl-022',
      title: 'Scan every ingested document for PII before it reaches the knowledge base',
      summary: 'Running the PII evaluator pre-ingestion, at internal tier since only the ingestion pipeline calls it, means a flagged document never gets embedded — and the evaluator only flags, a human always decides.',
      kind: 'convention', repo: REPO.LLM, initiative_id: INITIATIVE.LLM,
      tags: ['llm', 'pii'],
      member_observation_ids: groups.C22.map((o) => o.id),
      confidence: 0.85, created_by_compaction_id: 'comp-107',
      created_at: clock.hoursAgo(26), updated_at: clock.hoursAgo(26),
    },
  ];
}

// ─── Artifacts (L2) ────────────────────────────────────────────────────────
// The Library link lives in `libraryLinks` below, not on the row: the wire
// artifact's `library_item_id` is composed from that table, so "which
// artifacts are published" is one collection an auditor can empty.

function seedArtifacts(): ArtifactRow[] {
  return [
    {
      id: 'art-001',
      type: 'runbook',
      title: 'Rerun-and-diff triage for a flaky collector-fleet test',
      summary: 'Before quarantining a test as flaky, rerun it twice and diff the outcomes — parallel-CI port contention and a genuine regression look identical from a single failure.',
      body_markdown:
        '## Symptom\nA collector-fleet integration test fails intermittently in CI but passes every time locally.\n\n' +
        '## Triage\n1. Rerun the failing test twice in isolation.\n2. Diff the two outcomes against the original failure.\n3. If all three agree, it is not port contention — treat it as a real regression, not a flake.\n\n' +
        '## Why\nQuarantining without this check has hidden a real regression before (a seed-value bug shipped for a week under a "known flaky" label).',
      cluster_ids: ['cl-019'],
      facts: ['fact-001', 'fact-002'],
      status: 'published',
      reviewed_by: 'Eli Garcia', reviewed_at: clock.hoursAgo(9),
      created_by_compaction_id: 'comp-201',
      created_at: clock.hoursAgo(40), updated_at: clock.hoursAgo(9),
    },
    {
      id: 'art-002',
      type: 'runbook',
      title: 'Recover a cold Aurora Data API with a warm SELECT 1 and retry',
      summary: 'The first Data API call after idle fails with HttpEndpointNotEnabled; warm the endpoint with a throwaway query, then retry transient errors on a bounded backoff.',
      body_markdown:
        '## Symptom\n`HttpEndpointNotEnabledException` (or a sibling resume/scale transient) on the first Data API call after a cold start or rebuild.\n\n' +
        '## Fix\n1. Issue a throwaway `SELECT 1` to warm the endpoint.\n2. Retry the real call up to 6 times with a 3-second backoff, transient errors only.\n3. Let a genuine SQL error (e.g. `already exists`) raise immediately — do not retry it.',
      cluster_ids: ['cl-021'],
      facts: ['fact-003', 'fact-004'],
      status: 'published',
      reviewed_by: null, reviewed_at: null,
      created_by_compaction_id: 'comp-201',
      created_at: clock.hoursAgo(40), updated_at: clock.hoursAgo(40),
    },
    {
      id: 'art-003',
      type: 'insight',
      title: 'Collector-fleet Fargate tasks are ARM64',
      summary: 'An image built on Apple Silicon is ARM64; a Fargate task definition that doesn’t pin runtimePlatform still defaults to x86_64 and dies with exec format error.',
      body_markdown:
        'The middleware and collector-fleet images are built on Apple Silicon. Fargate defaults task definitions to x86_64 unless `runtimePlatform` explicitly pins ARM64 — the mismatch only surfaces as `exec format error` at container start, and looks like a crash loop rather than an architecture mismatch. ARM64 is also the cheaper Fargate option, so pinning it is free.',
      cluster_ids: ['cl-020'],
      facts: ['fact-005'],
      status: 'published',
      reviewed_by: 'Priya Desai', reviewed_at: clock.hoursAgo(30),
      created_by_compaction_id: 'comp-201',
      created_at: clock.hoursAgo(40), updated_at: clock.hoursAgo(30),
    },
    {
      id: 'art-004',
      type: 'decision',
      title: 'Gate auth diffs on the CSRF evaluator before merge',
      summary: 'Run every auth-service PR diff through the CSRF-risk evaluator as a required check, not an advisory comment — the diff is always fenced as untrusted input.',
      body_markdown:
        '## Decision\nEvery diff touching `orgiq-auth-service` runs through `lib-csrf-check` as a required PR check.\n\n' +
        '## Rationale\nAn earlier advisory-only comment did not stop a CSRF-weakening change from merging. A required check does.\n\n' +
        '## Guardrails\n- The diff is passed as fenced, untrusted content — never as an instruction the evaluator follows.\n- The evaluator needed two sign-offs before promotion to endpoint tier, since it can now block a merge.',
      cluster_ids: ['cl-011'],
      facts: ['fact-006', 'fact-007'],
      status: 'published',
      reviewed_by: 'Eli Garcia', reviewed_at: clock.hoursAgo(60),
      created_by_compaction_id: 'comp-202',
      created_at: clock.hoursAgo(70), updated_at: clock.hoursAgo(60),
    },
    {
      id: 'art-005',
      type: 'convention',
      title: 'Scan every ingested document for PII before it reaches the knowledge base',
      summary: 'Run the PII evaluator pre-ingestion so a flagged document never gets embedded; the evaluator flags, a human decides — it never auto-redacts.',
      body_markdown:
        'Every document heading into the Bedrock Knowledge Base first passes `lib-pii-scan`. Scanning after ingestion was tried and rejected: by then the document was already embedded and indexed. The evaluator runs at internal tier (the ingestion pipeline is its only caller) and only flags — redaction decisions stay with a human reviewer.',
      cluster_ids: ['cl-022'],
      facts: ['fact-008'],
      status: 'published',
      reviewed_by: 'Mia Singh', reviewed_at: clock.hoursAgo(45),
      created_by_compaction_id: 'comp-202',
      created_at: clock.hoursAgo(70), updated_at: clock.hoursAgo(45),
    },
    {
      id: 'art-006',
      type: 'runbook',
      title: 'Decommission StatsD service by service without breaking dashboards',
      summary: 'Dual-write StatsD and OTel per service until its OTel dashboards are trusted, then remove the emitter behind a checklist that re-points every alert first.',
      body_markdown:
        '## Steps\n1. Keep the service dual-writing to StatsD and OTel.\n2. Validate the OTel-derived dashboards against the StatsD numbers for at least one sprint.\n3. Re-point every alert that still references the StatsD metric.\n4. Remove the StatsD emitter for that service only.\n\nAwaiting review before this leaves draft — the checklist step is new and hasn’t been exercised on a second service yet.',
      cluster_ids: ['cl-005'],
      facts: ['fact-009'],
      status: 'draft',
      reviewed_by: null, reviewed_at: null,
      created_by_compaction_id: 'comp-202',
      created_at: clock.hoursAgo(70), updated_at: clock.hoursAgo(70),
    },
    {
      id: 'art-007',
      type: 'convention',
      title: 'Bump session_epoch on every tenant/role switch',
      summary: 'A stateless session cookie can’t be revoked directly; bumping a stored epoch, checked on the periodic grants refresh, closes the replay window to about 120 seconds.',
      body_markdown:
        'Every tenant/role switch and `revoke-others` call bumps `session_epoch` on `app_users`. `sessionMiddleware`’s periodic grants refresh compares the cookie’s epoch against the stored one and drops anything below it. Masquerade is the deliberate exception: it carries the target user’s epoch rather than bumping it, so masquerading into an account doesn’t kick that user out of their own live sessions.\n\nStill draft: needs a second reviewer before it generalizes past the auth-migration initiative.',
      cluster_ids: ['cl-008'],
      facts: ['fact-010'],
      status: 'draft',
      reviewed_by: null, reviewed_at: null,
      created_by_compaction_id: 'comp-203',
      created_at: clock.hoursAgo(100), updated_at: clock.hoursAgo(100),
    },
    {
      id: 'art-008',
      type: 'insight',
      title: 'OpenSearch Serverless and Aurora Serverless v2 both bill a floor at zero traffic',
      summary: 'Neither service scales to zero: OpenSearch bills a 2 OCU minimum and Aurora Serverless v2 bills a 0.5 ACU minimum (~$45/mo), continuously, regardless of load.',
      body_markdown:
        'Retired: superseded by two narrower artifacts (`skill-cold-start-aurora` covers the Aurora cold-start behavior; the OpenSearch floor is now tracked directly in the FinOps dashboard rather than as a standalone insight). Kept for lineage — the original showback case cited this combined artifact before it was split.',
      cluster_ids: ['cl-017', 'cl-018'],
      facts: ['fact-011', 'fact-012'],
      status: 'retired',
      reviewed_by: 'Layla Hassan', reviewed_at: clock.hoursAgo(80),
      created_by_compaction_id: 'comp-203',
      created_at: clock.hoursAgo(100), updated_at: clock.hoursAgo(80),
    },
  ];
}

// ─── Facts ─────────────────────────────────────────────────────────────────

/** Evidence by position within a cluster's own observation group, so a fact
 *  cites ids that exist by construction rather than by proofreading. */
const obsIds = (group: Observation[], ...idx: number[]): string[] => idx.map((i) => group[i]!.id);

function seedFacts(groups: ObservationGroups): Fact[] {
  return [
    {
      id: 'fact-001',
      artifact_id: 'art-001',
      statement: 'Rerunning a suspected-flaky collector test twice and diffing outcomes separates a real regression from CI port contention.',
      subject: 'a flaky collector-fleet test', predicate: 'is triaged by', object: 'a rerun-and-diff check',
      evidence_observation_ids: obsIds(groups.C19, 1, 2),
      confidence: 0.91,
    },
    {
      id: 'fact-002',
      artifact_id: 'art-001',
      statement: 'Quarantining a flaky test without diff evidence can hide a real regression.',
      subject: 'a quarantined flaky test with no diff evidence', predicate: 'can hide', object: 'a real regression',
      evidence_observation_ids: obsIds(groups.C19, 2),
      confidence: 0.83,
    },
    {
      id: 'fact-003',
      artifact_id: 'art-002',
      statement: 'The first Data API call to a cold 0.5-ACU Aurora cluster fails with HttpEndpointNotEnabled.',
      subject: 'the first Data API call after idle', predicate: 'fails with', object: 'HttpEndpointNotEnabledException',
      evidence_observation_ids: obsIds(groups.C21, 0),
      confidence: 0.95,
    },
    {
      id: 'fact-004',
      artifact_id: 'art-002',
      statement: 'A warm-up SELECT 1 followed by a 6x3s retry reliably clears the Aurora cold-start race.',
      subject: 'a warm SELECT 1 plus 6x3s retry', predicate: 'clears', object: 'the Aurora cold-start race',
      evidence_observation_ids: obsIds(groups.C21, 1),
      confidence: 0.93,
    },
    {
      id: 'fact-005',
      artifact_id: 'art-003',
      statement: 'An x86_64 image deployed to a Fargate task without runtimePlatform pinned to ARM64 fails at container start with exec format error.',
      subject: 'an x86_64 image on an unpinned Fargate task', predicate: 'fails with', object: 'exec format error',
      evidence_observation_ids: obsIds(groups.C20, 0, 1),
      confidence: 0.94,
    },
    {
      id: 'fact-006',
      artifact_id: 'art-004',
      statement: 'An LLM evaluator run as a required PR check catches CSRF-weakening diffs that an advisory-only comment did not stop.',
      subject: 'the CSRF evaluator as a required check', predicate: 'catches', object: 'CSRF-weakening diffs before merge',
      evidence_observation_ids: obsIds(groups.C11, 0, 1),
      confidence: 0.9,
    },
    {
      id: 'fact-007',
      artifact_id: 'art-004',
      statement: 'The evaluator’s diff input must be treated as untrusted data, never as instructions the model follows.',
      subject: 'the PR diff passed to the evaluator', predicate: 'must be treated as', object: 'untrusted, fenced data',
      evidence_observation_ids: obsIds(groups.C11, 2),
      confidence: 0.88,
    },
    {
      id: 'fact-008',
      artifact_id: 'art-005',
      statement: 'Scanning a document for PII before ingestion prevents a flagged document from ever being embedded into the knowledge base.',
      subject: 'a PII scan before ingestion', predicate: 'prevents', object: 'a flagged document reaching the KB',
      evidence_observation_ids: obsIds(groups.C22, 0),
      confidence: 0.89,
    },
    {
      id: 'fact-009',
      artifact_id: 'art-006',
      statement: 'Dual-writing to StatsD and OTel during the transition window gives on-call a fallback dashboard.',
      subject: 'a StatsD/OTel dual-write window', predicate: 'gives on-call', object: 'a fallback dashboard during cutover',
      evidence_observation_ids: obsIds(groups.C5, 1),
      confidence: 0.85,
    },
    {
      id: 'fact-010',
      artifact_id: 'art-007',
      statement: 'Bumping session_epoch on a tenant/role switch invalidates any cookie minted before it within one grants-refresh cycle.',
      subject: 'a session_epoch bump', predicate: 'invalidates', object: 'pre-switch cookies within about 120 seconds',
      evidence_observation_ids: obsIds(groups.C8, 0, 1),
      confidence: 0.92,
    },
    {
      id: 'fact-011',
      artifact_id: 'art-008',
      statement: 'OpenSearch Serverless bills its 2 OCU floor even with zero search traffic.',
      subject: 'OpenSearch Serverless', predicate: 'bills', object: 'a 2 OCU floor regardless of traffic',
      evidence_observation_ids: obsIds(groups.C17, 0),
      confidence: 0.96,
    },
    {
      id: 'fact-012',
      artifact_id: 'art-008',
      statement: 'Aurora Serverless v2 never scales below its 0.5 ACU floor, billing roughly $45/month even idle.',
      subject: 'Aurora Serverless v2', predicate: 'bills', object: 'a 0.5 ACU floor (~$45/mo) even idle',
      evidence_observation_ids: obsIds(groups.C18, 0),
      confidence: 0.96,
    },
  ];
}

// ─── Review samples ────────────────────────────────────────────────────────
// The pending backlog and the decided history in ONE store, because the
// calibration banner above the queue is counted from exactly these rows:
// queue depth, how many were reviewed in the window, and how often the
// reviewer agreed. Deciding a sample moves all three together or none.

function seedReviewSamples(): ReviewSample[] {
  let seq = 0;
  const mkReview = (
    targetKind: ReviewTargetKind, targetId: string, hAgo: number,
    reviewer: string | null, verdict: ReviewVerdict, note: string | null,
  ): ReviewSample => {
    seq += 1;
    return {
      id: `rev-${String(seq).padStart(3, '0')}`,
      target_kind: targetKind, target_id: targetId, sampled_at: clock.hoursAgo(hAgo),
      reviewer, verdict, note,
    };
  };

  return [
    // pending
    mkReview('artifact', 'art-006', 2, null, 'pending', null),
    mkReview('artifact', 'art-007', 3, null, 'pending', null),
    mkReview('cluster', 'cl-019', 1, null, 'pending', null),
    mkReview('cluster', 'cl-020', 1.5, null, 'pending', null),
    mkReview('cluster', 'cl-021', 0.5, null, 'pending', null),
    mkReview('cluster', 'cl-022', 0.8, null, 'pending', null),
    // decided — agree
    mkReview('cluster', 'cl-001', 5, 'Eli Garcia', 'agree', 'Matches what shipped.'),
    mkReview('cluster', 'cl-002', 6, 'Priya Desai', 'agree', 'Sampling behavior checks out against the trace data.'),
    mkReview('cluster', 'cl-003', 7, 'Layla Hassan', 'agree', 'RED dashboards confirm the connector story.'),
    mkReview('cluster', 'cl-005', 9, 'Nora DaSilva', 'agree', 'Checklist step is exactly what caught the missed alert.'),
    mkReview('cluster', 'cl-006', 10, 'Rachel Kowalski', 'agree', 'Burn-rate alerts paged correctly on the next incident.'),
    mkReview('cluster', 'cl-007', 24, 'Mia Singh', 'agree', 'BFF flow matches the design review.'),
    mkReview('cluster', 'cl-008', 25, 'Caleb Turner', 'agree', 'Epoch bump behavior verified against the session tests.'),
    mkReview('cluster', 'cl-010', 30, 'Priya Desai', 'agree', 'Rollback flag saved one tenant’s cutover already.'),
    mkReview('cluster', 'cl-011', 32, 'Eli Garcia', 'agree', 'Evaluator gate is live and blocking as described.'),
    mkReview('cluster', 'cl-012', 40, 'Layla Hassan', 'agree', 'Prompt refresh timing matches observed deploys.'),
    mkReview('cluster', 'cl-013', 41, 'Rachel Kowalski', 'agree', 'Pagination fix confirmed against the full prompt count.'),
    mkReview('cluster', 'cl-014', 42, 'Mia Singh', 'agree', 'Guardrail-per-role behavior matches the Cedar policies.'),
    mkReview('cluster', 'cl-015', 50, 'Caleb Turner', 'agree', 'SSM-backed config edit took effect immediately as claimed.'),
    mkReview('cluster', 'cl-016', 55, 'Nora DaSilva', 'agree', 'Showback number is what got the teardown approved.'),
    mkReview('cluster', 'cl-017', 58, 'Nora Chang', 'agree', 'OpenSearch floor confirmed against the billing export.'),
    mkReview('cluster', 'cl-018', 60, 'Priya Desai', 'agree', 'Billing floor matches the Cost Explorer line item.'),
    mkReview('artifact', 'art-004', 60, 'Eli Garcia', 'agree', 'CSRF gate matches the merged PR history.'),
    // decided — disagree
    mkReview('cluster', 'cl-004', 12, 'Eli Garcia', 'disagree', 'This merged two separate incidents into one cluster; the queue-limit fix and the OOM report aren’t the same learning.'),
    mkReview('cluster', 'cl-009', 20, 'Nora Chang', 'disagree', 'The HTTPS-callback gotcha and the picker-fallback decision read as two different learnings, not one cluster.'),
    mkReview('artifact', 'art-008', 70, 'Layla Hassan', 'disagree', 'Retiring this loses the OpenSearch half of the story — should stay published until a replacement artifact covers OpenSearch on its own.'),
  ];
}

// ─── Library links ───────────────────────────────────────────────────────────
// Which artifacts became a Library asset. Every id here is a REAL asset in
// providers/prompt-library.ts MOCK_ASSETS — an artifact linking to an asset
// that does not exist would render a "Distilled from" section pointing at a
// 404, which is the invented-wire-string bug (floor rule 2) wearing a
// different hat.

function seedLibraryLinks(): LibraryLink[] {
  return [
    { artifact_id: 'art-001', library_item_id: 'skill-flaky-test-triage' },
    { artifact_id: 'art-002', library_item_id: 'skill-cold-start-aurora' },
    { artifact_id: 'art-003', library_item_id: 'insight-arm64-fargate' },
    { artifact_id: 'art-004', library_item_id: 'lib-csrf-check' },
    { artifact_id: 'art-005', library_item_id: 'lib-pii-scan' },
  ];
}

// ─── Compaction jobs ─────────────────────────────────────────────────────────
// comp-101..107 are the frequent L0→L1 merges, comp-201..203 the sparser
// L1→L2 batch that has not run in nearly two days — the gap compactionHealth
// reports as stalled. comp-104 is the seeded failure: it produced nothing, so
// no cluster names it, so every number the provider counts for it comes out
// zero except the input count, which it borrows from the pass that re-merged
// its batch (`retriedBy`).

/** `startedAt` + `minutes`, so a job's duration is stated once. */
function finishedAfter(startedAt: string, minutes: number): string {
  return new Date(Date.parse(startedAt) + minutes * 60_000).toISOString();
}

function ranAt(
  id: string, level: Level, hoursAgo: number, minutes: number,
  over: Partial<CompactionJobRow> = {},
): CompactionJobRow {
  const startedAt = clock.hoursAgo(hoursAgo);
  return { id, level, startedAt, finishedAt: finishedAfter(startedAt, minutes), status: 'succeeded', ...over };
}

function seedCompactionJobs(): CompactionJobRow[] {
  return [
    ranAt('comp-101', 'L1', 0.3, 2),
    ranAt('comp-102', 'L1', 1.5, 2),
    ranAt('comp-103', 'L1', 4, 3),
    ranAt('comp-104', 'L1', 7, 1, {
      status: 'failed',
      error: 'EventBus consumer lost its offset mid-merge (bridge restart) — compaction aborted before any output was written.',
      retriedBy: 'comp-105',
    }),
    ranAt('comp-105', 'L1', 11, 2),
    ranAt('comp-106', 'L1', 18, 2),
    ranAt('comp-107', 'L1', 26, 2),
    ranAt('comp-201', 'L2', 40, 6),
    ranAt('comp-202', 'L2', 70, 5),
    ranAt('comp-203', 'L2', 100, 5),
  ];
}

// ─── The write stream ────────────────────────────────────────────────────────
// Twelve sessions writing into L0 right now, across the same four repos the
// corpus is written against. The Overview's "active writers", its per-hour
// rate and its repo shares are all counted from these rows.

function writer(
  id: string, session: string, box: string, repo: string, initiative: string,
  observationsPerHour: number, writes: IngestWriter['writes'],
): IngestWriter {
  return { id, session_id: session, box_id: box, repo, initiative_id: initiative, observationsPerHour, writes };
}

function seedIngestWriters(): IngestWriter[] {
  return [
    writer('wr-obs-01', 'sess-obs-04', 'box-obs-04', REPO.OBS, INITIATIVE.OBS, 9, {
      kind: 'gotcha', title: 'Span projector lags CloudWatch by a few minutes',
      body: 'Observability tables fill on the projector schedule, not on ingest — a "missing" trace usually just has not been projected yet.',
      tags: ['observability', 'span-projector'],
    }),
    writer('wr-obs-02', 'sess-obs-05', 'box-obs-05', REPO.OBS, INITIATIVE.OBS, 8, {
      kind: 'convention', title: 'Error rate counts real failures only',
      body: 'Guardrail interventions and schema-invalid output are errors; a weak answer is lowQualityRate, not an error.',
      tags: ['observability', 'metrics'],
    }),
    writer('wr-obs-03', 'sess-obs-06', 'box-obs-06', REPO.OBS, INITIATIVE.OBS, 8, {
      kind: 'worked', title: 'Collector canary catches a bad build before the fleet does',
      body: 'One gateway collector held back a version for 24h; the memory regression showed up there and never reached the rest of the fleet.',
      tags: ['otel', 'rollout'],
    }),
    writer('wr-obs-04', 'sess-obs-07', 'box-obs-07', REPO.OBS, INITIATIVE.OBS, 7, {
      kind: 'decision', title: 'Dashboards read from the span-metrics connector, not from app code',
      body: 'One pipeline for traces and RED metrics means a service gets its dashboards the moment it speaks OTLP.',
      tags: ['otel', 'metrics'],
    }),
    writer('wr-auth-01', 'sess-auth-04', 'box-auth-04', REPO.AUTH, INITIATIVE.AUTH, 7, {
      kind: 'worked', title: 'Cognito callback must be https off localhost',
      body: 'A deployed callback on plain http is rejected by the hosted UI; keep the picker until the ALB has a certificate.',
      tags: ['auth', 'cognito'],
    }),
    writer('wr-auth-02', 'sess-auth-05', 'box-auth-05', REPO.AUTH, INITIATIVE.AUTH, 7, {
      kind: 'gotcha', title: 'A masquerading admin must not bump the target user’s epoch',
      body: 'Bumping on masquerade would log the impersonated user out of their own live sessions the moment an admin looked at the account.',
      tags: ['auth', 'masquerade'],
    }),
    writer('wr-auth-03', 'sess-auth-06', 'box-auth-06', REPO.AUTH, INITIATIVE.AUTH, 6, {
      kind: 'decision', title: 'Resolve the user by external_sub first, email second',
      body: 'Matching the IdP subject claim first survives an upstream email change; email is the first-login fallback only.',
      tags: ['auth', 'oidc'],
    }),
    writer('wr-llm-01', 'sess-llm-03', 'box-llm-03', REPO.LLM, INITIATIVE.LLM, 6, {
      kind: 'decision', title: 'Prompt text resolved from Prompt Management at run time',
      body: 'A Prompt Studio edit reaches the fleet within a minute; the SYSTEM_PROMPT literal is the outage fallback only.',
      tags: ['prompts', 'bedrock'],
    }),
    writer('wr-llm-02', 'sess-llm-04', 'box-llm-04', REPO.LLM, INITIATIVE.LLM, 6, {
      kind: 'gotcha', title: 'An un-paginated Bedrock list call truncates in silence',
      body: 'ListPrompts returns the first page and no error; every list call in this codebase loops on nextToken by convention.',
      tags: ['llm', 'pagination'],
    }),
    writer('wr-llm-03', 'sess-llm-05', 'box-llm-05', REPO.LLM, INITIATIVE.LLM, 6, {
      kind: 'worked', title: 'Judge config read fresh on every ask keeps a rubric edit immediate',
      body: 'Caching the SSM judge config meant a rubric-weight fix took an hour to land; reading it per ask removed the lag.',
      tags: ['llm', 'canary'],
    }),
    writer('wr-cost-01', 'sess-cost-04', 'box-cost-04', REPO.COST, INITIATIVE.COST, 7, {
      kind: 'failed', title: 'OpenSearch Serverless bills two OCUs idle',
      body: 'Tearing down the collection between demos is the only lever; the budget alarm caught a weekend of idle burn.',
      tags: ['cost', 'opensearch'],
    }),
    writer('wr-cost-02', 'sess-cost-05', 'box-cost-05', REPO.COST, INITIATIVE.COST, 7, {
      kind: 'convention', title: 'Tag every ad-hoc eval run with the initiative footing the bill',
      body: 'Untagged runs land as unattributed spend at month end, which is exactly the bucket showback is supposed to have eliminated.',
      tags: ['finops', 'showback'],
    }),
  ];
}

// ─── The `large` world ───────────────────────────────────────────────────────
//
// Volume is a real story on this surface: L0 is a write head, and the tier
// list, its cursor pagination and the lineage graph's density are only
// auditable against a corpus bigger than one screen. The generator below is
// deterministic and self-consistent — every generated cluster's members, every
// artifact's clusters, every fact's evidence and every job's produced rows
// exist in the same generated world — so `resetAll('large')` is a corpus, not
// a pile of dangling ids.

const LARGE = {
  clusters: 20,
  membersPerCluster: 6,
  /** Written but not yet merged — the L0 backlog L1's lag is measured from. */
  looseObservations: 30,
  artifacts: 6,
  clustersPerArtifact: 2,
  l1Jobs: 4,
  l2Jobs: 2,
  reviews: 12,
  writers: 24,
} as const;

const LARGE_REPOS: Array<{ repo: string; initiative: string }> = [
  { repo: REPO.OBS, initiative: INITIATIVE.OBS },
  { repo: REPO.AUTH, initiative: INITIATIVE.AUTH },
  { repo: REPO.LLM, initiative: INITIATIVE.LLM },
  { repo: REPO.COST, initiative: INITIATIVE.COST },
];
const LARGE_KINDS: ObservationKind[] = ['worked', 'failed', 'gotcha', 'decision', 'convention'];
const LARGE_TYPES: ArtifactType[] = ['runbook', 'insight', 'convention', 'decision'];
const LARGE_STATUSES: ArtifactStatus[] = ['published', 'published', 'draft', 'published', 'draft', 'retired'];

const pad = (n: number, width: number): string => String(n).padStart(width, '0');
const largeRepo = (i: number) => LARGE_REPOS[i % LARGE_REPOS.length]!;
/** Which L1 job minted generated cluster `k` (1-based), and which L2 job minted artifact `a`. */
const largeL1Job = (k: number): string => `comp-L${1 + Math.floor((k - 1) / (LARGE.clusters / LARGE.l1Jobs))}`;
const largeL2Job = (a: number): string => `comp-L${LARGE.l1Jobs + 1 + Math.floor((a - 1) / (LARGE.artifacts / LARGE.l2Jobs))}`;

function largeObservations(): Observation[] {
  const clustered = LARGE.clusters * LARGE.membersPerCluster;
  return Array.from({ length: clustered + LARGE.looseObservations }, (_, i) => {
    const n = i + 1;
    const { repo, initiative } = largeRepo(i);
    const loose = n > clustered;
    return {
      id: `obs-L${pad(n, 3)}`,
      session_id: `sess-load-${pad((i % 12) + 1, 2)}`,
      box_id: `box-load-${pad((i % 6) + 1, 2)}`,
      repo,
      initiative_id: initiative,
      kind: LARGE_KINDS[i % LARGE_KINDS.length]!,
      title: loose
        ? `Uncompacted write ${n}: retry budget exhausted on a transient dependency`
        : `Load-corpus observation ${n}: ${LARGE_KINDS[i % LARGE_KINDS.length]} during a fleet run`,
      body: loose
        ? 'Landed at the write head after the last L0→L1 merge, so it is still waiting for a compaction pass to pick it up.'
        : 'Generated for the high-volume world: enough rows that the tier list pages, the cursor is exercised and the lineage graph has real density.',
      tags: ['load', LARGE_KINDS[i % LARGE_KINDS.length]!],
      // Loose rows are the freshest — they are what has not been merged yet.
      created_at: loose ? clock.hoursAgo(0.2 + (n - clustered) * 0.05) : clock.hoursAgo(6 + i * 0.4),
    };
  });
}

function largeClusters(): Cluster[] {
  return Array.from({ length: LARGE.clusters }, (_, i) => {
    const k = i + 1;
    const { repo, initiative } = largeRepo(i);
    const first = i * LARGE.membersPerCluster + 1;
    const at = clock.hoursAgo(5 + i * 1.5);
    return {
      id: `cl-L${pad(k, 2)}`,
      title: `Load-corpus cluster ${k}: repeated ${LARGE_KINDS[i % LARGE_KINDS.length]} across a fleet run`,
      summary: `Merged ${LARGE.membersPerCluster} observations written against ${repo} during the same fleet run.`,
      kind: LARGE_KINDS[i % LARGE_KINDS.length]!,
      repo,
      initiative_id: initiative,
      tags: ['load', LARGE_KINDS[i % LARGE_KINDS.length]!],
      member_observation_ids: Array.from({ length: LARGE.membersPerCluster }, (_, m) => `obs-L${pad(first + m, 3)}`),
      confidence: Number((0.75 + (i % 5) * 0.04).toFixed(2)),
      created_by_compaction_id: largeL1Job(k),
      created_at: at,
      updated_at: at,
    };
  });
}

function largeArtifacts(): ArtifactRow[] {
  return Array.from({ length: LARGE.artifacts }, (_, i) => {
    const a = i + 1;
    const at = clock.hoursAgo(30 + i * 6);
    const clusterIds = Array.from(
      { length: LARGE.clustersPerArtifact },
      (_, c) => `cl-L${pad(i * LARGE.clustersPerArtifact + c + 1, 2)}`,
    );
    return {
      id: `art-L${a}`,
      type: LARGE_TYPES[i % LARGE_TYPES.length]!,
      title: `Load-corpus artifact ${a}: what the fleet learned about ${largeRepo(i).repo.split('/').pop()}`,
      summary: `Distilled from ${clusterIds.length} generated clusters — present so the artifact list, its filters and the lineage graph have volume to render.`,
      body_markdown: `## Generated\nOne of the high-volume world's artifacts, distilled from ${clusterIds.join(' and ')}.`,
      cluster_ids: clusterIds,
      facts: Array.from({ length: LARGE.clustersPerArtifact }, (_, f) => `fact-L${pad(i * LARGE.clustersPerArtifact + f + 1, 2)}`),
      status: LARGE_STATUSES[i % LARGE_STATUSES.length]!,
      reviewed_by: i % 2 === 0 ? 'Priya Desai' : null,
      reviewed_at: i % 2 === 0 ? clock.hoursAgo(20 + i * 4) : null,
      created_by_compaction_id: largeL2Job(a),
      created_at: at,
      updated_at: at,
    };
  });
}

function largeFacts(): Fact[] {
  return Array.from({ length: LARGE.artifacts * LARGE.clustersPerArtifact }, (_, i) => {
    const artifactIndex = Math.floor(i / LARGE.clustersPerArtifact);
    const clusterIndex = i; // one fact per (artifact, member cluster) pair
    const firstObs = clusterIndex * LARGE.membersPerCluster + 1;
    return {
      id: `fact-L${pad(i + 1, 2)}`,
      artifact_id: `art-L${artifactIndex + 1}`,
      statement: `Load-corpus fact ${i + 1}: the generated cluster it cites is evidenced by its own observations.`,
      subject: `cl-L${pad(clusterIndex + 1, 2)}`,
      predicate: 'supports',
      object: `art-L${artifactIndex + 1}`,
      evidence_observation_ids: [`obs-L${pad(firstObs, 3)}`, `obs-L${pad(firstObs + 1, 3)}`],
      confidence: Number((0.8 + (i % 4) * 0.03).toFixed(2)),
    };
  });
}

function largeCompactionJobs(): CompactionJobRow[] {
  const l1 = Array.from({ length: LARGE.l1Jobs }, (_, i) => ranAt(`comp-L${i + 1}`, 'L1', 2 + i * 3, 2));
  const l2 = Array.from({ length: LARGE.l2Jobs }, (_, i) => ranAt(`comp-L${LARGE.l1Jobs + i + 1}`, 'L2', 28 + i * 12, 5));
  return [...l1, ...l2];
}

function largeReviewSamples(): ReviewSample[] {
  return Array.from({ length: LARGE.reviews }, (_, i) => {
    const decided = i >= LARGE.reviews / 2;
    const disagree = decided && i % 5 === 0;
    return {
      id: `rev-L${pad(i + 1, 2)}`,
      target_kind: 'cluster' as ReviewTargetKind,
      target_id: `cl-L${pad(i + 1, 2)}`,
      sampled_at: clock.hoursAgo(1 + i * 2),
      reviewer: decided ? (i % 2 === 0 ? 'Nora DaSilva' : 'Caleb Turner') : null,
      verdict: decided ? (disagree ? 'disagree' : 'agree') : 'pending',
      note: decided
        ? (disagree ? 'Two unrelated fleet runs merged into one cluster.' : 'Matches the run log.')
        : null,
    };
  });
}

function largeIngestWriters(): IngestWriter[] {
  return Array.from({ length: LARGE.writers }, (_, i) => {
    const { repo, initiative } = largeRepo(i);
    return writer(
      `wr-load-${pad(i + 1, 2)}`,
      `sess-load-${pad((i % 12) + 1, 2)}`,
      `box-load-${pad((i % 6) + 1, 2)}`,
      repo,
      initiative,
      4 + (i % 5),
      {
        kind: LARGE_KINDS[i % LARGE_KINDS.length]!,
        title: `Load writer ${i + 1} is writing against ${repo}`,
        body: 'Generated writer for the high-volume world — its rate is summed into the fleet rate, never typed beside it.',
        tags: ['load', 'ingest'],
      },
    );
  });
}

/**
 * The `error` world for this domain: the shared-memory store is unreadable.
 *
 * Throwing is the POINT, and it is the one scenario the whole distillation +
 * library + promotions ladder was missing. Every fixture here declared
 * `default`, `empty`, `fresh` and `large`, and an undeclared scenario falls
 * back to `default` — so `POST /api/__mock/scenario {"scenario":"error"}`
 * changed *nothing* on `/iq/distillation`, byte for byte, and the degraded
 * branch of the flagship surface could not be reached at all without
 * unplugging a database that isn't there offline anyway. One throw per table
 * rather than one for the domain, so an auditor can pin a single fixture
 * (`{"scenario":"error","fixture":"distillation-artifacts"}`) and watch the
 * artifacts panel fail while levels and ingest keep answering — which is what
 * a partial outage actually looks like.
 *
 * The message names the READ, spelled as `schema/distillation_schema.sql` and
 * `schema/lab_loop_schema.sql` spell it where a relation exists, so a reader
 * of the 500 knows which one failed. Three of these have no Aurora table yet
 * (the provider says so: there is no compaction-job or level-rollup table),
 * so they are named for the read rather than given an invented relation.
 */
const unreadable = (source: string) => (): never => {
  throw new Error(`distillation store unavailable: ${source} read failed`);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Every collection below declares `empty` explicitly: an undeclared scenario
// falls back to `default`, so a fixture that wants an auditable empty state
// has to say so, and "show me the empty state" was the one audit that
// previously required deleting rows from shared dev:mock state.
//
// `fresh` is the state this machine actually starts in: sessions are writing
// (the writers are there, L0 is filling) and nothing has been compacted,
// reviewed or published yet. It is the only world where pressing "Compact
// L0 → L1" has the whole corpus to chew on.

/** L0 — the raw write head. Never deleted: an observation becomes a cluster
 *  MEMBER, so this count only ever grows. */
export const observations = defineFixture<Observation>({
  key: 'distillation-observations',
  scenarios: {
    default: seedObservations,
    empty: () => [],
    large: () => [...seedObservations(), ...largeObservations()],
    error: unreadable('lab_experiences'),
  },
});

/** L1 — deduped clusters. `empty` (or `fresh`) leaves every observation in
 *  the L0 backlog, which is what L1's lag is measured against. */
export const clusters = defineFixture<Cluster>({
  key: 'distillation-clusters',
  scenarios: {
    default: () => seedClusters(seedObservationGroups()),
    empty: () => [],
    fresh: () => [],
    large: () => [...seedClusters(seedObservationGroups()), ...largeClusters()],
    error: unreadable('distillation_clusters'),
  },
});

/** L2 — distilled artifacts, minus their Library link (see `libraryLinks`). */
export const artifacts = defineFixture<ArtifactRow>({
  key: 'distillation-artifacts',
  scenarios: {
    default: seedArtifacts,
    empty: () => [],
    fresh: () => [],
    large: () => [...seedArtifacts(), ...largeArtifacts()],
    error: unreadable('distillation_artifacts'),
  },
});

/** The claims an artifact stands on, each citing observation ids as evidence. */
export const facts = defineFixture<Fact>({
  key: 'distillation-facts',
  scenarios: {
    default: () => seedFacts(seedObservationGroups()),
    empty: () => [],
    fresh: () => [],
    large: () => [...seedFacts(seedObservationGroups()), ...largeFacts()],
    error: unreadable('distillation_facts'),
  },
});

/** Which artifacts were published into the Library. Emptying this fixture is
 *  the "nothing has been published yet" world — every artifact still resolves,
 *  none of them link out, and /library/:id/provenance 404s. */
export const libraryLinks = defineFixture<LibraryLink>({
  key: 'distillation-library-links',
  scenarios: {
    default: seedLibraryLinks,
    empty: () => [],
    fresh: () => [],
    error: unreadable('distillation_artifacts.library_item_id'),
  },
});

/** Compaction history. Emptying it is what makes every level read `stalled`
 *  ("no compaction has ever run against it") — the state an operator is
 *  supposed to be able to recognise at a glance. */
export const compactionJobs = defineFixture<CompactionJobRow>({
  key: 'distillation-compactions',
  scenarios: {
    default: seedCompactionJobs,
    empty: () => [],
    fresh: () => [],
    large: () => [...seedCompactionJobs(), ...largeCompactionJobs()],
    error: unreadable('compaction job history'),
  },
});

/** The human sample queue AND its history — one store, so deciding a sample
 *  moves the calibration banner and the queue beneath it together. */
export const reviewSamples = defineFixture<ReviewSample>({
  key: 'distillation-review-samples',
  scenarios: {
    default: seedReviewSamples,
    empty: () => [],
    fresh: () => [],
    large: () => [...seedReviewSamples(), ...largeReviewSamples()],
    error: unreadable('distillation_review_samples'),
  },
});

/** The write stream itself. Emptied, nothing is writing — so simulated ingest
 *  mints nothing and the Overview's pressure panel reads zero honestly. */
export const ingestWriters = defineFixture<IngestWriter>({
  key: 'distillation-ingest-writers',
  scenarios: {
    default: seedIngestWriters,
    empty: () => [],
    large: () => [...seedIngestWriters(), ...largeIngestWriters()],
    error: unreadable('L0 write-stream rollup'),
  },
});

/** Every fixture in this domain, for the provider's test-only reset. */
export const distillationFixtures = [
  observations, clusters, artifacts, facts, libraryLinks, compactionJobs, reviewSamples, ingestWriters,
] as const;

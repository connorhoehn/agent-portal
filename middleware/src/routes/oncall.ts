// On-call / incident-response routes.
//
// Mounted ungated at /api/observability/oncall (see routes/observability.ts
// pattern in index.ts) so the on-call surface keeps working even if the
// portal session times out at 3am.
//
// The job-relevant insight: an incident is a correlation problem. When drift
// fires at 03:00, the operator wants a single timeline that aligns:
//   - drift P95 (semantic regression)
//   - judge P05 (worst-tail quality)
//   - error rate (real failures: guardrail intervention or schema-invalid;
//     NOT judge quality — a weak answer is not a failed request)
//   - HITL queue depth + decisions
//   - cost (a sudden 10× cost spike is itself a signal)
//   - deploy markers (prompt_versions registered just before)
//
// Endpoints:
//   GET /timeline?windowHours=&bucketMin=
//   GET /alarms
//   GET /hitl-sla?windowHours=
//   GET /recent-events?limit=
//
// Future extension: cross-reference CloudWatch alarms instead of computing
// alarm states ourselves. For now we synthesize alarm state from the same
// invocation_traces table so the surface is self-contained.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockDriftSummary,
  mockOncallHitlAlarmProbe,
  mockOncallHitlDecisionEvents,
  mockOncallHitlSla,
  mockOncallJudgeRegressions,
  mockOncallRecentDeploys,
  mockOncallTimelineBuckets,
  mockOncallTimelineHitl,
  mockCostDeployMarkers,
} from '../mock/observability-queries.js';

export const oncallRouter = Router();

/**
 * Marks a response whose underlying read failed — same shape as
 * `routes/cost.ts` and `routes/guardrails-detail.ts`'s local `degraded()`
 * helpers, so a real Aurora failure on this surface reads the same way it
 * does on its siblings rather than being indistinguishable from a quiet
 * window. Added only when something actually failed: a healthy read carries
 * no `degraded` key at all, exactly like the sibling routers.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'query failed' };
}

// ── Shared types (mirrored by the portal) ──────────────────────────────────

interface TimelineBucket {
  bucketStart: string;
  driftP95: number | null;
  judgeP05: number | null;
  errorRate: number;
  hitlPending: number;
  hitlDecided: number;
  costUsd: number;
  invocations: number;
}

interface DeployMarker {
  registeredAt: string;
  agentId: string;
  promptVersion: string;
  notes: string | null;
}

interface AlarmState {
  name: string;
  // 'unknown' is not a cosmetic addition. Without it, a probe that could not
  // run was reported as 'ok', so the on-call surface asserted "all signals
  // within thresholds" during a total database outage — the one moment it
  // must not claim things are fine.
  severity: 'critical' | 'warning' | 'ok' | 'unknown';
  reason: string;
  firedAt: string | null;
  affectedAgent: string | null;
}

interface TimelineResponse {
  buckets: TimelineBucket[];
  deployMarkers: DeployMarker[];
  activeAlarms: AlarmState[];
}

interface RecentEvent {
  ts: string;
  kind: 'deploy' | 'alarm' | 'hitl-decided' | 'hitl-expired' | 'judge-spike';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  relatedInvocationId?: string;
  relatedAgentId?: string;
}

/**
 * The fewest calls in the window a per-agent rate alarm may be computed from.
 *
 * Below this a percentage is arithmetic, not evidence: one errored response in
 * a quiet hour is 0% conformance, and firing a warning on it puts a false
 * story on the one page someone reads during an incident. Low on purpose —
 * the window is an hour and the fleet is small, so this drops samples that
 * cannot support a rate rather than waiting for statistical comfort while
 * something is actually broken.
 */
const MIN_ALARM_SAMPLE = 5;

// ── Param helpers ──────────────────────────────────────────────────────────

function longParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

// Parse + clamp helpers — copies the pattern from drift.ts.
function parseHours(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function parseBucketMin(raw: unknown, def: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n >= 5 ? Math.min(n, 360) : def;
}

// ── Alarm computation (shared between /alarms and /timeline) ───────────────

// Compute synthetic alarm states from invocation_traces + approvals in the
// last hour. Returns thresholded results — see CONSTITUTION-aligned cutoffs
// in the task spec.
//
// `failedProbes` is returned alongside the alarms rather than only folded
// into the 'evaluation' beacon: `/alarms` and `/recent-events` fold it back
// into that same beacon (unchanged), but `/timeline` and `/alarms` also use
// it to decide whether their OWN response needs a `degraded` marker — a
// failed probe is real signal loss on this router, not just something for
// the alarm list to say.
async function computeAlarms(): Promise<{ alarms: AlarmState[]; failedProbes: string[] }> {
  const out: AlarmState[] = [];
  const now = new Date().toISOString();
  // Which probes actually completed. An 'ok' beacon is only honest if every
  // signal it claims to summarise was really evaluated.
  const failedProbes: string[] = [];

  // 1) Per-agent quality signals: schema conformance, judge P05, drift P95.
  try {
    // Same per-agent cnt/conformance/p05/drift_p95 rollup as
    // `mockDriftSummary`'s 1-hour call — see mock/observability-queries.ts.
    const rows = config.mock.aurora
      ? mockDriftSummary(1)
      : await exec(`
      WITH window_rows AS (
        SELECT *
          FROM observability.invocation_traces
         WHERE ts > now() - INTERVAL '1 hour'
           AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
      ),
      centroids AS (
        SELECT agent_id, AVG(output_embedding) AS centroid
          FROM window_rows
         WHERE output_embedding IS NOT NULL
           AND (judge_score IS NULL OR judge_score >= 0.6)
         GROUP BY agent_id
      )
      SELECT w.agent_id,
             COUNT(*)::bigint AS cnt,
             AVG(CASE WHEN w.schema_valid IS NULL THEN NULL
                      WHEN w.schema_valid THEN 1.0 ELSE 0.0 END)::float8 AS conformance,
             PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS p05,
             COALESCE(
               (SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (d.output_embedding <=> c.centroid)::float8)
                  FROM window_rows d
                 WHERE d.agent_id = w.agent_id
                   AND d.output_embedding IS NOT NULL),
               0
             ) AS drift_p95
        FROM window_rows w
        LEFT JOIN centroids c USING (agent_id)
       GROUP BY w.agent_id
       ORDER BY cnt DESC`,
    );

    for (const r of rows) {
      const agentId = String(r['agent_id'] ?? 'unknown');
      const cnt = Number(r['cnt'] ?? 0);
      const conf = r['conformance'] == null ? 1 : Number(r['conformance']);
      const p05 = r['p05'] == null ? null : Number(r['p05']);
      const drift = r['drift_p95'] == null ? 0 : Number(r['drift_p95']);

      // A rate over one call is not a rate.
      //
      // `cnt` was selected here and never read, so every probe below fired off
      // whatever landed in the window however small: one errored response in a
      // quiet hour put "Schema conformance 0.0% (threshold 95%)" on the
      // incident board for that agent, while the 24-hour Drift view showed the
      // same agent at 97.8%. Two pages, same signal, opposite stories — and
      // the alarming one is the page someone reads at 3am.
      //
      // Five is deliberately low: this window is an hour, the fleet is small,
      // and the point is to drop samples that cannot support a percentage, not
      // to wait for statistical comfort while something is genuinely broken.
      // An agent quiet enough to fall under it has nothing to alarm about yet.
      if (cnt < MIN_ALARM_SAMPLE) continue;
      // Said out loud on every alarm, because "0.0% of 6" and "0.0% of 600"
      // ask for very different reactions and the reason line is all the reader
      // gets before deciding whether to wake someone.
      const of = ` over ${cnt} call${cnt === 1 ? '' : 's'}`;

      if (Number.isFinite(conf) && conf < 0.95) {
        out.push({
          name: `schema-conformance:${agentId}`,
          severity: 'warning',
          reason: `Schema conformance ${(conf * 100).toFixed(1)}% (threshold 95%)${of}`,
          firedAt: now,
          affectedAgent: agentId,
        });
      }
      if (p05 != null && Number.isFinite(p05)) {
        if (p05 < 0.25) {
          out.push({
            name: `judge-p05:${agentId}`,
            severity: 'critical',
            reason: `Judge P05 ${p05.toFixed(2)} (critical < 0.25)${of}`,
            firedAt: now,
            affectedAgent: agentId,
          });
        } else if (p05 < 0.4) {
          out.push({
            name: `judge-p05:${agentId}`,
            severity: 'warning',
            reason: `Judge P05 ${p05.toFixed(2)} (warning < 0.4)${of}`,
            firedAt: now,
            affectedAgent: agentId,
          });
        }
      }
      if (Number.isFinite(drift) && drift > 0.6) {
        out.push({
          name: `drift-p95:${agentId}`,
          severity: 'warning',
          reason: `Drift P95 ${drift.toFixed(2)} (threshold 0.6)`,
          firedAt: now,
          affectedAgent: agentId,
        });
      }
    }
  } catch (err) {
    console.warn('[oncall] quality alarms failed:', (err as Error).message);
    failedProbes.push('quality');
  }

  // 2) HITL queue depth + oldest-pending age.
  try {
    const rows = config.mock.aurora
      ? mockOncallHitlAlarmProbe()
      : await exec(`
      SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS pending,
             EXTRACT(EPOCH FROM (now() - MIN(requested_at)
                                 FILTER (WHERE status = 'PENDING')))::float8 AS oldest_age_s
        FROM observability.approvals`,
    );
    const r = rows[0] ?? {};
    const pending = Number(r['pending'] ?? 0);
    const oldestAgeS = r['oldest_age_s'] == null ? null : Number(r['oldest_age_s']);

    if (oldestAgeS != null && oldestAgeS > 1800) {
      out.push({
        name: 'hitl-stale',
        severity: 'critical',
        reason: `Oldest pending approval ${Math.round(oldestAgeS / 60)}m old (critical > 30m)`,
        firedAt: now,
        affectedAgent: null,
      });
    } else if (oldestAgeS != null && oldestAgeS > 600) {
      out.push({
        name: 'hitl-stale',
        severity: 'warning',
        reason: `Oldest pending approval ${Math.round(oldestAgeS / 60)}m old (warning > 10m)`,
        firedAt: now,
        affectedAgent: null,
      });
    }
    if (pending > 10) {
      out.push({
        name: 'hitl-depth',
        severity: 'warning',
        reason: `${pending} pending approvals in queue (threshold 10)`,
        firedAt: now,
        affectedAgent: null,
      });
    }
  } catch (err) {
    console.warn('[oncall] hitl alarms failed:', (err as Error).message);
    failedProbes.push('approval queue');
  }

  // A probe that could not run is reported as such. Previously any failure
  // fell through to the 'ok' beacon below, so a dead database rendered as
  // "all signals within thresholds" — an alerting surface claiming health at
  // exactly the moment it had no idea.
  if (failedProbes.length > 0) {
    out.push({
      name: 'evaluation',
      severity: 'unknown',
      reason: `Could not evaluate ${failedProbes.join(' and ')} — signals are unknown, not clear`,
      firedAt: now,
      affectedAgent: null,
    });
    return { alarms: out, failedProbes };
  }

  // Every probe ran and nothing fired: surface a single 'ok' beacon so the UI
  // can render "all clear" as a concrete attestation rather than an absence.
  if (out.length === 0) {
    out.push({
      name: 'overall',
      severity: 'ok',
      reason: 'All signals within thresholds (last 1h)',
      firedAt: now,
      affectedAgent: null,
    });
  }

  return { alarms: out, failedProbes };
}

// ── GET /timeline ──────────────────────────────────────────────────────────
// Composes the five-signal view in a single time-bucketed series so the
// operator can align "drift fired at 03:00" with deploys + cost + errors.

oncallRouter.get('/timeline', asyncHandler(async (req, res) => {
  const windowHours = parseHours(req.query['windowHours'], 24, 24 * 14);
  const bucketMin = parseBucketMin(req.query['bucketMin'], 15);

  // Per-bucket signal aggregation. centroid is computed over the full window
  // per agent (one anchor) — same approach drift.ts/timeseries uses.
  const bucketsSql = `
    WITH window_rows AS (
      SELECT *,
             to_timestamp(
               floor(EXTRACT(EPOCH FROM ts) / (:bucket * 60))
                 * (:bucket * 60)
             ) AS bucket_start
        FROM observability.invocation_traces
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
         AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
    ),
    centroids AS (
      SELECT agent_id, AVG(output_embedding) AS centroid
        FROM window_rows
       WHERE output_embedding IS NOT NULL
         AND (judge_score IS NULL OR judge_score >= 0.6)
       GROUP BY agent_id
    ),
    per_bucket AS (
      SELECT w.bucket_start,
             COUNT(*)::bigint AS invocations,
             COALESCE(
               PERCENTILE_CONT(0.95) WITHIN GROUP
                 (ORDER BY (w.output_embedding <=> c.centroid)::float8),
               NULL
             ) AS drift_p95,
             PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY w.judge_score)::float8 AS judge_p05,
             -- Real failures only: a guardrail intervention or non-conforming
             -- output. Low judge_score is answer QUALITY (surfaced as judge_p05
             -- in this same overlay), not a request error — folding it in here
             -- made a healthy fleet giving mediocre answers alarm as erroring.
             -- Mirrors the per-agent-summary error proxy in routes/traffic.ts.
             SUM(CASE WHEN (w.guardrail_action IS NOT NULL AND w.guardrail_action <> 'NONE')
                       OR w.schema_valid = false
                      THEN 1 ELSE 0 END)::bigint AS errors,
             COALESCE(SUM(w.total_cost_usd), 0)::float8 AS cost_usd
        FROM window_rows w
        LEFT JOIN centroids c ON c.agent_id = w.agent_id
       GROUP BY w.bucket_start
    )
    SELECT bucket_start::text AS bucket_start,
           invocations,
           drift_p95,
           judge_p05,
           errors,
           cost_usd
      FROM per_bucket
     ORDER BY bucket_start ASC`;

  // HITL pending/decided per bucket. We measure decided activity by
  // decided_at (when the human acted) and pending state at bucket end is
  // approximated by a window function — for the initial cut we just return
  // the count of approvals decided in the bucket and the running pending
  // count at bucket end.
  const hitlSql = `
    WITH buckets AS (
      SELECT DISTINCT
             to_timestamp(
               floor(EXTRACT(EPOCH FROM ts) / (:bucket * 60))
                 * (:bucket * 60)
             ) AS bucket_start
        FROM observability.invocation_traces
       WHERE ts > now() - (INTERVAL '1 hour' * :hours)
    ),
    decided AS (
      SELECT to_timestamp(
               floor(EXTRACT(EPOCH FROM decided_at) / (:bucket * 60))
                 * (:bucket * 60)
             ) AS bucket_start,
             COUNT(*)::bigint AS decided
        FROM observability.approvals
       WHERE decided_at IS NOT NULL
         AND decided_at > now() - (INTERVAL '1 hour' * :hours)
       GROUP BY 1
    ),
    pending_at_bucket AS (
      -- pending = requested_at <= bucket_end AND (decided_at IS NULL OR decided_at > bucket_end)
      SELECT b.bucket_start,
             (
               SELECT COUNT(*)::bigint
                 FROM observability.approvals a
                WHERE a.requested_at <= b.bucket_start + (INTERVAL '1 minute' * :bucket)
                  AND (a.decided_at IS NULL
                       OR a.decided_at > b.bucket_start + (INTERVAL '1 minute' * :bucket))
                  AND a.status = 'PENDING'
             ) AS pending
        FROM buckets b
    )
    SELECT b.bucket_start::text AS bucket_start,
           COALESCE(d.decided, 0)::bigint AS decided,
           COALESCE(p.pending, 0)::bigint AS pending
      FROM buckets b
      LEFT JOIN decided d USING (bucket_start)
      LEFT JOIN pending_at_bucket p USING (bucket_start)
     ORDER BY b.bucket_start ASC`;

  const params: SqlParameter[] = [
    longParam('hours', windowHours),
    longParam('bucket', bucketMin),
  ];

  // Independent reads — one failing must not take the other three down with
  // it, so each gets its own try/catch and its own name in `failures`, which
  // becomes the route's single `degraded` marker below (same idea as
  // cost.ts's `/summary`, condensed to one flag rather than a per-section
  // envelope since this route's wire shape predates that pattern).
  const failures: string[] = [];

  let bucketRows: Record<string, unknown>[] = [];
  let hitlRows: Record<string, unknown>[] = [];
  try {
    bucketRows = config.mock.aurora
      ? mockOncallTimelineBuckets(windowHours, bucketMin)
      : await exec(bucketsSql, params);
  } catch (err) {
    console.warn('[oncall] /timeline buckets failed:', (err as Error).message);
    failures.push(`buckets: ${(err as Error).message}`);
  }
  try {
    hitlRows = config.mock.aurora
      ? mockOncallTimelineHitl(windowHours, bucketMin)
      : await exec(hitlSql, params);
  } catch (err) {
    console.warn('[oncall] /timeline hitl failed:', (err as Error).message);
    failures.push(`hitl buckets: ${(err as Error).message}`);
  }

  // Merge HITL buckets onto signal buckets by bucket_start.
  const hitlByBucket = new Map<string, { pending: number; decided: number }>();
  for (const r of hitlRows) {
    const k = String(r['bucket_start'] ?? '');
    hitlByBucket.set(k, {
      pending: Number(r['pending'] ?? 0),
      decided: Number(r['decided'] ?? 0),
    });
  }

  const buckets: TimelineBucket[] = bucketRows.map((r) => {
    const k = String(r['bucket_start'] ?? '');
    const invocations = Number(r['invocations'] ?? 0);
    const errors = Number(r['errors'] ?? 0);
    const hitl = hitlByBucket.get(k) ?? { pending: 0, decided: 0 };
    return {
      bucketStart: k,
      driftP95: r['drift_p95'] == null ? null : Number(r['drift_p95']),
      judgeP05: r['judge_p05'] == null ? null : Number(r['judge_p05']),
      errorRate: invocations > 0 ? errors / invocations : 0,
      hitlPending: hitl.pending,
      hitlDecided: hitl.decided,
      costUsd: Number(r['cost_usd'] ?? 0),
      invocations,
    };
  });

  // Deploy markers — every prompt_version registration in the window is a
  // potential deploy. We don't try to dedupe vs. agentcore deploys here.
  let deployMarkers: DeployMarker[] = [];
  try {
    const rows = config.mock.aurora
      ? mockCostDeployMarkers(windowHours)
      : await exec(`
      SELECT registered_at::text AS registered_at,
             agent_id, prompt_version, notes
        FROM observability.prompt_versions
       WHERE registered_at > now() - (INTERVAL '1 hour' * :hours)
       ORDER BY registered_at ASC`,
      [longParam('hours', windowHours)],
    );
    deployMarkers = rows.map((r) => ({
      registeredAt: String(r['registered_at'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      promptVersion: String(r['prompt_version'] ?? ''),
      notes: r['notes'] == null ? null : String(r['notes']),
    }));
  } catch (err) {
    console.warn('[oncall] /timeline deploys failed:', (err as Error).message);
    failures.push(`deploy markers: ${(err as Error).message}`);
  }

  const { alarms: activeAlarms, failedProbes } = await computeAlarms();
  if (failedProbes.length > 0) {
    failures.push(`alarms: could not evaluate ${failedProbes.join(' and ')}`);
  }

  const payload: TimelineResponse = { buckets, deployMarkers, activeAlarms };
  res.json(failures.length > 0 ? degraded(payload, new Error(failures.join('; '))) : payload);
}));

// ── GET /alarms ────────────────────────────────────────────────────────────

oncallRouter.get('/alarms', asyncHandler(async (_req, res) => {
  const { alarms, failedProbes } = await computeAlarms();
  res.json(failedProbes.length > 0
    ? degraded({ alarms }, new Error(`Could not evaluate ${failedProbes.join(' and ')}`))
    : { alarms });
}));

// ── GET /hitl-sla ──────────────────────────────────────────────────────────

// 5-minute decision SLA — same threshold as the server-side expiry on
// approvals.ts so "SLA compliant" lines up with "did not auto-expire".
const SLA_THRESHOLD_SECONDS = 5 * 60;

oncallRouter.get('/hitl-sla', asyncHandler(async (req, res) => {
  const windowHours = parseHours(req.query['windowHours'], 24, 24 * 14);

  try {
    const rows = config.mock.aurora
      ? mockOncallHitlSla(windowHours)
      : await exec(`
      WITH win AS (
        SELECT *,
               CASE WHEN decided_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (decided_at - requested_at))::float8
               END AS decision_seconds
          FROM observability.approvals
         WHERE requested_at > now() - (INTERVAL '1 hour' * :hours)
      )
      SELECT
        (SELECT COUNT(*)::bigint FROM observability.approvals
          WHERE status = 'PENDING') AS pending_count,
        (SELECT EXTRACT(EPOCH FROM (now() - MIN(requested_at)))::float8
           FROM observability.approvals
          WHERE status = 'PENDING') AS oldest_pending_age_s,
        (SELECT COUNT(*)::bigint FROM win
          WHERE decided_at IS NOT NULL AND status IN ('APPROVED','REJECTED')) AS decided,
        (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY decision_seconds)::float8
           FROM win WHERE decision_seconds IS NOT NULL) AS p50_s,
        (SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY decision_seconds)::float8
           FROM win WHERE decision_seconds IS NOT NULL) AS p99_s,
        (SELECT COUNT(*)::bigint FROM win WHERE status = 'EXPIRED') AS expired,
        (SELECT COUNT(*)::bigint FROM win
          WHERE decision_seconds IS NOT NULL AND decision_seconds < :sla) AS within_sla,
        (SELECT COUNT(*)::bigint FROM win
          WHERE decision_seconds IS NOT NULL) AS sla_total`,
      [longParam('hours', windowHours), longParam('sla', SLA_THRESHOLD_SECONDS)],
    );
    const r = rows[0] ?? {};
    const slaTotal = Number(r['sla_total'] ?? 0);
    const withinSla = Number(r['within_sla'] ?? 0);
    res.json({
      pendingCount: Number(r['pending_count'] ?? 0),
      oldestPendingAgeSeconds: r['oldest_pending_age_s'] == null
        ? null
        : Number(r['oldest_pending_age_s']),
      decidedInWindow: Number(r['decided'] ?? 0),
      // NULL from PERCENTILE_CONT over an empty set means "no decision had a
      // latency" — not "every decision took 0ms". Coalescing it to 0 reported
      // "p50 0.0s · p99 0.0s" for a queue nobody had decided anything in.
      p50DecisionSeconds: r['p50_s'] == null ? null : Number(r['p50_s']),
      p99DecisionSeconds: r['p99_s'] == null ? null : Number(r['p99_s']),
      expiredInWindow: Number(r['expired'] ?? 0),
      // Null rather than 1 over an empty sample. `slaTotal > 0 ? ... : 1` put
      // "SLA 100.0%" in success green on a queue nobody had decided anything
      // in — a compliance claim nobody earned, on the page someone reads
      // during an incident. Same convention as the harness compare endpoint
      // and mock/harness.ts's `withCounts`: a rate with no denominator is
      // absent, not perfect.
      slaCompliantFraction: slaTotal > 0 ? withinSla / slaTotal : null,
      slaThresholdSeconds: SLA_THRESHOLD_SECONDS,
    });
  } catch (err) {
    console.warn('[oncall] /hitl-sla failed:', (err as Error).message);
    res.json(degraded({
      pendingCount: 0,
      oldestPendingAgeSeconds: null,
      decidedInWindow: 0,
      p50DecisionSeconds: 0,
      p99DecisionSeconds: 0,
      expiredInWindow: 0,
      slaCompliantFraction: 1,
      slaThresholdSeconds: SLA_THRESHOLD_SECONDS,
    }, err));
  }
}));

// ── GET /recent-events ─────────────────────────────────────────────────────
// Unified event feed: deploys + alarms + HITL decisions + judge regressions.

oncallRouter.get('/recent-events', asyncHandler(async (req, res) => {
  const rawLimit = parseInt((req.query['limit'] as string) ?? '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 500)
    : 50;

  const events: RecentEvent[] = [];
  const failures: string[] = [];

  // 1) Deploys (prompt_versions registrations in last 24h)
  try {
    const rows = config.mock.aurora
      ? mockOncallRecentDeploys(24)
      : await exec(
      `SELECT registered_at::text AS ts,
              agent_id, prompt_version, notes
         FROM observability.prompt_versions
        WHERE registered_at > now() - INTERVAL '24 hours'
        ORDER BY registered_at DESC
        LIMIT 200`,
    );
    for (const r of rows) {
      const pv = String(r['prompt_version'] ?? '');
      const agentId = String(r['agent_id'] ?? '');
      events.push({
        ts: String(r['ts'] ?? ''),
        kind: 'deploy',
        severity: 'info',
        title: `Deploy: ${agentId}@${pv.slice(0, 6)}`,
        detail: r['notes'] == null ? `New prompt version registered` : String(r['notes']),
        relatedAgentId: agentId,
      });
    }
  } catch (err) {
    console.warn('[oncall] events:deploys failed:', (err as Error).message);
    failures.push(`deploys: ${(err as Error).message}`);
  }

  // 2) HITL decisions (decided + expired in last 24h)
  try {
    const rows = config.mock.aurora
      ? mockOncallHitlDecisionEvents(24)
      : await exec(
      `SELECT approval_id::text AS approval_id,
              decided_at::text AS ts,
              status, agent_id, decided_by, decided_note
         FROM observability.approvals
        WHERE decided_at IS NOT NULL
          AND decided_at > now() - INTERVAL '24 hours'
        ORDER BY decided_at DESC
        LIMIT 200`,
    );
    for (const r of rows) {
      const status = String(r['status'] ?? '');
      const agentId = String(r['agent_id'] ?? '');
      const decidedBy = String(r['decided_by'] ?? 'system');
      const note = r['decided_note'] == null ? '' : String(r['decided_note']);
      if (status === 'EXPIRED') {
        events.push({
          ts: String(r['ts'] ?? ''),
          kind: 'hitl-expired',
          severity: 'warning',
          title: `Approval expired (${agentId})`,
          detail: note || 'No human responded within 5 minutes',
          relatedAgentId: agentId,
        });
      } else {
        events.push({
          ts: String(r['ts'] ?? ''),
          kind: 'hitl-decided',
          severity: 'info',
          title: `${status} by ${decidedBy} (${agentId})`,
          detail: note || `Approval ${status.toLowerCase()}`,
          relatedAgentId: agentId,
        });
      }
    }
  } catch (err) {
    console.warn('[oncall] events:hitl failed:', (err as Error).message);
    failures.push(`hitl decisions: ${(err as Error).message}`);
  }

  // 3) Judge regressions — invocation_traces rows with judge_score < 0.3
  //    in last 24h. We don't try to dedupe (each bad row is its own event).
  try {
    const rows = config.mock.aurora
      ? mockOncallJudgeRegressions(24)
      : await exec(
      `SELECT invocation_id::text AS invocation_id,
              ts::text AS ts,
              agent_id, judge_score, judge_rationale, response_snippet
         FROM observability.invocation_traces
        WHERE ts > now() - INTERVAL '24 hours'
          AND judge_score IS NOT NULL
          AND judge_score < 0.3
          AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
        ORDER BY ts DESC
        LIMIT 200`,
    );
    for (const r of rows) {
      const agentId = String(r['agent_id'] ?? '');
      const score = r['judge_score'] == null ? null : Number(r['judge_score']);
      const rationale = r['judge_rationale'] == null ? '' : String(r['judge_rationale']);
      const snippet = r['response_snippet'] == null ? '' : String(r['response_snippet']);
      events.push({
        ts: String(r['ts'] ?? ''),
        kind: 'judge-spike',
        severity: score != null && score < 0.2 ? 'critical' : 'warning',
        title: `Judge regression: ${agentId} scored ${score == null ? '?' : score.toFixed(2)}`,
        detail: rationale || snippet.slice(0, 140),
        relatedInvocationId: String(r['invocation_id'] ?? ''),
        relatedAgentId: agentId,
      });
    }
  } catch (err) {
    console.warn('[oncall] events:judge failed:', (err as Error).message);
    failures.push(`judge regressions: ${(err as Error).message}`);
  }

  // 4) Active alarms — synthesize one event per current alarm so the feed
  //    has the same surface as the alarm chip strip.
  try {
    const { alarms, failedProbes } = await computeAlarms();
    if (failedProbes.length > 0) {
      failures.push(`alarms: could not evaluate ${failedProbes.join(' and ')}`);
    }
    for (const a of alarms) {
      if (a.severity === 'ok') continue;
      events.push({
        ts: a.firedAt ?? new Date().toISOString(),
        kind: 'alarm',
        // The event feed carries severities it can style; an unevaluated probe
        // is informational there rather than an alarm firing.
        severity: a.severity === 'unknown' ? 'info' : a.severity,
        title: `Alarm: ${a.name}`,
        detail: a.reason,
        relatedAgentId: a.affectedAgent ?? undefined,
      });
    }
  } catch (err) {
    console.warn('[oncall] events:alarms failed:', (err as Error).message);
    failures.push(`alarms: ${(err as Error).message}`);
  }

  // Sort newest-first and truncate.
  events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const payload = { events: events.slice(0, limit) };
  res.json(failures.length > 0 ? degraded(payload, new Error(failures.join('; '))) : payload);
}));

-- OrgIQ observability — Sprint 5 canary decision log + per-version score view.
--
-- This sprint introduces an automated canary controller for prompt-version
-- rollouts on `orgiq-expert-explainer` (and future canaried agents). The
-- controller compares a baseline prompt version (A) against a candidate (B)
-- using EMF metrics emitted by the runtime, then decides each cycle whether to
-- PROMOTE (raise B's traffic weight), ROLLBACK (drop B to 0), HOLD (keep the
-- current split), or FINALIZE_READY (B has earned full traffic). Each decision
-- is persisted to `observability.canary_decisions` for audit + UI replay.
--
-- The companion view `v_canary_score_by_version_5m` rolls invocation_traces
-- into 5-minute buckets keyed by version_label (A vs B), which is what the
-- controller's threshold logic and the portal's canary chart both read.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint5-canary-schema.sh
--
-- Idempotent (IF NOT EXISTS on tables/indexes, CREATE OR REPLACE on the view).
-- Safe to re-run on every boot.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- canary_decisions
--   One row per controller tick that produced a decision. action enumerates
--   every outcome the controller can emit, including the SKIPPED_* family
--   which records *why* the controller declined to act (manual override flag,
--   cooldown window, or insufficient samples). composite/error/latency
--   columns are the snapshot the decision was based on, copied from
--   v_canary_score_by_version_5m at decision time so the audit row is
--   self-contained even if the underlying traces are aged out. execution_arn
--   links back to the Step Functions / Lambda invocation that ran the
--   controller, for cross-referencing CloudWatch logs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.canary_decisions (
  id                    bigserial PRIMARY KEY,
  canary_name           text NOT NULL DEFAULT 'orgiq-expert-explainer',
  decided_at            timestamptz NOT NULL DEFAULT now(),
  prompt_version_a_arn  text NOT NULL,
  prompt_version_b_arn  text NOT NULL,
  action                text NOT NULL CHECK (action IN (
                          'PROMOTE',
                          'ROLLBACK',
                          'HOLD',
                          'FINALIZE_READY',
                          'SKIPPED_OVERRIDE',
                          'SKIPPED_COOLDOWN',
                          'SKIPPED_NO_SAMPLES'
                        )),
  weight_b_before       smallint NOT NULL,
  weight_b_after        smallint NOT NULL,
  composite_a           numeric(5,4),
  composite_b           numeric(5,4),
  error_rate_a          numeric(5,4),
  error_rate_b          numeric(5,4),
  latency_p95_a_ms      integer,
  latency_p95_b_ms      integer,
  sample_count_a        integer,
  sample_count_b        integer,
  reason                text,
  execution_arn         text
);

CREATE INDEX IF NOT EXISTS canary_decisions_canary_ts_idx
  ON observability.canary_decisions (canary_name, decided_at DESC);

COMMENT ON TABLE observability.canary_decisions IS
  'Audit log of every canary controller tick: which prompt versions were compared, what metrics they had, and what action (PROMOTE/ROLLBACK/HOLD/FINALIZE_READY or a SKIPPED_* reason) was taken on B''s traffic weight.';

-- ---------------------------------------------------------------------------
-- v_canary_score_by_version_5m
--   Rolls observability.invocation_traces into 5-minute buckets, grouped by
--   canary_name (sourced from agent_id today) and version_label (A vs B).
--
--   NOTE on version_label:
--     The existing invocation_traces table has a `prompt_version` column
--     (short SHA registered in observability.prompt_versions) but does NOT
--     yet have a `version_label` column distinguishing the canary A side
--     from the B side. The future EMF→Aurora projection (Sprint 5 telemetry
--     pipeline) will stamp invocation_traces.version_label = 'A' | 'B' at
--     ingest time, derived from the runtime routing decision recorded in
--     each EMF event. Until that projection ships, the view selects NULL
--     as the placeholder so downstream consumers can be wired up against
--     the final shape; the controller's metric path is EMF/CloudWatch
--     directly, and only the audit + portal-replay paths read this view.
--   Columns:
--     canary_name      — currently agent_id; the controller passes a single
--                        canaried agent name today.
--     version_label    — 'A' | 'B' placeholder, NULL until EMF projection
--                        fills it in.
--     bucket_5m        — start of the 5-minute window (timestamptz).
--     avg_composite    — mean judge_score across rows in the bucket.
--     error_count      — count of rows where guardrail_action <> 'NONE'
--                        OR schema_valid = false (proxy for invocation
--                        failure until a dedicated error column lands).
--     n                — total rows in the bucket for this (canary, label).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW observability.v_canary_score_by_version_5m AS
SELECT
  it.agent_id                                              AS canary_name,
  CAST(NULL AS text)                                       AS version_label,
  date_trunc('minute', it.ts)
    - (EXTRACT(MINUTE FROM it.ts)::int % 5) * INTERVAL '1 minute'
                                                           AS bucket_5m,
  AVG(it.judge_score)::numeric(5,4)                        AS avg_composite,
  COUNT(*) FILTER (
    WHERE (it.guardrail_action IS NOT NULL
           AND it.guardrail_action <> 'NONE')
       OR it.schema_valid = false
  )::int                                                   AS error_count,
  COUNT(*)::int                                            AS n
FROM observability.invocation_traces it
GROUP BY
  it.agent_id,
  date_trunc('minute', it.ts)
    - (EXTRACT(MINUTE FROM it.ts)::int % 5) * INTERVAL '1 minute';

COMMENT ON VIEW observability.v_canary_score_by_version_5m IS
  '5-minute rollup of invocation_traces by canary_name + version_label, feeding the canary controller audit path and portal replay chart. version_label is NULL until the EMF→Aurora projection adds it to invocation_traces; see schema header comment.';

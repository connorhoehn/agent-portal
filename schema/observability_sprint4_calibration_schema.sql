-- OrgIQ observability — Sprint 4 (M10) judge calibration schema.
--
-- M10  judge calibration: a curated set of (prompt, response, human_score)
--      tuples that an AI EA / researcher hand-grades. The LLM-as-judge
--      (Nova Pro) is periodically re-run over the set; the gap between
--      judge_score and human_score is "judge drift" — when MAE creeps up
--      the whole quality history loses its anchor, and we need to know.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint4-calibration-schema.sh
--
-- Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS). Safe
-- to re-run on every boot.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- calibration_set
--   Hand-graded ground truth. ~20 cases is enough to detect drift; large
--   enough to span the score spectrum (good / mediocre / bad / edge), small
--   enough that the periodic re-judge is cheap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.calibration_set (
  calibration_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text NOT NULL,
  prompt          text NOT NULL,
  response        text NOT NULL,
  human_score     numeric(4,3) NOT NULL,        -- 0.000 to 1.000
  human_rationale text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  notes           text
);
CREATE INDEX IF NOT EXISTS calibration_set_active_idx
  ON observability.calibration_set (active, agent_id);

-- ---------------------------------------------------------------------------
-- calibration_runs
--   One row per "re-judge the whole active set" execution. label disambiguates
--   monthly cadence vs ad-hoc smoke runs; judge_model_id pins the model so a
--   spike in MAE can be traced to a model swap rather than a real drift event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.calibration_runs (
  calibration_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label              text NOT NULL,                  -- 'monthly@2026-05'
  judge_model_id     text NOT NULL,
  total_cases        integer NOT NULL DEFAULT 0,
  mean_abs_error     numeric(4,3),                   -- judge vs human MAE
  max_abs_error      numeric(4,3),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  notes              text
);
CREATE INDEX IF NOT EXISTS calibration_runs_started_idx
  ON observability.calibration_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- calibration_results
--   Per-case result for a given run. Joined back to calibration_set when the
--   UI needs the prompt + response + human_score to render the scatter plot
--   and the worst-disagreements table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observability.calibration_results (
  calibration_run_id uuid NOT NULL REFERENCES observability.calibration_runs(calibration_run_id) ON DELETE CASCADE,
  calibration_id     uuid NOT NULL REFERENCES observability.calibration_set(calibration_id),
  judge_score        numeric(4,3),
  judge_rationale    text,
  abs_error          numeric(4,3),                   -- |judge_score - human_score|
  PRIMARY KEY (calibration_run_id, calibration_id)
);

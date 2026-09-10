-- Work-item estimates — what a forecast said, who stood behind it, and when.
--
-- WHY THIS EXISTS. `work_items.estimated_cost_usd` has been in the schema since
-- program_schema.sql, described as "expected agent spend to deliver this item —
-- complexity priced through the repo-calibrated $/point curve". Nothing ever
-- read it. The marketplace drawer sends `{model, points}` to /api/bots/estimate
-- and recomputes from scratch every time it opens, so the number an operator
-- authorized against existed only for the life of that drawer. There was no
-- author, no timestamp, and no review anywhere in any schema file.
--
-- That is a real gap on a money path. "≈ $0.03–$0.30" with nobody's name on it
-- is a suggestion; the same figure with "estimated by Nora Chang, 20 minutes
-- ago, on Haiku" is a decision somebody can be asked about.
--
-- THE MODEL IS PART OF THE ESTIMATE, NOT METADATA ABOUT IT. Measured on one
-- 5-point story in this repo: Haiku forecast $0.03–$0.30 over 1–6 min, Opus
-- $0.60–$5.00 over 5–30 min. A 20x spread on identical complexity. So a stored
-- estimate is only valid for the model it was computed against, and
-- `estimate_model` is what makes a reader able to tell. Displaying a Haiku
-- estimate while Opus is selected would be worse than showing none.
--
-- ATTRIBUTION STARTS GOING FORWARD, exactly as agent_run_attribution_schema.sql
-- reasoned about `bot_runs.dispatched_by`:
--
--   * every work item that existed before this migration has estimated_by NULL
--     and is attributed to nobody — that is correct, not missing data;
--   * an item whose estimate was never authorized keeps NULL: recomputing a
--     forecast in a drawer someone then cancelled is not an estimate anybody
--     made, and recording it would invent a decision;
--   * only an authorized dispatch writes these columns, and the subject comes
--     from the session, never from a request body.
--
-- REVIEW IS ADVISORY, DELIBERATELY. `estimate_reviewed_by` records that an SME
-- looked at the forecast; it does NOT gate dispatch. The dispatch path already
-- refuses four ways — grant-scoped 403, per-run cap, initiative allocation,
-- sprint envelope — and a fifth hard gate is how a fleet gets wedged by a
-- reviewer who is on holiday. Advisory can become blocking in one predicate;
-- un-wedging a blocked fleet is a much worse afternoon. If that call is wrong,
-- the column is already here and only the gate needs adding.

ALTER TABLE work_items
  -- The session subject that authorized the dispatch this estimate was shown
  -- for. TEXT, not a people(id) FK: app_users and the org graph are separate
  -- populations, and `bot_runs.dispatched_by` already records a subject the
  -- same way. An account with no linked person still authorized the spend.
  ADD COLUMN IF NOT EXISTS estimated_by          TEXT,
  ADD COLUMN IF NOT EXISTS estimated_at          TIMESTAMPTZ,
  -- The model the forecast was computed against. Without this the stored
  -- number cannot be trusted for the model currently selected — see above.
  ADD COLUMN IF NOT EXISTS estimate_model        TEXT,
  -- The forecast itself, as shown: p25/p75 cost and minutes, basis, sample
  -- count, confidence. Stored whole rather than split into columns because it
  -- is a record of what an operator was looking at, and a later change to the
  -- forecast's shape must not silently reinterpret an old one.
  ADD COLUMN IF NOT EXISTS estimate_forecast     JSONB,
  -- Advisory SME sign-off. Null means nobody has reviewed, which is the
  -- ordinary case and is not a warning.
  ADD COLUMN IF NOT EXISTS estimate_reviewed_by  TEXT,
  ADD COLUMN IF NOT EXISTS estimate_reviewed_at  TIMESTAMPTZ;

COMMENT ON COLUMN work_items.estimated_by IS
  'Session subject that authorized the dispatch this estimate was shown for. '
  'NULL for every item predating the migration and for any item whose estimate '
  'was never authorized — attributed to nobody, which is correct.';

COMMENT ON COLUMN work_items.estimate_model IS
  'Model the stored forecast was computed against. A forecast is only valid '
  'for its own model: Haiku vs Opus measured 20x apart on identical points.';

COMMENT ON COLUMN work_items.estimate_reviewed_by IS
  'Advisory SME sign-off on the estimate. Does NOT gate dispatch — see the '
  'header of this file for why a fifth hard gate was refused.';

-- Read pattern is "does this item have a current estimate for the model I am
-- about to use", so the useful index is the pair, not either column alone.
CREATE INDEX IF NOT EXISTS work_items_estimate_model_idx
  ON work_items (id, estimate_model)
  WHERE estimate_model IS NOT NULL;

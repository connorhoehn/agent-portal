-- Program operating model — sprints, SME budget grants, and cost-based
-- estimation on work items.
--
-- The frame (see docs/program-operating-model.md): one person owns each
-- initiative, SMEs attach across initiatives, and a release manager funds work
-- by granting an SME a spend envelope for a sprint. Work is estimated in
-- complexity (story points) and dollars (agent spend), never human hours.
-- Bots are the baseline cost of maintaining an initiative's repos; the view at
-- the bottom is that baseline.
--
-- Loads after orgiq_schema.sql (people, projects), orgiq_work_items_schema.sql
-- (work_items) and agent_bots_schema.sql (bots, bot_runs).

-- ---------------------------------------------------------------------------
-- Sprints — the cadence an SME sees their budget through
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sprints (
  id                 TEXT PRIMARY KEY DEFAULT ('spr-' || gen_random_uuid()::TEXT),
  org_project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,             -- 'Sprint 14', 'PI-3 Iteration 2'
  goal               TEXT,
  -- The SME who sees this sprint through with the budget granted to them.
  steward_person_id  TEXT REFERENCES people(id) ON DELETE SET NULL,
  starts_on          DATE NOT NULL,
  ends_on            DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','active','done')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on > starts_on)
);

CREATE INDEX IF NOT EXISTS sprints_project_idx ON sprints (org_project_id, starts_on DESC);

COMMENT ON TABLE sprints IS
  'Iteration cadence per initiative. steward_person_id is the SME accountable '
  'for the sprint; their spend envelope is the budget_grants row pointing here.';

-- ---------------------------------------------------------------------------
-- Budget grants — release manager hands an SME an envelope
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budget_grants (
  id                 TEXT PRIMARY KEY DEFAULT ('bg-' || gen_random_uuid()::TEXT),
  org_project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Null = an initiative-level standing grant rather than one sprint's.
  sprint_id          TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  grantee_person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  allocated_usd      NUMERIC NOT NULL CHECK (allocated_usd >= 0),
  -- Who authorized it (app_users sub) and why. Burn is never stored here — it
  -- is derived at read time from bot_runs attributed to the initiative inside
  -- the sprint window, same discipline as initiative_budgets.
  granted_by         TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS budget_grants_project_idx ON budget_grants (org_project_id);
CREATE INDEX IF NOT EXISTS budget_grants_grantee_idx ON budget_grants (grantee_person_id);

COMMENT ON TABLE budget_grants IS
  'A release manager''s allocation of agent spend to an SME, usually scoped to '
  'one sprint. The SME dispatches bots/marketplace runs against the envelope.';

-- ---------------------------------------------------------------------------
-- Work items gain sprint membership and a dollar estimate
-- ---------------------------------------------------------------------------

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS sprint_id          TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC;

COMMENT ON COLUMN work_items.estimated_cost_usd IS
  'Expected agent spend to deliver this item — complexity (story_points) '
  'priced through the repo-calibrated $/point curve the marketplace uses. '
  'Never a human-hour figure.';

CREATE INDEX IF NOT EXISTS work_items_sprint_idx ON work_items (sprint_id);

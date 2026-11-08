-- Spend holds (docs/deployment-enhancements/DE-34-spend-holds.md).
--
-- A dispatch used to read the allocation and the caller's envelope, judge the
-- forecast, and start the run with nothing written in between; spend appeared
-- only once the run settled. So N concurrent dispatches on one initiative all
-- saw the same remainder and all passed. A hold is the forecast's p75 written
-- at dispatch, under an advisory lock on the initiative (then the grant), and
-- counted as spent by every brake until the ledger entry for the same
-- (source, source_id) lands — at which point the hold settles in the same
-- transaction, so held money becomes spent money once, never both or neither.
--
-- Named a HOLD, not a reservation: lib/devbox-fleet.ts already reserves boxes.
--
-- The source list matches spend_entries. Loads after spend_ledger_schema.sql
-- (FKs projects and budget_grants, same as the ledger). Additive.

CREATE TABLE IF NOT EXISTS spend_holds (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  grant_id       TEXT REFERENCES budget_grants (id) ON DELETE SET NULL,
  -- Who caused the hold: the session subject or principal.requestedBy. Null
  -- for a cron firing. A per-user lock and budget (goal row "user budgets")
  -- will read this column; the lock order is initiative, grant, then user.
  actor_id       TEXT,
  source         TEXT NOT NULL CHECK (source IN ('bot_run', 'job', 'box_task', 'agent_loop', 'agent_project_run', 'agent_invoke', 'microvm', 'voice_session')),
  -- The key spend_entries uses for the same attempt; set once the row exists.
  source_id      TEXT,
  amount_usd     NUMERIC(10,4) NOT NULL CHECK (amount_usd >= 0),
  basis          TEXT NOT NULL CHECK (basis IN ('p75', 'confirmed_over', 'topup')),
  status         TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'released', 'expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ,
  UNIQUE (source, source_id)
);

-- The source list as a named constraint, so adding a path is a re-apply of
-- this file (agent_invoke: a chat invoke or a /summarize run, work item 16;
-- microvm: one microVM runner attempt, docs/microvm-runner-design.md §6;
-- voice_session: one voice navigator session, docs/voice-navigator-spec.md §7).
ALTER TABLE spend_holds DROP CONSTRAINT IF EXISTS spend_holds_source_check;
ALTER TABLE spend_holds ADD CONSTRAINT spend_holds_source_check
  CHECK (source IN ('bot_run', 'job', 'box_task', 'agent_loop', 'agent_project_run', 'agent_invoke', 'microvm', 'voice_session'));

CREATE INDEX IF NOT EXISTS spend_holds_open_idx ON spend_holds (initiative_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_grant_open_idx ON spend_holds (grant_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS spend_holds_actor_open_idx ON spend_holds (actor_id) WHERE status = 'held';

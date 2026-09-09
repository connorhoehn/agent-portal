-- Devbox fleet — the computers the lab has provisioned, remembered across
-- restarts.
--
-- WHY THIS TABLE EXISTS. The fleet registry lives in two module-level Maps in
-- `middleware/src/lib/devbox-fleet.ts`. That is the right shape for a hot,
-- per-request read — and it meant a middleware restart dropped every box while
-- the AgentCore sessions carried on running. Verified live on 2026-09-09:
-- after a restart `GET /api/devbox/boxes` returned an empty fleet while the
-- orphaned microVM still answered commands with its workspace intact.
--
-- That is not merely a display bug. `devbox-reaper` reaps whatever
-- `listBoxes()` returns, so a session the registry has forgotten sits outside
-- BOTH the 20-minute idle timeout and the 60-minute lifetime ceiling —
-- permanently. Those ceilings are the only thing stopping an idle microVM
-- billing forever, and under `tsx watch` the registry was cleared on every
-- file save.
--
-- It cannot be fixed by asking AWS. There is no AgentCore API that enumerates
-- live *runtime* sessions to reconcile against — `list-sessions` is AgentCore
-- Memory, not Runtime. `stop-runtime-session` works, but only if you already
-- know the session id. So the registry has to remember, which is this table.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * The event buffer. It is a capped in-memory cache of a stream that has
--     already ended; replaying a pre-restart run into a live tail would be
--     worse than an empty one.
--   * `context_used` / the per-task token count. Those reset at `task_started`
--     by design, so persisting them would restore a number that is only ever
--     true mid-task.
--   * Any workspace contents. `/mnt/workspace` is session storage owned by
--     AgentCore and wiped on every runtime version update; this table records
--     that a box EXISTS, never what is in it.
--
-- The two timestamp columns are the load-bearing ones: `created_at` is what
-- the lifetime ceiling measures from and `last_activity_at` is what the idle
-- timer measures from. Restoring a box with fresh timestamps would leave it
-- visible and still unable to age out — the same leak, only quieter — so the
-- loader writes these straight into the registry rather than re-stamping them.

CREATE TABLE IF NOT EXISTS devbox_boxes (
  -- The short id the API and UI address a box by (the session id's tail).
  id                TEXT PRIMARY KEY,
  -- The AgentCore runtimeSessionId. Unique because it is the identity the
  -- runtime itself knows, and the only handle `stop-runtime-session` accepts —
  -- two rows claiming one session would make a stop ambiguous.
  session_id        TEXT NOT NULL UNIQUE,
  label             TEXT,
  -- Attribution, taken from the session and never from a request body. Null
  -- for boxes the fleet made for itself (job dispatcher, bot runner).
  owner_id          TEXT,
  -- Set when the computer is charged to an initiative, which also shares it
  -- with everyone attached to that initiative (lib/devbox-visibility.ts).
  project_id        TEXT,
  status            TEXT NOT NULL DEFAULT 'idle',
  created_at        TIMESTAMPTZ NOT NULL,
  last_activity_at  TIMESTAMPTZ NOT NULL,
  -- Lifetime cost-centre totals, so a restart does not reset what a box has
  -- cost. Both are monotonic; the per-task figures are not stored (see above).
  spend_usd         NUMERIC,
  tokens_used       BIGINT,
  active_model      TEXT
);

-- The reaper's sweep reads every row and the visibility filter groups by
-- initiative; both are small scans today, but `project_id` is the one column a
-- fleet-wide role's page filters on often enough to be worth an index.
CREATE INDEX IF NOT EXISTS idx_devbox_boxes_project ON devbox_boxes (project_id);
CREATE INDEX IF NOT EXISTS idx_devbox_boxes_owner ON devbox_boxes (owner_id);

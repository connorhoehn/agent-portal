-- Agent projects — repositories that agents work on.
--
-- Named `agent_projects`, not `projects`: `projects` is already the org
-- graph's own table (initiatives people contribute to) and the two are
-- unrelated. Reusing the name once already cost the graph its data.
--
-- Deliberately not a mirror of GitHub. The familiar surfaces there exist to
-- coordinate humans: issue lists, review threads, comment history, who
-- reacted to what. None of that applies to a repository whose contributors
-- are agents — there is nobody to coordinate with, and rendering an empty
-- discussion tab is worse than rendering nothing.
--
-- What matters instead is: which workspace holds this checkout, what has been
-- run against it, what changed as a result, and whether it worked. That is
-- what these tables record.

CREATE TABLE IF NOT EXISTS agent_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- owner/name. Unique because linking the same repo twice would give two
  -- histories for one thing.
  repo_full_name  TEXT        NOT NULL UNIQUE,
  default_branch  TEXT        NOT NULL DEFAULT 'main',

  -- Which stored credential reaches it. Null for a public repo, which needs
  -- none — and a project that needs no secret should not be made to have one.
  connection_name TEXT,

  -- The devbox holding the checkout. Null until first opened; a project is a
  -- durable thing and a workspace is not.
  session_id      TEXT,
  workspace_path  TEXT        NOT NULL DEFAULT '/mnt/workspace',
  cloned_at       TIMESTAMPTZ,

  -- The initiative this repository implements.
  --
  -- An enterprise project has people who own it and code that delivers it;
  -- `projects` holds the first and this holds the second. Keeping them linked
  -- is what lets a run against a repo be attributed to the work it serves, and
  -- what lets an initiative show the code its agents are changing.
  org_project_id  TEXT REFERENCES projects (id) ON DELETE SET NULL,

  added_by        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_projects_session ON agent_projects (session_id);

-- Every agent run against a project, and what came of it.
--
-- This is the activity feed the product actually needs. A run is the unit:
-- what was asked, which model answered, how long it took, what it cost, and
-- whether the working tree ended up different afterwards.
CREATE TABLE IF NOT EXISTS agent_project_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES agent_projects (id) ON DELETE CASCADE,

  prompt        TEXT        NOT NULL,
  model         TEXT,
  session_id    TEXT,

  status        TEXT        NOT NULL DEFAULT 'running',   -- running | done | failed
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,

  -- The outcome worth recording: did the repository change.
  files_changed INTEGER,
  diff_summary  TEXT,
  error         TEXT,
  cost_usd      NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_agent_project_runs_project ON agent_project_runs (project_id, started_at DESC);

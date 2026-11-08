-- Devbox policy profiles (DE-40) and the one lifetime model (DE-48).
--
-- A profile is the rule set a box runs under: which models it may bill, how
-- long one task may run, how long the box may sit idle or live, which network
-- class and org-data access its runtime carries. Before this every knob was
-- deploy-wide and lived in a different place (CDK env, the image, the reaper's
-- module constants); none was keyed by initiative, and changing the model
-- allowlist meant redeploying the runtime, which wipes every workspace.
--
-- Rows are APPEND-ONLY: an edit inserts (id, version + 1). A box records the
-- (profile_id, profile_version) it was created under on its fleet row, so a
-- running box never changes rules mid-task; the reaper may only ever use a
-- newer version to shorten a lifetime, never to lengthen one.
--
-- `network_class` and `org_access` are deploy-time facts (AgentCore fixes
-- network mode and the execution role per runtime). A profile NAMES a class;
-- it never carries a runtime ARN. `default` names the fleet runtime
-- (public / none); `restricted` names the microVM runner's (egress-allowlist /
-- none, docs/microvm-runner-design.md §5).
--
-- Additive and idempotent. Loads after orgiq_schema.sql (projects) and
-- devbox_fleet_schema.sql (devbox_boxes), both of which it alters.

CREATE TABLE IF NOT EXISTS devbox_profiles (
  id                   TEXT        NOT NULL,            -- 'default', 'restricted', ...
  version              INTEGER     NOT NULL CHECK (version >= 1),
  -- Allowlisted inference-profile ids; the FIRST is the default a task gets
  -- when it names none. The BFF always sends the model explicitly.
  models               JSONB       NOT NULL,
  -- Per-task ceiling. 3300 s is the streaming-connection bound the image
  -- enforces as its own defence (agents/devbox/main.py MAX_TIMEOUT_S).
  task_timeout_s       INTEGER     NOT NULL CHECK (task_timeout_s BETWEEN 60 AND 3300),
  -- Nobody has touched the box. Must stay under AgentCore's own 60-minute
  -- idle stop so the reaper, which records a reason, fires first.
  idle_minutes         INTEGER     NOT NULL CHECK (idle_minutes BETWEEN 1 AND 59),
  -- Box ceiling for a box that is NOT running (DE-48: a running box is bounded
  -- by its task's own timeout plus grace). 480 is AgentCore's maxLifetime.
  max_lifetime_minutes INTEGER     NOT NULL CHECK (max_lifetime_minutes BETWEEN 1 AND 480),
  network_class        TEXT        NOT NULL CHECK (network_class IN ('public', 'egress-allowlist')),
  org_access           TEXT        NOT NULL CHECK (org_access IN ('none', 'read')),
  created_by           TEXT        NOT NULL,            -- session sub, or 'seed'
  reason               TEXT        NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version)
);

-- Which profile an initiative's boxes are created under. NULL = 'default'.
-- Only a published profile id may be named (checked by the BFF, not an FK:
-- the profile table is versioned and a plain FK would need a version too).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS devbox_profile_id TEXT;

-- The rules a box was created under, and when its current task began. The
-- reaper reads `task_started_at` to bound a RUNNING box by its task (DE-48)
-- instead of by box age, which used to cut a long task on an old box.
ALTER TABLE devbox_boxes ADD COLUMN IF NOT EXISTS profile_id      TEXT;
ALTER TABLE devbox_boxes ADD COLUMN IF NOT EXISTS profile_version INTEGER;
ALTER TABLE devbox_boxes ADD COLUMN IF NOT EXISTS task_started_at TIMESTAMPTZ;

-- Version 1 of `default` copies what the deployment enforced before profiles
-- existed: the three-model allowlist the image and the CDK stack carried, the
-- 840 s task default, 20 idle minutes, public network, no org access. The box
-- ceiling is DE-48's 4 h (a codebase's checkout survives a working session;
-- the idle timer still stops a forgotten box after 20 minutes). The BFF also
-- bootstraps this row lazily when the table is empty, so a cluster this file
-- has not reached is still governed.
INSERT INTO devbox_profiles
  (id, version, models, task_timeout_s, idle_minutes, max_lifetime_minutes, network_class, org_access, created_by, reason)
VALUES
  ('default', 1,
   '["us.anthropic.claude-haiku-4-5-20251001-v1:0","us.anthropic.claude-sonnet-5","us.anthropic.claude-opus-4-8"]'::jsonb,
   840, 20, 240, 'public', 'none', 'seed', 'Seeded from the pre-profile deployment values (DE-40).')
ON CONFLICT (id, version) DO NOTHING;

-- Version 1 of `restricted`: the microVM runner's profile
-- (docs/microvm-runner-design.md §5, §13). `egress-allowlist` resolves to the
-- `orgiq_microvm` runtime (VPC mode, GitHub-only egress, Bedrock through the
-- VPC endpoint); no org data (there is no Aurora or KB path in the allowlist);
-- Haiku and Sonnet only. Idle 5 minutes matches the runtime's
-- idleRuntimeSessionTimeout 300; the ceiling is the task timeout plus 900 s
-- rounded up to the hour (§7). Nothing points an initiative at it: that is
-- `PUT /api/projects/:id` with devboxProfileId 'restricted'.
INSERT INTO devbox_profiles
  (id, version, models, task_timeout_s, idle_minutes, max_lifetime_minutes, network_class, org_access, created_by, reason)
VALUES
  ('restricted', 1,
   '["us.anthropic.claude-haiku-4-5-20251001-v1:0","us.anthropic.claude-sonnet-5"]'::jsonb,
   840, 5, 60, 'egress-allowlist', 'none', 'seed', 'The microVM runner profile (docs/microvm-runner-design.md §13).')
ON CONFLICT (id, version) DO NOTHING;

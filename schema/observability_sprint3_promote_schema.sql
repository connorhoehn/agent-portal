-- OrgIQ observability — Sprint 3 (M8) prompt-promote columns.
--
-- M8  pre-deploy assurance: when a researcher has just compared run B against
--      run A and decided B's prompt version is good, they "promote" the
--      version. The portal calls POST /api/observability/harness/promote which
--      stamps promoted_at + promoted_by + promote_notes on the prompt_versions
--      row. Filtered queries then surface only blessed-for-prod versions.
--
-- Apply via:
--   ./infra/scripts/apply-observability-sprint3-promote-schema.sh
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS). Safe to
-- re-run on every boot.

CREATE SCHEMA IF NOT EXISTS observability;

-- ---------------------------------------------------------------------------
-- Prompt-promote columns. Sprint 1 created observability.prompt_versions; we
-- only add the audit columns here.
-- ---------------------------------------------------------------------------
ALTER TABLE observability.prompt_versions
  ADD COLUMN IF NOT EXISTS promoted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS promoted_by    text,
  ADD COLUMN IF NOT EXISTS promote_notes  text;

-- ---------------------------------------------------------------------------
-- Filter index: "what's blessed for this agent, newest first". NULLS LAST so
-- never-promoted rows fall to the tail when sorted by promoted_at DESC.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS prompt_versions_promoted_idx
  ON observability.prompt_versions (agent_id, promoted_at DESC NULLS LAST);

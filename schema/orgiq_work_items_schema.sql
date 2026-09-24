-- Work-item hierarchy for OrgIQ Projects.
-- Deliberately flat: Epic → Story | Bug, and that's the tree. Stories and bugs
-- are the dispatchable units; epics roll up progress and spend. Both levels
-- live in one self-referencing table (work_items) keyed by type so queries can
-- cross levels without joins. (The original four-type Epic → Feature → Story
-- → Task hierarchy collapsed to two levels — see the migration at the bottom.)
--
-- Decisions are linked to projects and gain a status+escalation model so they
-- can surface inside the project work view and be routed to the right roles.

-- ─────────────────────────────────────────────────────────────────────────────
-- work_items
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY DEFAULT ('wi-' || gen_random_uuid()::TEXT),
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('epic','story','bug')),
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','in_review','done','cancelled')),
  priority     TEXT NOT NULL DEFAULT 'medium'
               CHECK (priority IN ('critical','high','medium','low')),
  assignee_id  TEXT REFERENCES people(id) ON DELETE SET NULL,
  labels       TEXT[],              -- e.g. {'kubernetes','infra','backend'}
  story_points INTEGER,             -- used on story level
  pr_url       TEXT,                -- mock GitHub PR link
  pr_status    TEXT CHECK (pr_status IN ('open','draft','merged','closed') OR pr_status IS NULL),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

COMMENT ON TABLE work_items IS
  'Epic/Story/Bug two-level hierarchy. parent_id links child to parent. '
  'type enforces the level; hierarchy rules are application-enforced: '
  'epic.parent_id IS NULL, story.parent_id = epic|NULL, bug.parent_id = epic|NULL.';

CREATE INDEX IF NOT EXISTS work_items_project_id_idx  ON work_items (project_id);
CREATE INDEX IF NOT EXISTS work_items_parent_id_idx   ON work_items (parent_id);
CREATE INDEX IF NOT EXISTS work_items_assignee_id_idx ON work_items (assignee_id);
CREATE INDEX IF NOT EXISTS work_items_status_idx      ON work_items (status);
CREATE INDEX IF NOT EXISTS work_items_type_idx        ON work_items (type);

-- ─────────────────────────────────────────────────────────────────────────────
-- Upgrade decisions: add status, escalation, and project link
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'open'
                                          CHECK (status IN ('open','escalated','resolved','rejected')),
  ADD COLUMN IF NOT EXISTS project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution     TEXT,
  ADD COLUMN IF NOT EXISTS required_role  TEXT,    -- e.g. 'org-leader', 'hr-admin'
  ADD COLUMN IF NOT EXISTS escalated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS work_item_id   TEXT REFERENCES work_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN decisions.status IS
  'open = needs decision, escalated = blocking and routed to required_role, '
  'resolved = accepted, rejected = dismissed.';

CREATE INDEX IF NOT EXISTS decisions_project_id_idx ON decisions (project_id);
CREATE INDEX IF NOT EXISTS decisions_status_idx     ON decisions (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Upgrade projects: add description + github_url
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS github_url  TEXT,
  ADD COLUMN IF NOT EXISTS owner_id    TEXT REFERENCES people(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- work_item_comments  (must be created before v_work_item_summary)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_item_comments (
  id           TEXT PRIMARY KEY DEFAULT ('wic-' || gen_random_uuid()::TEXT),
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES people(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  is_system    BOOLEAN NOT NULL DEFAULT FALSE,  -- true = status-change event
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE work_item_comments IS
  'Threaded comments on work items. is_system=true rows are auto-generated '
  'audit events (status changes, assignments) shown differently in the UI.';

CREATE INDEX IF NOT EXISTS wic_work_item_id_idx ON work_item_comments (work_item_id);
CREATE INDEX IF NOT EXISTS wic_author_id_idx    ON work_item_comments (author_id);
CREATE INDEX IF NOT EXISTS wic_created_at_idx   ON work_item_comments (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- work_item_criteria — the acceptance-criteria checklist on a work item
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_item_criteria (
  id           TEXT PRIMARY KEY DEFAULT ('wicr-' || gen_random_uuid()::TEXT),
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  done         BOOLEAN NOT NULL DEFAULT FALSE,
  position     INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE work_item_criteria IS
  'Ordered acceptance-criteria checklist on a work item. position is dense '
  '0..n-1 within a work_item_id; the API renumbers siblings on insert/move/delete '
  'so the ordering never carries a gap. No UNIQUE(work_item_id, position) — a '
  'renumber lands as one UPDATE ... FROM a ROW_NUMBER() window (see '
  'renumberWorkItemCriteria in providers/work-items.ts, the same shape as '
  'moveKnowledgeNodeRow in providers/assessment-aurora.ts), and Postgres checks a '
  'non-deferred unique constraint per row rather than after the statement, which '
  'would spuriously reject a plain two-item swap.';

CREATE INDEX IF NOT EXISTS wicr_work_item_position_idx
  ON work_item_criteria (work_item_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- View: v_work_item_summary — denormalised for fast list rendering
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_work_item_summary AS
SELECT
  wi.id,
  wi.project_id,
  p.name              AS project_name,
  wi.parent_id,
  wi.type,
  wi.title,
  wi.status,
  wi.priority,
  wi.labels,
  wi.story_points,
  wi.pr_url,
  wi.pr_status,
  wi.created_at,
  wi.updated_at,
  wi.completed_at,
  a.id                AS assignee_id,
  a.name              AS assignee_name,
  a.title             AS assignee_title,
  a.team              AS assignee_dept,
  -- child counts
  (SELECT COUNT(*) FROM work_items c WHERE c.parent_id = wi.id)               AS child_count,
  (SELECT COUNT(*) FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count,
  -- comment count
  (SELECT COUNT(*) FROM work_item_comments wic WHERE wic.work_item_id = wi.id AND NOT wic.is_system) AS comment_count
FROM work_items wi
JOIN projects p ON p.id = wi.project_id
LEFT JOIN people a ON a.id = wi.assignee_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- View: v_decision_queue — decisions that need resolution, newest first
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_decision_queue AS
SELECT
  d.id,
  d.topic,
  d.summary,
  d.status,
  d.required_role,
  d.project_id,
  p.name          AS project_name,
  d.escalated_at,
  d.decided_at,
  d.work_item_id,
  wi.title        AS work_item_title,
  COUNT(dp.person_id) AS participant_count
FROM decisions d
LEFT JOIN projects p  ON p.id  = d.project_id
LEFT JOIN work_items wi ON wi.id = d.work_item_id
LEFT JOIN decision_participants dp ON dp.decision_id = d.id
GROUP BY d.id, p.name, wi.title
ORDER BY
  CASE d.status WHEN 'escalated' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
  COALESCE(d.escalated_at, d.created_at) DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: collapse Epic → Feature → Story → Task to Epic → Story | Bug
-- ─────────────────────────────────────────────────────────────────────────────
-- The marketplace dispatches stories and bugs; epics roll up. Every statement
-- here is safe to re-run: on a fresh database (created with the two-level
-- CHECK above) the updates match nothing and the constraint swap is a no-op
-- rename. On an existing database the UPDATEs must run BEFORE the constraint
-- is re-added, or the old feature/task rows would violate it.
-- (Neither v_work_item_summary nor v_decision_queue filters on specific type
-- values — they pass wi.type through — so the views need no change.)

-- Retype first: features and tasks both become stories (they were the
-- mid-grain units of work; bugs are a new type with no legacy rows).
UPDATE work_items SET type = 'story' WHERE type IN ('feature','task');

-- Epics are roots in a two-level tree, unconditionally.
UPDATE work_items SET parent_id = NULL WHERE type = 'epic' AND parent_id IS NOT NULL;

-- Re-parent to keep a strict two-level tree. Rule: any item whose parent is
-- not an epic is re-parented to its NEAREST EPIC ANCESTOR, or NULL when the
-- chain reaches a root without passing an epic. Each pass hoists such items
-- one level (to their grandparent); the loop runs to fixpoint, so arbitrarily
-- deep legacy chains (epic → feature → story → task) all land on the epic.
DO $$
DECLARE
  moved INTEGER;
BEGIN
  LOOP
    UPDATE work_items wi
       SET parent_id = parent.parent_id
      FROM work_items parent
     WHERE wi.parent_id = parent.id
       AND parent.type <> 'epic';
    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;
  END LOOP;
END $$;

-- Only after the data conforms: swap the CHECK to the two-level taxonomy.
ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_type_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_type_check
  CHECK (type IN ('epic','story','bug'));

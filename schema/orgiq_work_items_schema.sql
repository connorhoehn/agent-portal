-- Work-item hierarchy for OrgIQ Projects.
-- Mirrors GitHub/GitLab concepts: Epic → Feature → Story → Task.
-- All four levels live in one self-referencing table (work_items) keyed by type
-- so queries can cross levels without four-table joins.
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
  type         TEXT NOT NULL CHECK (type IN ('epic','feature','story','task')),
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
  'Epic/Feature/Story/Task hierarchy. parent_id links child to parent level. '
  'type enforces the level; hierarchy rules are application-enforced: '
  'epic.parent_id IS NULL, feature.parent_id = epic, story.parent_id = feature|epic, '
  'task.parent_id = story|feature|epic.';

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
  a.department        AS assignee_dept,
  -- child counts
  (SELECT COUNT(*) FROM work_items c WHERE c.parent_id = wi.id)               AS child_count,
  (SELECT COUNT(*) FROM work_items c WHERE c.parent_id = wi.id AND c.status = 'done') AS child_done_count
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

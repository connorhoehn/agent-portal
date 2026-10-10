-- Which app users are on which assessment team (docs/communication-plane-goal.md
-- §1.3, "My teams"; docs/audit/2026-10-07-audit-plan.md D4). Additive: every
-- statement is IF NOT EXISTS / ON CONFLICT DO NOTHING, so it is safe on an
-- up-to-date cluster. Loads after assessment_schema.sql (assessment_teams) and
-- identity_schema.sql (app_users).
--
-- Before this table the Communication plane decided "on a team" by matching the
-- directory's display name or email against assessment_teams.assessment_lead /
-- contributors / contacts. Those stay what they are — the team's named people,
-- free text — and this table is the one link an app account has to a team.
-- middleware/src/providers/assessment-team-members.ts reads it; while it is
-- missing on a cluster the plane answers no memberships and says why in
-- `limits`, never a guess.

CREATE TABLE IF NOT EXISTS assessment_team_members (
  team_id   TEXT NOT NULL REFERENCES assessment_teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'contributor', 'member')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS assessment_team_members_user_idx ON assessment_team_members (user_id);

-- The seeded cast's memberships: exactly what the retired name match produced
-- (Asha Nair is a contributor on Northstar Payments). The other leads and
-- contributors the seed names have no app account.
INSERT INTO assessment_team_members (team_id, user_id, role) VALUES
  ('TEAM-001', 'u-asha', 'contributor')
ON CONFLICT (team_id, user_id) DO NOTHING;

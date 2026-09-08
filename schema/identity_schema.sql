-- Identity layer: tenants, login-able users, and per-tenant role grants.
-- Users are distinct from the org-graph `people` table — a user is someone who
-- can hold a session in the portal; person_id optionally links a user to their
-- graph persona so traces and bylines resolve to a real name.
--
-- Roles are NOT defined here. Role definitions live as Cedar policies
-- (middleware/seeds/roles/{tenant}/{role}.cedar) seeded into Verified
-- Permissions on boot; this table only records which user holds which role in
-- which tenant. The middleware validates every role/tenant switch against
-- user_tenant_roles, which is what prevents cross-tenant leakage.

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,           -- 'orgiq' | 'assessment' | future
  display_name TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | SUSPENDED
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id           TEXT PRIMARY KEY,          -- opaque internal id; the session `sub`
  display_name TEXT NOT NULL,
  email        TEXT,
  person_id    TEXT REFERENCES people(id) ON DELETE SET NULL,
  external_sub TEXT,                      -- future IdP subject (Cognito etc.); NULL for picker-login users
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- bumped on tenant/role switch + sign-out-others; cookies below the current epoch are rejected at grants-refresh (≤120s replay window)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent add for clusters created before session_epoch existed.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_external_sub_idx
  ON app_users (external_sub) WHERE external_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_tenant_roles (
  user_id   TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,                -- must match a seeded Cedar role for the tenant
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id, role)
);

CREATE INDEX IF NOT EXISTS user_tenant_roles_tenant_idx ON user_tenant_roles (tenant_id);

-- ── Seed: tenants ────────────────────────────────────────────────────────────

INSERT INTO tenants (id, display_name) VALUES
  ('orgiq', 'OrgIQ'),
  ('assessment', 'Assessment')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: demo users ─────────────────────────────────────────────────────────
-- person_id subqueries resolve to NULL when the org graph isn't seeded yet, so
-- this file loads cleanly in any order relative to seed.sql.

INSERT INTO app_users (id, display_name, email, person_id) VALUES
  ('u-operator', 'Platform Operator', 'operator@orgiq.example', NULL),
  ('u-theo',     'Theo Chang',        'theo.chang@orgiq.example',
     (SELECT id FROM people WHERE name = 'Theo Chang' LIMIT 1)),
  ('u-vera',     'Vera Green',        'vera.green@orgiq.example',
     (SELECT id FROM people WHERE name = 'Vera Green' LIMIT 1)),
  ('u-hr',       'Priya Desai',       'priya.desai@orgiq.example', NULL),
  -- Program operating model cast (docs/program-operating-model.md): a release
  -- manager who grants SME budget envelopes, a program operator who runs the
  -- program surfaces, and SMEs who masquerade in and assign compute to work.
  ('u-release',  'Sienna Garcia',     'sienna.garcia@orgiq.example',
     (SELECT id FROM people WHERE name = 'Sienna Garcia' LIMIT 1)),
  ('u-rachel',   'Rachel Kowalski',   'rachel.kowalski@orgiq.example',
     (SELECT id FROM people WHERE name = 'Rachel Kowalski' LIMIT 1)),
  ('u-mia',      'Mia Singh',         'mia.singh@orgiq.example',
   (SELECT id FROM people WHERE id = 'p-030')),
  ('u-nora',     'Nora DaSilva',      'nora.dasilva@orgiq.example',
     (SELECT id FROM people WHERE name = 'Nora DaSilva' LIMIT 1)),
  ('u-eli',      'Eli Garcia',        'eli.garcia@orgiq.example',
     (SELECT id FROM people WHERE name = 'Eli Garcia' LIMIT 1)),
  ('u-layla',    'Layla Hassan',      'layla.hassan@orgiq.example',
     (SELECT id FROM people WHERE name = 'Layla Hassan' LIMIT 1)),
  ('u-caleb',    'Caleb Turner',      'caleb.turner@orgiq.example',
     (SELECT id FROM people WHERE name = 'Caleb Turner' LIMIT 1)),
  -- Assessment tenant cast (docs/assessment-tenant.md Roles (Cedar)).
  ('u-asha',     'Asha Nair',         'asha.nair@assessment.example', NULL),
  ('u-jonas',    'Jonas Lindqvist',   'jonas.lindqvist@assessment.example', NULL),
  ('u-farah',    'Farah Osei',        'farah.osei@assessment.example', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES
  -- Cross-tenant operator: the only identity allowed to masquerade.
  ('u-operator', 'orgiq',    'admin'),
  ('u-operator', 'assessment', 'admin'),
  -- OrgIQ-only users, one per role tier.
  ('u-theo',     'orgiq',    'member'),
  ('u-vera',     'orgiq',    'org-leader'),
  ('u-vera',     'orgiq',    'member'),
  ('u-hr',       'orgiq',    'hr-admin'),
  -- Release manager: allocates initiative budgets and grants SME envelopes
  -- (org-leader carries ManageBudgets + DispatchAgentRun).
  ('u-release',  'orgiq',    'org-leader'),
  ('u-release',  'orgiq',    'member'),
  -- Program operator: runs bots/identity/program governance surfaces.
  ('u-rachel',   'orgiq',    'hr-admin'),
  ('u-rachel',   'orgiq',    'org-leader'),

  -- The program owner: runs the delivery program (sprints, bots, the board)
  -- without the allocation authority (see seeds/roles/orgiq/program-owner.cedar).
  ('u-mia',      'orgiq',    'program-owner'),
  ('u-mia',      'orgiq',    'member'),
  -- SMEs: dispatch agent work against their granted envelopes.
  ('u-nora',     'orgiq',    'sme'),
  ('u-eli',      'orgiq',    'sme'),
  ('u-layla',    'orgiq',    'sme'),
  ('u-caleb',    'orgiq',    'sme'),

  -- Assessment tenant: assessor -> lead-assessor -> program-lead ladder.
  ('u-asha',     'assessment', 'assessor'),
  ('u-jonas',    'assessment', 'lead-assessor'),
  ('u-jonas',    'assessment', 'assessor'),
  ('u-farah',    'assessment', 'program-lead'),
  ('u-farah',    'assessment', 'lead-assessor')
ON CONFLICT DO NOTHING;

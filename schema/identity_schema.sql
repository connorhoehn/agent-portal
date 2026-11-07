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

-- Avatar for a login that is not linked to an org-graph person (a linked user
-- shows people.avatar_url). NULL renders initials.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

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

-- BEGIN GENERATED tenants (scripts/gen-tenants.mjs from tenants/manifest.json; do not edit)
INSERT INTO tenants (id, display_name) VALUES
  ('orgiq', 'Work'),
  ('assessment', 'Assessment'),
  ('social', 'Social'),
  ('pipelines', 'Pipelines'),
  ('access', 'Access')
ON CONFLICT (id) DO NOTHING;
-- END GENERATED tenants

-- Existing tenants retain their ID while the product display name converges.
UPDATE tenants SET display_name = 'Work' WHERE id = 'orgiq';

-- ── Demo users: not here ─────────────────────────────────────────────────────
-- The demo cast (24 accounts, including u-operator with `admin` in every
-- tenant) lives in seed_demo_identities.sql. This file is a repeatable schema
-- entry that every deploy loads, so seeding accounts from it put a known admin
-- login into every environment. That file is applied only on request (see
-- schema/README.md, "Demo identities").

-- ===========================================================================
-- graph_readonly_role.sql — the braces behind agents/_shared/sql_guard.py
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
--
-- `search` and `advisor` expose a `query_graph(sql)` tool: the *model* writes
-- the SQL and the agent executes it verbatim through the RDS Data API. Until
-- this file, the only thing between a prompt injection sitting in an ingested
-- document and `DELETE FROM people` was a regex — and the first version of
-- that regex had a hole (a data-modifying CTE starts with WITH, holds no
-- semicolon, and PostgreSQL runs the DELETE inside it).
--
-- `sql_guard.py` closed that hole and stays exactly where it is: defence in
-- depth, and the layer that returns a useful message to the model. But a regex
-- over model-authored SQL will always be an argument about parsing. A role
-- that *cannot write* is a fact the engine enforces. This file creates that
-- role.
--
-- WHAT IT CREATES
--
--   orgiq_graph_reader — LOGIN, no password (set out of band, see below),
--   NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOREPLICATION / NOBYPASSRLS,
--   owns nothing, and holds exactly:
--     * CONNECT on the current database
--     * USAGE (not CREATE) on schema public
--     * SELECT on the fourteen tables listed in READABLE below — the org-graph
--       node/edge tables that `query_graph`'s docstring describes to the model,
--       plus `knowledge_bases`, which `_shared/kb_resolver.py` reads to resolve
--       a KB id.
--   and nothing else. No INSERT, no UPDATE, no DELETE, no TRUNCATE, no
--   REFERENCES, no TRIGGER, no sequence or function privileges, no default
--   privileges on future objects.
--
-- Belt on the braces: the role is pinned to
-- `default_transaction_read_only = on`, so even a future grant applied by
-- mistake cannot produce a write through this login, and to a 30s
-- `statement_timeout`, so a model-authored cartesian join cannot pin the
-- cluster at 4 ACU.
--
-- DELIBERATELY ABSENT: `ALTER DEFAULT PRIVILEGES`. A new table must be added
-- to READABLE below and this file re-applied. An allow-list that grows by
-- itself is not an allow-list.
--
-- THE PASSWORD IS NOT IN THIS FILE.
-- `OrgIQ-Aurora` mints `orgiq-aurora-readonly-credentials` in Secrets Manager
-- with a generated password; `schema/apply_all_seed.py` reads that secret and
-- issues the one `ALTER ROLE ... PASSWORD` statement, so the credential never
-- lands in git. Until that runs the role cannot authenticate at all — this
-- file fails closed, not open.
--
-- IDEMPOTENT. Safe to re-apply. Applied by `schema/apply_all_seed.py` (last in
-- FILES: every table it grants on must already exist), and skipped gracefully
-- for any table that does not.
--
-- Runbook: docs/readonly-graph-role.md
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The role.
--
-- Created NOLOGIN with no password. The NO* attributes are set here, in
-- CREATE ROLE, and never in a later ALTER: PostgreSQL's ALTER ROLE checks the
-- *presence* of SUPERUSER / REPLICATION / BYPASSRLS rather than their value,
-- so `ALTER ROLE x NOSUPERUSER` demands a real superuser — which the Aurora
-- master user is not (it is rds_superuser). CREATE ROLE checks the value, so
-- spelling the safe defaults out there works and documents the intent.
-- ---------------------------------------------------------------------------
DO $ROLE$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orgiq_graph_reader') THEN
    CREATE ROLE orgiq_graph_reader
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      INHERIT;
  END IF;
END
$ROLE$;

-- LOGIN is granted separately (and re-asserted on every apply) because the
-- attribute is the only one of these that we ever want to flip back off in an
-- incident: `ALTER ROLE orgiq_graph_reader NOLOGIN` is the kill switch.
ALTER ROLE orgiq_graph_reader WITH LOGIN NOCREATEDB NOCREATEROLE INHERIT;

-- Session defaults. `default_transaction_read_only` makes a write impossible
-- through this login even if a grant is later added by accident — PostgreSQL
-- refuses INSERT/UPDATE/DELETE/DDL in a read-only transaction regardless of
-- privilege. The RDS Data API runs each statement in its own implicit
-- transaction, so this applies to every call the agents make.
ALTER ROLE orgiq_graph_reader SET default_transaction_read_only = on;
ALTER ROLE orgiq_graph_reader SET statement_timeout = '30s';
ALTER ROLE orgiq_graph_reader SET idle_in_transaction_session_timeout = '60s';
-- Pin the search_path so an object planted in another schema cannot shadow a
-- graph table for this login.
ALTER ROLE orgiq_graph_reader SET search_path = public;

-- ---------------------------------------------------------------------------
-- 2. Start from zero.
--
-- Revoke everything first so a re-apply after this file shrinks (a table
-- removed from READABLE) actually removes the privilege, rather than leaving
-- the old grant behind forever.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM orgiq_graph_reader;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM orgiq_graph_reader;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM orgiq_graph_reader;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM orgiq_graph_reader;

-- Every other schema in this database (observability, and anything a later
-- migration adds) is explicitly not visible to this role.
DO $REVOKE$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema')
      AND nspname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM orgiq_graph_reader', s);
  END LOOP;
END
$REVOKE$;

-- ---------------------------------------------------------------------------
-- 3. Grant back exactly what search and advisor read.
--
-- CONNECT on the database, USAGE (never CREATE) on schema public, SELECT on
-- the allow-list. That is the whole privilege set.
-- ---------------------------------------------------------------------------
DO $CONNECT$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO orgiq_graph_reader', current_database());
END
$CONNECT$;

GRANT USAGE ON SCHEMA public TO orgiq_graph_reader;

DO $GRANTS$
DECLARE
  t text;
  -- The allow-list. Derived from what the two consumers actually read:
  --   * the node and edge tables named in query_graph's docstring in
  --     agents/search/main.py and agents/advisor/main.py (the schema the model
  --     is told about, and therefore the only schema it has any business
  --     querying), and
  --   * knowledge_bases, read by agents/_shared/kb_resolver.py.
  -- Not here, on purpose: node_embeddings (never described to the model),
  -- every identity table (app_users, tenants, user_tenant_roles), every
  -- program/budget table, every observability table, and every table the
  -- write agents own. If a query needs one of those, adding it here is a
  -- reviewable change — which is the point.
  READABLE CONSTANT text[] := ARRAY[
    -- nodes
    'people',
    'skills',
    'teams',
    'projects',
    'decisions',
    'documents',
    -- edges
    'person_skills',
    'team_memberships',
    'collaborations',
    'project_contributions',
    'decision_participants',
    'mentions',
    -- KB registry (kb_resolver)
    'knowledge_bases'
  ];
BEGIN
  FOREACH t IN ARRAY READABLE LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO orgiq_graph_reader', t);
    ELSE
      RAISE NOTICE 'graph_readonly_role: table public.% does not exist yet, skipped', t;
    END IF;
  END LOOP;
END
$GRANTS$;

-- ---------------------------------------------------------------------------
-- 4. Assert the boundary in the database itself.
--
-- If any write privilege survived the statements above, this raises and the
-- apply fails loudly rather than reporting success on a role that can write.
-- ---------------------------------------------------------------------------
DO $ASSERT$
DECLARE
  bad record;
BEGIN
  FOR bad IN
    SELECT table_schema, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee = 'orgiq_graph_reader'
      AND privilege_type <> 'SELECT'
  LOOP
    RAISE EXCEPTION
      'orgiq_graph_reader holds % on %.% — the read-only role is not read-only',
      bad.privilege_type, bad.table_schema, bad.table_name;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'orgiq_graph_reader'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'orgiq_graph_reader has an escalation attribute set';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = 'orgiq_graph_reader'
  ) THEN
    RAISE EXCEPTION 'orgiq_graph_reader owns an object — an owner can always write';
  END IF;
END
$ASSERT$;

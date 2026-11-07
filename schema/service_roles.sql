-- ===========================================================================
-- service_roles.sql — one database login per service, the master for migrations
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
--
-- docs/next-steps.md §7/§8 (work item 19): the Aurora master credential went
-- to the middleware, the writer agents (graph-builder reads untrusted
-- documents) and the Bedrock knowledge base. Any one of them could drop a
-- table, create a role or read every tenant's identity rows. This file gives
-- each a login that can do its job and nothing else; the master secret is left
-- to the schema loaders and migrations.
--
-- WHAT IT CREATES (all LOGIN, no password here, NOSUPERUSER / NOCREATEDB /
-- NOCREATEROLE / NOREPLICATION / NOBYPASSRLS, owning nothing at creation):
--
--   orgiq_graph_writer  — graph-builder and scoring. SELECT/INSERT/UPDATE on the
--                         org-graph tables they upsert (no DELETE, no
--                         TRUNCATE), SELECT on the few they only read. Nothing
--                         else: no identity, program, budget or observability
--                         table. ingestion only reads `knowledge_bases`, so it
--                         uses orgiq_graph_reader (graph_readonly_role.sql).
--
--   orgiq_kb_service    — the Bedrock knowledge base's vector store. SELECT /
--                         INSERT / UPDATE / DELETE on public.bedrock_kb, which
--                         the KnowledgeBase stack's init step creates.
--
--   orgiq_app_middleware — the BFF. SELECT / INSERT / UPDATE / DELETE on every
--                         application table that exists when this file is
--                         applied (except bedrock_kb), USAGE on their schemas
--                         and sequences. No TRUNCATE, REFERENCES or TRIGGER, no
--                         ownership of existing tables, no role or database
--                         attributes. One exception, stated plainly: CREATE on
--                         schema public, because the knowledge-base registry
--                         (middleware/src/providers/kb-registry.ts) creates a
--                         vector table per registered KB at run time. Moving
--                         those tables to their own schema would remove it.
--
-- The middleware grant is schema-wide on purpose: it is the application, it
-- touches nearly every table, and a hand-kept list of ~150 tables would drift.
-- It is still re-derived on every apply, with no ALTER DEFAULT PRIVILEGES: a
-- table added by a migration is invisible to the middleware until this file is
-- re-applied (schema/apply_all_seed.py --roles-only), so the migration order in
-- infra/SECURITY-NOTES.md re-applies it after every migration.
--
-- THE PASSWORDS ARE NOT IN THIS FILE. OrgIQ-Aurora mints one Secrets Manager
-- secret per role (`orgiq-aurora-<service>-credentials`); apply_all_seed.py
-- reads each and issues the `ALTER ROLE ... PASSWORD`. Until then the roles
-- cannot authenticate: this fails closed.
--
-- IDEMPOTENT: revokes then re-grants. Applied after every table exists
-- (manifest seed_run, just before graph_readonly_role).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The roles. Escalation attributes are negated in CREATE ROLE, never in a
-- later ALTER (see graph_readonly_role.sql for why).
-- ---------------------------------------------------------------------------
DO $ROLES$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['orgiq_graph_writer', 'orgiq_kb_service', 'orgiq_app_middleware'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT', r);
    END IF;
    -- LOGIN is the kill switch: `ALTER ROLE <r> NOLOGIN` in an incident.
    EXECUTE format('ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE INHERIT', r);
    EXECUTE format('ALTER ROLE %I SET search_path = public', r);
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
  END LOOP;
END
$ROLES$;

-- The migrating login (the cluster master) joins orgiq_app_middleware so it
-- holds owner rights over the per-KB vector tables the middleware creates.
-- Without it, the schema-wide REVOKE/GRANT below (and the one in
-- graph_readonly_role.sql) fail with "permission denied" on the first such
-- table: the master is rds_superuser, not a true superuser.
GRANT orgiq_app_middleware TO CURRENT_USER;

-- An agent's statement is bounded like the reader's; the middleware runs
-- longer reports, so it gets more room.
ALTER ROLE orgiq_graph_writer SET statement_timeout = '30s';
ALTER ROLE orgiq_kb_service SET statement_timeout = '60s';
ALTER ROLE orgiq_app_middleware SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 2. Start from zero in every application schema, so a re-apply after this
-- file shrinks actually removes the privilege.
-- ---------------------------------------------------------------------------
DO $REVOKE$
DECLARE
  s text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['orgiq_graph_writer', 'orgiq_kb_service', 'orgiq_app_middleware'] LOOP
    FOR s IN
      SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('information_schema') AND nspname NOT LIKE 'pg\_%'
    LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', s, r);
    END LOOP;
  END LOOP;
END
$REVOKE$;

-- ---------------------------------------------------------------------------
-- 3. orgiq_graph_writer: the tables agents/graph-builder/main.py upserts
-- (merge_person/skill/team/project, merge_relationship, node_embeddings) and
-- agents/scoring/main.py reads and scores (UPDATE people).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO orgiq_graph_writer;

DO $WRITER$
DECLARE
  t text;
  seq text;
  WRITABLE CONSTANT text[] := ARRAY[
    'people', 'skills', 'teams', 'projects',
    'person_skills', 'team_memberships', 'project_contributions',
    'decision_participants', 'collaborations', 'node_embeddings'
  ];
  READABLE CONSTANT text[] := ARRAY['decisions', 'documents', 'mentions', 'knowledge_bases'];
BEGIN
  FOREACH t IN ARRAY WRITABLE LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO orgiq_graph_writer', t);
      -- A serial/identity column's sequence, if the table has one.
      FOR seq IN
        SELECT s.oid::regclass::text FROM pg_class s
        JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
        WHERE s.relkind = 'S' AND d.refobjid = ('public.' || quote_ident(t))::regclass
      LOOP
        EXECUTE format('GRANT USAGE ON SEQUENCE %s TO orgiq_graph_writer', seq);
      END LOOP;
    ELSE
      RAISE NOTICE 'service_roles: table public.% does not exist yet, skipped', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY READABLE LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO orgiq_graph_writer', t);
    END IF;
  END LOOP;
END
$WRITER$;

-- ---------------------------------------------------------------------------
-- 4. orgiq_kb_service: the knowledge base's vector table, nothing else.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO orgiq_kb_service;

DO $KB$
BEGIN
  IF to_regclass('public.bedrock_kb') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bedrock_kb TO orgiq_kb_service;
  ELSE
    RAISE NOTICE 'service_roles: public.bedrock_kb does not exist yet (deploy OrgIQ-KnowledgeBase), skipped';
  END IF;
END
$KB$;

-- ---------------------------------------------------------------------------
-- 5. orgiq_app_middleware: DML on every application table, schema by schema.
-- ---------------------------------------------------------------------------
DO $MIDDLEWARE$
DECLARE
  s text;
  t record;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('information_schema') AND nspname NOT LIKE 'pg\_%'
      AND nspname NOT IN ('aws_commons', 'aws_lambda', 'aws_s3')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO orgiq_app_middleware', s);
    FOR t IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = s AND c.relkind IN ('r', 'p', 'v', 'm')
        AND NOT (n.nspname = 'public' AND c.relname = 'bedrock_kb')
    LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO orgiq_app_middleware', s, t.relname);
    END LOOP;
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO orgiq_app_middleware', s);
  END LOOP;
END
$MIDDLEWARE$;

-- The one DDL privilege: kb-registry creates `bedrock_kb_<tenant>_<slug>`
-- vector tables at run time. The middleware owns those, and only those.
GRANT CREATE ON SCHEMA public TO orgiq_app_middleware;

-- ---------------------------------------------------------------------------
-- 6. Assert the boundaries in the database itself; a failure fails the apply.
-- ---------------------------------------------------------------------------
DO $ASSERT$
DECLARE
  bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('orgiq_graph_writer', 'orgiq_kb_service', 'orgiq_app_middleware')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'a service role has an escalation attribute set';
  END IF;

  -- No service role may hold the table-level privileges that are not DML.
  FOR bad IN
    SELECT grantee, table_schema, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee IN ('orgiq_graph_writer', 'orgiq_kb_service', 'orgiq_app_middleware')
      AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    RAISE EXCEPTION '% holds % on %.%', bad.grantee, bad.privilege_type, bad.table_schema, bad.table_name;
  END LOOP;

  -- The writer never deletes, and never sees outside the graph.
  FOR bad IN
    SELECT table_name, privilege_type FROM information_schema.table_privileges
    WHERE grantee = 'orgiq_graph_writer'
      AND (privilege_type = 'DELETE'
           OR table_name NOT IN ('people', 'skills', 'teams', 'projects', 'person_skills', 'team_memberships',
                                 'project_contributions', 'decision_participants', 'collaborations',
                                 'node_embeddings', 'decisions', 'documents', 'mentions', 'knowledge_bases'))
  LOOP
    RAISE EXCEPTION 'orgiq_graph_writer holds % on %', bad.privilege_type, bad.table_name;
  END LOOP;

  -- The knowledge base sees its vector table only.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'orgiq_kb_service' AND table_name <> 'bedrock_kb'
  ) THEN
    RAISE EXCEPTION 'orgiq_kb_service holds a privilege outside bedrock_kb';
  END IF;

  -- The writer and the knowledge base own nothing; the middleware owns only
  -- the per-KB vector tables it creates.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
    WHERE r.rolname IN ('orgiq_graph_writer', 'orgiq_kb_service')
  ) THEN
    RAISE EXCEPTION 'a service role owns an object — an owner can always write and drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = 'orgiq_app_middleware' AND c.relkind IN ('r', 'p')
      AND c.relname NOT LIKE 'bedrock\_kb\_%'
  ) THEN
    RAISE EXCEPTION 'orgiq_app_middleware owns a table that is not a registry vector table';
  END IF;
END
$ASSERT$;

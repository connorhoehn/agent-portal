-- ===========================================================================
-- row_level_security.sql — tenant isolation in the database (work item 22)
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
--
-- docs/next-steps.md §8 work item 22. Every tenant boundary used to live only
-- in the middleware's WHERE clauses: one missing `AND tenant = :tenant` and a
-- Work session read another tenant's rows. With one login per service
-- (service_roles.sql, item 19) the database can hold that line itself.
--
-- THE SETTING
--
-- `app.tenant` is set per transaction by the middleware's Data API wrapper
-- (middleware/src/providers/data-api.ts; the statement is db-tenant.ts `SET_TENANT_SQL`):
--
--     SELECT set_config('app.tenant', :app_tenant, true)   -- true = LOCAL
--
-- The Data API has no session, so the wrapper begins a transaction, sets it,
-- runs the statement and commits. The value is the tenants the request may
-- read, comma-separated, active tenant first:
--
--   'orgiq,social'  a session in Work whose user also holds a Social grant
--                   (its granted tenants: providers/db-tenant.ts dbTenantScopeFor)
--   '*'             the cross-tenant role `admin`, the access tenant (it
--                   administers every tenant's grants), and system work with
--                   no request behind it (boot, pollers, the grants refresh)
--   unset / ''      nothing: every policy below answers false
--
-- WHO IS BOUND
--
--   orgiq_app_middleware  every policy below. NOBYPASSRLS (service_roles.sql).
--   orgiq_graph_reader /  read-only passthrough on knowledge_bases only, the
--   orgiq_graph_writer    one tenant table their allow-lists reach (agents
--                         have no request tenant; graph_readonly_role.sql).
--   the migrating login   owns every table, so RLS does not apply to it (no
--                         FORCE ROW LEVEL SECURITY here, on purpose): schema
--                         loads, migrations and seeds see every row. It is the
--                         master (rds_superuser) on Aurora and `postgres`
--                         locally; under the `dbMasterSecret` fallback the
--                         middleware runs as it and RLS_ENFORCE defaults off.
--
-- WHICH TABLES (a table that does not exist yet is skipped with a NOTICE; the
-- file is re-applied after every migration, like service_roles.sql)
--
--   A tenant column that names the owning tenant:
--     user_tenant_roles.tenant_id, saved_searches.tenant_id, flow_runs.tenant,
--     knowledge_bases.tenant, social_channels.tenant,
--     access_catalog_items.tenant, access_reviews.tenant,
--     access_review_items.tenant, assessment_document_mappings.tenant_id,
--     microvm_sessions.tenant, github_user_grants.tenant (the microVM
--     runner, docs/microvm-runner-design.md §13), sweep_runs.tenant
--   Two tenant columns:
--     pipeline_definitions, pipeline_runs  tenant OR context_tenant (a run
--                                          shows on the page it acted for)
--     access_policies                      left_tenant OR right_tenant
--     social_bindings                      tenant AND 'social' (routes/social.ts
--                                          /bindings: a grant in both)
--   Reachable only through a parent that has one:
--     pipeline_steps, pipeline_artifacts   their pipeline_runs row
--     access_requests                      its access_catalog_items row
--     access_request_steps, access_events  their access_requests row
--   Reachable only through one tenant (the product owns every row):
--     every other assessment_* table       'assessment'
--     access_delegations                   'access'
--     pipeline_config, pipeline_run_decks,
--     pipeline_run_deck_revisions          'pipelines'
--
-- Deliberately NOT here, each a follow-up with its reason:
--   observability.authz_events / .invocation_traces — the operator plane; the
--     tenant column is a nullable attribute and the observability pages read
--     every tenant's traces behind ViewObservability.
--   tenants, app_users — the directory; a user spans tenants.
--   social_decks, social_deck_revisions — built from conversations (dm:,
--     team:) that live in every tenant's bottom bar, not only in Social.
--   the org graph and the other Work tables (projects, people, budgets, work
--     items, decks…) — no tenant column, and Social, Pipelines and Access read
--     them by design. A constant 'orgiq' policy there needs those readers
--     mapped first.
--
-- IDEMPOTENT: drops and re-creates its own policies. Runs after
-- graph_readonly_role.sql (it names that role), last in the seed run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The one predicate. SQL, STABLE and free of SECURITY DEFINER, so the
-- planner inlines it. The policies bind it by OID when they are created, so a
-- function of the same name elsewhere on a search_path cannot replace it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_tenant_visible(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $FN$
  SELECT CASE coalesce(current_setting('app.tenant', true), '')
           WHEN '' THEN false
           WHEN '*' THEN true
           ELSE row_tenant = ANY (string_to_array(current_setting('app.tenant', true), ','))
         END
$FN$;

COMMENT ON FUNCTION public.app_tenant_visible(text) IS
  'Row-level security (schema/row_level_security.sql): true when app.tenant is * or lists row_tenant; false when unset.';

REVOKE ALL ON FUNCTION public.app_tenant_visible(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_tenant_visible(text) TO orgiq_app_middleware;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS and (re)create the middleware's policy on every table.
-- One row per table: the predicate is used for USING and WITH CHECK, so the
-- middleware can neither read nor write a row outside the request's tenants.
-- ---------------------------------------------------------------------------
DO $RLS$
DECLARE
  r record;
  pol record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- A tenant column that names the owning tenant.
      ('user_tenant_roles',            'public.app_tenant_visible(tenant_id)'),
      ('saved_searches',               'public.app_tenant_visible(tenant_id)'),
      ('flow_runs',                    'public.app_tenant_visible(tenant)'),
      ('knowledge_bases',              'public.app_tenant_visible(tenant)'),
      ('social_channels',              'public.app_tenant_visible(tenant)'),
      ('access_catalog_items',         'public.app_tenant_visible(tenant)'),
      ('access_reviews',               'public.app_tenant_visible(tenant)'),
      ('access_review_items',          'public.app_tenant_visible(tenant)'),
      ('assessment_document_mappings', 'public.app_tenant_visible(tenant_id)'),
      ('microvm_sessions',             'public.app_tenant_visible(tenant)'),
      ('github_user_grants',           'public.app_tenant_visible(tenant)'),
      ('sweep_runs',                   'public.app_tenant_visible(tenant)'),
      -- Two tenant columns.
      ('pipeline_definitions',         'public.app_tenant_visible(tenant) OR public.app_tenant_visible(context_tenant)'),
      ('pipeline_runs',                'public.app_tenant_visible(tenant) OR public.app_tenant_visible(context_tenant)'),
      ('access_policies',              'public.app_tenant_visible(left_tenant) OR public.app_tenant_visible(right_tenant)'),
      ('social_bindings',              'public.app_tenant_visible(tenant) AND public.app_tenant_visible(''social'')'),
      -- Through a parent (the parent's own policy filters the subquery).
      ('pipeline_steps',               'EXISTS (SELECT 1 FROM public.pipeline_runs p WHERE p.id = pipeline_steps.run_id)'),
      ('pipeline_artifacts',           '(pipeline_artifacts.run_id IS NULL AND public.app_tenant_visible(''pipelines'')) OR EXISTS (SELECT 1 FROM public.pipeline_runs p WHERE p.id = pipeline_artifacts.run_id)'),
      ('access_requests',              'EXISTS (SELECT 1 FROM public.access_catalog_items i WHERE i.id = access_requests.item_id)'),
      ('access_request_steps',         'EXISTS (SELECT 1 FROM public.access_requests q WHERE q.id = access_request_steps.request_id)'),
      ('access_events',                '(access_events.request_id IS NULL AND public.app_tenant_visible(''access'')) OR EXISTS (SELECT 1 FROM public.access_requests q WHERE q.id = access_events.request_id)'),
      -- Reachable only through one tenant.
      ('access_delegations',           'public.app_tenant_visible(''access'')'),
      ('pipeline_config',              'public.app_tenant_visible(''pipelines'')'),
      ('pipeline_run_decks',           'public.app_tenant_visible(''pipelines'')'),
      ('pipeline_run_deck_revisions',  'public.app_tenant_visible(''pipelines'')')
    ) AS t(tbl, predicate)
    UNION ALL
    -- Every other assessment_* base table belongs to the assessment tenant.
    SELECT c.relname, 'public.app_tenant_visible(''assessment'')'
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname LIKE 'assessment\_%' AND c.relname <> 'assessment_document_mappings'
  LOOP
    IF to_regclass('public.' || quote_ident(r.tbl)) IS NULL THEN
      RAISE NOTICE 'row_level_security: table public.% does not exist yet, skipped', r.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    -- Start from zero: a policy this file no longer writes must not linger.
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, r.tbl);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I AS PERMISSIVE FOR ALL TO orgiq_app_middleware USING (%s) WITH CHECK (%s)',
      r.tbl, r.predicate, r.predicate);
  END LOOP;
END
$RLS$;

-- ---------------------------------------------------------------------------
-- 3. The agents' read of the KB registry (agents/_shared/kb_resolver.py).
-- Their logins have no request tenant; their allow-lists already bound them.
-- ---------------------------------------------------------------------------
DO $AGENTS$
BEGIN
  IF to_regclass('public.knowledge_bases') IS NOT NULL THEN
    CREATE POLICY agents_read ON public.knowledge_bases AS PERMISSIVE FOR SELECT
      TO orgiq_graph_reader, orgiq_graph_writer USING (true);
  END IF;
END
$AGENTS$;

-- ---------------------------------------------------------------------------
-- 4. A view runs with its owner's rights, and the owner bypasses RLS. Views
-- over a table above read as the caller instead (PostgreSQL 15+; Aurora 16).
-- ---------------------------------------------------------------------------
DO $VIEWS$
BEGIN
  IF to_regclass('public.v_assessment_team_rollup') IS NOT NULL THEN
    ALTER VIEW public.v_assessment_team_rollup SET (security_invoker = true);
  END IF;
END
$VIEWS$;

-- ---------------------------------------------------------------------------
-- 5. Assert in the database itself; a failure fails the apply.
-- ---------------------------------------------------------------------------
DO $ASSERT$
DECLARE
  bad record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('orgiq_app_middleware', 'orgiq_graph_writer', 'orgiq_kb_service', 'orgiq_graph_reader')
      AND (rolbypassrls OR rolsuper)
  ) THEN
    RAISE EXCEPTION 'a service role can bypass row-level security';
  END IF;

  -- Every assessment_* table and every table with a tenant column the middleware
  -- can reach has RLS on. A new one fails here until it is listed above.
  FOR bad IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      AND (c.relname LIKE 'assessment\_%' OR c.relname LIKE 'access\_%'
           OR c.relname IN (SELECT table_name FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND column_name IN ('tenant', 'tenant_id', 'context_tenant', 'left_tenant', 'right_tenant')))
  LOOP
    RAISE EXCEPTION 'public.% carries a tenant but has no row-level security (schema/row_level_security.sql)', bad.relname;
  END LOOP;

  -- Nothing grants the middleware an unconditional policy.
  FOR bad IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND 'orgiq_app_middleware' = ANY (roles)
      AND (qual IS NULL OR qual = 'true')
  LOOP
    RAISE EXCEPTION 'policy % on % gives the middleware every row', bad.policyname, bad.tablename;
  END LOOP;
END
$ASSERT$;

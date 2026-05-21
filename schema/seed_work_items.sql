-- Seed work items for demo projects.
-- Assumes projects and people tables already have data from the main seed.
-- Run AFTER applying orgiq_work_items_schema.sql.
--
-- Pattern: each project gets 2–3 epics, each epic gets 2–3 features,
-- each feature gets 2–3 stories, each story gets 1–2 tasks.
-- Labels include skill keywords so the keyword search demo works.

-- ── Helpers ────────────────────────────────────────────────────────────────────
-- We reference projects and people by name (more resilient to ID churn).

DO $$
DECLARE
  -- Projects
  p_infra     TEXT;
  p_platform  TEXT;
  p_observ    TEXT;
  p_auth      TEXT;

  -- People
  per_henry   TEXT;
  per_sarah   TEXT;
  per_marcus  TEXT;
  per_aisha   TEXT;
  per_theo    TEXT;
  per_raj     TEXT;
  per_lena    TEXT;
  per_hiro    TEXT;
  per_james   TEXT;
  per_tara    TEXT;

  -- Epics
  e1 TEXT; e2 TEXT; e3 TEXT; e4 TEXT; e5 TEXT; e6 TEXT; e7 TEXT; e8 TEXT;
  -- Features
  f1 TEXT; f2 TEXT; f3 TEXT; f4 TEXT; f5 TEXT; f6 TEXT; f7 TEXT; f8 TEXT;
  f9 TEXT; f10 TEXT; f11 TEXT; f12 TEXT;
  -- Stories
  s1 TEXT; s2 TEXT; s3 TEXT; s4 TEXT; s5 TEXT; s6 TEXT; s7 TEXT; s8 TEXT;

BEGIN

  -- ── Resolve project IDs ─────────────────────────────────────────────────────
  SELECT id INTO p_infra    FROM projects WHERE name ILIKE '%infra%'     LIMIT 1;
  SELECT id INTO p_platform FROM projects WHERE name ILIKE '%platform%'  LIMIT 1;
  SELECT id INTO p_observ   FROM projects WHERE name ILIKE '%observ%'    LIMIT 1;
  SELECT id INTO p_auth     FROM projects WHERE name ILIKE '%auth%'      LIMIT 1;

  -- Fallback: pick any 4 projects if names don't match
  IF p_infra IS NULL THEN
    SELECT id INTO p_infra FROM projects ORDER BY created_at LIMIT 1 OFFSET 0;
  END IF;
  IF p_platform IS NULL THEN
    SELECT id INTO p_platform FROM projects ORDER BY created_at LIMIT 1 OFFSET 1;
  END IF;
  IF p_observ IS NULL THEN
    SELECT id INTO p_observ FROM projects ORDER BY created_at LIMIT 1 OFFSET 2;
  END IF;
  IF p_auth IS NULL THEN
    SELECT id INTO p_auth FROM projects ORDER BY created_at LIMIT 1 OFFSET 3;
  END IF;

  -- ── Resolve people IDs ──────────────────────────────────────────────────────
  SELECT id INTO per_henry  FROM people WHERE name ILIKE '%henry%'  LIMIT 1;
  SELECT id INTO per_sarah  FROM people WHERE name ILIKE '%sarah%'  LIMIT 1;
  SELECT id INTO per_marcus FROM people WHERE name ILIKE '%marcus%' LIMIT 1;
  SELECT id INTO per_aisha  FROM people WHERE name ILIKE '%aisha%'  LIMIT 1;
  SELECT id INTO per_theo   FROM people WHERE name ILIKE '%theo%'   LIMIT 1;
  SELECT id INTO per_raj    FROM people WHERE name ILIKE '%raj%'    LIMIT 1;
  SELECT id INTO per_lena   FROM people WHERE name ILIKE '%lena%'   LIMIT 1;
  SELECT id INTO per_hiro   FROM people WHERE name ILIKE '%hiro%'   LIMIT 1;
  SELECT id INTO per_james  FROM people WHERE name ILIKE '%james%'  LIMIT 1;
  SELECT id INTO per_tara   FROM people WHERE name ILIKE '%tara%'   LIMIT 1;

  IF p_infra IS NULL THEN
    RAISE NOTICE 'No projects found — skipping work item seed';
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PROJECT 1: Infrastructure (kubernetes, networking, observability)
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Epic 1: Kubernetes cluster upgrade
  INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
  VALUES (p_infra, 'epic', 'Kubernetes cluster upgrade to v1.30',
    'Upgrade all production k8s clusters from v1.27 to v1.30 with zero-downtime rolling strategy.',
    'in_progress', 'critical', ARRAY['kubernetes','infrastructure','platform-eng'], per_henry)
  RETURNING id INTO e1;

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
  VALUES (p_infra, e1, 'feature', 'Control-plane node upgrade', 'done', 'critical',
    ARRAY['kubernetes','control-plane'], per_henry)
  RETURNING id INTO f1;

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
  VALUES (p_infra, f1, 'story', 'Drain and cordon primary control-plane node', 'done', 'critical',
    ARRAY['kubernetes'], per_henry, 3, 'https://github.com/orgiq/infra/pull/142', 'merged')
  RETURNING id INTO s1;
  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, assignee_id)
  VALUES (p_infra, s1, 'task', 'Verify etcd health before drain', 'done', 'high', per_henry);
  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, assignee_id)
  VALUES (p_infra, s1, 'task', 'Take etcd snapshot backup', 'done', 'critical', per_henry);

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
  VALUES (p_infra, f1, 'story', 'Validate API server post-upgrade', 'done', 'high',
    ARRAY['kubernetes','testing'], per_marcus, 2, 'https://github.com/orgiq/infra/pull/143', 'merged')
  RETURNING id INTO s2;
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s2, 'task', 'Run conformance tests', 'done', per_marcus);

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
  VALUES (p_infra, e1, 'feature', 'Worker node rolling upgrade', 'in_progress', 'high',
    ARRAY['kubernetes','worker-nodes'], per_raj)
  RETURNING id INTO f2;

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
  VALUES (p_infra, f2, 'story', 'Upgrade data-platform node pool', 'in_progress', 'high',
    ARRAY['kubernetes','data-platform'], per_raj, 5, 'https://github.com/orgiq/infra/pull/156', 'open')
  RETURNING id INTO s3;
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s3, 'task', 'Cordon 3 nodes in data-platform pool', 'done', per_raj);
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s3, 'task', 'Validate PodDisruptionBudgets', 'in_progress', per_raj);
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s3, 'task', 'Drain node and apply upgrade', 'open', per_raj);

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
  VALUES (p_infra, f2, 'story', 'Upgrade security node pool', 'open', 'medium',
    ARRAY['kubernetes','security'], per_marcus, 5)
  RETURNING id INTO s4;

  -- Epic 2: Service mesh migration (Istio)
  INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
  VALUES (p_infra, 'epic', 'Migrate to Istio service mesh',
    'Replace custom Envoy sidecars with managed Istio to get mTLS, traffic policy, and canary routing for free.',
    'open', 'high', ARRAY['kubernetes','istio','networking','service-mesh'], per_marcus)
  RETURNING id INTO e2;

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
  VALUES (p_infra, e2, 'feature', 'Istio control-plane installation', 'in_progress', 'high',
    ARRAY['kubernetes','istio'], per_marcus)
  RETURNING id INTO f3;

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
  VALUES (p_infra, f3, 'story', 'Install istiod via Helm with production config', 'in_progress', 'high',
    ARRAY['kubernetes','istio','helm'], per_marcus, 3, 'https://github.com/orgiq/infra/pull/162', 'open')
  RETURNING id INTO s5;
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s5, 'task', 'Configure PeerAuthentication to STRICT mTLS', 'open', per_marcus);
  INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
  VALUES (p_infra, s5, 'task', 'Set up Kiali dashboard for mesh visibility', 'open', per_lena);

  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
  VALUES (p_infra, e2, 'feature', 'Namespace-by-namespace sidecar injection', 'open', 'medium',
    ARRAY['kubernetes','istio'], per_hiro)
  RETURNING id INTO f4;
  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
  VALUES (p_infra, f4, 'story', 'Enable injection for platform-engineering namespace', 'open', 'medium',
    ARRAY['kubernetes','istio'], per_hiro, 2);
  INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
  VALUES (p_infra, f4, 'story', 'Enable injection for data-platform namespace', 'open', 'medium',
    ARRAY['kubernetes','istio'], per_raj, 2);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PROJECT 2: Platform Engineering (CI/CD, developer experience)
  -- ═══════════════════════════════════════════════════════════════════════════

  IF p_platform IS NOT NULL THEN

    INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
    VALUES (p_platform, 'epic', 'Unified CI/CD pipeline with GitHub Actions',
      'Replace 4 different CI systems with a single GitHub Actions–based pipeline that handles build, test, security scan, and deploy.',
      'in_progress', 'high', ARRAY['ci-cd','github-actions','developer-experience'], per_aisha)
    RETURNING id INTO e3;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_platform, e3, 'feature', 'Shared reusable workflow library', 'done', 'high',
      ARRAY['github-actions','ci-cd'], per_aisha)
    RETURNING id INTO f5;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_platform, f5, 'story', 'Publish orgiq/workflows repo with build-and-test callable workflow', 'done', 'high',
      ARRAY['github-actions'], per_aisha, 5, 'https://github.com/orgiq/workflows/pull/1', 'merged')
    RETURNING id INTO s6;
    INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
    VALUES (p_platform, s6, 'task', 'Add SAST scan step via CodeQL', 'done', per_aisha);
    INSERT INTO work_items (project_id, parent_id, type, title, status, assignee_id)
    VALUES (p_platform, s6, 'task', 'Add container image signing with Cosign', 'done', per_james);

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_platform, e3, 'feature', 'Migrate service repos to new pipeline', 'in_progress', 'medium',
      ARRAY['ci-cd','migration'], per_theo)
    RETURNING id INTO f6;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_platform, f6, 'story', 'Migrate orgiq-search service', 'done', 'high',
      ARRAY['ci-cd','kubernetes'], per_theo, 2, 'https://github.com/orgiq/search/pull/89', 'merged');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_platform, f6, 'story', 'Migrate orgiq-scoring service', 'in_progress', 'medium',
      ARRAY['ci-cd','kubernetes'], per_theo, 2, 'https://github.com/orgiq/scoring/pull/34', 'open');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
    VALUES (p_platform, f6, 'story', 'Migrate orgiq-graph-builder service', 'open', 'medium',
      ARRAY['ci-cd'], per_hiro, 2);

    INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
    VALUES (p_platform, 'epic', 'Developer onboarding improvements',
      'Reduce time-to-first-PR for new engineers from 5 days to 1 day.',
      'open', 'medium', ARRAY['developer-experience','documentation','onboarding'], per_lena)
    RETURNING id INTO e4;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_platform, e4, 'feature', 'Automated dev environment bootstrap script', 'in_progress', 'high',
      ARRAY['developer-experience','kubernetes'], per_lena)
    RETURNING id INTO f7;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_platform, f7, 'story', 'Write bootstrap.sh that spins up local k8s via kind', 'in_progress', 'high',
      ARRAY['kubernetes','developer-experience'], per_lena, 3, 'https://github.com/orgiq/dev-tools/pull/12', 'draft');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
    VALUES (p_platform, f7, 'story', 'Add pre-commit hooks for linting and formatting', 'open', 'medium',
      ARRAY['developer-experience'], per_james, 1);

  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PROJECT 3: Observability (linked decisions + escalations)
  -- ═══════════════════════════════════════════════════════════════════════════

  IF p_observ IS NOT NULL THEN

    INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
    VALUES (p_observ, 'epic', 'Unified observability stack',
      'Consolidate metrics, logs, and traces onto OpenTelemetry + Grafana stack. Decommission legacy Datadog agent.',
      'in_progress', 'high', ARRAY['observability','kubernetes','opentelemetry','grafana'], per_hiro)
    RETURNING id INTO e5;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_observ, e5, 'feature', 'Deploy OTel collector DaemonSet', 'done', 'critical',
      ARRAY['kubernetes','opentelemetry'], per_hiro)
    RETURNING id INTO f8;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_observ, f8, 'story', 'Write Helm chart for otelcol-k8s', 'done', 'critical',
      ARRAY['kubernetes','helm','opentelemetry'], per_hiro, 5, 'https://github.com/orgiq/infra/pull/178', 'merged');

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_observ, e5, 'feature', 'Grafana dashboards for all services', 'in_progress', 'high',
      ARRAY['grafana','observability'], per_tara)
    RETURNING id INTO f9;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_observ, f9, 'story', 'Create golden-signals dashboard per service', 'in_progress', 'high',
      ARRAY['grafana','kubernetes'], per_tara, 3, 'https://github.com/orgiq/dashboards/pull/7', 'open');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
    VALUES (p_observ, f9, 'story', 'Set up Grafana OnCall integration', 'open', 'medium',
      ARRAY['grafana','on-call'], per_sarah, 2);

    -- Link a decision to this project
    UPDATE decisions
    SET project_id   = p_observ,
        status       = 'escalated',
        required_role = 'org-leader',
        escalated_at = NOW() - INTERVAL '2 days'
    WHERE topic ILIKE '%datadog%' OR topic ILIKE '%monitor%'
    LIMIT 1;

    -- If no matching decision, insert one
    INSERT INTO decisions (id, topic, summary, status, project_id, required_role, escalated_at)
    SELECT
      'dec-observ-budget',
      'Datadog vs Grafana cost decision',
      'Grafana OSS saves ~$84k/year but requires 1 FTE to operate. Datadog managed is $110k/year. '
      'Need org-leader sign-off before decommissioning Datadog agent on 2026-06-01.',
      'escalated',
      p_observ,
      'org-leader',
      NOW() - INTERVAL '2 days'
    WHERE NOT EXISTS (
      SELECT 1 FROM decisions WHERE project_id = p_observ AND status = 'escalated'
    );

  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PROJECT 4: Auth/AuthZ
  -- ═══════════════════════════════════════════════════════════════════════════

  IF p_auth IS NOT NULL THEN

    INSERT INTO work_items (project_id, type, title, description, status, priority, labels, assignee_id)
    VALUES (p_auth, 'epic', 'Migrate to Cedar policy engine',
      'Replace legacy RBAC with Amazon Verified Permissions + Cedar policies for fine-grained AuthZ.',
      'in_progress', 'critical', ARRAY['auth','cedar','authorization','security'], per_sarah)
    RETURNING id INTO e6;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_auth, e6, 'feature', 'Policy store bootstrap', 'done', 'critical',
      ARRAY['cedar','auth'], per_sarah)
    RETURNING id INTO f10;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_auth, f10, 'story', 'Define Cedar schema for OrgIQ entities', 'done', 'critical',
      ARRAY['cedar'], per_sarah, 3, 'https://github.com/orgiq/auth/pull/21', 'merged');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_auth, f10, 'story', 'Write ReadOrg, ManageIngest, ManageCanary policies', 'done', 'critical',
      ARRAY['cedar','auth'], per_sarah, 5, 'https://github.com/orgiq/auth/pull/24', 'merged');

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id)
    VALUES (p_auth, e6, 'feature', 'Agent identity + Workload Identity tokens', 'in_progress', 'high',
      ARRAY['auth','kubernetes','workload-identity'], per_marcus)
    RETURNING id INTO f11;

    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points, pr_url, pr_status)
    VALUES (p_auth, f11, 'story', 'Issue OIDC tokens per agent at runtime', 'in_progress', 'high',
      ARRAY['auth','kubernetes','oidc'], per_marcus, 5, 'https://github.com/orgiq/auth/pull/31', 'open');
    INSERT INTO work_items (project_id, parent_id, type, title, status, priority, labels, assignee_id, story_points)
    VALUES (p_auth, f11, 'story', 'Validate token via Cedar IsAuthorizedWithToken', 'open', 'high',
      ARRAY['cedar','auth'], per_sarah, 3);

    -- Escalated decision for auth project
    INSERT INTO decisions (id, topic, summary, status, project_id, required_role, escalated_at)
    SELECT
      'dec-auth-sso',
      'SSO provider selection for contractor accounts',
      'Current Okta contract expires 2026-07-31. Must choose between renewing Okta ($42k/yr), '
      'migrating to Entra ID ($28k/yr), or running Keycloak OSS (1 FTE ops). Decision blocks '
      'contractor onboarding automation work item.',
      'escalated',
      p_auth,
      'hr-admin',
      NOW() - INTERVAL '1 day'
    WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE id = 'dec-auth-sso');

  END IF;

END $$;

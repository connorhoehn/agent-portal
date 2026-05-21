-- =============================================================================
-- seed_work_items_full.sql
-- Work item hierarchy for ALL 14 OrgIQ projects.
-- =============================================================================
-- Usage:
--   psql $DATABASE_URL -f schema/orgiq_work_items_schema.sql   # run once
--   psql $DATABASE_URL -f schema/seed.sql                      # people + projects
--   psql $DATABASE_URL -f schema/seed_work_items_full.sql      # this file
--
-- Idempotent: uses ON CONFLICT (id) DO NOTHING on every INSERT.
-- Safe to re-run; duplicate IDs are silently skipped.
-- Does NOT use PL/pgSQL — plain INSERT statements only so apply scripts
-- can split on semicolons.
--
-- Structure per project: 2 epics, 4 features (2/epic), 8 stories (2/feature),
-- 8 tasks (1/story) = 22 items × 14 projects = 308 rows total.
-- =============================================================================


-- =============================================================================
-- PROJECT: p-auth-migration  (Auth Migration — in_progress)
-- Domain : security, Cedar, OIDC, SSO
-- Assignees: p-004 Nora DaSilva, p-010 Tara Chen, p-003 Marcus O'Brien,
--            p-012 Rachel Kowalski
-- Key    : auth
-- =============================================================================

-- Epic 1: Cedar policy migration
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-auth-e1', 'p-auth-migration', NULL, 'epic',
  'Migrate authorization layer to Amazon Verified Permissions + Cedar',
  'Replace legacy ACL checks scattered across services with centralized Cedar policy evaluation via AVP. Target: all 9 agent endpoints + admin portal routes.',
  'in_progress', 'critical', 'p-004',
  ARRAY['cedar','authorization','security','avp'],
  NULL, NOW() - INTERVAL '90 days', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Cedar schema + policy authoring
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-f1', 'p-auth-migration', 'wi-auth-e1', 'feature',
  'Define Cedar entity schema and seed policy store',
  'done', 'critical', 'p-004',
  ARRAY['cedar','avp','security'],
  NOW() - INTERVAL '88 days', NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-auth-s1', 'p-auth-migration', 'wi-auth-f1', 'story',
  'Write Cedar schema covering OrgIQ entities: User, Agent, Project, Document, Skill',
  'done', 'critical', 'p-004',
  ARRAY['cedar','schema'], 3,
  'https://github.com/orgiq/auth/pull/18', 'merged',
  NOW() - INTERVAL '85 days', NOW() - INTERVAL '80 days', NOW() - INTERVAL '80 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-auth-t1', 'p-auth-migration', 'wi-auth-s1', 'task',
  'Validate Cedar schema compiles without entity type errors in AVP console',
  'done', 'high', 'p-004',
  ARRAY['cedar','avp'],
  NOW() - INTERVAL '83 days', NOW() - INTERVAL '81 days', NOW() - INTERVAL '81 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-auth-s2', 'p-auth-migration', 'wi-auth-f1', 'story',
  'Author ReadOrg, ManageIngest, ManageCanary, and AdminOverride Cedar policies',
  'done', 'critical', 'p-012',
  ARRAY['cedar','policies','authorization'], 5,
  'https://github.com/orgiq/auth/pull/24', 'merged',
  NOW() - INTERVAL '78 days', NOW() - INTERVAL '70 days', NOW() - INTERVAL '70 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-auth-t2', 'p-auth-migration', 'wi-auth-s2', 'task',
  'Write cedar-policy unit tests covering deny conditions for cross-tenant access',
  'done', 'high', 'p-012',
  ARRAY['cedar','testing'],
  NOW() - INTERVAL '75 days', NOW() - INTERVAL '71 days', NOW() - INTERVAL '71 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): AVP integration in middleware
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-f2', 'p-auth-migration', 'wi-auth-e1', 'feature',
  'Integrate AVP IsAuthorized calls into Express middleware auth layer',
  'in_progress', 'high', 'p-003',
  ARRAY['cedar','avp','middleware','nodejs'],
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-auth-s3', 'p-auth-migration', 'wi-auth-f2', 'story',
  'Replace hardcoded role checks in /api/agents/* routes with AVP IsAuthorized SDK calls',
  'done', 'high', 'p-003',
  ARRAY['cedar','avp','typescript'], 5,
  'https://github.com/orgiq/auth/pull/31', 'merged',
  NOW() - INTERVAL '65 days', NOW() - INTERVAL '55 days', NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-auth-t3', 'p-auth-migration', 'wi-auth-s3', 'task',
  'Add AVP client retry logic with exponential backoff for throttled IsAuthorized responses',
  'done', 'medium', 'p-003',
  ARRAY['avp','reliability'],
  NOW() - INTERVAL '62 days', NOW() - INTERVAL '56 days', NOW() - INTERVAL '56 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-auth-s4', 'p-auth-migration', 'wi-auth-f2', 'story',
  'Add request-context entity builder that maps JWT claims to Cedar principal + resource',
  'in_progress', 'high', 'p-010',
  ARRAY['cedar','jwt','auth'], 3,
  'https://github.com/orgiq/auth/pull/38', 'open',
  NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-t4', 'p-auth-migration', 'wi-auth-s4', 'task',
  'Handle missing sub claim gracefully — return 401 not 500 when JWT is malformed',
  'in_progress', 'high', 'p-010',
  ARRAY['jwt','error-handling'],
  NOW() - INTERVAL '28 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: OIDC / SSO federation
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-auth-e2', 'p-auth-migration', NULL, 'epic',
  'Federate workforce SSO via OIDC to Cognito + issue per-agent workload tokens',
  'Route all human logins through Okta→Cognito OIDC federation. Issue short-lived OIDC workload identity tokens to each AgentCore runtime so Cedar IsAuthorizedWithToken can evaluate agent actions.',
  'in_progress', 'high', 'p-010',
  ARRAY['oidc','sso','cognito','workload-identity'],
  NULL, NOW() - INTERVAL '60 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Cognito OIDC federation setup
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-f3', 'p-auth-migration', 'wi-auth-e2', 'feature',
  'Configure Cognito User Pool with Okta as external OIDC identity provider',
  'done', 'high', 'p-010',
  ARRAY['cognito','oidc','sso','okta'],
  NOW() - INTERVAL '58 days', NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-auth-s5', 'p-auth-migration', 'wi-auth-f3', 'story',
  'Register OrgIQ app in Okta, configure OIDC client_id and redirect URIs in Cognito',
  'done', 'high', 'p-010',
  ARRAY['cognito','okta','oidc'], 3,
  'https://github.com/orgiq/auth/pull/42', 'merged',
  NOW() - INTERVAL '56 days', NOW() - INTERVAL '48 days', NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-auth-t5', 'p-auth-migration', 'wi-auth-s5', 'task',
  'Verify Okta groups claim maps correctly to Cognito id_token groups attribute',
  'done', 'medium', 'p-010',
  ARRAY['cognito','okta','claims'],
  NOW() - INTERVAL '54 days', NOW() - INTERVAL '49 days', NOW() - INTERVAL '49 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-auth-s6', 'p-auth-migration', 'wi-auth-f3', 'story',
  'Enable Cognito hosted UI with custom domain auth.orgiq.internal and test full login flow',
  'done', 'medium', 'p-012',
  ARRAY['cognito','sso'], 2,
  'https://github.com/orgiq/auth/pull/45', 'merged',
  NOW() - INTERVAL '47 days', NOW() - INTERVAL '42 days', NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-auth-t6', 'p-auth-migration', 'wi-auth-s6', 'task',
  'Smoke-test SSO login with 3 test accounts across org-leader, engineer, and viewer roles',
  'done', 'high', 'p-012',
  ARRAY['sso','testing'],
  NOW() - INTERVAL '44 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Workload identity tokens for agents
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-f4', 'p-auth-migration', 'wi-auth-e2', 'feature',
  'Issue OIDC workload identity tokens to AgentCore runtimes for Cedar evaluation',
  'in_progress', 'high', 'p-003',
  ARRAY['workload-identity','oidc','agentcore','cedar'],
  NOW() - INTERVAL '35 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-auth-s7', 'p-auth-migration', 'wi-auth-f4', 'story',
  'Implement AgentCore Workload Identity credential provider in agents/_shared/identity.py',
  'in_review', 'high', 'p-003',
  ARRAY['workload-identity','python','agentcore'], 5,
  'https://github.com/orgiq/auth/pull/51', 'open',
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-t7', 'p-auth-migration', 'wi-auth-s7', 'task',
  'Pin token TTL to 15 minutes and auto-refresh 60 seconds before expiry',
  'in_progress', 'high', 'p-003',
  ARRAY['workload-identity','token-refresh'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-auth-s8', 'p-auth-migration', 'wi-auth-f4', 'story',
  'Wire IsAuthorizedWithToken call in supervisor agent before each tool dispatch',
  'open', 'high', 'p-004',
  ARRAY['cedar','avp','strands-agents'], 3,
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-auth-t8', 'p-auth-migration', 'wi-auth-s8', 'task',
  'Add Cedar decision logging to Aurora observability_events table for audit trail',
  'open', 'medium', 'p-004',
  ARRAY['cedar','audit','aurora'],
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-observability  (Observability Platform — in_progress)
-- Domain : OTel, Grafana, SLOs, SRE
-- Assignees: p-008 Layla Hassan, p-009 Marcus Shah, p-011 Eli Garcia,
--            p-013 Caleb Turner
-- Key    : obs
-- =============================================================================

-- Epic 1: OpenTelemetry collector + trace pipeline
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-e1', 'p-observability', NULL, 'epic',
  'Deploy OpenTelemetry collector pipeline across all agent and portal services',
  'Stand up otelcol-contrib DaemonSet, configure receivers (OTLP, Prometheus, Kubernetes), and route spans to both Grafana Tempo and the Aurora span-projector Lambda.',
  'in_progress', 'critical', 'p-013',
  ARRAY['opentelemetry','observability','kubernetes','tracing'],
  NULL, NOW() - INTERVAL '70 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): OTel collector deployment
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-f1', 'p-observability', 'wi-obs-e1', 'feature',
  'Write and deploy otelcol-contrib Helm chart with Kubernetes receiver',
  'done', 'critical', 'p-013',
  ARRAY['opentelemetry','helm','kubernetes'],
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-obs-s1', 'p-observability', 'wi-obs-f1', 'story',
  'Configure Grafana Alloy scrape intervals for high-cardinality Kubernetes pod metrics',
  'done', 'high', 'p-013',
  ARRAY['grafana','alloy','prometheus','kubernetes'], 5,
  'https://github.com/orgiq/observability/pull/11', 'merged',
  NOW() - INTERVAL '65 days', NOW() - INTERVAL '55 days', NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obs-t1', 'p-observability', 'wi-obs-s1', 'task',
  'Tune scrape_interval to 30s for high-cardinality label sets to reduce TSDB write pressure',
  'done', 'medium', 'p-013',
  ARRAY['prometheus','performance'],
  NOW() - INTERVAL '63 days', NOW() - INTERVAL '56 days', NOW() - INTERVAL '56 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-obs-s2', 'p-observability', 'wi-obs-f1', 'story',
  'Add OTLP exporter to collector config pointing at Grafana Tempo ingest endpoint',
  'done', 'high', 'p-008',
  ARRAY['opentelemetry','tempo','tracing'], 3,
  'https://github.com/orgiq/observability/pull/14', 'merged',
  NOW() - INTERVAL '58 days', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obs-t2', 'p-observability', 'wi-obs-s2', 'task',
  'Validate trace propagation from portal SSE request through supervisor agent to search agent',
  'done', 'high', 'p-008',
  ARRAY['tracing','opentelemetry','e2e'],
  NOW() - INTERVAL '55 days', NOW() - INTERVAL '51 days', NOW() - INTERVAL '51 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Aurora span projector integration
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-f2', 'p-observability', 'wi-obs-e1', 'feature',
  'Wire OTel spans from ADOT exporter into Aurora observability tables via SpanProjector Lambda',
  'in_progress', 'high', 'p-009',
  ARRAY['opentelemetry','aurora','lambda','openinference'],
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-obs-s3', 'p-observability', 'wi-obs-f2', 'story',
  'Extend SpanProjector Lambda to parse OpenInference semantic conventions and map to observability_spans schema',
  'done', 'high', 'p-009',
  ARRAY['openinference','lambda','aurora'], 8,
  'https://github.com/orgiq/observability/pull/22', 'merged',
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '28 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obs-t3', 'p-observability', 'wi-obs-s3', 'task',
  'Handle span batches larger than Lambda 6MB payload limit by chunking before Aurora RDS Data API write',
  'done', 'critical', 'p-009',
  ARRAY['lambda','aurora','rds-data-api'],
  NOW() - INTERVAL '35 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-obs-s4', 'p-observability', 'wi-obs-f2', 'story',
  'Add OBS_USE_LEGACY_POLLER fallback in middleware to poll CloudWatch when Lambda projector lags',
  'in_progress', 'medium', 'p-011',
  ARRAY['cloudwatch','middleware','observability'], 3,
  'https://github.com/orgiq/observability/pull/29', 'open',
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-t4', 'p-observability', 'wi-obs-s4', 'task',
  'Expose OBS_LAG_THRESHOLD_SECONDS env var and emit metric when projector lag exceeds threshold',
  'in_progress', 'medium', 'p-011',
  ARRAY['cloudwatch','metrics'],
  NOW() - INTERVAL '12 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: SLO framework + alerting
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-e2', 'p-observability', NULL, 'epic',
  'Define and instrument SLOs for all agent endpoints with Grafana Alerting',
  'Author error-budget SLOs (availability, p99 latency) for each OrgIQ agent runtime, wire burn-rate alerts, and build Grafana OnCall escalation policies.',
  'in_progress', 'high', 'p-008',
  ARRAY['slo','grafana','alerting','sre'],
  NULL, NOW() - INTERVAL '50 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): SLO definitions
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-f3', 'p-observability', 'wi-obs-e2', 'feature',
  'Author SLO YAML definitions for supervisor, search, and scoring agents',
  'done', 'high', 'p-008',
  ARRAY['slo','grafana','prometheus'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-obs-s5', 'p-observability', 'wi-obs-f3', 'story',
  'Define 99.5% availability SLO for orgiq-supervisor with 30-day rolling window error budget',
  'done', 'high', 'p-008',
  ARRAY['slo','supervisor'], 3,
  'https://github.com/orgiq/observability/pull/33', 'merged',
  NOW() - INTERVAL '46 days', NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obs-t5', 'p-observability', 'wi-obs-s5', 'task',
  'Back-fill 7-day baseline from CloudWatch to validate SLO threshold before enabling burn-rate alert',
  'done', 'medium', 'p-008',
  ARRAY['cloudwatch','slo','baseline'],
  NOW() - INTERVAL '44 days', NOW() - INTERVAL '39 days', NOW() - INTERVAL '39 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-obs-s6', 'p-observability', 'wi-obs-f3', 'story',
  'Configure p99 latency SLO of 2s for orgiq-search agent using Tempo trace data',
  'done', 'high', 'p-011',
  ARRAY['slo','latency','tempo'], 3,
  'https://github.com/orgiq/observability/pull/36', 'merged',
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-obs-t6', 'p-observability', 'wi-obs-s6', 'task',
  'Verify histogram bucket boundaries include 500ms, 1s, 2s marks for SLO query accuracy',
  'done', 'medium', 'p-011',
  ARRAY['prometheus','histogram','slo'],
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '34 days', NOW() - INTERVAL '34 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Grafana OnCall + alerting
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-f4', 'p-observability', 'wi-obs-e2', 'feature',
  'Set up Grafana OnCall with escalation chains for burn-rate and capacity alerts',
  'in_progress', 'high', 'p-009',
  ARRAY['grafana','oncall','alerting','sre'],
  NOW() - INTERVAL '25 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-obs-s7', 'p-observability', 'wi-obs-f4', 'story',
  'Configure 5x burn-rate Grafana alert rule for supervisor availability SLO with 1-hour window',
  'in_review', 'high', 'p-009',
  ARRAY['grafana','slo','alerting'], 3,
  'https://github.com/orgiq/observability/pull/41', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-t7', 'p-observability', 'wi-obs-s7', 'task',
  'Create Grafana OnCall escalation: page on-call SRE after 5 min, escalate to team lead after 20 min',
  'in_progress', 'high', 'p-009',
  ARRAY['grafana','oncall'],
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-obs-s8', 'p-observability', 'wi-obs-f4', 'story',
  'Build Grafana dashboard for real-time error budget burn visualization across all agent SLOs',
  'open', 'medium', 'p-008',
  ARRAY['grafana','slo','dashboard'], 5,
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-obs-t8', 'p-observability', 'wi-obs-s8', 'task',
  'Add error budget remaining annotation panels to existing golden-signals dashboard',
  'open', 'low', 'p-008',
  ARRAY['grafana','dashboard'],
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-cost-opt  (Cost Optimization — in_progress)
-- Domain : FinOps, rightsizing, reserved instances
-- Assignees: p-001 Theo Chang, p-007 Marcus Müller, p-013 Caleb Turner,
--            p-018 Sarah Ahmed
-- Key    : cost
-- =============================================================================

-- Epic 1: FinOps visibility + tagging
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-e1', 'p-cost-opt', NULL, 'epic',
  'Establish FinOps tagging taxonomy and Cost Explorer dashboards per team',
  'Enforce mandatory cost allocation tags (team, service, env) across all AWS resources. Build Cost Explorer saved reports per team and configure monthly budget alerts.',
  'in_progress', 'high', 'p-001',
  ARRAY['finops','cost-optimization','tagging','aws'],
  NULL, NOW() - INTERVAL '60 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Tagging enforcement
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-f1', 'p-cost-opt', 'wi-cost-e1', 'feature',
  'Implement AWS Config managed rule to flag untagged resources and SCP to block non-compliant launches',
  'done', 'high', 'p-001',
  ARRAY['aws-config','scp','tagging','finops'],
  NOW() - INTERVAL '58 days', NOW() - INTERVAL '40 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-cost-s1', 'p-cost-opt', 'wi-cost-f1', 'story',
  'Author SCP that prevents EC2 and RDS launches without mandatory cost-allocation tags',
  'done', 'high', 'p-001',
  ARRAY['scp','tagging','iam'], 3,
  'https://github.com/orgiq/cost-opt/pull/7', 'merged',
  NOW() - INTERVAL '56 days', NOW() - INTERVAL '48 days', NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cost-t1', 'p-cost-opt', 'wi-cost-s1', 'task',
  'Test SCP in sandbox account — verify ec2:RunInstances is denied without team tag',
  'done', 'high', 'p-001',
  ARRAY['scp','testing','iam'],
  NOW() - INTERVAL '54 days', NOW() - INTERVAL '49 days', NOW() - INTERVAL '49 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-cost-s2', 'p-cost-opt', 'wi-cost-f1', 'story',
  'Enable AWS Config rule required-tags across all regions and pipe findings to SecurityHub',
  'done', 'medium', 'p-007',
  ARRAY['aws-config','securityhub','compliance'], 3,
  'https://github.com/orgiq/cost-opt/pull/10', 'merged',
  NOW() - INTERVAL '50 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cost-t2', 'p-cost-opt', 'wi-cost-s2', 'task',
  'Create SecurityHub custom insight for untagged resource count trend over 30 days',
  'done', 'low', 'p-007',
  ARRAY['securityhub','finops'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '44 days', NOW() - INTERVAL '44 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Cost Explorer dashboards
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-f2', 'p-cost-opt', 'wi-cost-e1', 'feature',
  'Build Cost Explorer saved reports and budget alarms per team',
  'in_progress', 'medium', 'p-013',
  ARRAY['cost-explorer','budgets','finops'],
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-cost-s3', 'p-cost-opt', 'wi-cost-f2', 'story',
  'Create Cost Explorer saved reports filtered by team tag for Platform Eng, Data Platform, and Product',
  'done', 'medium', 'p-013',
  ARRAY['cost-explorer','finops'], 2,
  'https://github.com/orgiq/cost-opt/pull/15', 'merged',
  NOW() - INTERVAL '36 days', NOW() - INTERVAL '28 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cost-t3', 'p-cost-opt', 'wi-cost-s3', 'task',
  'Share Cost Explorer report links with team leads via Slack #finops channel',
  'done', 'low', 'p-013',
  ARRAY['finops','communication'],
  NOW() - INTERVAL '34 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-cost-s4', 'p-cost-opt', 'wi-cost-f2', 'story',
  'Configure AWS Budget alarm at 80% and 100% of monthly $15k ceiling per team with SNS notifications',
  'in_progress', 'high', 'p-007',
  ARRAY['aws-budgets','sns','finops'], 2,
  'https://github.com/orgiq/cost-opt/pull/19', 'open',
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-t4', 'p-cost-opt', 'wi-cost-s4', 'task',
  'Verify SNS budget alert email reaches on-call distribution list within 5 minutes of threshold breach',
  'in_progress', 'medium', 'p-007',
  ARRAY['sns','budgets','testing'],
  NOW() - INTERVAL '12 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Rightsizing + RI/Savings Plans
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-e2', 'p-cost-opt', NULL, 'epic',
  'Execute compute rightsizing recommendations and purchase Savings Plans',
  'Use AWS Compute Optimizer and Trusted Advisor to identify oversized instances, resize them, and convert on-demand spend to Savings Plans or Reserved Instances.',
  'in_progress', 'high', 'p-013',
  ARRAY['rightsizing','savings-plans','reserved-instances','finops'],
  NULL, NOW() - INTERVAL '45 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Rightsizing execution
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-f3', 'p-cost-opt', 'wi-cost-e2', 'feature',
  'Downsize over-provisioned EC2 and RDS instances flagged by Compute Optimizer',
  'done', 'high', 'p-001',
  ARRAY['ec2','rds','rightsizing','compute-optimizer'],
  NOW() - INTERVAL '43 days', NOW() - INTERVAL '25 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-cost-s5', 'p-cost-opt', 'wi-cost-f3', 'story',
  'Resize 6 m5.2xlarge development EC2 instances to m5.xlarge based on Compute Optimizer recommendations',
  'done', 'high', 'p-001',
  ARRAY['ec2','rightsizing'], 3,
  'https://github.com/orgiq/cost-opt/pull/23', 'merged',
  NOW() - INTERVAL '41 days', NOW() - INTERVAL '32 days', NOW() - INTERVAL '32 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cost-t5', 'p-cost-opt', 'wi-cost-s5', 'task',
  'Monitor P99 CPU utilization for 72h post-resize and roll back if it exceeds 85%',
  'done', 'high', 'p-001',
  ARRAY['ec2','monitoring','rollback'],
  NOW() - INTERVAL '39 days', NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-cost-s6', 'p-cost-opt', 'wi-cost-f3', 'story',
  'Change Aurora Serverless v2 minimum ACU from 2 to 0.5 across non-production clusters',
  'done', 'medium', 'p-007',
  ARRAY['aurora','rds','cost-optimization'], 2,
  'https://github.com/orgiq/cost-opt/pull/27', 'merged',
  NOW() - INTERVAL '35 days', NOW() - INTERVAL '28 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-cost-t6', 'p-cost-opt', 'wi-cost-s6', 'task',
  'Verify Aurora cluster cold-start time remains under 30s after ACU reduction',
  'done', 'medium', 'p-007',
  ARRAY['aurora','performance'],
  NOW() - INTERVAL '33 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Savings Plans purchase
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-f4', 'p-cost-opt', 'wi-cost-e2', 'feature',
  'Analyze and purchase Compute Savings Plans to reduce on-demand EC2 and Fargate spend by 30%',
  'in_progress', 'high', 'p-013',
  ARRAY['savings-plans','ec2','finops','reserved-instances'],
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-cost-s7', 'p-cost-opt', 'wi-cost-f4', 'story',
  'Run Savings Plans coverage analysis in Cost Explorer for trailing 30-day compute baseline',
  'in_review', 'high', 'p-013',
  ARRAY['savings-plans','cost-explorer','finops'], 2,
  'https://github.com/orgiq/cost-opt/pull/31', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-t7', 'p-cost-opt', 'wi-cost-s7', 'task',
  'Export Savings Plans recommendation CSV and share with finance for approval signature',
  'in_progress', 'medium', 'p-013',
  ARRAY['savings-plans','finops','approval'],
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-cost-s8', 'p-cost-opt', 'wi-cost-f4', 'story',
  'Purchase 1-year Compute Savings Plan at $8k/month commitment after finance sign-off',
  'open', 'high', 'p-007',
  ARRAY['savings-plans','finops'], 1,
  NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-cost-t8', 'p-cost-opt', 'wi-cost-s8', 'task',
  'Set up Savings Plans utilization alert at <80% utilization to detect over-commitment early',
  'open', 'medium', 'p-007',
  ARRAY['savings-plans','cloudwatch','alerting'],
  NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-realtime-analytics  (Real-time Analytics Pipeline — in_progress)
-- Domain : Kafka, Flink, streaming
-- Assignees: p-015 Raj Mehta, p-017 Daniel Chang, p-019 Lena Dubois,
--            p-020 Henry Hassan
-- Key    : rta
-- =============================================================================

-- Epic 1: Kafka cluster + producer onboarding
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-e1', 'p-realtime-analytics', NULL, 'epic',
  'Stand up MSK Kafka cluster and onboard first-party event producers',
  'Provision Amazon MSK (Kafka 3.6) with 3-AZ broker topology, configure IAM auth and TLS in-transit, and migrate orgiq-events service from SQS fan-out to Kafka topics.',
  'in_progress', 'critical', 'p-017',
  ARRAY['kafka','msk','streaming','data-platform'],
  NULL, NOW() - INTERVAL '75 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): MSK cluster provisioning
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-f1', 'p-realtime-analytics', 'wi-rta-e1', 'feature',
  'Provision MSK cluster with 3-AZ broker layout and IAM authentication',
  'done', 'critical', 'p-017',
  ARRAY['kafka','msk','iam','cdk'],
  NOW() - INTERVAL '73 days', NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rta-s1', 'p-realtime-analytics', 'wi-rta-f1', 'story',
  'Author CDK stack for MSK cluster with 3 m5.xlarge brokers across us-east-1a/b/c',
  'done', 'critical', 'p-017',
  ARRAY['kafka','msk','cdk','infrastructure'], 8,
  'https://github.com/orgiq/realtime-analytics/pull/3', 'merged',
  NOW() - INTERVAL '71 days', NOW() - INTERVAL '62 days', NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rta-t1', 'p-realtime-analytics', 'wi-rta-s1', 'task',
  'Validate MSK replication factor=3 and min.insync.replicas=2 on all topics via kafka-configs.sh',
  'done', 'high', 'p-017',
  ARRAY['kafka','replication','reliability'],
  NOW() - INTERVAL '69 days', NOW() - INTERVAL '63 days', NOW() - INTERVAL '63 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rta-s2', 'p-realtime-analytics', 'wi-rta-f1', 'story',
  'Configure MSK IAM policy for producer and consumer roles with topic-level ACLs',
  'done', 'high', 'p-020',
  ARRAY['kafka','iam','security'], 3,
  'https://github.com/orgiq/realtime-analytics/pull/6', 'merged',
  NOW() - INTERVAL '65 days', NOW() - INTERVAL '58 days', NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rta-t2', 'p-realtime-analytics', 'wi-rta-s2', 'task',
  'Test producer IAM auth rejects writes to topics outside its ACL prefix',
  'done', 'medium', 'p-020',
  ARRAY['kafka','iam','testing'],
  NOW() - INTERVAL '63 days', NOW() - INTERVAL '59 days', NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Producer migration from SQS
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-f2', 'p-realtime-analytics', 'wi-rta-e1', 'feature',
  'Migrate orgiq-events SQS producer to Kafka with dual-write failover',
  'in_progress', 'high', 'p-019',
  ARRAY['kafka','sqs','migration','streaming'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rta-s3', 'p-realtime-analytics', 'wi-rta-f2', 'story',
  'Add exponential backoff to Kafka consumer retry handler for transient broker disconnects',
  'done', 'high', 'p-019',
  ARRAY['kafka','retry','reliability'], 3,
  'https://github.com/orgiq/realtime-analytics/pull/14', 'merged',
  NOW() - INTERVAL '45 days', NOW() - INTERVAL '37 days', NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rta-t3', 'p-realtime-analytics', 'wi-rta-s3', 'task',
  'Simulate broker failure in staging MSK cluster and verify consumer reconnects within 30s',
  'done', 'high', 'p-019',
  ARRAY['kafka','testing','chaos'],
  NOW() - INTERVAL '43 days', NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-rta-s4', 'p-realtime-analytics', 'wi-rta-f2', 'story',
  'Implement dual-write mode in orgiq-events: write to both SQS and Kafka topics for 2-week parallel run',
  'in_progress', 'high', 'p-015',
  ARRAY['kafka','sqs','dual-write','migration'], 5,
  'https://github.com/orgiq/realtime-analytics/pull/19', 'open',
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-t4', 'p-realtime-analytics', 'wi-rta-s4', 'task',
  'Compare SQS vs Kafka message counts over 24h window and alert if drift exceeds 0.01%',
  'in_progress', 'high', 'p-015',
  ARRAY['kafka','sqs','monitoring','dual-write'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Flink streaming jobs
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-e2', 'p-realtime-analytics', NULL, 'epic',
  'Develop Apache Flink jobs for real-time aggregation and anomaly detection on event stream',
  'Write Flink DataStream jobs for: (1) per-agent invocation rate aggregation → Aurora, (2) latency anomaly detection → alert topic, (3) session windowing for user journey analytics.',
  'in_progress', 'high', 'p-020',
  ARRAY['flink','streaming','kafka','data-platform'],
  NULL, NOW() - INTERVAL '55 days', NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Flink job infrastructure
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-f3', 'p-realtime-analytics', 'wi-rta-e2', 'feature',
  'Set up Amazon Managed Service for Apache Flink application with MSK VPC connectivity',
  'done', 'high', 'p-020',
  ARRAY['flink','msk','vpc','aws'],
  NOW() - INTERVAL '53 days', NOW() - INTERVAL '35 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rta-s5', 'p-realtime-analytics', 'wi-rta-f3', 'story',
  'Validate Flink job checkpoint recovery after task manager failure using RocksDB state backend',
  'done', 'high', 'p-020',
  ARRAY['flink','checkpointing','rocksdb'], 5,
  'https://github.com/orgiq/realtime-analytics/pull/24', 'merged',
  NOW() - INTERVAL '50 days', NOW() - INTERVAL '41 days', NOW() - INTERVAL '41 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rta-t5', 'p-realtime-analytics', 'wi-rta-s5', 'task',
  'Set Flink checkpoint interval to 60s and savepoint retention to 5 checkpoints in managed Flink config',
  'done', 'medium', 'p-020',
  ARRAY['flink','checkpointing'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '42 days', NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rta-s6', 'p-realtime-analytics', 'wi-rta-f3', 'story',
  'Write Flink connector config for MSK source with SASL/SCRAM auth and consumer group orgiq-flink',
  'done', 'high', 'p-017',
  ARRAY['flink','kafka','msk','sasl'], 3,
  'https://github.com/orgiq/realtime-analytics/pull/27', 'merged',
  NOW() - INTERVAL '44 days', NOW() - INTERVAL '36 days', NOW() - INTERVAL '36 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rta-t6', 'p-realtime-analytics', 'wi-rta-s6', 'task',
  'Verify Flink consumer lag stays below 10k messages during peak ingest via MSK CloudWatch metrics',
  'done', 'medium', 'p-017',
  ARRAY['flink','kafka','monitoring'],
  NOW() - INTERVAL '42 days', NOW() - INTERVAL '37 days', NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Flink streaming jobs implementation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-f4', 'p-realtime-analytics', 'wi-rta-e2', 'feature',
  'Implement per-agent invocation rate aggregation job with 1-minute tumbling window',
  'in_progress', 'high', 'p-019',
  ARRAY['flink','streaming','kafka','aggregation'],
  NOW() - INTERVAL '28 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-rta-s7', 'p-realtime-analytics', 'wi-rta-f4', 'story',
  'Write Flink KeyedProcessFunction that counts invocations per agent per tumbling-minute window and sinks to Aurora',
  'in_review', 'high', 'p-019',
  ARRAY['flink','aggregation','aurora'], 8,
  'https://github.com/orgiq/realtime-analytics/pull/33', 'open',
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-t7', 'p-realtime-analytics', 'wi-rta-s7', 'task',
  'Add watermark strategy with 5s allowed lateness to handle out-of-order Kafka messages in aggregation job',
  'in_progress', 'high', 'p-019',
  ARRAY['flink','watermarks','streaming'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-rta-s8', 'p-realtime-analytics', 'wi-rta-f4', 'story',
  'Implement latency anomaly detector: flag agent calls where p95 latency exceeds 3× 7-day baseline',
  'open', 'high', 'p-015',
  ARRAY['flink','anomaly-detection','latency'], 8,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-rta-t8', 'p-realtime-analytics', 'wi-rta-s8', 'task',
  'Publish anomaly events to MSK orgiq.alerts.latency topic and wire Kafka consumer in observability service',
  'open', 'medium', 'p-015',
  ARRAY['kafka','alerting','flink'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- PROJECT: p-data-lake  (Data Lake Migration — planning)
-- Domain : S3, Athena, Glue, Iceberg
-- Assignees: p-015 Raj Mehta, p-016 Tara Wright, p-017 Daniel Chang,
--            p-024 Theo Williams
-- Key    : dlk
-- Status rules: planning — most open, first epic in_progress at most
-- =============================================================================

-- Epic 1: Data lake foundation on S3 + Iceberg
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-e1', 'p-data-lake', NULL, 'epic',
  'Establish S3-based data lake with Apache Iceberg table format and AWS Glue catalog',
  'Migrate from on-prem Hadoop HDFS to S3 Intelligent-Tiering with Iceberg v2 table format, Glue Data Catalog as HMS replacement, and Athena for ad-hoc SQL.',
  'in_progress', 'high', 'p-017',
  ARRAY['s3','iceberg','glue','athena','data-lake'],
  NULL, NOW() - INTERVAL '30 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Glue catalog + Iceberg setup
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-f1', 'p-data-lake', 'wi-dlk-e1', 'feature',
  'Configure Glue Data Catalog with LakeFormation permissions and Iceberg format defaults',
  'in_progress', 'high', 'p-017',
  ARRAY['glue','lakeformation','iceberg','data-lake'],
  NOW() - INTERVAL '28 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-dlk-s1', 'p-data-lake', 'wi-dlk-f1', 'story',
  'Create Glue catalog database orgiq_lake with Iceberg table format as default in CDK',
  'in_review', 'high', 'p-017',
  ARRAY['glue','iceberg','cdk'], 3,
  'https://github.com/orgiq/data-lake/pull/2', 'open',
  NOW() - INTERVAL '25 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t1', 'p-data-lake', 'wi-dlk-s1', 'task',
  'Enable LakeFormation hybrid access mode so existing Glue IAM grants continue to work during migration',
  'in_progress', 'medium', 'p-017',
  ARRAY['lakeformation','glue','iam'],
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '9 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s2', 'p-data-lake', 'wi-dlk-f1', 'story',
  'Register S3 orgiq-datalake-{account}-us-east-1 bucket as LakeFormation data location',
  'open', 'high', 'p-024',
  ARRAY['lakeformation','s3','data-lake'], 2,
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t2', 'p-data-lake', 'wi-dlk-s2', 'task',
  'Verify S3 bucket policy allows LakeFormation service role GetObject and PutObject',
  'open', 'medium', 'p-024',
  ARRAY['lakeformation','s3','iam'],
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Athena + query performance
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-f2', 'p-data-lake', 'wi-dlk-e1', 'feature',
  'Configure Athena workgroups per team with per-query data scanned limits',
  'open', 'medium', 'p-015',
  ARRAY['athena','data-lake','cost-optimization'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s3', 'p-data-lake', 'wi-dlk-f2', 'story',
  'Create Athena workgroups for data-platform, product, and platform-eng teams with 1TB/query scan limit',
  'open', 'medium', 'p-015',
  ARRAY['athena','workgroups','finops'], 2,
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '16 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t3', 'p-data-lake', 'wi-dlk-s3', 'task',
  'Tag Athena workgroups with team and cost-center tags for Cost Explorer attribution',
  'open', 'low', 'p-015',
  ARRAY['athena','tagging','finops'],
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '16 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s4', 'p-data-lake', 'wi-dlk-f2', 'story',
  'Benchmark Iceberg vs Parquet scan performance on 1TB orgiq_events dataset in Athena',
  'open', 'medium', 'p-024',
  ARRAY['athena','iceberg','performance'], 3,
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t4', 'p-data-lake', 'wi-dlk-s4', 'task',
  'Document Iceberg compaction schedule to prevent small-file proliferation in high-write tables',
  'open', 'low', 'p-024',
  ARRAY['iceberg','performance','maintenance'],
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Glue ETL pipeline migration
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-e2', 'p-data-lake', NULL, 'epic',
  'Rewrite on-prem Spark ETL jobs as AWS Glue 4.0 jobs with Iceberg merge-on-read',
  'Migrate 12 legacy Spark batch jobs from on-prem EMR to Glue 4.0 (Spark 3.5). Use Iceberg MERGE INTO for upsert pattern. Enable Glue job bookmarks for incremental loads.',
  'open', 'high', 'p-024',
  ARRAY['glue','spark','etl','iceberg','data-lake'],
  NULL, NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Glue job authoring
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-f3', 'p-data-lake', 'wi-dlk-e2', 'feature',
  'Port first 3 Spark ETL jobs (org_events, people_sync, doc_ingestion) to Glue 4.0',
  'open', 'high', 'p-015',
  ARRAY['glue','spark','etl','migration'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s5', 'p-data-lake', 'wi-dlk-f3', 'story',
  'Rewrite org_events Spark job as Glue 4.0 PySpark script with Iceberg MERGE INTO upsert',
  'open', 'high', 'p-015',
  ARRAY['glue','spark','iceberg','pyspark'], 8,
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '16 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t5', 'p-data-lake', 'wi-dlk-s5', 'task',
  'Enable Glue job bookmark on org_events job to process only new S3 prefixes since last run',
  'open', 'medium', 'p-015',
  ARRAY['glue','job-bookmark','incremental'],
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '16 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s6', 'p-data-lake', 'wi-dlk-f3', 'story',
  'Port people_sync Spark job to Glue 4.0 with schema evolution support for new Aurora columns',
  'open', 'medium', 'p-016',
  ARRAY['glue','spark','schema-evolution'], 5,
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t6', 'p-data-lake', 'wi-dlk-s6', 'task',
  'Write Glue job unit tests using pytest-mock to stub S3 and Iceberg catalog calls',
  'open', 'medium', 'p-016',
  ARRAY['glue','testing','pyspark'],
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Data quality + validation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-f4', 'p-data-lake', 'wi-dlk-e2', 'feature',
  'Integrate AWS Glue Data Quality rules into ETL pipeline for schema and null-rate checks',
  'open', 'medium', 'p-024',
  ARRAY['glue','data-quality','etl'],
  NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s7', 'p-data-lake', 'wi-dlk-f4', 'story',
  'Author Glue Data Quality ruleset: non-null PK, row-count delta < 10%, schema match',
  'open', 'medium', 'p-024',
  ARRAY['glue','data-quality','dqdl'], 3,
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t7', 'p-data-lake', 'wi-dlk-s7', 'task',
  'Configure Glue Data Quality to publish rule results to CloudWatch and fail job on critical rule breach',
  'open', 'medium', 'p-024',
  ARRAY['glue','cloudwatch','data-quality'],
  NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dlk-s8', 'p-data-lake', 'wi-dlk-f4', 'story',
  'Build Grafana dashboard pulling Glue Data Quality pass/fail metrics from CloudWatch',
  'open', 'low', 'p-016',
  ARRAY['grafana','data-quality','cloudwatch'], 3,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dlk-t8', 'p-data-lake', 'wi-dlk-s8', 'task',
  'Add data freshness annotation to dashboard showing time since last successful Glue job run',
  'open', 'low', 'p-016',
  ARRAY['grafana','dashboard','data-quality'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-feature-store  (ML Feature Store — in_progress)
-- Domain : SageMaker, feature pipelines, ML
-- Assignees: p-006 Maria Johnson, p-022 Sarah Thompson, p-025 Aisha Mehta,
--            p-024 Theo Williams
-- Key    : fst
-- =============================================================================

-- Epic 1: SageMaker Feature Store setup + feature pipelines
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-e1', 'p-feature-store', NULL, 'epic',
  'Bootstrap SageMaker Feature Store with online + offline stores and first feature groups',
  'Create feature groups for person expertise scores, document embeddings, and project health signals. Configure online store (ElastiCache) for low-latency inference and offline store (S3 Iceberg) for training.',
  'in_progress', 'high', 'p-025',
  ARRAY['sagemaker','feature-store','ml','mlops'],
  NULL, NOW() - INTERVAL '65 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Feature group creation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-f1', 'p-feature-store', 'wi-fst-e1', 'feature',
  'Define and register expertise-score and document-embedding feature groups in SageMaker',
  'done', 'high', 'p-025',
  ARRAY['sagemaker','feature-store','feature-groups'],
  NOW() - INTERVAL '63 days', NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-fst-s1', 'p-feature-store', 'wi-fst-f1', 'story',
  'Create person-expertise-scores feature group with 12 feature definitions and record identifier person_id',
  'done', 'high', 'p-025',
  ARRAY['sagemaker','feature-groups','ml'], 5,
  'https://github.com/orgiq/feature-store/pull/4', 'merged',
  NOW() - INTERVAL '61 days', NOW() - INTERVAL '52 days', NOW() - INTERVAL '52 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-fst-t1', 'p-feature-store', 'wi-fst-s1', 'task',
  'Validate feature group online store returns sub-10ms GetRecord latency at p99 in us-east-1',
  'done', 'high', 'p-025',
  ARRAY['sagemaker','latency','feature-store'],
  NOW() - INTERVAL '59 days', NOW() - INTERVAL '53 days', NOW() - INTERVAL '53 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-fst-s2', 'p-feature-store', 'wi-fst-f1', 'story',
  'Register doc-embedding-1024d feature group with vector feature type for Titan V2 output',
  'done', 'high', 'p-022',
  ARRAY['sagemaker','embeddings','feature-groups','titan'], 3,
  'https://github.com/orgiq/feature-store/pull/7', 'merged',
  NOW() - INTERVAL '55 days', NOW() - INTERVAL '47 days', NOW() - INTERVAL '47 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-fst-t2', 'p-feature-store', 'wi-fst-s2', 'task',
  'Run batch ingestion of 10k document embeddings using PutRecord and verify offline store S3 partitioning',
  'done', 'medium', 'p-022',
  ARRAY['sagemaker','feature-store','batch-ingestion'],
  NOW() - INTERVAL '53 days', NOW() - INTERVAL '48 days', NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Feature pipeline automation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-f2', 'p-feature-store', 'wi-fst-e1', 'feature',
  'Build SageMaker Pipelines step to recompute expertise scores and update feature store daily',
  'in_progress', 'high', 'p-006',
  ARRAY['sagemaker','pipelines','mlops','feature-store'],
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-fst-s3', 'p-feature-store', 'wi-fst-f2', 'story',
  'Write SageMaker Processing step that reads Aurora scores and calls FeatureStore PutRecord in batch',
  'done', 'high', 'p-006',
  ARRAY['sagemaker','feature-store','aurora','processing'], 8,
  'https://github.com/orgiq/feature-store/pull/12', 'merged',
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '28 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-fst-t3', 'p-feature-store', 'wi-fst-s3', 'task',
  'Add idempotent event_time field to each feature record to prevent duplicate ingestion on retry',
  'done', 'medium', 'p-006',
  ARRAY['sagemaker','feature-store','idempotency'],
  NOW() - INTERVAL '36 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-fst-s4', 'p-feature-store', 'wi-fst-f2', 'story',
  'Schedule SageMaker Pipeline daily run via EventBridge and add Slack notification on failure',
  'in_progress', 'medium', 'p-024',
  ARRAY['sagemaker','eventbridge','mlops'], 3,
  'https://github.com/orgiq/feature-store/pull/17', 'open',
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-t4', 'p-feature-store', 'wi-fst-s4', 'task',
  'Wire SageMaker Pipeline failure CloudWatch alarm to SNS topic subscribed by #ml-alerts Slack channel',
  'in_progress', 'medium', 'p-024',
  ARRAY['sagemaker','cloudwatch','slack','alerting'],
  NOW() - INTERVAL '12 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Feature serving + model training integration
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-e2', 'p-feature-store', NULL, 'epic',
  'Integrate feature store with online inference endpoint and batch training dataset generation',
  'Serve expertise features from online store in orgiq-scoring agent. Generate training datasets from offline store snapshots for model retraining jobs.',
  'in_progress', 'high', 'p-006',
  ARRAY['sagemaker','feature-store','inference','training'],
  NULL, NOW() - INTERVAL '45 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Online feature serving in scoring agent
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-f3', 'p-feature-store', 'wi-fst-e2', 'feature',
  'Add FeatureStore GetRecord calls to orgiq-scoring agent for real-time expertise feature lookup',
  'done', 'high', 'p-022',
  ARRAY['sagemaker','feature-store','scoring-agent'],
  NOW() - INTERVAL '43 days', NOW() - INTERVAL '25 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-fst-s5', 'p-feature-store', 'wi-fst-f3', 'story',
  'Replace Aurora direct query in scoring agent score_person tool with FeatureStore online GetRecord',
  'done', 'high', 'p-022',
  ARRAY['sagemaker','scoring-agent','feature-store','python'], 5,
  'https://github.com/orgiq/feature-store/pull/21', 'merged',
  NOW() - INTERVAL '41 days', NOW() - INTERVAL '32 days', NOW() - INTERVAL '32 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-fst-t5', 'p-feature-store', 'wi-fst-s5', 'task',
  'Benchmark scoring agent latency before/after FeatureStore migration: target < 50ms for GetRecord',
  'done', 'high', 'p-022',
  ARRAY['sagemaker','latency','benchmark'],
  NOW() - INTERVAL '39 days', NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-fst-s6', 'p-feature-store', 'wi-fst-f3', 'story',
  'Add local fallback to Aurora if FeatureStore online store returns throttling error',
  'done', 'high', 'p-006',
  ARRAY['sagemaker','feature-store','fallback','reliability'], 3,
  'https://github.com/orgiq/feature-store/pull/24', 'merged',
  NOW() - INTERVAL '35 days', NOW() - INTERVAL '27 days', NOW() - INTERVAL '27 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-fst-t6', 'p-feature-store', 'wi-fst-s6', 'task',
  'Write integration test that injects FeatureStore ThrottlingException and asserts Aurora fallback fires',
  'done', 'medium', 'p-006',
  ARRAY['sagemaker','testing','fallback'],
  NOW() - INTERVAL '33 days', NOW() - INTERVAL '28 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Training dataset generation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-f4', 'p-feature-store', 'wi-fst-e2', 'feature',
  'Generate point-in-time correct training datasets from feature store offline S3 snapshots',
  'in_progress', 'medium', 'p-025',
  ARRAY['sagemaker','feature-store','training','dataset'],
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-fst-s7', 'p-feature-store', 'wi-fst-f4', 'story',
  'Write SageMaker create_dataset job using CreateDatasetDefinition for point-in-time join across feature groups',
  'in_review', 'medium', 'p-025',
  ARRAY['sagemaker','dataset','feature-store','point-in-time'], 8,
  'https://github.com/orgiq/feature-store/pull/29', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-t7', 'p-feature-store', 'wi-fst-s7', 'task',
  'Verify point-in-time join returns features as of label_timestamp not as of query time',
  'in_progress', 'high', 'p-025',
  ARRAY['sagemaker','feature-store','correctness'],
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-fst-s8', 'p-feature-store', 'wi-fst-f4', 'story',
  'Trigger retraining SageMaker Pipeline when dataset drift score exceeds 0.15 on weekly evaluation',
  'open', 'medium', 'p-022',
  ARRAY['sagemaker','mlops','dataset-drift','retraining'], 5,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-fst-t8', 'p-feature-store', 'wi-fst-s8', 'task',
  'Configure SageMaker Model Monitor data capture on scoring endpoint to feed drift evaluator',
  'open', 'medium', 'p-022',
  ARRAY['sagemaker','model-monitor','drift'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-mobile-redesign  (Mobile App Redesign — in_progress)
-- Domain : React Native, iOS, Android
-- Assignees: p-026 Mateo Green, p-027 Sasha Kim, p-029 Ezra Park,
--            p-030 Mia Singh
-- Key    : mob
-- =============================================================================

-- Epic 1: React Native architecture migration
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-e1', 'p-mobile-redesign', NULL, 'epic',
  'Migrate mobile app from Cordova to React Native New Architecture with Fabric renderer',
  'Full rewrite of the OrgIQ mobile app using React Native 0.74 with New Architecture enabled. Target: iOS 16+ and Android 13+. Replace Cordova WebView with native modules.',
  'in_progress', 'high', 'p-029',
  ARRAY['react-native','ios','android','mobile'],
  NULL, NOW() - INTERVAL '80 days', NOW() - INTERVAL '7 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Project scaffold + navigation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-f1', 'p-mobile-redesign', 'wi-mob-e1', 'feature',
  'Set up React Native 0.74 project with Expo Router and TypeScript strict mode',
  'done', 'high', 'p-029',
  ARRAY['react-native','expo','typescript','navigation'],
  NOW() - INTERVAL '78 days', NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-mob-s1', 'p-mobile-redesign', 'wi-mob-f1', 'story',
  'Bootstrap React Native 0.74 monorepo with Turborepo, enable New Architecture in android/gradle.properties and ios/Podfile',
  'done', 'high', 'p-029',
  ARRAY['react-native','new-architecture','turborepo'], 5,
  'https://github.com/orgiq/mobile/pull/1', 'merged',
  NOW() - INTERVAL '76 days', NOW() - INTERVAL '68 days', NOW() - INTERVAL '68 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-mob-t1', 'p-mobile-redesign', 'wi-mob-s1', 'task',
  'Run Metro bundler on both iOS Simulator and Android Emulator and confirm New Architecture bridge logs appear',
  'done', 'high', 'p-029',
  ARRAY['react-native','new-architecture','testing'],
  NOW() - INTERVAL '74 days', NOW() - INTERVAL '69 days', NOW() - INTERVAL '69 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-mob-s2', 'p-mobile-redesign', 'wi-mob-f1', 'story',
  'Configure Expo Router v3 with tab + stack navigator layout matching Figma app structure',
  'done', 'high', 'p-027',
  ARRAY['expo','navigation','react-native'], 3,
  'https://github.com/orgiq/mobile/pull/5', 'merged',
  NOW() - INTERVAL '70 days', NOW() - INTERVAL '62 days', NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-mob-t2', 'p-mobile-redesign', 'wi-mob-s2', 'task',
  'Deep-link test: verify orgiq://search/person/{id} routes correctly to PersonDetail screen on iOS and Android',
  'done', 'medium', 'p-027',
  ARRAY['react-native','deep-linking','navigation'],
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '63 days', NOW() - INTERVAL '63 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Native modules + biometrics
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-f2', 'p-mobile-redesign', 'wi-mob-e1', 'feature',
  'Implement biometric authentication native module using Face ID / Fingerprint via Turbo Modules',
  'in_progress', 'high', 'p-026',
  ARRAY['react-native','biometrics','ios','android','turbo-modules'],
  NOW() - INTERVAL '45 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-mob-s3', 'p-mobile-redesign', 'wi-mob-f2', 'story',
  'Write Swift Turbo Module for Face ID LocalAuthentication with LAContext and fallback to PIN',
  'done', 'high', 'p-026',
  ARRAY['react-native','ios','biometrics','swift'], 8,
  'https://github.com/orgiq/mobile/pull/14', 'merged',
  NOW() - INTERVAL '42 days', NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-mob-t3', 'p-mobile-redesign', 'wi-mob-s3', 'task',
  'Handle LAError.userFallback and LAError.biometryLockout cases and map to JS-side error codes',
  'done', 'high', 'p-026',
  ARRAY['ios','biometrics','error-handling'],
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '34 days', NOW() - INTERVAL '34 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-mob-s4', 'p-mobile-redesign', 'wi-mob-f2', 'story',
  'Write Android Kotlin Turbo Module for BiometricPrompt with BIOMETRIC_STRONG class authenticator',
  'in_progress', 'high', 'p-026',
  ARRAY['react-native','android','biometrics','kotlin'], 8,
  'https://github.com/orgiq/mobile/pull/19', 'open',
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-t4', 'p-mobile-redesign', 'wi-mob-s4', 'task',
  'Test BiometricPrompt on Android 13 Pixel and Samsung One UI 6 — verify BIOMETRIC_ERROR_HW_UNAVAILABLE fallback',
  'in_progress', 'high', 'p-026',
  ARRAY['android','biometrics','testing'],
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: UX redesign screens
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-e2', 'p-mobile-redesign', NULL, 'epic',
  'Implement redesigned search and person-profile screens from Figma v3 designs',
  'Build OrgSearch, PersonDetail, and ProjectDetail screens. Apply new design token system. Target WCAG AA accessibility on both platforms.',
  'in_progress', 'high', 'p-030',
  ARRAY['react-native','ux','figma','accessibility'],
  NULL, NOW() - INTERVAL '55 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Search screen
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-f3', 'p-mobile-redesign', 'wi-mob-e2', 'feature',
  'Build OrgSearch screen with semantic search input and animated result list',
  'done', 'high', 'p-027',
  ARRAY['react-native','search','animation','ux'],
  NOW() - INTERVAL '53 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-mob-s5', 'p-mobile-redesign', 'wi-mob-f3', 'story',
  'Implement debounced search input that calls /api/search via React Query with 300ms delay',
  'done', 'high', 'p-027',
  ARRAY['react-native','react-query','search'], 3,
  'https://github.com/orgiq/mobile/pull/23', 'merged',
  NOW() - INTERVAL '51 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-mob-t5', 'p-mobile-redesign', 'wi-mob-s5', 'task',
  'Add VoiceOver/TalkBack accessibilityLabel to search result items — verify screen reader announces name + department',
  'done', 'medium', 'p-027',
  ARRAY['accessibility','ios','android','react-native'],
  NOW() - INTERVAL '49 days', NOW() - INTERVAL '44 days', NOW() - INTERVAL '44 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-mob-s6', 'p-mobile-redesign', 'wi-mob-f3', 'story',
  'Animate search result list entrance using React Native Reanimated layout transitions',
  'done', 'medium', 'p-026',
  ARRAY['react-native','animation','reanimated'], 3,
  'https://github.com/orgiq/mobile/pull/27', 'merged',
  NOW() - INTERVAL '45 days', NOW() - INTERVAL '37 days', NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-mob-t6', 'p-mobile-redesign', 'wi-mob-s6', 'task',
  'Reduce JS→UI thread frame drops to 0 on search list scroll: profile with Flashlight and Perfetto',
  'done', 'medium', 'p-026',
  ARRAY['react-native','performance','reanimated'],
  NOW() - INTERVAL '43 days', NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): PersonDetail screen
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-f4', 'p-mobile-redesign', 'wi-mob-e2', 'feature',
  'Build PersonDetail screen with expertise radar chart and recent project timeline',
  'in_progress', 'high', 'p-030',
  ARRAY['react-native','ux','chart','figma'],
  NOW() - INTERVAL '28 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-mob-s7', 'p-mobile-redesign', 'wi-mob-f4', 'story',
  'Render expertise radar chart on PersonDetail using Victory Native XL with animated enter transition',
  'in_review', 'high', 'p-030',
  ARRAY['react-native','chart','victory-native','animation'], 5,
  'https://github.com/orgiq/mobile/pull/34', 'open',
  NOW() - INTERVAL '20 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-t7', 'p-mobile-redesign', 'wi-mob-s7', 'task',
  'Confirm radar chart renders correctly in dark mode on iOS 17 and Android 14 dynamic color theming',
  'in_progress', 'medium', 'p-030',
  ARRAY['react-native','dark-mode','ios','android'],
  NOW() - INTERVAL '16 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-mob-s8', 'p-mobile-redesign', 'wi-mob-f4', 'story',
  'Add project timeline scroll view on PersonDetail with pull-to-refresh and optimistic cache update',
  'open', 'medium', 'p-027',
  ARRAY['react-native','timeline','react-query'], 3,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-mob-t8', 'p-mobile-redesign', 'wi-mob-s8', 'task',
  'Write Detox E2E test: navigate to PersonDetail, pull-to-refresh, verify updated project count renders',
  'open', 'medium', 'p-027',
  ARRAY['react-native','detox','e2e','testing'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-design-v3  (Design System v3 — in_progress)
-- Domain : Figma, design tokens, Storybook
-- Assignees: p-026 Mateo Green, p-027 Sasha Kim, p-028 Theo Rivera,
--            p-029 Ezra Park, p-030 Mia Singh
-- Key    : dsv
-- =============================================================================

-- Epic 1: Design token pipeline
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-e1', 'p-design-v3', NULL, 'epic',
  'Build automated design token pipeline from Figma Variables to CSS/JS/Swift/Kotlin output',
  'Export Figma Variables (color, spacing, typography, radius) via Style Dictionary to platform-specific token files consumed by portal (CSS vars), mobile (Kotlin/Swift), and Storybook.',
  'in_progress', 'high', 'p-028',
  ARRAY['design-tokens','figma','style-dictionary','storybook'],
  NULL, NOW() - INTERVAL '70 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Figma Variables export
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-f1', 'p-design-v3', 'wi-dsv-e1', 'feature',
  'Configure Figma Variables export plugin and Style Dictionary transform pipeline',
  'done', 'high', 'p-028',
  ARRAY['figma','style-dictionary','design-tokens'],
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '48 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-dsv-s1', 'p-design-v3', 'wi-dsv-f1', 'story',
  'Write Style Dictionary config that transforms Figma color tokens to CSS custom properties and Tailwind palette',
  'done', 'high', 'p-028',
  ARRAY['style-dictionary','css','tailwind','design-tokens'], 5,
  'https://github.com/orgiq/design-system/pull/8', 'merged',
  NOW() - INTERVAL '66 days', NOW() - INTERVAL '57 days', NOW() - INTERVAL '57 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-dsv-t1', 'p-design-v3', 'wi-dsv-s1', 'task',
  'Add semantic color token aliases (color.bg.surface, color.text.muted) referencing base scale tokens',
  'done', 'medium', 'p-028',
  ARRAY['design-tokens','css','semantic-tokens'],
  NOW() - INTERVAL '64 days', NOW() - INTERVAL '58 days', NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-dsv-s2', 'p-design-v3', 'wi-dsv-f1', 'story',
  'Add Swift and Kotlin token output formats to Style Dictionary for mobile token consumption',
  'done', 'high', 'p-026',
  ARRAY['style-dictionary','swift','kotlin','mobile','design-tokens'], 5,
  'https://github.com/orgiq/design-system/pull/12', 'merged',
  NOW() - INTERVAL '58 days', NOW() - INTERVAL '49 days', NOW() - INTERVAL '49 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-dsv-t2', 'p-design-v3', 'wi-dsv-s2', 'task',
  'Validate Swift token output compiles without warnings in Xcode 15 against iOS 16 deployment target',
  'done', 'medium', 'p-026',
  ARRAY['swift','ios','design-tokens'],
  NOW() - INTERVAL '56 days', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): CI token sync automation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-f2', 'p-design-v3', 'wi-dsv-e1', 'feature',
  'Automate token regeneration in CI when Figma Variables change using GitHub Actions',
  'in_progress', 'medium', 'p-027',
  ARRAY['github-actions','figma','design-tokens','ci-cd'],
  NOW() - INTERVAL '35 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-dsv-s3', 'p-design-v3', 'wi-dsv-f2', 'story',
  'Create GitHub Action workflow that exports Figma tokens via REST API and opens PR with diff on change',
  'done', 'medium', 'p-027',
  ARRAY['github-actions','figma','design-tokens'], 5,
  'https://github.com/orgiq/design-system/pull/19', 'merged',
  NOW() - INTERVAL '33 days', NOW() - INTERVAL '25 days', NOW() - INTERVAL '25 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-dsv-t3', 'p-design-v3', 'wi-dsv-s3', 'task',
  'Store Figma API token as GitHub Actions secret and rotate quarterly via documented runbook',
  'done', 'medium', 'p-027',
  ARRAY['figma','secrets','security'],
  NOW() - INTERVAL '31 days', NOW() - INTERVAL '26 days', NOW() - INTERVAL '26 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-dsv-s4', 'p-design-v3', 'wi-dsv-f2', 'story',
  'Add visual regression check to token PR: render Storybook components before/after and diff screenshots',
  'in_progress', 'medium', 'p-028',
  ARRAY['storybook','visual-regression','chromatic','design-tokens'], 5,
  'https://github.com/orgiq/design-system/pull/24', 'open',
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-t4', 'p-design-v3', 'wi-dsv-s4', 'task',
  'Configure Chromatic project and add CHROMATIC_PROJECT_TOKEN to GitHub Actions environment secrets',
  'in_progress', 'medium', 'p-028',
  ARRAY['chromatic','storybook','ci-cd'],
  NOW() - INTERVAL '12 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Component library Storybook v8 + accessibility
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-e2', 'p-design-v3', NULL, 'epic',
  'Upgrade component library to Storybook 8 and enforce WCAG AA accessibility in all stories',
  'Migrate all 40+ component stories to Storybook 8 with new @storybook/test runner, add a11y addon, and integrate axe-core assertions. Publish updated Storybook to GitHub Pages.',
  'in_progress', 'high', 'p-027',
  ARRAY['storybook','accessibility','wcag','react'],
  NULL, NOW() - INTERVAL '50 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Storybook 8 migration
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-f3', 'p-design-v3', 'wi-dsv-e2', 'feature',
  'Migrate all component stories from Storybook 7 CSF2 format to Storybook 8 CSF3',
  'done', 'high', 'p-027',
  ARRAY['storybook','csf','migration'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '28 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-dsv-s5', 'p-design-v3', 'wi-dsv-f3', 'story',
  'Run Storybook 8 codemod on all story files and fix 14 remaining CSF3 type errors',
  'done', 'high', 'p-027',
  ARRAY['storybook','typescript','migration'], 3,
  'https://github.com/orgiq/design-system/pull/28', 'merged',
  NOW() - INTERVAL '46 days', NOW() - INTERVAL '38 days', NOW() - INTERVAL '38 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-dsv-t5', 'p-design-v3', 'wi-dsv-s5', 'task',
  'Fix StoryObj generic type inference for compound components that use render props pattern',
  'done', 'medium', 'p-027',
  ARRAY['storybook','typescript'],
  NOW() - INTERVAL '44 days', NOW() - INTERVAL '39 days', NOW() - INTERVAL '39 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-dsv-s6', 'p-design-v3', 'wi-dsv-f3', 'story',
  'Integrate @storybook/addon-a11y and set axe-core rules to enforce WCAG 2.1 AA as story-level check',
  'done', 'high', 'p-026',
  ARRAY['storybook','accessibility','axe','wcag'], 3,
  'https://github.com/orgiq/design-system/pull/32', 'merged',
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '32 days', NOW() - INTERVAL '32 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-dsv-t6', 'p-design-v3', 'wi-dsv-s6', 'task',
  'Fix 8 color-contrast axe violations in Button and Badge components using updated token values',
  'done', 'high', 'p-026',
  ARRAY['accessibility','css','design-tokens'],
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '33 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Storybook publish + docs
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-f4', 'p-design-v3', 'wi-dsv-e2', 'feature',
  'Publish Storybook to GitHub Pages with per-PR preview deployments',
  'in_progress', 'medium', 'p-028',
  ARRAY['storybook','github-pages','ci-cd'],
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-dsv-s7', 'p-design-v3', 'wi-dsv-f4', 'story',
  'Add GitHub Actions workflow to build and deploy Storybook to gh-pages branch on main push',
  'in_review', 'medium', 'p-028',
  ARRAY['storybook','github-pages','github-actions'], 3,
  'https://github.com/orgiq/design-system/pull/38', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-t7', 'p-design-v3', 'wi-dsv-s7', 'task',
  'Configure GitHub Pages custom domain design.orgiq.internal and add CNAME file to Storybook static output',
  'in_progress', 'medium', 'p-028',
  ARRAY['github-pages','dns'],
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-dsv-s8', 'p-design-v3', 'wi-dsv-f4', 'story',
  'Write MDX documentation pages for design principles, token usage, and component composition patterns',
  'open', 'low', 'p-030',
  ARRAY['storybook','documentation','mdx'], 5,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-dsv-t8', 'p-design-v3', 'wi-dsv-s8', 'task',
  'Add do/don''t example pairs to Button, Input, and Modal component documentation pages',
  'open', 'low', 'p-030',
  ARRAY['storybook','documentation'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- PROJECT: p-llm-platform  (LLM Application Platform — in_progress)
-- Domain : Bedrock, RAG, agents, Nova
-- Assignees: p-006 Maria Johnson, p-013 Caleb Turner, p-022 Sarah Thompson,
--            p-025 Aisha Mehta
-- Key    : llm
-- =============================================================================

-- Epic 1: Bedrock model gateway + prompt management
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-e1', 'p-llm-platform', NULL, 'epic',
  'Build centralized Bedrock model gateway with prompt versioning and usage tracking',
  'Create an internal LLM gateway service that routes Bedrock InvokeModel calls, enforces guardrails, logs token usage to Aurora, and supports A/B prompt experiments via canary library.',
  'in_progress', 'high', 'p-006',
  ARRAY['bedrock','llm','gateway','prompt-management'],
  NULL, NOW() - INTERVAL '72 days', NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Gateway service
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-f1', 'p-llm-platform', 'wi-llm-e1', 'feature',
  'Build Express-based LLM gateway with Bedrock ConverseStream API and Cedar auth guard',
  'done', 'high', 'p-006',
  ARRAY['bedrock','nodejs','typescript','cedar'],
  NOW() - INTERVAL '70 days', NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-llm-s1', 'p-llm-platform', 'wi-llm-f1', 'story',
  'Implement /v1/converse SSE endpoint wrapping BedrockRuntimeClient ConverseStreamCommand with AG-UI event mapping',
  'done', 'high', 'p-006',
  ARRAY['bedrock','ag-ui','sse','typescript'], 8,
  'https://github.com/orgiq/llm-platform/pull/5', 'merged',
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '58 days', NOW() - INTERVAL '58 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-llm-t1', 'p-llm-platform', 'wi-llm-s1', 'task',
  'Handle Bedrock throttling (ThrottlingException) with jittered exponential backoff and surface 429 to caller',
  'done', 'high', 'p-006',
  ARRAY['bedrock','retry','reliability'],
  NOW() - INTERVAL '66 days', NOW() - INTERVAL '59 days', NOW() - INTERVAL '59 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-llm-s2', 'p-llm-platform', 'wi-llm-f1', 'story',
  'Log every Bedrock request (model, input/output tokens, latency, guardrail outcome) to Aurora llm_usage table',
  'done', 'high', 'p-013',
  ARRAY['bedrock','aurora','observability','token-usage'], 5,
  'https://github.com/orgiq/llm-platform/pull/9', 'merged',
  NOW() - INTERVAL '62 days', NOW() - INTERVAL '53 days', NOW() - INTERVAL '53 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-llm-t2', 'p-llm-platform', 'wi-llm-s2', 'task',
  'Add composite index on llm_usage (model_id, requested_at) for time-range cost queries',
  'done', 'medium', 'p-013',
  ARRAY['aurora','indexing','performance'],
  NOW() - INTERVAL '60 days', NOW() - INTERVAL '54 days', NOW() - INTERVAL '54 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Prompt library + canary
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-f2', 'p-llm-platform', 'wi-llm-e1', 'feature',
  'Build prompt library with version control and canary A/B routing for production prompt experiments',
  'in_progress', 'high', 'p-022',
  ARRAY['prompt-management','canary','bedrock','llm'],
  NOW() - INTERVAL '40 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-llm-s3', 'p-llm-platform', 'wi-llm-f2', 'story',
  'Create prompt_versions Aurora table and REST API for CRUD operations on prompt templates',
  'done', 'high', 'p-022',
  ARRAY['aurora','rest-api','prompt-management'], 5,
  'https://github.com/orgiq/llm-platform/pull/16', 'merged',
  NOW() - INTERVAL '38 days', NOW() - INTERVAL '29 days', NOW() - INTERVAL '29 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-llm-t3', 'p-llm-platform', 'wi-llm-s3', 'task',
  'Add optimistic locking (version column) to prompt_versions so concurrent edits return 409 not silent overwrite',
  'done', 'medium', 'p-022',
  ARRAY['aurora','concurrency','api'],
  NOW() - INTERVAL '36 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-llm-s4', 'p-llm-platform', 'wi-llm-f2', 'story',
  'Implement canary router that splits traffic between prompt versions by percentage using sticky session hash',
  'in_progress', 'high', 'p-025',
  ARRAY['canary','prompt-management','bedrock'], 5,
  'https://github.com/orgiq/llm-platform/pull/22', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-t4', 'p-llm-platform', 'wi-llm-s4', 'task',
  'Validate canary router assigns same prompt version to same user across requests using session hash',
  'in_progress', 'medium', 'p-025',
  ARRAY['canary','testing','session'],
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: RAG pipeline + knowledge base
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-e2', 'p-llm-platform', NULL, 'epic',
  'Build production RAG pipeline using Bedrock Knowledge Bases with Aurora pgvector fallback',
  'Ingest org documents into Bedrock KB (OpenSearch Serverless backend) and Aurora pgvector. Build retrieval pipeline with query decomposition, cross-encoder reranking, and citation attribution.',
  'in_progress', 'high', 'p-025',
  ARRAY['rag','bedrock','knowledge-base','pgvector','opentelemetry'],
  NULL, NOW() - INTERVAL '55 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Knowledge base ingestion
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-f3', 'p-llm-platform', 'wi-llm-e2', 'feature',
  'Configure Bedrock Knowledge Base with S3 data source and Titan V2 embeddings at 1024 dimensions',
  'done', 'high', 'p-013',
  ARRAY['bedrock','knowledge-base','s3','embeddings','titan'],
  NOW() - INTERVAL '53 days', NOW() - INTERVAL '33 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-llm-s5', 'p-llm-platform', 'wi-llm-f3', 'story',
  'Configure Bedrock KB with S3 orgiq-documents bucket, Titan V2 1024-dim, and hierarchical chunking strategy',
  'done', 'high', 'p-013',
  ARRAY['bedrock','knowledge-base','chunking','embeddings'], 5,
  'https://github.com/orgiq/llm-platform/pull/29', 'merged',
  NOW() - INTERVAL '51 days', NOW() - INTERVAL '42 days', NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-llm-t5', 'p-llm-platform', 'wi-llm-s5', 'task',
  'Trigger KB sync job and verify ingestion completes for 500-doc corpus in under 10 minutes',
  'done', 'medium', 'p-013',
  ARRAY['bedrock','knowledge-base','ingestion'],
  NOW() - INTERVAL '49 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-llm-s6', 'p-llm-platform', 'wi-llm-f3', 'story',
  'Mirror Bedrock KB embeddings into Aurora pgvector node_embeddings table for offline analytics queries',
  'done', 'medium', 'p-006',
  ARRAY['aurora','pgvector','embeddings','rag'], 5,
  'https://github.com/orgiq/llm-platform/pull/33', 'merged',
  NOW() - INTERVAL '45 days', NOW() - INTERVAL '36 days', NOW() - INTERVAL '36 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-llm-t6', 'p-llm-platform', 'wi-llm-s6', 'task',
  'Add HNSW index on node_embeddings vector column and benchmark ANN query at 10k vectors',
  'done', 'medium', 'p-006',
  ARRAY['pgvector','aurora','indexing','performance'],
  NOW() - INTERVAL '43 days', NOW() - INTERVAL '37 days', NOW() - INTERVAL '37 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Retrieval + reranking
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-f4', 'p-llm-platform', 'wi-llm-e2', 'feature',
  'Add query decomposition and cross-encoder reranking to RAG retrieval pipeline',
  'in_progress', 'high', 'p-022',
  ARRAY['rag','reranking','bedrock','llm'],
  NOW() - INTERVAL '25 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-llm-s7', 'p-llm-platform', 'wi-llm-f4', 'story',
  'Implement RetrieveAndGenerate query decomposition: break multi-part questions into sub-queries before KB retrieval',
  'in_review', 'high', 'p-022',
  ARRAY['rag','bedrock','query-decomposition'], 8,
  'https://github.com/orgiq/llm-platform/pull/41', 'open',
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-t7', 'p-llm-platform', 'wi-llm-s7', 'task',
  'Evaluate decomposition quality on 50-query golden set: track MRR and NDCG@5 vs baseline single-query retrieval',
  'in_progress', 'high', 'p-022',
  ARRAY['rag','evaluation','metrics'],
  NOW() - INTERVAL '15 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-llm-s8', 'p-llm-platform', 'wi-llm-f4', 'story',
  'Integrate Bedrock Rerank API (cross-encoder) as post-retrieval step and measure NDCG@5 improvement',
  'open', 'high', 'p-025',
  ARRAY['rag','reranking','bedrock'], 5,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-llm-t8', 'p-llm-platform', 'wi-llm-s8', 'task',
  'Add RETRIEVER span with retrieved chunk IDs to OTel trace so Grafana can visualize RAG hit rate',
  'open', 'medium', 'p-025',
  ARRAY['opentelemetry','rag','observability'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-rag-search  (RAG Knowledge Search — completed)
-- All items: status='done', pr_status='merged' where applicable
-- Assignees: p-017 Daniel Chang, p-018 Sarah Ahmed, p-020 Henry Hassan,
--            p-022 Sarah Thompson
-- Key    : rag
-- =============================================================================

-- Epic 1: Bedrock KB + pgvector search backend
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-e1', 'p-rag-search', NULL, 'epic',
  'Build dual-backend search using Bedrock Knowledge Base and Aurora pgvector',
  'Implemented hybrid semantic search: Bedrock KB for high-quality passage retrieval + pgvector cosine similarity for graph-adjacent people and skill lookups. Merged results with reciprocal rank fusion.',
  'done', 'high', 'p-020',
  ARRAY['rag','bedrock','pgvector','search'],
  NULL, NOW() - INTERVAL '120 days', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Bedrock KB search integration
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-f1', 'p-rag-search', 'wi-rag-e1', 'feature',
  'Integrate Bedrock RetrieveAndGenerate API into orgiq-search agent retrieve_documents tool',
  'done', 'high', 'p-020',
  ARRAY['bedrock','rag','search'],
  NOW() - INTERVAL '118 days', NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s1', 'p-rag-search', 'wi-rag-f1', 'story',
  'Write retrieve_documents Strands tool that calls Bedrock KB RetrieveAndGenerate with session-scoped memory',
  'done', 'high', 'p-020',
  ARRAY['bedrock','strands-agents','rag'], 8,
  'https://github.com/orgiq/rag-search/pull/3', 'merged',
  NOW() - INTERVAL '116 days', NOW() - INTERVAL '105 days', NOW() - INTERVAL '105 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t1', 'p-rag-search', 'wi-rag-s1', 'task',
  'Write eval harness: run 100-query golden set against retrieve_documents and assert MRR > 0.65',
  'done', 'high', 'p-020',
  ARRAY['rag','evaluation','testing'],
  NOW() - INTERVAL '114 days', NOW() - INTERVAL '106 days', NOW() - INTERVAL '106 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s2', 'p-rag-search', 'wi-rag-f1', 'story',
  'Add citation attribution: extract sourceUris from KB response and append to AG-UI RUN_RESULT event',
  'done', 'medium', 'p-022',
  ARRAY['bedrock','rag','citations','ag-ui'], 3,
  'https://github.com/orgiq/rag-search/pull/7', 'merged',
  NOW() - INTERVAL '108 days', NOW() - INTERVAL '99 days', NOW() - INTERVAL '99 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t2', 'p-rag-search', 'wi-rag-s2', 'task',
  'Render citation chips in portal search results with doc title, page number, and S3 presigned URL',
  'done', 'medium', 'p-022',
  ARRAY['react','ux','citations'],
  NOW() - INTERVAL '106 days', NOW() - INTERVAL '100 days', NOW() - INTERVAL '100 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): pgvector people/skill search
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-f2', 'p-rag-search', 'wi-rag-e1', 'feature',
  'Implement pgvector cosine-similarity search over people and skill node_embeddings in Aurora',
  'done', 'high', 'p-017',
  ARRAY['pgvector','aurora','embeddings','search'],
  NOW() - INTERVAL '105 days', NOW() - INTERVAL '80 days', NOW() - INTERVAL '80 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s3', 'p-rag-search', 'wi-rag-f2', 'story',
  'Write find_similar_people SQL using pgvector <=> operator with HNSW index on node_embeddings.embedding',
  'done', 'high', 'p-017',
  ARRAY['pgvector','aurora','sql'], 5,
  'https://github.com/orgiq/rag-search/pull/11', 'merged',
  NOW() - INTERVAL '103 days', NOW() - INTERVAL '93 days', NOW() - INTERVAL '93 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t3', 'p-rag-search', 'wi-rag-s3', 'task',
  'Benchmark pgvector HNSW ef_search=64 ANN recall vs exact scan on 50k embedding corpus',
  'done', 'medium', 'p-017',
  ARRAY['pgvector','performance','benchmark'],
  NOW() - INTERVAL '101 days', NOW() - INTERVAL '94 days', NOW() - INTERVAL '94 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s4', 'p-rag-search', 'wi-rag-f2', 'story',
  'Implement reciprocal rank fusion to merge Bedrock KB results with pgvector results into unified ranked list',
  'done', 'high', 'p-018',
  ARRAY['rag','search','ranking','pgvector'], 5,
  'https://github.com/orgiq/rag-search/pull/15', 'merged',
  NOW() - INTERVAL '95 days', NOW() - INTERVAL '85 days', NOW() - INTERVAL '85 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t4', 'p-rag-search', 'wi-rag-s4', 'task',
  'Tune RRF k constant to 60 and evaluate NDCG@10 improvement over single-source baseline',
  'done', 'medium', 'p-018',
  ARRAY['rag','ranking','evaluation'],
  NOW() - INTERVAL '93 days', NOW() - INTERVAL '86 days', NOW() - INTERVAL '86 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Search UI + agent streaming
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-e2', 'p-rag-search', NULL, 'epic',
  'Build streaming search UI with AG-UI SSE event rendering and progressive result display',
  'Portal SearchPage subscribes to AG-UI SSE stream from orgiq-search agent. Results stream in progressively. Person cards, document citations, and skill tags render as events arrive.',
  'done', 'high', 'p-022',
  ARRAY['ag-ui','sse','react','search','streaming'],
  NULL, NOW() - INTERVAL '100 days', NOW() - INTERVAL '46 days', NOW() - INTERVAL '46 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): SSE stream rendering
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-f3', 'p-rag-search', 'wi-rag-e2', 'feature',
  'Implement AG-UI SSE event consumer in SearchPage with progressive token and result rendering',
  'done', 'high', 'p-022',
  ARRAY['ag-ui','sse','react','streaming'],
  NOW() - INTERVAL '98 days', NOW() - INTERVAL '70 days', NOW() - INTERVAL '70 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s5', 'p-rag-search', 'wi-rag-f3', 'story',
  'Write useAgStream React hook that parses AG-UI SSE events and accumulates RUN_STEP_DELTA tokens',
  'done', 'high', 'p-022',
  ARRAY['ag-ui','react','hooks','sse'], 5,
  'https://github.com/orgiq/rag-search/pull/21', 'merged',
  NOW() - INTERVAL '96 days', NOW() - INTERVAL '86 days', NOW() - INTERVAL '86 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t5', 'p-rag-search', 'wi-rag-s5', 'task',
  'Handle RUN_ERROR AG-UI event: show user-facing error toast and preserve partial results in UI',
  'done', 'medium', 'p-022',
  ARRAY['ag-ui','error-handling','ux'],
  NOW() - INTERVAL '94 days', NOW() - INTERVAL '87 days', NOW() - INTERVAL '87 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s6', 'p-rag-search', 'wi-rag-f3', 'story',
  'Render PersonCard components progressively as TOOL_CALL_RESULT events arrive during stream',
  'done', 'high', 'p-020',
  ARRAY['react','ag-ui','ux','streaming'], 5,
  'https://github.com/orgiq/rag-search/pull/25', 'merged',
  NOW() - INTERVAL '88 days', NOW() - INTERVAL '78 days', NOW() - INTERVAL '78 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t6', 'p-rag-search', 'wi-rag-s6', 'task',
  'Add skeleton loading state to PersonCard while first stream chunk is in flight',
  'done', 'low', 'p-020',
  ARRAY['react','ux','loading-state'],
  NOW() - INTERVAL '86 days', NOW() - INTERVAL '79 days', NOW() - INTERVAL '79 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Search analytics
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-f4', 'p-rag-search', 'wi-rag-e2', 'feature',
  'Track search query analytics to Aurora: query text, result count, click-through, and latency',
  'done', 'medium', 'p-018',
  ARRAY['analytics','aurora','search','clickthrough'],
  NOW() - INTERVAL '80 days', NOW() - INTERVAL '55 days', NOW() - INTERVAL '55 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s7', 'p-rag-search', 'wi-rag-f4', 'story',
  'Emit search_events rows to Aurora on each query with embedding model latency and KB latency split',
  'done', 'medium', 'p-018',
  ARRAY['aurora','analytics','search'], 3,
  'https://github.com/orgiq/rag-search/pull/31', 'merged',
  NOW() - INTERVAL '78 days', NOW() - INTERVAL '68 days', NOW() - INTERVAL '68 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t7', 'p-rag-search', 'wi-rag-s7', 'task',
  'Build Grafana panel showing P50/P95/P99 search latency from search_events over trailing 7 days',
  'done', 'low', 'p-018',
  ARRAY['grafana','analytics','search'],
  NOW() - INTERVAL '76 days', NOW() - INTERVAL '69 days', NOW() - INTERVAL '69 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-rag-s8', 'p-rag-search', 'wi-rag-f4', 'story',
  'Add click-through tracking: log result_rank and result_id when user clicks a PersonCard from search results',
  'done', 'medium', 'p-017',
  ARRAY['analytics','search','clickthrough'], 2,
  'https://github.com/orgiq/rag-search/pull/35', 'merged',
  NOW() - INTERVAL '70 days', NOW() - INTERVAL '62 days', NOW() - INTERVAL '62 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-rag-t8', 'p-rag-search', 'wi-rag-s8', 'task',
  'Compute mean reciprocal rank from click-through data weekly and add to search quality Grafana dashboard',
  'done', 'low', 'p-017',
  ARRAY['analytics','search','mrr','grafana'],
  NOW() - INTERVAL '68 days', NOW() - INTERVAL '63 days', NOW() - INTERVAL '63 days')
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- PROJECT: p-soc2  (SOC2 Compliance — in_progress)
-- Domain : security controls, audits, policies
-- Assignees: p-004 Nora DaSilva, p-010 Tara Chen, p-012 Rachel Kowalski,
--            p-008 Layla Hassan
-- Key    : soc
-- =============================================================================

-- Epic 1: Security controls implementation
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-e1', 'p-soc2', NULL, 'epic',
  'Implement SOC2 Type II security controls: encryption, access control, audit logging',
  'Satisfy CC6 (logical access), CC7 (system operations), and CC9 (risk mitigation) criteria for SOC2 Type II audit covering the OrgIQ platform. Audit window: 2026-Q3.',
  'in_progress', 'critical', 'p-012',
  ARRAY['soc2','security','compliance','audit'],
  NULL, NOW() - INTERVAL '85 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 1 (under e1): Encryption at rest + in transit
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-f1', 'p-soc2', 'wi-soc-e1', 'feature',
  'Enforce encryption at rest with KMS CMK and TLS 1.2+ in transit for all data stores',
  'done', 'critical', 'p-012',
  ARRAY['kms','encryption','tls','soc2'],
  NOW() - INTERVAL '83 days', NOW() - INTERVAL '60 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s1', 'p-soc2', 'wi-soc-f1', 'story',
  'Rotate Aurora cluster encryption key to KMS CMK orgiq-aurora-key and verify key policy allows RDS service',
  'done', 'critical', 'p-012',
  ARRAY['kms','aurora','encryption'], 3,
  'https://github.com/orgiq/soc2/pull/4', 'merged',
  NOW() - INTERVAL '81 days', NOW() - INTERVAL '72 days', NOW() - INTERVAL '72 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t1', 'p-soc2', 'wi-soc-s1', 'task',
  'Enable CloudTrail event for kms:Decrypt calls and confirm Aurora decrypt events appear in trail',
  'done', 'high', 'p-012',
  ARRAY['kms','cloudtrail','audit'],
  NOW() - INTERVAL '79 days', NOW() - INTERVAL '73 days', NOW() - INTERVAL '73 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s2', 'p-soc2', 'wi-soc-f1', 'story',
  'Configure S3 bucket policies to enforce TLS-only access and enable SSE-KMS on all orgiq-* buckets',
  'done', 'critical', 'p-004',
  ARRAY['s3','tls','kms','soc2'], 3,
  'https://github.com/orgiq/soc2/pull/8', 'merged',
  NOW() - INTERVAL '75 days', NOW() - INTERVAL '66 days', NOW() - INTERVAL '66 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t2', 'p-soc2', 'wi-soc-s2', 'task',
  'Run AWS Config conformance pack on S3 encryption rules and remediate 3 remaining non-compliant buckets',
  'done', 'high', 'p-004',
  ARRAY['aws-config','s3','compliance'],
  NOW() - INTERVAL '73 days', NOW() - INTERVAL '67 days', NOW() - INTERVAL '67 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 2 (under e1): Audit logging + SIEM
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-f2', 'p-soc2', 'wi-soc-e1', 'feature',
  'Centralize audit logs from CloudTrail, VPC Flow Logs, and application events into OpenSearch SIEM',
  'in_progress', 'high', 'p-010',
  ARRAY['cloudtrail','siem','opensearch','soc2','audit'],
  NOW() - INTERVAL '55 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s3', 'p-soc2', 'wi-soc-f2', 'story',
  'Configure CloudTrail org-wide trail shipping to S3 and Kinesis Firehose → OpenSearch for SIEM indexing',
  'done', 'high', 'p-010',
  ARRAY['cloudtrail','kinesis','opensearch','siem'], 5,
  'https://github.com/orgiq/soc2/pull/14', 'merged',
  NOW() - INTERVAL '53 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t3', 'p-soc2', 'wi-soc-s3', 'task',
  'Validate CloudTrail digest files using SHA-256 and confirm log file integrity is enabled on trail',
  'done', 'medium', 'p-010',
  ARRAY['cloudtrail','integrity','soc2'],
  NOW() - INTERVAL '51 days', NOW() - INTERVAL '44 days', NOW() - INTERVAL '44 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at)
VALUES ('wi-soc-s4', 'p-soc2', 'wi-soc-f2', 'story',
  'Build OpenSearch SIEM detection rules for privilege escalation, impossible travel, and failed MFA events',
  'in_progress', 'high', 'p-008',
  ARRAY['siem','opensearch','detection','security'], 8,
  'https://github.com/orgiq/soc2/pull/20', 'open',
  NOW() - INTERVAL '22 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-t4', 'p-soc2', 'wi-soc-s4', 'task',
  'Tune impossible-travel detection: use Haversine distance with 900km/h max speed threshold',
  'in_progress', 'medium', 'p-008',
  ARRAY['siem','detection','security'],
  NOW() - INTERVAL '18 days', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Epic 2: Vendor assessment + audit preparation
INSERT INTO work_items (id, project_id, parent_id, type, title, description, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-e2', 'p-soc2', NULL, 'epic',
  'Complete vendor risk assessments and prepare audit evidence packages for SOC2 auditor',
  'Conduct risk assessments for all Tier-1 vendors (AWS, Okta, GitHub). Gather and organize audit evidence: policy docs, configuration screenshots, change tickets, incident reports.',
  'in_progress', 'high', 'p-004',
  ARRAY['soc2','vendor-risk','audit','compliance'],
  NULL, NOW() - INTERVAL '60 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 3 (under e2): Policy documentation
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-f3', 'p-soc2', 'wi-soc-e2', 'feature',
  'Author and get sign-off on all required SOC2 information security policies',
  'done', 'critical', 'p-004',
  ARRAY['soc2','policy','documentation','compliance'],
  NOW() - INTERVAL '58 days', NOW() - INTERVAL '35 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s5', 'p-soc2', 'wi-soc-f3', 'story',
  'Write and publish Access Control Policy, Incident Response Policy, and Change Management Policy',
  'done', 'critical', 'p-004',
  ARRAY['soc2','policy','access-control'], 5,
  'https://github.com/orgiq/soc2/pull/26', 'merged',
  NOW() - INTERVAL '56 days', NOW() - INTERVAL '46 days', NOW() - INTERVAL '46 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t5', 'p-soc2', 'wi-soc-s5', 'task',
  'Obtain VP Engineering signature on all three policies and store signed PDFs in Confluence',
  'done', 'high', 'p-004',
  ARRAY['soc2','policy','approval'],
  NOW() - INTERVAL '54 days', NOW() - INTERVAL '47 days', NOW() - INTERVAL '47 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s6', 'p-soc2', 'wi-soc-f3', 'story',
  'Draft Vulnerability Management Policy with SLA: critical 24h, high 7d, medium 30d patch windows',
  'done', 'high', 'p-012',
  ARRAY['soc2','vulnerability-management','policy'], 3,
  'https://github.com/orgiq/soc2/pull/30', 'merged',
  NOW() - INTERVAL '50 days', NOW() - INTERVAL '42 days', NOW() - INTERVAL '42 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t6', 'p-soc2', 'wi-soc-s6', 'task',
  'Configure AWS Security Hub finding severity → Jira ticket auto-creation for critical and high findings',
  'done', 'high', 'p-012',
  ARRAY['securityhub','jira','automation'],
  NOW() - INTERVAL '48 days', NOW() - INTERVAL '43 days', NOW() - INTERVAL '43 days')
ON CONFLICT (id) DO NOTHING;

-- Feature 4 (under e2): Audit evidence collection
INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-f4', 'p-soc2', 'wi-soc-e2', 'feature',
  'Collect and organize audit evidence packages for each SOC2 control family',
  'in_progress', 'high', 'p-010',
  ARRAY['soc2','audit','evidence','compliance'],
  NOW() - INTERVAL '30 days', NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, pr_url, pr_status, created_at, updated_at, completed_at)
VALUES ('wi-soc-s7', 'p-soc2', 'wi-soc-f4', 'story',
  'Export IAM access review report from AWS IAM Access Analyzer and document quarterly review completion',
  'done', 'high', 'p-010',
  ARRAY['iam','access-analyzer','soc2','audit'], 2,
  'https://github.com/orgiq/soc2/pull/37', 'merged',
  NOW() - INTERVAL '25 days', NOW() - INTERVAL '17 days', NOW() - INTERVAL '17 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at, completed_at)
VALUES ('wi-soc-t7', 'p-soc2', 'wi-soc-s7', 'task',
  'Screenshot IAM Access Analyzer external finding count = 0 and attach to SOC2 evidence folder',
  'done', 'medium', 'p-010',
  ARRAY['iam','soc2','evidence'],
  NOW() - INTERVAL '23 days', NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, story_points, created_at, updated_at)
VALUES ('wi-soc-s8', 'p-soc2', 'wi-soc-f4', 'story',
  'Complete Business Continuity test: simulate Aurora failover and verify RTO < 30 minutes for OrgIQ platform',
  'open', 'high', 'p-008',
  ARRAY['soc2','bcp','aurora','disaster-recovery'], 5,
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_items (id, project_id, parent_id, type, title, status, priority, assignee_id, labels, created_at, updated_at)
VALUES ('wi-soc-t8', 'p-soc2', 'wi-soc-s8', 'task',
  'Document Aurora failover runbook with step-by-step Ops instructions and attach to BCP evidence package',
  'open', 'medium', 'p-008',
  ARRAY['soc2','aurora','runbook','bcp'],
  NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days')
ON CONFLICT (id) DO NOTHING;

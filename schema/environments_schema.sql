-- Environments — where an initiative's code actually runs.
--
-- An initiative (`projects`) has people who own it and repositories that
-- deliver it (`agent_projects`). What was missing is the third thing: the
-- places the delivered code lands. "Who can reach prod for the auth
-- migration" was, until this table, a question nothing here could answer —
-- not because the answer was secret, but because the nouns didn't exist.
--
-- Deliberately a *description*, not a controller. A row records what an
-- environment IS — which account, which region, which cluster, which role a
-- box would assume to reach it — and nothing about how to change it. There is
-- no deploy state, no promotion pipeline, no run history. The repositories
-- linked to these initiatives almost certainly have GitHub Actions doing the
-- deploying; this product's job is to REPORT the latest runs and stop there. A
-- "Deploy" button here would be a second, worse CI system competing with the
-- real one over what actually shipped.
--
-- Nor is this DORA. Nothing counts lead time or change-failure rate. The
-- question is spatial — what exists, and may I reach it — not statistical.
--
-- `cluster_name` is nullable on purpose. The obvious model is one row per EKS
-- cluster, and it is wrong the moment an initiative ships a Lambda, a static
-- site, or a managed database. Environment-ness is not Kubernetes-ness: the
-- account/region/role triple is what every environment has, and the cluster
-- columns are the EKS specialization layered on top. `kind` names the shape so
-- a reader never has to infer it from which columns happen to be null.
--
-- `access_role_arn` is the load-bearing column, and the reason this is more
-- than documentation. It is the IAM role a devbox assumes to reach this
-- environment — what an SME needs when they jump into a cluster to run
-- commands. Storing it does NOT grant it. Cedar decides whether a principal
-- may reach an environment at all (the EnterEnvironment action; see
-- middleware/seeds/roles/orgiq/*.cedar), and IAM then decides what the assumed
-- role can do once inside. Two independent gates, neither sufficient alone.
-- The ARN is a role name, not a credential — nothing secret lives in this
-- table, which is precisely why the read side can be wide.
--
-- `rank` exists because dev→staging→prod is an ordering no alphabetical sort
-- produces and every reader expects. Storing it beats hard-coding a name list
-- in each surface that renders environments, and it survives an org that calls
-- its tiers something else entirely.

CREATE TABLE IF NOT EXISTS environments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The initiative this environment serves. CASCADE because an environment has
  -- no meaning without one — unlike a repository, which can outlive the
  -- initiative it was linked to (hence agent_projects' SET NULL).
  org_project_id  TEXT        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,

  -- dev / staging / prod, or whatever this org calls its tiers. Unique per
  -- initiative: two rows named "prod" under one initiative means somebody is
  -- looking at the wrong one.
  name            TEXT        NOT NULL,

  -- eks | ecs | lambda | static | rds | other. See the header — this names the
  -- shape so the null columns below read as intent rather than as missing data.
  kind            TEXT        NOT NULL DEFAULT 'eks',

  -- Where it lives. The account id is TEXT, not a number: a 12-digit
  -- identifier with significant leading zeros, on which arithmetic is never
  -- meaningful.
  aws_account_id  TEXT        NOT NULL,
  aws_region      TEXT        NOT NULL DEFAULT 'us-east-1',

  -- The EKS specialization. Null for every environment that isn't a cluster,
  -- which is most of them in a mixed estate.
  cluster_name    TEXT,
  cluster_arn     TEXT,
  namespace       TEXT,

  -- The role a devbox assumes to reach this environment. A name, not a
  -- credential. Null means "wired for access by nothing yet", which is the
  -- honest state of an environment that has been described but not connected.
  access_role_arn TEXT,

  -- dev(0) → staging(10) → prod(30). Sparse, so a tier can be inserted between
  -- two existing ones without renumbering the world.
  rank            INTEGER     NOT NULL DEFAULT 0,

  -- active | provisioning | degraded | retired. Descriptive, not live health:
  -- nothing here polls the environment, so the row says what the org believes,
  -- and belief is what a human edits.
  status          TEXT        NOT NULL DEFAULT 'active',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT environments_project_name_key UNIQUE (org_project_id, name)
);

-- The only listing that matters: one initiative's environments, dev first.
CREATE INDEX IF NOT EXISTS idx_environments_project ON environments (org_project_id, rank);
-- "What else lives in this account?" — the blast-radius question, asked right
-- before somebody runs a command somewhere.
CREATE INDEX IF NOT EXISTS idx_environments_account ON environments (aws_account_id, aws_region);
CREATE INDEX IF NOT EXISTS idx_environments_status  ON environments (status);

-- ─── Seed: environments for the demo cast ────────────────────────────────────
--
-- Idempotent in the same shape as schema/seed_program.sql: fixed ids and a
-- bare ON CONFLICT DO NOTHING (which covers the id PK *and* the per-initiative
-- name uniqueness), so re-applying never duplicates a tier and never clobbers
-- an edit made in the app.
--
-- Deliberately NOT a uniform dev/staging/prod trio fourteen times over. A real
-- estate is lumpy, and a demo that renders the same three rows per initiative
-- teaches nothing about the model. Some initiatives are EKS end to end, one
-- runs its GPU tier in a separate account, one ships Lambdas, one a static
-- site, one has a prod that doesn't exist yet, one keeps a retired region.

INSERT INTO environments (id, org_project_id, name, kind, aws_account_id, aws_region, cluster_name, cluster_arn, namespace, access_role_arn, rank, status) VALUES
  ('b1f0a1e1-0001-4a00-8000-000000000001', 'p-observability', 'dev',     'eks', '647757222309', 'us-east-1', 'orgiq-dev',     'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-dev',     'observability', 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',     0,  'active'),
  ('b1f0a1e1-0001-4a00-8000-000000000002', 'p-observability', 'staging', 'eks', '647757222309', 'us-east-1', 'orgiq-staging', 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-staging', 'observability', 'arn:aws:iam::647757222309:role/orgiq-env-staging-access', 10, 'active'),
  ('b1f0a1e1-0001-4a00-8000-000000000003', 'p-observability', 'prod',    'eks', '647757222309', 'us-east-1', 'orgiq-prod',    'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',    'observability', 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',    30, 'active'),

  ('b1f0a1e1-0002-4a00-8000-000000000001', 'p-auth-migration', 'dev',     'eks', '647757222309', 'us-east-1', 'orgiq-dev',     'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-dev',     'auth', 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',     0,  'active'),
  ('b1f0a1e1-0002-4a00-8000-000000000002', 'p-auth-migration', 'staging', 'eks', '647757222309', 'us-east-1', 'orgiq-staging', 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-staging', 'auth', 'arn:aws:iam::647757222309:role/orgiq-env-staging-access', 10, 'active'),
  ('b1f0a1e1-0002-4a00-8000-000000000003', 'p-auth-migration', 'prod',    'eks', '647757222309', 'us-east-1', 'orgiq-prod',    'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',    'auth', 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',    30, 'active'),

  -- The LLM platform runs inference in its own account: a GPU fleet with a very
  -- different cost profile and blast radius does not belong beside general
  -- workloads, and the account id is the honest way to say so.
  ('b1f0a1e1-0003-4a00-8000-000000000001', 'p-llm-platform', 'dev',  'eks', '647757222309', 'us-east-1', 'orgiq-dev',      'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-dev',      'llm', 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',  0,  'active'),
  ('b1f0a1e1-0003-4a00-8000-000000000002', 'p-llm-platform', 'prod', 'eks', '210987654321', 'us-east-1', 'orgiq-gpu-prod', 'arn:aws:eks:us-east-1:210987654321:cluster/orgiq-gpu-prod', 'llm', 'arn:aws:iam::210987654321:role/orgiq-env-prod-access', 30, 'active'),

  -- Not everything is a cluster. Cost-opt ships scheduled Lambdas; the cluster
  -- columns stay null and `kind` says why.
  ('b1f0a1e1-0004-4a00-8000-000000000001', 'p-cost-opt', 'dev',  'lambda', '647757222309', 'us-east-1', NULL, NULL, NULL, 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',  0,  'active'),
  ('b1f0a1e1-0004-4a00-8000-000000000002', 'p-cost-opt', 'prod', 'lambda', '647757222309', 'us-east-1', NULL, NULL, NULL, 'arn:aws:iam::647757222309:role/orgiq-env-prod-access', 30, 'active'),

  ('b1f0a1e1-0005-4a00-8000-000000000001', 'p-rag-search', 'dev',     'eks', '647757222309', 'us-east-1', 'orgiq-dev',     'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-dev',     'rag', 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',     0,  'active'),
  ('b1f0a1e1-0005-4a00-8000-000000000002', 'p-rag-search', 'staging', 'eks', '647757222309', 'us-east-1', 'orgiq-staging', 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-staging', 'rag', 'arn:aws:iam::647757222309:role/orgiq-env-staging-access', 10, 'active'),
  -- Described before it exists — the honest state for work still in flight.
  ('b1f0a1e1-0005-4a00-8000-000000000003', 'p-rag-search', 'prod',    'eks', '647757222309', 'us-east-1', 'orgiq-prod',    'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',    'rag', NULL,                                                      30, 'provisioning'),

  -- A static site has no cluster and no namespace, and pretending otherwise is
  -- exactly the modelling mistake the nullable columns exist to avoid.
  ('b1f0a1e1-0006-4a00-8000-000000000001', 'p-design-v3', 'preview', 'static', '647757222309', 'us-east-1', NULL, NULL, NULL, 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',  5,  'active'),
  ('b1f0a1e1-0006-4a00-8000-000000000002', 'p-design-v3', 'prod',    'static', '647757222309', 'us-east-1', NULL, NULL, NULL, 'arn:aws:iam::647757222309:role/orgiq-env-prod-access', 30, 'active'),

  -- SOC2 evidence collection runs in the audit account, which nothing else
  -- touches. One tier, no lower ones: there is nothing here to rehearse.
  ('b1f0a1e1-0007-4a00-8000-000000000001', 'p-soc2', 'prod', 'ecs', '512345678901', 'us-east-2', NULL, NULL, NULL, 'arn:aws:iam::512345678901:role/orgiq-env-audit-access', 30, 'active'),

  ('b1f0a1e1-0008-4a00-8000-000000000001', 'p-zero-trust', 'staging', 'eks', '647757222309', 'us-east-1', 'orgiq-staging', 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-staging', 'zero-trust', 'arn:aws:iam::647757222309:role/orgiq-env-staging-access', 10, 'active'),
  ('b1f0a1e1-0008-4a00-8000-000000000002', 'p-zero-trust', 'prod',    'eks', '647757222309', 'us-east-1', 'orgiq-prod',    'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod',    'zero-trust', 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',    30, 'active'),

  -- Retired rows are kept, not deleted: "where did this used to run" is a real
  -- question during a postmortem, and a deleted row answers it with silence.
  ('b1f0a1e1-0009-4a00-8000-000000000001', 'p-data-lake', 'legacy-prod', 'ecs', '647757222309', 'us-west-2', NULL,         NULL,                                                    NULL,        NULL,                                                   40, 'retired'),
  ('b1f0a1e1-0009-4a00-8000-000000000002', 'p-data-lake', 'prod',        'eks', '647757222309', 'us-east-1', 'orgiq-prod', 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod', 'data-lake', 'arn:aws:iam::647757222309:role/orgiq-env-prod-access', 30, 'active')
ON CONFLICT DO NOTHING;

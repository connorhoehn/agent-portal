# OrgIQ schema

`orgiq_schema.sql` is the canonical relational schema for the OrgIQ org-graph in
Aurora PostgreSQL. Aurora does not support Apache AGE, so the graph is modeled
as plain tables (nodes + one edge table per relationship type) with `pgvector`
embeddings alongside.

## Applying the schema

Run once against the deployed Aurora cluster (idempotent — uses `CREATE … IF NOT EXISTS`):

```bash
export AURORA_CLUSTER_ARN=$(aws cloudformation describe-stacks \
  --stack-name OrgIQ-Aurora --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterArn'].OutputValue" --output text)

export AURORA_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name OrgIQ-Aurora --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='CredentialsSecretArn'].OutputValue" --output text)

aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --region us-east-1 \
  --sql "$(cat schema/orgiq_schema.sql)"
```

If the cluster has been idle, the first call will scale Aurora Serverless v2 up
from 0.5 ACU and may take 10-20 seconds.

## Verifying

```bash
aws rds-data execute-statement \
  --resource-arn "$AURORA_CLUSTER_ARN" \
  --secret-arn "$AURORA_SECRET_ARN" \
  --database orgiq \
  --sql "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
```

Expected tables: `collaborations`, `decision_participants`, `decisions`,
`documents`, `mentions`, `node_embeddings`, `people`, `person_skills`,
`project_contributions`, `projects`, `skills`, `team_memberships`, `teams`.

## When to re-run

- After a fresh Aurora deploy.
- After any change to `orgiq_schema.sql` (new columns, new indexes). The file
  uses `IF NOT EXISTS` everywhere, so additive changes are safe to reapply.
  Destructive changes (drop column, change type) need manual migration outside
  this file.

## Demo identities

`seed_demo_identities.sql` holds the demo sign-in cast: 24 accounts in
`app_users` and their grants in `user_tenant_roles`, including `u-operator`,
which holds `admin` in all five tenants. It used to live at the end of
`identity_schema.sql`, which every deploy loads, so every environment got a
known all-tenant admin account.

It is deliberately **not** in `manifest.json`. `load_schema.py`, a deploy and a
plain `python3 schema/apply_all_seed.py` never apply it. To load it into a
local or demo database, ask for it:

```bash
python3 schema/apply_all_seed.py --with-demo-users   # old name: --demo-identities
```

That applies it first, before the rest of the seed run, so the seeds that look
users up find them. The switch refuses to run (exit 2, before any database
call) when the target is production: the target environment file
(`infra/environments/<name>.json`, picked by `--env` or `ORGIQ_ENV`, default
`lab`) says `"production": true` or cannot be read, or `NODE_ENV` / `APP_ENV`
says `production` (or `prod`).
Offline (`MOCK_AURORA`) the middleware does not read this file: the same cast
is mirrored in `FALLBACK_USERS` in `middleware/src/providers/identity.ts`, and
the parity tests in `middleware/src/mock/core/parity` compare the two. That
mirror answers only under `MOCK_AURORA` or `INSECURE_DEV_MODE`; a deployed
middleware whose identity tables are empty or unreachable lists nobody.

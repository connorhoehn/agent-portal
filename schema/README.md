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

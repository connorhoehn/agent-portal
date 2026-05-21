-- Seed data for the knowledge_bases registry.
-- Safe to re-run — all inserts use ON CONFLICT DO NOTHING.
--
-- Run this AFTER orgiq_kb_registry_schema.sql has been applied.
-- The existing Bedrock KB ID (EJYAXQAMHQ) comes from middleware/.env.aws
-- (KNOWLEDGE_BASE_ID). The data_source_id is filled by the bootstrap script:
--   tsx middleware/src/scripts/bootstrap-kb-registry.ts
--
-- Newsroom KB (slug=newsroom) starts as PENDING — it is provisioned via the
-- portal wizard or POST /api/admin/kb-registry in Wave 3.

-- ---------------------------------------------------------------------------
-- Tenant: orgiq — default KB (existing, CDK-provisioned)
-- ---------------------------------------------------------------------------

INSERT INTO knowledge_bases (
  bedrock_kb_id,
  data_source_id,
  name,
  slug,
  tenant,
  purpose,
  description,
  s3_prefix,
  aurora_table,
  embedding_model,
  chunking_strategy,
  max_tokens,
  status,
  kb_service_role_arn
) VALUES (
  'EJYAXQAMHQ',   -- existing Bedrock KB ID from CDK OrgIQ-KnowledgeBase stack
  NULL,            -- bootstrap-kb-registry.ts will fill this from ListDataSources
  'OrgIQ Documents',
  'default',
  'orgiq',
  'default',
  'General organizational documents — ADRs, postmortems, performance reviews, wiki exports, Slack threads, all-hands recaps',
  'orgiq/uploads/',
  'bedrock_kb',
  'amazon.titan-embed-text-v2:0',
  'SEMANTIC',
  512,
  'ACTIVE',
  NULL             -- bootstrap script fills this from IAM describe-role if needed
) ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tenant: newsroom — article archive KB (not yet provisioned)
-- ---------------------------------------------------------------------------

INSERT INTO knowledge_bases (
  bedrock_kb_id,
  data_source_id,
  name,
  slug,
  tenant,
  purpose,
  description,
  s3_prefix,
  aurora_table,
  embedding_model,
  chunking_strategy,
  max_tokens,
  status
) VALUES (
  NULL,   -- not yet provisioned
  NULL,
  'Newsroom Articles',
  'newsroom',
  'newsroom',
  'articles',
  'News articles, entity clusters, and editorial research content ingested by the news-researcher agent',
  'newsroom/',
  'bedrock_kb_newsroom',
  'amazon.titan-embed-text-v2:0',
  'SEMANTIC',
  512,
  'PENDING'
) ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill existing documents → default KB
-- Runs only on rows that have no kb_registry_slug yet.
-- Safe to run multiple times (WHERE clause is idempotent).
-- ---------------------------------------------------------------------------

UPDATE documents
   SET kb_registry_slug = 'default'
 WHERE kb_registry_slug IS NULL;

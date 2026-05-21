-- OrgIQ Knowledge Base Registry schema for Aurora PostgreSQL 16.
-- Apply AFTER orgiq_schema.sql (depends on the documents table existing).
--
-- Purpose: tracks every Bedrock Knowledge Base in the system — one row per KB,
-- whether provisioned via the portal wizard or pre-existing from CDK.
-- The portal /admin/knowledge-bases surface reads from this table.
--
-- Apply via RDS Data API (each statement separately — RDS Data API is single-stmt):
--   aws rds-data execute-statement \
--     --resource-arn $AURORA_CLUSTER_ARN \
--     --secret-arn  $AURORA_SECRET_ARN  \
--     --database orgiq                  \
--     --sql "<statement>"

-- ---------------------------------------------------------------------------
-- knowledge_bases registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Bedrock-assigned IDs (null while status = CREATING or PENDING)
  bedrock_kb_id       TEXT,
  data_source_id      TEXT,

  -- Identity
  name                TEXT        NOT NULL UNIQUE,
  slug                TEXT        NOT NULL UNIQUE,   -- machine key, URL-safe, used for Aurora table + S3 prefix naming

  -- Tenant / purpose routing
  tenant              TEXT        NOT NULL DEFAULT 'orgiq',   -- orgiq | newsroom
  purpose             TEXT        NOT NULL DEFAULT 'default', -- default | articles | hr | engineering | custom

  description         TEXT,

  -- S3 landing zone (prefix inside the shared documents bucket, e.g. "orgiq/uploads/")
  s3_prefix           TEXT        NOT NULL,

  -- Aurora vector store (table name in the same cluster, e.g. "bedrock_kb_hr")
  aurora_table        TEXT        NOT NULL,

  -- Bedrock KB configuration
  embedding_model     TEXT        NOT NULL DEFAULT 'amazon.titan-embed-text-v2:0',
  chunking_strategy   TEXT        NOT NULL DEFAULT 'SEMANTIC',  -- SEMANTIC | FIXED | HIERARCHICAL | NONE
  max_tokens          INTEGER     NOT NULL DEFAULT 512,

  -- Lifecycle
  status              TEXT        NOT NULL DEFAULT 'CREATING',
                      -- PENDING (not yet provisioned)
                      -- CREATING (provisioning in flight)
                      -- ACTIVE
                      -- UPDATING
                      -- FAILED
                      -- DELETING

  error_message       TEXT,

  -- IAM role Bedrock uses to access Aurora + S3 on behalf of this KB
  kb_service_role_arn TEXT,

  -- Freeform config for future extensions (metadata filters, custom chunking params, etc.)
  config_json         JSONB       NOT NULL DEFAULT '{}',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS kb_tenant_idx  ON knowledge_bases (tenant);
CREATE INDEX IF NOT EXISTS kb_status_idx  ON knowledge_bases (status);
CREATE INDEX IF NOT EXISTS kb_slug_idx    ON knowledge_bases (slug);

-- ---------------------------------------------------------------------------
-- updated_at trigger — keep updated_at current on every UPDATE
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_knowledge_bases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kb_updated_at_trigger ON knowledge_bases;

CREATE TRIGGER kb_updated_at_trigger
  BEFORE UPDATE ON knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION update_knowledge_bases_updated_at();

-- ---------------------------------------------------------------------------
-- Link documents → knowledge_bases
-- Nullable so existing rows (pre-registry) are unaffected.
-- The backfill below sets kb_registry_slug = 'default' for all existing rows,
-- which maps them to the original OrgIQ KB once the default seed row exists.
-- ---------------------------------------------------------------------------

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS kb_registry_slug TEXT REFERENCES knowledge_bases(slug);

CREATE INDEX IF NOT EXISTS documents_kb_slug_idx
  ON documents (kb_registry_slug);

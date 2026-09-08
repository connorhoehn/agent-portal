// apply-kb-schema.ts
// Creates the knowledge_bases table, indexes, trigger, backfills documents,
// and seeds the default KB row.
//
// Safe to re-run — all DDL uses CREATE IF NOT EXISTS; all INSERTs use
// ON CONFLICT DO NOTHING; UPDATE backfill is idempotent.
//
// Usage (from repo root):
//   cd middleware && npx tsx src/scripts/apply-kb-schema.ts

import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.aws manually (same logic as config.ts)
const envPath = resolve(__dirname, '../../.env.aws');
try {
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) {
      process.env[m[1]!] = m[2];
    }
  }
} catch {
  // ignore missing .env.aws
}

const CLUSTER_ARN = process.env.AURORA_CLUSTER_ARN ?? '';
const SECRET_ARN  = process.env.AURORA_SECRET_ARN  ?? '';
const DATABASE    = process.env.AURORA_DB_NAME      ?? 'orgiq';
const KB_ID       = process.env.KNOWLEDGE_BASE_ID   ?? '';
const KB_ROLE_ARN = process.env.KB_SERVICE_ROLE_ARN ?? '';

if (!CLUSTER_ARN || !SECRET_ARN) {
  console.error('AURORA_CLUSTER_ARN and AURORA_SECRET_ARN must be set');
  process.exit(1);
}

const client = new RDSDataClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

async function sql(statement: string, label: string): Promise<void> {
  try {
    await client.send(new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn:   SECRET_ARN,
      database:    DATABASE,
      sql:         statement,
    }));
    console.log(`  ✓  ${label}`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // "already exists" errors are safe to ignore for IF NOT EXISTS / OR REPLACE constructs
    if (/already exists/i.test(msg)) {
      console.log(`  ≡  ${label} (already exists — skipped)`);
    } else {
      console.error(`  ✗  ${label}\n     ${msg}`);
      throw err;
    }
  }
}

async function main(): Promise<void> {
  console.log('\n═══ applying knowledge_bases schema to Aurora ═══\n');

  // ── 1. knowledge_bases table ─────────────────────────────────────────────
  await sql(`
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bedrock_kb_id       TEXT,
  data_source_id      TEXT,
  name                TEXT        NOT NULL UNIQUE,
  slug                TEXT        NOT NULL UNIQUE,
  tenant              TEXT        NOT NULL DEFAULT 'orgiq',
  purpose             TEXT        NOT NULL DEFAULT 'default',
  description         TEXT,
  s3_prefix           TEXT        NOT NULL,
  aurora_table        TEXT        NOT NULL,
  embedding_model     TEXT        NOT NULL DEFAULT 'amazon.titan-embed-text-v2:0',
  chunking_strategy   TEXT        NOT NULL DEFAULT 'SEMANTIC',
  max_tokens          INTEGER     NOT NULL DEFAULT 512,
  status              TEXT        NOT NULL DEFAULT 'CREATING',
  error_message       TEXT,
  kb_service_role_arn TEXT,
  config_json         JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`, 'CREATE TABLE knowledge_bases');

  // ── 2. Indexes ───────────────────────────────────────────────────────────
  await sql(`CREATE INDEX IF NOT EXISTS kb_tenant_idx ON knowledge_bases (tenant)`, 'INDEX kb_tenant_idx');
  await sql(`CREATE INDEX IF NOT EXISTS kb_status_idx ON knowledge_bases (status)`, 'INDEX kb_status_idx');
  await sql(`CREATE INDEX IF NOT EXISTS kb_slug_idx   ON knowledge_bases (slug)`,   'INDEX kb_slug_idx');

  // ── 3. updated_at trigger function ───────────────────────────────────────
  await sql(`
CREATE OR REPLACE FUNCTION update_knowledge_bases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`, 'FUNCTION update_knowledge_bases_updated_at');

  await sql(`DROP TRIGGER IF EXISTS kb_updated_at_trigger ON knowledge_bases`,
    'DROP TRIGGER kb_updated_at_trigger (idempotent)');

  await sql(`
CREATE TRIGGER kb_updated_at_trigger
  BEFORE UPDATE ON knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION update_knowledge_bases_updated_at()`,
    'TRIGGER kb_updated_at_trigger');

  // ── 4. FK column on documents ─────────────────────────────────────────────
  await sql(`
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS kb_registry_slug TEXT REFERENCES knowledge_bases(slug)`,
    'ALTER TABLE documents ADD COLUMN kb_registry_slug');

  await sql(`
CREATE INDEX IF NOT EXISTS documents_kb_slug_idx ON documents (kb_registry_slug)`,
    'INDEX documents_kb_slug_idx');

  // ── 5. Seed: default (orgiq) KB ──────────────────────────────────────────
  const kbRoleVal = KB_ROLE_ARN ? `'${KB_ROLE_ARN}'` : 'NULL';
  const kbIdVal   = KB_ID       ? `'${KB_ID}'`       : 'NULL';
  await sql(`
INSERT INTO knowledge_bases (
  bedrock_kb_id, data_source_id, name, slug, tenant, purpose,
  description, s3_prefix, aurora_table, embedding_model,
  chunking_strategy, max_tokens, status, kb_service_role_arn
) VALUES (
  ${kbIdVal}, NULL,
  'OrgIQ Documents', 'default', 'orgiq', 'default',
  'General org docs — ADRs, postmortems, perf reviews, Slack threads, all-hands recaps',
  'orgiq/uploads/', 'bedrock_kb',
  'amazon.titan-embed-text-v2:0', 'SEMANTIC', 512, 'ACTIVE',
  ${kbRoleVal}
) ON CONFLICT (slug) DO NOTHING`, 'SEED default KB (orgiq)');

  // ── 6. Backfill existing documents → default KB ──────────────────────────
  await sql(`
UPDATE documents
   SET kb_registry_slug = 'default'
 WHERE kb_registry_slug IS NULL`, 'BACKFILL documents.kb_registry_slug = default');

  console.log('\n✅  Knowledge base schema applied successfully.\n');
  console.log('Next step: run the bootstrap script to fill data_source_id:');
  console.log('  npx tsx src/scripts/bootstrap-kb-registry.ts\n');
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});

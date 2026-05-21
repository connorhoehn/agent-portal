// bootstrap-kb-registry.ts
// Run once after applying schema/seed_kb_registry.sql to populate the
// data_source_id for the existing 'default' KB entry.
//
// Usage:
//   cd middleware && npx tsx src/scripts/bootstrap-kb-registry.ts

import {
  BedrockAgentClient,
  ListDataSourcesCommand,
  type DataSourceSummary,
} from '@aws-sdk/client-bedrock-agent';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  // ── Step 1: verify KNOWLEDGE_BASE_ID is set ─────────────────────────────────
  const kbId = config.knowledgeBase.id;
  if (!kbId) {
    console.error('Error: KNOWLEDGE_BASE_ID is not set in environment / .env.aws');
    console.error('Make sure middleware/.env.aws contains KNOWLEDGE_BASE_ID=<your KB ID>');
    process.exit(1);
  }

  console.log(`Using KNOWLEDGE_BASE_ID: ${kbId}`);

  // ── Step 2: list data sources attached to the KB ────────────────────────────
  const client = new BedrockAgentClient({ region: config.region });

  console.log('Fetching data sources from Bedrock...');
  let dataSources: DataSourceSummary[];
  try {
    const resp = await client.send(
      new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 50 }),
    );
    dataSources = resp.dataSourceSummaries ?? [];
  } catch (err) {
    console.error('Error calling ListDataSources:', (err as Error).message);
    process.exit(1);
  }

  if (dataSources.length === 0) {
    console.error(`No data sources found for KB ${kbId}`);
    console.error('Ensure the CDK OrgIQ-KnowledgeBase stack has been deployed and is ACTIVE');
    process.exit(1);
  }

  console.log(`Found ${dataSources.length} data source(s):`);
  for (const ds of dataSources) {
    console.log(`  - ${ds.dataSourceId}  name="${ds.name}"  status=${ds.status}`);
  }

  // ── Step 3: find the first S3 data source ──────────────────────────────────
  // DataSourceSummary doesn't expose `type`; identify S3 by name heuristic or
  // just use the first source (the CDK stack creates exactly one S3 source).
  const s3Source =
    dataSources.find((ds) => (ds.name ?? '').toLowerCase().includes('s3')) ??
    dataSources[0]!;

  const dsId = s3Source.dataSourceId;
  if (!dsId) {
    console.error('Could not determine a valid dataSourceId from the listed sources');
    process.exit(1);
  }

  console.log(`\nSelected data source: ${dsId} ("${s3Source.name ?? 'unknown'}")`);

  // ── Step 4: update the 'default' registry entry if data_source_id is NULL ──
  console.log("Updating 'default' KB registry entry...");
  try {
    await exec(
      `UPDATE knowledge_bases
          SET data_source_id = :dsId
        WHERE slug = 'default'
          AND data_source_id IS NULL`,
      [{ name: 'dsId', value: { stringValue: dsId } }],
    );
  } catch (err) {
    console.error('Error updating knowledge_bases:', (err as Error).message);
    process.exit(1);
  }

  // ── Step 5: report outcome ─────────────────────────────────────────────────
  // Re-read to check current state
  const rows = await exec(
    `SELECT data_source_id FROM knowledge_bases WHERE slug = 'default'`,
    [],
  );

  if (rows.length === 0) {
    console.warn(
      "Warning: no 'default' row found in knowledge_bases. " +
      'Make sure schema/seed_kb_registry.sql has been applied first.',
    );
    process.exit(1);
  }

  const currentDsId = rows[0]!['data_source_id'];
  if (currentDsId === dsId) {
    console.log(`\nSuccess: data_source_id for slug='default' is now ${dsId}`);
  } else if (currentDsId != null) {
    console.log(
      `Already set: data_source_id for slug='default' is ${currentDsId} (no change made)`,
    );
  } else {
    console.warn('Warning: UPDATE ran but data_source_id is still NULL — check RDS Data API connectivity');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', (err as Error).message ?? err);
  process.exit(1);
});

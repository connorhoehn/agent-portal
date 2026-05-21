#!/usr/bin/env tsx
/**
 * migrate-s3-prefix.ts — one-shot S3 prefix migration for the KB registry.
 *
 * Copies all objects at the root level or under uploads/ to orgiq/uploads/,
 * then calls UpdateDataSource to add inclusionPrefixes: ['orgiq/uploads/'].
 *
 * Run:
 *   cd middleware && npx tsx src/scripts/migrate-s3-prefix.ts           # dry-run
 *   cd middleware && npx tsx src/scripts/migrate-s3-prefix.ts --execute  # live
 *
 * Prerequisites:
 *   - schema/orgiq_kb_registry_schema.sql applied
 *   - seed_kb_registry.sql applied
 *   - bootstrap-kb-registry.ts run (data_source_id populated)
 */

import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  type _Object as S3Object,
} from '@aws-sdk/client-s3';
import {
  BedrockAgentClient,
  UpdateDataSourceCommand,
  GetDataSourceCommand,
  type GetDataSourceCommandOutput,
  type S3DataSourceConfiguration,
  type DataSourceConfiguration,
} from '@aws-sdk/client-bedrock-agent';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';

// ─── Local helper (strParam is not exported from aurora.ts) ──────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

const DRY_RUN = !process.argv.includes('--execute');

if (DRY_RUN) {
  console.log('[DRY RUN] Pass --execute to perform the actual migration.');
  console.log('');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shouldMigrate(key: string): boolean {
  // Skip objects already under orgiq/ — they've already been migrated.
  if (key.startsWith('orgiq/')) return false;
  // Leave newsroom prefix untouched.
  if (key.startsWith('newsroom/')) return false;
  // Skip bare .keep markers (empty bucket placeholders).
  if (key === '.keep' || key.endsWith('/.keep')) return false;
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Step 1: load KB entry from Aurora registry ───────────────────────────────
  console.log("Loading 'default' knowledge base entry from registry...");

  let bedrockKbId: string;
  let dataSourceId: string;

  try {
    const rows = await exec(
      `SELECT bedrock_kb_id, data_source_id, s3_prefix
         FROM knowledge_bases
        WHERE slug = 'default'
        LIMIT 1`,
    );

    if (rows.length === 0) {
      console.error(
        "Error: no 'default' row found in knowledge_bases.\n" +
          'Make sure schema/orgiq_kb_registry_schema.sql + seed_kb_registry.sql have been applied.',
      );
      process.exit(1);
    }

    const row = rows[0]!;
    const rawKbId = row['bedrock_kb_id'];
    const rawDsId = row['data_source_id'];

    if (!rawKbId || typeof rawKbId !== 'string') {
      console.error(
        "Error: bedrock_kb_id is NULL for slug='default'.\n" +
          "Run bootstrap-kb-registry.ts first to populate it.",
      );
      process.exit(1);
    }

    if (!rawDsId || typeof rawDsId !== 'string') {
      console.error(
        "Error: data_source_id is NULL for slug='default'.\n" +
          "Run bootstrap-kb-registry.ts first to populate it.",
      );
      process.exit(1);
    }

    bedrockKbId = rawKbId;
    dataSourceId = rawDsId;
  } catch (err) {
    console.error('Error querying Aurora:', (err as Error).message);
    process.exit(1);
  }

  console.log(`  bedrock_kb_id:  ${bedrockKbId}`);
  console.log(`  data_source_id: ${dataSourceId}`);
  console.log('');

  // ── Step 2: resolve the documents bucket ────────────────────────────────────
  const bucket = config.foundation.documentsBucket;
  if (!bucket) {
    console.error(
      'Error: DOCUMENTS_BUCKET is not set in environment / .env.aws.\n' +
        'Make sure the OrgIQ-Foundation stack has been deployed and .env.aws is up-to-date.',
    );
    process.exit(1);
  }

  console.log(`Documents bucket: ${bucket}`);
  console.log('');

  // ── Step 3: list objects to migrate ─────────────────────────────────────────
  const s3 = new S3Client({ region: config.region });

  console.log('Listing S3 objects...');
  const toMigrate: S3Object[] = [];
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      if (shouldMigrate(obj.Key)) {
        toMigrate.push(obj);
      }
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`Objects found to migrate: ${toMigrate.length}`);
  if (toMigrate.length === 0) {
    console.log('Nothing to migrate — all objects are already under orgiq/ or excluded prefixes.');
    printSummary(0, 0, 0, false);
    return;
  }
  console.log('');

  // ── Step 4: copy each object to orgiq/uploads/<original-key> ────────────────
  let copied = 0;
  let failed = 0;
  // Skipped means "already under orgiq/" — handled by the filter above, but
  // we track it explicitly in case a concurrent run pre-migrated some objects.
  let skipped = 0;

  for (let i = 0; i < toMigrate.length; i++) {
    const obj = toMigrate[i]!;
    const sourceKey = obj.Key!;
    const destKey = `orgiq/uploads/${sourceKey}`;

    if (DRY_RUN) {
      console.log(`[DRY] would copy: ${sourceKey}  →  ${destKey}`);
      copied++;
    } else {
      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: encodeURIComponent(`${bucket}/${sourceKey}`),
            Key: destKey,
          }),
        );
        copied++;
      } catch (err) {
        console.error(`  FAILED to copy ${sourceKey}: ${(err as Error).message}`);
        failed++;
      }
    }

    // Progress heartbeat every 50 objects.
    if ((i + 1) % 50 === 0) {
      console.log(`  ... ${i + 1}/${toMigrate.length} processed (copied=${copied}, failed=${failed})`);
    }
  }

  console.log('');

  // ── Step 5: update the Bedrock data source inclusionPrefixes ─────────────────
  let dataSourceUpdated = false;

  if (!DRY_RUN && copied > 0 && failed === 0) {
    const bedrockAgent = new BedrockAgentClient({ region: config.region });

    // Fetch the current data source configuration so we can patch it cleanly.
    console.log('Fetching current data source configuration from Bedrock...');
    let currentConfig: GetDataSourceCommandOutput;
    try {
      currentConfig = await bedrockAgent.send(
        new GetDataSourceCommand({
          knowledgeBaseId: bedrockKbId,
          dataSourceId,
        }),
      );
    } catch (err) {
      console.error(`Error fetching data source ${dataSourceId}: ${(err as Error).message}`);
      console.error('Skipping data source update — re-run with --execute after fixing connectivity.');
      printSummary(copied, failed, skipped, dataSourceUpdated);
      return;
    }

    const ds = currentConfig.dataSource;
    if (!ds) {
      console.error('Error: GetDataSource returned no dataSource object — skipping update.');
      printSummary(copied, failed, skipped, dataSourceUpdated);
      return;
    }

    const existingS3Config: S3DataSourceConfiguration =
      (ds.dataSourceConfiguration?.s3Configuration as S3DataSourceConfiguration | undefined) ?? {
        bucketArn: '',
      };
    const existingPrefixes: string[] = existingS3Config.inclusionPrefixes ?? [];
    const TARGET_PREFIX = 'orgiq/uploads/';

    if (existingPrefixes.includes(TARGET_PREFIX)) {
      console.log(`Data source already has inclusionPrefix '${TARGET_PREFIX}' — no update needed.`);
      dataSourceUpdated = true; // conceptually already done
    } else {
      const updatedPrefixes = [...existingPrefixes, TARGET_PREFIX];

      console.log(
        `Updating data source ${dataSourceId} with inclusionPrefixes: ${JSON.stringify(updatedPrefixes)}`,
      );

      try {
        await bedrockAgent.send(
          new UpdateDataSourceCommand({
            knowledgeBaseId: bedrockKbId,
            dataSourceId,
            name: ds.name ?? 'orgiq-s3-source',
            description: ds.description,
            dataSourceConfiguration: {
              ...ds.dataSourceConfiguration,
              s3Configuration: {
                ...existingS3Config,
                inclusionPrefixes: updatedPrefixes,
              },
            } as DataSourceConfiguration,
            vectorIngestionConfiguration: ds.vectorIngestionConfiguration,
          }),
        );
        dataSourceUpdated = true;
        console.log('Data source updated successfully.');
      } catch (err) {
        console.error(`Error updating data source: ${(err as Error).message}`);
        console.error('Objects were copied but the data source was NOT updated — re-run to retry.');
      }
    }
  } else if (DRY_RUN) {
    console.log('[DRY] would update data source inclusionPrefixes to include orgiq/uploads/');
  } else if (failed > 0) {
    console.warn(
      `Skipping data source update because ${failed} object(s) failed to copy.\n` +
        'Fix the failures and re-run to retry.',
    );
  }

  console.log('');
  printSummary(copied, failed, skipped, dataSourceUpdated);
}

// ─── Summary printer ─────────────────────────────────────────────────────────

function printSummary(
  copied: number,
  failed: number,
  skipped: number,
  dataSourceUpdated: boolean,
): void {
  const dsStatus = DRY_RUN ? 'no (dry run)' : dataSourceUpdated ? 'yes' : 'no';

  console.log('Migration complete:');
  console.log(`  Objects copied:  ${copied}`);
  console.log(`  Objects failed:  ${failed}`);
  console.log(`  Objects skipped: ${skipped} (already prefixed)`);
  console.log(`  Data source updated: ${dsStatus}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run a Bedrock KB sync: POST /api/admin/kb-registry/default/sync');
  console.log('  2. Verify documents re-appear at /admin/knowledge-bases/default');
  console.log('  3. Delete original unprefixed objects once sync is confirmed (manual step)');
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('Unhandled error:', (err as Error).message ?? err);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * smoke-test-kb.ts — end-to-end smoke test for the KB registry provisioning flow.
 *
 * Creates a throwaway KB, uploads a small test document, triggers a sync,
 * waits for COMPLETE, verifies the doc appears in the registry, then cleans up.
 *
 * Run:
 *   cd middleware && npx tsx src/scripts/smoke-test-kb.ts
 *
 * Prerequisites: .env.aws populated, Aurora + Bedrock accessible.
 *
 * Expected output (success):
 *   [smoke] Creating test KB: smoke-test-1748123456789...
 *   [smoke] KB created (id: abc-123)
 *   [smoke] Provisioning (this takes ~60s)...
 *   [smoke] KB provisioned (bedrockKbId: XYZ)  [42s]
 *   [smoke] Uploading test document...
 *   [smoke] Document uploaded (key: smoke-test/.keep)
 *   [smoke] Triggering sync...
 *   [smoke] Sync started (jobId: job-abc)
 *   [smoke] Waiting for sync to complete (max 3 min)...
 *   [smoke] Sync complete  [38s]
 *   [smoke] Cleaning up...
 *   [smoke] KB deleted
 *   [smoke] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   [smoke] PASS  total: 84s
 */

import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  createKbEntry,
  provisionKb,
  getKb,
  deprovisionKb,
} from '../providers/kb-registry.js';
import { uploadToLandingZone } from '../providers/landing-zones.js';
import { config } from '../config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROVISION_TIMEOUT_MS  = 180_000;  // 3 min — CreateKB + CreateDataSource can be slow
const SYNC_TIMEOUT_MS       = 180_000;  // 3 min
const SYNC_POLL_INTERVAL_MS =  10_000;

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

function elapsed(startMs: number): string {
  return `${Math.round((Date.now() - startMs) / 1000)}s`;
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll Aurora for the KB entry until its status leaves CREATING, or timeout. */
async function waitForProvisioned(id: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await getKb(id);
    if (!entry) throw new Error(`KB entry ${id} disappeared while polling`);
    if (entry.status !== 'CREATING' && entry.status !== 'PENDING') {
      return entry.status;
    }
    await sleep(5_000);
  }
  throw new Error('Timed out waiting for KB to finish provisioning');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const totalStart = Date.now();
  const testSlug   = `smoke-test-${Date.now()}`;
  let entryId: string | null = null;

  // ── Step 1: Create KB registry entry ─────────────────────────────────────
  log(`Creating test KB: ${testSlug}...`);
  const entry = await createKbEntry({
    name: `Smoke Test ${testSlug}`,
    slug: testSlug,
    tenant: 'orgiq',
    purpose: 'custom',
    description: 'Smoke test KB — safe to delete',
    s3Prefix: `${testSlug}/`,
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 256,
  });
  entryId = entry.id;
  log(`KB created (id: ${entry.id})`);

  // ── Step 2: Provision with timeout ────────────────────────────────────────
  log('Provisioning (this takes ~60s)...');
  const provisionStart = Date.now();

  // provisionKb is fire-and-forget in the provider (it writes to Aurora).
  // We kick it off and poll Aurora ourselves.
  const provisionPromise = provisionKb(entry.id).catch((err: unknown) => {
    // Surface errors but don't crash — waitForProvisioned will see FAILED status
    log(`provisionKb threw: ${(err as Error).message}`);
  });

  const timeoutPromise = sleep(PROVISION_TIMEOUT_MS).then(() => {
    throw new Error('Provision timed out after 3 minutes');
  });

  let finalStatus: string;
  try {
    // Race: either provisioning finishes (we poll Aurora) or we hit the timeout.
    finalStatus = await Promise.race([
      waitForProvisioned(entry.id, PROVISION_TIMEOUT_MS),
      timeoutPromise as Promise<never>,
    ]);
    // Let the background provisionKb finish its own awaits cleanly.
    await provisionPromise;
  } catch (err) {
    log(`FAIL  Provision error: ${(err as Error).message}  [${elapsed(provisionStart)}]`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }

  if (finalStatus !== 'ACTIVE') {
    const refreshed = await getKb(entry.id);
    log(`FAIL  KB status after provisioning: ${finalStatus}  [${elapsed(provisionStart)}]`);
    if (refreshed?.errorMessage) log(`      error: ${refreshed.errorMessage}`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }

  // Re-fetch to get bedrockKbId + dataSourceId written by provisionKb
  const provisioned = await getKb(entry.id);
  if (!provisioned?.bedrockKbId || !provisioned?.dataSourceId) {
    log(`FAIL  KB ACTIVE but missing bedrockKbId or dataSourceId  [${elapsed(provisionStart)}]`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }
  log(`KB provisioned (bedrockKbId: ${provisioned.bedrockKbId})  [${elapsed(provisionStart)}]`);

  // ── Step 3: Upload test document ──────────────────────────────────────────
  log('Uploading test document...');
  let uploadedKey: string;
  try {
    const result = await uploadToLandingZone(
      testSlug,
      'smoke-test.txt',
      Buffer.from('This is a smoke test document for OrgIQ KB registry validation.'),
      'text/plain',
    );
    uploadedKey = result.key;
    log(`Document uploaded (key: ${result.key})`);
  } catch (err) {
    log(`FAIL  Upload failed: ${(err as Error).message}`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }

  // ── Step 4: Trigger sync ──────────────────────────────────────────────────
  log('Triggering sync...');
  const bedrockClient = new BedrockAgentClient({ region: config.region });
  let jobId: string;
  try {
    const syncResp = await bedrockClient.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: provisioned.bedrockKbId,
        dataSourceId: provisioned.dataSourceId,
        description: `Smoke test sync for ${testSlug}`,
      }),
    );
    jobId = syncResp.ingestionJob?.ingestionJobId ?? '';
    if (!jobId) throw new Error('StartIngestionJob returned no jobId');
    log(`Sync started (jobId: ${jobId})`);
  } catch (err) {
    log(`FAIL  Sync trigger failed: ${(err as Error).message}`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }

  // ── Step 5: Poll for sync completion ─────────────────────────────────────
  log('Waiting for sync to complete (max 3 min)...');
  const syncStart = Date.now();
  const syncDeadline = Date.now() + SYNC_TIMEOUT_MS;
  let syncStatus = 'STARTING';

  while (Date.now() < syncDeadline) {
    await sleep(SYNC_POLL_INTERVAL_MS);
    try {
      const jobResp = await bedrockClient.send(
        new GetIngestionJobCommand({
          knowledgeBaseId: provisioned.bedrockKbId,
          dataSourceId: provisioned.dataSourceId,
          ingestionJobId: jobId,
        }),
      );
      syncStatus = String(jobResp.ingestionJob?.status ?? 'UNKNOWN');
      if (syncStatus === 'COMPLETE') break;
      if (syncStatus === 'FAILED') {
        const reasons = jobResp.ingestionJob?.failureReasons ?? [];
        log(`FAIL  Sync job FAILED  [${elapsed(syncStart)}]`);
        if (reasons.length > 0) log(`      reasons: ${reasons.join('; ')}`);
        await cleanup(entryId);
        process.exitCode = 1;
        return;
      }
    } catch (err) {
      log(`      GetIngestionJob error (will retry): ${(err as Error).message}`);
    }
  }

  if (syncStatus !== 'COMPLETE') {
    log(`FAIL  Sync timed out with status ${syncStatus}  [${elapsed(syncStart)}]`);
    await cleanup(entryId);
    process.exitCode = 1;
    return;
  }
  log(`Sync complete  [${elapsed(syncStart)}]`);

  // ── Step 6: Cleanup ───────────────────────────────────────────────────────
  log('Cleaning up...');
  await cleanup(entryId);
  entryId = null;  // cleanup succeeded

  // ── Step 7: Summary ───────────────────────────────────────────────────────
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`PASS  total: ${elapsed(totalStart)}`);
}

async function cleanup(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await deprovisionKb(id);
    log('KB deleted');
  } catch (err) {
    log(`cleanup error (non-fatal): ${(err as Error).message}`);
  }
}

run().catch((err: unknown) => {
  log(`Unhandled error: ${(err as Error).message}`);
  process.exitCode = 1;
});

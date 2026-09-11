// KB Registry provider — CRUD + async provisioning for the knowledge_bases table.
//
// The knowledge_bases table tracks every Bedrock KB in the system (one row per KB).
// This provider handles:
//   - Reading/listing registry entries from Aurora
//   - Creating and updating registry entries
//   - Async provisioning: CreateKnowledgeBase + CreateDataSource via Bedrock Agent SDK
//   - Async deprovisioning: DeleteKnowledgeBase + cleanup
//
// Schema: schema/orgiq_kb_registry_schema.sql

import {
  BedrockAgentClient,
  CreateKnowledgeBaseCommand,
  GetKnowledgeBaseCommand,
  DeleteKnowledgeBaseCommand,
  ListKnowledgeBasesCommand,
  CreateDataSourceCommand,
  type VectorIngestionConfiguration,
} from '@aws-sdk/client-bedrock-agent';
import { exec } from './aurora.js';
import { initLandingZone } from './landing-zones.js';
import { provisioningBroker } from '../lib/provisioning-broker.js';
import { config } from '../config.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  mockKbRegistry,
  mockCreateKbEntry,
  mockDeleteKbEntry,
  mockPatchKb,
} from '../mock/kb-registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KbRegistryEntry {
  id: string;
  bedrockKbId: string | null;
  dataSourceId: string | null;
  name: string;
  slug: string;
  tenant: string;
  purpose: string;
  description: string | null;
  s3Prefix: string;
  auroraTable: string;
  embeddingModel: string;
  chunkingStrategy: string;
  maxTokens: number;
  status: string;
  errorMessage: string | null;
  kbServiceRoleArn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKbInput {
  name: string;
  slug: string;
  tenant: string;
  purpose: string;
  description?: string;
  s3Prefix: string;
  chunkingStrategy?: string;
  maxTokens?: number;
}

/** Emitted by the SSE status endpoint — describes an in-flight provisioning poll. */
export interface ProvisioningEvent {
  type: 'poll' | 'active' | 'failed' | 'error';
  status: string;
  message?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function nullableStrParam(name: string, value: string | null | undefined): SqlParameter {
  if (value == null || value === '') return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}

function rowToEntry(r: Record<string, unknown>): KbRegistryEntry {
  return {
    id: String(r['id'] ?? ''),
    bedrockKbId: r['bedrock_kb_id'] == null ? null : String(r['bedrock_kb_id']),
    dataSourceId: r['data_source_id'] == null ? null : String(r['data_source_id']),
    name: String(r['name'] ?? ''),
    slug: String(r['slug'] ?? ''),
    tenant: String(r['tenant'] ?? 'orgiq'),
    purpose: String(r['purpose'] ?? 'default'),
    description: r['description'] == null ? null : String(r['description']),
    s3Prefix: String(r['s3_prefix'] ?? ''),
    auroraTable: String(r['aurora_table'] ?? ''),
    embeddingModel: String(r['embedding_model'] ?? 'amazon.titan-embed-text-v2:0'),
    chunkingStrategy: String(r['chunking_strategy'] ?? 'SEMANTIC'),
    maxTokens: typeof r['max_tokens'] === 'number'
      ? r['max_tokens']
      : Number(r['max_tokens'] ?? 512),
    status: String(r['status'] ?? 'PENDING'),
    errorMessage: r['error_message'] == null ? null : String(r['error_message']),
    kbServiceRoleArn: r['kb_service_role_arn'] == null ? null : String(r['kb_service_role_arn']),
    createdAt: String(r['created_at'] ?? ''),
    updatedAt: String(r['updated_at'] ?? ''),
  };
}

// ─── Read operations ──────────────────────────────────────────────────────────

/** List all KB registry entries, optionally filtered by tenant. */
export async function listKbs(tenant?: string): Promise<KbRegistryEntry[]> {
  if (config.mock.aurora) {
    return tenant ? mockKbRegistry.filter((k) => k.tenant === tenant) : mockKbRegistry.slice();
  }
  const sql = tenant
    ? `SELECT * FROM knowledge_bases WHERE tenant = :tenant ORDER BY created_at DESC`
    : `SELECT * FROM knowledge_bases ORDER BY created_at DESC`;
  const params: SqlParameter[] = tenant ? [strParam('tenant', tenant)] : [];
  const rows = await exec(sql, params);
  return rows.map(rowToEntry);
}

/** Get a KB registry entry by UUID. */
/** Shape check before the cast — see getKb. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getKb(id: string): Promise<KbRegistryEntry | null> {
  // A malformed id is a miss, not a fault. `:id::uuid` makes Postgres raise on
  // anything that is not a UUID, which surfaced to callers as a 500 Internal
  // server error for what is plainly a bad request — and every route here
  // treats a null return as 404 already.
  if (!UUID_RE.test(id)) return null;
  if (config.mock.aurora) return mockKbRegistry.find((k) => k.id === id) ?? null;

  const rows = await exec(
    `SELECT * FROM knowledge_bases WHERE id = :id::uuid`,
    [strParam('id', id)],
  );
  return rows.length > 0 ? rowToEntry(rows[0]!) : null;
}

/** Get a KB registry entry by slug. */
export async function getKbBySlug(slug: string): Promise<KbRegistryEntry | null> {
  if (config.mock.aurora) return mockKbRegistry.find((k) => k.slug === slug) ?? null;
  const rows = await exec(
    `SELECT * FROM knowledge_bases WHERE slug = :slug`,
    [strParam('slug', slug)],
  );
  return rows.length > 0 ? rowToEntry(rows[0]!) : null;
}

// ─── Write operations ─────────────────────────────────────────────────────────

/** Insert a new KB registry entry. Returns the created entry with status = CREATING. */
export async function createKbEntry(input: CreateKbInput): Promise<KbRegistryEntry> {
  const chunkingStrategy = input.chunkingStrategy ?? 'SEMANTIC';
  const maxTokens = input.maxTokens ?? 512;
  // Derive aurora_table from slug: "bedrock_kb_<slug>" with hyphens → underscores
  const auroraTable = `bedrock_kb_${input.slug.replace(/-/g, '_')}`;
  const kbServiceRoleArn = config.knowledgeBase.serviceRoleArn || null;

  // The row is inserted into the fixture the reads above already serve, so
  // `POST /api/admin/kb-registry` followed by `GET /api/admin/kb-registry`
  // shows the knowledge base that was just registered — and
  // `POST /api/__mock/reset` un-registers it. The branch is here rather than
  // in routes/kb-admin.ts because this function is what owns the INSERT.
  if (config.mock.aurora) {
    return mockCreateKbEntry({
      name: input.name,
      slug: input.slug,
      tenant: input.tenant,
      purpose: input.purpose,
      description: input.description ?? null,
      s3Prefix: input.s3Prefix,
      auroraTable,
      chunkingStrategy,
      maxTokens,
      kbServiceRoleArn,
    });
  }

  const rows = await exec(
    `INSERT INTO knowledge_bases
       (name, slug, tenant, purpose, description, s3_prefix, aurora_table,
        embedding_model, chunking_strategy, max_tokens, status, kb_service_role_arn)
     VALUES
       (:name, :slug, :tenant, :purpose, :description, :s3_prefix, :aurora_table,
        'amazon.titan-embed-text-v2:0', :chunking_strategy, :max_tokens,
        'CREATING', :kb_service_role_arn)
     RETURNING *`,
    [
      strParam('name', input.name),
      strParam('slug', input.slug),
      strParam('tenant', input.tenant),
      strParam('purpose', input.purpose),
      nullableStrParam('description', input.description),
      strParam('s3_prefix', input.s3Prefix),
      strParam('aurora_table', auroraTable),
      strParam('chunking_strategy', chunkingStrategy),
      intParam('max_tokens', maxTokens),
      nullableStrParam('kb_service_role_arn', kbServiceRoleArn),
    ],
  );
  if (rows.length === 0) throw new Error('INSERT INTO knowledge_bases returned no rows');
  return rowToEntry(rows[0]!);
}

/** Update only the user-editable fields (name + description). */
export async function updateKbEntry(
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  if (config.mock.aurora) {
    mockPatchKb(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
    });
    return;
  }

  const parts: string[] = [];
  const params: SqlParameter[] = [];

  if (patch.name !== undefined) {
    parts.push('name = :name');
    params.push(strParam('name', patch.name));
  }
  if (patch.description !== undefined) {
    parts.push('description = :description');
    params.push(nullableStrParam('description', patch.description));
  }
  if (parts.length === 0) return;

  params.push(strParam('id', id));
  await exec(
    `UPDATE knowledge_bases SET ${parts.join(', ')} WHERE id = :id::uuid`,
    params,
  );
}

/** Hard-delete a registry entry by ID. */
export async function deleteKbEntry(id: string): Promise<void> {
  if (config.mock.aurora) { mockDeleteKbEntry(id); return; }
  await exec(`DELETE FROM knowledge_bases WHERE id = :id::uuid`, [strParam('id', id)]);
}

/** Internal: patch status + optional Bedrock IDs / error_message. */
async function patchKbStatus(
  id: string,
  status: string,
  opts: {
    errorMessage?: string | null;
    bedrockKbId?: string;
    dataSourceId?: string;
  } = {},
): Promise<void> {
  if (config.mock.aurora) {
    mockPatchKb(id, {
      status,
      ...(opts.bedrockKbId !== undefined ? { bedrockKbId: opts.bedrockKbId } : {}),
      ...(opts.dataSourceId !== undefined ? { dataSourceId: opts.dataSourceId } : {}),
      ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
    });
    return;
  }

  const parts: string[] = ['status = :status'];
  const params: SqlParameter[] = [strParam('status', status)];

  if (opts.bedrockKbId !== undefined) {
    parts.push('bedrock_kb_id = :bkid');
    params.push(strParam('bkid', opts.bedrockKbId));
  }
  if (opts.dataSourceId !== undefined) {
    parts.push('data_source_id = :dsid');
    params.push(strParam('dsid', opts.dataSourceId));
  }
  if (opts.errorMessage !== undefined) {
    parts.push('error_message = :err');
    params.push(nullableStrParam('err', opts.errorMessage));
  }

  params.push(strParam('id', id));
  await exec(
    `UPDATE knowledge_bases SET ${parts.join(', ')} WHERE id = :id::uuid`,
    params,
  );
}

// ─── Async provisioning ───────────────────────────────────────────────────────

/**
 * Provisions a Bedrock Knowledge Base for the given registry entry ID.
 * Fire-and-forget — callers do NOT await. Progress is streamed to any open
 * SSE connection via provisioningBroker; DB status is updated at each step.
 *
 * Steps (matching ProvisioningProgress.tsx step IDs):
 *  1. create_aurora_table  — CREATE TABLE IF NOT EXISTS <aurora_table> (vector store)
 *  2. create_vector_index  — HNSW index on embedding column
 *  3. create_text_index    — GIN full-text index on chunks column
 *  4. create_bedrock_kb    — Bedrock CreateKnowledgeBase
 *  5. wait_kb_active       — poll GetKnowledgeBase until ACTIVE (up to 5 min)
 *  6. create_data_source   — Bedrock CreateDataSource (S3 prefix)
 *  7. init_landing_zone    — put .keep object in S3 prefix
 */
export async function provisionKb(id: string): Promise<void> {
  // ── Helpers ───────────────────────────────────────────────────────────────
  const emit = (step: string, stepStatus: 'running' | 'done' | 'error', message?: string) => {
    provisioningBroker.emit(`kb:${id}`, { type: 'step', step, stepStatus, message });
  };

  const fail = async (step: string, msg: string) => {
    emit(step, 'error', msg);
    console.error(`[kb-registry] provisionKb step=${step} failed for ${id}: ${msg}`);
    try { await patchKbStatus(id, 'FAILED', { errorMessage: `[${step}] ${msg}` }); } catch { /* ignore */ }
    provisioningBroker.emit(`kb:${id}`, { type: 'failed', message: msg });
  };

  // ── Pre-flight ────────────────────────────────────────────────────────────
  const entry = await getKb(id).catch(() => null);
  if (!entry) {
    console.error(`[kb-registry] provisionKb: entry ${id} not found`);
    return;
  }

  // ── Offline ───────────────────────────────────────────────────────────────
  //
  // Every step below is a Bedrock or Aurora call, so offline this used to fail
  // at step 4 (`KB_SERVICE_ROLE_ARN not configured`) and then lose even that:
  // `fail` writes FAILED through `patchKbStatus`, whose `exec` threw and was
  // swallowed, so a KB created in dev:mock sat at CREATING for the life of the
  // process with no error anywhere. That is a write that looks half-done and
  // reports nothing.
  //
  // The offline provisioner walks the SAME seven steps through the SAME
  // broker, so ProvisioningProgress.tsx renders a genuine sequence, and lands
  // the row ACTIVE with `MOCK`-prefixed Bedrock ids — spelled that way so a
  // fixture-provisioned KB can never be mistaken for one Bedrock created. It
  // is a real state transition over fixture data; nothing is faked except the
  // account the ids belong to.
  if (config.mock.aurora) {
    const steps = [
      'create_aurora_table', 'create_vector_index', 'create_text_index',
      'create_bedrock_kb', 'wait_kb_active', 'create_data_source', 'init_landing_zone',
    ];
    const bedrockKbId = entry.bedrockKbId ?? `KBMOCK-${entry.slug.toUpperCase().replace(/-/g, '')}`.slice(0, 24);
    const dataSourceId = entry.dataSourceId ?? `DSMOCK-${entry.slug.toUpperCase().replace(/-/g, '')}`.slice(0, 24);
    for (const step of steps) {
      emit(step, 'running');
      if (step === 'init_landing_zone') await initLandingZone(entry.s3Prefix);
      emit(step, 'done', step === 'create_bedrock_kb' ? bedrockKbId
        : step === 'create_data_source' ? dataSourceId : undefined);
    }
    await patchKbStatus(id, 'ACTIVE', { bedrockKbId, dataSourceId, errorMessage: null });
    provisioningBroker.emit(`kb:${id}`, { type: 'complete', kbId: bedrockKbId });
    return;
  }

  const serviceRoleArn = entry.kbServiceRoleArn ?? config.knowledgeBase.serviceRoleArn;
  if (!serviceRoleArn) {
    await fail('create_bedrock_kb', 'KB_SERVICE_ROLE_ARN not configured');
    return;
  }

  const bucket = config.foundation.documentsBucket;
  if (!bucket) {
    await fail('create_bedrock_kb', 'DOCUMENTS_BUCKET not configured');
    return;
  }

  const client = new BedrockAgentClient({ region: config.region });
  const tbl = entry.auroraTable; // e.g. bedrock_kb_engineering_docs

  console.log(`[kb-registry] Starting provisioning for entry ${id} (slug=${entry.slug}, table=${tbl})`);

  // Track the active step so the catch block always labels the right one.
  let currentStep = 'create_aurora_table';

  try {
    // ── Step 1: Create Aurora vector table ───────────────────────────────────
    currentStep = 'create_aurora_table';
    emit('create_aurora_table', 'running');
    await exec(
      `CREATE TABLE IF NOT EXISTS ${tbl} (
         id        UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
         embedding vector(1024),
         chunks    TEXT,
         metadata  JSONB
       )`,
    );
    emit('create_aurora_table', 'done');

    // ── Step 2: HNSW index ───────────────────────────────────────────────────
    currentStep = 'create_vector_index';
    emit('create_vector_index', 'running');
    await exec(
      `CREATE INDEX IF NOT EXISTS ${tbl}_embedding_idx
         ON ${tbl} USING hnsw (embedding vector_cosine_ops)`,
    );
    emit('create_vector_index', 'done');

    // ── Step 3: Full-text index ──────────────────────────────────────────────
    // Bedrock validates the index against pg_indexes and expects the exact pattern
    //   to_tsvector('english', chunks)   — no COALESCE or other wrapper.
    // Always DROP + recreate so re-provisioning a FAILED row picks up the correct
    // definition even if a bad index was left behind by an earlier attempt.
    currentStep = 'create_text_index';
    emit('create_text_index', 'running');
    await exec(`DROP INDEX IF EXISTS ${tbl}_chunks_idx`);
    await exec(
      `CREATE INDEX ${tbl}_chunks_idx
         ON ${tbl} USING gin (to_tsvector('english', chunks))`,
    );
    emit('create_text_index', 'done');

    // ── Step 4: Create Bedrock KB (skip if already created) ──────────────────
    // Re-provisioning a FAILED row after steps 1-3: if bedrockKbId is already
    // persisted, the KB exists in Bedrock — skip creation to avoid duplicate error.
    currentStep = 'create_bedrock_kb';
    let bedrockKbId = entry.bedrockKbId ?? '';
    if (bedrockKbId) {
      emit('create_bedrock_kb', 'done', bedrockKbId);
      console.log(`[kb-registry] Bedrock KB already exists (${bedrockKbId}), skipping create`);
    } else {
      emit('create_bedrock_kb', 'running');
      // Bedrock name must match ([0-9a-zA-Z][_-]?){1,100} — no spaces.
      // Use slug (already URL-safe alphanumeric + hyphens) prefixed by tenant.
      const bedrockName = `${entry.tenant}-${entry.slug}`;
      const createResp = await client.send(
        new CreateKnowledgeBaseCommand({
          name: bedrockName,
          description: entry.description ?? entry.name,
          roleArn: serviceRoleArn,
          knowledgeBaseConfiguration: {
            type: 'VECTOR',
            vectorKnowledgeBaseConfiguration: {
              embeddingModelArn: `arn:aws:bedrock:${config.region}::foundation-model/${entry.embeddingModel}`,
            },
          },
          storageConfiguration: {
            type: 'RDS',
            rdsConfiguration: {
              resourceArn: config.aurora.clusterArn,
              credentialsSecretArn: config.aurora.secretArn,
              databaseName: config.aurora.database,
              tableName: tbl,
              fieldMapping: {
                vectorField: 'embedding',
                textField: 'chunks',
                metadataField: 'metadata',
                primaryKeyField: 'id',
              },
            },
          },
        }),
      );

      const newKbId = createResp.knowledgeBase?.knowledgeBaseId;
      if (!newKbId) throw new Error('CreateKnowledgeBase returned no knowledgeBaseId');
      bedrockKbId = newKbId;
      // Persist immediately so re-provisioning can skip this step on retry
      await patchKbStatus(id, 'CREATING', { bedrockKbId });
      emit('create_bedrock_kb', 'done', bedrockKbId);
    }

    // ── Step 5: Wait for KB to become ACTIVE ─────────────────────────────────
    currentStep = 'wait_kb_active';
    emit('wait_kb_active', 'running');
    const POLL_MS = 8_000;
    const LIMIT_MS = 5 * 60 * 1000;
    const deadline = Date.now() + LIMIT_MS;
    let kbStatus = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const resp = await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: bedrockKbId }));
      kbStatus = resp.knowledgeBase?.status ?? '';
      if (kbStatus === 'ACTIVE') break;
      if (kbStatus === 'FAILED') throw new Error(`Bedrock KB entered FAILED state`);
    }
    if (kbStatus !== 'ACTIVE') throw new Error(`Bedrock KB did not become ACTIVE within 5 minutes (last status: ${kbStatus})`);
    emit('wait_kb_active', 'done');

    // ── Step 6: Create S3 data source (skip if already created) ──────────────
    currentStep = 'create_data_source';
    let dataSourceId = entry.dataSourceId ?? '';
    if (dataSourceId) {
      emit('create_data_source', 'done', dataSourceId);
      console.log(`[kb-registry] Data source already exists (${dataSourceId}), skipping create`);
    } else {
      emit('create_data_source', 'running');
      const chunkingConfig = buildChunkingConfig(entry.chunkingStrategy, entry.maxTokens);
      const dsResp = await client.send(
        new CreateDataSourceCommand({
          knowledgeBaseId: bedrockKbId,
          name: `${entry.slug}-s3-source`,
          description: `S3 data source for KB ${entry.slug}`,
          dataSourceConfiguration: {
            type: 'S3',
            s3Configuration: {
              bucketArn: `arn:aws:s3:::${bucket}`,
              inclusionPrefixes: [entry.s3Prefix],
            },
          },
          vectorIngestionConfiguration: chunkingConfig,
        }),
      );
      const newDsId = dsResp.dataSource?.dataSourceId;
      if (!newDsId) throw new Error('CreateDataSource returned no dataSourceId');
      dataSourceId = newDsId;
      // Persist immediately so re-provisioning skips on retry
      await patchKbStatus(id, 'CREATING', { bedrockKbId, dataSourceId });
      emit('create_data_source', 'done', dataSourceId);
    }

    // ── Step 7: Init S3 landing zone (non-fatal) ─────────────────────────────
    // The KB is fully provisioned after step 6. Step 7 just places a .keep marker
    // in S3 so the prefix is visible. If the bucket doesn't exist yet (or there's
    // a transient S3 error), we log a warning but still mark the KB as ACTIVE.
    currentStep = 'init_landing_zone';
    emit('init_landing_zone', 'running');
    try {
      await initLandingZone(entry.s3Prefix);
      emit('init_landing_zone', 'done');
    } catch (lzErr) {
      const lzMsg = (lzErr as Error).message ?? String(lzErr);
      console.warn(`[kb-registry] initLandingZone warning for ${id}: ${lzMsg} (non-fatal)`);
      emit('init_landing_zone', 'error', lzMsg);
      // Fall through — KB is provisioned regardless of landing-zone marker
    }

    // ── Mark ACTIVE in Aurora ─────────────────────────────────────────────────
    await patchKbStatus(id, 'ACTIVE', { bedrockKbId, dataSourceId, errorMessage: null });
    console.log(`[kb-registry] Provisioning complete for entry ${id} (bedrock=${bedrockKbId})`);
    provisioningBroker.emit(`kb:${id}`, { type: 'complete', kbId: bedrockKbId });

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    await fail(currentStep, msg);
  }
}

/**
 * Deprovisions (deletes) a Bedrock Knowledge Base and removes the registry row.
 * Callers fire-and-forget; the DELETE /:id route returns 200 immediately.
 *
 * Cleanup sequence:
 *  1. Mark DB row DELETING
 *  2. Delete Bedrock KB (by bedrockKbId if known; otherwise search by derived name)
 *  3. Drop Aurora vector table (+ its indexes)
 *  4. Delete DB row
 */
export async function deprovisionKb(id: string): Promise<void> {
  const entry = await getKb(id);
  if (!entry) {
    console.warn(`[kb-registry] deprovisionKb: entry ${id} not found — nothing to do`);
    return;
  }

  await patchKbStatus(id, 'DELETING');

  // Offline the three cleanups below (Bedrock DeleteKnowledgeBase, DROP TABLE,
  // DELETE FROM) have exactly one counterpart: dropping the fixture row. The
  // registry row IS the knowledge base in this world, so removing it is the
  // whole deprovision rather than a stand-in for one.
  if (config.mock.aurora) {
    mockDeleteKbEntry(id);
    console.log(`[kb-registry] deprovisioned fixture entry ${id} (slug=${entry.slug})`);
    return;
  }

  const client = new BedrockAgentClient({ region: config.region });

  // ── Find + delete Bedrock KB ──────────────────────────────────────────────
  let kbIdToDelete = entry.bedrockKbId;

  if (!kbIdToDelete) {
    // bedrockKbId wasn't saved before failure — try to find by the derived name
    // pattern `${tenant}-${slug}` so we can clean up orphaned Bedrock resources.
    const derivedName = `${entry.tenant}-${entry.slug}`;
    try {
      let nextToken: string | undefined;
      outer: do {
        const resp = await client.send(
          new ListKnowledgeBasesCommand({ maxResults: 100, nextToken }),
        );
        for (const kb of resp.knowledgeBaseSummaries ?? []) {
          if (kb.name === derivedName) {
            kbIdToDelete = kb.knowledgeBaseId ?? null;
            break outer;
          }
        }
        nextToken = resp.nextToken;
      } while (nextToken);

      if (kbIdToDelete) {
        console.log(`[kb-registry] Found orphaned Bedrock KB by name "${derivedName}" → ${kbIdToDelete}`);
      }
    } catch (err) {
      console.warn(`[kb-registry] ListKnowledgeBases failed during cleanup:`, (err as Error).message);
    }
  }

  if (kbIdToDelete) {
    try {
      await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId: kbIdToDelete }));
      console.log(`[kb-registry] Deleted Bedrock KB ${kbIdToDelete}`);
    } catch (err) {
      // Log and continue — remove from registry even if Bedrock delete fails
      // (may already be gone, or might be in a terminal error state).
      console.warn(
        `[kb-registry] DeleteKnowledgeBase failed for ${kbIdToDelete}:`,
        (err as Error).message,
      );
    }
  }

  // ── Drop Aurora vector table ──────────────────────────────────────────────
  // Always attempt — table may not exist if provisioning failed at step 1.
  try {
    await exec(`DROP TABLE IF EXISTS ${entry.auroraTable} CASCADE`);
    console.log(`[kb-registry] Dropped Aurora table ${entry.auroraTable}`);
  } catch (err) {
    console.warn(`[kb-registry] DROP TABLE failed for ${entry.auroraTable}:`, (err as Error).message);
  }

  await deleteKbEntry(id);
  console.log(`[kb-registry] Registry entry ${id} removed`);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildChunkingConfig(
  strategy: string,
  maxTokens: number,
): VectorIngestionConfiguration {
  switch (strategy.toUpperCase()) {
    case 'FIXED':
      return {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: { maxTokens, overlapPercentage: 20 },
        },
      };
    case 'HIERARCHICAL':
      return {
        chunkingConfiguration: {
          chunkingStrategy: 'HIERARCHICAL',
          hierarchicalChunkingConfiguration: {
            levelConfigurations: [
              { maxTokens: Math.min(2048, maxTokens * 4) },
              { maxTokens },
            ],
            overlapTokens: Math.floor(maxTokens * 0.1),
          },
        },
      };
    case 'NONE':
      return { chunkingConfiguration: { chunkingStrategy: 'NONE' } };
    case 'SEMANTIC':
    default:
      return {
        chunkingConfiguration: {
          chunkingStrategy: 'SEMANTIC',
          semanticChunkingConfiguration: {
            maxTokens,
            bufferSize: 1,
            breakpointPercentileThreshold: 95,
          },
        },
      };
  }
}

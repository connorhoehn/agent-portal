// Knowledge-base registry fixture — backs providers/kb-registry.ts's reads
// under MOCK_AURORA.
//
// listKbs/getKb/getKbBySlug called `exec` (the raw RDS Data API caller) with
// no mock branch at all, so GET /api/admin/kb-registry/health — which calls
// listKbs() before ever reaching Bedrock — threw straight through
// asyncHandler into a 500 offline. The reconcile page (kb-reconcile.ts) is
// the "drift" demo highlight, so this fixture carries one deliberately
// drifted row (registry says ACTIVE, Bedrock has nothing by that id) to keep
// that story visible without ever making a real AWS call in mock mode: see
// the /health route's own config.mock.aurora branch, which reports this
// row's drift synthetically instead of calling Bedrock.
//
// `createdAt`/`updatedAt` used to be one `new Date().toISOString()` evaluated
// at module scope — the timestamp of the PROCESS START, shared by all three
// rows, which made a registry left running overnight claim every knowledge
// base was registered "yesterday at 4am" and made the three rows
// indistinguishable in a sort. They come from the clock inside the rows
// factory now, and each row carries its own age.
//
// ⚠️ `orgiq-default`'s s3Prefix ('orgiq/') is ASPIRATIONAL, not descriptive —
// see the field comment below. It names the target of
// scripts/migrate-s3-prefix.ts, which has not been run against this fixture
// world: mock/knowledge-base.ts's corpus (kbObjectRows) still sits at
// `synth/internal/...` and `uploads/...`, unprefixed, matching what the real
// bucket looks like today too (the deployed default KB's data source spans
// the whole bucket — see that script's own header). So a prefix-scoped S3
// query against `orgiq-default` in mock mode honestly returns zero. That is
// the correct behaviour for the pre-migration state this fixture represents,
// not a bug to paper over by inventing a prefix the corpus doesn't use.

import { randomUUID } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';
import type { KbRegistryEntry } from '../providers/kb-registry.js';

/** The seeded registry, including the deliberately drifted `orgiq-legacy` row. */
function seedRegistry(): KbRegistryEntry[] {
  return [
    {
      id: 'a0000001-0000-4000-8000-000000000001',
      bedrockKbId: 'KBMOCK0001AB',
      dataSourceId: 'DSMOCK0001AB',
      name: 'OrgIQ Knowledge Base',
      slug: 'orgiq-default',
      tenant: 'orgiq',
      purpose: 'default',
      description: 'Org docs, ADRs, postmortems, perf reviews — the OrgIQ fleet reads this one.',
      // Target prefix of scripts/migrate-s3-prefix.ts (`orgiq/uploads/` once
      // it runs), not where this fixture's own objects live today — see the
      // file header.
      s3Prefix: 'orgiq/',
      auroraTable: 'bedrock_kb_orgiq_default',
      embeddingModel: 'amazon.titan-embed-text-v2:0',
      chunkingStrategy: 'SEMANTIC',
      maxTokens: 512,
      status: 'ACTIVE',
      errorMessage: null,
      kbServiceRoleArn: null,
      createdAt: clock.daysAgo(90),
      updatedAt: clock.daysAgo(3),
    },
    {
      id: 'a0000002-0000-4000-8000-000000000002',
      bedrockKbId: 'KBMOCK0002CD',
      dataSourceId: 'DSMOCK0002CD',
      name: 'OrgIQ Onboarding Docs',
      slug: 'orgiq-onboarding',
      tenant: 'orgiq',
      purpose: 'onboarding',
      description: 'New-hire runbooks and team primers — a secondary orgiq KB alongside the default.',
      s3Prefix: 'orgiq-onboarding/',
      auroraTable: 'bedrock_kb_orgiq_onboarding',
      embeddingModel: 'amazon.titan-embed-text-v2:0',
      chunkingStrategy: 'SEMANTIC',
      maxTokens: 512,
      status: 'ACTIVE',
      errorMessage: null,
      kbServiceRoleArn: null,
      createdAt: clock.daysAgo(42),
      updatedAt: clock.daysAgo(1),
    },
    {
      id: 'a0000003-0000-4000-8000-000000000003',
      bedrockKbId: 'KBMOCK-GONE',
      dataSourceId: null,
      name: 'OrgIQ Legacy Docs',
      slug: 'orgiq-legacy',
      tenant: 'orgiq',
      purpose: 'legacy',
      description: 'Deprecated — superseded by orgiq-default. Left registered to demo drift detection.',
      s3Prefix: 'orgiq-legacy/',
      auroraTable: 'bedrock_kb_orgiq_legacy',
      embeddingModel: 'amazon.titan-embed-text-v2:0',
      chunkingStrategy: 'FIXED_SIZE',
      maxTokens: 300,
      status: 'ACTIVE',
      errorMessage: null,
      kbServiceRoleArn: null,
      createdAt: clock.daysAgo(210),
      updatedAt: clock.daysAgo(150),
    },
  ];
}

/**
 * The registry.
 *
 * `empty` — no knowledge base has been registered. `/admin/knowledge` has to
 *           offer registration rather than render an empty table that looks
 *           like a failed query, and the KB picker on every agent surface has
 *           to say why it has nothing to pick.
 * `error` — the reconcile pass found the registry unusable: rows in FAILED
 *           with the message that put them there. This is the state the health
 *           route's error styling and the "repoint" remediation are written
 *           for, and it was previously only reachable by breaking a real KB.
 */
export const kbRegistry = defineFixture<KbRegistryEntry>({
  key: 'kb-registry',
  scenarios: {
    default: seedRegistry,
    empty: () => [],
    error: () =>
      seedRegistry().map((row) => ({
        ...row,
        status: 'FAILED' as const,
        errorMessage:
          'Bedrock GetKnowledgeBase: ResourceNotFoundException — the knowledge base this row names no longer exists',
        updatedAt: clock.hoursAgo(1, { keepWithinToday: true }),
      })),
  },
});

/** Live view — see mock/live.ts. Consumers keep reading it as an array. */
export const mockKbRegistry: KbRegistryEntry[] = liveRows(kbRegistry);

// ─── Writes ──────────────────────────────────────────────────────────────────
//
// `createKbEntry`, `updateKbEntry`, `deleteKbEntry` and `patchKbStatus` all
// called `exec` unconditionally, so registering, renaming or deprovisioning a
// knowledge base offline 500'd on the RDS Data API — while every read on the
// same page was served from the rows above. These four move the same rows the
// reads serve, which is what makes `POST /api/__mock/reset` an undo.

/**
 * A registry id in the shape `getKb`'s UUID guard accepts.
 *
 * `getKb` refuses anything that is not a UUID before it looks, so a
 * fixture-minted id has to be one or the row would be created and then be
 * unreadable by the very next GET. `randomUUID` is not a clock read — it is an
 * identity, and contract.ts rule 3 is about timestamps.
 */
function newKbId(): string {
  return randomUUID();
}

export interface MockCreateKbInput {
  name: string;
  slug: string;
  tenant: string;
  purpose: string;
  description: string | null;
  s3Prefix: string;
  auroraTable: string;
  chunkingStrategy: string;
  maxTokens: number;
  kbServiceRoleArn: string | null;
}

/**
 * Insert a row exactly as the INSERT does: status CREATING, no Bedrock ids
 * yet, `created_at`/`updated_at` at NOW(). The caller (`provisionKb`) is what
 * moves it to ACTIVE, offline as online.
 */
export function mockCreateKbEntry(input: MockCreateKbInput): KbRegistryEntry {
  const row: KbRegistryEntry = {
    id: newKbId(),
    bedrockKbId: null,
    dataSourceId: null,
    name: input.name,
    slug: input.slug,
    tenant: input.tenant,
    purpose: input.purpose,
    description: input.description,
    s3Prefix: input.s3Prefix,
    auroraTable: input.auroraTable,
    // The INSERT hard-codes this one; the fixture must not drift from it.
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    chunkingStrategy: input.chunkingStrategy,
    maxTokens: input.maxTokens,
    status: 'CREATING',
    errorMessage: null,
    kbServiceRoleArn: input.kbServiceRoleArn,
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  };
  kbRegistry.rows().push(row);
  return row;
}

/** The columns any of the four write paths can move. */
export type MockKbPatch = Partial<
  Pick<KbRegistryEntry, 'name' | 'description' | 'status' | 'bedrockKbId' | 'dataSourceId' | 'errorMessage'>
>;

/**
 * Patch one row in place, stamping `updatedAt` the way the table's own trigger
 * does. A miss is a no-op, matching `UPDATE … WHERE id = :id` over zero rows.
 */
export function mockPatchKb(id: string, patch: MockKbPatch): KbRegistryEntry | null {
  const row = kbRegistry.rows().find((k) => k.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  row.updatedAt = clock.nowIso();
  return row;
}

/** Hard-delete, as `DELETE FROM knowledge_bases`. Returns whether a row went. */
export function mockDeleteKbEntry(id: string): boolean {
  const rows = kbRegistry.rows();
  const i = rows.findIndex((k) => k.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  return true;
}

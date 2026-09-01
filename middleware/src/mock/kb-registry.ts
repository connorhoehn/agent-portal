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

import type { KbRegistryEntry } from '../providers/kb-registry.js';

const now = new Date().toISOString();

export const mockKbRegistry: KbRegistryEntry[] = [
  {
    id: 'a0000001-0000-4000-8000-000000000001',
    bedrockKbId: 'KBMOCK0001AB',
    dataSourceId: 'DSMOCK0001AB',
    name: 'OrgIQ Knowledge Base',
    slug: 'orgiq-default',
    tenant: 'orgiq',
    purpose: 'default',
    description: 'Org docs, ADRs, postmortems, perf reviews — the OrgIQ fleet reads this one.',
    s3Prefix: 'orgiq/',
    auroraTable: 'bedrock_kb_orgiq_default',
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 512,
    status: 'ACTIVE',
    errorMessage: null,
    kbServiceRoleArn: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'a0000002-0000-4000-8000-000000000002',
    bedrockKbId: 'KBMOCK0002CD',
    dataSourceId: 'DSMOCK0002CD',
    name: 'Newsroom Knowledge Base',
    slug: 'newsroom-default',
    tenant: 'newsroom',
    purpose: 'default',
    description: 'Published articles + story clusters — the news-* agents read this one.',
    s3Prefix: 'newsroom/',
    auroraTable: 'bedrock_kb_newsroom_default',
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 512,
    status: 'ACTIVE',
    errorMessage: null,
    kbServiceRoleArn: null,
    createdAt: now,
    updatedAt: now,
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
    createdAt: now,
    updatedAt: now,
  },
];

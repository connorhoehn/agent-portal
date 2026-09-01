// Shapes the KB registry screens read. Kept out of the page files so the
// registry list, the detail view, KBCreateWizard and KBPipelineChain can all
// name the same row without importing a page component to get at its type.

export type KbStatus =
  | 'ACTIVE'
  | 'CREATING'
  | 'PENDING'
  | 'FAILED'
  | 'UPDATING'
  | 'DELETING';

export type KbTenant = 'orgiq' | 'newsroom';

export interface KbRegistryEntry {
  id: string;
  bedrockKbId: string | null;
  dataSourceId: string | null;
  name: string;
  slug: string;
  tenant: KbTenant;
  purpose: string;
  description: string;
  s3Prefix: string;
  auroraTable: string;
  embeddingModel: string;
  chunkingStrategy: string;
  maxTokens: number;
  status: KbStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  // Enriched at list time:
  docCount?: number;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
}

/** `GET /api/admin/kb-registry` */
export interface KbListResponse {
  kbs: KbRegistryEntry[];
}

/** `GET /api/admin/kb-registry/:id` */
export interface KbDetailResponse {
  kb: KbRegistryEntry;
}

export interface KbDocument {
  id: string;
  title: string | null;
  source: string | null;
  ingestedAt: string | null;
}

/** `GET /api/admin/kb-registry/:id/docs` */
export interface KbDocsResponse {
  documents: KbDocument[];
  total: number;
}

export interface KbIngestionJob {
  jobId: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  description: string;
  documentsIndexed: number;
  documentsFailed: number;
}

/** `GET /api/admin/kb-registry/:id/jobs` */
export interface KbJobsResponse {
  jobs: KbIngestionJob[];
}

/** The registry list's tenant filter. `all` is not a tenant — it is "no filter". */
export type TenantFilter = 'all' | KbTenant;

/** Which concern the detail view is showing. */
export type KbTabId = 'landing-zone' | 'documents' | 'ingestion-jobs' | 'configuration';

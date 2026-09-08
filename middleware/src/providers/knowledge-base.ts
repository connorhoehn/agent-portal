// Bedrock Knowledge Base provider — wraps the @aws-sdk/client-bedrock-agent
// control-plane API for the /ingest page. The agents stack already provisioned
// a Knowledge Base + KMS keys + data source via CDK (orgiq-knowledge-base).
//
// What this exposes:
//   - getKb()                       → KB metadata (id, embedding model, status)
//   - listDataSources()             → S3 ingestion targets bound to the KB
//   - listIngestionJobs(dsId?)      → recent sync runs
//   - startIngestionJob(dsId, desc, kbId?) → trigger a fresh sync

import {
  BedrockAgentClient,
  GetKnowledgeBaseCommand,
  ListDataSourcesCommand,
  GetDataSourceCommand,
  ListIngestionJobsCommand,
  GetIngestionJobCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { extname, basename } from 'node:path';
import { config } from '../config.js';
import type { StorageBreakdown } from '../lib/crawler-types.js';
import { exec } from './aurora.js';
import { clock, groupBy, sumBy } from '../mock/core/index.js';
import {
  MOCK_DOCUMENTS_BUCKET,
  kbDataSourceRows,
  kbDocumentRows,
  kbIngestionJobRows,
  kbObjectRows,
  kbSummaryRows,
  type KbObjectRow,
} from '../mock/knowledge-base.js';

// ─── Knowledge-Base Management Surface types ──────────────────────────────────
// Used by the /knowledge-base route and the KnowledgeBasePage portal surface.

export interface IngestedDoc {
  id: string;
  source: string | null;
  sourceUri: string | null;
  title: string | null;
  ingestedAt: string | null;
}

export interface DataSource {
  id: string;
  name: string;
  status: string;
  lastSyncedAt: string | null;
  lastJobStatus: string | null;
}

// List documents from Aurora `documents` table, newest first.
// Defensive: returns [] if the table doesn't exist yet.
export async function listIngestedDocs(opts: { limit?: number; since?: string } = {}): Promise<IngestedDoc[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  if (mockDocs()) {
    // Mirrors the SQL below: `ingested_at > :since`, newest first, NULLS LAST.
    return kbDocumentRows
      .rows()
      .filter((d) => !opts.since || (d.ingestedAt != null && d.ingestedAt > opts.since!))
      .slice()
      .sort((a, b) => (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? ''))
      .slice(0, limit);
  }
  const sincePart = opts.since ? 'AND ingested_at > :since' : '';
  const sql = `
    SELECT id::text, source, source_uri, title, ingested_at::text
      FROM documents
     WHERE 1=1 ${sincePart}
     ORDER BY ingested_at DESC NULLS LAST
     LIMIT :lim`;
  const params: import('@aws-sdk/client-rds-data').SqlParameter[] = [
    { name: 'lim', value: { longValue: limit } },
  ];
  if (opts.since) params.push({ name: 'since', value: { stringValue: opts.since } });
  try {
    const rows = await exec(sql, params);
    return rows.map(r => ({
      id: String(r['id'] ?? ''),
      source: r['source'] == null ? null : String(r['source']),
      sourceUri: r['source_uri'] == null ? null : String(r['source_uri']),
      title: r['title'] == null ? null : String(r['title']),
      ingestedAt: r['ingested_at'] == null ? null : String(r['ingested_at']),
    }));
  } catch (err) {
    console.warn('[kb] listIngestedDocs failed:', (err as Error).message);
    return [];
  }
}

// List data sources with their latest ingestion job status.
// Returns [] when kbId is empty.
export async function listDataSourcesWithStatus(kbId: string): Promise<DataSource[]> {
  if (mockAws()) {
    // The KB id is unset offline, so gate on the mock flag before the guard
    // below — otherwise /api/knowledge-base/data-sources answers `[]` forever.
    return kbDataSourceRows.rows().map((s) => {
      const latest = mockListIngestionJobs(s.id, 1)[0];
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        lastSyncedAt: latest?.updatedAt ?? null,
        lastJobStatus: latest?.status ?? null,
      };
    });
  }
  if (!kbId) return [];
  try {
    const client = new BedrockAgentClient({ region: config.region });
    const listResp = await client.send(new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 50 }));
    const summaries = listResp.dataSourceSummaries ?? [];
    const results: DataSource[] = [];
    for (const s of summaries) {
      const dsId = s.dataSourceId;
      if (!dsId) continue;
      let lastSyncedAt: string | null = null;
      let lastJobStatus: string | null = null;
      try {
        const jobResp = await client.send(
          new ListIngestionJobsCommand({
            knowledgeBaseId: kbId,
            dataSourceId: dsId,
            maxResults: 1,
            sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
          }),
        );
        const latestJob = (jobResp.ingestionJobSummaries ?? [])[0];
        if (latestJob) {
          lastJobStatus = String(latestJob.status ?? '');
          lastSyncedAt = latestJob.updatedAt instanceof Date ? latestJob.updatedAt.toISOString() : null;
        }
      } catch {
        // best-effort
      }
      results.push({
        id: dsId,
        name: s.name ?? dsId,
        status: String(s.status ?? 'UNKNOWN'),
        lastSyncedAt,
        lastJobStatus,
      });
    }
    return results;
  } catch (err) {
    console.warn('[kb] listDataSourcesWithStatus failed:', (err as Error).message);
    return [];
  }
}

// Trigger an ingestion job. Throws on error so the route can return 500.
export async function startSync(kbId: string, dataSourceId: string): Promise<{ jobId: string }> {
  if (mockAws()) {
    return { jobId: mockStartJob(dataSourceId, 'Manual sync from portal').jobId };
  }
  if (!kbId) throw new Error('KNOWLEDGE_BASE_ID not configured');
  const client = new BedrockAgentClient({ region: config.region });
  const resp = await client.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: kbId,
      dataSourceId,
      description: `Manual sync from portal at ${new Date().toISOString()}`,
    }),
  );
  const jobId = resp.ingestionJob?.ingestionJobId;
  if (!jobId) throw new Error('StartIngestionJob returned no jobId');
  return { jobId };
}

export interface KbSummary {
  id: string;
  name: string;
  status: string;
  description: string;
  embeddingModelArn: string;
  embeddingModel: string;          // human-friendly tail of the ARN
  vectorStore: string;             // openSearch | aurora | ...
  updatedAt: string;
}

export interface DataSourceSummary {
  id: string;
  name: string;
  status: string;
  description: string;
  type: string;                    // S3 | WEB | CONFLUENCE | ...
  sourceUri: string;               // e.g. "s3://orgiq-documents-..."
  updatedAt: string;
}

export interface IngestionJobSummary {
  jobId: string;
  dataSourceId: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  description: string;
  durationMs: number;
  documentsScanned: number;
  documentsIndexed: number;
  documentsFailed: number;
  documentsDeleted: number;
  failureReasons: string[];
}

// ─── Mock path ───────────────────────────────────────────────────────────────
//
// Every AWS call in this file swallows its own failure and returns `[]`/`null`,
// so offline the whole ingestion surface rendered as a populated shape with
// nothing in it — indistinguishable from a feature that was never built. These
// helpers answer from src/mock/knowledge-base.ts instead.
//
// Nothing here stores a total. A job's statistics are counted from the document
// rows that existed when it finished, storage totals are summed from the object
// rows, and "pending since last sync" is a filter over those same objects — so
// a tile and the list under it cannot drift apart.

/** Aurora holds `documents`; Bedrock and S3 hold everything else in this file. */
const mockDocs = (): boolean => config.mock.aurora;
const mockAws = (): boolean => config.mock.agentcore;

function mockBucket(): string {
  return config.foundation.documentsBucket || MOCK_DOCUMENTS_BUCKET;
}

/**
 * A job's statistics, counted rather than stored.
 *
 * A Bedrock S3 sync scans the whole data source every run, so `scanned` is the
 * corpus as of the moment the job settled and a COMPLETE run indexes all of it.
 * `documentsFailed` is the number of failures the job actually names — a job
 * cannot report a failure count it has no reason for.
 */
function mockJobSummary(job: {
  jobId: string; dataSourceId: string; status: string;
  startedAt: string; finishedAt: string | null; description: string; failureReasons: string[];
}): IngestionJobSummary {
  const updatedAt = job.finishedAt ?? clock.nowIso();
  const startMs = Date.parse(job.startedAt);
  const endMs = Date.parse(updatedAt);
  const settled = job.status === 'COMPLETE' || job.status === 'FAILED';
  const corpus = settled
    ? kbDocumentRows.rows().filter((d) => {
        const ms = Date.parse(String(d.ingestedAt ?? ''));
        return Number.isFinite(ms) && ms <= endMs;
      })
    : [];
  return {
    jobId: job.jobId,
    dataSourceId: job.dataSourceId,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt,
    description: job.description,
    durationMs: Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0,
    documentsScanned: corpus.length,
    documentsIndexed: job.status === 'COMPLETE' ? corpus.length : 0,
    documentsFailed: job.failureReasons.length,
    documentsDeleted: 0,
    failureReasons: job.failureReasons,
  };
}

function mockListIngestionJobs(dataSourceId: string | undefined, limit: number): IngestionJobSummary[] {
  return kbIngestionJobRows
    .rows()
    .filter((j) => !dataSourceId || j.dataSourceId === dataSourceId)
    .map(mockJobSummary)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

/**
 * Start a job in the mock world. `rows()` hands back the live array, so the
 * new job shows up in the next GET — a demo "Sync now" that leaves the job
 * list unchanged reads as a broken button. `resetAll()` takes it away again.
 */
let mockJobSeq = 100;
function mockStartJob(dataSourceId: string, description: string): IngestionJobSummary {
  const row = {
    jobId: `IJMOCK${String(++mockJobSeq).padStart(4, '0')}`,
    dataSourceId,
    status: 'STARTING',
    startedAt: clock.nowIso(),
    finishedAt: null,
    description,
    failureReasons: [] as string[],
  };
  kbIngestionJobRows.rows().unshift(row);
  return mockJobSummary(row);
}

/** ListObjectsV2 over the mock bucket. */
function mockObjects(): KbObjectRow[] {
  return kbObjectRows.rows();
}

function extensionOf(key: string): string {
  return extname(key).toLowerCase() || '(none)';
}

function topPrefixOf(key: string): string {
  return key.split('/')[0] || '(root)';
}

const _client = (): BedrockAgentClient =>
  new BedrockAgentClient({ region: config.region });

/**
 * Why the knowledge base could not be read. `getKb()` collapses every failure
 * into null, which made the Ingest page tell operators to "set KB_ID" when
 * KB_ID was set correctly and the knowledge base had been deleted upstream —
 * sending them to fix config that was already right.
 */
export interface KbLookup {
  kb: KbSummary | null;
  /** 'ok' | 'unconfigured' | 'missing' | 'error' */
  state: 'ok' | 'unconfigured' | 'missing' | 'error';
  kbId: string | null;
  problem: string | null;
}

export async function lookupKb(): Promise<KbLookup> {
  const kbId = config.knowledgeBase.id;
  if (mockAws()) {
    const kb = kbSummaryRows.rows()[0] ?? null;
    // The `empty` scenario is a knowledge base that was deleted upstream, not
    // one that was never configured — the two need different operator action,
    // which is the distinction this function exists to draw.
    return kb
      ? { kb, state: 'ok', kbId: kb.id, problem: null }
      : { kb: null, state: 'missing', kbId: kbId || 'KBMOCK0001AB',
          problem: `knowledge base ${kbId || 'KBMOCK0001AB'} does not exist in AWS — it was deleted upstream; redeploy OrgIQ-KnowledgeBase and refresh middleware/.env.aws` };
  }
  if (!kbId) {
    return {
      kb: null, state: 'unconfigured', kbId: null,
      problem: 'KNOWLEDGE_BASE_ID is not set — run schema/dump-stack-outputs.sh after deploying OrgIQ-KnowledgeBase',
    };
  }
  const kb = await getKb();
  if (kb) return { kb, state: 'ok', kbId, problem: null };

  // getKb swallowed the error; re-probe to classify it.
  try {
    await _client().send(new GetKnowledgeBaseCommand({ knowledgeBaseId: kbId }));
    return { kb: null, state: 'error', kbId, problem: 'knowledge base returned no payload' };
  } catch (err) {
    const name = (err as { name?: string }).name ?? 'UnknownError';
    return name === 'ResourceNotFoundException'
      ? { kb: null, state: 'missing', kbId,
          problem: `knowledge base ${kbId} does not exist in AWS — it was deleted upstream; redeploy OrgIQ-KnowledgeBase and refresh middleware/.env.aws` }
      : { kb: null, state: 'error', kbId, problem: `knowledge base lookup failed (${name})` };
  }
}

export async function getKb(): Promise<KbSummary | null> {
  const kbId = config.knowledgeBase.id;
  if (mockAws()) return kbSummaryRows.rows()[0] ?? null;
  if (!kbId) return null;
  try {
    const resp = await _client().send(new GetKnowledgeBaseCommand({ knowledgeBaseId: kbId }));
    const kb = resp.knowledgeBase;
    if (!kb) return null;
    const embArn =
      kb.knowledgeBaseConfiguration?.vectorKnowledgeBaseConfiguration?.embeddingModelArn ?? '';
    const vectorStore = kb.storageConfiguration?.type ?? '';
    return {
      id: kb.knowledgeBaseId ?? kbId,
      name: kb.name ?? 'orgiq-knowledge-base',
      status: String(kb.status ?? 'UNKNOWN'),
      description: kb.description ?? '',
      embeddingModelArn: embArn,
      embeddingModel: embArn.split('/').pop() ?? embArn,
      vectorStore: vectorStore,
      updatedAt: (kb.updatedAt instanceof Date ? kb.updatedAt : new Date()).toISOString(),
    };
  } catch (err) {
    console.warn('[kb] getKb failed:', (err as Error).message);
    return null;
  }
}

export async function listDataSources(): Promise<DataSourceSummary[]> {
  const kbId = config.knowledgeBase.id;
  if (mockAws()) return kbDataSourceRows.rows().slice();
  if (!kbId) return [];
  try {
    const list = await _client().send(new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 50 }));
    const ids = (list.dataSourceSummaries ?? []).map(s => s.dataSourceId).filter((x): x is string => Boolean(x));
    // Fetch detail per ID for source URI + config.
    const details = await Promise.all(
      ids.map(id =>
        _client()
          .send(new GetDataSourceCommand({ knowledgeBaseId: kbId, dataSourceId: id }))
          .catch(() => null),
      ),
    );
    return details
      .filter((d): d is NonNullable<typeof d> => Boolean(d?.dataSource))
      .map(d => {
        const ds = d.dataSource!;
        const s3 = ds.dataSourceConfiguration?.s3Configuration;
        const type = ds.dataSourceConfiguration?.type ?? 'UNKNOWN';
        const sourceUri = s3?.bucketArn ? `s3://${s3.bucketArn.replace('arn:aws:s3:::', '')}${s3.inclusionPrefixes?.[0] ? '/' + s3.inclusionPrefixes[0] : ''}` : '';
        return {
          id: ds.dataSourceId ?? '',
          name: ds.name ?? '',
          status: String(ds.status ?? ''),
          description: ds.description ?? '',
          type: String(type),
          sourceUri,
          updatedAt: (ds.updatedAt instanceof Date ? ds.updatedAt : new Date()).toISOString(),
        };
      });
  } catch (err) {
    console.warn('[kb] listDataSources failed:', (err as Error).message);
    return [];
  }
}

export async function listIngestionJobs(dataSourceId?: string, limit = 20): Promise<IngestionJobSummary[]> {
  const kbId = config.knowledgeBase.id;
  if (mockAws()) return mockListIngestionJobs(dataSourceId, limit);
  if (!kbId) return [];
  try {
    // If no dsId specified, fan out across all data sources.
    let dsIds: string[];
    if (dataSourceId) {
      dsIds = [dataSourceId];
    } else {
      const dsList = await _client().send(new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 50 }));
      dsIds = (dsList.dataSourceSummaries ?? []).map(s => s.dataSourceId).filter((x): x is string => Boolean(x));
    }

    const all: IngestionJobSummary[] = [];
    for (const dsId of dsIds) {
      const resp = await _client().send(
        new ListIngestionJobsCommand({
          knowledgeBaseId: kbId,
          dataSourceId: dsId,
          maxResults: limit,
          sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
        }),
      );
      for (const j of resp.ingestionJobSummaries ?? []) {
        const stats = j.statistics ?? {};
        const startMs = j.startedAt instanceof Date ? j.startedAt.getTime() : 0;
        const endMs = j.updatedAt instanceof Date ? j.updatedAt.getTime() : Date.now();
        all.push({
          jobId: j.ingestionJobId ?? '',
          dataSourceId: dsId,
          status: String(j.status ?? ''),
          startedAt: j.startedAt instanceof Date ? j.startedAt.toISOString() : new Date().toISOString(),
          updatedAt: j.updatedAt instanceof Date ? j.updatedAt.toISOString() : new Date().toISOString(),
          description: j.description ?? '',
          durationMs: startMs > 0 ? Math.max(0, endMs - startMs) : 0,
          documentsScanned: Number((stats as any).numberOfDocumentsScanned ?? 0),
          documentsIndexed: Number((stats as any).numberOfNewDocumentsIndexed ?? 0) + Number((stats as any).numberOfModifiedDocumentsIndexed ?? 0),
          documentsFailed: Number((stats as any).numberOfDocumentsFailed ?? 0),
          documentsDeleted: Number((stats as any).numberOfDocumentsDeleted ?? 0),
          failureReasons: [],
        });
      }
    }
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  } catch (err) {
    console.warn('[kb] listIngestionJobs failed:', (err as Error).message);
    return [];
  }
}

/**
 * Trigger an ingestion job.
 *
 * `kbId` overrides `config.knowledgeBase.id` — the configured KB is the
 * default, not the only possibility. Without the override this function read
 * the configured id unconditionally, so a caller that had already resolved a
 * *second* knowledge base out of the `knowledge_bases` registry could pass
 * that KB's data source id and still sync the first KB. StartIngestionJob
 * pairs (knowledgeBaseId, dataSourceId); passing a mismatched pair is either a
 * ValidationException or, worse, a successful sync of the wrong corpus.
 *
 * The returned `knowledgeBaseId`/`dataSourceId` are the pair the job actually
 * ran against, so a caller never has to infer them from what it hoped it
 * passed — and `/ingest/stream` needs the data source id to poll the job.
 */
export async function startIngestionJob(
  dataSourceId: string,
  description?: string,
  kbId?: string,
): Promise<{ jobId: string; status: string; knowledgeBaseId: string; dataSourceId: string } | null> {
  const targetKbId = kbId || config.knowledgeBase.id;
  if (mockAws()) {
    const job = mockStartJob(dataSourceId, description ?? 'Manual sync triggered from portal');
    return { jobId: job.jobId, status: job.status, knowledgeBaseId: targetKbId, dataSourceId };
  }
  if (!targetKbId) return null;
  try {
    const resp = await _client().send(
      new StartIngestionJobCommand({
        knowledgeBaseId: targetKbId,
        dataSourceId,
        description: description ?? `Manual sync triggered from portal at ${new Date().toISOString()}`,
      }),
    );
    return {
      jobId: resp.ingestionJob?.ingestionJobId ?? '',
      status: String(resp.ingestionJob?.status ?? 'UNKNOWN'),
      knowledgeBaseId: targetKbId,
      dataSourceId,
    };
  } catch (err) {
    console.warn('[kb] startIngestionJob failed:', (err as Error).message);
    return null;
  }
}

export async function getIngestionJob(jobId: string, dataSourceId: string): Promise<IngestionJobSummary | null> {
  const kbId = config.knowledgeBase.id;
  if (mockAws()) {
    const row = kbIngestionJobRows.rows().find((j) => j.jobId === jobId && j.dataSourceId === dataSourceId);
    return row ? mockJobSummary(row) : null;
  }
  if (!kbId) return null;
  try {
    const resp = await _client().send(
      new GetIngestionJobCommand({ knowledgeBaseId: kbId, dataSourceId, ingestionJobId: jobId }),
    );
    const j = resp.ingestionJob;
    if (!j) return null;
    const stats = j.statistics ?? {};
    const startMs = j.startedAt instanceof Date ? j.startedAt.getTime() : 0;
    const endMs = j.updatedAt instanceof Date ? j.updatedAt.getTime() : Date.now();
    return {
      jobId: j.ingestionJobId ?? jobId,
      dataSourceId,
      status: String(j.status ?? ''),
      startedAt: j.startedAt instanceof Date ? j.startedAt.toISOString() : new Date().toISOString(),
      updatedAt: j.updatedAt instanceof Date ? j.updatedAt.toISOString() : new Date().toISOString(),
      description: j.description ?? '',
      durationMs: startMs > 0 ? Math.max(0, endMs - startMs) : 0,
      documentsScanned: Number((stats as any).numberOfDocumentsScanned ?? 0),
      documentsIndexed: Number((stats as any).numberOfNewDocumentsIndexed ?? 0) + Number((stats as any).numberOfModifiedDocumentsIndexed ?? 0),
      documentsFailed: Number((stats as any).numberOfDocumentsFailed ?? 0),
      documentsDeleted: Number((stats as any).numberOfDocumentsDeleted ?? 0),
      failureReasons: j.failureReasons ?? [],
    };
  } catch (err) {
    console.warn('[kb] getIngestionJob failed:', (err as Error).message);
    return null;
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResult {
  key: string;
  bucket: string;
  size: number;
  contentType: string;
  url: string;
}

export async function uploadDocument(
  filename: string,
  body: Buffer,
  contentType: string,
  prefix = 'uploads',
): Promise<UploadResult> {
  const bucket = mockAws() ? mockBucket() : config.foundation.documentsBucket;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');
  const date = new Date().toISOString().slice(0, 10);
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}/${date}/${safe}`;
  if (mockAws()) {
    // The object joins the live rows, so the upload shows up in the storage
    // breakdown and in "pending since last sync" on the very next read.
    kbObjectRows.rows().push({ key, sizeBytes: body.length, lastModified: clock.nowIso() });
    return { key, bucket, size: body.length, contentType, url: `s3://${bucket}/${key}` };
  }
  const s3 = new S3Client({ region: config.region });
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: { 'uploaded-at': new Date().toISOString(), 'original-name': filename.slice(0, 512) },
  }));
  return { key, bucket, size: body.length, contentType, url: `s3://${bucket}/${key}` };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface IngestStats {
  s3: {
    bucket: string;
    total: number;
    totalSizeBytes: number;
    byExtension: Record<string, { count: number; sizeBytes: number }>;
    byPrefix: Record<string, number>;
    newestKey: string | null;
    newestAt: string | null;
  };
  kb: KbSummary | null;
  recentJobs: IngestionJobSummary[];
  lastSync: { completedAt: string | null; documentsIndexed: number; documentsFailed: number };
}

export async function getIngestStats(): Promise<IngestStats> {
  if (mockAws()) {
    const objects = mockObjects();
    const byExtension: IngestStats['s3']['byExtension'] = {};
    for (const [ext, rows] of groupBy(objects, (o) => extensionOf(o.key))) {
      byExtension[ext] = { count: rows.length, sizeBytes: sumBy(rows, 'sizeBytes') };
    }
    const byPrefix: Record<string, number> = {};
    for (const [prefix, rows] of groupBy(objects, (o) => topPrefixOf(o.key))) {
      byPrefix[prefix] = rows.length;
    }
    const newest = objects.reduce<KbObjectRow | null>(
      (best, o) => (best === null || o.lastModified > best.lastModified ? o : best), null);
    const [kb, recentJobs] = await Promise.all([getKb(), listIngestionJobs(undefined, 5)]);
    const lastComplete = recentJobs.find(j => j.status === 'COMPLETE');
    return {
      s3: {
        bucket: mockBucket(),
        total: objects.length,
        totalSizeBytes: sumBy(objects, 'sizeBytes'),
        byExtension,
        byPrefix,
        newestKey: newest?.key ?? null,
        newestAt: newest?.lastModified ?? null,
      },
      kb,
      recentJobs,
      lastSync: {
        completedAt: lastComplete?.updatedAt ?? null,
        documentsIndexed: lastComplete?.documentsIndexed ?? 0,
        documentsFailed: lastComplete?.documentsFailed ?? 0,
      },
    };
  }
  const bucket = config.foundation.documentsBucket;
  const s3Stats: IngestStats['s3'] = {
    bucket: bucket ?? '',
    total: 0,
    totalSizeBytes: 0,
    byExtension: {},
    byPrefix: {},
    newestKey: null,
    newestAt: null,
  };

  if (bucket) {
    try {
      const s3 = new S3Client({ region: config.region });
      let token: string | undefined;
      let newestTime = 0;
      do {
        const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: token }));
        for (const obj of resp.Contents ?? []) {
          const size = obj.Size ?? 0;
          s3Stats.total++;
          s3Stats.totalSizeBytes += size;
          // extension bucket
          const ext = extname(obj.Key ?? '').toLowerCase() || '(none)';
          const cur = s3Stats.byExtension[ext] ?? { count: 0, sizeBytes: 0 };
          s3Stats.byExtension[ext] = { count: cur.count + 1, sizeBytes: cur.sizeBytes + size };
          // top-level prefix bucket
          const topPrefix = (obj.Key ?? '').split('/')[0] ?? '(root)';
          s3Stats.byPrefix[topPrefix] = (s3Stats.byPrefix[topPrefix] ?? 0) + 1;
          // newest
          const ms = obj.LastModified?.getTime() ?? 0;
          if (ms > newestTime) { newestTime = ms; s3Stats.newestKey = obj.Key ?? null; s3Stats.newestAt = obj.LastModified?.toISOString() ?? null; }
        }
        token = resp.NextContinuationToken;
      } while (token && s3Stats.total < 5000);
    } catch (err) {
      console.warn('[kb] getIngestStats s3 scan failed:', (err as Error).message);
    }
  }

  const [kb, recentJobs] = await Promise.all([getKb(), listIngestionJobs(undefined, 5)]);
  const lastComplete = recentJobs.find(j => j.status === 'COMPLETE');
  return {
    s3: s3Stats,
    kb,
    recentJobs,
    lastSync: {
      completedAt: lastComplete?.updatedAt ?? null,
      documentsIndexed: lastComplete?.documentsIndexed ?? 0,
      documentsFailed: lastComplete?.documentsFailed ?? 0,
    },
  };
}

// ─── Queue ────────────────────────────────────────────────────────────────────

export interface S3QueueSummary {
  total: number;
  pendingSinceLastSync: number;
  lastModified: string | null;
  bucket: string;
}

/**
 * Count what is sitting in the documents bucket, optionally scoped to one
 * knowledge base's `s3_prefix`.
 *
 * The prefix is the only thing that separates one registered KB's corpus from
 * another's inside a shared bucket, so a per-KB queue count that ignores it is
 * just the whole-bucket count wearing a KB's name.
 */
export async function countS3Documents(lastSyncAt?: string, s3Prefix?: string): Promise<S3QueueSummary> {
  const prefix = s3Prefix?.trim() || undefined;
  if (mockAws()) {
    const objects = prefix ? mockObjects().filter((o) => o.key.startsWith(prefix)) : mockObjects();
    const cutoffMs = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
    const newest = objects.reduce<string | null>(
      (best, o) => (best === null || o.lastModified > best ? o.lastModified : best), null);
    return {
      total: objects.length,
      // No cutoff means nothing has been synced, so everything is pending —
      // the same rule the real scan applies below.
      pendingSinceLastSync: Number.isFinite(cutoffMs)
        ? objects.filter((o) => Date.parse(o.lastModified) > cutoffMs).length
        : objects.length,
      lastModified: newest,
      bucket: mockBucket(),
    };
  }
  const bucket = config.foundation.documentsBucket;
  if (!bucket) return { total: 0, pendingSinceLastSync: 0, lastModified: null, bucket: '' };
  const syncCutoff = lastSyncAt ? new Date(lastSyncAt) : null;
  try {
    const s3 = new S3Client({ region: config.region });
    let total = 0;
    let pending = 0;
    let lastModified: Date | null = null;
    let continuationToken: string | undefined;
    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
          ...(prefix ? { Prefix: prefix } : {}),
        }),
      );
      for (const obj of resp.Contents ?? []) {
        total++;
        if (obj.LastModified) {
          if (!lastModified || obj.LastModified > lastModified) lastModified = obj.LastModified;
          if (syncCutoff && obj.LastModified > syncCutoff) pending++;
        }
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken && total < 5000);
    if (!syncCutoff) pending = total;
    return { total, pendingSinceLastSync: pending, lastModified: lastModified?.toISOString() ?? null, bucket };
  } catch (err) {
    console.warn('[kb] countS3Documents failed:', (err as Error).message);
    return { total: 0, pendingSinceLastSync: 0, lastModified: null, bucket };
  }
}

// ─── Crawl → KB sync ──────────────────────────────────────────────────────────
// The KB data source covers the entire bucket (no per-prefix scoping at the
// data-source level), so we just call StartIngestionJob on the first S3 data
// source attached to the KB and stamp the crawl id into the description so the
// UI can correlate the job back to the run.

export async function triggerKbSyncForCrawl(
  crawlId: string,
): Promise<{ jobId: string; status: string; dataSourceId: string } | null> {
  const kbId = config.knowledgeBase.id;
  if (!kbId) return null;
  try {
    const sources = await listDataSources();
    // Prefer S3-backed sources; otherwise fall back to the first one available.
    const target = sources.find(s => s.type === 'S3') ?? sources[0];
    if (!target) {
      console.warn('[kb] triggerKbSyncForCrawl: no data sources attached to KB');
      return null;
    }
    const job = await startIngestionJob(target.id, `Crawl sync: ${crawlId}`);
    if (!job) return null;
    return { ...job, dataSourceId: target.id };
  } catch (err) {
    console.warn('[kb] triggerKbSyncForCrawl failed:', (err as Error).message);
    return null;
  }
}

// ─── Storage breakdown ────────────────────────────────────────────────────────
// Wider lens than getIngestStats — used by the new Ingest page summary cards.
// Aggregates the documents bucket by extension and by first-level prefix, and
// reports the KB document count from the most recent COMPLETE ingestion job.

export async function getStorageBreakdown(s3Prefix?: string): Promise<StorageBreakdown> {
  // Scoped to one KB's `s3_prefix` when given — see countS3Documents.
  const prefix = s3Prefix?.trim() || undefined;
  if (mockAws()) {
    const objects = prefix ? mockObjects().filter((o) => o.key.startsWith(prefix)) : mockObjects();
    const byType = [...groupBy(objects, (o) => extensionOf(o.key))]
      .map(([extension, rows]) => ({ extension, count: rows.length, bytes: sumBy(rows, 'sizeBytes') }))
      .sort((a, b) => b.bytes - a.bytes);
    const byPrefix = [...groupBy(objects, (o) => topPrefixOf(o.key))]
      .map(([prefix, rows]) => ({ prefix, count: rows.length, bytes: sumBy(rows, 'sizeBytes') }))
      .sort((a, b) => b.count - a.count);
    // Same proxy the real path uses: the newest COMPLETE job's indexed count.
    const lastComplete = (await listIngestionJobs(undefined, 10)).find(j => j.status === 'COMPLETE');
    return {
      bucket: mockBucket(),
      totalObjects: objects.length,
      totalBytes: sumBy(objects, 'sizeBytes'),
      byType,
      byPrefix,
      kb: {
        totalDocuments: lastComplete?.documentsIndexed ?? 0,
        lastIngestedAt: lastComplete?.updatedAt ?? null,
      },
    };
  }
  const bucket = config.foundation.documentsBucket ?? '';
  const byTypeMap = new Map<string, { count: number; bytes: number }>();
  const byPrefixMap = new Map<string, { count: number; bytes: number }>();
  let totalObjects = 0;
  let totalBytes = 0;

  if (bucket) {
    try {
      const s3 = new S3Client({ region: config.region });
      let token: string | undefined;
      do {
        const resp = await s3.send(new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 1000,
          ContinuationToken: token,
          ...(prefix ? { Prefix: prefix } : {}),
        }));
        for (const obj of resp.Contents ?? []) {
          const size = obj.Size ?? 0;
          totalObjects++;
          totalBytes += size;
          const ext = (extname(obj.Key ?? '').toLowerCase() || '(none)');
          const e = byTypeMap.get(ext) ?? { count: 0, bytes: 0 };
          byTypeMap.set(ext, { count: e.count + 1, bytes: e.bytes + size });
          const top = (obj.Key ?? '').split('/')[0] || '(root)';
          const p = byPrefixMap.get(top) ?? { count: 0, bytes: 0 };
          byPrefixMap.set(top, { count: p.count + 1, bytes: p.bytes + size });
        }
        token = resp.NextContinuationToken;
      } while (token && totalObjects < 10000);
    } catch (err) {
      console.warn('[kb] getStorageBreakdown s3 scan failed:', (err as Error).message);
    }
  }

  const byType = Array.from(byTypeMap.entries())
    .map(([extension, v]) => ({ extension, ...v }))
    .sort((a, b) => b.bytes - a.bytes);
  const byPrefix = Array.from(byPrefixMap.entries())
    .map(([prefix, v]) => ({ prefix, ...v }))
    .sort((a, b) => b.count - a.count);

  // KB doc count: use the most recent COMPLETE ingestion job's indexed count.
  // The bedrock-agent SDK pinned in this repo doesn't ship
  // ListKnowledgeBaseDocuments, so the last-job snapshot is our best proxy.
  let totalDocuments = 0;
  let lastIngestedAt: string | null = null;
  try {
    const recent = await listIngestionJobs(undefined, 10);
    const lastComplete = recent.find(j => j.status === 'COMPLETE');
    if (lastComplete) {
      totalDocuments = lastComplete.documentsIndexed;
      lastIngestedAt = lastComplete.updatedAt;
    }
  } catch (err) {
    console.warn('[kb] getStorageBreakdown kb stats failed:', (err as Error).message);
  }

  return {
    bucket,
    totalObjects,
    totalBytes,
    byType,
    byPrefix,
    kb: { totalDocuments, lastIngestedAt },
  };
}

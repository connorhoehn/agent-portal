// Bedrock Knowledge Base provider — wraps the @aws-sdk/client-bedrock-agent
// control-plane API for the /ingest page. The agents stack already provisioned
// a Knowledge Base + KMS keys + data source via CDK (orgiq-knowledge-base).
//
// What this exposes:
//   - getKb()                       → KB metadata (id, embedding model, status)
//   - listDataSources()             → S3 ingestion targets bound to the KB
//   - listIngestionJobs(dsId?)      → recent sync runs
//   - startIngestionJob(dsId, desc) → trigger a fresh sync

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

const _client = (): BedrockAgentClient =>
  new BedrockAgentClient({ region: config.region });

export async function getKb(): Promise<KbSummary | null> {
  const kbId = config.knowledgeBase.id;
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

export async function startIngestionJob(dataSourceId: string, description?: string): Promise<{ jobId: string; status: string } | null> {
  const kbId = config.knowledgeBase.id;
  if (!kbId) return null;
  try {
    const resp = await _client().send(
      new StartIngestionJobCommand({
        knowledgeBaseId: kbId,
        dataSourceId,
        description: description ?? `Manual sync triggered from portal at ${new Date().toISOString()}`,
      }),
    );
    return {
      jobId: resp.ingestionJob?.ingestionJobId ?? '',
      status: String(resp.ingestionJob?.status ?? 'UNKNOWN'),
    };
  } catch (err) {
    console.warn('[kb] startIngestionJob failed:', (err as Error).message);
    return null;
  }
}

export async function getIngestionJob(jobId: string, dataSourceId: string): Promise<IngestionJobSummary | null> {
  const kbId = config.knowledgeBase.id;
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
  const bucket = config.foundation.documentsBucket;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');
  const s3 = new S3Client({ region: config.region });
  const date = new Date().toISOString().slice(0, 10);
  const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}/${date}/${safe}`;
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

export async function countS3Documents(lastSyncAt?: string): Promise<S3QueueSummary> {
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
        new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: continuationToken }),
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

export async function getStorageBreakdown(): Promise<StorageBreakdown> {
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

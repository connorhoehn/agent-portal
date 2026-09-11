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
 * corpus as of the moment the job settled. `documentsFailed` is the number of
 * failures the job actually names — a job cannot report a failure count it has
 * no reason for.
 *
 * `indexed` is a DELTA, and getting that wrong here hid a real bug for as long
 * as this fixture has existed. It used to be `corpus.length` — "a COMPLETE run
 * indexes all of it" — but the real API reports
 * `numberOfNewDocumentsIndexed + numberOfModifiedDocumentsIndexed` (see the two
 * live call sites below), i.e. only what CHANGED. Live, a job that scanned 157
 * indexed 0 because nothing had changed since the run before it. So the mock
 * and the account used the same field name for different quantities, and every
 * consumer that read `documentsIndexed` as "how many documents exist" looked
 * correct in dev and reported 0 in the account. Counting the corpus that landed
 * inside this job's own window makes the mock's meaning match the wire's.
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
    // Only the documents that landed during THIS run — the delta the real
    // statistics report. A run that scans a corpus it has already indexed
    // indexes nothing, which is the healthy case the old `corpus.length` could
    // not express.
    documentsIndexed: job.status === 'COMPLETE'
      ? corpus.filter((d) => {
          const ms = Date.parse(String(d.ingestedAt ?? ''));
          return Number.isFinite(ms) && ms >= startMs;
        }).length
      : 0,
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
export interface StartedJob {
  jobId: string;
  status: string;
  knowledgeBaseId: string;
  dataSourceId: string;
}

/** Why a sync could not be started — a status a route can answer with, and a
 *  sentence an operator can act on. */
export interface StartJobFailure {
  status: number;
  error: string;
  /** True when the sync the caller asked for is *already happening*. Callers
   *  that record run history use this to avoid filing a success as a failure. */
  conflict: boolean;
}

export type StartJobOutcome =
  | ({ ok: true } & StartedJob)
  | ({ ok: false } & StartJobFailure);

/**
 * Turn a StartIngestionJob exception into an answer.
 *
 * WHY THIS EXISTS. `startIngestionJob` used to `catch`, `console.warn` and
 * return `null`, and four surfaces then invented their own wrong answer from
 * that one null:
 *
 *   - `POST /api/ingest/start`      → 500 "StartIngestionJob failed — check
 *                                     middleware logs"
 *   - `POST /api/knowledge-bases/:id/sync` → the throw reached `asyncHandler`,
 *                                     which discards unknown messages entirely:
 *                                     500 "Internal server error"
 *   - `POST /api/ingest/crawl/:id/sync`    → 502
 *   - the ingest scheduler          → recorded `lastStatus: 'FAILED'`
 *
 * The case that makes this a false flag rather than a rough edge: Bedrock
 * answers `ConflictException` when an ingestion job is **already running** for
 * that data source. So the operator presses "Sync now" while a sync is in
 * flight, the platform tells them it failed and to go read server logs, and the
 * truth is that the thing they asked for is already happening. A working
 * pipeline reporting as broken is the specific complaint this whole pass is
 * about — and it is the write-side twin of the read-side gap where a running
 * job made the "behind" banner vanish.
 *
 * Second, quieter half: `AccessDeniedException` (no `bedrock:StartIngestionJob`
 * on the task role) and `ResourceNotFoundException` (the data source was deleted
 * out of band) produced the *identical* message, so the one field that
 * distinguishes "already running" from "you lack the permission" from "the
 * target is gone" was in the exception and thrown away. Same lesson as
 * `kb-reconcile.ts::syncState`: the reason was there the whole time.
 *
 * Matching is on the SDK's `name`, with a message fallback because Bedrock has
 * also been observed reporting an in-flight job as a `ValidationException`.
 */
export function classifyStartJobFailure(err: unknown, target: string): StartJobFailure {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? '';
  const message = e?.message ?? String(err);
  const inFlight = /already\s+(a\s+)?(job|ingestion)|in\s*progress|ongoing/i.test(message);

  if (name === 'ConflictException' || inFlight) {
    return {
      status: 409,
      conflict: true,
      error: `A sync is already running on ${target}. Wait for it to finish — `
        + `starting another job now would re-embed the same documents.`,
    };
  }
  if (name === 'AccessDeniedException') {
    return {
      status: 403,
      conflict: false,
      error: `Not allowed to start a sync on ${target}: the middleware's role is `
        + `missing bedrock:StartIngestionJob. (${message})`,
    };
  }
  if (name === 'ResourceNotFoundException') {
    return {
      status: 404,
      conflict: false,
      error: `${target} does not exist in this account — the knowledge base or its `
        + `data source was deleted out of band. Reconcile it from /admin/knowledge. (${message})`,
    };
  }
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') {
    return { status: 429, conflict: false, error: `Bedrock throttled the sync request: ${message}` };
  }
  return { status: 502, conflict: false, error: `Could not start a sync on ${target}: ${message}` };
}

export async function startIngestionJob(
  dataSourceId: string,
  description?: string,
  kbId?: string,
): Promise<StartJobOutcome> {
  const targetKbId = kbId || config.knowledgeBase.id;
  const target = targetKbId ? `${targetKbId}/${dataSourceId}` : dataSourceId;
  if (mockAws()) {
    // Refuse offline for the same reason Bedrock refuses: one data source runs
    // one job at a time. Without this the 409 branch is unreachable under
    // `dev:mock` — and an unreachable state is how the read-side version of
    // this gap survived long enough to ship (see mock/knowledge-base.ts).
    const running = kbIngestionJobRows.rows().find(
      (j) => j.dataSourceId === dataSourceId
        && ['STARTING', 'IN_PROGRESS', 'STOPPING'].includes(j.status),
    );
    if (running) {
      return {
        ok: false,
        ...classifyStartJobFailure(
          { name: 'ConflictException', message: `job ${running.jobId} is already in progress` },
          target,
        ),
      };
    }
    const job = mockStartJob(dataSourceId, description ?? 'Manual sync triggered from portal');
    return {
      ok: true, jobId: job.jobId, status: job.status, knowledgeBaseId: targetKbId, dataSourceId,
    };
  }
  if (!targetKbId) {
    return {
      ok: false, status: 409, conflict: false,
      error: 'No knowledge base is configured (KNOWLEDGE_BASE_ID is unset), so there is '
        + 'nothing to sync.',
    };
  }
  try {
    const resp = await _client().send(
      new StartIngestionJobCommand({
        knowledgeBaseId: targetKbId,
        dataSourceId,
        description: description ?? `Manual sync triggered from portal at ${new Date().toISOString()}`,
      }),
    );
    return {
      ok: true,
      jobId: resp.ingestionJob?.ingestionJobId ?? '',
      status: String(resp.ingestionJob?.status ?? 'UNKNOWN'),
      knowledgeBaseId: targetKbId,
      dataSourceId,
    };
  } catch (err) {
    const failure = classifyStartJobFailure(err, target);
    // Still logged — but the reason now also reaches the caller, which is the
    // whole point. `conflict` is not a warning: it is the platform working.
    console.warn(`[kb] startIngestionJob ${failure.conflict ? 'conflict' : 'failed'}:`, failure.error);
    return { ok: false, ...failure };
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

export type CrawlSyncOutcome =
  | { ok: true; jobId: string; status: string; dataSourceId: string }
  | ({ ok: false } & StartJobFailure);

export async function triggerKbSyncForCrawl(crawlId: string): Promise<CrawlSyncOutcome> {
  const kbId = config.knowledgeBase.id;
  // Kept as a distinct sentence rather than folded into the generic failure:
  // "nothing is configured" is a deploy state, not a broken sync.
  if (!kbId) {
    return {
      ok: false, status: 409, conflict: false,
      error: 'No knowledge base is configured (KNOWLEDGE_BASE_ID is unset), so a crawl '
        + 'cannot be synced into one.',
    };
  }
  try {
    const sources = await listDataSources();
    // Prefer S3-backed sources; otherwise fall back to the first one available.
    const target = sources.find(s => s.type === 'S3') ?? sources[0];
    if (!target) {
      return {
        ok: false, status: 409, conflict: false,
        error: `Knowledge base ${kbId} has no data source attached, so StartIngestionJob `
          + 'has no target.',
      };
    }
    const job = await startIngestionJob(target.id, `Crawl sync: ${crawlId}`);
    // Relay the reason instead of collapsing it back to a null. This route
    // answered a flat 502 for every case, including the one where the sync the
    // caller wants is already running.
    if (!job.ok) return job;
    return { ok: true, jobId: job.jobId, status: job.status, dataSourceId: target.id };
  } catch (err) {
    return { ok: false, ...classifyStartJobFailure(err, kbId) };
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
    // Counted from the corpus fixture, matching what the real path now does:
    // documents the knowledge base HOLDS, not what the last run happened to
    // index. It used to be `lastComplete.documentsIndexed`, which made the mock
    // faithfully reproduce the deployed bug — the second wave indexed 4, so the
    // page read "4 documents" over a 14-document corpus the same fixture
    // exports. A fixture must never state a number it could count from rows it
    // also exports (docs/mock-floor.md).
    const lastComplete = (await listIngestionJobs(undefined, 10)).find(j => j.status === 'COMPLETE');
    return {
      bucket: mockBucket(),
      totalObjects: objects.length,
      totalBytes: sumBy(objects, 'sizeBytes'),
      byType,
      byPrefix,
      kb: {
        totalDocuments: kbDocumentRows.rows().length,
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

  // How many documents the knowledge base HOLDS — counted, not inferred.
  //
  // This used to be the newest COMPLETE ingestion job's `documentsIndexed`,
  // described as "our best proxy" because the pinned bedrock-agent SDK ships no
  // ListKnowledgeBaseDocuments. It is not a proxy for holdings at all: it is
  // how many documents that RUN newly indexed, which is **0 for any knowledge
  // base that is already current**. Deployed, the newest job scanned 157 and
  // indexed 0 (nothing had changed since the run before it), so the page
  // reported "0 documents" about a knowledge base holding 157 — and it reported
  // it most confidently exactly when the pipeline was healthiest. A fresh sync
  // that correctly finds nothing to do made the KB look empty.
  //
  // The real number was in the same database the whole time. `bedrock_kb` IS
  // the vector store Bedrock reads (see the KB stack), one row per chunk with
  // the S3 URI in `metadata.sourceUrl`, so distinct URIs are documents. Live
  // that is 157 distinct URIs across 158 chunks — matching S3's 157 objects,
  // which is the agreement the whole page is built to check.
  let totalDocuments: number | null = null;
  let lastIngestedAt: string | null = null;
  try {
    const rows = await exec(
      `SELECT count(DISTINCT metadata->>'sourceUrl')::int AS n FROM bedrock_kb`,
    );
    const n = rows[0]?.['n'];
    if (n != null) totalDocuments = Number(n);
  } catch (err) {
    // Left null on purpose. A missing table (a cluster the KB stack never
    // built) and an empty one are different facts, and a 0 here would be
    // indistinguishable from the bug above.
    console.warn('[kb] getStorageBreakdown document count failed:', (err as Error).message);
  }
  try {
    const recent = await listIngestionJobs(undefined, 10);
    const lastComplete = recent.find(j => j.status === 'COMPLETE');
    if (lastComplete) lastIngestedAt = lastComplete.updatedAt;
  } catch (err) {
    // Separately caught: a denied ListIngestionJobs must not erase a document
    // count that was read successfully — the same coupling that made
    // kb-reconcile's syncState report "no data source" about a live one.
    console.warn('[kb] getStorageBreakdown last-ingested failed:', (err as Error).message);
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

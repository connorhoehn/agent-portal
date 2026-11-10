import { Router } from 'express';
import express from 'express';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { config } from '../config.js';
import { MOCK_SCREENSHOT_PNG } from '../mock/ingest-crawls.js';
import {
  getKb,
  lookupKb,
  listDataSources,
  listIngestionJobs,
  getIngestionJob,
  startIngestionJob,
  countS3Documents,
  uploadDocument,
  getIngestStats,
  triggerKbSyncForCrawl,
  getStorageBreakdown,
} from '../providers/knowledge-base.js';
import { getKbBySlug, listKbs } from '../providers/kb-registry.js';
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  toggleSchedule,
  validateCronExpr,
} from '../lib/ingest-scheduler.js';
import {
  startCrawl,
  getCrawl,
  listCrawls,
  cancelCrawl,
  subscribeCrawl,
} from '../lib/crawler.js';
import {
  listCrawlTargets,
  getCrawlTarget,
  addCrawlTarget,
  updateCrawlTarget,
  removeCrawlTarget,
  recordTargetRun,
} from '../lib/crawl-targets.js';
import type { CrawlTarget, CrawlMode } from '../lib/crawler-types.js';
import { startSurvey, getSurvey, listSurveys } from '../lib/site-survey.js';

import { reasonLine } from '../lib/upstream.js';
/**
 * Marks a response whose upstream call failed — same convention as
 * routes/kb-admin.ts (which is where the marker was worth catching first for
 * this pipeline: /data-sources and /jobs both call through providers that
 * used to swallow a failed Bedrock call into a plain `[]`, indistinguishable
 * from a knowledge base with nothing to show yet). Kept local rather than
 * shared so each router owns its own copy, matching every other router that
 * defines this.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: reasonLine(err) };
}

export const ingestRouter = Router();

ingestRouter.get('/kb', asyncHandler(async (_req, res) => {
  // Return the diagnosis alongside the payload: "not configured" and
  // "configured but deleted upstream" need different operator action.
  const { kb, state, kbId, problem } = await lookupKb();
  res.json({ kb, state, kbId, problem });
}));

ingestRouter.get('/data-sources', asyncHandler(async (_req, res) => {
  // `{ silent: false }` so a real ListDataSources/GetDataSource failure
  // reaches here instead of the provider's default swallow-to-`[]` — the "KB
  // sync" page's Data Sources table used to render a failed Bedrock call as
  // "No data sources attached", the same sentence it uses for a knowledge
  // base that has none.
  try {
    const sources = await listDataSources({ silent: false });
    res.json({ sources });
  } catch (err) {
    console.warn('[ingest] GET /data-sources failed:', (err as Error).message);
    res.json(degraded({ sources: [] }, err));
  }
}));

ingestRouter.get('/jobs', asyncHandler(async (req, res) => {
  const dataSourceId = (req.query['dataSourceId'] as string) || undefined;
  // `|| 20` read a valid `limit=0` as "not given" and returned 20 rows;
  // only NaN should fall back to the default, and 0 clamps to 1.
  const rawLimit = parseInt((req.query['limit'] as string) ?? '20', 10);
  const limit = Math.max(1, Math.min(100, Number.isNaN(rawLimit) ? 20 : rawLimit));
  try {
    const jobs = await listIngestionJobs(dataSourceId, limit, { silent: false });
    res.json({ jobs });
  } catch (err) {
    console.warn('[ingest] GET /jobs failed:', (err as Error).message);
    res.json(degraded({ jobs: [] }, err));
  }
}));

ingestRouter.get('/job/:jobId', asyncHandler(async (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const dataSourceId = req.query['dataSourceId'] as string | undefined;
  if (!dataSourceId) {
    res.status(400).json({ error: 'dataSourceId query param required' });
    return;
  }
  const job = await getIngestionJob(jobId, dataSourceId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ job });
}));

// SSE live monitor for a single job — polls GetIngestionJob every 3s until terminal state.
ingestRouter.get('/stream', (req, res) => {
  const { jobId, dataSourceId } = req.query as { jobId?: string; dataSourceId?: string };
  if (!jobId || !dataSourceId) {
    res.status(400).json({ error: 'jobId and dataSourceId required' });
    return;
  }

  initSSE(res);

  const TERMINAL = new Set(['COMPLETE', 'FAILED', 'STOPPED', 'STOPPING']);
  const MAX_POLLS = 200; // 200 × 3 s = 10 min max
  let polls = 0;
  let timer: NodeJS.Timeout | null = null;

  function stop() {
    if (timer) clearTimeout(timer);
    endSSE(res);
  }

  req.on('close', stop);

  async function tick() {
    if (res.writableEnded) return;
    try {
      const job = await getIngestionJob(jobId!, dataSourceId!);
      if (job) {
        writeSSE(res, { type: 'update', job });
        if (TERMINAL.has(job.status)) {
          writeSSE(res, { type: 'done', job });
          stop();
          return;
        }
      }
    } catch {
      // keep polling on transient errors
    }
    polls++;
    if (polls >= MAX_POLLS) {
      writeSSE(res, { type: 'done' });
      stop();
      return;
    }
    if (!res.writableEnded) timer = setTimeout(tick, 3000);
  }

  tick();
});

ingestRouter.get('/queue', asyncHandler(async (req, res) => {
  const kbSlug = (req.query['kbSlug'] as string | undefined)?.trim() || undefined;
  const jobs = await listIngestionJobs(undefined, 5);
  const lastComplete = jobs.find(j => j.status === 'COMPLETE');
  // The registry lookup used to be made and thrown away, so ?kbSlug=<anything>
  // returned the whole bucket's count under that KB's name. The row's
  // `s3_prefix` is threaded now — the same key providers/landing-zones.ts uses
  // to decide where a KB's documents live — and an unknown slug refuses rather
  // than answering about a different corpus.
  //
  // A scoped answer echoes the prefix it counted, so a zero reads as "nothing
  // under orgiq/" rather than "this knowledge base is empty". Those are
  // different claims and only the first one is ours to make.
  let prefix: string | undefined;
  if (kbSlug) {
    const entry = await getKbBySlug(kbSlug);
    if (!entry) {
      res.status(404).json({ error: `No knowledge base is registered with slug "${kbSlug}"` });
      return;
    }
    prefix = entry.s3Prefix || undefined;
  }
  const queue = await countS3Documents(lastComplete?.updatedAt, prefix);
  res.json(kbSlug ? { ...queue, kbSlug, s3Prefix: prefix ?? null } : queue);
}));

// --- Schedule CRUD ---

ingestRouter.get('/schedules', (_req, res) => {
  res.json({ schedules: listSchedules() });
});

ingestRouter.post('/schedules', asyncHandler(async (req, res) => {
  const { dataSourceId, dataSourceName, cronExpr, label, enabled } = req.body as {
    dataSourceId?: string;
    dataSourceName?: string;
    cronExpr?: string;
    label?: string;
    enabled?: boolean;
  };
  if (!dataSourceId || !cronExpr) {
    res.status(400).json({ error: 'dataSourceId and cronExpr required' });
    return;
  }
  if (!validateCronExpr(cronExpr)) {
    res.status(400).json({ error: `Invalid cron expression: ${cronExpr}` });
    return;
  }
  const schedule = addSchedule({
    dataSourceId,
    dataSourceName: dataSourceName ?? dataSourceId,
    cronExpr,
    label: label ?? cronExpr,
    enabled: enabled !== false,
  });
  res.status(201).json({ schedule });
}));

ingestRouter.delete('/schedules/:id', (req, res) => {
  const removed = removeSchedule(String(req.params['id']));
  if (!removed) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  res.json({ ok: true });
});

ingestRouter.patch('/schedules/:id/toggle', asyncHandler(async (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) required' });
    return;
  }
  const updated = toggleSchedule(String(req.params['id']), enabled);
  if (!updated) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  res.json({ schedule: updated });
}));

ingestRouter.post('/start', asyncHandler(async (req, res) => {
  const { dataSourceId, kbSlug, description } = req.body as {
    dataSourceId?: string;
    kbSlug?: string;
    description?: string;
  };

  // Per-KB path: resolve bedrockKbId + dataSourceId from the `knowledge_bases`
  // registry and sync THAT knowledge base.
  //
  // This used to fall through to the configured KB whenever the slug failed to
  // resolve cleanly, and `startIngestionJob` read its kbId from config either
  // way — so `{"kbSlug":"orgiq-onboarding"}` reported `ok: true` while syncing
  // orgiq-default. Silently syncing the wrong corpus is worse than refusing, so
  // the slug is threaded through to StartIngestionJob and each way it can fail
  // to resolve now refuses with the reason named. There is no fall-through: a
  // caller that asked for one KB never gets a job against a different one.
  if (kbSlug) {
    const entry = await getKbBySlug(kbSlug);
    if (!entry) {
      res.status(404).json({ error: `No knowledge base is registered with slug "${kbSlug}"` });
      return;
    }
    if (!entry.bedrockKbId) {
      res.status(409).json({
        error:
          `Knowledge base "${kbSlug}" has no bedrock_kb_id (registry status ${entry.status}) — ` +
          `it has not finished provisioning, so there is nothing to sync.`,
      });
      return;
    }
    if (!entry.dataSourceId) {
      // Repointing bedrock_kb_id alone leaves a row that still rejects every
      // sync: StartIngestionJob needs the pair. /admin/knowledge's adoption
      // flow captures the data source id — see providers/kb-reconcile.ts.
      res.status(409).json({
        error:
          `Knowledge base "${kbSlug}" is registered as ${entry.bedrockKbId} but has no ` +
          `data_source_id, so StartIngestionJob has no target. Re-adopt it from ` +
          `/admin/knowledge to capture the data source id.`,
      });
      return;
    }
    const outcome = await startIngestionJob(entry.dataSourceId, description, entry.bedrockKbId);
    // The provider classifies; the route relays. This used to be a flat 500
    // "check middleware logs" for every failure — including Bedrock refusing
    // because the sync is ALREADY RUNNING, which is the platform working and
    // read on screen as the pipeline being broken. `conflict` is surfaced so
    // the portal can say "already running" rather than colour it as an error.
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error, conflict: outcome.conflict });
      return;
    }
    const { ok: _ok, ...job } = outcome;
    res.json({ ok: true, job, kbSlug, knowledgeBaseId: job.knowledgeBaseId });
    return;
  }

  if (!dataSourceId) {
    res.status(400).json({ error: 'dataSourceId required' });
    return;
  }
  const outcome = await startIngestionJob(dataSourceId, description);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error, conflict: outcome.conflict });
    return;
  }
  const { ok: _ok, ...job } = outcome;
  res.json({ ok: true, job, knowledgeBaseId: job.knowledgeBaseId });
}));

// ─── Stats ────────────────────────────────────────────────────────────────────
// Richer than /queue: S3 breakdown by extension + prefix, recent job history,
// and KB status all in one call.

ingestRouter.get('/stats', asyncHandler(async (_req, res) => {
  const stats = await getIngestStats();
  res.json(stats);
}));

// ─── Upload ───────────────────────────────────────────────────────────────────
// Accepts a single file as raw bytes. Portal should set:
//   Content-Type: <mime type>
//   X-Filename: original filename (required)
//   X-Prefix: s3 subfolder (optional, defaults to "uploads"); only "uploads"
//             or a registered knowledge base's s3 prefix

/**
 * The S3 prefix an upload may land under. The header used to be taken as
 * given, so a caller could write anywhere in the documents bucket the
 * knowledge base indexes (docs/next-steps.md section 7). Now: `uploads`, or a
 * registered knowledge base's prefix (of the caller's tenant, any tenant for
 * an admin), and never a path with `..` or a leading `/`. Null = refused.
 */
export async function uploadPrefix(raw: unknown, session: { role?: string; tenant?: string } | undefined): Promise<string | null> {
  const given = typeof raw === 'string' ? raw.trim() : '';
  if (!given) return 'uploads';
  if (given.startsWith('/') || given.includes('\\') || given.includes('..')) return null;
  const prefix = given.replace(/\/+$/, '');
  if (prefix === 'uploads') return prefix;
  const tenant = session?.role === 'admin' ? undefined : session?.tenant;
  const kbs = await listKbs(tenant);
  return kbs.some((kb) => kb.s3Prefix.trim().replace(/\/+$/, '') === prefix && prefix !== '') ? prefix : null;
}

ingestRouter.post(
  '/upload',
  express.raw({ type: '*/*', limit: '50mb' }),
  asyncHandler(async (req, res) => {
    const filename = (req.headers['x-filename'] as string | undefined)?.trim();
    if (!filename) {
      res.status(400).json({ error: 'X-Filename header required' });
      return;
    }
    const contentType = (req.headers['content-type'] as string) || 'application/octet-stream';
    const prefix = await uploadPrefix(req.headers['x-prefix'], req.session);
    if (!prefix) {
      res.status(400).json({ error: 'X-Prefix must be "uploads" or a registered knowledge base prefix' });
      return;
    }
    const body = req.body as Buffer;
    if (!body?.length) {
      res.status(400).json({ error: 'Empty body' });
      return;
    }
    const result = await uploadDocument(filename, body, contentType, prefix);
    res.status(201).json({ ok: true, ...result });
  }),
);

// ─── Crawl ────────────────────────────────────────────────────────────────────
// POST /ingest/crawl           — start a crawl, returns immediately with crawlId
// GET  /ingest/crawls          — list recent crawl sessions
// GET  /ingest/crawl/:id       — get a specific session
// DELETE /ingest/crawl/:id     — cancel a running crawl
// GET  /ingest/crawl/:id/stream — SSE stream of CrawlEvents

ingestRouter.post('/crawl', asyncHandler(async (req, res) => {
  const { startUrl, maxPages, mode, includePattern, sameOriginOnly, label } = req.body as {
    startUrl?: string;
    maxPages?: number;
    mode?: 'fetch' | 'browser' | 'browser_spa';
    includePattern?: string;
    sameOriginOnly?: boolean;
    label?: string;
  };
  if (!startUrl) {
    res.status(400).json({ error: 'startUrl required' });
    return;
  }
  try { new URL(startUrl); } catch {
    res.status(400).json({ error: 'startUrl must be a valid URL' });
    return;
  }
  const session = await startCrawl({ startUrl, maxPages, mode, includePattern, sameOriginOnly, label });
  res.status(202).json({ crawlId: session.id, session });
}));

ingestRouter.get('/crawls', (_req, res) => {
  res.json({ crawls: listCrawls(50) });
});

ingestRouter.get('/crawl/:id', (req, res) => {
  const session = getCrawl(String(req.params['id']));
  if (!session) { res.status(404).json({ error: 'Crawl not found' }); return; }
  res.json({ session });
});

ingestRouter.delete('/crawl/:id', (req, res) => {
  const ok = cancelCrawl(String(req.params['id']));
  if (!ok) { res.status(404).json({ error: 'Crawl not found' }); return; }
  res.json({ ok: true });
});

ingestRouter.get('/crawl/:id/stream', (req, res) => {
  const crawlId = String(req.params['id']);
  const session = getCrawl(crawlId);
  if (!session) { res.status(404).json({ error: 'Crawl not found' }); return; }

  initSSE(res);

  // If already terminal, send current state and close immediately.
  if (session.status !== 'running') {
    writeSSE(res, { type: session.status, session });
    endSSE(res);
    return;
  }

  // Send current snapshot so the client can render progress already made.
  writeSSE(res, { type: 'started', session });

  const unsub = subscribeCrawl(crawlId, (ev) => {
    if (res.writableEnded) return;
    writeSSE(res, ev);
    if (ev.type === 'completed' || ev.type === 'failed' || ev.type === 'cancelled') {
      endSSE(res);
    }
  });

  req.on('close', unsub);
});

// ─── Crawl detail / artifacts ─────────────────────────────────────────────────
// Page detail merges the in-memory CrawlPage with the analysis JSON sitting in
// S3 (Track A uploads the analysis blob during the crawl). The screenshot
// route is a thin S3 proxy with a 1-day cache.

const _s3 = (): S3Client => new S3Client({ region: config.region });

function asSessionPage(crawlId: string, idxStr: string) {
  const session = getCrawl(crawlId);
  if (!session) return { error: 'Crawl not found' as const, status: 404 as const };
  const idx = Number.parseInt(idxStr, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= session.pages.length) {
    return { error: 'Page not found' as const, status: 404 as const };
  }
  return { session, page: session.pages[idx]!, idx };
}

ingestRouter.get('/crawl/:id/page/:idx', asyncHandler(async (req, res) => {
  const result = asSessionPage(String(req.params['id']), String(req.params['idx']));
  if ('error' in result) { res.status(result.status as number).json({ error: result.error }); return; }
  const { page } = result;

  let analysis: unknown = null;
  const bucket = config.foundation.documentsBucket;
  // The CrawlPage shape carries S3 keys once Track A's uploads complete; until
  // then we just return the in-memory snapshot.
  const analysisKey = (page as { s3AnalysisKey?: string | null }).s3AnalysisKey ?? null;
  if (bucket && analysisKey) {
    try {
      const obj = await _s3().send(new GetObjectCommand({ Bucket: bucket, Key: analysisKey }));
      const body = await obj.Body?.transformToString('utf-8');
      if (body) {
        try { analysis = JSON.parse(body); } catch { analysis = body; }
      }
    } catch (err) {
      console.warn('[ingest] fetch analysis failed:', (err as Error).message);
    }
  }

  res.json({ page, analysis });
}));

ingestRouter.get('/crawl/:id/page/:idx/screenshot', asyncHandler(async (req, res) => {
  const result = asSessionPage(String(req.params['id']), String(req.params['idx']));
  if ('error' in result) { res.status(result.status as number).json({ error: result.error }); return; }
  const { page } = result;

  const bucket = config.foundation.documentsBucket;
  const key = (page as { s3ScreenshotKey?: string | null }).s3ScreenshotKey ?? null;
  if (config.mock.aurora && key) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(MOCK_SCREENSHOT_PNG);
    return;
  }
  if (!bucket || !key) { res.status(404).json({ error: 'Screenshot not available' }); return; }

  try {
    const obj = await _s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    // Headers go on only once we know there is a body to describe. Setting
    // Content-Type first meant the empty-body branch answered 502 with a JSON
    // error still labelled image/png — `res.json` will not overwrite an
    // existing Content-Type — so a client parsing JSON saw nothing at all.
    const body = obj.Body as Readable | undefined;
    if (!body) { res.status(502).json({ error: 'Empty S3 body' }); return; }
    res.setHeader('Content-Type', obj.ContentType ?? 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (obj.ETag) res.setHeader('ETag', obj.ETag);
    if (typeof obj.ContentLength === 'number') res.setHeader('Content-Length', String(obj.ContentLength));
    body.on('error', (err) => {
      console.warn('[ingest] screenshot stream error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Screenshot stream failed' });
      else res.end();
    });
    body.pipe(res);
  } catch (err) {
    console.warn('[ingest] screenshot fetch failed:', (err as Error).message);
    res.status(404).json({ error: 'Screenshot not found' });
  }
}));

ingestRouter.get('/crawl/:id/manifest', (req, res) => {
  const session = getCrawl(String(req.params['id']));
  if (!session) { res.status(404).json({ error: 'Crawl not found' }); return; }
  const bucket = config.foundation.documentsBucket ?? '';
  const entries = session.pages.map((p, idx) => {
    const np = p as {
      s3ScreenshotKey?: string | null;
      s3MarkdownKey?: string | null;
      s3AnalysisKey?: string | null;
    };
    return {
      idx,
      url: p.url,
      title: p.title,
      status: p.status,
      screenshotKey: np.s3ScreenshotKey ?? null,
      markdownKey: np.s3MarkdownKey ?? null,
      analysisKey: np.s3AnalysisKey ?? null,
    };
  });
  res.json({
    crawlId: session.id,
    bucket,
    prefix: (session as { s3Prefix?: string }).s3Prefix ?? `crawled/${session.id}`,
    pageCount: session.pages.length,
    entries,
  });
});

ingestRouter.post('/crawl/:id/sync', asyncHandler(async (req, res) => {
  const session = getCrawl(String(req.params['id']));
  if (!session) { res.status(404).json({ error: 'Crawl not found' }); return; }
  const outcome = await triggerKbSyncForCrawl(session.id);
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error, conflict: outcome.conflict });
    return;
  }
  const { ok: _ok, ...job } = outcome;
  res.status(202).json({ ok: true, job });
}));

// ─── Crawl Targets (named, optionally-scheduled crawls) ───────────────────────

ingestRouter.get('/crawl-targets', (_req, res) => {
  res.json({ targets: listCrawlTargets() });
});

ingestRouter.post('/crawl-targets', asyncHandler(async (req, res) => {
  const b = req.body as Partial<CrawlTarget> & { startUrl?: string; label?: string };
  if (!b.startUrl) { res.status(400).json({ error: 'startUrl required' }); return; }
  try { new URL(b.startUrl); } catch {
    res.status(400).json({ error: 'startUrl must be a valid URL' });
    return;
  }
  if (!b.label) { res.status(400).json({ error: 'label required' }); return; }
  if (b.cronExpr && !validateCronExpr(b.cronExpr)) {
    res.status(400).json({ error: `Invalid cron expression: ${b.cronExpr}` });
    return;
  }
  const maxPages = Math.max(1, Math.min(500, b.maxPages ?? 10));
  const mode: CrawlMode = (b.mode as CrawlMode) ?? 'browser';
  try {
    const target = addCrawlTarget({
      label: b.label,
      startUrl: b.startUrl,
      maxPages,
      mode,
      includePattern: b.includePattern ?? null,
      sameOriginOnly: b.sameOriginOnly !== false,
      cronExpr: b.cronExpr ?? null,
      enabled: b.enabled !== false,
    });
    res.status(201).json({ target });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}));

ingestRouter.patch('/crawl-targets/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id']);
  const patch = req.body as Partial<CrawlTarget>;
  if (patch.startUrl) {
    try { new URL(patch.startUrl); } catch {
      res.status(400).json({ error: 'startUrl must be a valid URL' });
      return;
    }
  }
  if (patch.cronExpr && !validateCronExpr(patch.cronExpr)) {
    res.status(400).json({ error: `Invalid cron expression: ${patch.cronExpr}` });
    return;
  }
  try {
    const updated = updateCrawlTarget(id, patch);
    if (!updated) { res.status(404).json({ error: 'Crawl target not found' }); return; }
    res.json({ target: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}));

ingestRouter.delete('/crawl-targets/:id', (req, res) => {
  const ok = removeCrawlTarget(String(req.params['id']));
  if (!ok) { res.status(404).json({ error: 'Crawl target not found' }); return; }
  res.json({ ok: true });
});

ingestRouter.post('/crawl-targets/:id/run', asyncHandler(async (req, res) => {
  const target = getCrawlTarget(String(req.params['id']));
  if (!target) { res.status(404).json({ error: 'Crawl target not found' }); return; }
  const session = await startCrawl({
    startUrl: target.startUrl,
    maxPages: target.maxPages,
    mode: target.mode,
    includePattern: target.includePattern ?? undefined,
    sameOriginOnly: target.sameOriginOnly,
    label: target.label,
    targetId: target.id,
    scheduleId: target.id,
  } as Parameters<typeof startCrawl>[0]);
  recordTargetRun(target.id, session.id, session.status);
  res.status(202).json({ crawlId: session.id, session });
}));

// ─── Storage breakdown ────────────────────────────────────────────────────────

ingestRouter.get('/storage', asyncHandler(async (req, res) => {
  const kbSlug = (req.query['kbSlug'] as string | undefined)?.trim() || undefined;
  // Same as /queue: the prefix is what scopes a breakdown to one KB, so it is
  // passed rather than resolved and discarded, and a scoped answer says which
  // prefix it summed.
  let prefix: string | undefined;
  if (kbSlug) {
    const entry = await getKbBySlug(kbSlug);
    if (!entry) {
      res.status(404).json({ error: `No knowledge base is registered with slug "${kbSlug}"` });
      return;
    }
    prefix = entry.s3Prefix || undefined;
  }
  const { s3ScanFailed, ...breakdown } = await getStorageBreakdown(prefix);
  const body = kbSlug ? { ...breakdown, kbSlug, s3Prefix: prefix ?? null } : breakdown;
  // `s3ScanFailed` means `totalObjects`/`byType`/`byPrefix` are a stale 0 from
  // a failed ListObjectsV2, not an empty bucket — the Storage page used to
  // have no way to tell those apart.
  res.json(s3ScanFailed ? degraded(body, new Error('S3 object listing failed — see server logs')) : body);
}));

// ── Site survey — reconnaissance before a crawl ─────────────────────────────
//
// A crawl target used to be configured blind: a URL and a page cap, with the
// site's actual shape discoverable only by paying for a full vision crawl. The
// survey walks the site cheaply first and hands back a tree you can choose
// from.

ingestRouter.post('/survey', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    startUrl?: string; maxPages?: number; useBrowserFallback?: boolean;
  };
  if (!body.startUrl?.trim()) throw new ValidationError('startUrl is required');
  const survey = await startSurvey({
    startUrl: body.startUrl.trim(),
    ...(body.maxPages !== undefined && { maxPages: Number(body.maxPages) }),
    ...(body.useBrowserFallback !== undefined && { useBrowserFallback: Boolean(body.useBrowserFallback) }),
  });
  res.status(202).json(survey);
}));

ingestRouter.get('/surveys', (_req, res) => {
  res.json({ surveys: listSurveys() });
});

ingestRouter.get('/survey/:id', (req, res) => {
  const survey = getSurvey(String(req.params['id'] ?? ''));
  if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }
  res.json(survey);
});

// ── Turn a selection into a crawl target ────────────────────────────────────
//
// The selected path prefixes become the target's includePattern, so the crawl
// that eventually runs is scoped to what was actually chosen rather than to
// the whole origin. This is the entire point of surveying first.

ingestRouter.post('/survey/:id/target', asyncHandler(async (req, res) => {
  const survey = getSurvey(String(req.params['id'] ?? ''));
  if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

  const body = (req.body ?? {}) as {
    prefixes?: unknown; label?: string; maxPages?: number;
    mode?: string; cronExpr?: string | null;
  };
  const prefixes = Array.isArray(body.prefixes)
    ? body.prefixes.map(String).filter((s) => s.startsWith('/'))
    : [];
  if (prefixes.length === 0) throw new ValidationError('Select at least one section to crawl');

  // Matched against the URL's *pathname*, not the full URL.
  //
  // The crawler tests `includeRegex.test(new URL(target).pathname)`, so a
  // pattern anchored at the origin — `^https://host(/docs)(/|$)` — matches
  // nothing at all: every survey-created target silently excluded every page,
  // and the crawl visited its start URL and stopped. Same origin is already
  // enforced separately by sameOriginOnly.
  //
  // Escaped so "/docs" is read literally, and closed with (/|$) so it cannot
  // also match "/docs-internal".
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const includePattern = `^(${escaped.join('|')})(/|$)`;

  const pagesInScope = survey.pages.filter(
    (pg) => pg.status === 'ok' && prefixes.some((pre) => pg.path === pre || pg.path.startsWith(`${pre}/`)),
  ).length;

  const target = addCrawlTarget({
    label: body.label?.trim() || `${new URL(survey.origin).hostname} ${prefixes.join(' ')}`,
    startUrl: survey.startUrl,
    // Default the cap to what the survey actually found in scope rather than a
    // round number, so the first run covers the selection and stops.
    maxPages: Math.max(1, Math.min(200, Number(body.maxPages) || pagesInScope || 25)),
    mode: (body.mode === 'fetch' || body.mode === 'browser_spa' ? body.mode : 'browser') as CrawlMode,
    includePattern,
    sameOriginOnly: true,
    cronExpr: body.cronExpr?.trim() || null,
    enabled: true,
  });

  res.status(201).json({ target, pagesInScope, includePattern });
}));

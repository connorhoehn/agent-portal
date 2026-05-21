import { Router } from 'express';
import express from 'express';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { config } from '../config.js';
import {
  getKb,
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
import { getKbBySlug } from '../providers/kb-registry.js';
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

export const ingestRouter = Router();

ingestRouter.get('/kb', asyncHandler(async (_req, res) => {
  const kb = await getKb();
  res.json({ kb });
}));

ingestRouter.get('/data-sources', asyncHandler(async (_req, res) => {
  const sources = await listDataSources();
  res.json({ sources });
}));

ingestRouter.get('/jobs', asyncHandler(async (req, res) => {
  const dataSourceId = (req.query['dataSourceId'] as string) || undefined;
  const limit = Math.max(1, Math.min(100, parseInt((req.query['limit'] as string) ?? '20', 10) || 20));
  const jobs = await listIngestionJobs(dataSourceId, limit);
  res.json({ jobs });
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
  if (kbSlug) {
    // Resolve the KB's s3_prefix from the registry for a per-KB queue count.
    const _entry = await getKbBySlug(kbSlug); // eslint-disable-line @typescript-eslint/no-unused-vars
    // TODO Wave 2: pass prefix once countS3Documents accepts it
  }
  const queue = await countS3Documents(lastComplete?.updatedAt);
  res.json(queue);
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

  // Per-KB path: resolve bedrockKbId + dataSourceId from the registry.
  if (kbSlug) {
    const entry = await getKbBySlug(kbSlug);
    if (entry && entry.bedrockKbId && entry.dataSourceId) {
      // NOTE: startIngestionJob currently reads kbId from config; it does not
      // accept a per-call kbId override. Passing entry.dataSourceId here works
      // only when entry.bedrockKbId matches the configured KB. A proper
      // per-KB implementation requires startIngestionJob to accept a kbId param
      // — that change is deferred to Wave 2 so it doesn't break existing callers.
      const job = await startIngestionJob(entry.dataSourceId, description);
      if (!job) {
        res.status(500).json({ error: 'StartIngestionJob failed — check middleware logs' });
        return;
      }
      res.json({ ok: true, job });
      return;
    }
    // Entry not found or missing IDs — fall through to the single-KB path below.
  }

  if (!dataSourceId) {
    res.status(400).json({ error: 'dataSourceId required' });
    return;
  }
  const job = await startIngestionJob(dataSourceId, description);
  if (!job) {
    res.status(500).json({ error: 'StartIngestionJob failed — check middleware logs' });
    return;
  }
  res.json({ ok: true, job });
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
//   X-Prefix: s3 subfolder (optional, defaults to "uploads")

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
    const prefix = (req.headers['x-prefix'] as string | undefined)?.trim() || 'uploads';
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
  if (!bucket || !key) { res.status(404).json({ error: 'Screenshot not available' }); return; }

  try {
    const obj = await _s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader('Content-Type', obj.ContentType ?? 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (obj.ETag) res.setHeader('ETag', obj.ETag);
    if (typeof obj.ContentLength === 'number') res.setHeader('Content-Length', String(obj.ContentLength));
    const body = obj.Body as Readable | undefined;
    if (!body) { res.status(502).json({ error: 'Empty S3 body' }); return; }
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
  const job = await triggerKbSyncForCrawl(session.id);
  if (!job) {
    res.status(502).json({ error: 'StartIngestionJob failed — check middleware logs' });
    return;
  }
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
  if (kbSlug) {
    // Resolve the KB's s3_prefix from the registry for a per-KB storage breakdown.
    const _entry = await getKbBySlug(kbSlug); // eslint-disable-line @typescript-eslint/no-unused-vars
    // TODO Wave 2: pass prefix once getStorageBreakdown accepts it
  }
  const breakdown = await getStorageBreakdown();
  res.json(breakdown);
}));

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  getKb,
  listDataSources,
  listIngestionJobs,
  getIngestionJob,
  startIngestionJob,
  countS3Documents,
} from '../providers/knowledge-base.js';
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  toggleSchedule,
  validateCronExpr,
} from '../lib/ingest-scheduler.js';

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

ingestRouter.get('/queue', asyncHandler(async (_req, res) => {
  const jobs = await listIngestionJobs(undefined, 5);
  const lastComplete = jobs.find(j => j.status === 'COMPLETE');
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
  const removed = removeSchedule(req.params['id']!);
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
  const updated = toggleSchedule(req.params['id']!, enabled);
  if (!updated) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }
  res.json({ schedule: updated });
}));

ingestRouter.post('/start', asyncHandler(async (req, res) => {
  const { dataSourceId, description } = req.body as { dataSourceId?: string; description?: string };
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

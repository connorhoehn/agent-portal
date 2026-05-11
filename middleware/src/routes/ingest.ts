import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import {
  getKb,
  listDataSources,
  listIngestionJobs,
  startIngestionJob,
} from '../providers/knowledge-base.js';

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

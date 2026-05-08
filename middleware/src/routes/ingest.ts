import { Router } from 'express';
import { mockIngestSources, mockIngestStats } from '../mock/ingest-sources.js';

export const ingestRouter = Router();

ingestRouter.get('/sources', (_req, res) => {
  res.json({ sources: mockIngestSources });
});

ingestRouter.get('/stats', (_req, res) => {
  res.json(mockIngestStats);
});

ingestRouter.post('/trigger', (req, res) => {
  const { sourceId } = req.body as { sourceId?: string };
  const source = sourceId ? mockIngestSources.find(s => s.id === sourceId) : null;
  res.json({
    status: 'queued',
    message: source ? `Sync triggered for ${source.name}` : 'Full sync triggered',
    estimatedDurationMs: 45000,
  });
});

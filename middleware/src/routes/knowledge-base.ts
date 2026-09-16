// Knowledge-Base management routes — /api/knowledge-base
//
// Mounted UNGATED (same pattern as cost/harness routes). Wire in index.ts:
//   import { knowledgeBaseRouter } from './routes/knowledge-base.js';
//   app.use('/api/knowledge-base', knowledgeBaseRouter);
//
// Endpoints:
//   GET  /documents?limit=N&since=ISO  — Aurora documents table, newest first
//   GET  /data-sources                 — Bedrock KB data sources + latest job
//   POST /sync                         — trigger ingestion job { dataSourceId }

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import {
  listIngestedDocs,
  countIngestedDocs,
  listDataSourcesWithStatus,
  startSync,
} from '../providers/knowledge-base.js';
import { config } from '../config.js';
import { requireAction } from '../lib/authz.js';

export const knowledgeBaseRouter = Router();

// ─── GET /documents ───────────────────────────────────────────────────────────

knowledgeBaseRouter.get('/documents', asyncHandler(async (req, res) => {
  const limitRaw = req.query['limit'];
  const since = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
  const limit = limitRaw ? Math.min(Math.max(1, parseInt(String(limitRaw), 10) || 50), 500) : 50;

  const [docs, total] = await Promise.all([
    listIngestedDocs({ limit, since }),
    countIngestedDocs({ since }),
  ]);
  res.json({ documents: docs, total });
}));

// ─── GET /data-sources ────────────────────────────────────────────────────────

knowledgeBaseRouter.get('/data-sources', asyncHandler(async (req, res) => {
  const kbId = config.knowledgeBase.id;
  const sources = await listDataSourcesWithStatus(kbId);
  res.json({ sources });
}));

// ─── POST /sync ───────────────────────────────────────────────────────────────

// Triggering an ingestion job spends real Bedrock/OpenSearch resources —
// gated as a KB-management decision (hr-admin / admin).
knowledgeBaseRouter.post('/sync', requireAction('ManageKB'), asyncHandler(async (req, res) => {
  const { dataSourceId } = req.body as { dataSourceId?: unknown };
  if (typeof dataSourceId !== 'string' || !dataSourceId.trim()) {
    throw new ValidationError('dataSourceId must be a non-empty string');
  }

  const kbId = config.knowledgeBase.id;
  try {
    const result = await startSync(kbId, dataSourceId.trim());
    res.json({ ok: true, jobId: result.jobId });
  } catch (err) {
    console.warn('[knowledge-base] /sync failed:', (err as Error).message);
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}));

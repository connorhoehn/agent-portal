import { Router } from 'express';
import { cloudwatch } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';
import { getRecentInvocations, getCapabilityEvents } from '../lib/invocations.js';
import type { CapabilityEventKind } from '../lib/invocations.js';

export const observabilityRouter = Router();

observabilityRouter.get('/recent-invocations', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt((req.query['limit'] as string) ?? '50', 10) || 50));
  res.json({ invocations: getRecentInvocations(limit) });
});

observabilityRouter.get('/capability-events', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt((req.query['limit'] as string) ?? '50', 10) || 50));
  const kind = req.query['kind'] as CapabilityEventKind | undefined;
  res.json({ events: getCapabilityEvents(limit, kind) });
});

observabilityRouter.get('/bedrock-invocations', asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt((req.query['limit'] as string) ?? '20', 10) || 20));
  const sinceMin = Math.max(1, Math.min(1440, parseInt((req.query['sinceMin'] as string) ?? '60', 10) || 60));
  const entries = await cloudwatch.listBedrockInvocations({
    limit,
    sinceMs: sinceMin * 60 * 1000,
  });
  res.json({ entries });
}));

observabilityRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const summary = await cloudwatch.getSummary();
    res.json(summary);
  }),
);

observabilityRouter.get(
  '/traces',
  asyncHandler(async (req, res) => {
    const limit = parseInt((req.query['limit'] as string) ?? '10', 10);
    const traces = await cloudwatch.listTraces(limit);
    res.json({ traces });
  }),
);

observabilityRouter.get(
  '/traces/:traceId',
  asyncHandler(async (req, res) => {
    const traceId = req.params['traceId'] as string;
    const trace = await cloudwatch.getTrace(traceId);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    res.json(trace);
  }),
);

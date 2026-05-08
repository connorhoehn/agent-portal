import { Router } from 'express';
import { mockTraces } from '../mock/traces.js';
import { mockAgents } from '../mock/agent-statuses.js';

export const observabilityRouter = Router();

observabilityRouter.get('/summary', (_req, res) => {
  const totalInvocations = mockAgents.reduce((sum, a) => sum + a.invocationsLast24h, 0);
  const totalErrors = mockAgents.reduce((sum, a) => sum + a.errorsLast24h, 0);
  const totalTokens = mockAgents.reduce((sum, a) => sum + a.tokensLast24h, 0);
  const avgLatency = Math.round(mockAgents.reduce((sum, a) => sum + a.latencyP50Ms, 0) / mockAgents.length);

  res.json({
    totalInvocations24h: totalInvocations,
    totalErrors24h: totalErrors,
    totalTokens24h: totalTokens,
    avgLatencyMs: avgLatency,
    successRate: ((totalInvocations - totalErrors) / totalInvocations * 100).toFixed(1),
    traceCount: mockTraces.length,
  });
});

observabilityRouter.get('/traces', (req, res) => {
  const limit = parseInt(req.query['limit'] as string ?? '10', 10);
  res.json({ traces: mockTraces.slice(0, limit) });
});

observabilityRouter.get('/traces/:traceId', (req, res) => {
  const trace = mockTraces.find(t => t.traceId === req.params['traceId']);
  if (!trace) { res.status(404).json({ error: 'Trace not found' }); return; }
  res.json(trace);
});

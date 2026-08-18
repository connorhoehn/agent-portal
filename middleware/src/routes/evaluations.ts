// Evaluations surface — LLM-as-judge configuration + recent scores.
//
// Backs the /iq/evaluations page. The config is the real thing: it is
// persisted in SSM (judge-config.ts) and read by fireJudge() on every canary
// invocation, so the enable toggle, model picker, rubric weights, and sample
// rate all change actual judging behavior.
//
// Mounted at /api/observability/evaluations in index.ts.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { canaryBroker } from '../lib/canary-broker.js';
import { getJudgeConfig, setJudgeConfig } from '../lib/judge-config.js';

export const evaluationsRouter = Router();

// GET /config — current server-side judge config (SSM-backed).
evaluationsRouter.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getJudgeConfig());
}));

// PUT /config — persist judge config. Cedar-gated (same action as canary
// mutations — configuring the judge changes live scoring behavior).
evaluationsRouter.put('/config', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const cfg = await setJudgeConfig(req.body);
  res.json({ ok: true, config: cfg });
}));

// GET /recent — recent judge scores from the canary broker's replay buffer,
// newest first. ?limit=N (default 50, max 200).
evaluationsRouter.get('/recent', asyncHandler(async (req, res) => {
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(200, Math.trunc(rawLimit)))
    : 50;
  const scores = canaryBroker
    .replay()
    .filter((ev) => ev.type === 'judge_score')
    .slice(-limit)
    .reverse();
  res.json({ scores });
}));

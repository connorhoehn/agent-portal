// Bots — /api/bots
//
// The roster of durable, mission-configured agents: create one from the
// wizard, run it now, pause it, watch its firings. Gated as ManageDevbox in
// index.ts because a bot dispatches the same governed runs the SDLC and
// Codebases surfaces do — same authority, same gate.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listBots, getBot, createBot, updateBot, deleteBot, setPausedReason, listBotRuns,
  listMarketplaceRuns, runCostSamples, perPointCostSamples,
  type BotTemplate, type BotTrigger, type BotPatch,
} from '../providers/bots.js';
import { fireBot, dispatchWorkItem } from '../lib/bot-runner.js';
import { registerBot, unregisterBot } from '../lib/bot-scheduler.js';
import { validateCronExpr } from '../lib/ingest-scheduler.js';
import { selectEstimate } from '../lib/bot-estimate.js';
import { selectPerPointEstimate } from '../lib/marketplace-estimate.js';

export const botsRouter: Router = Router();

const TEMPLATES: readonly BotTemplate[] = ['epic', 'story', 'bug'];
const TRIGGERS: readonly BotTrigger[] = ['manual', 'cron', 'pr_watch'];

/**
 * The trigger/target/cron rules shared by create and patch. A pr_watch bot
 * needs a repo (there is no PR stream to watch on an initiative); otherwise a
 * bot may target a repo, an initiative, or neither — but never both, because
 * the target decides the dispatch path and "both" would make it ambiguous.
 */
function checkShape(bot: {
  trigger: BotTrigger; cronExpr: string | null;
  agentProjectId: string | null; orgProjectId: string | null;
}): void {
  if (bot.trigger === 'cron' && (!bot.cronExpr || !validateCronExpr(bot.cronExpr))) {
    throw new ValidationError('a cron bot requires a valid cronExpr');
  }
  if (bot.trigger === 'pr_watch' && !bot.agentProjectId) {
    throw new ValidationError('a pr_watch bot requires agentProjectId — it watches a repository');
  }
  if (bot.agentProjectId && bot.orgProjectId) {
    throw new ValidationError('target either agentProjectId or orgProjectId, not both');
  }
}

// ─── Estimator ───────────────────────────────────────────────────────────────
// Registered before /:id so "estimate" is never read as a bot id.

botsRouter.get('/estimate', asyncHandler(async (req, res) => {
  const model = String(req.query['model'] ?? '').trim();
  if (!model) throw new ValidationError('model is required');
  const agentProjectId = req.query['agentProjectId'] ? String(req.query['agentProjectId']) : null;
  const pointsRaw = Number(req.query['points']);
  const points = Number.isFinite(pointsRaw) && pointsRaw > 0 ? pointsRaw : null;

  // A sized request first tries the per-point basis: percentiles of $/point
  // and minutes/point over runs bound to sized work items, multiplied by N.
  // scaled:true tells the portal the range actually reflects the item's size.
  if (points != null) {
    const repoPerPoint = agentProjectId ? await perPointCostSamples(model, agentProjectId) : null;
    const modelPerPoint = await perPointCostSamples(model, null);
    const scaled = selectPerPointEstimate(points, repoPerPoint, modelPerPoint);
    if (scaled) { res.json({ ...scaled, points, scaled: true }); return; }
  }

  // Fallback (and the unsized path): the run-level estimate, labeled
  // scaled:false — the range forecasts a run, not this item's size. Both
  // samples are fetched so the fallback chain is decided by the pure
  // selector, not by which query happened to run.
  const repoSample = agentProjectId ? await runCostSamples(model, agentProjectId) : null;
  const modelSample = await runCostSamples(model, null);
  res.json({ ...selectEstimate(model, repoSample, modelSample), points, scaled: false });
}));

// ─── Marketplace ─────────────────────────────────────────────────────────────
// Declared before the '/:id' routes so 'dispatch-work' and 'marketplace-runs'
// are never read as bot ids.

botsRouter.post('/dispatch-work', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    workItemId?: string; model?: string; agentProjectId?: string; instruction?: string;
    estimate?: Record<string, unknown>;
  };
  const workItemId = String(body.workItemId ?? '').trim();
  if (!workItemId) throw new ValidationError('workItemId is required');
  const model = String(body.model ?? '').trim();
  if (!model) throw new ValidationError('model is required');
  const instruction = String(body.instruction ?? '').trim();
  const actor = (req as { session?: { email?: string } }).session?.email;

  const result = await dispatchWorkItem({
    workItemId, model,
    ...(body.agentProjectId ? { agentProjectId: String(body.agentProjectId) } : {}),
    ...(instruction ? { instruction } : {}),
    ...(actor ? { actor } : {}),
    ...(body.estimate && typeof body.estimate === 'object' ? { estimate: body.estimate } : {}),
  });
  if (!result.ok) {
    // The dispatcher decides the status: 400 undispatchable, 404 missing,
    // 409 ambiguous codebase (with options to choose from), 503 infrastructure.
    res.status(result.status).json({
      error: result.error, ...(result.options ? { options: result.options } : {}),
    });
    return;
  }
  res.status(202).json({ run: result.run });
}));

botsRouter.get('/marketplace-runs', asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  res.json({ runs: await listMarketplaceRuns(orgProjectId) });
}));

// ─── CRUD ────────────────────────────────────────────────────────────────────

botsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ bots: await listBots() });
}));

botsRouter.post('/', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    name?: string; template?: string; prompt?: string; model?: string; trigger?: string;
    cronExpr?: string | null; agentProjectId?: string | null; orgProjectId?: string | null;
    enabled?: boolean; budgetPerRunUsd?: number | null; budgetPerDayUsd?: number | null;
    maxRunsPerDay?: number; requiresReview?: boolean;
  };
  const name = body.name?.trim();
  if (!name) throw new ValidationError('name is required');
  if (!TEMPLATES.includes(body.template as BotTemplate)) {
    throw new ValidationError(`template must be one of: ${TEMPLATES.join(', ')}`);
  }
  const prompt = body.prompt?.trim();
  if (!prompt) throw new ValidationError('prompt is required — a bot is a written mission');
  const model = body.model?.trim();
  if (!model) throw new ValidationError('model is required');
  if (!TRIGGERS.includes(body.trigger as BotTrigger)) {
    throw new ValidationError(`trigger must be one of: ${TRIGGERS.join(', ')}`);
  }
  checkShape({
    trigger: body.trigger as BotTrigger, cronExpr: body.cronExpr ?? null,
    agentProjectId: body.agentProjectId ?? null, orgProjectId: body.orgProjectId ?? null,
  });

  const bot = await createBot({
    name, template: body.template as BotTemplate, prompt, model,
    trigger: body.trigger as BotTrigger, cronExpr: body.cronExpr ?? null,
    agentProjectId: body.agentProjectId ?? null, orgProjectId: body.orgProjectId ?? null,
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    budgetPerRunUsd: body.budgetPerRunUsd ?? null,
    budgetPerDayUsd: body.budgetPerDayUsd ?? null,
    ...(body.maxRunsPerDay !== undefined ? { maxRunsPerDay: body.maxRunsPerDay } : {}),
    ...(body.requiresReview !== undefined ? { requiresReview: body.requiresReview } : {}),
    createdBy: (req as { session?: { email?: string } }).session?.email ?? null,
  });
  if (!bot) { res.status(503).json({ error: 'bots require Aurora' }); return; }
  registerBot(bot);
  res.status(201).json({ bot });
}));

botsRouter.get('/:id', asyncHandler(async (req, res) => {
  const bot = await getBot(String(req.params['id'] ?? ''));
  if (!bot) throw new NotFoundError('No such bot');
  res.json({ bot });
}));

botsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const existing = await getBot(id);
  if (!existing) throw new NotFoundError('No such bot');

  const body = (req.body ?? {}) as BotPatch;
  const patch: BotPatch = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw new ValidationError('name cannot be empty');
    patch.name = String(body.name).trim();
  }
  if (body.template !== undefined) {
    if (!TEMPLATES.includes(body.template)) throw new ValidationError(`template must be one of: ${TEMPLATES.join(', ')}`);
    patch.template = body.template;
  }
  if (body.prompt !== undefined) {
    if (!String(body.prompt).trim()) throw new ValidationError('prompt cannot be empty');
    patch.prompt = String(body.prompt);
  }
  if (body.model !== undefined) {
    if (!String(body.model).trim()) throw new ValidationError('model cannot be empty');
    patch.model = String(body.model).trim();
  }
  if (body.trigger !== undefined) {
    if (!TRIGGERS.includes(body.trigger)) throw new ValidationError(`trigger must be one of: ${TRIGGERS.join(', ')}`);
    patch.trigger = body.trigger;
  }
  for (const key of ['cronExpr', 'agentProjectId', 'orgProjectId', 'enabled',
    'budgetPerRunUsd', 'budgetPerDayUsd', 'maxRunsPerDay', 'requiresReview'] as const) {
    if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
  }
  // Validate the shape the bot will have after the patch, not the patch alone —
  // switching trigger to cron must fail without a cron expr even when the
  // patch itself carries neither field.
  checkShape({
    trigger: patch.trigger ?? existing.trigger,
    cronExpr: patch.cronExpr !== undefined ? (patch.cronExpr ?? null) : existing.cronExpr,
    agentProjectId: patch.agentProjectId !== undefined ? (patch.agentProjectId ?? null) : existing.agentProjectId,
    orgProjectId: patch.orgProjectId !== undefined ? (patch.orgProjectId ?? null) : existing.orgProjectId,
  });

  const bot = await updateBot(id, patch);
  if (!bot) throw new NotFoundError('No such bot');
  // registerBot re-schedules or clears as the new shape dictates.
  registerBot(bot);
  res.json({ bot });
}));

botsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const ok = await deleteBot(id);
  if (!ok) throw new NotFoundError('No such bot');
  unregisterBot(id);
  res.json({ ok: true });
}));

// ─── Controls ────────────────────────────────────────────────────────────────

botsRouter.post('/:id/run', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const instruction = String((req.body as { instruction?: string } ?? {}).instruction ?? '').trim();
  const result = await fireBot(id, {
    trigger: 'manual', ...(instruction ? { instruction } : {}),
  });
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.status(202).json({ run: result.run });
}));

botsRouter.post('/:id/pause', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!await getBot(id)) throw new NotFoundError('No such bot');
  const reason = String((req.body as { reason?: string } ?? {}).reason ?? '').trim();
  await setPausedReason(id, reason || 'paused by operator');
  res.json({ bot: await getBot(id) });
}));

botsRouter.post('/:id/resume', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!await getBot(id)) throw new NotFoundError('No such bot');
  // Resume clears BOTH halves of "paused": the operator/self-pause reason and
  // the enabled flag. Either alone would leave a bot that looks resumed but
  // still refuses to fire.
  await setPausedReason(id, null);
  await updateBot(id, { enabled: true });
  res.json({ bot: await getBot(id) });
}));

botsRouter.get('/:id/runs', asyncHandler(async (req, res) => {
  res.json({ runs: await listBotRuns(String(req.params['id'] ?? ''), 50) });
}));

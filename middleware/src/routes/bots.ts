// Bots — /api/bots
//
// The roster of durable, mission-configured agents: create one from the
// wizard, run it now, pause it, watch its firings.
//
// Gated per-route, in three tiers, because three different authorities meet
// on this surface:
//   reads     — operational visibility (the roster, runs, the estimator):
//               org-leader + hr-admin, like the other read-wide surfaces.
//   bot CRUD  — creating/patching/firing a bot dispatches the same governed
//               runs the SDLC and Codebases surfaces do: ManageDevbox.
//   dispatch  — authorizing a sized work item into a run is a marketplace
//               decision, not devbox administration: DispatchAgentRun, so
//               org-leaders can dispatch without holding the devbox keys.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction } from '../lib/authz.js';
import {
  listBots, getBot, createBot, updateBot, deleteBot, setPausedReason, listBotRuns,
  listMarketplaceRuns, runCostSamples, perPointCostSamples,
  type BotTemplate, type BotTrigger, type BotPatch,
} from '../providers/bots.js';
import { fireBot, dispatchWorkItem, decideRunBudget } from '../lib/bot-runner.js';
import { registerBot, unregisterBot } from '../lib/bot-scheduler.js';
import { validateCronExpr } from '../lib/ingest-scheduler.js';
import { selectEstimate } from '../lib/bot-estimate.js';
import { selectPerPointEstimate } from '../lib/marketplace-estimate.js';

export const botsRouter: Router = Router();

// The three gate tiers (see the header). readGate only fast-paths GETs, so
// attaching it to a read route is exactly "org-leader/hr-admin/admin may look,
// anyone else needs ManageDevbox".
const readGate = readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageDevbox');
const manageGate = requireAction('ManageDevbox');
const dispatchGate = requireAction('DispatchAgentRun');

const TEMPLATES: readonly BotTemplate[] = ['epic', 'story', 'bug'];
const TRIGGERS: readonly BotTrigger[] = ['manual', 'cron', 'pr_watch'];

const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Shape checks the SQL layer cannot express as a 400: a non-UUID
 * agentProjectId dies in a ::uuid cast (500), a string budget dies in the
 * NUMERIC bind, and a fractional or negative maxRunsPerDay corrupts the run
 * cap. Validated here on create AND patch so garbage never reaches Aurora.
 */
function checkFieldTypes(body: {
  agentProjectId?: string | null; orgProjectId?: string | null;
  budgetPerRunUsd?: unknown; budgetPerDayUsd?: unknown; maxRunsPerDay?: unknown;
}): void {
  if (body.agentProjectId != null && (typeof body.agentProjectId !== 'string' || !isUuid(body.agentProjectId))) {
    throw new ValidationError('agentProjectId must be a codebase UUID');
  }
  if (body.orgProjectId != null && (typeof body.orgProjectId !== 'string' || !body.orgProjectId.trim())) {
    throw new ValidationError('orgProjectId must be a non-empty project id');
  }
  for (const key of ['budgetPerRunUsd', 'budgetPerDayUsd'] as const) {
    const v = body[key];
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new ValidationError(`${key} must be a non-negative number, or null to clear it`);
    }
  }
  const runs = body.maxRunsPerDay;
  if (runs !== undefined && (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 0)) {
    throw new ValidationError('maxRunsPerDay must be an integer >= 0 (0 means the bot never fires)');
  }
}

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

botsRouter.get('/estimate', readGate, asyncHandler(async (req, res) => {
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

botsRouter.post('/dispatch-work', dispatchGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    workItemId?: string; model?: string; agentProjectId?: string; instruction?: string;
    estimate?: Record<string, unknown>; budgetPerRunUsd?: unknown; confirmOverBudget?: boolean;
  };
  const workItemId = String(body.workItemId ?? '').trim();
  if (!workItemId) throw new ValidationError('workItemId is required');
  const model = String(body.model ?? '').trim();
  if (!model) throw new ValidationError('model is required');
  if (body.agentProjectId != null && !isUuid(String(body.agentProjectId))) {
    throw new ValidationError('agentProjectId must be a codebase UUID');
  }
  const instruction = String(body.instruction ?? '').trim();
  const actor = req.session?.sub;

  // Per-run budget, request-supplied (there is no bot here to carry one).
  // Judged against a FRESH estimate, not the estimate echoed in body.estimate
  // — the operator's copy may be stale or shaped by the client.
  if (body.budgetPerRunUsd !== undefined && body.budgetPerRunUsd !== null) {
    const budget = body.budgetPerRunUsd;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
      throw new ValidationError('budgetPerRunUsd must be a non-negative number');
    }
    const repoSample = body.agentProjectId ? await runCostSamples(model, String(body.agentProjectId)) : null;
    const fresh = selectEstimate(model, repoSample, await runCostSamples(model, null));
    const gate = decideRunBudget(budget, fresh.costUsdP75, body.confirmOverBudget === true);
    if (gate.kind === 'confirm') {
      res.status(409).json({ error: gate.reason, estimate: fresh });
      return;
    }
  }

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

botsRouter.get('/marketplace-runs', readGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  res.json({ runs: await listMarketplaceRuns(orgProjectId) });
}));

// ─── CRUD ────────────────────────────────────────────────────────────────────

botsRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  res.json({ bots: await listBots() });
}));

botsRouter.post('/', manageGate, asyncHandler(async (req, res) => {
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
  checkFieldTypes(body);

  const bot = await createBot({
    name, template: body.template as BotTemplate, prompt, model,
    trigger: body.trigger as BotTrigger, cronExpr: body.cronExpr ?? null,
    agentProjectId: body.agentProjectId ?? null, orgProjectId: body.orgProjectId ?? null,
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    budgetPerRunUsd: body.budgetPerRunUsd ?? null,
    budgetPerDayUsd: body.budgetPerDayUsd ?? null,
    ...(body.maxRunsPerDay !== undefined ? { maxRunsPerDay: body.maxRunsPerDay } : {}),
    ...(body.requiresReview !== undefined ? { requiresReview: body.requiresReview } : {}),
    createdBy: req.session?.sub ?? null,
  });
  if (!bot) { res.status(503).json({ error: 'bots require Aurora' }); return; }
  registerBot(bot);
  res.status(201).json({ bot });
}));

botsRouter.get('/:id', readGate, asyncHandler(async (req, res) => {
  const bot = await getBot(String(req.params['id'] ?? ''));
  if (!bot) throw new NotFoundError('No such bot');
  res.json({ bot });
}));

botsRouter.patch('/:id', manageGate, asyncHandler(async (req, res) => {
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
  checkFieldTypes(patch);

  const bot = await updateBot(id, patch);
  if (!bot) throw new NotFoundError('No such bot');
  // registerBot re-schedules or clears as the new shape dictates.
  registerBot(bot);
  res.json({ bot });
}));

botsRouter.delete('/:id', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const ok = await deleteBot(id);
  if (!ok) throw new NotFoundError('No such bot');
  unregisterBot(id);
  res.json({ ok: true });
}));

// ─── Controls ────────────────────────────────────────────────────────────────

botsRouter.post('/:id/run', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const body = (req.body ?? {}) as { instruction?: string; confirmOverBudget?: boolean };
  const instruction = String(body.instruction ?? '').trim();

  // The per-run budget gate: a bot carrying budgetPerRunUsd is judged against
  // a fresh estimate (the bot's model, its repo's history) before dispatch.
  // Over budget demands an explicit confirmOverBudget — 409 with the estimate
  // attached so the operator sees what they are confirming.
  const bot = await getBot(id);
  if (bot?.budgetPerRunUsd != null) {
    const repoSample = bot.agentProjectId ? await runCostSamples(bot.model, bot.agentProjectId) : null;
    const fresh = selectEstimate(bot.model, repoSample, await runCostSamples(bot.model, null));
    const gate = decideRunBudget(bot.budgetPerRunUsd, fresh.costUsdP75, body.confirmOverBudget === true);
    if (gate.kind === 'confirm') {
      res.status(409).json({ error: gate.reason, estimate: fresh });
      return;
    }
  }

  const result = await fireBot(id, {
    trigger: 'manual', ...(instruction ? { instruction } : {}),
  });
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.status(202).json({ run: result.run });
}));

botsRouter.post('/:id/pause', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!await getBot(id)) throw new NotFoundError('No such bot');
  const reason = String((req.body as { reason?: string } ?? {}).reason ?? '').trim();
  await setPausedReason(id, reason || 'paused by operator');
  res.json({ bot: await getBot(id) });
}));

botsRouter.post('/:id/resume', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!await getBot(id)) throw new NotFoundError('No such bot');
  // Resume clears BOTH halves of "paused": the operator/self-pause reason and
  // the enabled flag. Either alone would leave a bot that looks resumed but
  // still refuses to fire.
  await setPausedReason(id, null);
  await updateBot(id, { enabled: true });
  res.json({ bot: await getBot(id) });
}));

botsRouter.get('/:id/runs', readGate, asyncHandler(async (req, res) => {
  res.json({ runs: await listBotRuns(String(req.params['id'] ?? ''), 50) });
}));

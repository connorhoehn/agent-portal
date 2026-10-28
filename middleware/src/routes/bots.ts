// Bots — /api/bots
//
// The roster of durable, mission-configured agents: create one from the
// wizard, run it now, pause it, watch its firings.
//
// Gated per-route, because several different authorities meet on this surface:
//   reads     — operational visibility (the roster, a bot's runs): org-leader
//               + hr-admin, like the other read-wide surfaces.
//   bot CRUD  — creating/patching/firing a bot dispatches the same governed
//               runs the SDLC and Codebases surfaces do: ManageDevbox.
//   dispatch  — authorizing a sized work item into a run is a marketplace
//               decision, not devbox administration: DispatchAgentRun, so
//               org-leaders can dispatch without holding the devbox keys.
//   market    — the estimator and the marketplace runs ride the dispatch
//               authority, because an SME who may dispatch must be able to see
//               what it will cost first.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { degradedFields } from '../lib/upstream.js';
import { readForRolesElseAction, requireAction, requireSession } from '../lib/authz.js';
import {
  listBotsResult, getBot, createBot, updateBot, deleteBot, setPausedReason, listBotRunsResult,
  listBotRunsForBotsResult,
  listMarketplaceRuns,
  listActiveRuns, runCostSamples, perPointCostSamples,
  type BotTemplate, type BotTrigger, type BotPatch,
} from '../providers/bots.js';
import {
  fireBot, dispatchWorkItem, preflightWorkItem, decideRunBudget, decideAllocation,
  decideEnvelope, loadEnvelope, grantScopedDispatchVerdict, resolveBotInitiativeId,
} from '../lib/bot-runner.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import {
  getWorkItem, recordWorkItemEstimate, reviewWorkItemEstimate,
} from '../providers/work-items.js';
import { getBudget, getMaintenance30d } from '../providers/budgets.js';
import { listAgentProjects } from '../providers/agent-projects.js';
import { registerBot, unregisterBot } from '../lib/bot-scheduler.js';
import { validateCronExpr } from '../lib/ingest-scheduler.js';
import { selectDispatchForecast, type ForecastSamples } from '../lib/marketplace-estimate.js';

export const botsRouter: Router = Router();

// The gate tiers (see the header). readGate only fast-paths GETs, so attaching
// it to a read route is exactly "org-leader/hr-admin/admin may look, anyone
// else needs ManageDevbox".
// ManageBots, not ManageDevbox: authoring a standing mission is its own
// authority (sme + program-owner + leaders hold it in Cedar) and no longer
// implies the microVM surface.
const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBots');
const manageGate = requireAction('ManageBots');
const dispatchGate = requireAction('DispatchAgentRun');
// Reads that belong to the DISPATCH journey rather than to bot administration:
// the estimator and the runs behind the initiative board. An SME holds
// DispatchAgentRun and nothing else, so gating these on ManageDevbox locks the
// role out of the very thing it exists to do — the portal disables Authorize
// while the estimate is null, so a 403 here latches the button off permanently
// and the failure reads as "estimate unavailable" rather than "you lack
// permission". Declared up here with the other tiers because the estimate
// route is registered before the marketplace ones.
const marketReadGate = readForRolesElseAction(['org-leader', 'hr-admin'], 'DispatchAgentRun');

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

/**
 * Every sample the estimator can draw on, then the pure selector over them.
 * Both the estimate the operator reads and the forecast the allocation brake
 * judges come through here — they used to be two expressions of the same
 * fallback chain and they disagreed exactly where it mattered (see
 * selectDispatchForecast). Per-point samples are skipped for an unsized item
 * because they cannot be scaled without points; everything else is fetched so
 * the chain is decided by the selector, not by which query happened to run.
 */
async function loadForecast(model: string, agentProjectId: string | null, points: number | null) {
  const sized = points != null && points > 0;
  const samples: ForecastSamples = {
    perPointRepo: sized && agentProjectId ? await perPointCostSamples(model, agentProjectId) : null,
    perPointModel: sized ? await perPointCostSamples(model, null) : null,
    runRepo: agentProjectId ? await runCostSamples(model, agentProjectId) : null,
    runModel: await runCostSamples(model, null),
  };
  return selectDispatchForecast(model, points, samples);
}

/** The wire shape of an estimate: the range, plus the two labels that stop it
 *  being read as more than it is. */
function estimateBody(f: Awaited<ReturnType<typeof loadForecast>>) {
  return { ...f.estimate, points: f.points, scaled: f.scaled, confidence: f.confidence };
}

// ─── The confirmation flags ──────────────────────────────────────────────────
//
// Three soft money gates can refuse one dispatch, and they are three DIFFERENT
// limits set by three different people:
//
//   run budget  the caller's own cap for this one run ("don't start it if it
//               is forecast over $X") — theirs, nobody else's;
//   allocation  the initiative's monthly allocation, set by a release manager;
//   envelope    the caller's sprint envelope, granted to them by a release
//               manager (budget_grants).
//
// They used to share one `confirmOverBudget`, with a comment claiming that was
// safe because the portal never sent budgetPerRunUsd. That was true and it was
// also the reason the per-run gate could never be wired to the portal: the
// moment a client sends both, one click silently answers two questions the
// operator was only shown one of. Each gate now names its own flag, in the 409
// it returns and in the reason text, so a confirmation can only ever confirm
// the fence it was shown.
//
// `confirmOverBudget` is kept as a DEPRECATED synonym for the two gates that
// existed while it was the only flag — nothing that predates the split breaks.
// It deliberately does NOT confirm the sprint envelope: that gate postdates the
// flag, so no existing caller can be stuck behind it, and widening a flag we
// are retiring would re-create the defect in a newer place. An envelope 409
// names confirmOverEnvelope and that is the only thing that opens it.
interface ConfirmFlags {
  confirmOverBudget?: unknown;
  confirmOverRunBudget?: unknown;
  confirmOverAllocation?: unknown;
  confirmOverEnvelope?: unknown;
}

function readConfirmations(body: ConfirmFlags) {
  const legacy = body.confirmOverBudget === true;
  return {
    runBudget: body.confirmOverRunBudget === true || legacy,
    allocation: body.confirmOverAllocation === true || legacy,
    envelope: body.confirmOverEnvelope === true,
  };
}

// marketReadGate, not readGate: the estimate is what the Authorize button
// waits on, so a role holding only DispatchAgentRun (sme) must be able to read
// it or the button latches off forever.
botsRouter.get('/estimate', marketReadGate, asyncHandler(async (req, res) => {
  const model = String(req.query['model'] ?? '').trim();
  if (!model) throw new ValidationError('model is required');
  const agentProjectId = req.query['agentProjectId'] ? String(req.query['agentProjectId']) : null;
  const pointsRaw = Number(req.query['points']);
  const points = Number.isFinite(pointsRaw) && pointsRaw > 0 ? pointsRaw : null;
  res.json(estimateBody(await loadForecast(model, agentProjectId, points)));
}));

// ─── Marketplace ─────────────────────────────────────────────────────────────
// Declared before the '/:id' routes so 'dispatch-work' and 'marketplace-runs'
// are never read as bot ids.

botsRouter.post('/dispatch-work', dispatchGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as ConfirmFlags & {
    workItemId?: string; model?: string; agentProjectId?: string; instruction?: string;
    estimate?: Record<string, unknown>; budgetPerRunUsd?: unknown;
  };
  const confirmed = readConfirmations(body);
  const workItemId = String(body.workItemId ?? '').trim();
  if (!workItemId) throw new ValidationError('workItemId is required');
  const model = String(body.model ?? '').trim();
  if (!model) throw new ValidationError('model is required');
  if (body.agentProjectId != null && !isUuid(String(body.agentProjectId))) {
    throw new ValidationError('agentProjectId must be a codebase UUID');
  }
  const instruction = String(body.instruction ?? '').trim();
  const actor = req.session?.sub;
  let budgetPerRunUsd: number | null = null;
  if (body.budgetPerRunUsd !== undefined && body.budgetPerRunUsd !== null) {
    if (typeof body.budgetPerRunUsd !== 'number' || !Number.isFinite(body.budgetPerRunUsd)
        || body.budgetPerRunUsd < 0) {
      throw new ValidationError('budgetPerRunUsd must be a non-negative number');
    }
    budgetPerRunUsd = body.budgetPerRunUsd;
  }

  // ── 0. Existence ───────────────────────────────────────────────────────────
  // Fetched once, up front: the grant-scoped check below needs the initiative
  // (item.projectId) before shape/codebase questions are even asked, and
  // preflightWorkItem accepts this same item so it never re-fetches it.
  const item = await getWorkItem(workItemId);
  if (!item) { res.status(404).json({ error: 'no such work item' }); return; }

  // ── 1. Grant-scoped authorization, before shape or money ──────────────────
  // An SME may only dispatch against an initiative they hold an ACTIVE sprint
  // grant on — they spend inside an envelope someone else authorized. This is
  // authorization (a hard 403), distinct from the envelope brake below, which
  // enforces the money OF that grant, and it runs before the codebase/shape
  // preflight: an ungranted SME must hear "you have no grant here", not "no
  // codebase delivers this initiative" (a refusal for a reason they cannot
  // act on and that used to fire first). org-leader/hr-admin/admin allocate
  // and need no grant. An unavailable SME grant read answers 503 before any
  // preflight or money gate; it cannot be treated as permission to dispatch.
  const verdict = await grantScopedDispatchVerdict(item.projectId, req.session);
  if (verdict.kind === 'deny') {
    res.status(403).json({ error: verdict.reason });
    return;
  }
  if (verdict.kind === 'unavailable') {
    res.status(503).json({ error: verdict.reason, gate: 'grant-authorization' });
    return;
  }

  // ── 2. Shape, before money ────────────────────────────────────────────────
  // Is this thing dispatchable at all, and against which codebase? The budget
  // gates used to run first, so a `done` item that also overran its allocation
  // asked the operator to confirm spending over budget and only THEN told them
  // the item was never dispatchable. Nobody should be asked to authorize spend
  // on work that cannot run.
  const pre = await preflightWorkItem(
    workItemId, body.agentProjectId ? String(body.agentProjectId) : undefined, req.session?.role, item,
  );
  if (!pre.ok) {
    // 400 undispatchable, 404 missing, 409 ambiguous codebase (with options).
    res.status(pre.status).json({ error: pre.error, ...(pre.options ? { options: pre.options } : {}) });
    return;
  }

  // ── 3. One fresh forecast, for both money gates ───────────────────────────
  // Fresh on purpose: never the estimate echoed in body.estimate, which may be
  // stale or shaped by the client. Priced against the codebase preflight
  // resolved, so a server-picked repo is still priced on its own history.
  const forecast = await loadForecast(model, pre.agentProjectId, pre.item.storyPoints);

  // ── 4. Per-run budget, request-supplied (no bot here carries one) ─────────
  // The operator's own cap on this one run. First because it is the cheapest
  // and the most personal: someone who said "not over $2" should hear about
  // that before being told anything about other people's fences.
  if (budgetPerRunUsd != null) {
    const gate = decideRunBudget(budgetPerRunUsd, forecast.estimate.costUsdP75, confirmed.runBudget);
    if (gate.kind === 'confirm') {
      res.status(409).json({
        error: gate.reason,
        gate: 'run-budget',
        confirmFlag: 'confirmOverRunBudget',
        estimate: estimateBody(forecast),
        runBudget: {
          budgetPerRunUsd,
          costUsdP25: forecast.estimate.costUsdP25,
          costUsdP75: forecast.estimate.costUsdP75,
        },
      });
      return;
    }
  }

  // ── 5. The initiative's allocation, as a brake rather than a report ───────
  // Dispatching work whose forecast does not fit the money left this period
  // demands the same explicit confirmation the per-run cap does.
  //
  // Two things this deliberately does NOT skip any more. It no longer needs a
  // per-point basis: with zero runs bound to sized work items in this
  // deployment, "no per-point basis" meant the brake could not fire at all,
  // and could never fire on a FIRST dispatch — the one with no history and the
  // best chance of blowing a small allocation. It now judges whatever forecast
  // exists and says how much that forecast is worth (decideAllocation). Nor
  // does it need the item to be pointed: an unsized story still spends money.
  //
  // Still skipped: an initiative with NO allocation row. Unbudgeted is not
  // zero-budget — that surfaces as a blind spot on the Budgets page, and
  // freezing an unfunded initiative here would be the wrong answer to it.
  //
  // The gate reads its own flag, so confirming the per-run cap above says
  // nothing here — and the 409 names the flag that would open it.
  const budgetRow = await getBudget(pre.item.projectId);
  if (budgetRow?.allocatedUsd != null) {
    const gate = decideAllocation(
      { allocatedUsd: budgetRow.allocatedUsd, spentUsd: budgetRow.spentThisPeriodUsd },
      {
        costUsdP75: forecast.estimate.costUsdP75,
        costUsdP25: forecast.estimate.costUsdP25,
        confidence: forecast.confidence,
      },
      confirmed.allocation,
    );
    if (gate.kind === 'confirm') {
      res.status(409).json({
        error: gate.reason,
        gate: 'allocation',
        confirmFlag: 'confirmOverAllocation',
        confidence: gate.confidence,
        estimate: estimateBody(forecast),
        allocation: {
          orgProjectId: pre.item.projectId,
          allocatedUsd: budgetRow.allocatedUsd,
          spentUsd: budgetRow.spentThisPeriodUsd,
          remainingUsd: budgetRow.allocatedUsd - budgetRow.spentThisPeriodUsd,
        },
      });
      return;
    }
  }

  // ── 6. The caller's own sprint envelope ───────────────────────────────────
  // The last brake, and the narrowest: a release manager granted THIS person a
  // spend envelope for this sprint (budget_grants), and until now nothing
  // checked it. Last on purpose — the initiative running out of money is the
  // more fundamental fact and deserves to be said first; a person's envelope is
  // only interesting while the initiative still has money to spend.
  //
  // No grant → no brake. Someone dispatching here without an envelope (a
  // release manager, an hr-admin) is the allocation brake's business.
  const envelope = await loadEnvelope(pre.item.projectId, actor);
  if (envelope) {
    const gate = decideEnvelope(
      envelope,
      {
        costUsdP75: forecast.estimate.costUsdP75,
        costUsdP25: forecast.estimate.costUsdP25,
        confidence: forecast.confidence,
      },
      confirmed.envelope,
    );
    if (gate.kind === 'confirm') {
      res.status(409).json({
        error: gate.reason,
        gate: 'envelope',
        confirmFlag: 'confirmOverEnvelope',
        confidence: gate.confidence,
        estimate: estimateBody(forecast),
        envelope: {
          orgProjectId: pre.item.projectId,
          grantId: envelope.grantId,
          sprintId: envelope.sprintId,
          sprintName: envelope.sprintName ?? null,
          allocatedUsd: envelope.allocatedUsd,
          // Named for what it is. Not "your spend" — only runs recorded as
          // dispatched by this subject are counted, and none were before the
          // attribution column existed.
          attributedSpentUsd: envelope.attributedSpentUsd,
          remainingUsd: envelope.allocatedUsd - envelope.attributedSpentUsd,
          attributionAvailable: envelope.attributionAvailable,
        },
      });
      return;
    }
  }

  const result = await dispatchWorkItem({
    workItemId, model, preflight: pre,
    ...(body.agentProjectId ? { agentProjectId: String(body.agentProjectId) } : {}),
    ...(instruction ? { instruction } : {}),
    ...(actor ? { actor } : {}),
    ...(body.estimate && typeof body.estimate === 'object' ? { estimate: body.estimate } : {}),
  });
  if (!result.ok) {
    // Shape refusals were answered by the preflight above; what is left is the
    // dispatcher's own: 429 concurrency, 409 already being worked, 503
    // infrastructure (no workspace, the run would not start).
    res.status(result.status).json({
      error: result.error, ...(result.options ? { options: result.options } : {}),
    });
    return;
  }
  // The dispatch succeeded, so the forecast the operator was looking at is now
  // a decision somebody took. Record it with the session subject — never the
  // body — so the item can later say "estimated by X, <when>, on <model>"
  // instead of recomputing a number with nobody's name on it.
  //
  // Deliberately AFTER the dispatch and deliberately not awaited into the
  // response: a bookkeeping write must never be the reason a run that already
  // started reports failure. A lost estimate is a missing label; a 500 here
  // would be a phantom failure on a run that is live.
  if (actor && body.estimate && typeof body.estimate === 'object') {
    const forecast = body.estimate as Record<string, unknown>;
    const p75 = Number(forecast['costUsdP75']);
    void recordWorkItemEstimate(
      workItemId, actor, model, forecast,
      Number.isFinite(p75) ? p75 : null,
    ).catch((err: unknown) => {
      console.warn('[bots] estimate not recorded for', workItemId, err);
    });
  }
  res.status(202).json({ run: result.run });
}));

/**
 * Record an estimate WITHOUT spending anything.
 *
 * This is the write path that makes a "standing estimate" a thing that can
 * exist. Originally the only writer was a successful dispatch, on the theory —
 * borrowed from `bot_runs.dispatched_by` — that only a real firing should be
 * attributed. That analogy was wrong here, and provably so: dispatching moves
 * the item `open -> in_progress`, so an estimate written by a dispatch belongs
 * to a row that is already running. The estimate could never be READ before it
 * was spent, which is the only moment it is worth anything.
 *
 * The distinction that actually matters is AUTHORIZED vs CANCELLED, not
 * dispatched vs not. An operator who computes a forecast and saves it has made
 * a decision somebody can be asked about; they simply have not spent yet.
 * Closing the drawer still writes nothing.
 *
 * Gated on DispatchAgentRun, not on a softer read capability: putting your name
 * on a number that authorizes spend is a spending-adjacent act, even though
 * this call moves no money.
 */
botsRouter.post('/work-items/:id/estimate', dispatchGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '').trim();
  if (!id) throw new ValidationError('work item id is required');
  const actor = req.session?.sub;
  if (!actor) { res.status(401).json({ error: 'a session is required to record an estimate' }); return; }

  const body = req.body as { model?: unknown; estimate?: unknown };
  const model = String(body.model ?? '').trim();
  if (!model) throw new ValidationError('model is required — a forecast is only valid for the model it was computed against');
  if (!body.estimate || typeof body.estimate !== 'object' || Array.isArray(body.estimate)) {
    throw new ValidationError('estimate must be the forecast object that was shown');
  }

  // 404 before the write: recording an estimate against an id that does not
  // exist would silently succeed as a no-op UPDATE and report success.
  if (!await getWorkItem(id)) { res.status(404).json({ error: 'no such work item' }); return; }

  const forecast = body.estimate as Record<string, unknown>;
  const p75 = Number(forecast['costUsdP75']);
  // Awaited, unlike the dispatch path's fire-and-forget: there, a bookkeeping
  // failure must not fail a run that is already live. Here the bookkeeping IS
  // the request, so a failure is the honest answer.
  await recordWorkItemEstimate(id, actor, model, forecast, Number.isFinite(p75) ? p75 : null);
  res.json({ item: await getWorkItem(id) });
}));

/**
 * Advisory SME sign-off on a work item's stored estimate.
 *
 * Gated on ManageIngest-tier dispatch rights rather than a new capability: the
 * people who can spend against an initiative are the people whose sign-off on a
 * forecast means anything. Does NOT gate dispatch — see
 * schema/work_item_estimate_schema.sql for why a fifth hard gate was refused.
 */
botsRouter.post('/work-items/:id/review-estimate', dispatchGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '').trim();
  if (!id) throw new ValidationError('work item id is required');
  const actor = req.session?.sub;
  if (!actor) { res.status(401).json({ error: 'a session is required to review an estimate' }); return; }
  const ok = await reviewWorkItemEstimate(id, actor);
  if (!ok) {
    // 409, not 404: the item may well exist. What is missing is an estimate to
    // review, and saying so is more useful than "not found".
    res.status(409).json({ error: 'this work item has no recorded estimate to review' });
    return;
  }
  res.json({ item: await getWorkItem(id) });
}));

/**
 * Everything the fleet is running right now.
 *
 * A session floor, not a capability gate: "what is currently burning money in
 * my org" is a question every signed-in role may ask, and the runs it lists are
 * already visible per-initiative to anyone who can open the initiative. The
 * BOX behind a run is a separate authorization, enforced at the lab.
 *
 * Each row carries the ids the caller needs to get somewhere useful — the box
 * to tail, and the work item it belongs to — because the failure this route
 * exists for is "I ran a task and then I lost it".
 */
botsRouter.get('/active-runs', requireSession('ActiveRuns'), asyncHandler(async (_req, res) => {
  const runs = await listActiveRuns();
  // Titles resolved one by one through getWorkItem rather than joined in SQL.
  // The list is capped at 25, and getWorkItem already carries the missing-table
  // guard — a JOIN would take the whole query down on a cluster without
  // work_items, turning "no titles" into "no runs", which is the exact failure
  // this route exists to prevent.
  const enriched = await Promise.all(runs.map(async (run) => {
    if (!run.workItemId) return { ...run, workItemTitle: null, projectId: null };
    const item = await getWorkItem(run.workItemId);
    // projectId travels with the run because not every caller can open the
    // Computer Lab: ManageDevbox is held by hr-admin and sme, NOT by
    // org-leader, who can nonetheless dispatch. Without the initiative id
    // there is no destination such a caller is allowed to reach, which is
    // precisely how a dispatched run became unfindable.
    return { ...run, workItemTitle: item?.title ?? null, projectId: item?.projectId ?? null };
  }));
  res.json({ runs: enriched });
}));

botsRouter.get('/marketplace-runs', marketReadGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  res.json({ runs: await listMarketplaceRuns(orgProjectId) });
}));

// GET /api/bots/initiative-runs?orgProjectId=p-…
//
// The runs on one initiative for any signed-in orgiq reader — the initiative
// page's Agents tab. The roster (`GET /`) and run history (`/runs`) stay
// gated because they carry bot CONFIGURATION (prompt, model, budgets, cron,
// review policy); the runs themselves are what the work queue already shows
// every session (`GET /api/work/jobs` is a session floor, CLAUDE.md "The auth
// floor"), so this answers with the runs plus each bot's id and name only.
// A member opening an initiative used to see "no runs" over nine real ones.
//
// Which bots count: those pointed at the initiative directly, or through a
// codebase that delivers it — the same rule the portal's activity hook uses.
botsRouter.get('/initiative-runs', requireSession('InitiativeRuns'), asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  const [roster, codebases, marketplace] = await Promise.all([
    listBotsResult(), listAgentProjects(), listMarketplaceRuns(orgProjectId),
  ]);
  const codebaseIds = new Set(codebases.filter((c) => c.orgProjectId === orgProjectId).map((c) => c.id));
  const bots = roster.items
    .filter((b) => b.orgProjectId === orgProjectId || (b.agentProjectId != null && codebaseIds.has(b.agentProjectId)))
    .map((b) => ({ id: b.id, name: b.name }));
  const history = bots.length > 0
    ? await listBotRunsForBotsResult(bots.map((b) => b.id), 50)
    : { items: [] };
  const seen = new Set<string>();
  const runs = [...marketplace, ...history.items].filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
  // The 30-day maintenance floor as `v_initiative_maintenance_30d` states it (cron-triggered
  // COSTED runs attributed to the initiative) — the same value the Budgets ledger reads, decided
  // here, never summed in a browser from a capped run list with unknown costs counted as zero
  // (CLAUDE.md: unknown burn is unknown, not zero). Null when the view could not be read.
  let maintenance30d: Awaited<ReturnType<typeof getMaintenance30d>> | null = null;
  try { maintenance30d = await getMaintenance30d(orgProjectId); } catch { maintenance30d = null; }
  res.json({ runs, bots, maintenance30d, ...(roster.degraded ? degradedFields(roster) : degradedFields(history)) });
}));

// GET /api/bots/runs?botIds=a,b,c
//
// Bulk run history for several bots in one request — what
// `InitiativeAgentRail` needs to feed its Agents/Outcomes cards without
// firing one `/:id/runs` per bot targeting the initiative (the N+1 the rail
// used to do). Registered ahead of `/:id` below: Express would otherwise
// route this path to the param handler with id="runs".
botsRouter.get('/runs', readGate, asyncHandler(async (req, res) => {
  const raw = String(req.query['botIds'] ?? '').trim();
  const botIds = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (botIds.length === 0) { res.json({ runs: [] }); return; }
  const history = await listBotRunsForBotsResult(botIds, 50);
  res.json({ runs: history.items, ...degradedFields(history) });
}));

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * The bot roster.
 *
 * `{ bots: [] }` meant two things and rendered as one: no bots are configured
 * (ordinary, and the "create a bot" affordance is written for it), or the
 * `bots` table does not exist on this cluster (providers/bots.ts `safeExec`
 * swallows a missing relation so a pre-migration cluster renders a page rather
 * than a 500). The second one is a page inviting an operator to create a bot
 * into a table that is not there. The provider says which now, and only the
 * failure changes shape — a healthy empty roster is byte-identical to what
 * this route always sent:
 *
 *   { bots: [] }                             nothing is configured
 *   { bots: [], degraded: true, error }      we could not read the roster
 */
botsRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  const roster = await listBotsResult();
  res.json({ bots: roster.items, ...degradedFields(roster) });
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
  // A bot spends on the initiative it targets (directly, or through the
  // codebase it maintains), so creating one there is the steward's call (DE-44).
  const target = await resolveBotInitiativeId({ orgProjectId: body.orgProjectId ?? null, agentProjectId: body.agentProjectId ?? null });
  if (!await requireInitiativeScope(req, res, target, { action: 'create bots' })) return;

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
    'budgetPerRunUsd', 'budgetPerDayUsd', 'maxRunsPerDay', 'requiresReview',
    'enforceAllocation'] as const) {
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
  // Steward of the bot's initiative now, and of the one it is being moved to:
  // retargeting moves its spend, and the patch can also clear its brakes.
  if (!await requireInitiativeScope(req, res, await resolveBotInitiativeId(existing), { action: 'manage bots' })) return;
  if (patch.orgProjectId !== undefined || patch.agentProjectId !== undefined) {
    const next = await resolveBotInitiativeId({
      orgProjectId: patch.orgProjectId !== undefined ? (patch.orgProjectId ?? null) : existing.orgProjectId,
      agentProjectId: patch.agentProjectId !== undefined ? (patch.agentProjectId ?? null) : existing.agentProjectId,
    });
    if (!await requireInitiativeScope(req, res, next, { action: 'manage bots' })) return;
  }

  const bot = await updateBot(id, patch);
  if (!bot) throw new NotFoundError('No such bot');
  // registerBot re-schedules or clears as the new shape dictates.
  registerBot(bot);
  res.json({ bot });
}));

botsRouter.delete('/:id', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const existing = await getBot(id);
  if (!existing) throw new NotFoundError('No such bot');
  if (!await requireInitiativeScope(req, res, await resolveBotInitiativeId(existing), { action: 'manage bots' })) return;
  const ok = await deleteBot(id);
  if (!ok) throw new NotFoundError('No such bot');
  unregisterBot(id);
  res.json({ ok: true });
}));

// ─── Controls ────────────────────────────────────────────────────────────────

botsRouter.post('/:id/run', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const body = (req.body ?? {}) as ConfirmFlags & { instruction?: string };
  const instruction = String(body.instruction ?? '').trim();
  // Same split as dispatch-work — the per-run gate is the same gate, so the
  // flag that opens it must be the same word on both routes.
  const confirmed = readConfirmations(body);

  // The per-run budget gate: a bot carrying budgetPerRunUsd is judged against
  // a fresh estimate (the bot's model, its repo's history) before dispatch.
  // Over budget demands an explicit confirmOverRunBudget — 409 with the
  // estimate attached so the operator sees what they are confirming.
  const bot = await getBot(id);
  if (!bot) throw new NotFoundError('No such bot');
  // A manual run spends on the bot's initiative: steward, and the grant an SME
  // spends under (DE-44 row 3). The envelope and allocation brakes the
  // dispatch route runs are DE-34/DE-36.
  if (!await requireInitiativeScope(req, res, await resolveBotInitiativeId(bot), { spend: true, action: 'run bots' })) return;
  if (bot.budgetPerRunUsd != null) {
    // A bot fires a whole run, not a sized item, so points is null and the
    // forecast is run-level by construction — same loader as the marketplace,
    // so a bot and a work item are never priced by two different chains.
    const forecast = await loadForecast(bot.model, bot.agentProjectId, null);
    const gate = decideRunBudget(
      bot.budgetPerRunUsd, forecast.estimate.costUsdP75, confirmed.runBudget,
    );
    if (gate.kind === 'confirm') {
      res.status(409).json({
        error: gate.reason,
        gate: 'run-budget',
        confirmFlag: 'confirmOverRunBudget',
        estimate: estimateBody(forecast),
        runBudget: {
          budgetPerRunUsd: bot.budgetPerRunUsd,
          costUsdP25: forecast.estimate.costUsdP25,
          costUsdP75: forecast.estimate.costUsdP75,
        },
      });
      return;
    }
  }

  const result = await fireBot(id, {
    trigger: 'manual', ...(instruction ? { instruction } : {}),
    // A hand-driven firing has an author; a cron one does not. Recording it is
    // what lets a sprint envelope be burned down against a person at all.
    dispatchedBy: req.session?.sub ?? null,
  });
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.status(202).json({ run: result.run });
}));

botsRouter.post('/:id/pause', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const existing = await getBot(id);
  if (!existing) throw new NotFoundError('No such bot');
  if (!await requireInitiativeScope(req, res, await resolveBotInitiativeId(existing), { action: 'manage bots' })) return;
  const reason = String((req.body as { reason?: string } ?? {}).reason ?? '').trim();
  await setPausedReason(id, reason || 'paused by operator');
  // Disarm the live cron too — a paused bot that keeps firing until the next
  // restart is the same defect as resume, mirrored.
  unregisterBot(id);
  res.json({ bot: await getBot(id) });
}));

botsRouter.post('/:id/resume', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const existing = await getBot(id);
  if (!existing) throw new NotFoundError('No such bot');
  // Resume re-arms a cron that spends on the bot's initiative (DE-44 row 4).
  if (!await requireInitiativeScope(req, res, await resolveBotInitiativeId(existing), { spend: true, action: 'resume bots' })) return;
  // Resume clears BOTH halves of "paused": the operator/self-pause reason and
  // the enabled flag. Either alone would leave a bot that looks resumed but
  // still refuses to fire.
  await setPausedReason(id, null);
  const bot = await updateBot(id, { enabled: true });
  // Register with the LIVE scheduler, not just the database. Without this a
  // resumed cron bot looked armed everywhere — enabled, no paused reason —
  // but its cron only existed in processes booted after the resume, so it
  // silently never fired until the next middleware restart. Found resuming
  // eleven seeded bots after repo provisioning: the roster said 11 enabled,
  // the scheduler still said 0.
  if (bot) registerBot(bot);
  res.json({ bot: bot ?? await getBot(id) });
}));

/** One bot's firing history. Same two empties as the roster above — and here
 *  the swallowed one is worse, because "this bot has never fired" is the exact
 *  question the page is opened to answer. */
botsRouter.get('/:id/runs', readGate, asyncHandler(async (req, res) => {
  const history = await listBotRunsResult(String(req.params['id'] ?? ''), 50);
  res.json({ runs: history.items, ...degradedFields(history) });
}));

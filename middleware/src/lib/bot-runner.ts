// Firing a bot — from a trigger to one governed run, with the brakes applied.
//
// Every trigger path (manual, cron, later pr_watch) converges here, so the
// guard ordering cannot drift between them: a disabled or paused bot refuses
// without leaving a run row (there was nothing to skip — the bot is off); a
// run-cap or budget refusal records a `skipped` bot_run, because a trigger
// that fired and was braked is an event the operator should see on the bot
// page, not a silent nothing.
//
// Dispatch reuses the existing machinery wholesale: repo-target bots go
// through dispatchGovernedRun (capture → review → gates → human), initiative
// bots enqueue an agent_jobs row for the fleet dispatcher. A bot adds no new
// way for code to change ungoverned.
//
// The work marketplace (dispatchWorkItem) is the bot-less sibling: a sized
// story or bug is authorized directly into a governed run bound to its work
// item, recorded as a bot_run with bot_id NULL. Same workspace machinery,
// same governance, no bot row.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  getBot, createBotRun, finalizeBotRun, setPausedReason, markBotRan, countRunningRuns,
  dispatchedSpendInWindow,
  type BotRun,
} from '../providers/bots.js';
// Read-only imports. providers/budgets.ts owns the envelope's ledger shape and
// is not edited from here — the brake consumes listGrants exactly as the
// Budgets page does, so the number an SME is stopped by and the number they see
// come from one query.
import { listGrants } from '../providers/budgets.js';
import { getUser } from '../providers/identity.js';
import {
  getAgentProject, listAgentProjects, buildCloneCommand, markCloned, type AgentProject,
} from '../providers/agent-projects.js';
import { getWorkItem, updateWorkItem, addWorkItemComment, type WorkItem } from '../providers/work-items.js';
import { enqueueJob } from '../providers/agent-jobs.js';
import { dispatchGovernedRun } from './sdlc-pipeline.js';
import { runDevboxShell } from './project-runner.js';
import { resolveDevboxArn, devboxDataClient } from './devbox-arn.js';
import { registerBox, getBoxBySession } from './devbox-fleet.js';
import { normalizeRuntimeSessionId } from './runtime-session.js';
import type { ForecastConfidence } from './bot-estimate.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

// The portal's clone-check heuristic: the devbox command API streams text with
// no exit-code marker, so a failed clone is recognised by what git says.
const CLONE_FAILURE = /fatal:|repository not found|authentication failed|could not read username/i;

// ─── The guard, pure ──────────────────────────────────────────────────────────

export interface FireGuardInput {
  enabled: boolean;
  pausedReason: string | null;
  maxRunsPerDay: number;
  budgetPerDayUsd: number | null;
  todayRunCount: number;
  todaySpendUsd: number;
}

export type FireDecision =
  | { kind: 'fire' }
  /** Nothing recorded — the bot is off, so the trigger had nothing to skip. */
  | { kind: 'refuse'; reason: string }
  /** Record a skipped bot_run: a live trigger was braked, which is visible history. */
  | { kind: 'skip'; reason: string }
  /** Record a skipped run AND self-pause — the hard daily-budget brake. */
  | { kind: 'pause'; reason: string };

/**
 * Whether this firing may proceed. Ordering is the contract: off/paused first
 * (cheapest, and any other answer would be misleading for a paused bot), then
 * the run cap (independent of cost, so a mispriced model cannot defeat it),
 * then the budget — which is the only one that flips the bot's own state.
 */
export function decideFire(bot: FireGuardInput): FireDecision {
  if (!bot.enabled) return { kind: 'refuse', reason: 'bot is disabled' };
  if (bot.pausedReason) return { kind: 'refuse', reason: `bot is paused: ${bot.pausedReason}` };
  // 0 is "never fires" — a deliberate off-switch, not a cap that was reached
  // today. Refuse (no run row) rather than skip: there was no live trigger
  // being braked, the bot is configured to never run.
  if (bot.maxRunsPerDay === 0) {
    return { kind: 'refuse', reason: 'maxRunsPerDay is 0 — this bot never fires' };
  }
  if (bot.todayRunCount >= bot.maxRunsPerDay) {
    return { kind: 'skip', reason: `max runs per day reached (${bot.maxRunsPerDay})` };
  }
  if (bot.budgetPerDayUsd != null && bot.todaySpendUsd >= bot.budgetPerDayUsd) {
    return { kind: 'pause', reason: 'daily budget reached' };
  }
  return { kind: 'fire' };
}

// ─── The bot-fire allocation brake, pure — OPT-IN, off by default ─────────────
//
// The doc flags this one as "worth an explicit decision", and the decision is:
// this must NOT be a hard brake, and it is OFF unless someone asks for it.
//
// ── Why not a hard brake, and why off by default ─────────────────────────────
// A cron bot IS the maintenance floor. `v_initiative_maintenance_30d` reads bot
// spend as the baseline cost of keeping an initiative's lights on, and an
// allocation is read *against* that floor — so a firing whose spend pushes the
// initiative past its allocation is the floor doing exactly its job, not a bot
// misbehaving. Braking the floor against the allocation is backwards: it would
// strand scheduled maintenance (dependency bumps, drift checks, evidence
// sweeps) the moment feature work ate the month's money — precisely when the
// repo most needs its lights kept on.
//
// It is also a DIFFERENT shape from the three human-facing soft brakes. Those
// answer 409 + confirmFlag, which only means anything to a human at a keyboard:
// a cron trigger has nobody to click "confirm". So the bot-appropriate outcome
// is not `confirm` but `skip` — the same visible, recorded skipped bot_run the
// run-cap already produces, so the operator sees on the bot page that a firing
// was braked and why, and the *next* trigger re-evaluates cleanly (when the
// monthly allocation resets, firing resumes on its own with no human un-pause).
//
// And it is NOT `pause`. Pausing self-strands: a bot that hit its initiative's
// allocation would stay paused for the rest of the period, killing every later
// maintenance firing until a human intervened — the exact stranding this brake
// exists to avoid. Skip is per-firing; pause is until-someone-notices.
//
// Default OFF (`enforceAllocation: false`) preserves the documented design
// wholesale — bot spend stays the floor, unbraked. An operator who wants a
// specific bot bounded by its initiative's allocation opts that one bot in.

export interface BotFireAllocationInput {
  /** Opt-in. False (the default firing path) → no brake, preserving the design
   *  where bot spend is the maintenance floor an allocation is read against.
   *  An operator turns this on per bot to bound its cron spend by the envelope. */
  enforceAllocation: boolean;
  /** The initiative's allocation this period. Null = unbudgeted, which is NOT
   *  zero — an unfunded initiative's maintenance is never braked, the same
   *  posture decideAllocation takes. */
  allocatedUsd: number | null;
  /** Attributed spend on the initiative so far this period. */
  spentUsd: number;
  /** Pessimistic (p75) projection of THIS firing's cost. */
  projectedCostUsd: number;
}

export type BotFireAllocationDecision =
  | { kind: 'proceed' }
  /** Record a skipped bot_run: a live cron trigger was braked, which is visible
   *  history on the bot page — never a self-pause, which would strand the rest
   *  of the period's maintenance. */
  | { kind: 'skip'; reason: string };

/**
 * Whether an OPT-IN cron firing fits inside its initiative's remaining
 * allocation. Pure, and a no-op unless the bot opted in — see the section note
 * for why this is a per-firing skip, never a hard stop or a self-pause, and why
 * it is off by default.
 */
export function decideBotFireAllocation(i: BotFireAllocationInput): BotFireAllocationDecision {
  if (!i.enforceAllocation || i.allocatedUsd == null) return { kind: 'proceed' };
  const remaining = i.allocatedUsd - i.spentUsd;
  if (i.projectedCostUsd <= remaining) return { kind: 'proceed' };
  if (remaining <= 0) {
    return {
      kind: 'skip',
      reason: `initiative allocation exhausted (${money(i.allocatedUsd)} allocated, ${money(i.spentUsd)} spent) — cron firing skipped while allocation enforcement is on for this bot`,
    };
  }
  return {
    kind: 'skip',
    reason: `projected ${money(i.projectedCostUsd)} would exceed the ${money(remaining)} left of this initiative's ${money(i.allocatedUsd)} allocation — cron firing skipped while allocation enforcement is on for this bot`,
  };
}

/**
 * The pipeline contract appended to EVERY dispatched mission. Capture diffs
 * the working tree (commit-per-capture commits on the agent's behalf), so an
 * agent that commits its own work leaves a clean tree and silently escapes
 * governance — a live audit caught exactly that: a successful run, zero
 * change captured. The contract line is the platform's, not the mission
 * author's, so it cannot be forgotten.
 */
const PIPELINE_CONTRACT =
  'Leave your changes UNCOMMITTED in the working tree — do not run git commit. ' +
  'The platform captures your diff, sends it through independent review and policy gates, and commits it for you.';

/** The written mission plus the operator's one-shot steering, when given. */
export function renderPrompt(promptTemplate: string, instruction?: string): string {
  const mission = instruction ? `${promptTemplate}\n\nFor this run specifically: ${instruction}` : promptTemplate;
  return `${mission}\n\n${PIPELINE_CONTRACT}`;
}

// ─── The concurrency ceiling, pure ────────────────────────────────────────────

/** Global cap on simultaneously-running bot_runs (bot AND marketplace). */
export function botMaxConcurrent(): number {
  const n = Number(process.env['BOT_MAX_CONCURRENT']);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export type ConcurrencyDecision = { kind: 'proceed' } | { kind: 'refuse'; reason: string };

/**
 * Whether another run may start while `runningCount` are already going. The
 * count is global — every running bot_run, bot-fired or marketplace — because
 * the ceiling protects the shared devbox pool and the shared budget, neither
 * of which cares which trigger started a run.
 */
export function decideConcurrency(runningCount: number, ceiling = botMaxConcurrent()): ConcurrencyDecision {
  if (runningCount >= ceiling) {
    return { kind: 'refuse', reason: `concurrency ceiling (${ceiling}) reached` };
  }
  return { kind: 'proceed' };
}

/** The guard both dispatch paths share: count what runs, judge the ceiling. */
export async function checkConcurrency(): Promise<ConcurrencyDecision> {
  return decideConcurrency(await countRunningRuns());
}

// ─── The per-run budget gate, pure ────────────────────────────────────────────

export type RunBudgetDecision =
  | { kind: 'proceed' }
  /** The estimate exceeds the per-run budget and the operator has not
   *  confirmed — the route answers 409 with the estimate attached. */
  | { kind: 'confirm'; reason: string };

/**
 * Whether a firing may proceed against its per-run budget. The budget is a
 * soft cap: an estimate's p75 over it demands an explicit confirmOverRunBudget
 * from the operator rather than refusing outright — the estimate is a
 * forecast, not a bill.
 *
 * The flag it names is its OWN. Three soft gates can refuse one dispatch (this
 * one, the initiative allocation, the SME's sprint envelope) and each is a
 * different limit set by a different person; a confirmation that answered all
 * three would mean an operator waving through a fence they were never shown.
 */
export function decideRunBudget(
  budgetPerRunUsd: number | null | undefined,
  costUsdP75: number,
  confirmed: boolean,
): RunBudgetDecision {
  if (budgetPerRunUsd == null || costUsdP75 <= budgetPerRunUsd || confirmed) {
    return { kind: 'proceed' };
  }
  return {
    kind: 'confirm',
    reason: `estimated p75 cost $${costUsdP75.toFixed(2)} exceeds the per-run budget $${budgetPerRunUsd.toFixed(2)} — pass confirmOverRunBudget to dispatch anyway`,
  };
}

export interface AllocationState {
  /** The initiative's allocation for the period. Null = none set, which is
   *  "unbudgeted", not "zero" — an initiative nobody has funded yet must not be
   *  frozen by this brake. The Budgets page surfaces it as a blind spot. */
  allocatedUsd: number | null;
  /** Attributed spend so far this period. */
  spentUsd: number;
}

/** What the brake is asked to judge. A bare number is read as a p75 it may
 *  speak about precisely — the shape from before there was anything weaker
 *  than a per-point forecast to hand it. */
export interface AllocationForecast {
  /** The figure the brake tests against the remainder: the pessimistic end. */
  costUsdP75: number;
  /** The optimistic end, when the range is known. Present or not, the test is
   *  the same; it only changes how certain the refusal is allowed to sound. */
  costUsdP25?: number;
  /** How the forecast was made. Decides the wording, never the verdict. */
  confidence?: ForecastConfidence;
}

/** Like RunBudgetDecision, but a refusal carries the confidence it was made
 *  with — the route hands it to the operator so a bracket is never mistaken
 *  for a measurement. */
export type AllocationDecision =
  | { kind: 'proceed' }
  | { kind: 'confirm'; reason: string; confidence: ForecastConfidence };

const money = (n: number): string => `$${n.toFixed(2)}`;

/** The parenthetical that stops a weak forecast reading like a measurement.
 *  No em dash inside — the reason's first ' — ' is the remedy separator, and
 *  clients split on it. */
const CONFIDENCE_NOTE: Record<ForecastConfidence, string> = {
  scaled: '',
  'run-history': " (run-level history, not scaled to this item's size)",
  prior: ' (no history for this model yet: a deliberately wide prior)',
};

/**
 * Whether a dispatch fits inside the initiative's remaining allocation.
 *
 * This is what makes a program-manager's allocation a brake rather than a
 * report. It is deliberately the SAME soft-cap shape as the per-run budget: a
 * forecast that overruns demands an explicit confirmation instead of refusing,
 * because the estimate is a forecast and the person dispatching may have good
 * reason to proceed. What it must never do is let a run start over an
 * exhausted allocation *silently*.
 *
 * The daily bot budget stays a HARD brake (it self-pauses the bot); this one
 * is soft, because it gates human-initiated work and a hard stop mid-sprint
 * with no override would strand an SME.
 *
 * ── Where the line sits between noisy and useless ────────────────────────────
 * The brake tests the **p75** of the range against the remainder, whatever the
 * confidence, and never the p25 or a midpoint. Testing p25 ("refuse only when
 * even the cheap outcome does not fit") would have kept this brake asleep for
 * exactly the case it exists for: a first dispatch against a $5 allocation,
 * where a $0.15–$1.50 prior's low end always fits. Testing p75 says "there is a
 * real chance this one run alone eats what is left", which is worth a
 * confirmation even when it is a bracket rather than a measurement — the brake
 * is soft, so a false alarm costs one click while a missed one costs money
 * someone deliberately fenced.
 *
 * The confidence therefore shapes the SENTENCE, not the verdict:
 *   scaled       one number, stated flatly — the range is size-aware evidence.
 *   run-history  the range, hedged as "may not fit", plus the caveat.
 *   prior        the same, plus "no history yet" and a cheaper-model remedy.
 * And when even the p25 is over the remainder the wording escalates to "even
 * the low end", because that overrun is near-certain on any basis. Exhaustion
 * is a fact about the ledger, not a forecast, so it carries no caveat at all.
 */
export function decideAllocation(
  allocation: AllocationState,
  forecast: number | AllocationForecast,
  confirmed: boolean,
): AllocationDecision {
  const { allocatedUsd, spentUsd } = allocation;
  if (allocatedUsd == null || confirmed) return { kind: 'proceed' };

  const f: AllocationForecast = typeof forecast === 'number' ? { costUsdP75: forecast } : forecast;
  const remaining = allocatedUsd - spentUsd;
  if (f.costUsdP75 <= remaining) return { kind: 'proceed' };

  // Exhausted: no forecast could fit, so say nothing about the forecast.
  if (remaining <= 0) {
    return {
      kind: 'confirm',
      reason: `this initiative's ${money(allocatedUsd)} allocation is exhausted (${money(spentUsd)} spent) — raise the allocation or pass confirmOverAllocation`,
      confidence: f.confidence ?? 'scaled',
    };
  }

  const confidence = f.confidence ?? 'scaled';
  const left = `the ${money(remaining)} left of this initiative's ${money(allocatedUsd)} allocation`;
  if (confidence === 'scaled' || f.costUsdP25 == null) {
    return {
      kind: 'confirm',
      reason: `estimated ${money(f.costUsdP75)} exceeds ${left} — raise it or pass confirmOverAllocation`,
      confidence,
    };
  }

  const range = `${money(f.costUsdP25)}–${money(f.costUsdP75)}`;
  const claim = f.costUsdP25 > remaining
    ? `even the low end of a ${range} forecast exceeds ${left}`
    : `a ${range} forecast may not fit ${left}`;
  return {
    kind: 'confirm',
    reason: `${claim}${CONFIDENCE_NOTE[confidence]} — raise it, pick a cheaper model, or pass confirmOverAllocation`,
    confidence,
  };
}

// ─── The sprint envelope, pure ────────────────────────────────────────────────
//
// A release manager grants a named SME a spend envelope for a sprint
// (budget_grants). Until now that envelope rendered on the Budgets page and
// nothing checked it — the doc listed enforcement as undone. This is the check,
// and the hard part is honesty about what the data supports.
//
// ── What is and is not claimed about who spent ───────────────────────────────
// bot_runs has never recorded who dispatched a run. The Budgets page is
// deliberate about that: GrantRow.initiativeSpendInWindowUsd is the
// INITIATIVE's spend inside the sprint window, explicitly not called the
// grantee's burn, because attributing initiative-wide spend to one SME would
// be a number nobody can support. That decision stands — this brake does not
// reuse that figure.
//
// Instead attribution starts going forward: bot_runs.dispatched_by records the
// session that authorized each run (schema/agent_run_attribution_schema.sql),
// and the envelope's burn is the sum of ONLY the runs carrying this caller's
// subject. So the number is small and truthful rather than large and invented:
//   - runs dispatched before the column existed count against nobody;
//   - cron firings and other people's dispatches count against nobody's
//     envelope, because nobody authorized them from inside one;
//   - the reason string always says the burn counts only runs recorded as
//     dispatched by this caller, so a small figure is never mistaken for
//     "this SME has barely spent".
// When the column is absent entirely the burn is UNKNOWN, not zero, and the
// brake says so — see attributionAvailable below.

export interface EnvelopeState {
  /** The envelope the release manager granted (budget_grants.allocated_usd). */
  allocatedUsd: number;
  /** Spend on runs this caller is RECORDED as having dispatched, inside the
   *  sprint window and attributed to this initiative. Never the initiative's
   *  window spend — see the section note. */
  attributedSpentUsd: number;
  /** false → bot_runs carries no dispatched_by column here yet, so the burn is
   *  unknown rather than zero. The brake then only fires on a forecast bigger
   *  than the WHOLE envelope, and says why it cannot say more. */
  attributionAvailable: boolean;
  /** Names the envelope in the refusal: 'Sprint 98 — Span metrics'. */
  sprintName?: string | null;
}

export type EnvelopeDecision =
  | { kind: 'proceed' }
  | { kind: 'confirm'; reason: string; confidence: ForecastConfidence };

/** Said every time a burn figure appears, so a small number is never read as
 *  "this SME has hardly spent". No em dash: the first ' — ' is the remedy
 *  separator and clients split on it. */
const ATTRIBUTION_NOTE = ' (counting only runs recorded as dispatched by you)';

/**
 * A sprint name, made safe to embed in a reason string.
 *
 * Every reason on this surface is "claim — remedy", and clients (the portal's
 * overAllocationBody among them) split on the FIRST ' — ' to show the claim
 * without an API flag name in it. Sprint names here really do carry em dashes —
 * the seed's are literally 'Sprint 98 — Span metrics + decom' — so embedding
 * one raw lets data forge the delimiter and truncates the claim mid-sentence.
 * The em dash becomes a spaced en dash, which no client splits on and which
 * reads identically.
 */
function safeSprintName(name: string): string {
  return name.replace(/\s*—\s*/g, ' – ');
}

/**
 * Whether a dispatch fits inside the caller's own sprint envelope.
 *
 * Same soft-409 shape as the allocation brake — p75 against the remainder,
 * confidence shapes the sentence and never the verdict — but a DIFFERENT
 * limit, set by a different person, so it carries its own confirm flag. An
 * operator who confirmed "yes, over the initiative's allocation" has said
 * nothing about their personal envelope, and vice versa.
 *
 * No grant means no brake: this fires only for someone spending inside an
 * envelope. A release manager or hr-admin dispatching without one is the
 * allocation brake's business, not this one's.
 */
export function decideEnvelope(
  envelope: EnvelopeState,
  forecast: number | AllocationForecast,
  confirmed: boolean,
): EnvelopeDecision {
  if (confirmed) return { kind: 'proceed' };

  const f: AllocationForecast = typeof forecast === 'number' ? { costUsdP75: forecast } : forecast;
  const confidence = f.confidence ?? 'scaled';
  const { allocatedUsd, attributedSpentUsd } = envelope;
  const named = envelope.sprintName
    ? `your ${money(allocatedUsd)} envelope on ${safeSprintName(envelope.sprintName)}`
    : `your ${money(allocatedUsd)} sprint envelope`;

  // Attribution not recorded here: the burn is unknown, so the only claim that
  // survives is about the envelope's SIZE. A forecast that would not fit even
  // an untouched envelope is worth a confirmation; anything smaller cannot be
  // judged without a burn, and inventing one is exactly what this refuses.
  if (!envelope.attributionAvailable) {
    if (f.costUsdP75 <= allocatedUsd) return { kind: 'proceed' };
    return {
      kind: 'confirm',
      reason: `estimated ${money(f.costUsdP75)} exceeds ${named} outright, and no run here is recorded as dispatched by anyone yet, so nothing is counted against it — ask for a larger envelope or pass confirmOverEnvelope`,
      confidence,
    };
  }

  const remaining = allocatedUsd - attributedSpentUsd;
  if (f.costUsdP75 <= remaining) return { kind: 'proceed' };

  // Spent out: no forecast could fit, so say nothing about the forecast.
  if (remaining <= 0) {
    return {
      kind: 'confirm',
      reason: `${named} is spent out (${money(attributedSpentUsd)} dispatched by you) — ask for a larger envelope or pass confirmOverEnvelope`,
      confidence,
    };
  }

  const left = `the ${money(remaining)} left of ${named}${ATTRIBUTION_NOTE}`;
  if (confidence === 'scaled' || f.costUsdP25 == null) {
    return {
      kind: 'confirm',
      reason: `estimated ${money(f.costUsdP75)} exceeds ${left} — ask for a larger envelope or pass confirmOverEnvelope`,
      confidence,
    };
  }

  const range = `${money(f.costUsdP25)}–${money(f.costUsdP75)}`;
  const claim = f.costUsdP25 > remaining
    ? `even the low end of a ${range} forecast exceeds ${left}`
    : `a ${range} forecast may not fit ${left}`;
  return {
    kind: 'confirm',
    reason: `${claim}${CONFIDENCE_NOTE[confidence]} — ask for a larger envelope, pick a cheaper model, or pass confirmOverEnvelope`,
    confidence,
  };
}

/** The envelope a dispatch is judged against, plus the grant it came from so
 *  the 409 can name it. Null = no active grant for this caller here, which is
 *  "not braked", not "zero envelope". */
export interface ResolvedEnvelope extends EnvelopeState {
  grantId: string;
  sprintId: string | null;
  granteePersonId: string;
}

/**
 * Resolve the caller's own envelope on an initiative: session subject → person
 * → their ACTIVE grant here → the burn of runs they dispatched in its window.
 *
 * Every step that cannot be answered returns null (no brake) rather than
 * guessing: no session, a user with no person_id (a platform operator is not
 * an SME), no grant, or a grants read that fails. A missing envelope must
 * never masquerade as an exhausted one.
 *
 * A grant counts as active when its sprint is `active`, or when it has no
 * sprint at all — an initiative-level standing grant is always in force, and
 * its burn window is simply unbounded. listGrants orders newest sprint first,
 * so with several the freshest window wins.
 */
export async function loadEnvelope(
  orgProjectId: string,
  sessionSub: string | undefined,
): Promise<ResolvedEnvelope | null> {
  if (!sessionSub) return null;
  try {
    const user = await getUser(sessionSub);
    const personId = user?.personId;
    if (!personId) return null;

    const grants = await listGrants(orgProjectId);
    const grant = grants.find(
      (g) => g.granteePersonId === personId && (g.sprintStatus === 'active' || g.sprintId == null),
    );
    if (!grant) return null;

    const burn = await dispatchedSpendInWindow({
      orgProjectId, dispatchedBy: sessionSub,
      startsOn: grant.startsOn, endsOn: grant.endsOn,
    });
    return {
      grantId: grant.id,
      sprintId: grant.sprintId,
      sprintName: grant.sprintName,
      granteePersonId: personId,
      allocatedUsd: grant.allocatedUsd,
      attributedSpentUsd: burn.spentUsd,
      attributionAvailable: burn.attributionAvailable,
    };
  } catch (err) {
    // A brake that cannot read its own inputs must not become a refusal — the
    // allocation brake still stands behind it.
    console.warn(`[bots] could not resolve the sprint envelope for ${orgProjectId}:`, (err as Error).message);
    return null;
  }
}

// ─── Grant-scoped dispatch authorization, pure ───────────────────────────────
//
// DispatchAgentRun is role-wide: an `sme` holding it can dispatch against ANY
// initiative, not only the ones a release manager put them on. The envelope
// brake above enforces the *money* of a grant, but not the *right to be here* —
// an SME with no grant on an initiative is braked by nothing, because with no
// grant there is no envelope to overrun. This closes that: an SME may dispatch
// only where they hold an active grant.
//
// ── Why here and not in Cedar ────────────────────────────────────────────────
// Cedar decides on the request's principal/action/resource and the policy
// store — it cannot see budget_grants, which is live DB state keyed on
// (person, initiative, sprint). So "condition DispatchAgentRun on holding a
// grant" cannot be a Cedar policy; it is a DB-backed check, shaped like the
// other decide* functions so the route calls one pure verdict.
//
// ── Authorization, not a soft brake ──────────────────────────────────────────
// The three money gates are soft: a forecast is not a bill, and an operator may
// have good reason to spend over a fence, so they answer 409 + a confirmFlag.
// This is different in kind. "You have no grant here" is not a forecast the
// caller can knowingly override — it is a missing authorization, and a
// confirmFlag that waved it through would make grant-scoping cosmetic. So the
// verdict is hard: allow or deny (the route answers 403), no override flag.
//
// ── Who is grant-scoped ──────────────────────────────────────────────────────
// Only `sme`. An SME spends inside an envelope someone else authorized; the
// grant IS that authorization. org-leader / hr-admin / admin allocate and
// administer — they dispatch without a grant by design, so they always pass.
// Every other role never reaches a DispatchAgentRun route at all, and an
// unknown/absent role is not this function's to deny (open-mode demo identity,
// tests) — so anything that is not `sme` passes.

export type DispatchGrantDecision =
  | { kind: 'allow' }
  /** The route answers 403 — a missing grant is missing authorization, not a
   *  forecast, so there is no confirmFlag to override it. */
  | { kind: 'deny'; reason: string };

/**
 * Whether this principal is authorized to dispatch against THIS initiative at
 * all — the authorization question, kept distinct from the money brakes. Only
 * `sme` is grant-scoped; see the section note. Pure: the route resolves the
 * role and the grant (resolveActiveGrant) and hands both here.
 */
export function decideGrantScopedDispatch(input: {
  role: string | null | undefined;
  hasActiveGrant: boolean;
  /** Whether the caller holds ANY grant on this initiative, active or not. A
   *  grant on a `planned` (not-yet-started) sprint is not active, but it exists
   *  — so the deny reason must say the grant is there and its sprint has not
   *  started, NOT tell them to request a grant they already hold. Optional so a
   *  caller that has not resolved it (or an older route) falls back to the
   *  no-grant-at-all wording rather than misreporting. */
  hasAnyGrant?: boolean;
  initiativeName?: string | null;
}): DispatchGrantDecision {
  if (input.role !== 'sme') return { kind: 'allow' };
  if (input.hasActiveGrant) return { kind: 'allow' };
  const where = input.initiativeName ? ` on ${input.initiativeName}` : ' here';
  // A grant exists but its sprint isn't active yet: don't send them to ask for
  // a grant they already hold — tell them the sprint hasn't started.
  if (input.hasAnyGrant) {
    return {
      kind: 'deny',
      reason: `you hold a sprint grant${where}, but its sprint has not started yet, so you cannot dispatch against this initiative — wait for the sprint to become active`,
    };
  }
  return {
    kind: 'deny',
    reason: `you hold no active sprint grant${where}, so you cannot dispatch against this initiative — ask the release manager for a grant`,
  };
}

/**
 * Resolve, for the grant-scoped check, whether the caller holds an ACTIVE grant
 * on an initiative: session subject → person → any active grant here. Mirrors
 * loadEnvelope's resolution (active = the grant's sprint is `active`, or the
 * grant is sprint-less and therefore standing), and its null-means-do-not-brake
 * posture: no session, no person_id (a platform operator is not an SME), or a
 * grants read that throws all return null, so the route enforces nothing rather
 * than fabricating a denial an authz check must never invent.
 *
 * `hasAnyGrant` is the second signal decideGrantScopedDispatch needs: whether
 * the caller holds ANY grant here at all (active or not). An SME whose only
 * grant is on a not-yet-active sprint has `hasActiveGrant: false` but
 * `hasAnyGrant: true`, so the deny reason can say the grant exists rather than
 * tell them to request one they already hold.
 */
export async function resolveActiveGrant(
  orgProjectId: string,
  sessionSub: string | undefined,
): Promise<{ hasActiveGrant: boolean; hasAnyGrant: boolean; initiativeName: string | null } | null> {
  if (!sessionSub) return null;
  try {
    const user = await getUser(sessionSub);
    const personId = user?.personId;
    if (!personId) return null;
    const grants = await listGrants(orgProjectId);
    const mine = grants.filter((g) => g.granteePersonId === personId);
    const active = mine.some((g) => g.sprintStatus === 'active' || g.sprintId == null);
    return {
      hasActiveGrant: active,
      hasAnyGrant: mine.length > 0,
      initiativeName: grants[0]?.orgProjectName ?? null,
    };
  } catch (err) {
    console.warn(`[bots] could not resolve grant-scoped dispatch for ${orgProjectId}:`, (err as Error).message);
    return null;
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export type FireResult =
  | { ok: true; run: BotRun }
  | { ok: false; reason: string; run?: BotRun };

/**
 * Make sure the bot's target repository is checked out in a live workspace.
 *
 * "Live" means both halves: the project knows a session AND the fleet registry
 * knows a box for it — the registry is in-memory, so a middleware restart (or
 * a workspace wipe) leaves session ids that point at nothing. Bots re-clone on
 * demand rather than assume, the same posture Codebases takes.
 */
async function ensureWorkspace(project: AgentProject): Promise<
  { ok: true; sessionId: string; boxId: string } | { ok: false; error: string }
> {
  const existing = project.sessionId ? getBoxBySession(project.sessionId) : null;
  if (project.sessionId && existing) return { ok: true, sessionId: project.sessionId, boxId: existing.id };

  const arn = await resolveDevboxArn();
  if (!arn) return { ok: false, error: 'the devbox runtime is not deployed' };

  // Keep the project's session id when it satisfies the runtime's ≥33-char
  // rule — the workspace may still hold the checkout — else mint a fresh one.
  const sessionId = normalizeRuntimeSessionId(project.sessionId);

  const { command, redacted } = await buildCloneCommand(project);
  let output = '';
  try {
    output = await runDevboxShell(devboxDataClient(), arn, sessionId, command);
  } catch (err) {
    return { ok: false, error: `clone failed: ${(err as Error).message}` };
  }
  if (CLONE_FAILURE.test(output)) {
    const line = output.split('\n').find((l) => CLONE_FAILURE.test(l)) ?? output.slice(-200);
    console.warn(`[bots] clone failed for ${project.repoFullName}: ${line.trim()} (${redacted})`);
    return { ok: false, error: `clone failed: ${line.trim()}` };
  }

  // Register the box only once the clone succeeded. Registering first would
  // leave a live-looking fleet entry for a workspace with no checkout, and the
  // sessionId+registry check at the top would then trust it on the next fire —
  // a failed clone poisoning every later dispatch.
  const box = registerBox({ sessionId });
  await markCloned(project.id, sessionId);
  return { ok: true, sessionId, boxId: box.id };
}

/** Dispatch one run of a bot. The single entry point for every trigger. */
export async function fireBot(botId: string, opts: {
  trigger: 'manual' | 'cron' | 'pr_watch';
  /** One-shot steering, appended to the mission for this run only. */
  instruction?: string;
  /** The session subject that authorized this firing, recorded on the run so a
   *  sprint envelope can be burned down against a person. Absent for cron and
   *  pr_watch: nobody authorized those from inside an envelope, and inventing
   *  an owner for them is exactly what the envelope brake must not do. */
  dispatchedBy?: string | null;
}): Promise<FireResult> {
  const bot = await getBot(botId);
  if (!bot) return { ok: false, reason: 'no such bot' };

  const decision = decideFire(bot);
  if (decision.kind === 'refuse') return { ok: false, reason: decision.reason };
  if (decision.kind === 'skip' || decision.kind === 'pause') {
    if (decision.kind === 'pause') await setPausedReason(bot.id, decision.reason);
    const run = await createBotRun({
      botId: bot.id, trigger: opts.trigger, status: 'skipped',
      dispatchedBy: opts.dispatchedBy ?? null,
      outcome: { reason: decision.reason },
    });
    return { ok: false, reason: decision.reason, ...(run ? { run } : {}) };
  }

  // The global ceiling, after the bot's own brakes: a capped or paused bot
  // reports its own state, not the fleet's. A braked trigger is visible
  // history, same as the run cap.
  const congestion = await checkConcurrency();
  if (congestion.kind === 'refuse') {
    const run = await createBotRun({
      botId: bot.id, trigger: opts.trigger, status: 'skipped',
      dispatchedBy: opts.dispatchedBy ?? null,
      outcome: { reason: congestion.reason },
    });
    return { ok: false, reason: congestion.reason, ...(run ? { run } : {}) };
  }

  const prompt = renderPrompt(bot.prompt, opts.instruction);

  // last_run_at is recorded BEFORE dispatch, not after: the boot catch-up and
  // a cron firing can interleave, and marking first means the second of the
  // two sees a fresh last_run_at (and today's run count) instead of both
  // firing. A dispatch that then fails still shows a truthful "last fired".
  await markBotRan(bot.id);

  if (bot.agentProjectId) {
    const project = await getAgentProject(bot.agentProjectId);
    if (!project) return { ok: false, reason: 'the bot\'s target codebase no longer exists' };

    const ws = await ensureWorkspace(project);
    if (!ws.ok) {
      const run = await createBotRun({
        botId: bot.id, trigger: opts.trigger, status: 'failed',
        dispatchedBy: opts.dispatchedBy ?? null,
        outcome: { error: ws.error },
      });
      return { ok: false, reason: ws.error, ...(run ? { run } : {}) };
    }

    const started = await dispatchGovernedRun({
      project, prompt, model: bot.model, sessionId: ws.sessionId,
    });
    if (!started.ok) {
      const run = await createBotRun({
        botId: bot.id, trigger: opts.trigger, status: 'failed',
        dispatchedBy: opts.dispatchedBy ?? null,
        outcome: { error: started.error, sessionId: ws.sessionId, boxId: ws.boxId },
      });
      return { ok: false, reason: started.error, ...(run ? { run } : {}) };
    }

    const run = await createBotRun({
      botId: bot.id, trigger: opts.trigger, runId: started.runId,
      ceiling: botMaxConcurrent(), dispatchedBy: opts.dispatchedBy ?? null,
      outcome: { sessionId: ws.sessionId, boxId: ws.boxId },
    });
    if (!run) return { ok: false, reason: 'could not record the bot run' };
    return { ok: true, run };
  }

  // Initiative-target (or untargeted) bot: queue work for the fleet dispatcher
  // rather than a repo-bound governed run. requiresReview rides the payload —
  // the dispatcher parks the artifact at awaiting_review unless it is false.
  // The bot's model rides too, else the dispatcher falls back to its default
  // and the bot's configured model is silently ignored.
  const job = await enqueueJob({
    kind: 'devbox:task', title: bot.name,
    payload: { prompt, requiresReview: bot.requiresReview, botId: bot.id, model: bot.model },
    // Also on the column, not just in the payload: the queue joins bots on it
    // to name the mission behind a scheduled job.
    botId: bot.id,
  });
  if (!job) return { ok: false, reason: 'could not enqueue the job' };
  const run = await createBotRun({
    botId: bot.id, trigger: opts.trigger, jobId: job.id, ceiling: botMaxConcurrent(),
    dispatchedBy: opts.dispatchedBy ?? null,
  });
  if (!run) return { ok: false, reason: 'could not record the bot run' };
  return { ok: true, run };
}

// ─── Marketplace dispatch ─────────────────────────────────────────────────────

export interface DispatchCandidate { id: string; repoFullName: string }

export type DispatchDecision =
  | { kind: 'proceed'; agentProjectId: string }
  | { kind: 'error'; status: number; error: string; options?: DispatchCandidate[] };

/**
 * Whether a work item may be dispatched, and against which codebase. Pure —
 * the refusal matrix in one place, judgeable without a database. Ordering:
 * item-shape refusals (type, status) come before codebase resolution, because
 * "pick a codebase" is a useless answer for an epic or a done item.
 */
export function decideDispatch(
  item: Pick<WorkItem, 'type' | 'status'>,
  codebases: DispatchCandidate[],
  agentProjectId?: string,
): DispatchDecision {
  if (item.type !== 'story' && item.type !== 'bug') {
    return { kind: 'error', status: 400, error: 'only stories and bugs dispatch — epics roll up, they do not run' };
  }
  // open or in_progress may (re)dispatch; done/cancelled are finished and
  // in_review already has a change awaiting a human — dispatching over it
  // would race the review.
  if (item.status !== 'open' && item.status !== 'in_progress') {
    return { kind: 'error', status: 400, error: `a ${item.status} work item cannot be dispatched` };
  }
  if (codebases.length === 0) {
    return { kind: 'error', status: 400, error: 'no codebase delivers this initiative — link one in Codebases' };
  }
  if (agentProjectId) {
    const chosen = codebases.find((c) => c.id === agentProjectId);
    if (!chosen) {
      return { kind: 'error', status: 400, error: 'that codebase does not deliver this initiative' };
    }
    return { kind: 'proceed', agentProjectId: chosen.id };
  }
  if (codebases.length > 1) {
    return {
      kind: 'error', status: 409,
      error: 'multiple codebases deliver this initiative — pick one',
      options: codebases,
    };
  }
  return { kind: 'proceed', agentProjectId: codebases[0]!.id };
}

/**
 * The work item rendered as a mission: what to do (title, description,
 * labels), which item it serves (so the trail from run back to story survives
 * in the prompt itself), and the standing instruction that governance — not
 * the agent — delivers the result.
 */
export function renderWorkItemPrompt(
  item: Pick<WorkItem, 'id' | 'type' | 'title' | 'description' | 'labels' | 'storyPoints'>,
  instruction?: string,
): string {
  const preamble = item.storyPoints != null
    ? `Work item ${item.id} (${item.type}, ${item.storyPoints} pts)`
    : `Work item ${item.id} (${item.type})`;
  const parts = [`${preamble}\n${item.title}`];
  if (item.description) parts.push(item.description);
  if (item.labels.length > 0) parts.push(`Labels: ${item.labels.join(', ')}`);
  if (instruction) parts.push(`For this run specifically: ${instruction}`);
  parts.push(PIPELINE_CONTRACT);
  return parts.join('\n\n');
}

export type DispatchWorkResult =
  | { ok: true; run: BotRun }
  | { ok: false; status: number; error: string; options?: DispatchCandidate[] };

/** The item and the codebase a dispatch resolved to, or the refusal it earned. */
export type WorkItemPreflight =
  | { ok: true; item: WorkItem; agentProjectId: string }
  | { ok: false; status: number; error: string; options?: DispatchCandidate[] };

/**
 * Everything that can refuse a dispatch on SHAPE — before a single question
 * about money is asked.
 *
 * Split out of dispatchWorkItem so the route can run it first. The gates used
 * to run the other way round, and the result was an interrogation nobody
 * should sit through: a `done` work item that also overran its initiative's
 * allocation answered "confirm you want to spend over budget", and only once
 * the operator had confirmed did it answer "a done work item cannot be
 * dispatched". Never ask someone to authorize spending on something that was
 * never dispatchable.
 *
 * Resolving the codebase here is the second reason: the brake can then price
 * against the repo the run will actually use, even when the caller left it to
 * the server to pick.
 */
export async function preflightWorkItem(
  workItemId: string,
  agentProjectId?: string,
): Promise<WorkItemPreflight> {
  const item = await getWorkItem(workItemId);
  if (!item) return { ok: false, status: 404, error: 'no such work item' };

  const codebases = (await listAgentProjects())
    .filter((p) => p.orgProjectId != null && p.orgProjectId === item.projectId)
    .map((p) => ({ id: p.id, repoFullName: p.repoFullName }));
  const decision = decideDispatch(item, codebases, agentProjectId);
  if (decision.kind === 'error') {
    return {
      ok: false, status: decision.status, error: decision.error,
      ...(decision.options ? { options: decision.options } : {}),
    };
  }
  return { ok: true, item, agentProjectId: decision.agentProjectId };
}

/**
 * Authorize a story or bug into a governed run — the marketplace's dispatch.
 *
 * No bot exists here: the work item is the mission and the bot_run rides with
 * bot_id NULL. The codebase is resolved from the initiative the item belongs
 * to (agent_projects.org_project_id); one match dispatches, several demand a
 * choice (409 + options), none is a setup error the operator must fix in
 * Codebases. The estimate the operator authorized against is echoed onto the
 * bot_run outcome so estimate-vs-actual calibration has both halves.
 */
export async function dispatchWorkItem(input: {
  workItemId: string;
  model: string;
  agentProjectId?: string;
  instruction?: string;
  actor?: string;
  /** The estimate shown at authorize time, echoed onto the bot_run outcome. */
  estimate?: Record<string, unknown>;
  /** A preflight the caller already ran (routes do, so shape refusals land
   *  before the budget gates). Omitted → run it here, so a direct caller still
   *  gets every refusal. */
  preflight?: Extract<WorkItemPreflight, { ok: true }>;
}): Promise<DispatchWorkResult> {
  const pre = input.preflight ?? await preflightWorkItem(input.workItemId, input.agentProjectId);
  if (!pre.ok) {
    return {
      ok: false, status: pre.status, error: pre.error,
      ...(pre.options ? { options: pre.options } : {}),
    };
  }
  const item = pre.item;

  // The global ceiling, before any workspace side effect: a refused dispatch
  // leaves the work item exactly as it was — no run row, no status flip — so
  // the operator retries when a slot frees up.
  const congestion = await checkConcurrency();
  if (congestion.kind === 'refuse') {
    return { ok: false, status: 429, error: congestion.reason };
  }

  const project = await getAgentProject(pre.agentProjectId);
  if (!project) return { ok: false, status: 404, error: 'the chosen codebase no longer exists' };

  // Claim the work item BEFORE any dispatch side effect, atomically: only an
  // 'open' item flips to in_progress, and no returned row means another
  // dispatch got there first — the read-then-dispatch race two interleaved
  // authorizations used to win together. (A failed run hands the item back to
  // 'open' via reconcile, so retries re-claim cleanly.)
  const claimed = await exec(
    `UPDATE work_items SET status = 'in_progress', updated_at = NOW()
      WHERE id = :wid AND status IN ('open') RETURNING id`,
    [s('wid', item.id)],
  );
  if (claimed.length === 0) {
    return { ok: false, status: 409, error: 'this work item is already being worked' };
  }
  const revertClaim = async (): Promise<void> => {
    await exec(
      `UPDATE work_items SET status = 'open', updated_at = NOW()
        WHERE id = :wid AND status = 'in_progress'`,
      [s('wid', item.id)],
    ).catch((err: unknown) =>
      console.warn(`[bots] could not revert claim on ${item.id}:`, (err as Error).message));
  };

  const ws = await ensureWorkspace(project);
  if (!ws.ok) { await revertClaim(); return { ok: false, status: 503, error: ws.error }; }

  const prompt = renderWorkItemPrompt(item, input.instruction);
  const started = await dispatchGovernedRun({
    project, prompt, model: input.model, sessionId: ws.sessionId,
  });
  if (!started.ok) { await revertClaim(); return { ok: false, status: 503, error: started.error }; }

  // Bind the governed run to its work item. Direct SQL on purpose — the
  // sdlc-pipeline API takes no work-item concept and stays that way; the
  // column was added by agent_bots_schema.sql for exactly this write.
  await exec(
    `UPDATE agent_project_runs SET work_item_id = :wid WHERE id = :rid::uuid`,
    [s('wid', item.id), s('rid', started.runId)],
  );

  const run = await createBotRun({
    botId: null, trigger: 'marketplace', runId: started.runId, workItemId: item.id,
    ceiling: botMaxConcurrent(),
    // The marketplace's actor IS the dispatcher — the envelope brake burns down
    // against exactly this subject, so the two must be the same string.
    dispatchedBy: input.actor ?? null,
    outcome: {
      sessionId: ws.sessionId, boxId: ws.boxId,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.estimate ? { estimate: input.estimate } : {}),
    },
  });
  if (!run) {
    await revertClaim();
    return { ok: false, status: 503, error: 'could not record the marketplace run' };
  }
  return { ok: true, run };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Settle running bot_runs whose underlying run or job has finished.
 *
 * The dispatch paths are fire-and-forget (a governed run finishes on its own;
 * a queue job is the dispatcher's), so nothing calls back into the bot layer
 * when they end. This poll closes the loop: terminal status and cost flow back
 * onto the bot_run, plus — for governed runs — the change request and PR it
 * produced, so the bot's Outcomes tab links into the review queue.
 */
/** A governed run that has been 'running' this long is dead, not slow. Real
 *  devbox runs finish in a minute or two, and the devbox box reaper caps a box
 *  at 60 min — so 30 min is comfortably past any live run and safely under the
 *  box ceiling. Env-tunable for a lab that wants a tighter or looser leash. */
const STALE_RUN_MINUTES = parseInt(process.env['BOT_STALE_RUN_MINUTES'] ?? '30', 10);

export async function reconcileBotRuns(): Promise<{ settled: number }> {
  if (config.mock.aurora) return { settled: 0 };
  let settled = 0;

  // Stale-run reaper — the arm that was missing. A run-backed bot_run only
  // settles once its agent_project_run reaches done/failed; if that run itself
  // hangs (a devbox that never called back — the catch-up-on-boot pass did
  // exactly this, leaving three runs 'running' for 90 minutes), nothing below
  // could ever settle it, and each one held a slot of the global concurrency
  // ceiling until every dispatch 429'd. Fail the hung agent_project_run first,
  // so the run-backed arm below settles its bot_run in this same pass.
  await exec(
    `UPDATE agent_project_runs
        SET status = 'failed', error = 'run exceeded the ${STALE_RUN_MINUTES}-minute ceiling — reaped as stale',
            finished_at = NOW()
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '${STALE_RUN_MINUTES} minutes'`,
  );

  // Governed runs. The lateral takes the newest change request for the run —
  // a re-review appends reviews, not changes, so one run has at most one.
  // The bot's per-run budget joins in so the soft cap can be judged against
  // the actual cost the moment it is known.
  const runBacked = await exec(
    `SELECT br.id, br.work_item_id, r.status AS run_status, r.cost_usd::float8 AS cost_usd,
            r.files_changed, r.error AS run_error, cr.change_id, cr.pr_url,
            b.budget_per_run_usd::float8 AS budget_per_run_usd
       FROM bot_runs br
       JOIN agent_project_runs r ON r.id = br.run_id
       LEFT JOIN bots b ON b.id = br.bot_id
       LEFT JOIN LATERAL (
         SELECT c.id AS change_id, c.pr_url
           FROM agent_change_requests c
          WHERE c.run_id = br.run_id
          ORDER BY c.created_at DESC LIMIT 1
       ) cr ON TRUE
      WHERE br.status = 'running' AND br.run_id IS NOT NULL
        AND r.status IN ('done','failed')`,
  );
  for (const row of runBacked) {
    // Per-row: one bad row (deleted work item, transient Data API error) must
    // not strand every other finished run at 'running'.
    try {
      const done = toStr(row['run_status']) === 'done';
      const costUsd = row['cost_usd'] == null ? null : Number(row['cost_usd']);

      // Settle the bound work item FIRST, finalize the bot_run LAST: the
      // br.status='running' filter is what re-selects this row next tick, so
      // finalizing first and then failing the settle would strand the item in
      // in_progress with nothing left to retry it.
      const workItemId = row['work_item_id'] ? toStr(row['work_item_id']) : null;
      if (workItemId) {
        if (done && row['change_id']) {
          await updateWorkItem(workItemId, {
            status: 'in_review',
            ...(row['pr_url'] ? { prUrl: toStr(row['pr_url']), prStatus: 'open' as const } : {}),
          });
        } else if (!done) {
          await updateWorkItem(workItemId, { status: 'open' });
          const why = row['run_error'] ? toStr(row['run_error']) : 'the run failed without a recorded error';
          await addWorkItemComment(workItemId, `Marketplace run failed: ${why}`, { isSystem: true });
        } else {
          // Done but nothing captured: the agent committed no change. Back to
          // open with a comment, else the item is stuck in_progress forever.
          await updateWorkItem(workItemId, { status: 'open' });
          await addWorkItemComment(workItemId, 'Marketplace run completed without a captured change.', { isSystem: true });
        }
      }

      // The per-run budget is a soft cap: exceeding it flags the run for the
      // Outcomes tab rather than clawing anything back — the money is spent.
      const budget = row['budget_per_run_usd'] == null ? null : Number(row['budget_per_run_usd']);
      const overRunBudget = budget != null && costUsd != null && costUsd > budget;

      await finalizeBotRun(toStr(row['id']), {
        status: done ? 'done' : 'failed',
        costUsd,
        outcome: {
          ...(row['change_id'] ? { changeId: toStr(row['change_id']) } : {}),
          ...(row['pr_url'] ? { prUrl: toStr(row['pr_url']) } : {}),
          ...(row['files_changed'] == null ? {} : { filesChanged: Number(row['files_changed']) }),
          ...(overRunBudget ? { overRunBudget: true } : {}),
        },
      });
      settled++;
    } catch (err) {
      console.warn(`[bots] reconcile failed for bot_run ${toStr(row['id'])}:`, (err as Error).message);
    }
  }

  // Queue jobs. awaiting_review counts as done for the bot — the work is
  // finished; what remains is the human decision, which lives on the Work
  // surface. cancelled is terminal too, else the bot_run runs forever.
  const jobBacked = await exec(
    `SELECT br.id, j.status AS job_status, (j.result->>'costUsd')::float8 AS cost_usd,
            b.budget_per_run_usd::float8 AS budget_per_run_usd
       FROM bot_runs br
       JOIN agent_jobs j ON j.id = br.job_id
       LEFT JOIN bots b ON b.id = br.bot_id
      WHERE br.status = 'running' AND br.job_id IS NOT NULL
        AND j.status IN ('done','awaiting_review','failed','cancelled')`,
  );
  for (const row of jobBacked) {
    try {
      const jobStatus = toStr(row['job_status']);
      const costUsd = row['cost_usd'] == null ? null : Number(row['cost_usd']);
      const budget = row['budget_per_run_usd'] == null ? null : Number(row['budget_per_run_usd']);
      const overRunBudget = budget != null && costUsd != null && costUsd > budget;
      await finalizeBotRun(toStr(row['id']), {
        status: jobStatus === 'done' || jobStatus === 'awaiting_review' ? 'done' : 'failed',
        costUsd,
        outcome: {
          ...(jobStatus === 'awaiting_review' ? { awaitingReview: true } : {}),
          ...(overRunBudget ? { overRunBudget: true } : {}),
        },
      });
      settled++;
    } catch (err) {
      console.warn(`[bots] reconcile failed for bot_run ${toStr(row['id'])}:`, (err as Error).message);
    }
  }

  // Vanished linkage: a bot_run still 'running' whose run_id AND job_id are
  // both NULL can never be settled by the arms above — the linked row was
  // deleted (ON DELETE SET NULL) out from under it. Fail it, else it eats a
  // concurrency slot until the 24h count window ages it out.
  const vanished = await exec(
    `UPDATE bot_runs
        SET status = 'failed', finished_at = NOW(),
            outcome = COALESCE(outcome, '{}'::jsonb) || '{"reason":"linked run vanished"}'::jsonb
      WHERE status = 'running' AND run_id IS NULL AND job_id IS NULL
      RETURNING id`,
  );
  settled += vanished.length;

  return { settled };
}

// ─── Boot sweep ───────────────────────────────────────────────────────────────

/** When this process started — the boot sweep's cutoff. A run 'running' from
 *  before this instant belongs to a previous process and cannot still exist:
 *  governed runs execute in-process and do not survive a restart. */
const PROCESS_START_ISO = new Date().toISOString();

/**
 * Fail agent_project_runs left 'running' by a previous process. Called once
 * from the scheduler's init path; the regular reconcile arms then settle the
 * bot_runs (and work items) linked to the newly-failed runs.
 */
export async function sweepOrphanedRuns(): Promise<{ failed: number }> {
  if (config.mock.aurora) return { failed: 0 };
  const rows = await exec(
    `UPDATE agent_project_runs
        SET status = 'failed', error = 'middleware restarted mid-run', finished_at = NOW()
      WHERE status = 'running' AND started_at < :boot::timestamptz
      RETURNING id`,
    [s('boot', PROCESS_START_ISO)],
  );
  if (rows.length > 0) {
    console.log(`[bots] boot sweep failed ${rows.length} run(s) orphaned by a restart`);
  }
  return { failed: rows.length };
}

// Money on the agent invoke paths (docs/next-steps.md §8 work item 16,
// docs/spend-map.md rows 13 and 14).
//
// The chat invoke (POST /api/agents/:id/invoke) and `/summarize` call an
// AgentCore runtime that spends Bedrock tokens. Neither used to reserve or
// record anything. Both now take a hold through the one chokepoint
// (lib/spend-holds.ts `reserveSpend`) before the runtime is called, and write
// one ledger row (`source: 'agent_invoke'`, keyed by the run id) after it,
// which settles the hold when its cost is known.
//
// The figure. A runtime response carries no usage today: the agent sums its
// Converse usage only into its trace bundle (agents/_shared/instrumentation.py),
// which lands in observability.invocation_traces, not the ledger. So the row
// is priced from a `usage` block when the final event carries one, and is
// otherwise written with an UNKNOWN cost, never a guessed one. An unknown row
// leaves its hold open until it expires (the ledger's own rule), so the money
// in flight still counts against the budgets for the hold's lifetime.
//
// The forecast is a fixed prior (AGENT_INVOKE_P75_USD, default $0.05): there
// is no run history for chat turns to draw a p75 from.
//
// Kept free of static provider imports: routes/agents.ts loads it lazily, as
// lib/agent-actions.ts does its authz, so a suite that imports the route does
// not drag the budget provider graph (and config.ts) in with it.

import type { AllocationForecast } from './bot-runner.js';
import type { ReserveSpendResult } from './spend-holds.js';
import type { TokenUsage } from './pricing.js';

export const AGENT_INVOKE_SOURCE = 'agent_invoke' as const;
/** The fleet's chat model (Nova Pro) when the final event names none. */
export const DEFAULT_AGENT_INVOKE_MODEL = 'amazon.nova-pro-v1:0';
const DEFAULT_P75_USD = 0.05;
const DEFAULT_HOLD_TTL_MS = 15 * 60_000;

/** The prior every agent invoke is held at; AGENT_INVOKE_P75_USD overrides. */
export function agentInvokeForecast(): AllocationForecast {
  const raw = (process.env['AGENT_INVOKE_P75_USD'] ?? '').trim();
  const n = Number(raw);
  const p75 = raw && Number.isFinite(n) && n >= 0 ? n : DEFAULT_P75_USD;
  return { costUsdP75: p75, costUsdP25: p75 / 5, confidence: 'prior' };
}

/** How long an invoke's hold may stay open: AGENT_INVOKE_HOLD_TTL_MS, plus the shared grace. */
export function agentInvokeHoldTtlMs(graceMs: number): number {
  const n = Number((process.env['AGENT_INVOKE_HOLD_TTL_MS'] ?? '').trim());
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_HOLD_TTL_MS) + graceMs;
}

export interface AgentInvokeHoldInput {
  actorId: string;
  initiativeId: string | null;
  /** The run id, when it is known before the call (the chat invoke). */
  sourceId?: string | null;
  confirmed?: { allocation?: boolean; envelope?: boolean; userBudget?: boolean };
}

/** Judge and hold one agent invoke. The caller renders a refusal with spendRefusalResponse. */
export async function holdAgentInvoke(input: AgentInvokeHoldInput): Promise<ReserveSpendResult> {
  const { reserveSpend, HOLD_GRACE_MS } = await import('./spend-holds.js');
  return reserveSpend({
    initiativeId: input.initiativeId,
    actorId: input.actorId,
    source: AGENT_INVOKE_SOURCE,
    sourceId: input.sourceId ?? null,
    forecast: agentInvokeForecast(),
    ...(input.confirmed ? { confirmed: input.confirmed } : {}),
    expiresInMs: agentInvokeHoldTtlMs(HOLD_GRACE_MS),
  });
}

/** Give back a hold whose invoke never reached the runtime. */
export async function releaseAgentInvokeHold(holdId: string | null | undefined): Promise<void> {
  if (!holdId) return;
  const { releaseHold } = await import('../providers/spend-holds.js');
  await releaseHold(holdId);
}

/** Point an already-taken hold at the ledger key that will settle it. */
export async function bindAgentInvokeHold(holdId: string | null | undefined, sourceId: string): Promise<void> {
  if (!holdId) return;
  const { bindHoldSource } = await import('../providers/spend-holds.js');
  await bindHoldSource(holdId, AGENT_INVOKE_SOURCE, sourceId);
}

export interface InvokeUsage { usage: TokenUsage; model: string | null; costUsd: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A usage block on an agent event, if it carries one: `usage` at the top
 * level or under `result`, camelCase or snake_case (the AG-UI SDKs drift
 * between the two), with an optional `model` and a reported `costUsd`.
 * Null when there is no usable token count.
 */
export function usageFromEvent(ev: unknown): InvokeUsage | null {
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as Record<string, unknown>;
  const result = e['result'] && typeof e['result'] === 'object' ? e['result'] as Record<string, unknown> : null;
  const u = (e['usage'] ?? result?.['usage']) as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return null;
  const inputTokens = num(u['inputTokens'] ?? u['input_tokens']);
  const outputTokens = num(u['outputTokens'] ?? u['output_tokens']);
  if (inputTokens == null && outputTokens == null) return null;
  const cacheRead = num(u['cacheReadInputTokens'] ?? u['cache_read_input_tokens']);
  const cacheWrite = num(u['cacheWriteInputTokens'] ?? u['cache_write_input_tokens']);
  const modelRaw = e['model'] ?? e['modelId'] ?? e['model_id'] ?? u['model'] ?? result?.['model'];
  return {
    usage: {
      inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0,
      ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
    },
    model: typeof modelRaw === 'string' && modelRaw.trim() ? modelRaw.trim() : null,
    costUsd: num(u['costUsd'] ?? u['cost_usd'] ?? e['costUsd'] ?? e['cost_usd']),
  };
}

export interface RecordAgentInvokeInput {
  /** The ledger key: the AG-UI run id, or the summarize run id. */
  sourceId: string;
  actorId: string | null;
  initiativeId: string | null;
  /** Which feature spent it (`chat:<agentId>`, `summarize:<tenant>`), kept as the row's trigger. */
  feature: string;
  usage: InvokeUsage | null;
}

/**
 * The ledger row for one invoke. Priced from the usage block when there is
 * one (`reported` when the agent states its own cost, else `estimated` from
 * the price table); written with an unknown cost when there is none. Best
 * effort, like every ledger write: it never fails the answer.
 */
export async function recordAgentInvoke(input: RecordAgentInvokeInput): Promise<void> {
  try {
    const [{ recordSpend }, { estimateUsageCost }] = await Promise.all([
      import('../providers/spend-ledger.js'), import('./model-prices.js'),
    ]);
    const model = input.usage?.model ?? DEFAULT_AGENT_INVOKE_MODEL;
    const estimated = input.usage ? estimateUsageCost(model, input.usage.usage) : null;
    const reported = input.usage?.costUsd ?? null;
    const costUsd = reported ?? estimated;
    await recordSpend({
      source: AGENT_INVOKE_SOURCE,
      sourceId: input.sourceId,
      initiativeId: input.initiativeId,
      boxId: null,
      actorId: input.actorId,
      trigger: input.feature,
      model,
      costUsd,
      costBasis: costUsd == null ? 'unknown' : reported != null ? 'reported' : 'estimated',
      estimatedCostUsd: estimated,
      inputTokens: input.usage?.usage.inputTokens ?? null,
      outputTokens: input.usage?.usage.outputTokens ?? null,
      provider: 'bedrock',
    });
  } catch (err) {
    console.warn(`[agent-invoke-spend] ${input.feature} ${input.sourceId} not recorded: ${(err as Error).message}`);
  }
}

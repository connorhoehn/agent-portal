// What a run cost, and who to believe about it.
//
// `lib/pricing.ts` is the equivalent module for TRACES: it prices Bedrock token
// counts the middleware observed itself, and it spends thirty lines arguing that
// an unpriced model must record `null` rather than `0`, "because a 0 with real
// token counts beside it does not read as unpriced — it reads as *free*".
//
// This module is that doctrine applied to AGENT RUNS, where the number does not
// come from a table at all. Claude Code reports `total_cost_usd` on its `result`
// event and the middleware records it. Three things go wrong with that, and each
// one is a measured failure rather than a hypothetical:
//
//   1. **Silence read as zero.** `Number(ev['total_cost_usd'] ?? 0)` turned "no
//      cost reported" into a countable zero that flowed to `bot_runs.cost_usd`,
//      `agent_project_runs.cost_usd` and `agent_jobs.result.costUsd`. The write
//      paths already accept null (`cost_usd = COALESCE(:cost, cost_usd)`), and
//      `agent_run_attribution_schema.sql` states the rule outright — degrade to
//      "burn unknown", never to "burn zero". Only the producer collapsed it.
//
//   2. **A confident lie from a local model.** Measured 2026-09-11 against a
//      llama-server on loopback serving Qwen3.6-35B: Claude Code reported
//      `total_cost_usd: 0.003711` for 1227 in / 2 out — exactly Anthropic
//      first-party Sonnet 4.5 list price — with `provider: "firstParty"`, for a
//      run that spent nothing. It prices from its own table and has no way to
//      know the endpoint was loopback. That figure is worse than the zero in (1)
//      because it is non-zero and authoritative-looking: it bills an
//      initiative's allocation and an SME's sprint envelope, and trips all three
//      brakes in `bot-runner.ts`, for dollars nobody spent. The whole premise of
//      local compute — "the maintenance floor drops because a workstation
//      absorbed the batch" — inverts, and the floor goes *up*.
//
//      It cannot be corrected by looking at the recorded model either: Claude
//      Code 2.1.236 rejects an unrecognized `--model` client-side before any
//      HTTP request, so a local run must send a real Anthropic id that
//      llama.cpp then ignores. `agent_project_runs.model` says
//      `claude-sonnet-4-5-…` for a run served by Qwen. The one column that looks
//      like it distinguishes them actively misleads.
//
//   3. **Nobody asked who ran it.** So the fix is a provider recorded ALONGSIDE
//      the cost, from the middleware's own knowledge of which execution path it
//      took — never from the run's self-report. `schema/local_compute_worker_schema.sql`
//      adds the column; this module is the rule.
//
// The rule, in one line: a local run costs a confident **0**, a cloud run costs
// what it reported or **null**, and the provider is always recorded so a wrong
// number is selectable later. (1) and (2) are opposite errors and both are fixed
// by refusing to let the executor be the pricing authority.

/**
 * Where the model that served a run actually ran.
 *
 * Not the model id — see (2) above, the id lies. This is the middleware's own
 * record of which execution path it took:
 *
 *   * `bedrock`  — AgentCore Runtime / Bedrock. Billed, and the reported figure
 *                  is the best number available.
 *   * `local`    — a paired workstation's own inference server. No marginal
 *                  model cost, whatever the run claims.
 *   * `simulated`— the mock providers and `SIMULATED_RESULT`. A plausible
 *                  fiction on purpose; kept distinguishable so a demo's numbers
 *                  never merge into a real rollup.
 */
import type { TokenUsage } from './pricing.js';

export type ModelProvider = 'bedrock' | 'local' | 'simulated';

const PROVIDERS: readonly ModelProvider[] = ['bedrock', 'local', 'simulated'];

/**
 * A provider read off the wire or out of a JSONB column, or `null`.
 *
 * Validated rather than cast, because both sources are outside this process:
 * `agent_jobs.result->>'provider'` was written by whatever executed the job, and
 * a claim's completion body is posted by a paired workstation. An unrecognized
 * string becomes `null` — "not recorded", which is a state the schema already
 * has a meaning for — instead of being stored and later matched by nothing.
 */
export function asModelProvider(v: unknown): ModelProvider | null {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v)
    ? v as ModelProvider
    : null;
}

/**
 * The cost a run reported, or `null` when it reported none.
 *
 * Absent, non-numeric and NaN all mean "no figure arrived" and all yield
 * `null`. A reported `0` is KEPT as `0`: that is Claude Code stating the run
 * cost nothing — it does exactly that on a pre-flight API error — which is a
 * different claim from silence, and the difference is the whole point of this
 * module.
 *
 * Negative is treated as absent. There is no reading of a negative charge that
 * belongs in an initiative's spend rollup.
 *
 * ⚠️ The type check before the coercion is load-bearing, and its absence was this
 * module's own version of the bug it was written to fix. `Number('')` is `0`, and
 * so are `Number([])` and `Number(false)` — so a bare `Number(raw)` turned an
 * empty field into a *reported* zero, which is the positive claim "this run cost
 * nothing" manufactured out of a value that said nothing at all. For a local run
 * the recorded figure is 0 either way and it never showed; for a Bedrock run it
 * is the difference between `cost_usd = NULL` and `cost_usd = 0`, i.e. between
 * "burn unknown" and "free", written straight into an initiative's spend rollup.
 * A numeric string is still accepted — JSON from a worker is not always typed —
 * but only when it actually contains a number.
 */
export function parseReportedCost(ev: Record<string, unknown>): number | null {
  const raw = ev['total_cost_usd'];
  const numeric = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

/**
 * Where a recorded figure came from (DE-30's `spend_entries.cost_basis`):
 * `reported` is the executor's own `total_cost_usd`, `estimated` is tokens ×
 * the price table (`lib/model-prices.ts`), `unknown` is null — never 0.
 */
export type CostBasis = 'reported' | 'estimated' | 'unknown';

/**
 * The `usage` block a `result` event carries, as a `TokenUsage`, or `null`
 * when there is none. Cache buckets are kept apart from `input_tokens` on
 * purpose: on a real Claude Code run `cache_read_input_tokens` is where most
 * of the tokens live (`lib/devbox-fleet.ts::extractUsage` measured ~22k cached
 * against 10 fresh), and they are priced at a fraction of the input rate.
 */
export function parseResultUsage(ev: Record<string, unknown>): TokenUsage | null {
  const direct = ev['usage'];
  const nested = (ev['message'] as { usage?: unknown } | undefined)?.usage;
  const usage = (direct ?? nested) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const n = (v: unknown): number | null => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(x) && x >= 0 ? x : null;
  };
  const input = n(usage['input_tokens']);
  const output = n(usage['output_tokens']);
  const cacheWrite = usage['cache_creation_input_tokens'] === undefined ? 0 : n(usage['cache_creation_input_tokens']);
  const cacheRead = usage['cache_read_input_tokens'] === undefined ? 0 : n(usage['cache_read_input_tokens']);
  // Missing/malformed usage cannot establish a free run or a partial price.
  if (input === null || output === null || cacheWrite === null || cacheRead === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  };
}

export interface SettledCost {
  /** What to record. `null` = burn unknown. */
  costUsd: number | null;
  costBasis: CostBasis;
  /**
   * The table's figure, kept BESIDE the recorded one even when the executor
   * reported, so a gap between Claude Code's price list and the Bedrock rate
   * is selectable later (DE-32 drift check). Null when the table cannot price.
   */
  estimatedCostUsd: number | null;
}

/**
 * Prefer the reported figure, fall back to the estimate, else unknown. The
 * reported figure wins when both exist because it is the executor's own
 * account of the run; the estimate is recorded next to it rather than
 * discarded. Pure.
 */
export function settleRunCost(reportedUsd: number | null, estimatedUsd: number | null): SettledCost {
  if (reportedUsd !== null) return { costUsd: reportedUsd, costBasis: 'reported', estimatedCostUsd: estimatedUsd };
  if (estimatedUsd !== null) return { costUsd: estimatedUsd, costBasis: 'estimated', estimatedCostUsd: estimatedUsd };
  return { costUsd: null, costBasis: 'unknown', estimatedCostUsd: null };
}

export interface RunCost {
  /** What to record. `null` = burn unknown. */
  costUsd: number | null;
  provider: ModelProvider;
  /**
   * Set when the recorded figure differs from what the run claimed, so the
   * override is visible in a transcript rather than silent.
   */
  note?: string;
}

/**
 * Decide what a finished run cost, given where it ran and what it claimed.
 *
 * Pure — the whole point is that this is testable without a runtime, a database
 * or a laptop.
 */
export function resolveRunCost(provider: ModelProvider, reportedUsd: number | null): RunCost {
  if (provider === 'local') {
    // A confident zero, not an unknown. The marginal cost of a token generated
    // on hardware the org already owns is genuinely nothing — that is the
    // feature's entire value proposition, and recording `null` here would throw
    // it away by making local work indistinguishable from unmetered work.
    //
    // Deliberately ignores `reportedUsd`: see (2) in the header. The claimed
    // figure is a first-party price list applied to loopback tokens. It is also
    // the one number a paired workstation asserts across a trust boundary, and
    // "the SME's laptop decides what its runs cost" is not an authority model.
    const note = reportedUsd !== null && reportedUsd > 0
      ? `run reported $${reportedUsd.toFixed(6)}; recorded $0 — served by local inference`
      : undefined;
    return { costUsd: 0, provider, note };
  }
  // Bedrock and simulated: the reported figure is the best available, and its
  // absence stays absent.
  return { costUsd: reportedUsd, provider };
}

/**
 * Whether a `result` event describes a run that actually succeeded.
 *
 * `subtype` alone is not enough, and this is a live bug in the shipped devbox
 * path rather than a hypothetical. Measured on Claude Code 2.1.236, a hard API
 * failure returns:
 *
 *   {"is_error": true, "terminal_reason": "api_error", "api_error_status": 400,
 *    "subtype": "success", "total_cost_usd": 0, "num_turns": 1,
 *    "result": "API Error (…): 400 The provided model identifier is invalid.."}
 *
 * and `claude -p` exits **0**, so the `devbox_end` exit-code check downstream
 * does not catch it either. Reading `subtype` on its own recorded a run that
 * never reached a model as successful at $0, and `requiresReview` then parked it
 * in `awaiting_review` — asking a human to accept an artifact that was never
 * produced. Nothing in the repo read `is_error` before this.
 *
 * Not local-compute-specific: the devbox pins a Haiku inference profile, and the
 * day that id goes stale or model access is revoked, every lab run reports
 * success.
 *
 * `is_error` is authoritative when present, so it is checked first.
 */
export function resultEventSucceeded(ev: Record<string, unknown>): boolean {
  if (ev['is_error'] === true) return false;
  return String(ev['subtype'] ?? '') === 'success';
}

const ERROR_DETAIL_MAX = 600;

/** The failure text a non-success `result` event carries, if any. */
export function resultEventError(ev: Record<string, unknown>): string | undefined {
  if (resultEventSucceeded(ev)) return undefined;
  const text = typeof ev['result'] === 'string' ? ev['result'].trim() : '';
  const parts = [
    ev['terminal_reason'] ? String(ev['terminal_reason']) : '',
    ev['api_error_status'] ? `status ${String(ev['api_error_status'])}` : '',
    text,
  ].filter(Boolean);
  const joined = parts.length ? parts.join(': ') : `run reported ${String(ev['subtype'] ?? 'failure')}`;
  return joined.length > ERROR_DETAIL_MAX ? `${joined.slice(0, ERROR_DETAIL_MAX)}…` : joined;
}

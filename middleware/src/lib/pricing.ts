// Bedrock pricing in USD per 1K tokens (AWS Bedrock pricing page, us-east-1
// on-demand). Centralized so the cost surface, trace-sink, and harness runner
// all agree on the same numbers. Keep current — the dollar values shown on
// the dashboards are only as accurate as this map.
//
// AWS-native only. The Nova/Titan rates the nine agents use live here in
// code. The devbox's Bedrock Claude inference profiles — the one deliberate
// exception to the AWS-native model rule — are priced from CONFIG, not from
// this file: `lib/model-prices.ts` reads SSM `/orgiq/pricing/model_prices`
// (checked-in defaults in `lib/model-prices-defaults.ts`, the mock fixture
// offline) and registers itself through `registerPriceSource` below. No
// Claude rate is hard-coded in this module (DE-32), and this module imports
// no config so the fleet and the runner can price without a credential.
//
// "Embeddings" model output tokens are zero by definition; we keep the slot
// for shape uniformity so `estimateCost` doesn't need to special-case.

import { createHash } from 'node:crypto';

export interface BedrockPrice {
  input: number;        // USD per 1K input tokens
  output: number;       // USD per 1K output tokens
  /** USD per 1K prompt-cache write tokens. Absent = this model cannot price cache writes. */
  cacheWrite?: number;
  /** USD per 1K prompt-cache read tokens. Absent = this model cannot price cache reads. */
  cacheRead?: number;
  /** Where the rate came from (a URL, a bill, 'mock'). Required for config-supplied rates. */
  source?: string;
  /** ISO date the rate took effect. Required for config-supplied rates. */
  effectiveFrom?: string;
}

export const BEDROCK_PRICING: Record<string, BedrockPrice> = {
  'amazon.nova-pro-v1:0':         { input: 0.0008,   output: 0.0032 },
  'amazon.nova-lite-v1:0':        { input: 0.00006,  output: 0.00024 },
  'amazon.nova-micro-v1:0':       { input: 0.000035, output: 0.00014 },
  'amazon.titan-embed-text-v2:0': { input: 0.00002,  output: 0 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** `cache_creation_input_tokens` — tokens written to the prompt cache. */
  cacheWriteTokens?: number;
  /** `cache_read_input_tokens` — tokens re-read from the prompt cache. */
  cacheReadTokens?: number;
}

/**
 * Cross-region and global inference profiles (`us.`, `eu.`, `apac.`,
 * `global.`) bill as the underlying foundation model, so a lookup keyed by
 * bare id must try the exact id first and then the id with that prefix
 * stripped — otherwise a `us.amazon.nova-pro-v1:0` run reads as unpriced.
 */
const PROFILE_PREFIX_RE = /^(us|eu|apac|global)\./;

/**
 * One id rule for every price lookup: the exact id if `known` accepts it,
 * else the id without its geo/global profile prefix if `known` accepts that,
 * else `null`. Pure, so the mock fixture and the SSM table resolve the same.
 */
export function normalizeModelId(modelId: string, known: (id: string) => boolean): string | null {
  // Telemetry and older callers may omit the id at runtime. Preserve the
  // unpriced result instead of failing the trace pipeline on `.trim()`.
  if (typeof modelId !== 'string') return null;
  const id = modelId.trim();
  if (!id) return null;
  if (known(id)) return id;
  const bare = id.replace(PROFILE_PREFIX_RE, '');
  if (bare !== id && known(bare)) return bare;
  return null;
}

/** A further price table consulted after BEDROCK_PRICING; keyed by exact id. */
export type PriceSource = (modelId: string) => BedrockPrice | undefined;

let extraSource: PriceSource | null = null;

/**
 * Register the config-supplied table (`lib/model-prices.ts` does this at
 * import). Kept as a hook rather than an import so this module needs no
 * config and no credential — the fleet accrues a box's live spend from here.
 */
export function registerPriceSource(source: PriceSource | null): void {
  extraSource = source;
}

function lookup(id: string): BedrockPrice | undefined {
  return BEDROCK_PRICING[id] ?? extraSource?.(id);
}

/** The price row for `modelId` after the one id rule, or `null`. */
export function priceFor(modelId: string): BedrockPrice | null {
  const id = normalizeModelId(modelId, (candidate) => lookup(candidate) !== undefined);
  return id ? lookup(id) ?? null : null;
}

/** Whether `modelId` can be priced at all. */
export function hasPricing(modelId: string): boolean {
  return priceFor(modelId) !== null;
}

function tokens(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Price every bucket of a usage block separately, or `null`.
 *
 * `null` when the model has no row, and ALSO when a bucket with tokens in it
 * has no rate — a cache-heavy Claude Code run priced at its input rate alone
 * would be wrong by an order of magnitude and would look exact, so there is
 * never a partial price. A bucket with zero tokens needs no rate.
 */
export function estimateUsageCost(modelId: string, usage: TokenUsage): number | null {
  const p = priceFor(modelId);
  if (!p) return null;
  const buckets: Array<[number, number | undefined]> = [
    [tokens(usage.inputTokens), p.input],
    [tokens(usage.outputTokens), p.output],
    [tokens(usage.cacheWriteTokens), p.cacheWrite],
    [tokens(usage.cacheReadTokens), p.cacheRead],
  ];
  let total = 0;
  for (const [count, rate] of buckets) {
    if (count === 0) continue;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
    total += (count / 1000) * rate;
  }
  return total;
}

/**
 * Estimate USD cost for a single Bedrock invocation.
 *
 * Returns 0 for unknown modelIds — callers can detect "no pricing data" with
 * `hasPricing` / `estimateCostOrNull`. We do NOT throw on unknown ids because
 * partial cost telemetry is better than crashing the trace path.
 */
export function estimateCost(modelId: string, usage: TokenUsage): number {
  return estimateUsageCost(modelId, usage) ?? 0;
}

/**
 * Cost, or `null` when the model has no price.
 *
 * The distinction matters more than it looks. `estimateCost` returns 0 for an
 * unknown model, and a 0 with real token counts beside it does not read as
 * "unpriced" — it reads as *free*. The devbox is exactly that case: the
 * computer lab runs Claude Code on Bedrock Claude inference profiles, and for
 * a long time this map held only the Nova/Titan models the nine agents use,
 * so every lab run — the expensive kind, a Claude model in a microVM — was
 * recording `cost_usd = 0` with a full token count.
 *
 * That is not a rounding problem, it is a governance one: the program
 * operating model meters initiatives in dollars (`initiative_budgets`,
 * `budget_grants`, `estimated_cost_usd`), so a lab run priced at zero spends
 * nobody's envelope and trips none of the three brakes in `bot-runner`. Zero
 * is the one value that is both wrong and invisible.
 *
 * `null` propagates honestly instead: SQL `SUM` skips it, so an unpriced run
 * is *excluded* from a total rather than counted as free, and the cost surface
 * can say "unknown" where it means unknown.
 *
 * The Claude rates are deliberately NOT in this file: Bedrock is
 * partner-operated with its own price list, and neither the AWS pricing page
 * nor the Price List API publishes current-generation Anthropic models. They
 * come from config (`lib/model-prices.ts`), each row carrying its source and
 * effective date, so a number here never looks more authoritative than it is.
 */
export function estimateCostOrNull(modelId: string, usage: TokenUsage): number | null {
  return estimateUsageCost(modelId, usage);
}

/**
 * Short content-addressed hash for prompt version stamps. 12 hex chars of
 * SHA-256 ≈ 48 bits of namespace — collision-resistant across the ~1k prompts
 * a single OrgIQ deployment is likely to hold, and short enough to render as
 * a chip in the UI.
 */
export function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Full SHA-256 hex digest. Stored alongside the short hash so we can detect
 * collisions (different content, same short SHA) without paying the storage
 * cost of full hashes in display paths.
 */
export function fullSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

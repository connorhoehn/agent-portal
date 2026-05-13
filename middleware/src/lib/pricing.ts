// Bedrock pricing in USD per 1K tokens (AWS Bedrock pricing page, us-east-1
// on-demand). Centralized so the cost surface, trace-sink, and harness runner
// all agree on the same numbers. Keep current — the dollar values shown on
// the dashboards are only as accurate as this map.
//
// AWS-native only. Anthropic / Claude is intentionally excluded — OrgIQ's
// model policy says nova-pro for vision+text and titan-v2 for embeddings.
//
// "Embeddings" model output tokens are zero by definition; we keep the slot
// for shape uniformity so `estimateCost` doesn't need to special-case.

import { createHash } from 'node:crypto';

export interface BedrockPrice {
  input: number;   // USD per 1K input tokens
  output: number;  // USD per 1K output tokens
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
}

/**
 * Estimate USD cost for a single Bedrock invocation.
 *
 * Returns 0 for unknown modelIds — callers can detect "no pricing data" by
 * checking BEDROCK_PRICING explicitly. We do NOT throw on unknown ids because
 * partial cost telemetry is better than crashing the trace path.
 */
export function estimateCost(modelId: string, usage: TokenUsage): number {
  const p = BEDROCK_PRICING[modelId];
  if (!p) return 0;
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  return (input / 1000) * p.input + (output / 1000) * p.output;
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

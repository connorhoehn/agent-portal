// The checked-in default price table for the devbox's Claude inference
// profiles (DE-32). USD per 1K tokens, keyed by the BARE foundation-model id;
// `us.` / `eu.` / `apac.` / `global.` profiles resolve to these through
// `pricing.ts::normalizeModelId`.
//
// WHAT THESE NUMBERS ARE, STATED SO NOBODY MISTAKES THEM FOR THE BILL. They
// are Anthropic's FIRST-PARTY list prices, read from
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-28
// (base input / 5-minute cache write / cache read / output). Bedrock is
// partner-operated with its own price list, and neither the AWS pricing page
// nor the Price List API publishes current-generation Anthropic models in a
// form a script can read — the Bedrock page was checked the same day and
// carries no figures in its text. Bedrock's on-demand rates have tracked the
// first-party list closely, but nothing in this tree has measured that, so a
// cost priced from this table is recorded with `cost_basis = 'estimated'`,
// never 'reported'.
//
// OVERRIDE, DON'T EDIT. The operator supplies the real rates in SSM
// `/orgiq/pricing/model_prices` (the console's on-demand rate, with the URL
// and date as `source`); an SSM row replaces the default for the same id.
// `MODEL_PRICES_DEFAULTS=off` drops this table entirely so an unsupplied
// model prices to null, which was the behaviour before DE-32.
//
// Only the models the devbox may run (`DEVBOX_ALLOWED_MODELS`,
// infra/lib/devbox-stack.ts) are listed. Nothing else in the platform calls
// an Anthropic model — AWS-native models only — so a wider table would only
// invite one.

import type { BedrockPrice } from './pricing.js';

export interface ModelPriceEntry extends BedrockPrice {
  source: string;
  effectiveFrom: string;
}

const SOURCE =
  'Anthropic first-party list price, https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-28; '
  + 'Bedrock on-demand is partner-priced and unverified — override in SSM /orgiq/pricing/model_prices';
const EFFECTIVE_FROM = '2026-10-28';

/** $/MTok on the page → $/1K here. */
function perK(perMillion: number): number {
  return perMillion / 1000;
}

export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPriceEntry>> = Object.freeze({
  // The devbox default and small/fast model.
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    input: perK(1), output: perK(5), cacheWrite: perK(1.25), cacheRead: perK(0.10),
    source: SOURCE, effectiveFrom: EFFECTIVE_FROM,
  },
  'anthropic.claude-sonnet-5': {
    input: perK(2), output: perK(10), cacheWrite: perK(2.50), cacheRead: perK(0.20),
    source: SOURCE, effectiveFrom: EFFECTIVE_FROM,
  },
  'anthropic.claude-opus-4-8': {
    input: perK(5), output: perK(25), cacheWrite: perK(6.25), cacheRead: perK(0.50),
    source: SOURCE, effectiveFrom: EFFECTIVE_FROM,
  },
});

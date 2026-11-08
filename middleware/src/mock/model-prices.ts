// The model price table — SSM `/orgiq/pricing/model_prices`, offline (DE-32).
//
// Price rows are CONFIGURATION, not aggregates: one row per model the mock
// world runs, each stamped `source: 'mock'` so a figure priced from it can
// never be mistaken for a Bedrock rate. Keyed by the ids the mock fleet and
// the mock agent loop actually send (`claude-sonnet-5` in mock/devbox-fleet.ts
// and mock/devbox-tail.ts, `sonnet` in mock/devbox-agent-loop.ts) plus the
// bare ids of the devbox allowlist, so `us.anthropic.claude-sonnet-5` from
// mock/agent-project-runs.ts resolves through the same prefix rule as a real
// profile id.
//
// The numbers are the checked-in defaults' numbers, read from the module that
// owns them rather than retyped (contract.ts rule 2), so the mock and the
// defaults cannot drift apart silently.
//
// `empty` is the operator-has-not-supplied-rates world: every Claude run
// prices to null, cost_basis 'unknown'. Declared explicitly so a scenario
// can blank the table and exercise that path.

import { defineFixture } from './core/index.js';
import { DEFAULT_MODEL_PRICES, type ModelPriceEntry } from '../lib/model-prices-defaults.js';

export interface ModelPriceRow extends ModelPriceEntry {
  modelId: string;
}

const HAIKU = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const SONNET = 'anthropic.claude-sonnet-5';
const OPUS = 'anthropic.claude-opus-4-8';

function row(modelId: string, from: string): ModelPriceRow {
  const d = DEFAULT_MODEL_PRICES[from]!;
  return {
    modelId,
    input: d.input, output: d.output,
    ...(d.cacheWrite !== undefined ? { cacheWrite: d.cacheWrite } : {}),
    ...(d.cacheRead !== undefined ? { cacheRead: d.cacheRead } : {}),
    source: 'mock',
    effectiveFrom: d.effectiveFrom,
  };
}

export const modelPriceRows = defineFixture<ModelPriceRow>({
  key: 'model-prices',
  scenarios: {
    default: () => [
      row(HAIKU, HAIKU),
      row(SONNET, SONNET),
      row(OPUS, OPUS),
      // The ids the mock fleet and the mock agent loop send.
      row('claude-sonnet-5', SONNET),
      row('sonnet', SONNET),
      // The voice navigator's delegation model, so MOCK_VOICE's scripted tokens price (G11).
      row('gpt-6-luna', 'gpt-6-luna'),
    ],
    empty: () => [],
  },
});

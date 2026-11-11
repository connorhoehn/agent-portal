// `executeDevboxTask`'s cost settlement (DE-32): a `result` with usage but no
// `total_cost_usd` is priced from the table as 'estimated'; one with neither
// is 'unknown' and null; a reported figure wins and the estimate is kept
// beside it. The stream is faked at the AgentCore client boundary so no
// runtime is needed.

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { executeDevboxTask } from '../devbox-runner.js';
import { _resetModelPricesForTest } from '../model-prices.js';
import { DEFAULT_MODEL_PRICES } from '../model-prices-defaults.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const SONNET_PROFILE = 'us.anthropic.claude-sonnet-5';
const sonnet = DEFAULT_MODEL_PRICES['anthropic.claude-sonnet-5']!;

function clientOf(frames: Array<Record<string, unknown>>): BedrockAgentCoreClient {
  const encoder = new TextEncoder();
  async function* body(): AsyncGenerator<Uint8Array> {
    for (const f of frames) yield encoder.encode(`data: ${JSON.stringify(f)}\n`);
  }
  return { send: async () => ({ response: body() }) } as unknown as BedrockAgentCoreClient;
}

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 };
const EXPECTED = sonnet.input * 1 + sonnet.output * 0.5 + sonnet.cacheWrite! * 2 + sonnet.cacheRead! * 10;

async function run(frames: Array<Record<string, unknown>>, model?: string) {
  return executeDevboxTask({
    sessionId: 's-1', prompt: 'do the thing', runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/x',
    client: clientOf(frames), ...(model ? { model } : {}),
  });
}

beforeEach(() => {
  process.env['MOCK_AGENTCORE'] = 'true';
  fixtureRegistry.resetAll('default');
  _resetModelPricesForTest();
});
afterAll(() => { fixtureRegistry.resetAll('default'); delete process.env['MOCK_AGENTCORE']; });

describe('executeDevboxTask cost basis', () => {
  it('carries a failed result code without replacing its detail, even when the process exits zero', async () => {
    const outcome = await run([
      { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'needs_gpu_pool', result: 'The cold-start test waits for a GPU node.' },
      { type: 'devbox_end', exit_code: 0 },
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.failureCode).toBe('needs_gpu_pool');
    expect(outcome.error).toBe('needs_gpu_pool: The cold-start test waits for a GPU node.');
  });

  it('does not invent a structured code for a legacy result or a successful result', async () => {
    const legacy = await run([{ type: 'result', subtype: 'error', result: 'The worker timed out.' }]);
    expect(legacy.failureCode).toBeUndefined();
    expect(legacy.error).toBe('The worker timed out.');
    const success = await run([{ type: 'result', subtype: 'success', terminal_reason: 'api_error' }]);
    expect(success.ok).toBe(true);
    expect(success.failureCode).toBeUndefined();
  });

  it.each([{}, [], { input_tokens: 100 }, { input_tokens: 100, output_tokens: -1 },
    { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 'invalid' }])(
    'does not turn incomplete or malformed usage into a free or partially priced run: %j', async (usage) => {
      const outcome = await run([{ type: 'result', subtype: 'success', usage }], SONNET_PROFILE);
      expect(outcome.costUsd).toBeNull();
      expect(outcome.costBasis).toBe('unknown');
    },
  );
  it('a result with usage but no total_cost_usd yields costBasis estimated with the table figure', async () => {
    const outcome = await run([
      { type: 'devbox_start', model: SONNET_PROFILE },
      { type: 'result', subtype: 'success', num_turns: 2, usage: USAGE, result: 'done' },
      { type: 'devbox_end', exit_code: 0 },
    ]);
    expect(outcome.ok).toBe(true);
    expect(outcome.model).toBe(SONNET_PROFILE);
    expect(outcome.costBasis).toBe('estimated');
    expect(outcome.costUsd).toBeCloseTo(EXPECTED, 10);
    expect(outcome.estimatedCostUsd).toBeCloseTo(EXPECTED, 10);
    expect(outcome.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 10_000 });
  });

  it('a result with neither usage nor a figure yields unknown and null', async () => {
    const outcome = await run([
      { type: 'devbox_start', model: SONNET_PROFILE },
      { type: 'result', subtype: 'success', num_turns: 1, result: 'done' },
      { type: 'devbox_end', exit_code: 0 },
    ]);
    expect(outcome.costBasis).toBe('unknown');
    expect(outcome.costUsd).toBeNull();
    expect(outcome.estimatedCostUsd).toBeNull();
  });

  it('a reported figure wins, and the estimate is recorded beside it for the drift check', async () => {
    const outcome = await run([
      { type: 'devbox_start', model: SONNET_PROFILE },
      { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.05, usage: USAGE, result: 'done' },
    ]);
    expect(outcome.costBasis).toBe('reported');
    expect(outcome.costUsd).toBe(0.05);
    expect(outcome.estimatedCostUsd).toBeCloseTo(EXPECTED, 10);
  });

  it('usage on a model the table cannot price is unknown, never 0 — and the requested model is the fallback id', async () => {
    const blank = await run([
      { type: 'devbox_start', model: 'us.anthropic.claude-unlisted' },
      { type: 'result', subtype: 'success', num_turns: 1, usage: USAGE, result: 'done' },
    ]);
    expect(blank.costBasis).toBe('unknown');
    expect(blank.costUsd).toBeNull();

    // No devbox_start announcement: the caller's requested model prices the run.
    const requested = await run([
      { type: 'result', subtype: 'success', num_turns: 1, usage: USAGE, result: 'done' },
    ], SONNET_PROFILE);
    expect(requested.model).toBe(SONNET_PROFILE);
    expect(requested.costBasis).toBe('estimated');

    fixtureRegistry.resetAll('empty');
    const unsupplied = await run([
      { type: 'devbox_start', model: SONNET_PROFILE },
      { type: 'result', subtype: 'success', num_turns: 1, usage: USAGE, result: 'done' },
    ]);
    expect(unsupplied.costBasis).toBe('unknown');
    expect(unsupplied.costUsd).toBeNull();
  });
});

// DE-35: the mid-run meter (lib/run-meter.ts) and executeDevboxTask's cutoff.
// Usage is priced per bucket through the DE-32 table as frames arrive; at 80 %
// of the hold a top-up is asked for; at 100 % with no top-up the run is cut,
// the stream is aborted, and the session is stopped after the grace period
// when no devbox_end followed. The AgentCore client is faked at its boundary.

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { RunMeter, cutoffMessage } from '../run-meter.js';
import { executeDevboxTask } from '../devbox-runner.js';
import { _resetModelPricesForTest } from '../model-prices.js';
import { DEFAULT_MODEL_PRICES } from '../model-prices-defaults.js';
import { fixtureRegistry } from '../../mock/core/index.js';

const MODEL = 'us.anthropic.claude-sonnet-5';
const P = DEFAULT_MODEL_PRICES['anthropic.claude-sonnet-5']!;
/** One assistant turn: 1k input + 1k output fresh, plus cache reads (priced at the read rate). */
const turn = (id: string) => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 4000 } },
});
const TURN_USD = P.input * 1 + P.output * 1 + P.cacheRead! * 4;

beforeEach(() => {
  process.env['MOCK_AGENTCORE'] = 'true';
  fixtureRegistry.resetAll('default');
  _resetModelPricesForTest();
});
afterAll(() => { fixtureRegistry.resetAll('default'); delete process.env['MOCK_AGENTCORE']; });

describe('RunMeter', () => {
  it('prices usage per bucket and counts a repeated message once', () => {
    const m = new RunMeter({ ceilingUsd: 100, holdIds: ['h1'], model: MODEL });
    m.observe(turn('m1'));
    m.observe(turn('m1'));
    m.observe(turn('m2'));
    expect(m.meteredUsd).toBeCloseTo(TURN_USD * 2, 4);
    expect(m.cutoff).toBeNull();
  });

  it('asks for a top-up at 80 % and, granted, raises the ceiling and keeps going', async () => {
    const topUp = jest.fn(async () => ({ holdId: 'h2', amountUsd: TURN_USD * 2 }));
    const m = new RunMeter({ ceilingUsd: TURN_USD * 2, holdIds: ['h1'], model: MODEL, topUp });
    m.observe(turn('m1'));          // 50 %
    m.observe(turn('m2'));          // 100 %: a top-up is in flight, so no cut yet
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(m.cutoff).toBeNull();
    await m.settled();
    expect(m.ceilingUsd).toBeCloseTo(TURN_USD * 4, 4);
    expect(m.holdIds).toEqual(['h1', 'h2']);
    expect(m.cutoff).toBeNull();
    expect(m.signal.aborted).toBe(false);
  });

  it('refused, cuts at the ceiling: the signal aborts with the cutoff block', async () => {
    const onCut = jest.fn();
    const m = new RunMeter({ ceilingUsd: TURN_USD * 2, holdIds: ['h1'], model: MODEL, topUp: async () => null, onCut });
    m.observe(turn('m1'));
    m.observe(turn('m2'));
    await m.settled();
    expect(m.cutoff).toMatchObject({ reason: 'budget', holdIds: ['h1'] });
    expect(m.cutoff!.ceilingUsd).toBeCloseTo(TURN_USD * 2, 4);
    expect(m.cutoff!.meteredUsd).toBeCloseTo(TURN_USD * 2, 4);
    expect(m.signal.aborted).toBe(true);
    expect(onCut).toHaveBeenCalledTimes(1);
    expect(cutoffMessage(m.cutoff!)).toMatch(/^stopped at \$\d+\.\d\d of its \$\d+\.\d\d hold; raise the allocation or re-dispatch$/);
  });

  it('takes at most maxTopUps top-ups, then cuts', async () => {
    let n = 0;
    const m = new RunMeter({
      ceilingUsd: TURN_USD, holdIds: ['h1'], model: MODEL, maxTopUps: 1,
      topUp: async () => ({ holdId: `t${++n}`, amountUsd: TURN_USD }),
    });
    m.observe(turn('m1'));
    await m.settled();
    m.observe(turn('m2'));
    await m.settled();
    expect(n).toBe(1);
    expect(m.cutoff?.reason).toBe('budget');
  });

  it('a reported total_cost_usd above the priced figure counts', async () => {
    const m = new RunMeter({ ceilingUsd: 1, holdIds: ['h1'], model: MODEL });
    m.observe({ type: 'result', total_cost_usd: 1.5 });
    expect(m.cutoff?.meteredUsd).toBe(1.5);
  });

  it('tells the box a token ceiling: hold x (1 + top-ups) at the output rate', () => {
    const m = new RunMeter({ ceilingUsd: 1, holdIds: ['h1'], model: MODEL, maxTopUps: 2 });
    expect(m.boxBudget('ref-1')).toEqual({ max_fresh_tokens: Math.ceil((3 / P.output) * 1000), reason_ref: 'ref-1' });
    expect(new RunMeter({ ceilingUsd: 1, holdIds: [], model: 'no-such-model' }).boxBudget('x')).toBeNull();
  });
});

describe('executeDevboxTask with a meter', () => {
  function scripted(frames: Array<Record<string, unknown>>, sent: unknown[]): BedrockAgentCoreClient {
    const encoder = new TextEncoder();
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const f of frames) yield encoder.encode(`data: ${JSON.stringify(f)}\n`);
    }
    return { send: async (cmd: { input: unknown }) => { sent.push(cmd.input); return { response: body() }; } } as unknown as BedrockAgentCoreClient;
  }

  afterEach(() => jest.useRealTimers());

  it('aborts at the ceiling, books the metered estimate, and stops the session once after the grace period', async () => {
    jest.useFakeTimers();
    const sent: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];
    const stop = jest.fn(async () => undefined);
    const onStopped = jest.fn();
    const meter = new RunMeter({ ceilingUsd: TURN_USD * 2, holdIds: ['h1'], model: MODEL, topUp: async () => null });
    const outcome = await executeDevboxTask({
      sessionId: 's-1', prompt: 'spend', model: MODEL, runtimeArn: 'arn:x', client: scripted([
        { type: 'devbox_start', model: MODEL }, turn('m1'), turn('m2'), turn('m3'), turn('m4'),
        { type: 'result', total_cost_usd: 99 }, { type: 'devbox_end', exit_code: 0 },
      ], sent),
      meter, onEvent: (ev) => events.push(ev),
      cutoffBackstop: { stop, onStopped, graceMs: 30_000 },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.cutoff).toMatchObject({ reason: 'budget' });
    expect(outcome.error).toMatch(/^stopped at/);
    // The second turn reaches the ceiling while the top-up is being decided;
    // the refusal lands before the fourth: nothing after the cut was read.
    expect(events.filter((e) => e['type'] === 'assistant')).toHaveLength(3);
    expect(events.some((e) => e['type'] === 'result')).toBe(false);
    expect(outcome.costUsd).toBeCloseTo(TURN_USD * 3, 4);
    expect(outcome.costBasis).toBe('estimated');
    expect(events.find((e) => e['type'] === 'run_cutoff')).toMatchObject({ reason: 'budget' });
    // The payload told the box its own token ceiling.
    const payload = JSON.parse(new TextDecoder().decode((sent[0] as { payload: Uint8Array }).payload));
    expect(payload.budget.max_fresh_tokens).toBeGreaterThan(0);

    expect(stop).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(29_000);
    expect(stop).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e['type'] === 'devbox_reaped')).toMatchObject({ reason: 'budget' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a run that ends under its ceiling is untouched and stops nothing', async () => {
    jest.useFakeTimers();
    const stop = jest.fn(async () => undefined);
    const meter = new RunMeter({ ceilingUsd: TURN_USD * 10, holdIds: ['h1'], model: MODEL, topUp: async () => null });
    const outcome = await executeDevboxTask({
      sessionId: 's-1', prompt: 'small', model: MODEL, runtimeArn: 'arn:x',
      client: scripted([turn('m1'), { type: 'result', subtype: 'success', total_cost_usd: 0.01 }, { type: 'devbox_end', exit_code: 0 }], []),
      meter, cutoffBackstop: { stop, graceMs: 1_000 },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.cutoff).toBeUndefined();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it('the box\'s own budget kill (devbox_end killed_reason budget) is recorded as a cutoff', async () => {
    const outcome = await executeDevboxTask({
      sessionId: 's-1', prompt: 'x', model: MODEL, runtimeArn: 'arn:x',
      client: scripted([turn('m1'), { type: 'devbox_end', exit_code: -9, killed_reason: 'budget' }], []),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.cutoff?.reason).toBe('budget');
  });
});

// Unit tests for judge-config: the rubric-weighted composite that turns raw
// judge scores into the number the canary controller acts on, and the offline
// branch that reads and writes the rubric without SSM.

// `judge-config.ts` reads `config.mock.agentcore` to choose its store, and
// `src/config.ts` uses `import.meta` — which ts-jest cannot compile under the
// CommonJS test tsconfig. Every suite in this repo that reaches a module
// touching config stubs it the same way.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } },
}));

import { fixtureRegistry } from '../../mock/core/index.js';
import {
  DEFAULT_JUDGE_CONFIG, getJudgeConfig, invalidateJudgeConfig, setJudgeConfig, weightedComposite,
} from '../judge-config.js';
import { judgeConfigParam } from '../../mock/judge-config.js';

afterEach(() => {
  judgeConfigParam.reset();
  invalidateJudgeConfig();
});

describe('weightedComposite', () => {
  const dims = [
    { key: 'helpfulness', weight: 30 },
    { key: 'factuality', weight: 30 },
    { key: 'tone', weight: 20 },
    { key: 'conciseness', weight: 20 },
  ];

  it('computes the weighted mean over declared dimensions', () => {
    const scores = { helpfulness: 1, factuality: 0.5, tone: 0, conciseness: 1 };
    // (1*30 + 0.5*30 + 0*20 + 1*20) / 100 = 0.65
    expect(weightedComposite(scores, dims)).toBeCloseTo(0.65, 10);
  });

  it('equals the plain mean when weights are equal', () => {
    const equal = dims.map(d => ({ ...d, weight: 25 }));
    const scores = { helpfulness: 0.2, factuality: 0.8, tone: 0.9, conciseness: 0.6 };
    expect(weightedComposite(scores, equal)).toBeCloseTo(0.625, 10);
  });

  it('ignores dimensions missing from the score record', () => {
    const scores = { helpfulness: 1, factuality: 1 };
    // Only the two present keys contribute: (1*30 + 1*30) / 60 = 1
    expect(weightedComposite(scores, dims)).toBeCloseTo(1, 10);
  });

  it('ignores non-finite score values', () => {
    const scores = { helpfulness: 1, factuality: Number.NaN, tone: 0.5, conciseness: 0.5 };
    // (1*30 + 0.5*20 + 0.5*20) / 70
    expect(weightedComposite(scores, dims)).toBeCloseTo(50 / 70, 10);
  });

  it('falls back to a plain mean when total weight is zero', () => {
    const zero = dims.map(d => ({ ...d, weight: 0 }));
    const scores = { helpfulness: 0.4, factuality: 0.6 };
    expect(weightedComposite(scores, zero)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for an empty score record with zero-weight dims', () => {
    expect(weightedComposite({}, [])).toBe(0);
  });

  it('default config rubric weights sum to 100', () => {
    const total = DEFAULT_JUDGE_CONFIG.dimensions.reduce((s: number, d) => s + d.weight, 0);
    expect(total).toBe(100);
  });
});

// ── The offline branch ─────────────────────────────────────────────────────
//
// `getJudgeConfig` always DEGRADED correctly offline — no credential, so the
// `GetParameter` throws and the catch answers `DEFAULT_JUDGE_CONFIG`. What was
// missing was a store: the rubric could not be edited, and every read past the
// 20-second cache window paid a doomed SSM call and logged
// `UnrecognizedClientException` as if something were misconfigured.

describe('offline, the rubric is a fixture and not an SSM call', () => {
  it('reads the shipped rubric without touching SSM', async () => {
    await expect(getJudgeConfig()).resolves.toEqual(DEFAULT_JUDGE_CONFIG);
  });

  it('a write is visible to the very next read — no cache window in between', async () => {
    const before = await getJudgeConfig();
    expect(before.failThreshold).toBe(DEFAULT_JUDGE_CONFIG.failThreshold);

    await setJudgeConfig({ ...DEFAULT_JUDGE_CONFIG, failThreshold: 7, minSampleRate: 40 });

    // No `invalidateJudgeConfig()` here on purpose. Against SSM the 20s cache
    // would serve the stale value; offline the fixture IS the store, so the
    // editor on /iq/evaluations must not have to wait for a TTL to see its own
    // edit — that lag is what makes a control feel broken.
    const after = await getJudgeConfig();
    expect(after.failThreshold).toBe(7);
    expect(after.minSampleRate).toBe(40);
  });

  it('stores the SANITISED config, never the raw body', async () => {
    // 900 is outside 0–100 and would be clamped on the real path. A mock that
    // stored it would hold a shape production could not, which is worse than
    // having no mock at all.
    await setJudgeConfig({ minSampleRate: 900, failThreshold: -4, dimensions: [{ key: 'helpfulness', weight: 300 }] });
    const cfg = await getJudgeConfig();
    expect(cfg.minSampleRate).toBe(100);
    expect(cfg.failThreshold).toBe(0);
    expect(cfg.dimensions).toEqual([{ key: 'helpfulness', weight: 100 }]);
  });

  it('a reset puts the shipped rubric back', async () => {
    await setJudgeConfig({ ...DEFAULT_JUDGE_CONFIG, enabled: false });
    expect((await getJudgeConfig()).enabled).toBe(false);

    fixtureRegistry.get('judge-config')!.reset();
    expect(await getJudgeConfig()).toEqual(DEFAULT_JUDGE_CONFIG);
  });

  it('an absent parameter reads as the shipped defaults, and a write creates it', async () => {
    // The `empty` world is "the parameter was never written" — the
    // `ParameterNotFound` branch. Its VALUES are the defaults, which is the
    // honest answer and not a gap: the two states are indistinguishable to a
    // reader by design. What differs is that there is no row until a PUT.
    fixtureRegistry.resetAll('empty');
    try {
      expect(judgeConfigParam.rows()).toEqual([]);
      expect(await getJudgeConfig()).toEqual(DEFAULT_JUDGE_CONFIG);

      await setJudgeConfig({ ...DEFAULT_JUDGE_CONFIG, enabled: false });
      expect(judgeConfigParam.rows()).toHaveLength(1);
      expect((await getJudgeConfig()).enabled).toBe(false);
    } finally {
      fixtureRegistry.resetAll('default');
    }
  });

  it('handing back a copy, so a caller cannot edit the store by mutating a read', async () => {
    const cfg = await getJudgeConfig();
    cfg.dimensions[0]!.weight = 99;
    expect((await getJudgeConfig()).dimensions[0]!.weight)
      .toBe(DEFAULT_JUDGE_CONFIG.dimensions[0]!.weight);
  });
});

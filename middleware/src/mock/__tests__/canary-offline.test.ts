// The canary offline — the SSM parameters, the judged score, the EMF record.
//
// Seven pairs on `scripts/mock-write-route-budget.txt` lived on this chain.
// `getWeightB` and `getControl` already had mock branches, so the surface READ
// as if it worked; `getSubjectAArn`, `getSubjectBArn` and `setSubjectArns` did
// not, so `POST /canary/start` PutParameter'd against the real
// `/orgiq/canary/subject_{a,b}_arn` from a laptop with `MOCK_AGENTCORE=true`.
// The judge and the EMF emitter behind `/canary/ask` were the same story one
// layer down.
//
// What these tests are really about is the two rules that make an offline
// write honest:
//
//   THE WRITE HAPPENS. `setSubjectArns` moves the same row the getters read,
//   so `start` then `prompts` shows the experiment that was started. A mock
//   that returned `{ok:true}` and stored nothing would be worse than the 503
//   it replaces.
//
//   THE JUDGE ABSTAINS RATHER THAN FLATTERS. `mock/answer-check.ts` cannot
//   hear register, so `tone` is ABSENT from the score, not zero and not ten.
//   `weightedComposite` renormalises over the keys it was given, so the
//   abstention costs the composite nothing and buys the answer nothing.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    canary: { name: 'orgiq-prompt-canary', judgeArn: '', subjectAArn: '', subjectBArn: '' },
  },
}));

import { freezeClock } from '../core/clock.js';
import { fixtureRegistry } from '../core/fixture.js';
import { canaryWeight } from '../canary-weight.js';
import { canaryScores } from '../canary-scores.js';
import { canarySubjectAnswers, offlineSubjectAnswer } from '../canary-ask.js';
import { MOCK_PROMPT_LIBRARY } from '../canary-library.js';
import { measureAnswer, offlineRubricScores, OFFLINE_JUDGE_MODEL } from '../answer-check.js';
import { DEFAULT_JUDGE_CONFIG, weightedComposite } from '../../lib/judge-config.js';
import { emitCanaryScore } from '../../lib/emf-emitter.js';
import {
  getSubjectAArn,
  getSubjectBArn,
  setSubjectArns,
} from '../../lib/weight-cache.js';

const AT = '2026-09-06T09:15:00.000Z';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  canaryWeight.reset();
  canaryScores.reset();
  canarySubjectAnswers.reset();
});

describe('the canary subject parameters offline', () => {
  it('seeds subjects that exist in the offline prompt library', async () => {
    const a = await getSubjectAArn();
    const b = await getSubjectBArn();
    const arns = MOCK_PROMPT_LIBRARY.flatMap((p) => p.versions.map((v) => v.arn));
    // Rule 2: not a string typed from memory. A subject the library cannot
    // resolve gives `GET /prompts` an ARN with no template behind it.
    expect(arns).toContain(a);
    expect(arns).toContain(b);
    expect(a).not.toBe(b);
  });

  it('start writes both parameters, and the getters read what was written', async () => {
    const a = 'arn:aws:bedrock:us-east-1:000000000000:prompt/mock-advisor-system-prompt:DRAFT';
    const b = 'arn:aws:bedrock:us-east-1:000000000000:prompt/mock-scoring-system-prompt:DRAFT';

    await setSubjectArns(a, b);

    expect(await getSubjectAArn()).toBe(a);
    expect(await getSubjectBArn()).toBe(b);
    // ...and it is in the fixture, which is what makes /api/__mock/reset an undo.
    expect(canaryWeight.rows()[0]).toMatchObject({ subjectAArn: a, subjectBArn: b });
  });

  it('reset takes the experiment back', async () => {
    const seeded = await getSubjectAArn();
    await setSubjectArns('arn:aws:bedrock:us-east-1:000000000000:prompt/x:DRAFT', 'arn:…:y');
    expect(await getSubjectAArn()).not.toBe(seeded);
    canaryWeight.reset();
    expect(await getSubjectAArn()).toBe(seeded);
  });

  it('the empty world is a canary that was never started, not a fabricated one', async () => {
    // A world switch is the registry's call — `fixture.reset('empty')` rebuilds
    // that world's rows but leaves the ACTIVE world alone, which is exactly the
    // distinction the control plane's global-vs-pin note is about.
    fixtureRegistry.resetAll('empty');
    try {
      expect(await getSubjectAArn()).toBe('');
      expect(await getSubjectBArn()).toBe('');
    } finally {
      fixtureRegistry.resetAll('default');
    }
  });
});

describe('the declared subject answers', () => {
  it('are about the question asked, so the judge measures the answer', () => {
    const text = offlineSubjectAnswer('A', { personName: 'Priya Raman', topic: 'reranking' });
    expect(text).toContain('Priya Raman');
    expect(text).toContain('reranking');
    expect(text).not.toContain('{{');
  });

  it('differ in the way the canary exists to detect', () => {
    const a = offlineSubjectAnswer('A', { personName: 'Priya Raman', topic: 'reranking' })!;
    const b = offlineSubjectAnswer('B', { personName: 'Priya Raman', topic: 'reranking' })!;
    expect(a).not.toBe(b);
    // B is the verbose challenger; if they ever converge the A/B page is
    // comparing one text with itself.
    expect(b.length).toBeGreaterThan(a.length * 2);
  });

  it('the empty world has no declared answer, so /ask reports the failure', () => {
    fixtureRegistry.resetAll('empty');
    try {
      expect(offlineSubjectAnswer('A', { personName: 'X', topic: 'y' })).toBeNull();
    } finally {
      fixtureRegistry.resetAll('default');
    }
  });
});

describe('the offline judge', () => {
  const dims = DEFAULT_JUDGE_CONFIG.dimensions;
  const question = 'reranking — Priya Raman';

  it('abstains on tone rather than awarding it marks', () => {
    const answer = offlineSubjectAnswer('A', { personName: 'Priya Raman', topic: 'reranking' })!;
    const scores = offlineRubricScores(measureAnswer(question, answer), dims);
    expect(Object.keys(scores).sort()).toEqual(['conciseness', 'factuality', 'helpfulness']);
    expect(scores).not.toHaveProperty('tone');
  });

  it('scores tone only when there is a tone failure it can actually hear', () => {
    const refusal = "I don't have access to that information.";
    const scores = offlineRubricScores(measureAnswer(question, refusal), dims);
    expect(scores).toHaveProperty('tone');
    expect(scores['tone']).toBeLessThanOrEqual(2);
  });

  it('an abstained dimension costs the composite nothing and buys nothing', () => {
    const answer = offlineSubjectAnswer('A', { personName: 'Priya Raman', topic: 'reranking' })!;
    const unit: Record<string, number> = {};
    for (const [k, v] of Object.entries(offlineRubricScores(measureAnswer(question, answer), dims))) {
      unit[k] = v / 10;
    }
    const composite = weightedComposite(unit, dims);
    // Renormalised over helpfulness+factuality+conciseness (30+30+20 = 80),
    // NOT divided by the full 100 as if tone had scored zero.
    const expected =
      (unit['helpfulness']! * 30 + unit['factuality']! * 30 + unit['conciseness']! * 20) / 80;
    expect(composite).toBeCloseTo(expected, 10);
  });

  it('scores a refusal below a real answer, however well formatted', () => {
    const answer = offlineSubjectAnswer('A', { personName: 'Priya Raman', topic: 'reranking' })!;
    const good = weightedComposite(
      Object.fromEntries(Object.entries(offlineRubricScores(measureAnswer(question, answer), dims))
        .map(([k, v]) => [k, v / 10])), dims);
    const bad = weightedComposite(
      Object.fromEntries(Object.entries(offlineRubricScores(
        measureAnswer(question, 'I am sorry, I cannot help with reranking for Priya Raman.'), dims))
        .map(([k, v]) => [k, v / 10])), dims);
    expect(bad).toBeLessThan(good);
  });

  it('names itself, and never a Bedrock model id', () => {
    expect(OFFLINE_JUDGE_MODEL).toBe('offline/lexical-answer-check');
    expect(OFFLINE_JUDGE_MODEL).not.toMatch(/nova|anthropic|amazon\./);
  });
});

describe('the EMF record offline', () => {
  it('lands in the fixture standing in for /orgiq/canary/scores, stamped from the clock', async () => {
    restore = freezeClock(AT);
    expect(canaryScores.rows()).toHaveLength(0);

    await emitCanaryScore({
      canary_name: 'orgiq-prompt-canary',
      version_label: 'B',
      prompt_arn: 'arn:aws:bedrock:us-east-1:000000000000:prompt/mock-search-system-prompt:DRAFT',
      request_id: 'req-1',
      composite_score: 0.75625,
      latency_ms: 12,
      error: 0,
      helpfulness: 0.9,
      factuality: 0.5,
      conciseness: 0.925,
      judged_by: OFFLINE_JUDGE_MODEL,
    });

    expect(canaryScores.rows()).toEqual([
      {
        canary_name: 'orgiq-prompt-canary',
        version_label: 'B',
        prompt_arn: 'arn:aws:bedrock:us-east-1:000000000000:prompt/mock-search-system-prompt:DRAFT',
        request_id: 'req-1',
        composite_score: 0.75625,
        latency_ms: 12,
        error: 0,
        helpfulness: 0.9,
        factuality: 0.5,
        conciseness: 0.925,
        judged_by: OFFLINE_JUDGE_MODEL,
        emittedAt: AT,
      },
    ]);
    // tone is ABSENT, not zero — "not measured" is a different claim.
    expect(canaryScores.rows()[0]).not.toHaveProperty('tone');
  });

  it('is a sink: the seed is empty in every world, and reset empties it', async () => {
    expect(canaryScores.rows('default')).toEqual([]);
    expect(canaryScores.rows('empty')).toEqual([]);
    await emitCanaryScore({
      canary_name: 'c', version_label: 'A', prompt_arn: 'arn', request_id: 'r',
      composite_score: 0, latency_ms: 0, error: 1,
    });
    expect(canaryScores.rows()).toHaveLength(1);
    canaryScores.reset();
    expect(canaryScores.rows()).toHaveLength(0);
  });
});

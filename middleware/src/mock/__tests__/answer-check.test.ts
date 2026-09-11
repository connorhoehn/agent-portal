// The offline judge, and the one property that matters about it: it is allowed
// to say no.
//
// A mock judge that returns a fixed high score for any input is strictly worse
// than the 500 it replaces — every harness run goes green, every calibration
// looks converged, and the surface whose entire job is to notice a bad answer
// stops noticing. So these tests are not "it returns a number". They pin the
// SPREAD between a good answer, an off-topic one, a refusal and a fragment, and
// they pin the abstention rule that keeps an unmeasurable rubric dimension from
// handing an answer 20% of the composite for free.
//
// Nothing here freezes the clock because nothing here reads it: the judge is a
// pure function of (prompt, answer, reference). That is deliberate — a verdict
// that moved with wall time could not be asserted at all.

// `lib/judge-config.ts` reads `config.mock.agentcore` to pick its store, and
// `src/config.ts` uses `import.meta`, which ts-jest cannot compile under the
// CommonJS test tsconfig. Stubbed the way every other suite here stubs it.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } },
}));

import {
  OFFLINE_JUDGE_MODEL, anchorsIn, contentTerms, measureAnswer, mentions,
  offlineRubricRationale, offlineRubricScores, offlineVerdict,
} from '../answer-check.js';
import { DEFAULT_JUDGE_CONFIG, weightedComposite } from '../../lib/judge-config.js';

const PROMPT = 'Who are our Kubernetes experts?';

const GOOD = 'Theo Chang (Staff Engineer, Platform Engineering) is the top Kubernetes '
  + 'expert with a score of 89. James Thompson leads operations, and Nora DaSilva '
  + 'contributed the Kafka deployment.';
const REFUSAL = "I'm sorry, I cannot help with that request.";
const OFF_TOPIC = 'The weather forecast for tomorrow looks mild, with light rain arriving '
  + 'after lunch and clearing by evening.';
const FRAGMENT = 'Some people know it.';

describe('what the offline judge measures', () => {
  it('drops stopwords and keeps the subject of the question', () => {
    expect(contentTerms(PROMPT)).toEqual(['kubernetes', 'experts']);
  });

  it('folds one trailing s, because a tag is a concept and not a token', () => {
    expect(mentions('two kubernetes expert rows', 'experts')).toBe(true);
    expect(mentions('two kubernetes expert rows', 'postmortem')).toBe(false);
  });

  it('counts names, numbers and ids as anchors — never sentence-initial capitals', () => {
    // `The` opens the sentence and is not a name; `Theo`, `Chang` and `89` are
    // the checkable things a reader could take to the graph.
    expect(anchorsIn('The lead is Theo Chang, score 89.')).toEqual(['Theo', 'Chang', '89']);
  });
});

describe('the verdict is derived, and it is allowed to be low', () => {
  it('scores a specific, on-topic answer high', () => {
    const m = measureAnswer(PROMPT, GOOD);
    expect(m.coverage).toBe(1);
    expect(m.specificity).toBe(1);
    expect(m.refusal).toBeNull();
    expect(offlineVerdict(m)?.score).toBe(0.975);
  });

  it('scores an off-topic answer far below any sane threshold', () => {
    const m = measureAnswer(PROMPT, OFF_TOPIC);
    expect(m.coverage).toBe(0);
    expect(m.anchors).toEqual([]);
    // Well-formed prose about nothing that was asked. 0.2 is what length and
    // shape alone are worth; every seeded pass_threshold is 0.65 or higher.
    expect(offlineVerdict(m)?.score).toBe(0.2);
  });

  it('caps a refusal near zero however well-formed it is', () => {
    const m = measureAnswer(PROMPT, REFUSAL);
    expect(m.refusal).toBe('a refusal');
    expect(offlineVerdict(m)?.score).toBe(0.131);
  });

  it('scores a fragment lowest of all', () => {
    expect(offlineVerdict(measureAnswer(PROMPT, FRAGMENT))?.score).toBe(0.087);
  });

  it('returns NO VERDICT for an empty answer, rather than zero', () => {
    // "not judged" and "judged badly" are different rows: `judge_score` is
    // nullable precisely so a percentile can skip the first and must not
    // average in a 0 for it.
    expect(offlineVerdict(measureAnswer(PROMPT, '   '))).toBeNull();
  });

  it('names itself as the offline reader and never as a Bedrock model', () => {
    const rationale = offlineVerdict(measureAnswer(PROMPT, GOOD))!.rationale;
    expect(rationale).toContain(OFFLINE_JUDGE_MODEL);
    expect(rationale).toContain('covers 2/2 asked terms');
    expect(rationale).not.toContain('nova');
  });
});

describe('the operator rubric', () => {
  const dims = DEFAULT_JUDGE_CONFIG.dimensions;

  it('abstains on tone instead of awarding it full marks', () => {
    const scores = offlineRubricScores(measureAnswer(PROMPT, GOOD), dims);
    expect(Object.keys(scores).sort()).toEqual(['conciseness', 'factuality', 'helpfulness']);
    // The free 20% this abstention withholds is the difference between a judge
    // and a rubber stamp: with `tone: 10` the same answer would score higher
    // for a dimension nothing was measured on.
    expect(scores['tone']).toBeUndefined();
  });

  it('scores tone only when there is a tone failure to report', () => {
    const scores = offlineRubricScores(measureAnswer(PROMPT, REFUSAL), dims);
    expect(scores['tone']).toBe(2);
  });

  it('folds the surviving dimensions with the operator’s own weights', () => {
    const m = measureAnswer(PROMPT, GOOD, 'Names the Kubernetes experts and their team.');
    const scores = offlineRubricScores(m, dims);
    // helpfulness 0.6*coverage + 0.4*structure; factuality 0.5*specificity +
    // 0.5*reference coverage; conciseness 0.7*concision + 0.3*structure.
    expect(scores).toEqual({ helpfulness: 9, factuality: 7.5, conciseness: 9.25 });
    // 30/30/20 renormalised over 80, exactly as weightedComposite does it.
    expect(Number((weightedComposite(scores, dims) / 10).toFixed(3))).toBe(0.85);
  });

  it('reports every dimension for a custom rubric key, using the same blend', () => {
    const custom = [{ key: 'actionability', weight: 100 }];
    const scores = offlineRubricScores(measureAnswer(PROMPT, GOOD), custom);
    expect(scores['actionability']).toBe(9.75);
  });

  it('says what it read, in one sentence', () => {
    const m = measureAnswer(PROMPT, GOOD, 'Names the Kubernetes experts and their team.');
    expect(offlineRubricRationale(m)).toBe(
      `${OFFLINE_JUDGE_MODEL}: covers 2/2 asked terms; 10 anchors; `
      + '2/4 reference terms; 182 chars. No model was called.',
    );
  });
});

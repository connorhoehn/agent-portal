// Harness engine tests.
//
// The scoring logic is what decides whether a prompt change shipped or got
// rolled back, so the parts that run in code — not in a model — are pinned
// here: tag checking, reference overlap, answer extraction, and the rule that
// a deterministic failure outranks a happy judge.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../../routes/invocations.js', () => ({ getRuntimeArn: jest.fn() }));
jest.mock('../judge-config.js', () => ({
  getJudgeConfig: jest.fn(async () => ({ dimensions: [] })),
  weightedComposite: jest.fn(() => 0),
}));

import { checkTags, referenceSimilarity, extractAnswer, runCase, type TestCase } from '../harness-runner.js';
import { getRuntimeArn } from '../../routes/invocations.js';

const arnMock = getRuntimeArn as unknown as jest.Mock;

function testCase(over: Partial<TestCase> = {}): TestCase {
  return {
    testId: 't-1', agentId: 'orgiq-search', prompt: 'Who knows Kubernetes?',
    referenceOutput: null, expectedTags: [], rubricOverride: null, passThreshold: 0.7,
    ...over,
  };
}

describe('checkTags', () => {
  it('matches a required concept regardless of casing', () => {
    // A tag is a concept, not a token — failing on capitalisation would teach
    // a reader nothing about the agent.
    expect(checkTags('We chose Aurora PostgreSQL', ['aurora'])).toEqual({ aurora: true });
    expect(checkTags('we chose aurora', ['Aurora'])).toEqual({ Aurora: true });
  });

  it('reports each expected tag separately so the miss is nameable', () => {
    expect(checkTags('Aurora only', ['Aurora', 'pgvector'])).toEqual({ Aurora: true, pgvector: false });
  });

  it('is empty, not failing, when a case expects nothing', () => {
    expect(checkTags('anything', [])).toEqual({});
  });
});

describe('referenceSimilarity', () => {
  it('is null when there is no reference to compare against', () => {
    expect(referenceSimilarity('some answer', null)).toBeNull();
  });

  it('is 1 for the same content and 0 for disjoint content', () => {
    expect(referenceSimilarity('alpha beta gamma', 'gamma beta alpha')).toBe(1);
    expect(referenceSimilarity('alpha beta', 'kappa lambda')).toBe(0);
  });

  it('sits in between for partial overlap', () => {
    const v = referenceSimilarity('alpha beta gamma', 'alpha beta delta') ?? 0;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it('does not divide by zero on an empty answer', () => {
    expect(referenceSimilarity('', 'something')).toBe(0);
  });
});

describe('extractAnswer', () => {
  it('passes plain text through untouched', () => {
    expect(extractAnswer('Sarah Thompson knows Kubernetes.')).toBe('Sarah Thompson knows Kubernetes.');
  });

  it.each([
    ['{"result":"from result"}', 'from result'],
    ['{"output":"from output"}', 'from output'],
    ['{"response":"from response"}', 'from response'],
  ])('unwraps %s', (raw, expected) => expect(extractAnswer(raw)).toBe(expected));

  it('keeps the raw envelope when no known key carries text', () => {
    expect(extractAnswer('{"unexpected":{"a":1}}')).toBe('{"unexpected":{"a":1}}');
  });

  it('survives malformed JSON rather than throwing mid-run', () => {
    expect(extractAnswer('{not json')).toBe('{not json');
  });
});

describe('runCase', () => {
  beforeEach(() => arnMock.mockReset());

  it('records an unreachable agent as a failed case, not an exception', async () => {
    // The single most useful thing an evaluation can report is that the agent
    // fell over. Throwing here would lose it.
    arnMock.mockResolvedValue(null);
    const out = await runCase(testCase(), 'amazon.nova-pro-v1:0');
    expect(out.passed).toBe(false);
    expect(out.failReasons[0]).toMatch(/invocation failed.*no deployed runtime/);
    expect(out.judgeScore).toBeNull();
  });

  it('names the agent that could not be reached', async () => {
    arnMock.mockResolvedValue(null);
    const out = await runCase(testCase({ agentId: 'orgiq-scoring' }), 'amazon.nova-pro-v1:0');
    expect(out.failReasons[0]).toContain('orgiq-scoring');
  });
});

// These tests are mostly about one property: knowledge learned on a DIFFERENT
// project must be findable. Everything today's `lab recall` gets wrong is a
// repo filter, so the cross-project cases are the ones that matter.

import {
  problemShape, shapeScore, applicability, rankMatches, avoidedEstimate,
  daysBetween, SCORE_FLOOR, STRONG_SCORE, STALE_DAYS,
  type Experience,
} from '../rediscovery.js';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function exp(over: Partial<Experience> & Pick<Experience, 'id' | 'title'>): Experience {
  return {
    kind: 'gotcha', body: '', repo: 'orgiq-observability',
    sessionId: 'sess-1', createdAt: daysAgo(10), ...over,
  };
}

describe('problemShape', () => {
  it('weights identifying tokens far above prose', () => {
    const shape = problemShape('The deploy failed with HttpEndpointNotEnabledException');
    expect(shape.get('httpendpointnotenabledexception')).toBeGreaterThan(shape.get('deploy')!);
  });

  it('drops stopwords and short noise', () => {
    const shape = problemShape('the it is a of to on');
    expect(shape.size).toBe(0);
  });

  it('does not let a repeated word inflate the signature', () => {
    const once = problemShape('rollout stuck');
    const many = problemShape('rollout rollout rollout stuck');
    expect(many.get('rollout')).toBe(once.get('rollout'));
  });

  it('recognises snake_case, SCREAMING_CASE and status codes as identifying', () => {
    const shape = problemShape('task_definition returned 503 with EXEC_FORMAT_ERROR');
    expect(shape.get('task_definition')).toBe(4);
    expect(shape.get('exec_format_error')).toBe(4);
    expect(shape.get('503')).toBe(4);
  });
});

describe('shapeScore', () => {
  it('scores a short problem fully contained in a long experience highly', () => {
    // Rewarding thoroughness: the experience being detailed must not dilute it.
    const problem = problemShape('HttpEndpointNotEnabledException on first call');
    const experience = problemShape(
      'Aurora Data API call failed with HttpEndpointNotEnabledException on the very first ' +
      'call after a scale-to-zero cluster wakes. Warm up with SELECT 1 then retry with backoff.',
    );
    expect(shapeScore(problem, experience)).toBeGreaterThan(STRONG_SCORE);
  });

  it('does not match two unrelated problems that share only prose', () => {
    const a = problemShape('the deploy is stuck');
    const b = problemShape('the test is stuck');
    expect(shapeScore(a, b)).toBeLessThan(STRONG_SCORE);
  });

  it('is 0 against an empty shape', () => {
    expect(shapeScore(problemShape(''), problemShape('anything'))).toBe(0);
  });
});

describe('applicability', () => {
  const base = { score: 0.8, ageDays: 5, kind: 'worked' as const, sameRepo: true };

  it('a strong recent match applies', () => {
    expect(applicability(base).verdict).toBe('applies');
  });

  it('age degrades a verdict but never promotes one', () => {
    const old = applicability({ ...base, ageDays: STALE_DAYS + 1 });
    expect(old.verdict).toBe('partial');
    expect(old.why).toMatch(/months old — verify against the current environment/);
  });

  it('a dead end is never a procedure', () => {
    // Knowing a thing did not work is context, not something to replay.
    expect(applicability({ ...base, kind: 'failed' }).verdict).toBe('partial');
    expect(applicability({ ...base, kind: 'failed' }).why).toMatch(/what not to try/);
  });

  it('a weak overlap is stale regardless of recency', () => {
    expect(applicability({ ...base, score: SCORE_FLOOR - 0.01, ageDays: 0 }).verdict).toBe('stale');
  });

  it('always says where it came from, so the verdict can be audited', () => {
    expect(applicability({ ...base, sameRepo: false }).why).toMatch(/different project/);
    expect(applicability(base).why).toMatch(/same repo/);
  });
});

describe('rankMatches — the cross-project payoff', () => {
  const ecsAugust = exp({
    id: 'exp-aug', kind: 'worked',
    title: 'ECS rollout stuck: task_definition pinned to a stale image digest',
    body: 'The ECS service rollout hung in IN_PROGRESS because the task_definition digest '
        + 'never changed. Forcing a new deployment with the updated digest cleared it.',
    repo: 'some-other-project', sessionId: 'sess-aug', createdAt: daysAgo(120),
  });
  const unrelated = exp({
    id: 'exp-other', title: 'Design system tokens renamed', body: 'Renamed spacing tokens.',
    repo: 'orgiq-design-system',
  });

  it('finds knowledge learned on a DIFFERENT project — the whole point', () => {
    // This is the case a repo-scoped recall can never reach.
    const matches = rankMatches(
      'Why is our ECS rollout stuck? task_definition seems fine.',
      [ecsAugust, unrelated],
      { repo: 'orgiq-auth-service', now: NOW },
    );
    expect(matches[0]!.experienceId).toBe('exp-aug');
    expect(matches[0]!.crossProject).toBe(true);
  });

  it('never filters by repo — only nudges ranking', () => {
    const withRepo = rankMatches('ECS rollout stuck task_definition', [ecsAugust],
      { repo: 'orgiq-auth-service', now: NOW });
    const noRepo = rankMatches('ECS rollout stuck task_definition', [ecsAugust], { now: NOW });
    expect(withRepo).toHaveLength(1);
    expect(noRepo).toHaveLength(1);
  });

  it('a strong cross-project match outranks a weak local one', () => {
    const weakLocal = exp({
      id: 'exp-local', title: 'Rollout notes', body: 'Some rollout happened.',
      repo: 'orgiq-auth-service',
    });
    const matches = rankMatches(
      'ECS rollout stuck: task_definition pinned to a stale image digest',
      [weakLocal, ecsAugust], { repo: 'orgiq-auth-service', now: NOW },
    );
    expect(matches[0]!.experienceId).toBe('exp-aug');
  });

  it('drops everything below the floor rather than padding the list', () => {
    // A weak match shown at a spend moment trains people to ignore the panel.
    expect(rankMatches('completely unrelated subject matter', [unrelated], { now: NOW })).toEqual([]);
  });

  it('reports age in whole days', () => {
    expect(daysBetween(daysAgo(120), NOW)).toBe(120);
  });
});

describe('avoidedEstimate — the counterfactual', () => {
  const applies = { verdict: 'applies' as const };
  const partial = { verdict: 'partial' as const };

  it('claims nothing when no match was strong enough to stop the work', () => {
    expect(avoidedEstimate([partial] as never, { usd: 5, minutes: 40 }))
      .toEqual({ usd: null, minutes: null });
  });

  it('reports the estimate the spend was about to be authorised against', () => {
    expect(avoidedEstimate([applies] as never, { usd: 4.8, minutes: 35 }))
      .toEqual({ usd: 4.8, minutes: 35 });
  });

  it('returns null rather than inventing a number when there is no estimate', () => {
    expect(avoidedEstimate([applies] as never, {})).toEqual({ usd: null, minutes: null });
  });
});

describe('shapeScore — prose-only overlap cannot claim identity', () => {
  it('caps a match built entirely on prose below the strong band', () => {
    const a = problemShape('rollout appears blocked somehow');
    const b = problemShape('rollout appears fine actually');
    expect(shapeScore(a, b)).toBeLessThan(STRONG_SCORE);
  });

  it('but a single shared identifying token still carries the match', () => {
    const a = problemShape('failing with HttpEndpointNotEnabledException');
    const b = problemShape('HttpEndpointNotEnabledException on a cold cluster');
    expect(shapeScore(a, b)).toBeGreaterThanOrEqual(STRONG_SCORE);
  });
});

describe('prose can suggest, only identifiers assert', () => {
  it('a substantial prose overlap survives but is held under the strong band', () => {
    // Two accounts of the same session-rotation bug, both in plain English.
    // They are genuinely the same problem and must be reachable — as `partial`.
    const a = problemShape('rotation on switch re-mint session cookie refresh window tenant role');
    const b = problemShape('rotating session cookie switch tenant role refresh window re-mint');
    const score = shapeScore(a, b);
    expect(score).toBeGreaterThan(SCORE_FLOOR);
    expect(score).toBeLessThan(STRONG_SCORE);
  });

  it('a thin prose overlap is still coincidence and stays out', () => {
    const a = problemShape('the deploy is stuck');
    const b = problemShape('the test is stuck');
    expect(shapeScore(a, b)).toBeLessThan(SCORE_FLOOR);
  });

  it('trailing sentence punctuation does not split a token from itself', () => {
    // `window.` and `window` are the same word; treating them as different
    // keys silently drops overlap at the end of every sentence.
    expect(shapeScore(problemShape('the refresh window.'), problemShape('the refresh window')))
      .toBeGreaterThan(0);
    expect(problemShape('refresh window.').has('window')).toBe(true);
  });
});

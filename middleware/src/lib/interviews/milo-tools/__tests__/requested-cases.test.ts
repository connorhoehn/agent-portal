// Film 5: the test cases Milo writes cover every kind the candidate named. Take 4 asked for "an empty array and duplicates" and
// got duplicates only: two_sum's reference has no answer for an empty array, so the case was dropped.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { testCasesFor, requestedOf } from '../tests.js';
import { testsAddedLine } from '../deps.js';
import { spawnSync } from 'node:child_process';
import type { KitQuestion } from '../../types.js';

const PAD = 'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n';
const Q = { id: 'q-be-twosum' } as unknown as KitQuestion;
const at = (requested: unknown, count = 4) => ({ pad: PAD, language: 'python' as const, question: Q, fn: 'two_sum', count, requested });
const CASES = [
  { args: '[[2, 7, 11, 15], 9]', expected: '[0, 1]', covers: '' },
  { args: '[[3, 3], 6]', expected: '[0, 1]', covers: 'duplicates' },
  { args: '[[], 0]', expected: '[]', covers: 'an empty array' },
  { args: '[[3, 2, 4], 6]', expected: '[1, 2]', covers: '' },
  { args: '[[1, 5, 9], 14]', expected: '[1, 2]', covers: '' },
];

describe('test cases the asker named', () => {
  it('makes a requested no-pair case executable with a disclosed assumption, alongside reference-checked duplicates', () => {
    const made = testCasesFor(CASES, at(['an empty array', 'duplicates']));
    if (!made.ok) throw new Error('not made');
    expect(made.missing).toEqual([]);
    expect(made.count).toBe(4);
    expect(made.checked).toBe(true);
    expect(made.block).toContain('(([3, 3], 6), [0, 1])');
    expect(made.block).not.toContain('milo_edge_inputs = [');
    expect(made.block).toContain('Assumes [] when there is no pair');
    expect(made.assumed).toBe(true);
    expect(made.block).toContain('    (([], 0), []),');
    expect(made.block).toContain('assert milo_failures == 0');
  });

  it('the asked-for cases stay even when the count is smaller than the spares before them', () => {
    const made = testCasesFor(CASES, at(['an empty array', 'duplicates'], 2));
    if (!made.ok) throw new Error('not made');
    expect(made.count).toBe(2);
    expect(made.block).toContain('([], 0)');
    expect(made.block).toContain('(([3, 3], 6)');
    expect(made.block).not.toContain('(([2, 7, 11, 15], 9)');
  });

  it('with nothing named, an input with no answer is still dropped (as before)', () => {
    const made = testCasesFor(CASES.map((c) => ({ ...c, covers: '' })), at([]));
    if (!made.ok) throw new Error('not made');
    expect(made.block).not.toContain('([], 0)');
    expect(made.block).not.toContain('milo_edge_inputs');
  });

  it('a named kind with no case is said, not hidden', () => {
    const made = testCasesFor(CASES.filter((c) => c.covers !== 'an empty array'), at(['an empty array', 'duplicates']));
    if (!made.ok) throw new Error('not made');
    expect(made.missing).toEqual(['an empty array']);
    expect(testsAddedLine(made.count, made.checked, made.missing)).toBe("Added four test cases at the bottom of the pad. I couldn't write one for an empty array.");
  });

  it('requested is bounded and deduplicated', () => {
    expect(requestedOf(['Duplicates', 'duplicates', ' ', 3, 'an empty array'])).toEqual(['Duplicates', 'an empty array']);
    expect(requestedOf('x')).toEqual([]);
  });
});

describe("the kinds the request's own words name (film 5, take 1: no labels from the writer, no empty case)", () => {
  const T1 = [
    { args: '[[3, 2, 4], 6]', expected: '[1, 2]' },
    { args: '[[1, 5, 9, 13], 22]', expected: '[2, 3]' },
    { args: '[[0, 4, 3, 0], 0]', expected: '[0, 3]' },
    { args: '[[1, 2], 3]', expected: '[0, 1]' },
  ];
  const REQ = 'a few test cases for an empty array and duplicates';
  it('builds the empty input from the first case when the writer wrote none, and keeps the duplicates case first', () => {
    const made = testCasesFor(T1, { ...at([], 3), request: REQ });
    if (!made.ok) throw new Error('not made');
    expect(made.block).toContain('    (([], 6), []),');
    expect(made.block).toContain('(([0, 4, 3, 0], 0), [0, 3])');
    expect(made.count).toBe(3);
  });
  it('an empty case the writer wrote but the reference set aside is used as it is', () => {
    const made = testCasesFor([...T1, { args: '[[], 0]', expected: '[]' }], { ...at([], 4), request: REQ });
    if (!made.ok) throw new Error('not made');
    expect(made.block).toContain('    (([], 0), []),');
    expect(made.block).not.toContain('([], 6)');
  });
  it('builds duplicates by repeating an item when no case has them', () => {
    const made = testCasesFor(T1.filter((c) => !c.args.includes('0, 4, 3, 0')), { ...at([], 3), request: 'test cases with duplicates' });
    if (!made.ok) throw new Error('not made');
    expect(made.block).toContain('([3, 2, 4, 3], 6)');
  });
});


describe('executable requested cases', () => {
  for (const language of ['python', 'javascript'] as const) {
    it(`${language}: a wrong empty return fails the process even when duplicates pass`, () => {
      const made = testCasesFor(CASES, { ...at(['an empty array', 'duplicates'], 2), language });
      if (!made.ok) throw new Error('not made');
      const body = language === 'python'
        ? 'def two_sum(nums, target):\n    return [0, 1] if nums else None\n'
        : 'function two_sum(nums, target) { return nums.length ? [0, 1] : null; }\n';
      const run = spawnSync(language === 'python' ? 'python3' : process.execPath, [language === 'python' ? '-c' : '-e', body + made.block], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain('ok');
      expect(run.stdout).toContain('DIFF');
      const fixed = body.replace('None', '[]').replace('null', '[]');
      expect(spawnSync(language === 'python' ? 'python3' : process.execPath, [language === 'python' ? '-c' : '-e', fixed + made.block]).status).toBe(0);
    });
  }
  it('does not silently override an explicitly conflicting no-pair contract', () => {
    const made = testCasesFor(CASES, { ...at(['an empty array', 'duplicates']), request: 'For empty input return null.' });
    if (!made.ok) throw new Error('not made');
    expect(made.assumed).toBe(false);
    expect(made.block).toContain('milo_edge_inputs');
    expect(made.checked).toBe(false);
    expect(made.unchecked).toBe(1);
    expect(testsAddedLine(made.count, made.checked, made.missing, made.assumed, made.unchecked))
      .toBe('Added three test cases at the bottom of the pad, plus one input with no expected result yet.');
  });
});

// Film 5: the test cases Milo writes cover every kind the candidate named. Take 4 asked for "an empty array and duplicates" and
// got duplicates only: two_sum's reference has no answer for an empty array, so the case was dropped.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { testCasesFor, requestedOf } from '../tests.js';
import { testsAddedLine } from '../deps.js';
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
  it('keeps an asked-for case the reference has no answer for, as an edge input, and the duplicates with its checked value', () => {
    const made = testCasesFor(CASES, at(['an empty array', 'duplicates']));
    if (!made.ok) throw new Error('not made');
    expect(made.missing).toEqual([]);
    expect(made.count).toBe(4);
    expect(made.checked).toBe(true);
    expect(made.block).toContain('(([3, 3], 6), [0, 1])');
    expect(made.block).toContain('milo_edge_inputs = [');
    expect(made.block).toContain('    ([], 0),');
    expect(made.block).toContain('print("edge", args, "->", two_sum(*args))');
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

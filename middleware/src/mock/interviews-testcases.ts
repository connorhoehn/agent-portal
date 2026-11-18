// The mock world's prepared test cases, which the scripted stand-in for Milo's test cases answers with
// (lib/interviews/testcases/model.ts ScriptedTestCaseModel). Keyed by kit question id; a question with none here gets no cases
// from the stand-in. Every expected value below was checked by brute force (each input has exactly one answer, as the question
// says). The first is the starter's own example, which the parse drops while the pad still calls it, so a request for twelve
// reads as "another dozen".
import type { TestCase } from '../lib/interviews/testcases/render.js';

const TWO_SUM: readonly TestCase[] = [
  { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
  { args: [[3, 2, 4], 6], expected: [1, 2] },
  { args: [[3, 3], 6], expected: [0, 1] },
  { args: [[1, 5, 9, 13], 22], expected: [2, 3] },
  { args: [[-3, 4, 3, 90], 0], expected: [0, 2] },
  { args: [[0, 4, 3, 0], 0], expected: [0, 3] },
  { args: [[1, 2], 3], expected: [0, 1] },
  { args: [[5, 75, 25], 100], expected: [1, 2] },
  { args: [[-1, -2, -3, -4, -5], -8], expected: [2, 4] },
  { args: [[10, 20, 30, 40, 50], 90], expected: [3, 4] },
  { args: [[1, 3, 4, 2], 6], expected: [2, 3] },
  { args: [[2, 5, 5, 11], 10], expected: [1, 2] },
  { args: [[100, -100, 7], 0], expected: [0, 1] },
  { args: [[8, 1, 6, 4], 14], expected: [0, 2] },
  { args: [[4, 4, 1], 8], expected: [0, 1] },
  { args: [[7, 2, 13, 11], 24], expected: [2, 3] },
  { args: [[1, 6, 3, 9], 10], expected: [0, 3] },
  { args: [[0, 0], 0], expected: [0, 1] },
  { args: [[12, -4, 30, 7], 26], expected: [1, 2] },
  { args: [[3, 9, 14, 20, 1], 15], expected: [2, 4] },
  { args: [[6, 2, 8, 5, 3], 13], expected: [2, 3] },
];

const PREPARED: Readonly<Record<string, readonly TestCase[]>> = {
  'q-be-twosum': TWO_SUM,
};

/** The prepared cases for a kit question (a copy), or none. */
export function scriptedTestCases(questionId: string): TestCase[] {
  return (PREPARED[questionId] ?? []).map((c) => structuredClone(c));
}

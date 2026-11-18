// The mock world's stand-in for Milo's interview tools: what the scripted session's "background agent" passes as the arguments of
// its tool calls (docs/interviews-tenant-plan.md, "Milo's interview tools"), so walks, tests and the film drive the tools with no
// model and no spend. The interviews policy adds these rules to the scripted session (meeting-assistant/scripted-session.ts
// `addScriptRules`); a session follows one only when it was offered that tool (an interview's).
//
//   "...another dozen test cases"       pad_add_tests with that many prepared Two Sum cases (expected values checked by brute
//                                        force; the starter's own example is left out, as the pad already calls it)
//   "...LRU cache..."                    pad_add_helper "an LRU cache" with a small class in JavaScript: in Python the server
//                                        puts `from functools import lru_cache` in instead (the language has it)
//   "...trie..." / "...helper..."        pad_add_helper with a small Python trie
//   "...solve it..." / "...solution..."  pad_add_helper whose code defines the question's function: the server refuses it
import type { ScriptRule } from '../lib/meeting-assistant/scripted-session.js';
import type { TestCase } from '../lib/interviews/testcases/render.js';

export const DEFAULT_TEST_CASES = 12;
export const MAX_TEST_CASES = 20;
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};


/** Lower case, punctuation as spaces (apostrophes dropped), one space between words. */
const utterance = (text: string): string => text.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** How many test cases the words ask for, within 1 and MAX_TEST_CASES. */
export function amountOf(text: string): number {
  const t = utterance(text);
  const n = /\b(\d{1,3})\b/.exec(t)?.[1] ?? Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  const asked = n === undefined ? null
    : /^\d+$/.test(n) ? Number.parseInt(n, 10) : NUMBER_WORDS[n]!;
  const counted = asked !== null && !/\bdozen\b/.test(t) ? asked
    : /\bhalf\s+a\s+dozen\b/.test(t) ? 6
    : /\bdozen\b/.test(t) ? 12 * (asked ?? 1)
    : /\bcouple\b/.test(t) ? 2
    : /\bfew\b/.test(t) ? 5
    : DEFAULT_TEST_CASES;
  return Math.max(1, Math.min(MAX_TEST_CASES, counted));
}

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

const PREPARED: Readonly<Record<string, readonly TestCase[]>> = { 'q-be-twosum': TWO_SUM };

/** The prepared cases for a kit question (a copy), or none. */
export function scriptedTestCases(questionId: string): TestCase[] {
  return (PREPARED[questionId] ?? []).map((c) => structuredClone(c));
}

export const SCRIPTED_LRU_JS = [
  'class LRUCache {',
  '  constructor(capacity) {',
  '    this.capacity = capacity;',
  '    this.map = new Map();',
  '  }',
  '  get(key) {',
  '    if (!this.map.has(key)) return undefined;',
  '    const value = this.map.get(key);',
  '    this.map.delete(key);',
  '    this.map.set(key, value);',
  '    return value;',
  '  }',
  '  put(key, value) {',
  '    this.map.delete(key);',
  '    this.map.set(key, value);',
  '    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);',
  '  }',
  '}',
].join('\n');

export const SCRIPTED_TRIE_PY = [
  'class Trie:',
  '    def __init__(self):',
  '        self.children = {}',
  '        self.end = False',
  '',
  '    def insert(self, word):',
  '        node = self',
  '        for ch in word:',
  '            node = node.children.setdefault(ch, Trie())',
  '        node.end = True',
  '',
  '    def contains(self, word):',
  '        node = self',
  '        for ch in word:',
  '            node = node.children.get(ch)',
  '            if node is None:',
  '                return False',
  '        return node.end',
].join('\n');

/** A "helper" that is the question's answer: the server refuses it (it defines the question's function). */
export const SCRIPTED_SOLUTION_PY = 'def two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n';

const asToolCase = (c: TestCase) => ({ args: JSON.stringify(c.args), expected: JSON.stringify(c.expected) });

export const INTERVIEW_SCRIPT_RULES: readonly ScriptRule[] = [
  { id: 'iv-solution', match: /\b(?:solve (?:it|this|the (?:question|problem))|the solution|write (?:the|my) (?:code|function|answer))\b/i,
    run: () => ({ call: { name: 'pad_add_helper', args: { what: 'the solution', code: SCRIPTED_SOLUTION_PY } } }) },
  { id: 'iv-tests', match: /\btest\s*cases?\b/i,
    run: (m) => ({ call: { name: 'pad_add_tests', args: { cases: scriptedTestCases('q-be-twosum').slice(1, 1 + amountOf(m.input ?? '')).map(asToolCase) } } }) },
  { id: 'iv-lru', match: /\blru\b|least recently used/i,
    run: () => ({ call: { name: 'pad_add_helper', args: { what: 'an LRU cache', code: SCRIPTED_LRU_JS } } }) },
  { id: 'iv-trie', match: /\btrie\b|\bhelper\b/i,
    run: () => ({ call: { name: 'pad_add_helper', args: { what: 'a trie', code: SCRIPTED_TRIE_PY } } }) },
];

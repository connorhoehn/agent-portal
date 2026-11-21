jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { hearsQuestion, scriptedRecap } from '../model.js';
import type { RecapInput } from '../prompt.js';
import { courtesyOnly, parseRecapAnswer } from '../parse.js';

const input: RecapInput = {
  competencies: ['problem-solving', 'code-quality', 'communication'].map((id) => ({ id, name: id, lookFor: '', anchors: { 1: '', 2: '', 3: '', 4: '' } })),
  questions: [{ text: 'Given an array of integers and a target, return the indices of two numbers.', competencyId: 'problem-solving', how: 'chosen' }],
  lines: [
    { seq: 10, side: 'panel', text: 'At given in array of integers and a target, return the indices of the two numbers.' },
    { seq: 11, side: 'candidate', text: 'I would use a hash map to find the complement in one pass.' },
    { seq: 12, side: 'candidate', text: 'I check before storing the number so the duplicate test cannot reuse the same index.' },
    { seq: 13, side: 'candidate', text: 'Hey Milo, add test cases for an empty array and duplicates.' },
    { seq: 14, side: 'candidate', text: 'Thanks Hugo, have a great rest of your day.' },
  ],
};

test('ASR substitution still opens the question; only substantive answers become evidence', () => {
  const recap = scriptedRecap(input);
  expect(recap.notCovered).toEqual([]);
  expect(recap.competencies.find((c) => c.id === 'code-quality')!.evidence.map((e) => e.seq)).toEqual([12]);
  expect(recap.competencies.flatMap((c) => c.evidence.map((e) => e.seq))).not.toEqual(expect.arrayContaining([13]));
  expect(recap.competencies.flatMap((c) => c.evidence.map((e) => e.seq))).not.toEqual(expect.arrayContaining([14]));
});

test('topic overlap and short fuzzy titles do not manufacture a question', () => {
  expect(hearsQuestion('I like an array of integers for my examples.', 'given an array of integers and')).toBe(false);
  expect(hearsQuestion('Design a toaster', 'design twitter')).toBe(false);
  expect(scriptedRecap({ ...input, lines: input.lines.slice(1) }).competencies).toEqual([]);
});

test('missing code reasoning stays uncovered and a farewell alone supplies no evidence', () => {
  expect(scriptedRecap({ ...input, lines: input.lines.filter((l) => l.seq !== 12) }).notCovered).toContain('code-quality');
  expect(scriptedRecap({ ...input, lines: [input.lines[0]!, input.lines[4]!] }).competencies).toEqual([]);
});

test('the common parser rejects a farewell citation and does not append it to a real answer', () => {
  const lines = [
    { seq: 1, side: 'panel' as const, text: 'Explain your approach.' },
    { seq: 2, side: 'candidate' as const, text: 'I use a dictionary to find each complement.' },
    { seq: 3, side: 'candidate' as const, text: 'Thanks Hugo, have a great rest of your day.' },
  ];
  const raw = JSON.stringify({ competencies: [{ id: 'communication', evidence: lines.slice(1).map((line) => ({ text: 'The candidate said this.', seq: line.seq, quote: line.text })) }], notCovered: [] });
  const result = parseRecapAnswer(raw, { competencyIds: ['communication'], lines });
  expect(result.ok && result.recap.competencies[0]!.evidence.map((e) => e.seq)).toEqual([2]);
});

test('social acknowledgments alone are excluded without dropping technical answers that start politely', () => {
  expect(courtesyOnly('Sounds great, thanks Hugo.')).toBe(true);
  expect(courtesyOnly('Thanks, I check before storing the index so duplicates cannot reuse the same element.')).toBe(false);
  const recap = scriptedRecap({ ...input, lines: [input.lines[0]!, { seq: 11, side: 'candidate', text: 'Thanks, I check before storing the index so duplicates cannot reuse the same element.' }] });
  expect(recap.notCovered).toEqual([]);
});

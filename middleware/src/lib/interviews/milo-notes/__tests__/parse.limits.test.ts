// The private question's pre-check limits (lib/interviews/milo-notes/rules.ts `precheckQuestion`; row I3.6; OWED O-123),
// pinned: for each kind of question the pre-check's own comment says it cannot catch, what it does TODAY. Not changed here.
//   it(...)          what holds today: refused before any model, or let through as a fair search.
//   it.failing(...)  let through today, yet it asks Milo for what decision 6 forbids (a rating, a ranking, a recommendation,
//                    or a reading of a face, a voice or a manner). Each asserts the refusal it should get; it passes while the
//                    gap is open. The model is told to answer such a question with NOT_SAID and its answer is guarded
//                    (parse.ts), so this is the first line of two, not the only one.
import { precheckQuestion } from '../rules.js';

describe('refused today, before any model', () => {
  it.each([
    ['a judgement in the listed words', 'Was that a strong answer?', 'refused-judgement'],
    ['a hiring question', 'Should we hire her?', 'refused-judgement'],
    ['a comparison', 'Was he better than the other candidate?', 'refused-judgement'],
    ['a reading of the manner in the listed words', 'Did she seem nervous?', 'refused-personal'],
  ])('%s', (_l, q, code) => expect(precheckQuestion(q)).toBe(code));
});

describe('let through today, and a fair search', () => {
  it.each([
    ['a plain search', 'Where did she mention the release checklist?'],
    ['a leading but fair selection', 'Find only the places where she talked about things that went wrong.'],
    ['a selection by competency', 'What did she say that bears on delivery?'],
  ])('%s', (_l, q) => expect(precheckQuestion(q)).toBeNull());
});

describe('let through today, though it asks for what decision 6 forbids (the open gaps)', () => {
  it.failing.each([
    ['a paraphrased judgement', 'Anything I should worry about with her?'],
    ['a paraphrased judgement asking to be persuaded', 'Convince me she can lead a team.'],
    ['a judgement wrapped as a search', 'Find where she was weakest.'],
    ['a ranking wrapped as a search', 'Show me the moments that make the best case for her.'],
    ['a judgement in Spanish', '¿Es buena candidata?'],
    ['a hiring question in German', 'Sollten wir sie einstellen?'],
    ['a reading of the manner in French', 'Est-ce qu\'elle avait l\'air nerveuse ?'],
    ['a leading selection that reads the manner', 'Find the moments where she hesitated before answering.'],
  ])('%s is refused', (_l, q) => {
    expect(precheckQuestion(q)).not.toBeNull();
  });
});

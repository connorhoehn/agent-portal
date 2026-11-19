// Reading the coach's answer (lib/interviews/coach/parse.ts; row I3.3): strict JSON or dropped, and each guard.
import { guardSuggestion, parseCoachAnswer, quotedFrom } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';

const ctx = { competencyIds: FIXED_INPUT.competencies.map((c) => c.id), lines: FIXED_INPUT.lines };
const answer = (o: unknown) => parseCoachAnswer(typeof o === 'string' ? o : JSON.stringify(o), ctx);
const GOOD = { text: 'Who did you bring in, and when?', competencyId: 'communication', basedOn: 'I paged the on-call lead' };

describe('a well-formed answer', () => {
  it('is read, with a fenced code block tolerated and the quote kept', () => {
    expect(answer(GOOD)).toEqual({ ok: true, suggestion: GOOD });
    expect(answer('```json\n' + JSON.stringify(GOOD) + '\n```')).toEqual({ ok: true, suggestion: GOOD });
  });
  it('a quote with no words in it reads as no quote, and leading punctuation is trimmed', () => {
    for (const q of ['.', ' … ', '"."']) expect(answer({ ...GOOD, basedOn: q })).toEqual({ ok: true, suggestion: { ...GOOD, basedOn: null } });
  });
  it('may build on nothing said (a new question from the bank)', () => {
    expect(answer({ ...GOOD, basedOn: null })).toEqual({ ok: true, suggestion: { ...GOOD, basedOn: null } });
  });
  it('finds a quote whatever its case, spacing or curly quotes', () => {
    expect(quotedFrom('“I PAGED the   on-call lead…”', FIXED_INPUT.lines)).toBe(true);
  });
});

describe('a malformed answer is dropped', () => {
  it.each([
    ['not JSON', 'Ask them about the queue.'],
    ['nothing', null],
    ['an array', '[1,2]'],
    ['a missing key', JSON.stringify({ text: 'x?', competencyId: 'communication' })],
    ['an extra key', JSON.stringify({ ...GOOD, rating: 3 })],
    ['a wrong type', JSON.stringify({ ...GOOD, competencyId: 7 })],
    ['empty text', JSON.stringify({ ...GOOD, text: '   ' })],
  ])('%s', (_label, raw) => {
    expect(parseCoachAnswer(raw as string | null, ctx)).toEqual({ ok: false, code: 'malformed' });
  });
});

describe('a well-formed answer that breaks a rule is dropped with its code', () => {
  it('off-kit: a competency the kit does not have', () => expect(answer({ ...GOOD, competencyId: 'leadership' })).toEqual({ ok: false, code: 'off-kit' }));
  it('too-long: longer than a spoken question', () => expect(answer({ ...GOOD, text: `${'Why '.repeat(80)}?` })).toEqual({ ok: false, code: 'too-long' }));
  it('unsourced: a quote that is not in the transcript', () => expect(answer({ ...GOOD, basedOn: 'I rewrote the whole service alone' })).toEqual({ ok: false, code: 'unsourced' }));
  it('judges: rates the candidate', () => expect(answer({ ...GOOD, text: 'That was a strong answer; ask who else was paged?' })).toEqual({ ok: false, code: 'judges' }));
  it('personal: speaks of the person', () => expect(answer({ ...GOOD, text: 'They sound nervous; ask them to slow down?' })).toEqual({ ok: false, code: 'personal' }));
});

describe('the guard', () => {
  it.each([
    'I would rate them a 3 on communication.',
    'Score the candidate on the rubric now.',
    'This is a 3/4 so far.',
    'I recommend moving on.',
    'You should hire this one.',
    'Strong yes from me.',
    'How do they compare with the other candidates?',
    'That was a weak answer.',
    'Sounds like a culture fit.',
  ])('catches judging: %s', (text) => expect(guardSuggestion(text)).toBe('judges'));

  it.each([
    'Ask about their accent.',
    'Their tone was flat; probe that.',
    'Watch their body language here.',
    'They seem nervous.',
    'How old were you when you started?',
    'Do you have children?',
    'Where are you originally from?',
    'Are you a native speaker?',
    'Does your health allow on-call?',
    'Ask about their religion.',
    'Is their personality a match?',
  ])('catches the personal: %s', (text) => expect(guardSuggestion(text)).toBe('personal'));

  it.each([
    'How does your rate limiter treat a burst at the window edge?',
    'Who did you hire first, and why?',
    'How would you compare the two approaches you described?',
    'Where could a race condition appear in that retry loop?',
    'What does the health check of that service test?',
    'Would a regular expression be enough to validate the key?',
    'How confident are you that the retries are idempotent?',
    'What happens when the write fails halfway?',
  ])('lets the work through: %s', (text) => expect(guardSuggestion(text)).toBeNull());
});

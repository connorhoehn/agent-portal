// The coach guard's limits (lib/interviews/coach/parse.ts; row I3.3; OWED O-109), pinned on a fixed transcript: for each
// kind of answer the guard's own comment once said it could not catch, what it does now. The last block was a set of
// `it.failing` pins (decision 6: Milo never rates, ranks or recommends, and never infers anything from a face, a voice or
// a tone); the judgement detector (lib/interviews/judgement.ts) closed them, so each is now a plain test of the drop.
import { parseCoachAnswer, type ParseResult } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';

// The fixed transcript: the panel asks about an incident; the candidate says "The payments queue backed up, so I paged the
// on-call lead and we split the work."
const ctx = { competencyIds: FIXED_INPUT.competencies.map((c) => c.id), lines: FIXED_INPUT.lines };
const QUOTE = 'I paged the on-call lead';
const model = (text: string, competencyId = 'communication', basedOn: string | null = QUOTE): ParseResult =>
  parseCoachAnswer(JSON.stringify({ text, competencyId, basedOn }), ctx);
const dropped = (r: ParseResult): string | null => (r.ok ? null : r.code);

describe('drops today: the listed English words', () => {
  it.each([
    ['a named judgement', 'That was a strong answer. Who did you bring in, and when?', 'judges'],
    ['a rating on the rubric', 'I would rate this a 3 on the rubric; ask about the split.', 'judges'],
    ['a hiring call', 'We should hire them; ask what they would change next time.', 'judges'],
    ['a read of the voice', 'They sounded nervous; ask who they paged first.', 'personal'],
    ['a read of the face', 'Their body language says unsure. Who did you bring in?', 'personal'],
  ])('%s', (_l, text, code) => expect(dropped(model(text))).toBe(code));
});

describe('lets through today, and decision 6 allows it', () => {
  it('a leading but fair question about what was said', () => {
    expect(model('So paging the on-call lead was your first move: who did you bring in after that?')).toEqual({
      ok: true, suggestion: { text: 'So paging the on-call lead was your first move: who did you bring in after that?', competencyId: 'communication', basedOn: QUOTE },
    });
    expect(model('Wouldn\'t paging the on-call lead first have slowed the split?').ok).toBe(true);
  });

  it('a slant in which competency is picked: the guard reads one answer at a time and never sees the pattern', () => {
    // Five suggestions in a row, all probing the same competency and never the other: each passes on its own.
    const run = ['Who did you bring in, and when?', 'How did you explain the split to them?', 'What did you say first?', 'Who heard about it next?', 'How did you tell the team?'];
    for (const text of run) expect(model(text, 'communication').ok).toBe(true);
    // The same question tied to either competency passes alike: which one is probed is not the guard's to see.
    expect(model('Who did you bring in, and when?', 'collaboration').ok).toBe(true);
  });
});

describe('dropped since the judgement detector (the gaps once open)', () => {
  it.each([
    ['a paraphrased ranking', 'That was the most convincing story so far. Who did you bring in, and when?'],
    ['a paraphrased rating', 'That account was thin. Ask for one concrete example of the split.'],
    ['indirect praise', 'Exactly what we hope to hear from someone at this level. What happened next?'],
    ['indirect doubt', 'I am not convinced the candidate really led this. Who made the call to split the work?'],
    ['a judgement in Spanish', 'Fue una respuesta débil. ¿A quién avisaste primero?'],
    ['a recommendation in German', 'Ich würde sie einstellen. Wen haben Sie zuerst informiert?'],
    ['a read of the voice in French', 'Sa voix tremblait ; demandez qui a été appelé en premier.'],
    ['a read of the manner in other English words', 'They seemed a little shaky there; ask who they paged.'],
    ['the hiring question in another word order', 'Should we hire them? Ask what they would change next time.'],
  ])('%s is dropped', (_l, text) => {
    expect(dropped(model(text))).not.toBeNull();
  });
});

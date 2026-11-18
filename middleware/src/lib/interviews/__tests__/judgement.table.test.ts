// Decision 6 as a table (docs/interviews-tenant-plan.md): the asks the lead may put to Milo and the ones it must refuse
// before any model, and Milo's own words that must reach the lead and the ones that must be dropped. Each row is one
// case of lib/interviews/judgement.ts as wired into the Ask pre-check (milo-notes/rules.ts `precheckQuestion`) and the
// output guard (coach/parse.ts `guardSuggestion`, used by the coach, the private answer, the plan and the recap).
import { guardSuggestion } from '../coach/parse.js';
import { precheckQuestion } from '../milo-notes/rules.js';
import { normalise, readsAsEnglish } from '../judgement.js';

const ALLOWED_ASKS = [
  'What did they say about caching?',
  'Which questions are left?',
  'Summarise their answer on the rate limiter.',
  'Where did she mention the release checklist?',
  'Find only the places where she talked about things that went wrong.',
  'What did she say that bears on delivery?',
  'What did they say about the rate limiter?',
  'Where did she talk about testing?',
  'Did he mention the retry budget?',
  'What did they say happened first in the incident?',
  'Which of the chosen questions are left?',
  'What was the race condition they described?',
  "What's left to cover on communication?",
  'Where did he describe the rollback?',
  'Quote what she said about on-call.',
  'Did they mention idempotency keys?',
  'What did the candidate say about strong consistency?',
  'Where did she talk about weak references?',
  'What did he say the error rate was?',
  'Summarize what they said about the migration plan.',
  'What did they say about best practices for logging?',
  'Did she talk about the worst case complexity?',
  'What did he say about the trust boundary?',
  'Which competency has no questions asked yet?',
  'What did she say about her résumé gap?',
  'Where did they explain the queue backing up?',
  'What examples did he give of mentoring?',
  'Did the candidate mention Kafka?',
  'What did José say about sharding?',
  'Show me where they talked about the payments queue.',
  'Which lines mention the database index?',
  'What did they say they would change next time?',
  'Where did she bring up deadlines?',
  'What did they say about GC tuning?',
  'List what they said about monitoring.',
  'What did he say about the regular expression?',
  'Who did they say they paged first?',
  'What did they say about ES modules?',
  'What concerns did she raise about the migration?',
  'What did the candidate say about the MIT license?',
  'How long did they say the outage lasted?',
  'Which question did Milo suggest last?',
];

const REFUSED_ASKS: Array<[string, 'refused-judgement' | 'refused-personal' | 'either']> = [
  // the pinned gaps (milo-notes parse.limits) and the H3 report's finding 7
  ['Anything I should worry about with her?', 'refused-judgement'],
  ['Convince me she can lead a team.', 'refused-judgement'],
  ['Find where she was weakest.', 'refused-judgement'],
  ['Show me the moments that make the best case for her.', 'refused-judgement'],
  ['¿Es buena candidata?', 'refused-judgement'],
  ['Sollten wir sie einstellen?', 'refused-judgement'],
  ["Est-ce qu'elle avait l'air nerveuse ?", 'refused-judgement'],
  ['Find the moments where she hesitated before answering.', 'refused-personal'],
  ['Should we hire them?', 'refused-judgement'],
  // paraphrases
  ["Shouldn't we just hire him?", 'refused-judgement'],
  ['Would you hire this person?', 'refused-judgement'],
  ['Is she worth advancing?', 'refused-judgement'],
  ['Should she move to the next round?', 'refused-judgement'],
  ['How did they do?', 'refused-judgement'],
  ["How'd he do on the design question?", 'refused-judgement'],
  ['How did the candidate perform overall?', 'refused-judgement'],
  ['Did she nail the system design?', 'refused-judgement'],
  ['Where did he struggle the most?', 'refused-judgement'],
  ['What were her strongest moments?', 'refused-judgement'],
  ['Find his best answer.', 'refused-judgement'],
  ['Is he better than the other candidate?', 'refused-judgement'],
  ['Rank the candidates for me.', 'refused-judgement'],
  ['What score would you give her?', 'refused-judgement'],
  ['Grade their answer on testing.', 'refused-judgement'],
  ['Any red flags?', 'refused-judgement'],
  ['Any concerns?', 'refused-judgement'],
  ['What concerns do you have about them?', 'refused-judgement'],
  ['Is she a good fit for the team?', 'refused-judgement'],
  ['Would he fit in here?', 'refused-judgement'],
  ['Is she senior enough?', 'refused-judgement'],
  ['Does he really understand caching?', 'refused-judgement'],
  ['Does she have enough experience for this role?', 'refused-judgement'],
  ['Can he handle the on-call load?', 'refused-judgement'],
  ['Make the case against hiring her.', 'refused-judgement'],
  ['Was his answer convincing?', 'refused-judgement'],
  ['What did you make of her?', 'refused-judgement'],
  ["What's your read on the candidate?", 'refused-judgement'],
  ['Do you think he was exaggerating?', 'refused-judgement'],
  ['Was she honest about her role?', 'refused-judgement'],
  ['Did they pass?', 'refused-judgement'],
  ['Thumbs up or down on him?', 'refused-judgement'],
  ['Which answer was the weakest?', 'refused-judgement'],
  ['Find where they could have done better.', 'refused-judgement'],
  ['What are her strengths and weaknesses?', 'refused-judgement'],
  ['Did they impress you?', 'refused-judgement'],
  ['Was that answer thin?', 'refused-judgement'],
  ['Did he seem confident?', 'refused-personal'],
  ['How was her tone when she talked about the outage?', 'refused-personal'],
  ['Did she pause a lot?', 'refused-personal'],
  ['Was he flustered by the follow-up?', 'refused-personal'],
  ['When did she go quiet? Did she go silent for long?', 'either'],
  // other languages
  ['¿Deberíamos contratarla?', 'refused-judgement'],
  ['¿Dónde fue más débil?', 'refused-judgement'],
  ['Est-ce que nous devrions embaucher ce candidat ?', 'refused-judgement'],
  ['Était-il convaincant ?', 'refused-judgement'],
  ['Wie gut war die Kandidatin?', 'refused-judgement'],
  ['Ist er ein guter Kandidat?', 'refused-judgement'],
  ['Moeten we haar aannemen?', 'refused-judgement'],
  ['Dovremmo assumere lei?', 'refused-judgement'],
  ['彼女を採用すべきですか？', 'refused-judgement'],
  ['Qué dijo sobre caching?', 'refused-judgement'],
];

describe('the Ask pre-check: asks the lead may put to Milo', () => {
  it('holds at least 40 rows', () => expect(ALLOWED_ASKS.length).toBeGreaterThanOrEqual(40));
  it.each(ALLOWED_ASKS)('lets through: %s', (q) => expect(precheckQuestion(q)).toBeNull());
});

describe('the Ask pre-check: asks Milo must refuse before any model', () => {
  it('holds at least 40 rows', () => expect(REFUSED_ASKS.length).toBeGreaterThanOrEqual(40));
  it.each(REFUSED_ASKS)('refuses: %s', (q, code) => {
    const got = precheckQuestion(q);
    if (code === 'either') expect(got).not.toBeNull();
    else expect(got).toBe(code);
  });
});

const ALLOWED_OUTPUTS = [
  'Who did you bring in, and when?',
  'How did you explain the split to the team?',
  'Who did you hire first, and why?',
  'Where did you struggle most during the incident?',
  'How would you compare the two approaches you described?',
  'How does your rate limiter treat a burst at the window edge?',
  'What happens when the write fails halfway?',
  'How confident are you that the retries are idempotent?',
  'At that level of traffic, what broke first?',
  'What was your take on the rollback plan?',
  'She said she paged the on-call lead first.',
  'They described splitting the queue into two consumers.',
  'The candidate said the payments queue backed up.',
  'How did you convince the team to roll back?',
  'What would you change next time?',
  'Walk me through the strong consistency trade-off you mentioned.',
  'What did you measure before and after the fix?',
  'Which part of the design would you test first?',
];

const DROPPED_OUTPUTS = [
  'That was the most convincing story so far. Who did you bring in, and when?',
  'That account was thin. Ask for one concrete example of the split.',
  'Exactly what we hope to hear from someone at this level. What happened next?',
  'I am not convinced the candidate really led this. Who made the call to split the work?',
  'Fue una respuesta débil. ¿A quién avisaste primero?',
  'Ich würde sie einstellen. Wen haben Sie zuerst informiert?',
  'Sa voix tremblait ; demandez qui a été appelé en premier.',
  'They seemed a little shaky there; ask who they paged.',
  'Should we hire them? Ask what they would change next time.',
  'Her answer was vague; ask for numbers.',
  'An impressive answer. Ask about the rollback.',
  'She is not a fit for the team.',
  'He hesitated before answering about the deadline.',
  'That is the weakest answer we have heard today.',
  'They are stronger than most candidates on this.',
  'Red flags in that story; ask who owned it.',
  'She nailed it. Ask the next question.',
  'Concerns about him on ownership; probe that.',
];

describe('the output guard: what Milo may show', () => {
  it.each(ALLOWED_OUTPUTS)('shows: %s', (t) => expect(guardSuggestion(t)).toBeNull());
});

describe('the output guard: what Milo must drop (the backstop for an ask the pre-check missed)', () => {
  it.each(DROPPED_OUTPUTS)('drops: %s', (t) => expect(guardSuggestion(t)).not.toBeNull());
});

describe('normalisation and language', () => {
  it('folds contractions and every name for the candidate', () => {
    expect(normalise("Shouldn't we hire HER?")).toBe('should not we hire cand');
    expect(normalise("How'd the applicant's answer go?")).toBe("how did cand's answer go");
    expect(normalise('Was he better than the other candidate?')).toBe('was cand better than othercand');
  });
  it.each([
    ['plain English', 'Where did she mention caching?', true],
    ['an English loan word', 'What did she say about her résumé?', true],
    ['a name with an accent mid-sentence', 'What did José say about sharding?', true],
    ['an acronym that is a Spanish word in lower case', 'What did they say about ES modules?', true],
    ['Spanish', '¿Es buena candidata?', false],
    ['French elision', "Est-ce qu'elle avait l'air nerveuse ?", false],
    ['German with no accent', 'Sollten wir sie einstellen?', false],
    ['another script', '彼女を採用すべきですか', false],
    ['no English word in three or more', 'Kafka partition rebalancing', false],
  ])('%s', (_l, text, english) => expect(readsAsEnglish(text)).toBe(english));
});

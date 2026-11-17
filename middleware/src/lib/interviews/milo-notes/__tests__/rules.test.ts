// When Milo may answer the lead's private question (lib/interviews/milo-notes/rules.ts; row I3.6), every branch.
import { ASK_GAP_MS, checkQuestion, decideAsk, MAX_ASKS_PER_INTERVIEW, precheckQuestion, type AskFacts } from '../rules.js';
import type { CoachLogRecord } from '../store.js';

const NOW = Date.UTC(2026, 10, 17, 10, 30);
const row = (secondsAgo: number, over: Partial<CoachLogRecord> = {}): CoachLogRecord => ({
  id: `ml-${secondsAgo}`, interviewId: 'iv-1', kind: 'answer', askedBy: 'u-lead', question: 'q', answer: 'a', sources: [], code: null,
  askedAt: new Date(NOW - secondsAgo * 1000).toISOString(), modelId: 'scripted-milo', promptVersion: 'v', ...over,
});
const facts = (over: Partial<AskFacts> = {}): AskFacts => ({
  viewerId: 'u-lead', interview: { leadId: 'u-lead', state: 'live' }, consent: { transcription: true, milo: true },
  question: 'What did they say about testing?', log: [], inFlight: false, lineCount: 4, nowMs: NOW, ...over,
});

describe('decideAsk', () => {
  it('thinks for the lead of a live interview with consent and lines, numbering the call', () => {
    expect(decideAsk(facts())).toEqual({ kind: 'think', n: 1 });
    expect(decideAsk(facts({ log: [row(300), row(100, { modelId: 'none', code: 'refused-judgement' })] }))).toEqual({ kind: 'think', n: 2 });
  });
  it.each<[string, Partial<AskFacts>, unknown]>([
    ['not the lead', { viewerId: 'u-panel' }, { kind: 'not-found' }],
    ['not live', { interview: { leadId: 'u-lead', state: 'ended' } }, { kind: 'refuse', reason: 'not-live', retryAfterMs: null }],
    ['no answers', { consent: null }, { kind: 'refuse', reason: 'no-consent', retryAfterMs: null }],
    ['Milo declined', { consent: { transcription: true, milo: false } }, { kind: 'refuse', reason: 'no-consent', retryAfterMs: null }],
    ['the transcript declined', { consent: { transcription: false, milo: true } }, { kind: 'refuse', reason: 'no-consent', retryAfterMs: null }],
    ['a judgement', { question: 'Is she a strong candidate?' }, { kind: 'fixed', code: 'refused-judgement' }],
    ['a personal trait', { question: 'Did he seem nervous?' }, { kind: 'fixed', code: 'refused-personal' }],
    ['at the maximum', { log: Array.from({ length: MAX_ASKS_PER_INTERVIEW }, (_, i) => row(1000 + i)) }, { kind: 'refuse', reason: 'at-max', retryAfterMs: null }],
    ['too soon', { log: [row(5)] }, { kind: 'refuse', reason: 'too-soon', retryAfterMs: ASK_GAP_MS - 5000 }],
    ['one in flight', { inFlight: true }, { kind: 'refuse', reason: 'in-flight', retryAfterMs: 5000 }],
    ['nothing said yet', { lineCount: 0 }, { kind: 'refuse', reason: 'no-lines', retryAfterMs: null }],
  ])('%s', (_l, over, expected) => {
    expect(decideAsk(facts(over))).toEqual(expected);
  });
  it('a refusal before the model never counts toward the gap', () => {
    expect(decideAsk(facts({ log: [row(2, { modelId: 'none', code: 'refused-personal' })] }))).toEqual({ kind: 'think', n: 1 });
  });
});

describe('the pre-check', () => {
  it.each([
    'Is she any good?', 'is the candidate qualified', 'How did he do on the first question?', 'How well did they explain it?',
    'Should we hire her?', 'Would you recommend him?', 'Rate her answer on testing', 'What would you score that?',
    'What do you think of the candidate?', 'Was he better than the other candidate?', 'Did she pass the bar?', 'thumbs up or down?',
    'Was that a strong answer?',
  ])('refuses a judgement: %s', (q) => expect(precheckQuestion(q)).toBe('refused-judgement'));
  it.each([
    'Did she seem nervous?', 'Where is he originally from?', 'How old is she?', 'What is her nationality?', 'Does he have kids?', 'Her accent?',
  ])('refuses a personal trait: %s', (q) => expect(precheckQuestion(q)).toBe('refused-personal'));
  it.each([
    'What did they say about the rate limiter?', 'Where did she talk about testing?', 'Did he mention the retry budget?',
    'What did they say happened first in the incident?', 'Which of the chosen questions are left?', 'What was the race condition they described?',
  ])('lets a search through: %s', (q) => expect(precheckQuestion(q)).toBeNull());
});

describe('checkQuestion', () => {
  it('takes a trimmed question up to the cap, and nothing else', () => {
    expect(checkQuestion({ question: '  What   about tests? ' })).toBe('What about tests?');
    expect(checkQuestion({ question: '' })).toBeNull();
    expect(checkQuestion({ question: 'x'.repeat(301) })).toBeNull();
    expect(checkQuestion({ question: 3 })).toBeNull();
    expect(checkQuestion(null)).toBeNull();
    expect(checkQuestion(['q'])).toBeNull();
  });
});

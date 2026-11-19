// The detector's limits (lib/interviews/speak `candidateRequestOf`; row I3.8, decision 10; OWED O-224, lane H8). The candidate
// may ask Milo for two things only: the question again, or the time left. Everything else must be `other` (the one fixed
// sentence). This pins, as a table, what the two patterns detect and what they let through. The patterns read the whole
// utterance (a short request with at most a greeting, Milo's name, "can you" and "please" around it), so a sentence that only
// contains one of the phrases is `other`. Whatever is
// detected is still answered only from held text (the last approved question, or the time left), so a misread repeats the
// question or reads the clock; it never reaches a model.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
import { candidateRequestOf } from '../index.js';

describe('what the detector reads as one of the two requests (as it should)', () => {
  it.each([
    ['repeat the question', 'repeat'],
    ['Milo, repeat the question please', 'repeat'],
    ['Could you say that again?', 'repeat'],
    ['What was the question?', 'repeat'],
    ['What is the question', 'repeat'],
    ['ask it again', 'repeat'],
    ['how much time is left?', 'time'],
    ['How long do I have?', 'time'],
    ['time left', 'time'],
    ['minutes remaining', 'time'],
    ['how long have we got', 'time'],
    // A clause before the request, the name last (film F1, 19 November).
    ['Before I start drawing, roughly how much time is left, Milo?', 'time'],
    ['Okay so before I code this up, how long do I have left?', 'time'],
    ['Sorry, I lost my train of thought, could you repeat the question, Milo?', 'repeat'],
    ['Before I answer, what was the question again?', 'repeat'],
  ])('"%s" is %s', (text, want) => {
    expect(candidateRequestOf(text)).toBe(want);
  });
});

describe('near-misses of the two phrases and other languages: the fixed sentence (other)', () => {
  // A plain request the patterns do not know is answered with the one sentence that names the two requests: safe, if less helpful.
  it.each([
    'pardon?',
    "what's the question",
    'can you rephrase the question',
    'How many minutes are left?',
    'Milo, répète la question',
    '¿Cuánto tiempo queda?',
    'Wiederhole die Frage',
    'wie viel Zeit bleibt',
    'what time is it',
  ])('"%s" is other', (text) => {
    expect(candidateRequestOf(text)).toBe('other');
  });
});

describe('anything else asks for help, and gets the fixed sentence (other)', () => {
  it.each([
    'give me a hint',
    'what is the answer',
    'is my code correct',
    'can you tell me what is wrong with my loop',
  ])('"%s" is other', (text) => {
    expect(candidateRequestOf(text)).toBe('other');
  });
});

// Decision 10 says these are `other`: each contains a request's words but is not the request (closed 18 November).
describe('decision 10: a sentence that only contains the words is other', () => {
  it.each([
    'Repeat the answer',
    'Can you repeat what the expected output is?',
    'How much time complexity does my solution have?',
    'How long should the function be in minutes?',
    'I would repeat the request with backoff',
    'I spent a long time on this, how much is left to cover',
    'I would repeat it with exponential backoff',
    'so the time left over goes to the queue',
    'after the first pass the time left is spent on tests',
    'I think I would repeat the question back to the user',
  ])('"%s" is other', (text) => {
    expect(candidateRequestOf(text)).toBe('other');
  });
});

describe('the requests as people say them, with the words around them', () => {
  it.each([
    ['Sorry, Milo, can you repeat the question?', 'repeat'],
    ['Milo, could you please repeat that?', 'repeat'],
    ['Repeat the last question, please.', 'repeat'],
    ['Um, what was the question again?', 'repeat'],
    ['Milo, how much time is left in this round?', 'time'],
    ["Hey Milo, how much time do we have left?", 'time'],
    ['How long do I have left?', 'time'],
  ])('"%s" is %s', (text, want) => {
    expect(candidateRequestOf(text)).toBe(want);
  });
});

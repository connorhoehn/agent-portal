// The detector's limits (lib/interviews/speak `candidateRequestOf`; row I3.8, decision 10; OWED O-224, lane H8). The candidate
// may ask Milo for two things only: the question again, or the time left. Everything else must be `other` (the one fixed
// sentence). This pins, as a table, what the two patterns detect and what they let through; a line decision 10 says must be
// `other` and is not is an `it.failing` here and a finding in the lane's report, never a change to the patterns. Whatever is
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

// Decision 10 says these must be `other`; the patterns read them as one of the two requests today. Each is harmless in what is
// said (the last approved question, or the time left), but it is not the fixed sentence. Reported, not changed.
describe('decision 10 says other; the detector reads a request (findings)', () => {
  it.failing('a hint asked as "repeat the answer" is other', () => {
    expect(candidateRequestOf('Repeat the answer')).toBe('other');
  });
  it.failing('"can you repeat what the expected output is?" (a hint) is other', () => {
    expect(candidateRequestOf('Can you repeat what the expected output is?')).toBe('other');
  });
  it.failing('"how much time complexity does my solution have?" (a hint) is other', () => {
    expect(candidateRequestOf('How much time complexity does my solution have?')).toBe('other');
  });
  it.failing('"how long should the function be in minutes?" is other', () => {
    expect(candidateRequestOf('How long should the function be in minutes?')).toBe('other');
  });
  it.failing('the phrase inside a longer answer ("I would repeat the request with backoff") is other', () => {
    expect(candidateRequestOf('I would repeat the request with backoff')).toBe('other');
  });
  it.failing('"I spent a long time on this, how much is left to cover" is other', () => {
    expect(candidateRequestOf('I spent a long time on this, how much is left to cover')).toBe('other');
  });
});

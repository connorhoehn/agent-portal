// When the coach may think (lib/interviews/coach/rules.ts; decisions 8 and 20, row I3.3).
import { decideCoach, MAX_ATTEMPTS_PER_INTERVIEW, SUGGESTION_GAP_MS, type CoachFacts } from '../rules.js';
import type { SuggestionRecord } from '../store.js';

const NOW = Date.UTC(2026, 10, 16, 14, 30);
const row = (over: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
  id: 'sg-1', interviewId: 'iv-1', callId: 'call-1', throughSeq: 10, text: 'Who else?', competencyId: 'communication', basedOn: null,
  madeAt: new Date(NOW - 5 * 60_000).toISOString(), shownAt: new Date(NOW - 5 * 60_000).toISOString(), answer: 'ask',
  answeredAt: new Date(NOW - 4 * 60_000).toISOString(), spoken: false, modelId: 'scripted-coach', promptVersion: 'v', dropped: null, ...over,
});
const facts = (over: Partial<CoachFacts> = {}): CoachFacts => ({
  viewerId: 'u-wen', interview: { leadId: 'u-wen', state: 'live' }, consent: { transcription: true, milo: true },
  log: [row()], transcript: { callId: 'call-1', lastSeq: 12 }, inFlight: false, nowMs: NOW, ...over,
});

describe('the coach thinks only for the live lead with Milo accepted', () => {
  it('thinks when everything allows it', () => expect(decideCoach(facts())).toEqual({ kind: 'think' }));
  it('not-found for anyone but the lead', () => expect(decideCoach(facts({ viewerId: 'u-hugo' }))).toEqual({ kind: 'not-found' }));
  it.each(['ready', 'accepted', 'ended', 'scored'])('nothing while the interview is %s', (state) =>
    expect(decideCoach(facts({ interview: { leadId: 'u-wen', state } }))).toMatchObject({ kind: 'none', reason: 'not-live' }));
  it.each([
    ['no answers', null],
    ['Milo declined', { transcription: true, milo: false }],
    ['the transcript declined', { transcription: false, milo: true }],
  ])('nothing with %s', (_l, consent) => expect(decideCoach(facts({ consent }))).toMatchObject({ kind: 'none', reason: 'no-consent' }));
});

describe('the limits', () => {
  it('shows the waiting suggestion again, never a new one beside it', () => {
    const waiting = row({ id: 'sg-2', answer: null, answeredAt: null, madeAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(decideCoach(facts({ log: [row(), waiting] }))).toEqual({ kind: 'show', suggestion: waiting });
  });
  it('a dropped attempt is not waiting', () => {
    const dropped = row({ id: 'sg-2', text: '', competencyId: null, answer: null, answeredAt: null, shownAt: null, dropped: 'malformed' });
    expect(decideCoach(facts({ log: [dropped] }))).toEqual({ kind: 'think' });
  });
  it('at most one every 90 seconds, a dropped attempt included, with when to ask again', () => {
    const recent = row({ madeAt: new Date(NOW - 30_000).toISOString() });
    expect(decideCoach(facts({ log: [recent] }))).toEqual({ kind: 'none', reason: 'too-soon', retryAfterMs: SUGGESTION_GAP_MS - 30_000 });
    const droppedRecent = row({ madeAt: new Date(NOW - 30_000).toISOString(), text: '', competencyId: null, answer: null, answeredAt: null, dropped: 'timeout' });
    expect(decideCoach(facts({ log: [droppedRecent] }))).toMatchObject({ kind: 'none', reason: 'too-soon' });
    expect(decideCoach(facts({ log: [row({ madeAt: new Date(NOW - SUGGESTION_GAP_MS).toISOString() })] }))).toEqual({ kind: 'think' });
  });
  it('nothing when no line was added since the last attempt; a new call counts as new', () => {
    expect(decideCoach(facts({ transcript: { callId: 'call-1', lastSeq: 10 } }))).toMatchObject({ kind: 'none', reason: 'no-new-lines' });
    expect(decideCoach(facts({ transcript: null }))).toMatchObject({ kind: 'none', reason: 'no-new-lines' });
    expect(decideCoach(facts({ transcript: { callId: 'call-2', lastSeq: 3 } }))).toEqual({ kind: 'think' });
    expect(decideCoach(facts({ log: [], transcript: { callId: 'call-1', lastSeq: 0 } }))).toMatchObject({ reason: 'no-new-lines' });
  });
  it(`at most ${MAX_ATTEMPTS_PER_INTERVIEW} attempts per interview`, () => {
    const log = Array.from({ length: MAX_ATTEMPTS_PER_INTERVIEW }, (_, n) => row({ id: `sg-${n}`, throughSeq: n }));
    expect(decideCoach(facts({ log }))).toMatchObject({ kind: 'none', reason: 'at-max' });
  });
  it('one call in flight per interview', () => expect(decideCoach(facts({ inFlight: true }))).toMatchObject({ kind: 'none', reason: 'in-flight' }));
});

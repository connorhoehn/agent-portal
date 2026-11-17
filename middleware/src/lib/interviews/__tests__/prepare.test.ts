// The rules for preparing a round (lib/interviews/prepare.ts; row I1.7).
import { checkQuestions, mayChoose, MAX_QUESTIONS, missingLine, readyState } from '../prepare.js';
import type { Interview, OpeningKit } from '../types.js';

const kit: OpeningKit = {
  rounds: [], competencies: [],
  questions: [
    { id: 'qt1', prompt: 'a', followUps: [], competencyId: 'c', roundType: 'technical' },
    { id: 'qt2', prompt: 'b', followUps: [], competencyId: 'c', roundType: 'technical' },
    { id: 'qb1', prompt: 'c', followUps: [], competencyId: 'c', roundType: 'behavioural' },
  ],
};
const lead = 'u-lead';
const iv = (o: Partial<Interview> = {}): Pick<Interview, 'state' | 'type' | 'leadId' | 'acceptances' | 'scheduledAt' | 'questionIds'> => ({
  state: 'accepted', type: 'technical', leadId: lead, acceptances: [{ userId: lead, seat: 'lead', at: 'x' }], scheduledAt: null, questionIds: [], ...o,
});

describe('readyState', () => {
  it('is ready only with a time and a question; follows both when either is taken away', () => {
    expect(readyState(iv({ scheduledAt: 't', questionIds: ['qt1'] }))).toBe('ready');
    expect(readyState(iv({ state: 'ready', scheduledAt: null, questionIds: ['qt1'] }))).toBe('accepted');
    expect(readyState(iv({ state: 'ready', scheduledAt: 't', questionIds: [] }))).toBe('accepted');
  });
  it('leaves every other state alone', () => {
    for (const state of ['assigned', 'live', 'ended', 'declined', 'cancelled'] as const) expect(readyState(iv({ state, scheduledAt: 't', questionIds: ['q'] }))).toBe(state);
  });
  it('says what is missing in one line', () => {
    expect(missingLine(iv())).toContain('time from the recruiter, and');
    expect(missingLine(iv({ questionIds: ['qt1'] }))).toBe('Waiting for a time from the recruiter.');
    expect(missingLine(iv({ scheduledAt: 't' }))).toContain('at least one question');
    expect(missingLine(iv({ scheduledAt: 't', questionIds: ['qt1'] }))).toBeNull();
  });
});

describe('who and when', () => {
  it('only the lead chooses', () => { expect(mayChoose({ leadId: lead }, lead)).toBe(true); expect(mayChoose({ leadId: lead }, 'u-other')).toBe(false); });
  it.each(['assigned', 'live', 'ended', 'declined', 'cancelled'] as const)('refuses in %s', (state) => {
    expect(checkQuestions({ questionIds: ['qt1'] }, iv({ state }), kit).ok).toBe(false);
  });
  it('refuses before the lead has accepted even if the state says otherwise', () => {
    expect(checkQuestions({ questionIds: ['qt1'] }, iv({ acceptances: [] }), kit).ok).toBe(false);
  });
});

describe('what', () => {
  const ids = (v: unknown, o: Partial<Interview> = {}) => checkQuestions({ questionIds: v }, iv(o), kit);
  it('takes the kit\'s questions of the round\'s type, in order, and an empty plan', () => {
    expect(ids(['qt2', 'qt1'])).toEqual({ ok: true, value: { questionIds: ['qt2', 'qt1'] } });
    expect(ids([])).toEqual({ ok: true, value: { questionIds: [] } });
    expect(ids(['qb1'], { type: 'behavioural' }).ok).toBe(true);
  });
  it('refuses the wrong type, a stranger, a repeat, too many and a non-list, in words', () => {
    for (const bad of [['qb1'], ['nope'], ['qt1', 'qt1'], Array.from({ length: MAX_QUESTIONS + 1 }, (_, n) => `q${n}`), 'qt1', [1]]) {
      const r = ids(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems[0]!.message).toMatch(/\.$/);
    }
  });
});

// Hardening (H1, O-036): the ceiling is a number of questions, so the limit itself is taken and one more is not.
describe('the ceiling of questions in a plan', () => {
  const big: OpeningKit = {
    rounds: [], competencies: [],
    questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, n) => ({ id: `qt${n}`, prompt: `q${n}`, followUps: [], competencyId: 'c', roundType: 'technical' as const })),
  };
  it('takes exactly the most it allows, in the order sent, and refuses one more with a sentence', () => {
    const all = big.questions.map((q) => q.id);
    const eight = checkQuestions({ questionIds: all.slice(0, MAX_QUESTIONS) }, iv(), big);
    expect(MAX_QUESTIONS).toBe(8);
    expect(eight).toEqual({ ok: true, value: { questionIds: all.slice(0, MAX_QUESTIONS) } });
    const nine = checkQuestions({ questionIds: all }, iv(), big);
    expect(nine.ok).toBe(false);
    if (!nine.ok) expect(nine.problems[0]).toMatchObject({ path: 'questionIds', message: expect.stringMatching(/\.$/) });
  });
});

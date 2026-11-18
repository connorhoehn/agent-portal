// The speech's money (lib/interviews/speak; row I3.5, decision 18's `speech` part; OWED O-222, lane H8). Money is pinned, never
// fixed: this suite says what the code does today, and the case the plan asks for and the code does not do is `it.failing`.
//
// Speech is an explicit part of the interview's money: each line said aloud first holds SPEECH_HOLD_USD under part `speech`
// (keyed by its said row) through spend.ts's door, and releases it once said, because the listening period's minute meter books
// the audio. A refused hold (a reached interview cap, no cap set) leaves the words in the chat and says nothing.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
jest.mock('../../spend.js', () => ({
  ...jest.requireActual('../../spend.js'),
  reserveInterviewSpend: jest.fn(),
  settleInterviewSpend: jest.fn(),
  releaseInterviewSpend: jest.fn(async () => undefined),
  meterInterviewSpend: jest.fn(),
}));
import { SAY_MAX_BOUND_MS, SAY_QUIET_WAIT_MS } from '../../../meeting-assistant/approved-speech.js';
import * as spend from '../../spend.js';
import { INTERVIEW_SPEND_PARTS } from '../../spend.js';
import { MemorySaidStore, SPEECH_HOLD_TTL_MS, SPEECH_HOLD_USD, answerCandidate, logSaid, notAloudWhy, sayApproved, sayLogged, setSpeakDeps } from '../index.js';
import type { SayResult } from '../../../meeting-assistant/approved-speech.js';

const IV = { id: 'iv-money', callId: 'call-money', minutes: 45, scheduledAt: null as string | null };
const NOW = Date.parse('2026-11-17T15:00:00.000Z');
let said: string[] = [];
let posted: string[] = [];
let store: MemorySaidStore;
let n = 0;
const reserve = spend.reserveInterviewSpend as jest.Mock;
const release = spend.releaseInterviewSpend as jest.Mock;

beforeEach(() => {
  said = []; posted = []; n = 0; store = new MemorySaidStore();
  reserve.mockReset(); release.mockClear();
  // A refused hold, as a cap reached would answer: if the speech asked, it would be told no.
  reserve.mockResolvedValue({ ok: false, refusal: { status: 402, body: { error: 'This interview has reached its cap.' } } });
  setSpeakDeps({
    store: () => store,
    post: async (_c, text) => { posted.push(text); return true; },
    say: async (_c, text) => { said.push(text); return { outcome: 'spoken' as const, why: null }; },
    miloJoinedAt: async () => NOW - 10 * 60_000,
    callOf: async () => IV.callId,
    now: () => NOW,
    newId: () => `said-${++n}`,
  });
});
afterAll(() => setSpeakDeps(null));

it('the plan names a speech part of an interview\'s money', () => {
  expect(INTERVIEW_SPEND_PARTS).toContain('speech');
});

it('a granted hold: a kit question and a candidate\'s answer are posted and said, each holding its line under `speech` and releasing it after', async () => {
  reserve.mockResolvedValue({ ok: true, holdId: 'hold-1', sourceId: 'iv:o:iv-money:speech:said-1', amountUsd: SPEECH_HOLD_USD });
  expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a rate limiter.', askedBy: 'u-hugo' })).said).toBe('spoken');
  expect((await answerCandidate(IV, 'time', 'guest:inv-1')).said).toBe('spoken');
  expect(reserve).toHaveBeenCalledTimes(2);
  expect(reserve).toHaveBeenNthCalledWith(1, expect.objectContaining({ interviewId: IV.id, part: 'speech', key: 'said-1', estimateUsd: SPEECH_HOLD_USD }));
  expect(release).toHaveBeenCalledTimes(2);
  expect(posted).toHaveLength(2);
  expect(said).toHaveLength(2);
  expect((await store.list(IV.id)).map((r) => r.spoken)).toEqual([true, true]);
});

it('a refused speech hold (a reached interview cap) posts in chat and says nothing', async () => {
  const out = await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a rate limiter.', askedBy: 'u-hugo' });
  expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ interviewId: IV.id, part: 'speech' }));
  expect(out.said).toBe('chat');
  expect(said).toEqual([]);
  expect(posted).toEqual(['Design a rate limiter.']);
  expect((await store.list(IV.id)).map((r) => r.spoken)).toEqual([false]);
});

it('the candidate\'s button under a reached cap: the line is in the chat, not said', async () => {
  const out = await answerCandidate(IV, 'time', 'guest:inv-1');
  expect(out.said).toBe('chat');
  expect(said).toEqual([]);
  expect(posted).toHaveLength(1);
});

it('a hold that throws is a refusal, never a crash and never speech', async () => {
  reserve.mockRejectedValue(new Error('store down'));
  expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Q', askedBy: 'u-hugo' })).said).toBe('chat');
  expect(said).toEqual([]);
});

it('a hold that throws is logged with its name and message, and is still a refusal', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    reserve.mockRejectedValue(new TypeError('store down'));
    const row = await logSaid(IV, { kind: 'question', source: 'suggestion', text: 'Q', askedBy: 'u-hugo' });
    expect(await sayLogged(IV.id, row, IV.callId)).toEqual({ spoken: false, why: 'budget' });
    expect(warn).toHaveBeenCalledWith('[interviews] speech hold failed', 'TypeError', 'store down');
    expect(said).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

// The lead's "Have Milo ask" receipt (coach/service.ts answerSuggestion) says why the words were not said aloud.
describe('why a logged line was not said aloud (sayLogged)', () => {
  const sayAs = (result: SayResult | Error) => setSpeakDeps({
    store: () => store, now: () => NOW, newId: () => `said-${++n}`,
    say: async () => { if (result instanceof Error) throw result; return result; },
  });
  const tryIt = async () => sayLogged(IV.id, await logSaid(IV, { kind: 'question', source: 'suggestion', text: 'Q', askedBy: 'u-hugo' }), IV.callId);
  beforeEach(() => reserve.mockResolvedValue({ ok: true, holdId: 'hold-1', sourceId: 's', amountUsd: SPEECH_HOLD_USD }));

  it('a refused hold is the budget', async () => {
    reserve.mockResolvedValue({ ok: false, refusal: { status: 402, body: { error: 'cap' } } });
    sayAs({ outcome: 'spoken', why: null });
    expect(await tryIt()).toEqual({ spoken: false, why: 'budget' });
  });

  it('relayed is spoken and marks the row; Milo with no run in the call is not in the call', async () => {
    sayAs({ outcome: 'spoken', why: null });
    expect(await tryIt()).toEqual({ spoken: true });
    expect((await store.list(IV.id)).at(-1)!.spoken).toBe(true);
    sayAs({ outcome: 'no-call', why: null });
    expect(await tryIt()).toEqual({ spoken: false, why: 'not-in-call' });
  });

  it('the meeting assistant\'s withheld codes: voice off, paused, not heard in time, anything else', async () => {
    for (const [why, want] of [['voice-off', 'voice-off'], ['paused', 'paused'], ['not-quiet', 'not-heard'], ['timeout', 'not-heard'], ['mismatch', 'not-said'], ['busy', 'not-said']] as const) {
      sayAs({ outcome: 'posted', why });
      expect(await tryIt()).toEqual({ spoken: false, why: want });
    }
    sayAs(new Error('session gone'));
    expect(await tryIt()).toEqual({ spoken: false, why: 'not-said' });
    expect(release).toHaveBeenCalled();
    expect(notAloudWhy(null)).toBe('not-said');
  });
});

it('a spoken request\'s held answer (the policy\'s holdHeldSpeech): refused under the cap, granted with a release otherwise', async () => {
  const { INTERVIEWS_MILO_POLICY } = await import('../../milo-policy.js');
  const call = { callId: 'call-money', lobby: `interviews:interview:${IV.id}` } as Parameters<NonNullable<typeof INTERVIEWS_MILO_POLICY.holdHeldSpeech>>[0];
  expect(await INTERVIEWS_MILO_POLICY.holdHeldSpeech!(call, { askedBy: 'guest:inv-1', text: 'x' })).toBeNull();
  expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({ interviewId: IV.id, part: 'speech' }));
  reserve.mockResolvedValue({ ok: true, holdId: 'hold-2', sourceId: 's', amountUsd: SPEECH_HOLD_USD });
  const granted = await INTERVIEWS_MILO_POLICY.holdHeldSpeech!(call, { askedBy: 'guest:inv-1', text: 'x' });
  await granted!.release();
  expect(release).toHaveBeenCalledWith(['hold-2']);
  expect(await INTERVIEWS_MILO_POLICY.holdHeldSpeech!({ ...call, lobby: 'work:x' }, { askedBy: 'guest:inv-1', text: 'x' })).toBeNull();
});

describe('the speech hold outlives the longest say', () => {
  it('the wait for quiet plus the longest bound stays well inside the hold\'s lifetime, so the money is held for the whole say', () => {
    expect(SAY_QUIET_WAIT_MS + SAY_MAX_BOUND_MS).toBeLessThan(SPEECH_HOLD_TTL_MS / 2);
  });
});

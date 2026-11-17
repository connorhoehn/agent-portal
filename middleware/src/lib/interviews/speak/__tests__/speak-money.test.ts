// The speech's money (lib/interviews/speak; row I3.5, decision 18's `speech` part; OWED O-222, lane H8). Money is pinned, never
// fixed: this suite says what the code does today, and the case the plan asks for and the code does not do is `it.failing`.
//
// Today: approved words are logged, posted and said with no hold at all. lib/interviews/spend.ts names a `speech` part
// (INTERVIEW_SPEND_PARTS) that nothing reserves; routes/interview-invite-milo.ts says "Nothing here can cost money: the voice is
// the listening period's own session" (the listening hold, taken when Milo is invited, is what pays for the voice). So a refused
// hold or a reached interview cap cannot stop the speech: there is no hold to refuse.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } } }));
jest.mock('../../spend.js', () => ({
  ...jest.requireActual('../../spend.js'),
  reserveInterviewSpend: jest.fn(),
  settleInterviewSpend: jest.fn(),
  releaseInterviewSpend: jest.fn(),
  meterInterviewSpend: jest.fn(),
}));
import * as spend from '../../spend.js';
import { INTERVIEW_SPEND_PARTS } from '../../spend.js';
import { MemorySaidStore, answerCandidate, sayApproved, setSpeakDeps } from '../index.js';

const IV = { id: 'iv-money', callId: 'call-money', minutes: 45, scheduledAt: null as string | null };
const NOW = Date.parse('2026-11-17T15:00:00.000Z');
let said: string[] = [];
let posted: string[] = [];
let store: MemorySaidStore;
let n = 0;
const reserve = spend.reserveInterviewSpend as jest.Mock;

beforeEach(() => {
  said = []; posted = []; n = 0; store = new MemorySaidStore();
  reserve.mockReset();
  // A refused hold, as a cap reached would answer: if the speech asked, it would be told no.
  reserve.mockResolvedValue({ ok: false, refusal: { status: 402, body: { error: 'This interview has reached its cap.' } } });
  setSpeakDeps({
    store: () => store,
    post: async (_c, text) => { posted.push(text); return true; },
    say: async (_c, text) => { said.push(text); return 'spoken'; },
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

it('today: a kit question and a candidate\'s answer are posted and said with no hold asked for, so nothing is held against the opening', async () => {
  expect((await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a rate limiter.', askedBy: 'u-hugo' })).said).toBe('spoken');
  expect((await answerCandidate(IV, 'time', 'guest:inv-1')).said).toBe('spoken');
  expect(reserve).not.toHaveBeenCalled();
  expect(posted).toHaveLength(2);
  expect(said).toHaveLength(2);
  expect((await store.list(IV.id)).map((r) => r.spoken)).toEqual([true, true]);
});

// Decision 18's `speech` part, as O-222 states it: the speech's cost is held against the opening, and a refused hold or a
// reached interview cap posts in chat and says nothing. The code takes no hold, so the words are said. A finding, not a fix.
it.failing('a refused speech hold (a reached interview cap) posts in chat and says nothing', async () => {
  const out = await sayApproved(IV, { kind: 'question', source: 'kit', text: 'Design a rate limiter.', askedBy: 'u-hugo' });
  expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ interviewId: IV.id, part: 'speech' }));
  expect(out.said).toBe('chat');
  expect(said).toEqual([]);
});

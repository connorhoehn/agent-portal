// An interview's spend (docs/interviews-tenant-plan.md decision 18, row I0.6; lib/interviews/spend.ts and the
// `interviews` branch of lib/spend-holds.ts reserveSpend): judged by the interview's cap and its opening's, under one
// lock per opening, against what both already held and spent; never by an initiative, an envelope or anyone's user
// budget. The seeded openings: op-ios caps $100 with $8 per interview; op-em $60 with the default per interview;
// op-backend $150 with the default.

jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));

import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { spendHolds } from '../../../mock/spend-holds.js';
import { spendEntries } from '../../../mock/spend-ledger.js';
import { fleetSwitches } from '../../../mock/run-controls.js';
import { setSwitch } from '../../fleet-switches.js';
import { reserveSpend } from '../../spend-holds.js';
import { interviewSpendRefusal } from '../../spend-refusal.js';
import { topUpSourceId } from '../../../providers/spend-holds.js';
import { recordSpend } from '../../../providers/spend-ledger.js';
import { userSpendThisPeriod } from '../../../providers/user-budgets.js';
import {
  DEFAULT_INTERVIEW_CAP_USD, callOfMeetingSourceId, decideInterviewHold, defaultInterviewCapUsd, interviewOfSpend, interviewSpendSourceId,
  interviewSpendState, interviewsPayer, openingMoney, parseInterviewSourceId, releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend,
} from '../spend.js';

const opening = (id: string) => interviewOpeningsFixture.rows().find((o) => o.id === id)!;
const ivHolds = () => spendHolds.rows().filter((h) => h.source === 'interviews');
const reserve = (interviewId: string, estimateUsd: number, key = `k${Math.round(estimateUsd * 1000)}-${Math.random().toString(36).slice(2, 8)}`, part: 'listening' | 'coach' | 'speech' | 'run' = 'coach') =>
  reserveInterviewSpend({ interviewId, part, key, estimateUsd, expiresInMs: 60_000 });

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  fleetSwitches.reset();
  delete process.env['INTERVIEWS_INTERVIEW_CAP_USD'];
  delete process.env['SPEND_HOLDS'];
});

describe('source ids', () => {
  it('a door id names the opening, the interview, the part and the key, and survives a top-up', () => {
    const sid = interviewSpendSourceId({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' }, 'run', 'r-1');
    expect(sid).toBe('iv:op-ios:iv-c3k8w2ma:run:r-1');
    expect(parseInterviewSourceId(topUpSourceId(sid, 2))).toEqual({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma', part: 'run', key: 'r-1' });
    expect(parseInterviewSourceId('iv:op-ios:iv-c3k8w2ma:lunch:r-1')).toBeNull();
    expect(() => interviewSpendSourceId({ openingId: 'op-ios', interviewId: 'iv:x' }, 'run', 'r')).toThrow();
  });

  it('every meeting-assistant id names its call', () => {
    for (const sid of ['ma:call-7', 'ma:call-7:x2', 'ma:call-7:tokens', 'ma:call-7:x1:tokens', 'ma:call-7:minutes', 'ma:call-7:minutes:1:2', 'ma:call-7:watch:3', 'ma:call-7#topup-1']) {
      expect(callOfMeetingSourceId(sid)).toBe('call-7');
    }
    expect(callOfMeetingSourceId('learning:run-1')).toBeNull();
  });

  it('the cap per interview defaults to a documented figure and follows the setting', () => {
    expect(defaultInterviewCapUsd({})).toBe(DEFAULT_INTERVIEW_CAP_USD);
    expect(defaultInterviewCapUsd({ INTERVIEWS_INTERVIEW_CAP_USD: '4.5' })).toBe(4.5);
    expect(defaultInterviewCapUsd({ INTERVIEWS_INTERVIEW_CAP_USD: 'lots' })).toBe(DEFAULT_INTERVIEW_CAP_USD);
  });
});

describe('the decision', () => {
  const state = (o: Partial<Parameters<typeof decideInterviewHold>[0]> = {}) => ({
    openingCapUsd: 20, interviewCapUsd: 5, opening: { spentUsd: 0, heldUsd: 0 }, interview: { spentUsd: 0, heldUsd: 0 }, ...o,
  });
  it('under and exactly at either cap proceeds; a cent over refuses, the interview\'s cap first', () => {
    expect(decideInterviewHold(state(), 4.99)).toEqual({ kind: 'proceed' });
    expect(decideInterviewHold(state({ interview: { spentUsd: 3, heldUsd: 1 } }), 1)).toEqual({ kind: 'proceed' });
    expect(decideInterviewHold(state({ interview: { spentUsd: 3, heldUsd: 1 } }), 1.01))
      .toEqual({ kind: 'capped', gate: 'interview-cap', capUsd: 5, spentUsd: 3, heldUsd: 1 });
    expect(decideInterviewHold(state({ opening: { spentUsd: 17, heldUsd: 2 } }), 1)).toEqual({ kind: 'proceed' });
    expect(decideInterviewHold(state({ opening: { spentUsd: 17, heldUsd: 2 } }), 1.5))
      .toEqual({ kind: 'capped', gate: 'opening-cap', capUsd: 20, spentUsd: 17, heldUsd: 2 });
  });
  it('no cap on the opening refuses everything, even nothing', () => {
    expect(decideInterviewHold(state({ openingCapUsd: null }), 0)).toEqual({ kind: 'no-cap' });
  });
});

describe('holding against the opening', () => {
  it('holds on no initiative and no person, keyed to the opening and the interview', async () => {
    const r = await reserve('iv-c3k8w2ma', 2, 'c-1');
    expect(r).toEqual({ ok: true, holdId: expect.any(String), sourceId: 'iv:op-ios:iv-c3k8w2ma:coach:c-1', amountUsd: 2 });
    expect(ivHolds()).toEqual([expect.objectContaining({ initiativeId: null, actorId: null, grantId: null, sourceId: 'iv:op-ios:iv-c3k8w2ma:coach:c-1', status: 'held' })]);
    expect(await interviewSpendState({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' }))
      .toEqual({ openingCapUsd: 100, interviewCapUsd: 8, opening: { spentUsd: 0, heldUsd: 2 }, interview: { spentUsd: 0, heldUsd: 2 } });
  });

  it('the interview\'s cap: at it passes, past it refuses in plain words', async () => {
    expect((await reserve('iv-c3k8w2ma', 5)).ok).toBe(true);
    expect((await reserve('iv-c3k8w2ma', 3)).ok).toBe(true);
    const over = await reserve('iv-c3k8w2ma', 0.5);
    expect(over).toEqual({ ok: false, refusal: { status: 403, body: expect.objectContaining({ gate: 'interview-cap', capUsd: 8, spentUsd: 0, heldUsd: 8, amountUsd: 0.5 }) } });
    expect(!over.ok && over.refusal.body['error']).toBe(
      "This interview has reached its spending cap of $8.00: $8.00 is already spent or set aside, so nothing is left, and this needs about $0.50. Nothing was started. The recruiter can raise the cap per interview on the opening's page.",
    );
    // Another interview on the same opening still has its own room.
    expect((await reserve('iv-p2v7j4ye', 8)).ok).toBe(true);
  });

  it('the opening\'s cap counts every interview on it, held and spent', async () => {
    opening('op-em').budgetCapUsd = 15;
    expect((await reserve('iv-m8t3h6ng', 9)).ok).toBe(true);
    await recordSpend({ source: 'interviews', sourceId: 'iv:op-em:iv-g9r1y8lp:listening:l-1', initiativeId: null, boxId: null, actorId: 'u-wen', model: 'm', costUsd: 4, costBasis: 'reported' });
    const over = await reserve('iv-n5z9f2cq', 3);
    expect(!over.ok && over.refusal.body).toEqual(expect.objectContaining({ gate: 'opening-cap', capUsd: 15, spentUsd: 4, heldUsd: 9, amountUsd: 3 }));
    expect(!over.ok && over.refusal.body['error']).toContain('This opening has reached its spending cap of $15.00: $13.00 is already spent or set aside across its interviews, so $2.00 is left');
    expect((await reserve('iv-n5z9f2cq', 2)).ok).toBe(true);
    // Another opening's money is untouched.
    expect((await reserve('iv-k1p5w8ra', 9)).ok).toBe(true);
  });

  it('two holds racing at the cap: exactly one passes', async () => {
    const both = await Promise.all([reserve('iv-c3k8w2ma', 5, 'a'), reserve('iv-c3k8w2ma', 5, 'b')]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, refusal: expect.objectContaining({ body: expect.objectContaining({ gate: 'interview-cap' }) }) });
    expect(ivHolds()).toHaveLength(1);
  });

  it('two holds racing at the opening\'s cap from different interviews: exactly one passes', async () => {
    opening('op-em').budgetCapUsd = 10;
    const both = await Promise.all([reserve('iv-m8t3h6ng', 6, 'a'), reserve('iv-n5z9f2cq', 6, 'b')]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, refusal: expect.objectContaining({ body: expect.objectContaining({ gate: 'opening-cap' }) }) });
  });

  it('an opening with no cap spends nothing, and the words tell the recruiter to set one', async () => {
    opening('op-ios').budgetCapUsd = null;
    const r = await reserve('iv-c3k8w2ma', 0.01);
    expect(r).toEqual({ ok: false, refusal: { status: 403, body: expect.objectContaining({ gate: 'spend-hold' }) } });
    expect(!r.ok && r.refusal.body['error']).toBe("This opening has no spending cap yet, so nothing that costs money can start in its interviews. The recruiter can set one on the opening's page.");
    expect(ivHolds()).toHaveLength(0);
  });

  it('the opening\'s own cap per interview wins over the default; null takes the default', async () => {
    process.env['INTERVIEWS_INTERVIEW_CAP_USD'] = '3';
    expect((await reserve('iv-m8t3h6ng', 3.01)).ok).toBe(false);
    opening('op-em').interviewCapUsd = 4;
    expect((await reserve('iv-m8t3h6ng', 3.01)).ok).toBe(true);
  });

  it('an interview nobody knows is refused without saying which', async () => {
    const r = await reserve('iv-nobody', 1);
    expect(!r.ok && r.refusal.body['error']).toBe('This spend is not tied to an interview, so nothing was started.');
    expect((await reserveSpend({ initiativeId: null, actorId: null, source: 'interviews', sourceId: 'iv:op-ios:iv-m8t3h6ng:coach:x', forecast: { costUsdP75: 1, costUsdP25: 0.25, confidence: 'prior' }, expiresInMs: 1000 })).kind).toBe('refused');
  });

  it('a kill switch stops it like every run', async () => {
    await setSwitch('fleet', true, 'test', 'u-ops');
    const r = await reserve('iv-c3k8w2ma', 1);
    expect(!r.ok && r.refusal.status).toBe(423);
    await setSwitch('fleet', false, null, 'u-ops');
  });

  it('never counts against the person who caused it, or any initiative', async () => {
    await recordSpend({ source: 'interviews', sourceId: 'iv:op-ios:iv-c3k8w2ma:coach:c-9', initiativeId: null, boxId: null, actorId: 'u-wen', model: 'm', costUsd: 3, costBasis: 'reported' });
    expect((await userSpendThisPeriod('u-wen')).spentUsd).toBe(0);
    expect(spendHolds.rows().every((h) => h.actorId === null)).toBe(true);
  });
});

describe('settling, topping up and giving back', () => {
  it('a known cost settles the hold and becomes spent', async () => {
    const r = await reserve('iv-c3k8w2ma', 2, 'c-1');
    if (!r.ok) throw new Error('not held');
    await settleInterviewSpend({ sourceId: r.sourceId, costUsd: 1.25, basis: 'reported', model: 'nova', actorId: 'u-wen', provider: 'bedrock' });
    expect(ivHolds()[0]!.status).toBe('settled');
    expect(spendEntries.rows().filter((e) => e.source === 'interviews')).toEqual([expect.objectContaining({ source: 'interviews', sourceId: r.sourceId, initiativeId: null, costUsd: 1.25, trigger: 'interviews:coach' })]);
    expect((await interviewSpendState({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' })).interview).toEqual({ spentUsd: 1.25, heldUsd: 0 });
  });

  it('an unknown cost leaves the hold standing until it expires', async () => {
    const r = await reserve('iv-c3k8w2ma', 2, 'c-2');
    if (!r.ok) throw new Error('not held');
    await settleInterviewSpend({ sourceId: r.sourceId, costUsd: null, basis: 'unknown', model: null });
    expect(ivHolds()[0]!.status).toBe('held');
    expect((await openingMoney(opening('op-ios')))).toMatchObject({ spentUsd: 0, heldUsd: 2, unknownCount: 1 });
  });

  it('a top-up is judged by the same caps, and the attempt\'s ledger row settles it with its parent', async () => {
    const r = await reserve('iv-c3k8w2ma', 5, 'run-1', 'run');
    if (!r.ok) throw new Error('not held');
    const topUp = (n: number, usd: number) => reserveSpend({
      initiativeId: null, actorId: null, source: 'interviews', sourceId: topUpSourceId(r.sourceId, n),
      forecast: { costUsdP75: usd, costUsdP25: usd / 4, confidence: 'prior' }, expiresInMs: 60_000, basis: 'topup',
    });
    expect(await topUp(1, 3)).toMatchObject({ kind: 'held', amountUsd: 3 });
    // The interview's $8 is used up: the next top-up is the cut-off.
    expect(await topUp(2, 1)).toMatchObject({ kind: 'capped', gate: 'interview-cap' });
    await settleInterviewSpend({ sourceId: r.sourceId, costUsd: 7.5, basis: 'estimated', model: 'runner' });
    expect(ivHolds().map((h) => h.status)).toEqual(['settled', 'settled']);
    expect(await openingMoney(opening('op-ios'))).toMatchObject({ capUsd: 100, spentUsd: 7.5, heldUsd: 0, leftUsd: 92.5 });
  });

  it('an attempt that never started gives its money back', async () => {
    const r = await reserve('iv-c3k8w2ma', 8);
    if (!r.ok) throw new Error('not held');
    await releaseInterviewSpend([r.holdId]);
    expect((await reserve('iv-c3k8w2ma', 8)).ok).toBe(true);
  });
});

describe('the meeting assistant\'s ids, when an interview call\'s policy names this source', () => {
  it('a call is tied to its interview by the interview\'s call', async () => {
    interviewsFixture.rows().find((i) => i.id === 'iv-c3k8w2ma')!.callId = 'call-aiko';
    expect(await interviewOfSpend('ma:call-aiko:x1')).toEqual({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' });
    const held = await reserveSpend({
      initiativeId: interviewsPayer({ inviterId: 'u-wen' }).initiativeId, actorId: 'u-wen', source: interviewsPayer({ inviterId: 'u-wen' }).source,
      sourceId: 'ma:call-aiko', forecast: { costUsdP75: 9, costUsdP25: 2, confidence: 'prior' }, expiresInMs: 60_000,
    });
    // $9 of listening is more than the iOS opening allows per interview.
    expect(held).toMatchObject({ kind: 'capped', gate: 'interview-cap', capUsd: 8 });
    expect(await interviewOfSpend('ma:call-elsewhere')).toBeNull();
  });

  it('the payer: the opening pays under this source, on no initiative', () => {
    expect(interviewsPayer({ inviterId: 'u-wen' })).toEqual({ actorId: 'u-wen', initiativeId: null, source: 'interviews' });
  });
});

describe('the refusal\'s sentences', () => {
  it('say which cap, what is left and what to do, with no ids and nobody blamed', () => {
    const lines = [
      interviewSpendRefusal({ kind: 'interview-cap', capUsd: 10, spentUsd: 6.5, heldUsd: 3, amountUsd: 1.5 }),
      interviewSpendRefusal({ kind: 'opening-cap', capUsd: 120, spentUsd: 100, heldUsd: 0, amountUsd: 30 }),
      interviewSpendRefusal({ kind: 'no-cap' }),
    ];
    expect(lines[0]).toBe("This interview has reached its spending cap of $10.00: $9.50 is already spent or set aside, so $0.50 is left, and this needs about $1.50. Nothing was started. The recruiter can raise the cap per interview on the opening's page.");
    expect(lines[1]).toBe("This opening has reached its spending cap of $120.00: $100.00 is already spent or set aside across its interviews, so $20.00 is left, and this needs about $30.00. Nothing was started. The recruiter can raise the opening's cap on its page.");
    for (const l of lines) expect(l).not.toMatch(/iv-|op-|INTERVIEWS_|_usd|\byou\b/i);
    expect(interviewSpendRefusal({ kind: 'interview-cap', capUsd: 1, spentUsd: 0.999, heldUsd: 0, amountUsd: 0.002 })).toContain('so nothing is left, and this needs less than a cent.');
  });
});

describe('the opening\'s figures', () => {
  it('cap, held, spent and left; left is null with no cap', async () => {
    await reserve('iv-c3k8w2ma', 2);
    expect(await openingMoney(opening('op-ios'))).toEqual({
      capUsd: 100, interviewCapUsd: 8, defaultInterviewCapUsd: DEFAULT_INTERVIEW_CAP_USD, effectiveInterviewCapUsd: 8,
      spentUsd: 0, heldUsd: 2, leftUsd: 98, unknownCount: 0,
    });
    opening('op-ios').budgetCapUsd = null;
    expect((await openingMoney(opening('op-ios'))).leftUsd).toBeNull();
    expect(await openingMoney(opening('op-em'))).toMatchObject({ interviewCapUsd: null, effectiveInterviewCapUsd: DEFAULT_INTERVIEW_CAP_USD, heldUsd: 0 });
  });
});

// Hardening (H1, O-006): a meeting-assistant id is tied to its interview through the live call's lobby and, separately,
// through the lobby Milo's stored record kept. The two paths are told apart by what each one is given.
describe('a call that is tied to its interview only through a lobby', () => {
  const callChat = jest.requireActual<typeof import('../../call-chat.js')>('../../call-chat.js');
  const storeSelect = jest.requireActual<typeof import('../../meeting-assistant/store-select.js')>('../../meeting-assistant/store-select.js');
  afterEach(() => jest.restoreAllMocks());

  it('through the live call: the runtime names the lobby and the stored record is never asked', async () => {
    const lobbyOf = jest.fn(async (callId: string) => (callId === 'call-live' ? 'interviews:interview:iv-c3k8w2ma' : null));
    jest.spyOn(callChat, 'callChatRuntime').mockReturnValue({ lobbyOf } as never);
    const stored = jest.spyOn(storeSelect, 'assistantStore');
    expect(await interviewOfSpend('ma:call-live:x1')).toEqual({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' });
    expect(lobbyOf).toHaveBeenCalledWith('call-live');
    expect(stored).not.toHaveBeenCalled();
  });

  it('through the stored record: the live call is gone (no runtime) and the record\'s lobby decides', async () => {
    jest.spyOn(callChat, 'callChatRuntime').mockImplementation(() => { throw new Error('no runtime'); });
    jest.spyOn(storeSelect, 'assistantStore').mockReturnValue({ get: async (id: string) => (id === 'call-ended' ? { lobby: 'interviews:interview:iv-c3k8w2ma' } : null) } as never);
    expect(await interviewOfSpend('ma:call-ended:minutes')).toEqual({ openingId: 'op-ios', interviewId: 'iv-c3k8w2ma' });
    expect(await interviewOfSpend('ma:call-unknown')).toBeNull();
  });

  it('a lobby that is not an interview\'s ties the call to nothing, by either path', async () => {
    jest.spyOn(callChat, 'callChatRuntime').mockReturnValue({ lobbyOf: async () => 'work:huddle:abc' } as never);
    expect(await interviewOfSpend('ma:call-work')).toBeNull();
    jest.spyOn(callChat, 'callChatRuntime').mockImplementation(() => { throw new Error('no runtime'); });
    jest.spyOn(storeSelect, 'assistantStore').mockReturnValue({ get: async () => ({ lobby: 'work:huddle:abc' }) } as never);
    expect(await interviewOfSpend('ma:call-work')).toBeNull();
  });
});

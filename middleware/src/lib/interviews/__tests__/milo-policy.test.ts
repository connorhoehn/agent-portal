// Milo's policy for an interview call (lib/interviews/milo-policy.ts, row I3.2), one method at a time, from each seat that matters:
// the lead, a panel member, the recruiter, the opening's hiring manager, another opening's hiring manager, a Work user and the
// candidate's guest id. The seeded round iv-n5z9f2cq (op-em): lead u-wen, panel u-hugo, recruiter u-greta, hiring manager
// u-amara. The test makes u-otto hiring manager of op-backend, which is another opening.

jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));

import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { interviewConsentsFixture } from '../../../mock/interviews-consents.js';
import { spendHolds } from '../../../mock/spend-holds.js';
import { spendEntries } from '../../../mock/spend-ledger.js';
import { userSpendThisPeriod } from '../../../providers/user-budgets.js';
import { DEFAULT_POLICY, limitsOfCall, minutesWordingOf, payerFields, policyForLobby, policyFamilies, type PolicyCall } from '../../meeting-assistant/policy.js';
import { realSpend, sourceIdFor } from '../../meeting-assistant/spend.js';
import type { AssistantRecord, MinutesRecord } from '../../meeting-assistant/types.js';
import { MemoryInviteStore, setInviteStore } from '../invite/store.js';
import {
  CANNOT_LISTEN_PAST_ROUND, INTERVIEW_FAMILY, INTERVIEWS_MILO_POLICY as P, LEAD_ONLY, MILO_OFF_NOT_ANSWERED, MILO_OFF_NO_TRANSCRIPT, registerInterviewsMiloPolicy, setInterviewConsentSource, unregisterInterviewsMiloPolicy,
} from '../milo-policy.js';
import { interviewSpendState } from '../spend.js';

const IV = 'iv-n5z9f2cq';
const LOBBY = `interviews:interview:${IV}`;
const CALL: PolicyCall = { callId: 'call-nadia', lobby: LOBBY, tenant: 'interviews' };
const LEAD = 'u-wen'; const PANEL = 'u-hugo'; const RECRUITER = 'u-greta'; const HM = 'u-amara'; const OTHER_HM = 'u-otto'; const WORK = 'u-alice';

/** Everyone the tests ask about, with their tenant and role. */
const PEOPLE = {
  lead: { userId: LEAD, tenant: 'interviews', role: 'interviewer' },
  panel: { userId: PANEL, tenant: 'interviews', role: 'interviewer' },
  recruiter: { userId: RECRUITER, tenant: 'interviews', role: 'recruiter' },
  hiringManager: { userId: HM, tenant: 'interviews', role: 'hiring-manager' },
  otherHiringManager: { userId: OTHER_HM, tenant: 'interviews', role: 'hiring-manager' },
  work: { userId: WORK, tenant: 'orgiq', role: 'member' },
  guest: { userId: 'guest:inv-1', tenant: 'interviews', role: 'interview-guest' },
} as const;

const record = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: CALL.callId, tenant: 'interviews', lobby: LOBBY, initiativeId: null, invitedBy: LEAD, attendees: [LEAD, PANEL, 'guest:inv-1'], acked: [],
  ...over,
} as unknown as AssistantRecord);

let guestId: string;

beforeEach(async () => {
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  // Count from nothing: take out the seed's settled spend for the finished rounds (mock/interviews-money.ts).
  { const rows = spendEntries.rows(); for (let k = rows.length - 1; k >= 0; k -= 1) if (rows[k]!.source === 'interviews') rows.splice(k, 1); }
  interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!.hiringManagerId = OTHER_HM;
  setInviteStore(new MemoryInviteStore());
  const { inviteStore } = await import('../invite/store.js');
  const inv = await inviteStore().issueInvite({ interviewId: IV, tokenHash: 'a'.repeat(64), issuedBy: RECRUITER, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  guestId = `guest:${inv.id}`;
  setInterviewConsentSource(null);
});

afterAll(() => { setInviteStore(null); setInterviewConsentSource(null); unregisterInterviewsMiloPolicy(); });

describe('registration', () => {
  it('is for the interview family alone, once, and only while the tenant is on', () => {
    expect(registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'false' })).toBe(false);
    expect(policyFamilies()).toEqual([]);
    expect(registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' })).toBe(true);
    expect(registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' })).toBe(true); // idempotent: a second call does not throw
    expect(policyFamilies()).toEqual([INTERVIEW_FAMILY]);
    expect(policyForLobby(LOBBY)).toBe(P);
    expect(policyForLobby('orgiq:initiative:p-auth')).toBe(DEFAULT_POLICY);
    expect(policyForLobby('interviews:pad:iv-1')).toBe(DEFAULT_POLICY);
  });
});

describe('the notices\' wording: notes for the panel only (E4 #33)', () => {
  it('an interview call says the notes are the panel\'s only; any other call keeps the meeting\'s words', async () => {
    const { noticeText } = await import('../../meeting-assistant/chat.js');
    expect(noticeText.joined('Hugo Marchetti', 30, 75, minutesWordingOf(LOBBY))).toContain('Milo writes notes for the interview panel only and leaves after 75 minutes.');
    expect(noticeText.rejoined('Hugo Marchetti', 30, 10, minutesWordingOf(LOBBY))).toContain('Milo adds what it hears to the notes for the interview panel only and leaves');
    expect(noticeText.joined('Vera', 30, 60, minutesWordingOf('orgiq:initiative:p-auth'))).toContain('Milo writes minutes for the people in the call');
  });
});

describe('inviteRefusal: the lead only (decision 20)', () => {
  const ALL_YES = { recording: true, transcription: true, milo: true };
  it('lets the lead in and refuses everyone else with one plain sentence', async () => {
    setInterviewConsentSource(async () => ALL_YES);
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBeNull();
    for (const who of ['panel', 'recruiter', 'hiringManager', 'otherHiringManager', 'work', 'guest'] as const) {
      expect([who, await P.inviteRefusal(PEOPLE[who], CALL)]).toEqual([who, LEAD_ONLY]);
    }
    expect(LEAD_ONLY).not.toMatch(/iv-|u-|interviews:|\bpolicy\b/);
  });

  it('refuses the lead of another interview, a Work session holding the lead\'s id, and a call with no interview in its lobby', async () => {
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: 'interviews:interview:iv-k1p5w8ra' })).toBe(LEAD_ONLY); // u-hugo leads it
    expect(await P.inviteRefusal({ ...PEOPLE.lead, tenant: 'orgiq' }, CALL)).toBe(LEAD_ONLY);
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: 'interviews:interview:iv-nope' })).toBe(LEAD_ONLY);
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: null })).toBe(LEAD_ONLY);
  });
});

describe('inviteRefusal: the candidate\'s answers (row I2.5)', () => {
  const yn = [true, false] as const;
  const combos = yn.flatMap((recording) => yn.flatMap((transcription) => yn.map((milo) => ({ recording, transcription, milo }))));

  it.each(combos)('the lead with %j: invited exactly when the transcript was accepted', async (a) => {
    const asked: string[] = [];
    setInterviewConsentSource(async (iv) => { asked.push(iv); return a; });
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBe(a.transcription ? null : MILO_OFF_NO_TRANSCRIPT);
    expect(asked).toEqual([IV]);
  });

  it('with nothing answered or a failing source, the lead is refused: nothing runs before consent', async () => {
    setInterviewConsentSource(async () => null);
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBe(MILO_OFF_NOT_ANSWERED);
    setInterviewConsentSource(null); // no source: the stored answers, and the seed has none for this round
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBe(MILO_OFF_NOT_ANSWERED);
    setInterviewConsentSource(async () => { throw new Error('down'); });
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBe(MILO_OFF_NOT_ANSWERED);
  });

  it('with no source set, the stored answers decide', async () => {
    const now = new Date().toISOString();
    const row = (transcription: boolean) => ({ interviewId: IV, noticeVersion: 'v', recording: false, recordingAt: now, transcription, transcriptionAt: now,
      milo: false, miloAt: now, answeredAt: now, changedAt: now, history: [], revision: 1 });
    interviewConsentsFixture.rows().push(row(true));
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBeNull();
    interviewConsentsFixture.rows().splice(-1, 1, row(false));
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBe(MILO_OFF_NO_TRANSCRIPT);
  });

  it('someone who is not the lead still gets the lead sentence, never the candidate\'s answer', async () => {
    setInterviewConsentSource(async () => ({ recording: true, transcription: false, milo: false }));
    for (const who of ['panel', 'recruiter', 'hiringManager', 'guest'] as const) expect(await P.inviteRefusal(PEOPLE[who], CALL)).toBe(LEAD_ONLY);
  });

  it('the sentences are plain: no ids, no setting names', () => {
    for (const s of [MILO_OFF_NO_TRANSCRIPT, MILO_OFF_NOT_ANSWERED]) expect(s).not.toMatch(/iv-|u-|interviews:|consent|policy|transcription/);
  });
});

describe('reads: the panel side only (decision 4)', () => {
  const ALL = { record: true, transcript: true, minutes: true };
  const NONE = { record: false, transcript: false, minutes: false };
  it('the lead, the panel, the recruiter and this opening\'s hiring manager read everything; nobody else reads anything', async () => {
    const r = record();
    const answers: Record<string, unknown> = {};
    for (const [who, p] of Object.entries(PEOPLE)) answers[who] = await P.reads({ ...p, seated: false }, r);
    expect(answers).toEqual({ lead: ALL, panel: ALL, recruiter: ALL, hiringManager: ALL, otherHiringManager: NONE, work: NONE, guest: NONE });
  });

  it('a seat gives nothing by itself: a seated guest, a seated Work user and a seated stranger read nothing', async () => {
    const r = record({ attendees: [LEAD, guestId, WORK] });
    expect(await P.reads({ userId: guestId, tenant: 'interviews', seated: true }, r)).toEqual(NONE);
    expect(await P.reads({ ...PEOPLE.work, seated: true }, r)).toEqual(NONE);
    expect(await P.reads({ ...PEOPLE.otherHiringManager, seated: true }, r)).toEqual(NONE);
  });

  it('without a role, as the admin, or on a record in another tenant, nothing', async () => {
    expect(await P.reads({ userId: LEAD, tenant: 'interviews', seated: true }, record())).toEqual(NONE);
    expect(await P.reads({ userId: 'u-root', tenant: 'interviews', role: 'admin', seated: false }, record())).toEqual(NONE);
    expect(await P.reads({ ...PEOPLE.lead, seated: false }, record({ tenant: 'orgiq' }))).toEqual(NONE);
  });
});

describe('payer: the opening pays (decision 18, row I0.6)', () => {
  it('names the interviews source on no initiative, for every inviter', () => {
    for (const p of Object.values(PEOPLE)) expect(P.payer(CALL, { inviterId: p.userId, initiativeId: 'p-auth' })).toEqual({ actorId: p.userId, initiativeId: null, source: 'interviews' });
  });

  it('one listening period from reserve to settle lands on the opening, within the cap per interview, and on nobody\'s budget', async () => {
    const unregister = registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' });
    expect(unregister).toBe(true);
    interviewsFixture.rows().find((i) => i.id === IV)!.callId = CALL.callId;
    const rec = record();
    const payer = payerFields(rec);
    expect(payer).toEqual({ inviterId: LEAD, initiativeId: null, source: 'interviews' });
    // The invite's hold, as POST /invite takes it: ten minutes of listening.
    const held = await realSpend.reserve({ callId: CALL.callId, tenant: 'interviews', seconds: 600, part: 0, ...payer });
    expect(held.ok).toBe(true);
    const hold = spendHolds.rows().find((h) => h.sourceId === sourceIdFor(CALL.callId));
    expect(hold).toMatchObject({ source: 'interviews', actorId: null, initiativeId: null });
    const ref = { openingId: 'op-em', interviewId: IV };
    const during = await interviewSpendState(ref);
    expect(during.interview.heldUsd).toBeGreaterThan(0);
    expect(during.opening.heldUsd).toBe(during.interview.heldUsd);
    // The settlement books the period under the same id, which settles the hold.
    await realSpend.settle({ record: rec, usageSeconds: 0, tokens: { input: 0, output: 0, cached: 0 }, sessionKind: 'scripted', listeningSeconds: 300 });
    const row = spendEntries.rows().find((e) => e.sourceId === sourceIdFor(CALL.callId));
    expect(row).toMatchObject({ source: 'interviews', initiativeId: null });
    const after = await interviewSpendState(ref);
    expect(after.interview.heldUsd).toBe(0);
    expect(after.interview.spentUsd).toBeGreaterThan(0);
    expect(after.opening.spentUsd).toBe(after.interview.spentUsd);
    expect((await userSpendThisPeriod(LEAD)).spentUsd).toBe(0);
  });

  it('a hold over the cap per interview is refused before anything starts', async () => {
    registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' });
    interviewsFixture.rows().find((i) => i.id === IV)!.callId = CALL.callId;
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!.interviewCapUsd = 0.01;
    const held = await realSpend.reserve({ callId: CALL.callId, tenant: 'interviews', seconds: 3600, part: 0, ...payerFields(record()) });
    expect(held.ok).toBe(false);
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toEqual([]);
  });
});

describe('tools: none, for anyone', () => {
  it('offers the live session no tools and lets nobody run one', () => {
    expect(P.sessionTools(CALL).tools).toEqual([]);
    for (const p of Object.values(PEOPLE)) for (const tool of ['create_work_item', 'search', 'navigate', 'anything']) expect(P.mayUseTool(CALL, { userId: p.userId, roles: [p.role] }, tool)).toBe(false);
  });
});

describe('acknowledgement: the panel in the call, the candidate in the portal', () => {
  it('the panel side acknowledges with the notice in the call; a guest elsewhere', () => {
    for (const who of ['lead', 'panel', 'recruiter', 'hiringManager'] as const) expect(P.acknowledgement(CALL, PEOPLE[who].userId)).toBe('in-call-notice');
    expect(P.acknowledgement(CALL, guestId)).toBe('elsewhere');
  });

  it('with no consent source (the default) nobody has acknowledged, so nothing the candidate says is stored or heard', async () => {
    expect(await P.acknowledgedElsewhere!(CALL, [guestId, LEAD])).toEqual([]);
  });

  it('a guest counts when the transcript was accepted (Milo or not), for this interview, by its own invite', async () => {
    const asked: string[] = [];
    let answer: { transcription: boolean; milo: boolean } | null = null;
    setInterviewConsentSource(async (iv) => { asked.push(iv); return answer; });
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]); // not answered yet
    answer = { transcription: true, milo: false };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([guestId]); // transcribed; Milo's models skip them (below)
    answer = { transcription: false, milo: true };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]);
    answer = { transcription: true, milo: true };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId, LEAD, 'guest:inv-unknown'])).toEqual([guestId]); // staff and strangers never count
    expect(asked.every((iv) => iv === IV)).toBe(true);
    // Another interview's call: this guest's invite is not for it.
    expect(await P.acknowledgedElsewhere!({ ...CALL, lobby: 'interviews:interview:iv-k1p5w8ra' }, [guestId])).toEqual([]);
  });

  it('a consent source that fails counts as no answer', async () => {
    setInterviewConsentSource(async () => { throw new Error('down'); });
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]);
  });
});

describe('modelReadsSpeaker: Milo uses the candidate\'s lines only when Milo was accepted', () => {
  const line = (userId: string | null, speakers?: string[]) => ({ userId, ...(speakers ? { speakers } : {}) });
  const REC = { callId: CALL.callId, lobby: LOBBY, tenant: 'interviews' };
  beforeAll(() => registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' }));

  it('both accepted: every line, the candidate\'s included', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: true }));
    const may = await P.modelReadsSpeaker!(CALL);
    expect([may(LEAD), may(guestId), may(null)]).toEqual([true, true, true]);
    const { linesForModels } = await import('../../meeting-assistant/policy.js');
    expect(await linesForModels(REC, [line(LEAD), line(guestId)])).toHaveLength(2);
  });

  it('the transcript accepted, Milo declined: the panel\'s lines only; a line the candidate shares or nobody owns is left out', async () => {
    setInterviewConsentSource(async () => ({ transcription: true, milo: false }));
    const may = await P.modelReadsSpeaker!(CALL);
    expect([may(LEAD), may(guestId), may(null)]).toEqual([true, false, false]);
    const { linesForModels } = await import('../../meeting-assistant/policy.js');
    expect(await linesForModels(REC, [line(LEAD), line(guestId), line(LEAD, [LEAD, guestId]), line(null)])).toEqual([line(LEAD)]);
  });

  it('answers that cannot be read count as Milo declined', async () => {
    setInterviewConsentSource(async () => { throw new Error('down'); });
    expect((await P.modelReadsSpeaker!(CALL))(guestId)).toBe(false);
  });

  it('Work\'s calls (the default policy) are untouched: every line', async () => {
    const { linesForModels } = await import('../../meeting-assistant/policy.js');
    expect(DEFAULT_POLICY.modelReadsSpeaker).toBeUndefined();
    expect(await linesForModels({ ...REC, lobby: 'initiative:x', tenant: 'orgiq' }, [line('u-a'), line('guest:x'), line(null)])).toHaveLength(3);
  });
});

describe('rings and listsMeeting: the panel side, never a guest', () => {
  it('rings and lists for staff, never for a guest', () => {
    const minutes = { callId: CALL.callId, lobby: LOBBY, tenant: 'interviews' } as unknown as MinutesRecord;
    for (const who of ['lead', 'panel', 'recruiter', 'hiringManager'] as const) {
      expect(P.rings(CALL, PEOPLE[who].userId)).toBe(true);
      expect(P.listsMeeting(minutes, PEOPLE[who].userId)).toBe(true);
    }
    expect(P.rings(CALL, guestId)).toBe(false);
    expect(P.listsMeeting(minutes, guestId)).toBe(false);
  });
});

describe('relaysLiveSpeech and fixed requests', () => {
  it('relays nothing the live model says (decision 9); the fixed requests are answered from held text (row I3.8, speak.test.ts)', () => {
    expect(P.relaysLiveSpeech(CALL)).toBe(false);
    expect(typeof P.answerFromHeldText).toBe('function');
  });
});

describe('how Milo\'s chat names the candidate, and the fixed refusal', () => {
  it('names this interview\'s guest by the candidate\'s name on the record; a stranger guest is "Candidate"; staff are left to the directory', async () => {
    const name = await P.displayName!(CALL, guestId);
    expect(name).toBeTruthy();
    expect(name).not.toMatch(/^guest:/);
    expect(name).not.toBe('Candidate');
    expect(await P.displayName!(CALL, 'guest:inv-unknown')).toBe('Candidate');
    expect(await P.displayName!(CALL, LEAD)).toBeNull();
  });

  it('declares its one fixed refusal, so a request heard again is refused once until Milo answers something else', async () => {
    const { MILO_CAN_DO } = await import('../speak/index.js');
    expect(P.heldRefusal).toBe(MILO_CAN_DO);
  });
});

describe('listeningLimitMinutes: the round plus 15, no extension past it', () => {
  beforeEach(() => { registerInterviewsMiloPolicy({ INTERVIEWS_ENABLED: 'true' }); });

  it('is the interview\'s minutes plus 15, as both the first ceiling and the most', async () => {
    const minutes = interviewsFixture.rows().find((i) => i.id === IV)!.minutes;
    expect(await P.listeningLimitMinutes!(CALL)).toBe(minutes + 15);
    const limits = await limitsOfCall(CALL);
    expect(limits.maxSeconds).toBe((minutes + 15) * 60);
    expect(limits.hardMaxSeconds).toBe((minutes + 15) * 60);
  });

  it('is 60 + 15 when the interview cannot be read', async () => {
    expect(await P.listeningLimitMinutes!({ ...CALL, lobby: 'interviews:interview:iv-nope' })).toBe(75);
    expect(await P.listeningLimitMinutes!({ ...CALL, lobby: null })).toBe(75);
  });

  it('leaves a Work call on the assistant\'s own limits', async () => {
    const work = await limitsOfCall({ callId: 'c', lobby: 'orgiq:initiative:p-auth', tenant: 'orgiq' });
    expect(work.hardMaxSeconds).toBe(180 * 60);
    expect(work.maxSeconds).toBe(60 * 60);
  });

  it('refuses more time with one plain sentence', () => {
    expect(CANNOT_LISTEN_PAST_ROUND).toBe("Milo can't listen past the end of this round.");
  });
});

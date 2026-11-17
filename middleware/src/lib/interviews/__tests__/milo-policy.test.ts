// Milo's policy for an interview call (lib/interviews/milo-policy.ts, row I3.2), one method at a time, from each seat that matters:
// the lead, a panel member, the recruiter, the opening's hiring manager, another opening's hiring manager, a Work user and the
// candidate's guest id. The seeded round iv-nadia-leadership (op-em): lead u-wen, panel u-hugo, recruiter u-greta, hiring manager
// u-amara. The test makes u-otto hiring manager of op-backend, which is another opening.

jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));

import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { spendHolds } from '../../../mock/spend-holds.js';
import { spendEntries } from '../../../mock/spend-ledger.js';
import { userSpendThisPeriod } from '../../../providers/user-budgets.js';
import { DEFAULT_POLICY, payerFields, policyForLobby, policyFamilies, type PolicyCall } from '../../meeting-assistant/policy.js';
import { realSpend, sourceIdFor } from '../../meeting-assistant/spend.js';
import type { AssistantRecord, MinutesRecord } from '../../meeting-assistant/types.js';
import { MemoryInviteStore, setInviteStore } from '../invite/store.js';
import {
  INTERVIEW_FAMILY, INTERVIEWS_MILO_POLICY as P, LEAD_ONLY, registerInterviewsMiloPolicy, setInterviewConsentSource, unregisterInterviewsMiloPolicy,
} from '../milo-policy.js';
import { interviewSpendState } from '../spend.js';

const IV = 'iv-nadia-leadership';
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

describe('inviteRefusal: the lead only (decision 20)', () => {
  it('lets the lead in and refuses everyone else with one plain sentence', async () => {
    expect(await P.inviteRefusal(PEOPLE.lead, CALL)).toBeNull();
    for (const who of ['panel', 'recruiter', 'hiringManager', 'otherHiringManager', 'work', 'guest'] as const) {
      expect([who, await P.inviteRefusal(PEOPLE[who], CALL)]).toEqual([who, LEAD_ONLY]);
    }
    expect(LEAD_ONLY).not.toMatch(/iv-|u-|interviews:|\bpolicy\b/);
  });

  it('refuses the lead of another interview, a Work session holding the lead\'s id, and a call with no interview in its lobby', async () => {
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: 'interviews:interview:iv-mateo-design' })).toBe(LEAD_ONLY); // u-hugo leads it
    expect(await P.inviteRefusal({ ...PEOPLE.lead, tenant: 'orgiq' }, CALL)).toBe(LEAD_ONLY);
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: 'interviews:interview:iv-nope' })).toBe(LEAD_ONLY);
    expect(await P.inviteRefusal(PEOPLE.lead, { ...CALL, lobby: null })).toBe(LEAD_ONLY);
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

  it('a guest counts only when BOTH transcription and Milo were accepted, for this interview, by its own invite', async () => {
    const asked: string[] = [];
    let answer: { transcription: boolean; milo: boolean } | null = null;
    setInterviewConsentSource(async (iv) => { asked.push(iv); return answer; });
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]); // not answered yet
    answer = { transcription: true, milo: false };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]);
    answer = { transcription: false, milo: true };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]);
    answer = { transcription: true, milo: true };
    expect(await P.acknowledgedElsewhere!(CALL, [guestId, LEAD, 'guest:inv-unknown'])).toEqual([guestId]); // staff and strangers never count
    expect(asked.every((iv) => iv === IV)).toBe(true);
    // Another interview's call: this guest's invite is not for it.
    expect(await P.acknowledgedElsewhere!({ ...CALL, lobby: 'interviews:interview:iv-mateo-design' }, [guestId])).toEqual([]);
  });

  it('a consent source that fails counts as no answer', async () => {
    setInterviewConsentSource(async () => { throw new Error('down'); });
    expect(await P.acknowledgedElsewhere!(CALL, [guestId])).toEqual([]);
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
  it('relays nothing the live model says (decision 9) and has no fixed requests yet (row I3.8)', () => {
    expect(P.relaysLiveSpeech(CALL)).toBe(false);
    expect(P.answerFromHeldText).toBeUndefined();
  });
});

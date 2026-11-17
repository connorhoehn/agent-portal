// The meeting assistant's policy seam (policy.ts, interviews plan row I3.1): the registry resolves a call's lobby family to its policy,
// and the default policy answers exactly what the code decided inline before the seam (Work's behaviour, for every lobby).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/spend-ledger.js', () => ({ recordSpend: jest.fn(async () => undefined) }));

import { recordSpend } from '../../../providers/spend-ledger.js';
import { MEETING_EXCLUDED_TOOLS, meetingBackendInstructions, meetingFunctionTools, meetingTools } from '../instructions.js';
import {
  DEFAULT_POLICY, familyOfLobby, hasFamilyPolicies, payerFields, payerOf, policyFamilies, policyForLobby, policyOfCall, registerMeetingAssistantPolicy,
  type MeetingAssistantPolicy,
} from '../policy.js';
import { realSpend } from '../spend.js';
import { MemoryAssistantStore } from '../store.js';
import { initiativeOfLobby } from '../store.js';
import { assistantStore, setAssistantStore } from '../store-select.js';
import { newAssistantSession, type AssistantRecord, type MinutesRecord } from '../types.js';

/** Every kind of lobby a call Milo can be invited into has today (the call store's `lobbyName`s the tests and the mock world use). */
const EXISTING: ReadonlyArray<[lobby: string, family: string]> = [
  ['orgiq:initiative:p-auth', 'orgiq:initiative'],
  ['orgiq:dm:u-alice:u-bob', 'orgiq:dm'],
  ['orgiq:dm:alice:bob:carol', 'orgiq:dm'],
  ['social:ch:general', 'social:ch'],
  ['social:dm:u-lena:u-mira', 'social:dm'],
  ['social:room:r-standup', 'social:room'],
  ['social:team:t-platform', 'social:team'],
  ['assessment:doc:doc-1', 'assessment:doc'],
  ['assessment:team:TEAM-42', 'assessment:team'],
  ['pipelines:run:run-7', 'pipelines:run'],
];

const rec = (over: Partial<AssistantRecord> = {}): AssistantRecord => ({
  callId: 'call-1', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-alice', invitedAt: 1_000,
  pausedBy: null, leftAt: null, leftBy: null, acked: ['u-alice'], attendees: ['u-alice', 'u-bob'], presentAtInvite: ['u-alice', 'u-bob'],
  requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(600), ...over,
});

const stub = (over: Partial<MeetingAssistantPolicy>): MeetingAssistantPolicy => ({ ...DEFAULT_POLICY, id: 'stub', ...over });

let unregister: Array<() => void> = [];
afterEach(() => { for (const off of unregister.splice(0)) off(); setAssistantStore(null); });

describe('the registry', () => {
  it('reads a lobby\'s family from its first two segments, and none from a name without one', () => {
    for (const [lobby, family] of EXISTING) expect(familyOfLobby(lobby)).toBe(family);
    expect(familyOfLobby('interviews:interview:iv-1')).toBe('interviews:interview');
    expect(familyOfLobby('orgiq:lobby')).toBe('orgiq:lobby');
    for (const none of [null, undefined, '', 'orgiq', 'Orgiq:dm:x', ':dm:x', 'orgiq::x', '1x:dm:y']) expect(familyOfLobby(none)).toBeNull();
  });

  it('resolves the default for every existing family, and for a lobby it cannot read', () => {
    expect(hasFamilyPolicies()).toBe(false);
    for (const [lobby] of EXISTING) expect(policyForLobby(lobby)).toBe(DEFAULT_POLICY);
    for (const odd of [null, undefined, '', 'nonsense']) expect(policyForLobby(odd)).toBe(DEFAULT_POLICY);
  });

  it('resolves a registered family to its own policy, leaves every other family on the default, and lets go of it again', () => {
    const mine = stub({ id: 'interviews' });
    unregister.push(registerMeetingAssistantPolicy('interviews:interview', mine));
    expect(hasFamilyPolicies()).toBe(true);
    expect(policyFamilies()).toEqual(['interviews:interview']);
    expect(policyForLobby('interviews:interview:iv-1')).toBe(mine);
    for (const [lobby] of EXISTING) expect(policyForLobby(lobby)).toBe(DEFAULT_POLICY);
    expect(policyForLobby('interviews:debrief:iv-1')).toBe(DEFAULT_POLICY);
    unregister.splice(0).forEach((off) => off());
    expect(policyForLobby('interviews:interview:iv-1')).toBe(DEFAULT_POLICY);
    expect(hasFamilyPolicies()).toBe(false);
  });

  it('refuses a second policy for one family, and a name that is not a family', () => {
    unregister.push(registerMeetingAssistantPolicy('orgiq:dm', stub({})));
    expect(() => registerMeetingAssistantPolicy('orgiq:dm', stub({}))).toThrow(/already registered/);
    expect(() => registerMeetingAssistantPolicy('orgiq:dm:x', stub({}))).toThrow(/not a lobby family/);
    expect(() => registerMeetingAssistantPolicy('orgiq', stub({}))).toThrow(/not a lobby family/);
  });

  it('finds a call\'s policy from its record\'s lobby, and reads nothing while no family has one', async () => {
    const store = new MemoryAssistantStore(); setAssistantStore(store);
    const get = jest.spyOn(store, 'get');
    expect(await policyOfCall('call-1', 'orgiq')).toEqual({ policy: DEFAULT_POLICY, call: { callId: 'call-1', lobby: null, tenant: 'orgiq' } });
    expect(get).not.toHaveBeenCalled();
    const mine = stub({});
    unregister.push(registerMeetingAssistantPolicy('orgiq:dm', mine));
    const { session: _s, ...rest } = rec({ lobby: 'orgiq:dm:u-alice:u-bob', initiativeId: null });
    await assistantStore().create({ ...rest, session: newAssistantSession(600) });
    expect(await policyOfCall('call-1', 'orgiq')).toEqual({ policy: mine, call: { callId: 'call-1', lobby: 'orgiq:dm:u-alice:u-bob', tenant: 'orgiq' } });
    expect((await policyOfCall('call-2', 'orgiq')).policy).toBe(DEFAULT_POLICY);
  });
});

describe('the default policy answers what the code decided before the seam', () => {
  const call = { callId: 'call-1', lobby: 'orgiq:initiative:p-auth', tenant: 'orgiq' };

  it('lets anyone Cedar lets invite, invite (no narrowing of its own)', async () => {
    for (const role of ['member', 'sme', 'org-leader', 'admin']) expect(await DEFAULT_POLICY.inviteRefusal({ userId: 'u-x', tenant: 'orgiq', role }, call)).toBeNull();
  });

  it('reads: the attendee rule for the words, seated-or-attendee for the record, in the record\'s tenant only, admins included', () => {
    // Before: attendeeOf = tenant matches && an attendee; proposals' "was there" = seated || attendee (after the tenant check).
    const before = (userId: string, tenant: string, seated: boolean, r: AssistantRecord) => {
      const attendee = r.tenant === tenant && r.attendees.includes(userId);
      return { record: r.tenant === tenant && (seated || attendee), transcript: attendee, minutes: attendee };
    };
    const r = rec();
    const table: Array<[string, string, boolean]> = [
      ['u-alice', 'orgiq', false], ['u-alice', 'orgiq', true], ['u-bob', 'orgiq', false], ['u-carol', 'orgiq', false], ['u-carol', 'orgiq', true],
      ['u-alice', 'assessment', false], ['u-alice', 'assessment', true], ['u-admin', 'orgiq', false],
    ];
    for (const [userId, tenant, seated] of table) expect([userId, tenant, seated, DEFAULT_POLICY.reads({ userId, tenant, seated }, r)]).toEqual([userId, tenant, seated, before(userId, tenant, seated, r)]);
    expect(DEFAULT_POLICY.reads({ userId: 'u-bob', tenant: 'orgiq', seated: false }, r)).toEqual({ record: true, transcript: true, minutes: true });
    expect(DEFAULT_POLICY.reads({ userId: 'u-carol', tenant: 'orgiq', seated: false }, r)).toEqual({ record: false, transcript: false, minutes: false });
  });

  it('pays: the period\'s inviter, the call\'s initiative, the meeting assistant\'s source', () => {
    expect(DEFAULT_POLICY.payer(call, { inviterId: 'u-bob', initiativeId: 'p-auth' })).toEqual({ actorId: 'u-bob', initiativeId: 'p-auth', source: 'meeting_assistant' });
    expect(DEFAULT_POLICY.payer({ ...call, lobby: 'orgiq:dm:a:b' }, { inviterId: 'u-alice', initiativeId: null })).toEqual({ actorId: 'u-alice', initiativeId: null, source: 'meeting_assistant' });
    const r = rec({ invitedBy: 'u-bob' });
    expect(payerOf(r)).toEqual({ actorId: 'u-bob', initiativeId: 'p-auth', source: 'meeting_assistant' });
    expect(payerOf(r, 'u-alice')).toEqual({ actorId: 'u-alice', initiativeId: 'p-auth', source: 'meeting_assistant' });
    expect(payerFields(r)).toEqual({ inviterId: 'u-bob', initiativeId: 'p-auth', source: 'meeting_assistant' });
    // The invite's initiative is the lobby's, as before.
    expect(initiativeOfLobby(call.lobby)).toBe('p-auth');
  });

  it('offers the session the tenant\'s meeting tools and the second model\'s instructions about them', () => {
    for (const tenant of ['orgiq', 'assessment']) {
      expect(DEFAULT_POLICY.sessionTools({ ...call, tenant })).toEqual({ tools: meetingFunctionTools(tenant), backendInstructions: meetingBackendInstructions(tenant) });
    }
  });

  it('runs a tool for an asker by the voice catalogue of their tenant and role, never one a meeting excludes', () => {
    const before = (tenant: string, roles: string[], name: string) => !MEETING_EXCLUDED_TOOLS.has(name) && roles.some((role) => meetingTools(tenant, role).some((t) => t.name === name));
    const names = [...new Set([...meetingTools('orgiq').map((t) => t.name), ...MEETING_EXCLUDED_TOOLS, 'no-such-tool'])];
    expect(names.length).toBeGreaterThan(5);
    let allowed = 0;
    for (const roles of [['member'], ['sme'], ['org-leader'], ['hr-admin', 'member'], [], ['nobody']]) {
      for (const name of names) {
        const now = DEFAULT_POLICY.mayUseTool(call, { userId: 'u-x', roles }, name);
        expect([roles, name, now]).toEqual([roles, name, before('orgiq', roles, name)]);
        if (now) allowed += 1;
      }
    }
    expect(allowed).toBeGreaterThan(0);
  });

  it('takes everyone\'s acknowledgement from the notice in the call, rings everyone, lists every meeting, relays the live model, holds no fixed answers', () => {
    for (const u of ['u-alice', 'u-bob', 'guest-1']) {
      expect(DEFAULT_POLICY.acknowledgement(call, u)).toBe('in-call-notice');
      expect(DEFAULT_POLICY.rings(call, u)).toBe(true);
      expect(DEFAULT_POLICY.listsMeeting({ callId: 'call-1', lobby: call.lobby, tenant: 'orgiq', attendees: [u] } as MinutesRecord, u)).toBe(true);
    }
    expect(DEFAULT_POLICY.relaysLiveSpeech(call)).toBe(true);
    expect(DEFAULT_POLICY.acknowledgedElsewhere).toBeUndefined();
    expect(DEFAULT_POLICY.answerFromHeldText).toBeUndefined();
  });
});

describe('settling the ledger asks the call\'s policy whose money it was', () => {
  beforeEach(() => jest.mocked(recordSpend).mockClear());
  const settle = (record: AssistantRecord) => realSpend.settle({ record, usageSeconds: 120, tokens: { input: 0, output: 0, cached: 0 }, sessionKind: 'scripted', listeningSeconds: 120 });

  it('books against the inviter on the initiative under meeting_assistant by default', async () => {
    await settle(rec());
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(jest.mocked(recordSpend).mock.calls[0]![0]).toMatchObject({ source: 'meeting_assistant', actorId: 'u-alice', initiativeId: 'p-auth', sourceId: 'ma:call-1' });
  });

  it('books against the payer a family\'s policy names', async () => {
    unregister.push(registerMeetingAssistantPolicy('orgiq:initiative', stub({ payer: () => ({ actorId: 'u-owner', initiativeId: 'p-budget', source: 'voice_session' }) })));
    await settle(rec());
    expect(jest.mocked(recordSpend).mock.calls[0]![0]).toMatchObject({ source: 'voice_session', actorId: 'u-owner', initiativeId: 'p-budget' });
  });
});

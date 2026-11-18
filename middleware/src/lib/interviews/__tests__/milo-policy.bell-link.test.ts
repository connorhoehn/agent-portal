// The bell's link for an interview's call (policy hook `meetingPath`): Work's /iq/meetings/<callId> is outside the interviews tenant
// and the notification service refuses it, so both bells ("Minutes are ready" and a proposal that needs someone) take the link from
// the call's policy. Here the real notification service's tenant check judges every link that is sent.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../call-chat.js', () => ({ callChatRuntime: () => ({ seatedUsers: async () => [] }) }));
jest.mock('../../meeting-assistant/chat.js', () => ({ nameOf: async (id: string) => id }));
const mockSent: Array<{ users: string[]; input: { action?: { href?: string } } }> = [];
jest.mock('../../social-notify.js', () => {
  const real = jest.requireActual('../../social-notify.js');
  return { ...real, notify: async (users: string[], input: never) => { mockSent.push({ users, input }); return users; } };
});

import { hrefInsideTenant } from '../../social-notify.js';
import { notifyMinutesReady } from '../../meeting-assistant/minutes-service.js';
import { forgetProposalNotices, notifyProposalNeeds } from '../../meeting-assistant/proposal-notify.js';
import { buildProposal } from '../../meeting-assistant/proposals.js';
import { meetingPathOf } from '../../meeting-assistant/policy.js';
import { MemoryAssistantStore } from '../../meeting-assistant/store.js';
import { setAssistantStore } from '../../meeting-assistant/store-select.js';
import type { MinutesRecord } from '../../meeting-assistant/types.js';
import { INTERVIEWS_MILO_POLICY, registerInterviewsMiloPolicy, unregisterInterviewsMiloPolicy } from '../milo-policy.js';

const CALL = 'call-iv-1';
const LOBBY = 'interviews:interview:iv-n5z9f2cq';
let store: MemoryAssistantStore;

beforeEach(async () => {
  mockSent.length = 0; forgetProposalNotices();
  store = new MemoryAssistantStore();
  await store.create({ callId: CALL, tenant: 'interviews', lobby: LOBBY, initiativeId: null, state: 'left', invitedBy: 'u-wen', invitedAt: 0, pausedBy: null, leftAt: 5, leftBy: 'u-wen',
    acked: [], attendees: [], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] } as never);
  setAssistantStore(store);
  registerInterviewsMiloPolicy();
});
afterEach(() => unregisterInterviewsMiloPolicy());
afterAll(() => setAssistantStore(null));

const minutes = (over: Partial<MinutesRecord> = {}): MinutesRecord => ({
  callId: CALL, tenant: 'interviews', lobby: LOBBY, initiativeId: null, callName: 'Round', startedAt: 0, endedAt: 1, invitedBy: 'u-wen', attendees: ['u-wen', 'u-hugo'],
  summary: 's', decisions: [], actionItems: [], topics: [], lineCount: 1, truncated: false, writer: 'scripted', createdAt: 1, ...over,
});

const noticeOf = async (m: MinutesRecord) => { await store.putMinutes(m); return notifyMinutesReady(m); };

it('the policy names the round\'s record page, and a call with no interview in its lobby the lead\'s list', () => {
  expect(meetingPathOf(INTERVIEWS_MILO_POLICY, { callId: CALL, lobby: LOBBY, tenant: 'interviews' })).toBe('/interviews/rounds/iv-n5z9f2cq/record');
  expect(meetingPathOf(INTERVIEWS_MILO_POLICY, { callId: CALL, lobby: null, tenant: 'interviews' })).toBe('/interviews/my-interviews');
});

it('"Minutes are ready" for an interview links inside the interviews tenant', async () => {
  await noticeOf(minutes());
  expect(mockSent).toHaveLength(1);
  const href = mockSent[0]!.input.action!.href;
  expect(href).toBe('/interviews/rounds/iv-n5z9f2cq/record');
  expect(hrefInsideTenant('interviews', href)).toBe(true);
});

it('a proposal that needs someone, in an interview call, links inside the interviews tenant', async () => {
  const p = buildProposal({ id: 'p1', callId: CALL, tenant: 'interviews', statement: 'x', outcome: { kind: 'decision', initiativeId: null }, named: ['u-hugo'], executor: 'u-wen', source: 'dev', at: 1 } as never);
  await notifyProposalNeeds(p, new Set());
  expect(mockSent).toHaveLength(1);
  expect(mockSent[0]!.input.action!.href).toBe('/interviews/rounds/iv-n5z9f2cq/record');
  expect(hrefInsideTenant('interviews', mockSent[0]!.input.action!.href)).toBe(true);
});

it('a Work call still links to its meeting page', async () => {
  const work = minutes({ callId: 'call-w', tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth' });
  await noticeOf(work);
  expect(mockSent[0]!.input.action!.href).toBe('/iq/meetings/call-w');
});

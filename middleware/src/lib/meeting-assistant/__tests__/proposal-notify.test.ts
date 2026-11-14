// Telling the people a proposal needs who are not in the call: only those still owing an answer, once each, with a link to the
// meeting page and no words of the proposal.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
const mockSent: Array<{ users: string[]; input: { title: string; body?: string; action?: { href?: string }; payload: Record<string, unknown> } }> = [];
jest.mock('../../social-notify.js', () => ({ notify: async (users: string[], input: never) => { mockSent.push({ users, input }); return users; } }));
jest.mock('../../call-chat.js', () => ({ callChatRuntime: () => ({ seatedUsers: async () => [{ userId: 'u-ada', active: true }] }) }));

import { buildProposal } from '../proposals.js';
import { forgetProposalNotices, notifyOpenProposals, notifyProposalNeeds, owedBy, PROPOSAL_NOTICE_TITLE } from '../proposal-notify.js';
import { MemoryAssistantStore } from '../store.js';

const make = (over: Partial<Parameters<typeof buildProposal>[0]> = {}) => buildProposal({
  id: 'p1', callId: 'call-1', tenant: 'orgiq', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' },
  named: ['u-ben', 'u-cal'], executor: 'u-ada', source: 'dev', at: 1, ...over,
});

beforeEach(() => { mockSent.length = 0; forgetProposalNotices(); });

it('owes an answer: the executor and the named people who have not answered', () => {
  const p = make();
  expect(owedBy(p)).toEqual(['u-ada', 'u-ben', 'u-cal']);
  expect(owedBy({ ...p, responses: [{ userId: 'u-ben', response: 'object', reason: 'x', at: 2 }] })).toEqual(['u-ada', 'u-cal']);
});

it('tells only those not seated, once, with the meeting link and no statement', async () => {
  const p = make();
  expect(await notifyProposalNeeds(p, new Set(['u-ada']))).toEqual(['u-ben', 'u-cal']);
  expect(await notifyProposalNeeds(p, new Set())).toEqual(['u-ada']);
  expect(await notifyProposalNeeds(p, new Set())).toEqual([]);
  expect(mockSent[0]!.input).toMatchObject({ title: PROPOSAL_NOTICE_TITLE, action: { href: '/iq/meetings/call-1' }, payload: { tenant: 'orgiq', callId: 'call-1' } });
  expect(JSON.stringify(mockSent)).not.toMatch(/smallest|Cut over|p1/);
});

it('a finished proposal tells nobody; at the end of the call the open ones tell who is not seated', async () => {
  expect(await notifyProposalNeeds({ ...make(), state: 'done' }, new Set())).toEqual([]);
  const store = new MemoryAssistantStore();
  await store.create({ callId: 'call-1', tenant: 'orgiq', lobby: 'l', initiativeId: null, state: 'left', invitedBy: 'u-ada', invitedAt: 0, pausedBy: null, leftAt: 5, leftBy: 'u-ada',
    acked: [], attendees: [], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] });
  await store.createProposal(make());
  expect(await notifyOpenProposals(store, 'call-1')).toBe(2);
  expect(mockSent.flatMap((s) => s.users)).toEqual(['u-ben', 'u-cal']);
});

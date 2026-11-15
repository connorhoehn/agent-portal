// Telling the people a proposal needs who are not in the call: only those still owing an answer, once each, with a link to the
// meeting page and no words of the proposal.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
const mockSent: Array<{ users: string[]; input: { title: string; body?: string; action?: { href?: string }; payload: Record<string, unknown> } }> = [];
jest.mock('../../social-notify.js', () => ({ notify: async (users: string[], input: never) => { mockSent.push({ users, input }); return users; } }));
jest.mock('../../call-chat.js', () => ({ callChatRuntime: () => ({ seatedUsers: async () => [{ userId: 'u-ada', active: true }] }) }));
jest.mock('../../../providers/projects.js', () => ({ getProject: async (id: string) => (id === 'p-auth' ? { id, name: 'Auth Migration' } : null) }));

import { buildProposal } from '../proposals.js';
import { callLabelOf, forgetProposalNotices, notifyHandBack, notifyOpenProposals, notifyProposalEnded, notifyProposalNeeds, notifyReadyToRun, owedBy } from '../proposal-notify.js';
import { MemoryAssistantStore } from '../store.js';
import { setAssistantStore } from '../store-select.js';

const recordOf = (initiativeId: string | null) => ({ callId: 'call-1', tenant: 'orgiq', lobby: 'l', initiativeId, state: 'left' as const, invitedBy: 'u-ada', invitedAt: 0, pausedBy: null, leftAt: 5, leftBy: 'u-ada',
  acked: [], attendees: [], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [] });
let labelStore: MemoryAssistantStore;
beforeEach(async () => { labelStore = new MemoryAssistantStore(); await labelStore.create(recordOf('p-auth') as never); setAssistantStore(labelStore); });
afterAll(() => setAssistantStore(null));

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
  expect(mockSent[0]!.input).toMatchObject({ title: 'A proposal from the Auth Migration call needs you', action: { href: '/iq/meetings/call-1' }, payload: { tenant: 'orgiq', callId: 'call-1' } });
  expect(JSON.stringify(mockSent)).not.toMatch(/smallest|Cut over|p1/);
});

it('a finished proposal tells nobody; at the end of the call the open ones tell who is not seated', async () => {
  expect(await notifyProposalNeeds({ ...make(), state: 'done' }, new Set())).toEqual([]);
  const store = new MemoryAssistantStore();
  await store.create(recordOf(null) as never);
  await store.createProposal(make());
  expect(await notifyOpenProposals(store, 'call-1')).toBe(2);
  expect(mockSent.flatMap((s) => s.users)).toEqual(['u-ben', 'u-cal']);
});

it('names the call by its initiative, or says "a call"', async () => {
  expect(await callLabelOf('call-1')).toBe('the Auth Migration call');
  const other = new MemoryAssistantStore();
  await other.create(recordOf(null) as never);
  expect(await callLabelOf('call-1', other)).toBe('a call');
  expect(await callLabelOf('no-such-call', other)).toBe('a call');
});

it('an ending tells the asker and the executor once, with the call name and no words of the proposal', async () => {
  const p = make({ askedBy: 'u-dee', source: 'asked' });
  expect(await notifyProposalEnded({ ...p, state: 'open' })).toEqual([]);
  expect(await notifyProposalEnded({ ...p, state: 'done' })).toEqual(['u-dee', 'u-ada']);
  expect(await notifyProposalEnded({ ...p, state: 'done' })).toEqual([]);
  expect(mockSent[0]!.input).toMatchObject({ title: 'A proposal from the Auth Migration call was carried out', action: { href: '/iq/meetings/call-1' } });
  forgetProposalNotices();
  await notifyProposalEnded({ ...p, state: 'failed' });
  await notifyProposalEnded({ ...make({ id: 'p2' }), state: 'expired' });
  expect(mockSent.slice(1).map((x) => [x.users, x.input.title])).toEqual([
    [['u-dee', 'u-ada'], 'A proposal from the Auth Migration call could not be carried out'],
    [['u-ada'], 'A proposal from the Auth Migration call expired without running'],
  ]);
  expect(JSON.stringify(mockSent)).not.toMatch(/smallest|Cut over|p1|p2/);
});

it('a hand-back tells the executor, once per hand-back; a consented one waiting for them is not a hand-back', async () => {
  const run = { turnId: null, by: 'u-ada', at: 10, title: null, href: null, note: 'Ada was not there to run this.' };
  const p = { ...make(), state: 'consented' as const, run };
  expect(await notifyHandBack({ ...p, run: null })).toEqual([]);
  expect(await notifyHandBack({ ...p, run: { ...run, turnId: 't1' } })).toEqual([]);
  expect(await notifyHandBack(p)).toEqual(['u-ada']);
  expect(await notifyHandBack(p)).toEqual([]);
  expect(await notifyHandBack({ ...p, run: { ...run, at: 11 } })).toEqual(['u-ada']);
  expect(mockSent[0]!.input).toMatchObject({ title: 'Nova could not run a proposal from the Auth Migration call' });
  expect(JSON.stringify(mockSent)).not.toMatch(/smallest|not there|p1/);
});

it('an executor away from the call is told once when only their own click is left', async () => {
  const p = { ...make(), state: 'consented' as const };
  expect(await notifyReadyToRun(p, new Set(['u-ada']))).toEqual([]);
  expect(await notifyReadyToRun({ ...p, state: 'open' }, new Set())).toEqual([]);
  expect(await notifyReadyToRun(p, new Set())).toEqual(['u-ada']);
  expect(await notifyReadyToRun(p, new Set())).toEqual([]);
  expect(mockSent[0]!.input).toMatchObject({ title: 'A proposal from the Auth Migration call is ready for you to run' });
});

// A proposal's card in the call chat: one card per proposal whatever created it, kept at the proposal's state, carrying only the id and
// state in its metadata (the statement is its text), and blanked by the erase like every other Milo message.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';

const chat = new InMemoryChatStore();
jest.mock('../../call-chat.js', () => ({ callChatChannel: (id: string) => `orgiq:huddle:${id}`, callChatRuntime: () => ({ messages: chat }) }));
jest.mock('../../social-chat.js', () => ({
  postThreadMessage: async (row: ChatMessage) => { await chat.putMessage(row); },
  updateThreadMessage: async (channel: string, id: string, patch: { message?: string; metadata?: Record<string, unknown> }) => {
    const existing = await chat.getMessage(channel, id);
    if (!existing) return null;
    const merged: Record<string, unknown> = { ...(existing.metadata ?? {}) };
    for (const [k, v] of Object.entries(patch.metadata ?? {})) { if (v === undefined) delete merged[k]; else merged[k] = v; }
    return chat.updateMessage(channel, id, { metadata: merged, ...(patch.message ? { message: patch.message } : {}) });
  },
}));
jest.mock('../../social-notify.js', () => ({ notify: async () => [] }));

import { MemoryAssistantStore } from '../store.js';
import { setAssistantStore } from '../store-select.js';
import { eraseAssistantMessages, proposalCardId } from '../chat.js';
import { DELETED_RECORD_LINE, ASSISTANT_USER_ID, parseAssistantMetadata } from '../chat-types.js';
import { createProposal, respondToProposal } from '../proposals.js';
import type { AssistantRecord } from '../types.js';

const CALL = 'call-p';
const CHANNEL = `orgiq:huddle:${CALL}`;
const record: AssistantRecord = {
  callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: 'u-ada', invitedAt: 1000, pausedBy: null, leftAt: null, leftBy: null,
  acked: [], attendees: ['u-ada', 'u-ben', 'u-cal'], presentAtInvite: ['u-ada'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
};
const cards = async () => (await chat.listMessages(CHANNEL, 100)).filter((m) => m.userId === ASSISTANT_USER_ID && m.metadata?.['kind'] === 'assistant-proposal');
const make = (store: MemoryAssistantStore, id = 'p1') => createProposal(store, {
  id, callId: CALL, tenant: 'orgiq', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' },
  named: [], executor: 'u-ada', source: 'dev', at: 50_000,
});

describe('proposal cards', () => {
  let store: MemoryAssistantStore;
  beforeEach(async () => { (chat as unknown as { _reset(): void })._reset(); store = new MemoryAssistantStore(); setAssistantStore(store); await store.create(record); });

  it('posts one card when a proposal is created, with the statement as text and only the id and state as metadata', async () => {
    await make(store);
    await make(store); // the same id again is not a new proposal and posts nothing
    const [card, ...rest] = await cards();
    expect(rest).toHaveLength(0);
    expect(card!.id).toBe(proposalCardId({ id: 'p1', createdAt: 50_000 }));
    expect(card!.message).toBe('Cut over the smallest tenants first');
    expect(card!.metadata).toEqual({ assistant: true, displayName: 'Milo', kind: 'assistant-proposal', proposalId: 'p1', state: 'open' });
  });

  it('follows the proposal: consented after two people including the executor, objected, back to open on withdrawal, dismissed', async () => {
    await make(store);
    await respondToProposal(store, CALL, 'p1', { userId: 'u-ben', response: 'consent', at: 51_000 });
    expect((await cards())[0]!.metadata?.['state']).toBe('open');
    await respondToProposal(store, CALL, 'p1', { userId: 'u-ada', response: 'consent', at: 52_000 });
    expect((await cards())[0]!.metadata?.['state']).toBe('consented');

    await make(store, 'p2');
    await respondToProposal(store, CALL, 'p2', { userId: 'u-cal', response: 'object', reason: 'Out next week', at: 53_000 });
    const second = async () => (await cards()).find((c) => c.metadata?.['proposalId'] === 'p2')!;
    expect((await second()).metadata?.['state']).toBe('objected');
    expect(JSON.stringify((await second()).metadata)).not.toContain('Out next week');
    await respondToProposal(store, CALL, 'p2', { userId: 'u-cal', response: 'withdraw', at: 54_000 });
    expect((await second()).metadata?.['state']).toBe('open');
    await respondToProposal(store, CALL, 'p2', { userId: 'u-ben', response: 'not-a-decision', at: 55_000 });
    expect((await second()).metadata?.['state']).toBe('dismissed');
  });

  it('posts nothing when the assistant is not in the call', async () => {
    await store.transition(CALL, { from: ['listening'], to: 'left', by: 'u-ada', at: 2000 });
    await make(store);
    expect(await cards()).toHaveLength(0);
  });

  it('the erase leaves no card: the call chat holds the fixed line once, as a plain notice', async () => {
    await make(store);
    await eraseAssistantMessages(CALL);
    expect(await cards()).toEqual([]);
    const mine = (await chat.listMessages(CHANNEL, 100)).filter((m) => m.userId === ASSISTANT_USER_ID && m.metadata?.['deleted'] !== true);
    expect(mine.map((m) => m.message)).toEqual([DELETED_RECORD_LINE]);
    expect(JSON.stringify(await chat.listMessages(CHANNEL, 100))).not.toContain('smallest tenants');
  });

  it('parses the card metadata and refuses a bad state or a missing id', () => {
    const base = { assistant: true, displayName: 'Milo', kind: 'assistant-proposal' };
    expect(parseAssistantMetadata({ ...base, proposalId: 'p1', state: 'objected', statement: 'hidden' })).toEqual({ ...base, proposalId: 'p1', state: 'objected' });
    expect(parseAssistantMetadata({ ...base, proposalId: 'p1', state: 'maybe' })).toBeNull();
    expect(parseAssistantMetadata({ ...base, state: 'open' })).toBeNull();
  });
});

// A call chat's read positions (lib/call-chat-reads.ts) under the call chat's own authority: a current member reads and
// moves only their own position, per tab; another call, another tenant, a non-member and a guest outside their interview's
// call are refused; a position never moves backwards.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));

import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore, MemoryChatReadReceiptStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { getUser } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { CallChatRuntime, callChatChannel } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';
import { callChatReadChannel, callChatReads } from '../call-chat-reads.js';
import { lobbyGuard } from '../gateway/authority.js';
import type { Session } from '../session.js';

const CALL = 'work-call', LOBBY = 'orgiq:initiative:p-auth';
const IV_CALL = 'iv-call', IV_LOBBY = 'interviews:interview:iv-1';
const GUEST = 'guest:inv-1';
const member = (sub: string): Session => ({ sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'] }, iat: 100 } as Session);
const lead = member('u-lead'), wen = member('u-wen'), stranger = member('u-stranger');
const guestSession = { sub: GUEST, tenant: 'interviews', role: 'interview-guest', epoch: 0, grants: { interviews: ['interview-guest'] }, iat: 0,
  guest: { inviteId: 'inv-1', interviewId: 'iv-1', session: 's' } } as unknown as Session;
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, epoch: 0, sessionIat: s.iat });
const guestCtx = { userId: GUEST, org: 'interviews', role: 'interview-guest', tenants: [], guest: { inviteId: 'inv-1', interviewId: 'iv-1', session: 's' } };
const NOW = Date.parse('2026-10-10T12:10:00Z');
const at = (s: number) => new Date(Date.parse('2026-10-10T12:00:00Z') + s * 1000).toISOString();

let calls: InMemoryCallStateStore, runtime: CallChatRuntime, store: MemoryChatReadReceiptStore, reads: ReturnType<typeof callChatReads>;

beforeEach(async () => {
  const contexts = new Map<string, Record<string, unknown>>([['lead', ctx(lead)], ['wen', ctx(wen)], ['guest', guestCtx], ['lead-iv', ctx(lead)]]);
  const people: Record<string, string> = { 'u-lead': 'Lead', 'u-wen': 'Wen', 'u-stranger': 'Stranger' };
  jest.mocked(getUser).mockReset().mockImplementation(async id => (people[id] ? { id, displayName: people[id]!, email: null, personId: null, epoch: 0, grants: { orgiq: ['member'] } } : null));
  jest.mocked(isAllowed).mockReset().mockResolvedValue(true);
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  calls = new InMemoryCallStateStore();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id),
    getClientData: (id: string) => (contexts.has(id) ? { userContext: contexts.get(id) } : undefined), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router, lobbyAllowed: lobbyGuard,
    maintenanceIntervalMs: 0, now: () => NOW - 60_000, interviewLeadOf: async (id) => (id === 'iv-1' ? 'u-lead' : null) });
  await calls.registerParticipant(CALL, 'lead', 'u-lead', LOBBY, []); await runtime.registered(CALL, 'lead');
  await calls.registerParticipant(CALL, 'wen', 'u-wen', LOBBY, []); await runtime.registered(CALL, 'wen');
  await calls.registerParticipant(IV_CALL, 'lead-iv', 'u-lead', IV_LOBBY, []); await runtime.registered(IV_CALL, 'lead-iv');
  await calls.registerParticipant(IV_CALL, 'guest', GUEST, IV_LOBBY, []); await runtime.registered(IV_CALL, 'guest');
  store = new MemoryChatReadReceiptStore();
  reads = callChatReads({ store: () => store, assertMember: (callId, session) => runtime.assertMember(callId, session), now: () => new Date(NOW) });
});
afterEach(() => { runtime.dispose(); jest.restoreAllMocks(); });

describe('my read positions in a call', () => {
  it('start empty, move per tab, and the chat position is the library read receipt on the call channel', async () => {
    expect((await reads.get(CALL, lead)).reads).toEqual({ chat: null, milo: null });
    const out = await reads.mark(CALL, lead, 'chat', at(30));
    expect(out.reads.chat).toEqual({ readAt: at(30), updatedAt: new Date(NOW).toISOString() });
    expect(out.reads.milo).toBeNull();
    expect((await store.listReceipts(callChatChannel(CALL))).map(r => r.userId)).toEqual(['u-lead']);
    await reads.mark(CALL, lead, 'milo', at(10));
    expect((await reads.get(CALL, lead)).reads.milo?.readAt).toBe(at(10));
    expect(callChatReadChannel(CALL, 'milo')).toBe(`${callChatChannel(CALL)}~reads~milo`);
  });

  it('never moves backwards (a second tab on an older message), and clamps a slightly fast clock to now', async () => {
    await reads.mark(CALL, lead, 'chat', at(30));
    expect((await reads.mark(CALL, lead, 'chat', at(5))).reads.chat?.readAt).toBe(at(30));
    expect((await reads.mark(CALL, lead, 'chat', new Date(NOW + 60_000).toISOString())).reads.chat?.readAt).toBe(new Date(NOW).toISOString());
  });

  it('is mine alone: another member of the same call reads their own (none), not mine', async () => {
    await reads.mark(CALL, lead, 'chat', at(30));
    expect((await reads.get(CALL, wen)).reads.chat).toBeNull();
    await reads.mark(CALL, wen, 'chat', at(20));
    expect((await reads.get(CALL, lead)).reads.chat?.readAt).toBe(at(30));
  });

  it('refuses a bad tab, a malformed time and a time far in the future', async () => {
    await expect(reads.mark(CALL, lead, 'pad', at(1))).rejects.toMatchObject({ status: 400 });
    await expect(reads.mark(CALL, lead, 'chat', 'yesterday')).rejects.toMatchObject({ status: 400 });
    await expect(reads.mark(CALL, lead, 'chat', new Date(NOW + 3_600_000).toISOString())).rejects.toMatchObject({ status: 400 });
  });
});

describe('refusals', () => {
  it('another call: a member of one call cannot read or write a position in a call they are not in', async () => {
    await expect(reads.get('other-call', lead)).rejects.toMatchObject({ status: 404 });
    await expect(reads.mark(IV_CALL, wen, 'chat', at(1))).rejects.toMatchObject({ status: 403 });
    await expect(reads.get(CALL, stranger)).rejects.toMatchObject({ status: 403 });
    expect(await store.listReceipts(callChatChannel(IV_CALL))).toEqual([]);
  });

  it('another tenant: the same person under another tenant\'s session is refused', async () => {
    const elsewhere = { ...lead, tenant: 'assessment', role: 'assessor', grants: { assessment: ['assessor'] } } as Session;
    await expect(reads.get(CALL, elsewhere)).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(reads.mark(CALL, elsewhere, 'chat', at(1))).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await store.listReceipts(callChatChannel(CALL))).toEqual([]);
  });

  it('a guest candidate keeps a position in their interview\'s call only', async () => {
    await expect(reads.get(CALL, guestSession)).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(reads.mark(CALL, guestSession, 'chat', at(40))).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await store.listReceipts(callChatChannel(CALL))).toEqual([]);
    // In their interview's call the seat checks are the interviews lobby's (lib/interviews/lobby.ts, call-chat-guest.test.ts);
    // the seat is given here so only the position is under test.
    jest.spyOn(runtime, 'assertMember').mockImplementation(async (callId) => { if (callId !== IV_CALL) throw Object.assign(new Error('no'), { status: 403 }); });
    expect((await reads.mark(IV_CALL, guestSession, 'chat', at(40))).reads.chat?.readAt).toBe(at(40));
    expect((await store.listReceipts(callChatChannel(IV_CALL))).map(r => r.userId)).toEqual([GUEST]);
  });

  it('a member who left the call is refused', async () => {
    await reads.mark(CALL, wen, 'chat', at(5));
    runtime.invalidate(CALL, 'wen'); await calls.removeParticipant(CALL, 'wen'); await runtime.removed(CALL, 'wen');
    await expect(reads.get(CALL, wen)).rejects.toMatchObject({ status: 403 });
  });
});

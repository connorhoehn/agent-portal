// What a guest reads of the call's chat (docs/interviews-tenant-plan.md decisions 4 and 9, interviews contract E9): people's
// own messages and, of Milo's, only the questions the lead approved. A guest connection and a panel connection on the
// same call, through every delivery the runtime owns: live messages and updates, the history replay, and `get`.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../page-resources.js', () => ({ pageResourceVisible: jest.fn() }));

import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore, type ChatMessage } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { getUser } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { pageResourceVisible } from '../page-resources.js';
import { CallChatRuntime, callChatChannel, guestMaySee, isGuestSession } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';
import { lobbyGuard } from '../gateway/authority.js';
import { APPROVED_QUESTION_KEY, ASSISTANT_USER_ID, claimsAssistant } from '../meeting-assistant/chat-types.js';
import type { Session } from '../session.js';

const CALL = 'iv-call', LOBBY = 'orgiq:initiative:p-auth', CHANNEL = callChatChannel(CALL);
const GUEST = 'guest:inv-1';
const lead: Session = { sub: 'u-lead', tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'] }, iat: 100 };
const guestSession = { sub: GUEST, tenant: 'interviews', role: 'interview-guest', epoch: 0, grants: { interviews: ['interview-guest'] }, iat: 0,
  guest: { inviteId: 'inv-1', interviewId: 'iv-1', session: 's' } } as unknown as Session;
const leadCtx = { userId: lead.sub, org: lead.tenant, role: lead.role, epoch: 0, sessionIat: lead.iat };
const guestCtx = { userId: GUEST, org: 'interviews', role: 'interview-guest', tenants: [], guest: { inviteId: 'inv-1', interviewId: 'iv-1', session: 's' } };

const at = (n: number) => new Date(Date.parse('2026-10-10T12:00:10Z') + n * 1000).toISOString();
const milo = (id: string, n: number, text: string, metadata: Record<string, unknown>): ChatMessage =>
  ({ id, clientId: 'server:assistant', userId: ASSISTANT_USER_ID, channel: CHANNEL, message: text, timestamp: at(n), metadata: { assistant: true, displayName: 'Milo', ...metadata } });
const person = (id: string, n: number, userId: string, text: string, metadata: Record<string, unknown> = {}): ChatMessage =>
  ({ id, clientId: 'c', userId, channel: CHANNEL, message: text, timestamp: at(n), metadata });

const ROWS: ChatMessage[] = [
  person('p-1', 1, 'u-lead', 'Welcome, thanks for joining.'),
  milo('m-notice', 2, 'Milo joined at the lead\'s invitation.', { kind: 'assistant-notice' }),
  milo('m-reply', 3, 'The candidate mentioned retries.', { kind: 'assistant-reply', askedBy: 'u-lead', askedByName: 'Lead', private: false }),
  milo('m-action', 4, 'Create a follow-up', { kind: 'assistant-action', actionId: 'a', askedBy: 'u-lead', askedByName: 'Lead', summary: 's', tool: { name: 't', argsDigest: '' }, status: 'waiting' }),
  milo('m-minutes', 5, 'Summary of the meeting.', { kind: 'assistant-notice', minutes: { decisions: 1, actionItems: 0, proposals: 0 } }),
  milo('m-q', 6, 'How would you design a rate limiter?', { kind: 'assistant-notice', [APPROVED_QUESTION_KEY]: true }),
  person('g-1', 7, GUEST, 'I would start with a token bucket.'),
  // A person's row that carries the mark (written straight to the store) is still a person's message, shown without the key.
  person('p-forged', 8, 'u-lead', 'forged', { [APPROVED_QUESTION_KEY]: true }),
  // Another non-person author carrying the mark is panel-side.
  { ...milo('x-agent', 9, 'Another agent', { kind: 'assistant-notice', [APPROVED_QUESTION_KEY]: true }), userId: 'agent:other' },
  // An erased approved question is gone for everyone.
  milo('m-q-erased', 10, 'This record was deleted.', { deleted: true, [APPROVED_QUESTION_KEY]: true }),
];
const GUEST_SEES = ['p-1', 'm-q', 'g-1', 'p-forged'];

let calls: InMemoryCallStateStore, state: MemoryCallChatStateStore, messages: InMemoryChatStore, runtime: CallChatRuntime;
let contexts: Map<string, Record<string, unknown>>, router: RealtimeRouter;

beforeEach(async () => {
  const clock = Date.parse('2026-10-10T12:00:00Z');
  contexts = new Map<string, Record<string, unknown>>([['lead', leadCtx], ['guest', guestCtx]]);
  jest.mocked(getUser).mockReset().mockImplementation(async id => (id === lead.sub ? { id, displayName: 'Lead', email: null, personId: null, epoch: 0, grants: lead.grants } : null));
  jest.mocked(isAllowed).mockReset().mockResolvedValue(true);
  jest.mocked(pageResourceVisible).mockReset().mockResolvedValue(true);
  calls = new InMemoryCallStateStore(); state = new MemoryCallChatStateStore(); messages = new InMemoryChatStore();
  router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id),
    getClientData: (id: string) => (contexts.has(id) ? { userContext: contexts.get(id) } : undefined), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  runtime = new CallChatRuntime({ calls, state, messages, router, lobbyAllowed: lobbyGuard, maintenanceIntervalMs: 0, now: () => clock });
  await calls.registerParticipant(CALL, 'lead', 'u-lead', LOBBY, []); await runtime.registered(CALL, 'lead');
  for (const row of ROWS) await messages.putMessage(row);
});
afterEach(() => { runtime.dispose(); jest.restoreAllMocks(); });

const ids = (rows: unknown) => (rows as ChatMessage[]).map(m => m.id);

describe('the rule', () => {
  it('a guest sees people\'s messages and Milo\'s approved questions only; the mark cannot be sent by a person', () => {
    expect(ROWS.filter(guestMaySee).map(m => m.id)).toEqual(GUEST_SEES);
    expect(isGuestSession(guestSession)).toBe(true);
    expect(isGuestSession({ sub: GUEST, role: 'member' } as Session)).toBe(true);
    expect(isGuestSession(lead)).toBe(false);
    expect(claimsAssistant({ [APPROVED_QUESTION_KEY]: true })).toBe(true);
  });
});

describe('live frames', () => {
  const frame = (message: ChatMessage, action = 'message') => ({ type: 'chat', action, channel: CHANNEL, message });

  it('drops Milo\'s notices, replies, cards and minutes for the guest, and keeps them as they were for the panel', async () => {
    for (const row of ROWS) {
      const forPanel = await runtime.filterFrame('lead', frame(row));
      expect(forPanel).toEqual(frame(await runtime.render(CALL, row)));
      const forGuest = await runtime.filterFrame('guest', frame(row));
      if (GUEST_SEES.includes(row.id)) expect(forGuest).not.toBeNull(); else expect(forGuest).toBeNull();
    }
  });

  it('the guest reads the approved question as a plain line under Milo\'s name: no asker, no kind, no mark', async () => {
    const q = ROWS.find(m => m.id === 'm-q')!;
    const forGuest = await runtime.filterFrame('guest', frame(q)) as { message: ChatMessage };
    expect(forGuest.message).toEqual({ id: 'm-q', clientId: 'server:assistant', userId: ASSISTANT_USER_ID, channel: CHANNEL, message: q.message, timestamp: q.timestamp,
      metadata: { displayName: 'Milo' } });
    const forPanel = await runtime.filterFrame('lead', frame(q)) as { message: ChatMessage };
    expect(forPanel.message.metadata).toMatchObject({ assistant: true, kind: 'assistant-notice', approvedQuestion: true });
    const forged = await runtime.filterFrame('guest', frame(ROWS.find(m => m.id === 'p-forged')!)) as { message: ChatMessage };
    expect(forged.message.metadata).toEqual({});
  });

  it('an update to one of Milo\'s cards never reaches the guest; a frame without an author is dropped for it', async () => {
    expect(await runtime.filterFrame('guest', frame(ROWS.find(m => m.id === 'm-action')!, 'messageUpdated'))).toBeNull();
    expect(await runtime.filterFrame('lead', frame(ROWS.find(m => m.id === 'm-action')!, 'messageUpdated'))).not.toBeNull();
    const partial = { id: 'm-action', channel: CHANNEL, metadata: { status: 'confirmed' } } as unknown as ChatMessage;
    expect(await runtime.filterFrame('guest', frame(partial, 'messageUpdated'))).toBeNull();
  });

  it('a reader this replica cannot place is read as a guest for Milo\'s messages, never for people\'s', async () => {
    expect(await runtime.filterFrame('nobody', frame(ROWS.find(m => m.id === 'm-notice')!))).toBeNull();
    expect(await runtime.filterFrame('nobody', frame(ROWS.find(m => m.id === 'p-1')!))).not.toBeNull();
  });
});

describe('the history replay', () => {
  it('a join or a history request replays only what the guest may see; the panel gets every row', async () => {
    const history = { type: 'chat', action: 'history', channel: CHANNEL, messages: ROWS };
    expect(ids((await runtime.filterFrame('guest', history) as { messages: unknown }).messages)).toEqual(GUEST_SEES);
    expect(ids((await runtime.filterFrame('lead', history) as { messages: unknown }).messages)).toEqual(ROWS.map(m => m.id));
    // A history of people's messages only is the same for both.
    const people = { ...history, messages: ROWS.filter(m => m.userId === 'u-lead' || m.userId === GUEST) };
    expect(await runtime.filterFrame('guest', people)).toEqual(await runtime.filterFrame('lead', people));
  });
});

describe('the resolver (get)', () => {
  it('a panel session reads what it read before; a guest session the filtered list', async () => {
    const panel = await runtime.get(CALL, lead, 100);
    // The erased row is dropped for everyone by the existing deletion rule.
    expect(ids(panel.messages)).toEqual(ROWS.filter(m => m.id !== 'm-q-erased').map(m => m.id));
    // A guest's seat checks are the interviews lobby's (lib/interviews/lobby.ts); here the seat is given so only the reading is under test.
    const seat = { state: { members: { [GUEST]: { active: true, historyFrom: '2026-10-10T12:00:00.000Z' } }, revision: 1 }, authority: {}, call: { lobbyName: LOBBY }, clientIds: ['guest'] };
    const r = runtime as unknown as Record<string, unknown>;
    jest.spyOn(r as never, 'participant' as never).mockResolvedValue(seat as never);
    jest.spyOn(r as never, 'seats' as never).mockResolvedValue([] as never);
    jest.spyOn(r as never, 'grant' as never).mockResolvedValue(true as never);
    const asGuest = await runtime.get(CALL, guestSession, 100);
    expect(ids(asGuest.messages)).toEqual(GUEST_SEES);
    expect(asGuest.messages.find(m => m.id === 'm-q')!.metadata).toEqual({ displayName: 'Milo' });
  });
});

describe('the panel\'s names a candidate reads (E4 #32)', () => {
  const IV_CALL = 'iv-panel-call', IV_CHANNEL = callChatChannel(IV_CALL);
  const said = (id: string, userId: string, name: string): ChatMessage =>
    ({ id, clientId: 'c', userId, channel: IV_CHANNEL, message: 'hello', timestamp: at(1), metadata: { displayName: name } });
  let named: CallChatRuntime;
  beforeEach(async () => {
    named = new CallChatRuntime({ calls, state, messages, router, lobbyAllowed: lobbyGuard, maintenanceIntervalMs: 0, now: () => Date.parse('2026-10-10T12:00:00Z'),
      interviewLeadOf: async (id) => (id === 'iv-1' ? 'u-lead' : null) });
    await calls.registerParticipant(IV_CALL, 'lead', 'u-lead', 'interviews:interview:iv-1', []); await named.registered(IV_CALL, 'lead');
  });
  afterEach(() => named.dispose());
  const chat = (message: ChatMessage) => ({ type: 'chat', action: 'message', channel: IV_CHANNEL, message });

  it('the lead keeps their name, another panel member is "Interviewer", the candidate is themselves; staff read every name', async () => {
    const nameOf = async (reader: string, m: ChatMessage) => ((await named.filterFrame(reader, chat(m))) as { message: ChatMessage }).message.metadata?.['displayName'];
    expect(await nameOf('guest', said('a', 'u-lead', 'Hugo Marchetti'))).toBe('Hugo Marchetti');
    expect(await nameOf('guest', said('b', 'u-wen', 'Wen Zhao'))).toBe('Interviewer');
    expect(await nameOf('guest', said('c', GUEST, 'Candidate'))).toBe('Candidate');
    expect(await nameOf('lead', said('b', 'u-wen', 'Wen Zhao'))).toBe('Wen Zhao');
    const history = await named.filterFrame('guest', { type: 'chat', action: 'history', channel: IV_CHANNEL, messages: [said('a', 'u-lead', 'Hugo Marchetti'), said('b', 'u-wen', 'Wen Zhao')] }) as { messages: ChatMessage[] };
    expect(history.messages.map((m) => m.metadata?.['displayName'])).toEqual(['Hugo Marchetti', 'Interviewer']);
  });
});

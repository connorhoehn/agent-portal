// CallChatRuntime.usersInLobbyCall (gap audit 2026-11-20 §4): who is in a lobby's live call, from the call store's lobby
// index and each seat's VERIFIED socket context. A disconnected socket, another lobby's call, a context without a
// well-formed identity and a store without a lobby index all count as nobody.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { CallChatRuntime } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';

const LOBBY = 'interviews:interview:iv-room1';
const staff = (userId: string) => ({ userId, org: 'interviews', role: 'interviewer', epoch: 0, sessionIat: 1 });

let calls: InMemoryCallStateStore, contexts: Map<string, Record<string, unknown>>, runtime: CallChatRuntime;
beforeEach(() => {
  calls = new InMemoryCallStateStore();
  contexts = new Map();
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id),
    getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  runtime = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: new InMemoryChatStore(), router,
    lobbyAllowed: () => true, maintenanceIntervalMs: 0 });
});
afterEach(() => runtime.dispose());

it('names the connected seats of the lobby\'s call, by their verified context, and nobody else', async () => {
  contexts.set('c-hugo', staff('u-hugo')).set('c-wen', staff('u-wen')).set('c-other', staff('u-other')).set('c-bad', { org: 'interviews' });
  await calls.registerParticipant('call-1', 'c-hugo', 'u-hugo', LOBBY, []);
  await calls.registerParticipant('call-1', 'c-wen', 'u-hugo', LOBBY, []);
  await calls.registerParticipant('call-1', 'c-gone', 'u-hugo', LOBBY, []); // no live socket
  await calls.registerParticipant('call-1', 'c-bad', 'u-hugo', LOBBY, []); // no identity in its context
  await calls.registerLobbyCall(LOBBY, 'call-1', 60);
  await calls.registerParticipant('call-2', 'c-other', 'u-other', 'interviews:interview:iv-room2', []);
  await calls.registerLobbyCall('interviews:interview:iv-room2', 'call-2', 60);
  expect((await runtime.usersInLobbyCall(LOBBY)).sort()).toEqual(['u-hugo', 'u-wen']);
  contexts.delete('c-hugo');
  expect(await runtime.usersInLobbyCall(LOBBY)).toEqual(['u-wen']);
  expect(await runtime.usersInLobbyCall('interviews:interview:iv-none')).toEqual([]);
});

it('a call store without a lobby index, or one that fails, says nobody', async () => {
  contexts.set('c-hugo', staff('u-hugo'));
  await calls.registerParticipant('call-1', 'c-hugo', 'u-hugo', LOBBY, []);
  await calls.registerLobbyCall(LOBBY, 'call-1', 60);
  jest.spyOn(calls, 'getCall').mockRejectedValueOnce(new Error('down'));
  expect(await runtime.usersInLobbyCall(LOBBY)).toEqual([]);
  (calls as unknown as { getCallIdsByLobby?: unknown }).getCallIdsByLobby = undefined;
  expect(await runtime.usersInLobbyCall(LOBBY)).toEqual([]);
});

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import { LocalRealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { CallChatRuntime } from '../call-chat.js';
import { MemoryCallChatStateStore } from '../call-chat-state.js';
import type { Session } from '../session.js';

it.each(['social:dm:u-mira:u-sana', 'assessment:doc:page:100002', 'pipelines:run:run-42', 'assessment:team:team-lower'])('shared call lifecycle leaves %s outside the huddle reconciler', async lobbyName => {
  const calls = new InMemoryCallStateStore(), state = new MemoryCallChatStateStore();
  const getState = jest.spyOn(state, 'get'), join = jest.spyOn(state, 'join');
  const authority = jest.fn().mockRejectedValue(new Error('OrgIQ authority must not run for another call tenant'));
  const runtime = new CallChatRuntime({ calls, state, messages: new InMemoryChatStore(), router: new LocalRealtimeRouter(),
    lobbyAllowed: () => true, authority, maintenanceIntervalMs: 0 });
  try {
    await calls.registerParticipant('other-call', 'mira-seat', 'u-mira', lobbyName, ['u-sana']);
    await calls.registerParticipant('other-call', 'sana-seat', 'u-mira', lobbyName, ['u-sana']);
    await runtime.registered('other-call', 'mira-seat');
    await runtime.registered('other-call', 'mira-seat', true);
    await runtime.restored('other-call', (await calls.getCall('other-call'))!);
    runtime.invalidate('other-call', 'mira-seat');
    await calls.removeParticipant('other-call', 'mira-seat');
    await runtime.removed('other-call', 'mira-seat');
    expect(authority).not.toHaveBeenCalled(); expect(getState).not.toHaveBeenCalled(); expect(join).not.toHaveBeenCalled();
    expect((await calls.getCall('other-call'))?.participantClientIds).toEqual(['sana-seat']);
    // Ignoring an unrelated lifecycle callback never grants HTTP chat access.
    authority.mockResolvedValue({ displayName: 'Mira', grants: { social: ['participant'] } });
    await expect(runtime.get('other-call', { sub: 'u-mira', tenant: 'social' } as Session)).rejects.toMatchObject({
      status: 403, message: 'This call requires an OrgIQ lobby',
    });
    await runtime.finish('other-call'); await calls.forgetCall('other-call');
    await expect(runtime.removed('other-call', 'sana-seat')).resolves.toBeUndefined();
  } finally { runtime.dispose(); }
});

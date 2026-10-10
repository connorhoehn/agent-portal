import { captureCallReaction, configuredCallReactionCapture, recordedCallReactionItem, type RecordedCallReaction } from '../call-reactions.js';
import type { Reaction } from '@connorhoehnslalom/realtime-modules/reactions';

const event: Reaction = { id: 'reaction-1', channel: 'orgiq:huddle:call-1', clientId: 'socket-1', userId: 'u-vera',
  displayName: 'Vera Green', emoji: '🎉', effect: 'float', position: null,
  metadata: { lobbyName: 'social:room:spoofed', orgId: 'social', userId: 'u-nora' }, timestamp: '2026-10-09T04:00:00.000Z' };
const call = { callerId: 'u-vera', lobbyName: 'orgiq:initiative:p-observability', targetUserIds: [], participantClientIds: ['socket-1'] };

test('recording activity resolves the accepted call and tenant from server state', async () => {
  const rows: RecordedCallReaction[] = [];
  const capture = captureCallReaction({ calls: { getCall: async id => id === 'call-1' ? call : null },
    context: () => ({ userId: 'u-vera', org: 'orgiq' }), store: { put: async row => { rows.push(row); } } });
  await capture(event);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tenant: 'orgiq', lobbyName: call.lobbyName, userId: 'u-vera', at: event.timestamp, emoji: '🎉' });
  expect(rows[0]).not.toHaveProperty('metadata');
  const item = recordedCallReactionItem(rows[0]!);
  expect(item['lobbyKey']).toBe('orgiq|orgiq:initiative:p-observability');
  expect(item['sk']).toBe(`${event.timestamp}#reaction-1`);
  expect(recordedCallReactionItem(rows[0]!)).toEqual(item); // duplicate delivery is the same official key
});

test.each([
  { targetId: 'message-1' }, { channel: 'orgiq:initiative:p-observability' }, { channel: 'orgiq:huddle:missing' },
  { userId: 'u-nora' }, { clientId: 'unseated' }, { timestamp: 'invalid' },
])('chat chips, spoofed senders, unseated sockets and unknown calls are not recorded: %j', async change => {
  const put = jest.fn();
  const capture = captureCallReaction({ calls: { getCall: async id => id === 'call-1' ? call : null },
    context: () => ({ userId: 'u-vera', org: 'orgiq' }), store: { put } });
  await capture({ ...event, ...change });
  expect(put).not.toHaveBeenCalled();
});

test('another tenant cannot file activity in this lobby; store failures stay observable', async () => {
  const put = jest.fn();
  await captureCallReaction({ calls: { getCall: async () => call }, context: () => ({ userId: 'u-vera', org: 'social' }), store: { put } })(event);
  expect(put).not.toHaveBeenCalled();
  const failed = captureCallReaction({ calls: { getCall: async () => call }, context: () => ({ userId: 'u-vera', org: 'orgiq' }),
    store: { put: async () => { throw new Error('Recording store unavailable'); } } });
  await expect(failed(event)).rejects.toThrow('Recording store unavailable');
});

test('capture never enables a cloud store with no explicit recording configuration', () => {
  expect(configuredCallReactionCapture({})).toBeNull();
  expect(configuredCallReactionCapture({ AWS_REGION: 'us-east-1', SOCIAL_CHAT_STORE: 'dynamo' })).toBeNull();
});

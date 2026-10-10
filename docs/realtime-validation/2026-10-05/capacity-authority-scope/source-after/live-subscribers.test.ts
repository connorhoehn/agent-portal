jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true } } }));
import { liveSubscribersForUsers } from '../realtime-gateway.js';

it('uses actual readable peer subscriptions and handles several tabs without adding unrequested users', async () => {
  const router = {
    getClientsByUserId: async () => [{ clientId: 'stale', userId: 'bob' }, { clientId: 'reading', userId: 'bob' },
      { clientId: 'elsewhere', userId: 'carol' }, { clientId: 'outsider', userId: 'outsider' }],
    isClientSubscribed: async (id: string, channel: string) => id === 'reading' && channel === 'social:dm:alice:bob',
  };
  expect(await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob', 'carol'])).toEqual(new Set(['bob']));
});

it('an unavailable lookup keeps conservative notification behavior', async () => {
  expect(await liveSubscribersForUsers({ getClientsByUserId: async () => { throw new Error('Redis unavailable'); },
    isClientSubscribed: () => true }, 'social:dm:alice:bob', ['bob'])).toBeNull();
});

it('legacy local routers retain their actual local subscription inventory', async () => {
  expect(await liveSubscribersForUsers({ channelMembers: new Map([['chat:social:dm:alice:bob', new Set(['local'])]]),
    getUserIdForClient: () => 'bob' }, 'social:dm:alice:bob', ['bob'])).toEqual(new Set(['bob']));
});

it('passes an active operation scope to every readable-subscription probe, and never a closed one', async () => {
  const { createAuthorityScope } = await import('@connorhoehnslalom/realtime-modules/server');
  const seen: unknown[] = [];
  const router = {
    getClientsByUserId: async () => [{ clientId: 'reading', userId: 'bob' }],
    isClientSubscribed: async (...args: unknown[]) => { seen.push(args[2]); return false; },
  };
  const scope = createAuthorityScope('chat.send');
  await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob'], scope);
  expect(seen).toEqual([{ scope }, { scope }]);
  scope.close(); seen.length = 0;
  await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob'], scope);
  expect(seen).toEqual([undefined, undefined]);
});

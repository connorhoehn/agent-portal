jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true } } }));
import { liveUsersOnChannel, type AuthorityScope } from '@connorhoehn/realtime-modules/server';
import { liveSubscribersForUsers } from '../realtime-gateway.js';

/** A router whose `liveUsersOn` is the library's own probe over these connections. */
function routerOver(clients: Array<{ clientId: string; userId: string }>, subscribed: (clientId: string, channel: string, opts?: { scope?: AuthorityScope }) => Promise<boolean>) {
  const inner = { getClientsByUserId: async () => clients, isClientSubscribed: subscribed };
  return { liveUsersOn: (channel: string, users: string[], opts?: { scope?: AuthorityScope }) => liveUsersOnChannel(inner, channel, users, opts) };
}

it('uses actual readable peer subscriptions and handles several tabs without adding unrequested users', async () => {
  const router = routerOver([{ clientId: 'stale', userId: 'bob' }, { clientId: 'reading', userId: 'bob' },
    { clientId: 'elsewhere', userId: 'carol' }, { clientId: 'outsider', userId: 'outsider' }],
  async (id, channel) => id === 'reading' && channel === 'social:dm:alice:bob');
  expect(await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob', 'carol'])).toEqual(new Set(['bob']));
});

it('counts a chat:-prefixed subscription as watching the bare channel', async () => {
  const router = routerOver([{ clientId: 'prefixed', userId: 'bob' }], async (_id, channel) => channel === 'chat:social:dm:alice:bob');
  expect(await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob'])).toEqual(new Set(['bob']));
});

it('an unavailable lookup keeps conservative notification behavior', async () => {
  expect(await liveSubscribersForUsers({ liveUsersOn: async () => { throw new Error('Redis unavailable'); } }, 'social:dm:alice:bob', ['bob'])).toBeNull();
  expect(await liveSubscribersForUsers({}, 'social:dm:alice:bob', ['bob'])).toBeNull();
});

it('passes an active operation scope to every readable-subscription probe, and never a closed one', async () => {
  const { createAuthorityScope } = await import('@connorhoehn/realtime-modules/server');
  const seen: unknown[] = [];
  const router = routerOver([{ clientId: 'reading', userId: 'bob' }], async (_id, _channel, opts) => { seen.push(opts); return false; });
  const scope = createAuthorityScope('chat.send');
  await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob'], scope);
  expect(seen).toEqual([{ scope }, { scope }]);
  scope.close(); seen.length = 0;
  await liveSubscribersForUsers(router, 'social:dm:alice:bob', ['bob'], scope);
  expect(seen).toEqual([undefined, undefined]);
});

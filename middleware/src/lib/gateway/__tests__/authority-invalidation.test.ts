// The seam's own mechanics: the epoch key, the bound cache, the peer hop.
import { AUTHORITY_PEER_TOPIC, authorityEpoch, applyChannel, bindAuthorityCache, invalidateAll, invalidateChannel,
  invalidateForUser, type AuthorityPeerEvents } from '../authority-invalidation.js';

function fakeCache() {
  return { invalidateChannel: jest.fn(), invalidateUser: jest.fn(), clear: jest.fn() };
}
function fakePeers() {
  const handlers = new Map<string, (payload: string) => void>();
  const published: Array<[string, string]> = [];
  const peers: AuthorityPeerEvents = {
    publish: async (topic, payload) => { published.push([topic, payload]); },
    subscribe: (topic, handler) => { handlers.set(topic, handler); return () => handlers.delete(topic); },
  };
  return { peers, published, deliver: (payload: string) => handlers.get(AUTHORITY_PEER_TOPIC)?.(payload), handlers };
}

it('the epoch key moves with the user, the masquerading actor and the global generation, not with others', () => {
  const ctx = { userId: 'u-a', epoch: 3 };
  const masq = { userId: 'u-a', epoch: 3, act: { sub: 'u-admin', epoch: 1 } };
  const k0 = authorityEpoch(ctx), m0 = authorityEpoch(masq);
  invalidateForUser('u-other');
  expect(authorityEpoch(ctx)).toBe(k0);
  invalidateForUser('u-admin');
  expect(authorityEpoch(ctx)).toBe(k0);
  expect(authorityEpoch(masq)).not.toBe(m0);
  invalidateForUser('u-a');
  const k1 = authorityEpoch(ctx);
  expect(k1).not.toBe(k0);
  invalidateAll('test');
  expect(authorityEpoch(ctx)).not.toBe(k1);
  expect(authorityEpoch({ userId: 'u-a', epoch: 4 })).not.toBe(authorityEpoch(ctx));
  expect(authorityEpoch(null)).toBeNull();
  expect(authorityEpoch({ userId: 'u-a', epoch: 'x' })).toBeNull();
});

it('drives the bound cache, including the names derived from a Social conversation', () => {
  const cache = fakeCache();
  const unbind = bindAuthorityCache(cache);
  try {
    invalidateForUser('u-a');
    invalidateChannel('social:ch:general');
    invalidateChannel('orgiq:huddle:c1');
    invalidateAll('test');
    expect(cache.invalidateUser).toHaveBeenCalledWith('u-a');
    expect(cache.invalidateChannel.mock.calls.map(c => c[0])).toEqual([
      'social:ch:general', 'social:workgraph:conversation:social:ch:general', 'orgiq:huddle:c1']);
    expect(cache.clear).toHaveBeenCalledTimes(1);
  } finally { unbind(); }
  invalidateForUser('u-b');
  expect(cache.invalidateUser).not.toHaveBeenCalledWith('u-b');
});

it('publishes local invalidations to the peers and applies theirs without re-publishing', async () => {
  const cache = fakeCache(), { peers, published, deliver } = fakePeers();
  const unbind = bindAuthorityCache(cache, { peers });
  try {
    invalidateForUser('u-a'); invalidateChannel('access:req:req-0001'); invalidateAll('cedar-policy');
    applyChannel('social:ch:x'); // membership: the router carries it, so no orgiq:authority publish
    await Promise.resolve();
    expect(published.map(([t, p]) => [t, JSON.parse(p)])).toEqual([
      [AUTHORITY_PEER_TOPIC, { op: 'user', id: 'u-a' }],
      [AUTHORITY_PEER_TOPIC, { op: 'channel', id: 'access:req:req-0001' }],
      [AUTHORITY_PEER_TOPIC, { op: 'all' }],
    ]);
    cache.invalidateUser.mockClear(); cache.clear.mockClear(); cache.invalidateChannel.mockClear();
    deliver(JSON.stringify({ op: 'user', id: 'u-z' }));
    deliver(JSON.stringify({ op: 'channel', id: 'assessment:team:TEAM-001' }));
    deliver(JSON.stringify({ op: 'all' }));
    deliver('not json'); deliver(JSON.stringify({ op: 'user', id: 42 }));
    expect(cache.invalidateUser).toHaveBeenCalledWith('u-z');
    expect(cache.invalidateChannel).toHaveBeenCalledWith('assessment:team:TEAM-001');
    expect(cache.clear).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(3);
  } finally { unbind(); }
});

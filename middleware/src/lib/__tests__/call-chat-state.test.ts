jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
import { MemoryCallChatStateStore } from '../call-chat-state.js';

it('preserves the floor on resume, replaces it on explicit rejoin, and retains a terminal tombstone', async () => {
  const store = new MemoryCallChatStateStore();
  try {
    expect((await store.join('call', 'alice', 'first', false)).members.alice).toEqual({ historyFrom: 'first', active: true });
    await store.leave('call', 'alice');
    expect((await store.join('call', 'alice', 'later', true)).members.alice).toEqual({ historyFrom: 'first', active: true });
    // A reconnect while still active changes nothing, not even the revision.
    const before = await store.get('call');
    expect(await store.join('call', 'alice', 'reconnect', true)).toEqual(before);
    await store.leave('call', 'alice');
    expect((await store.join('call', 'alice', 'latest', false)).members.alice).toEqual({ historyFrom: 'latest', active: true });
    const terminal = await store.finish('call'); expect(terminal.members).toEqual({});
    expect(await store.finish('call')).toEqual(terminal);
    await expect(store.join('call', 'bob', 'never', false)).rejects.toMatchObject({ status: 404 });
  } finally { store.dispose(); }
});

it('bounds memory state by TTL, renews it only while the call is active, and starts a fresh roster after expiry', async () => {
  let time = 1000; const store = new MemoryCallChatStateStore(60, () => time);
  try {
    await store.join('call', 'alice', 'first', false);
    time += 59000; await store.keepAlive('call'); time += 59000;
    expect((await store.get('call')).members.alice?.historyFrom).toBe('first');
    await store.finish('call'); time += 61000;
    expect(await store.get('call')).toEqual({ revision: 0, ended: false, members: {} });
    // A reused call id after expiry gets a new boundary, never the old one.
    expect((await store.join('call', 'alice', 'second', true)).members.alice?.historyFrom).toBe('second');
  } finally { store.dispose(); }
});

it('uses own keys for unusual user ids, returns detached records and caps membership', async () => {
  const store = new MemoryCallChatStateStore();
  try {
    const state = await store.join('call', '__proto__', 'first', false);
    state.members['__proto__']!.historyFrom = 'changed';
    expect((await store.get('call')).members['__proto__']?.historyFrom).toBe('first');
    expect(await store.join('call', 'constructor', 'first', false)).toMatchObject({ revision: 2 });
    for (let index = 2; index < 512; index += 1) await store.join('call', `u-${index}`, 'first', false);
    await expect(store.join('call', 'one-too-many', 'first', false)).rejects.toMatchObject({ status: 409 });
  } finally { store.dispose(); }
});

// Signed-envelope nonces shared across middleware replicas
// (lib/service-nonce-store.ts, layered by ServiceNonceGuard in service-auth.ts).
//
//   - first use accepted;
//   - a replay on a second "replica" (a second guard over the same store) refused;
//   - any store error refuses (fail closed), and so does a client that cannot be built;
//   - SERVICE_AUTH_REPLAY_TABLE unset behaves exactly as before (process only).

import { randomBytes } from 'node:crypto';
import express from 'express';
import request from '../../test-support/http.js';
import { signServiceRequest } from '@connorhoehn/service-runtime';
import {
  APPROVALS_SERVICE_AUTH,
  AGENT_SERVICE_ID,
  SERVICE_NONCE_HEADER,
  ServiceNonceGuard,
  captureRawBody,
  requireServiceAuth,
  resetServiceNonceCache,
} from '../service-auth.js';
import {
  DynamoNonceStore,
  REPLAY_ENDPOINT_ENV,
  REPLAY_KEY_PREFIX,
  REPLAY_TABLE_ENV,
  replayKey,
  setSharedNonceStore,
  sharedNonceStore,
  type NonceStore,
} from '../service-nonce-store.js';

const SECRET = 'shared-secret-value';
const SPEC = APPROVALS_SERVICE_AUTH;

/** An in-memory stand-in with DynamoDB's conditional-put semantics. */
class FakeStore implements NonceStore {
  readonly items = new Map<string, number>();
  fail: Error | null = null;
  async claim(key: string, nowMs: number, windowMs: number): Promise<boolean> {
    if (this.fail) throw this.fail;
    const exp = this.items.get(key);
    if (exp !== undefined && exp >= nowMs) return false;
    this.items.set(key, nowMs + windowMs);
    return true;
  }
}

afterEach(() => {
  delete process.env[SPEC.envVar];
  delete process.env[REPLAY_TABLE_ENV];
  delete process.env[REPLAY_ENDPOINT_ENV];
  setSharedNonceStore(undefined);
  resetServiceNonceCache();
  jest.restoreAllMocks();
});

function app() {
  const a = express();
  a.use(express.json({ verify: captureRawBody }));
  a.post('/callback', requireServiceAuth(SPEC), (_req, res) => { res.json({ ok: true }); });
  return a;
}

function signed(body: string) {
  const nonce = randomBytes(18).toString('base64url');
  const header = signServiceRequest(
    { method: 'POST', target: '/callback', body },
    { serviceId: AGENT_SERVICE_ID, secret: SECRET, audience: `${SPEC.signed!.audience}#${nonce}` },
  );
  return { 'X-Service-Auth': header, [SERVICE_NONCE_HEADER]: nonce, 'content-type': 'application/json' };
}

describe('ServiceNonceGuard over a shared store', () => {
  it('first use is accepted; the same nonce on a second replica is refused', async () => {
    const store = new FakeStore();
    const replicaA = new ServiceNonceGuard(() => store);
    const replicaB = new ServiceNonceGuard(() => store);
    const now = Date.now();
    await expect(replicaA.claim('orgiq-agent:n1', now)).resolves.toBe('ok');
    await expect(replicaB.claim('orgiq-agent:n1', now + 1000)).resolves.toBe('replayed');
    // The same replica refuses from its own cache without asking the store.
    store.fail = new Error('not consulted');
    await expect(replicaA.claim('orgiq-agent:n1', now + 2000)).resolves.toBe('replayed');
  });

  it('a store error refuses (fail closed)', async () => {
    const store = new FakeStore();
    store.fail = Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const guard = new ServiceNonceGuard(() => store);
    await expect(guard.claim('orgiq-agent:n2', Date.now())).resolves.toBe('store-unavailable');
  });

  it('with no store configured it is the process cache alone', async () => {
    const guard = new ServiceNonceGuard(() => null);
    const now = Date.now();
    await expect(guard.claim('orgiq-agent:n3', now)).resolves.toBe('ok');
    await expect(guard.claim('orgiq-agent:n3', now)).resolves.toBe('replayed');
    // A fresh process (another replica) has no memory of it: today's limit.
    await expect(new ServiceNonceGuard(() => null).claim('orgiq-agent:n3', now)).resolves.toBe('ok');
  });
});

describe('requireServiceAuth with the shared store', () => {
  it('accepts first use and refuses the captured request on another replica', async () => {
    process.env[SPEC.envVar] = SECRET;
    const store = new FakeStore();
    setSharedNonceStore(store);
    const body = JSON.stringify({ hello: 'world' });
    const headers = signed(body);
    expect((await request(app()).post('/callback').set(headers).send(body)).status).toBe(200);
    resetServiceNonceCache(); // the second replica's process has never seen it
    expect((await request(app()).post('/callback').set(headers).send(body)).status).toBe(401);
    expect([...store.items.keys()]).toHaveLength(1);
  });

  it('refuses a valid envelope when the store errors', async () => {
    process.env[SPEC.envVar] = SECRET;
    const store = new FakeStore();
    store.fail = new Error('unreachable');
    setSharedNonceStore(store);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const body = '{}';
    expect((await request(app()).post('/callback').set(signed(body)).send(body)).status).toBe(401);
  });

  it('unset table: no shared store, and a replay is refused by the process cache as before', async () => {
    process.env[SPEC.envVar] = SECRET;
    expect(sharedNonceStore()).toBeNull();
    const body = '{}';
    const headers = signed(body);
    expect((await request(app()).post('/callback').set(headers).send(body)).status).toBe(200);
    expect((await request(app()).post('/callback').set(headers).send(body)).status).toBe(401);
  });
});

describe('DynamoNonceStore', () => {
  const now = 1_800_000_000_000;

  it('writes one conditional put under the prefixed key, expiring with the window', async () => {
    const send = jest.fn().mockResolvedValue({});
    const store = new DynamoNonceStore('replay', { send } as never);
    await expect(store.claim('orgiq-agent:abc', now, 70_000)).resolves.toBe(true);
    const input = send.mock.calls[0][0].input;
    expect(input.TableName).toBe('replay');
    expect(input.Item.nonce_hash.S).toBe(replayKey('orgiq-agent:abc'));
    expect(input.Item.nonce_hash.S.startsWith(REPLAY_KEY_PREFIX)).toBe(true);
    expect(input.Item.caller.S).toBe('orgiq-agent');
    expect(Number(input.Item.expires_at.N)).toBe(Math.floor((now + 70_000) / 1000) + 1);
    expect(input.ConditionExpression).toBe('attribute_not_exists(nonce_hash) OR expires_at < :now');
    expect(input.ExpressionAttributeValues[':now'].N).toBe(String(now / 1000));
  });

  it('a live item (conditional failure) is a replay; any other error rejects', async () => {
    const conditional = Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    await expect(new DynamoNonceStore('t', { send: jest.fn().mockRejectedValue(conditional) } as never)
      .claim('orgiq-agent:x', now, 70_000)).resolves.toBe(false);
    const denied = Object.assign(new Error('no'), { name: 'AccessDeniedException' });
    await expect(new DynamoNonceStore('t', { send: jest.fn().mockRejectedValue(denied) } as never)
      .claim('orgiq-agent:x', now, 70_000)).rejects.toThrow('no');
  });

  it('the middleware key never collides with the agents\' bare digest', () => {
    expect(replayKey('orgiq-agent:abc')).toMatch(/^service-envelope#[0-9a-f]{64}$/);
  });

  it('a configured table builds a store from the environment', () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env[REPLAY_TABLE_ENV] = 'orgiq-signed-request-replay';
    process.env[REPLAY_ENDPOINT_ENV] = 'http://127.0.0.1:1';
    expect(sharedNonceStore()).toBeInstanceOf(DynamoNonceStore);
  });
});

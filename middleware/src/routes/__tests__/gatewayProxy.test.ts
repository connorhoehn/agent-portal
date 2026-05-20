// src/routes/__tests__/gatewayProxy.test.ts
//
// Unit tests for the gateway proxy routes (gateway-proxy.ts).
//
// Covers:
//   1. Unsigned passthrough — no GATEWAY_SERVICE_AUTH_SECRET set
//   2. Correct X-Service-Auth HMAC header added when secret is set
//   3. Gateway 4xx propagated verbatim
//   4. All 4 route shapes:
//      POST /api/gateway/channels/:id/messages
//      GET  /api/gateway/presence/:channel
//      GET  /api/gateway/chat/:channel/history
//      GET  /api/gateway/activity/:channel/history

import express from 'express';
import request from 'supertest';
import { createHmac } from 'crypto';
import { gatewayProxyRouter, _internal } from '../gateway-proxy.js';

// ─── Test app ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gateway', gatewayProxyRouter);
  return app;
}

// ─── fetch mock helpers ───────────────────────────────────────────────────────

type MockFetchResponse = {
  status: number;
  body: string;
};

function mockFetch(response: MockFetchResponse) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status: response.status,
      text: async () => response.body,
    } as unknown as Response;
  });
  (global as unknown as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return { impl, calls };
}

// ─── Env helpers ──────────────────────────────────────────────────────────────

const GATEWAY_URL = 'http://gateway:8080';

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
}

// ─── HMAC verification helper ─────────────────────────────────────────────────
//
// Verifies that the header value matches the wire format:
//   v1.<serviceId>.<tsSec>.<base64url-mac>
// where mac = HMAC-SHA256(secret, "<serviceId>.<tsSec>.<payload>")

function verifyAuthHeader(header: string, secret: string, payload: string): boolean {
  const parts = header.split('.');
  if (parts.length !== 4) return false;
  const [version, serviceId, tsStr, macB64url] = parts;
  if (version !== 'v1' || !tsStr || !macB64url) return false;
  const tsSec = Number(tsStr);
  if (!Number.isFinite(tsSec)) return false;

  const h = createHmac('sha256', secret);
  h.update(`${serviceId}.${tsSec}.${payload}`);
  const expected = h.digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return expected === macB64url;
}

// ─── _internal.buildAuthHeader ────────────────────────────────────────────────

describe('_internal.buildAuthHeader', () => {
  it('produces a v1 envelope with correct HMAC for empty payload', () => {
    const secret = 'test-secret';
    const header = _internal.buildAuthHeader(secret, '');
    expect(verifyAuthHeader(header, secret, '')).toBe(true);
  });

  it('produces a v1 envelope with correct HMAC for JSON payload', () => {
    const secret = 'test-secret';
    const payload = '{"hello":"world"}';
    const header = _internal.buildAuthHeader(secret, payload);
    expect(verifyAuthHeader(header, secret, payload)).toBe(true);
  });

  it('header starts with "v1.orgiq-middleware."', () => {
    const header = _internal.buildAuthHeader('s', '');
    expect(header.startsWith(`v1.${_internal.SERVICE_ID}.`)).toBe(true);
  });
});

// ─── POST /api/gateway/channels/:id/messages ─────────────────────────────────

describe('POST /api/gateway/channels/:id/messages', () => {
  const app = buildApp();

  it('forwards request to gateway and returns 200', async () => {
    const { calls } = mockFetch({ status: 200, body: JSON.stringify({ delivered: 3 }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app)
          .post('/api/gateway/channels/room-1/messages')
          .send({ payload: { type: 'ping' } });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ delivered: 3 });
        expect(calls[0]!.url).toBe(`${GATEWAY_URL}/api/channels/room-1/messages`);
        expect((calls[0]!.init as { method: string }).method).toBe('POST');
      },
    );
  });

  it('adds X-Service-Auth header when secret is set', async () => {
    const secret = 'my-secret';
    const { calls } = mockFetch({ status: 200, body: JSON.stringify({ delivered: 1 }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: secret },
      async () => {
        await request(app)
          .post('/api/gateway/channels/room-1/messages')
          .send({ payload: 'hello' });
        const headers = (calls[0]!.init as { headers: Record<string, string> }).headers;
        expect(headers[_internal.SERVICE_AUTH_HEADER]).toBeDefined();
        // The body sent to gateway should be the signed payload
        const sentBody = (calls[0]!.init as { body: string }).body as string;
        expect(verifyAuthHeader(headers[_internal.SERVICE_AUTH_HEADER]!, secret, sentBody)).toBe(true);
      },
    );
  });

  it('does NOT add X-Service-Auth header when no secret is set', async () => {
    const { calls } = mockFetch({ status: 200, body: JSON.stringify({ delivered: 0 }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        await request(app)
          .post('/api/gateway/channels/room-1/messages')
          .send({ payload: 'test' });
        const headers = (calls[0]!.init as { headers: Record<string, string> }).headers;
        expect(headers[_internal.SERVICE_AUTH_HEADER]).toBeUndefined();
      },
    );
  });

  it('propagates gateway 401 verbatim', async () => {
    mockFetch({ status: 401, body: JSON.stringify({ error: 'unauthorized' }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app)
          .post('/api/gateway/channels/room-1/messages')
          .send({ payload: 'test' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'unauthorized' });
      },
    );
  });

  it('propagates gateway 429 verbatim', async () => {
    mockFetch({ status: 429, body: JSON.stringify({ error: 'rate_limited' }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app)
          .post('/api/gateway/channels/room-1/messages')
          .send({ payload: 'hi' });
        expect(res.status).toBe(429);
      },
    );
  });

  it('URL-encodes channel id with special characters', async () => {
    const { calls } = mockFetch({ status: 200, body: JSON.stringify({ delivered: 0 }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        await request(app)
          .post('/api/gateway/channels/room%2F1/messages')
          .send({ payload: 'x' });
        // Express decodes the param; we re-encode it
        expect(calls[0]!.url).toContain('/api/channels/');
      },
    );
  });
});

// ─── GET /api/gateway/presence/:channel ──────────────────────────────────────

describe('GET /api/gateway/presence/:channel', () => {
  const app = buildApp();

  it('forwards GET to gateway presence endpoint', async () => {
    const { calls } = mockFetch({
      status: 200,
      body: JSON.stringify({ users: [{ userId: 'u1', joinedAt: 0 }] }),
    });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/presence/room-1');
        expect(res.status).toBe(200);
        expect(res.body.users).toHaveLength(1);
        expect(calls[0]!.url).toBe(`${GATEWAY_URL}/api/presence/room-1`);
        expect((calls[0]!.init as { method: string }).method).toBe('GET');
      },
    );
  });

  it('adds X-Service-Auth on GET when secret is set', async () => {
    const secret = 'presence-secret';
    const { calls } = mockFetch({ status: 200, body: JSON.stringify({ users: [] }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: secret },
      async () => {
        await request(app).get('/api/gateway/presence/room-1');
        const headers = (calls[0]!.init as { headers: Record<string, string> }).headers;
        expect(headers[_internal.SERVICE_AUTH_HEADER]).toBeDefined();
        // GET signs empty payload
        expect(verifyAuthHeader(headers[_internal.SERVICE_AUTH_HEADER]!, secret, '')).toBe(true);
      },
    );
  });

  it('propagates gateway 401', async () => {
    mockFetch({ status: 401, body: JSON.stringify({ error: 'unauthorized', code: 'AUTH_FAILED' }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/presence/room-1');
        expect(res.status).toBe(401);
      },
    );
  });
});

// ─── GET /api/gateway/chat/:channel/history ───────────────────────────────────

describe('GET /api/gateway/chat/:channel/history', () => {
  const app = buildApp();

  it('forwards GET to chat history endpoint', async () => {
    const messages = [{ id: 'm1', content: 'hello', userId: 'u1', timestamp: 0 }];
    const { calls } = mockFetch({ status: 200, body: JSON.stringify(messages) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/chat/room-1/history');
        expect(res.status).toBe(200);
        expect(res.body).toEqual(messages);
        expect(calls[0]!.url).toBe(`${GATEWAY_URL}/api/chat/room-1/history`);
      },
    );
  });

  it('forwards limit and before query params', async () => {
    const { calls } = mockFetch({ status: 200, body: JSON.stringify([]) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        await request(app).get('/api/gateway/chat/room-1/history?limit=10&before=m42');
        expect(calls[0]!.url).toContain('limit=10');
        expect(calls[0]!.url).toContain('before=m42');
      },
    );
  });

  it('adds X-Service-Auth on chat history when secret is set', async () => {
    const secret = 'chat-secret';
    const { calls } = mockFetch({ status: 200, body: JSON.stringify([]) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: secret },
      async () => {
        await request(app).get('/api/gateway/chat/room-1/history');
        const headers = (calls[0]!.init as { headers: Record<string, string> }).headers;
        expect(headers[_internal.SERVICE_AUTH_HEADER]).toBeDefined();
        expect(verifyAuthHeader(headers[_internal.SERVICE_AUTH_HEADER]!, secret, '')).toBe(true);
      },
    );
  });

  it('propagates gateway 500', async () => {
    mockFetch({ status: 500, body: JSON.stringify({ error: 'internal' }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/chat/room-1/history');
        expect(res.status).toBe(500);
      },
    );
  });
});

// ─── GET /api/gateway/activity/:channel/history ───────────────────────────────

describe('GET /api/gateway/activity/:channel/history', () => {
  const app = buildApp();

  it('forwards GET to activity history endpoint', async () => {
    const events = [{ id: 'e1', type: 'joined', userId: 'u1', timestamp: 0 }];
    const { calls } = mockFetch({ status: 200, body: JSON.stringify(events) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/activity/room-1/history');
        expect(res.status).toBe(200);
        expect(res.body).toEqual(events);
        expect(calls[0]!.url).toBe(`${GATEWAY_URL}/api/activity/room-1/history`);
      },
    );
  });

  it('forwards limit query param', async () => {
    const { calls } = mockFetch({ status: 200, body: JSON.stringify([]) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        await request(app).get('/api/gateway/activity/room-1/history?limit=25');
        expect(calls[0]!.url).toContain('limit=25');
      },
    );
  });

  it('adds X-Service-Auth on activity history when secret is set', async () => {
    const secret = 'activity-secret';
    const { calls } = mockFetch({ status: 200, body: JSON.stringify([]) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: secret },
      async () => {
        await request(app).get('/api/gateway/activity/room-1/history');
        const headers = (calls[0]!.init as { headers: Record<string, string> }).headers;
        expect(headers[_internal.SERVICE_AUTH_HEADER]).toBeDefined();
        expect(verifyAuthHeader(headers[_internal.SERVICE_AUTH_HEADER]!, secret, '')).toBe(true);
      },
    );
  });

  it('propagates gateway 404', async () => {
    mockFetch({ status: 404, body: JSON.stringify({ error: 'not_found' }) });
    await withEnv(
      { GATEWAY_URL, GATEWAY_SERVICE_AUTH_SECRET: undefined },
      async () => {
        const res = await request(app).get('/api/gateway/activity/room-1/history');
        expect(res.status).toBe(404);
      },
    );
  });
});

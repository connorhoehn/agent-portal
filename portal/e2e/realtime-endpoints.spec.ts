import { test, expect } from '@playwright/test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The portal learns the realtime gateway URL at run time from
// GET /api/session/realtime-token (`gatewayUrl`), so a deployed bundle needs
// no build-time VITE_GATEWAY_URL (docs/social-calls-deploy-plan.md §5).
//
// It must run against a Vite WITHOUT the local override, or the override wins
// by design. From portal/, with a middleware on :3011 (`PORT=3011 npm run
// dev:mock` in middleware/):
//
//   VITE_GATEWAY_URL= API_PROXY_TARGET=http://127.0.0.1:3011 npx vite --port 5184 --strictPort
//   npx playwright test e2e/realtime-endpoints.spec.ts
//
// REALTIME_ENDPOINTS_BASE_URL points it elsewhere.

test.use({ baseURL: process.env.REALTIME_ENDPOINTS_BASE_URL ?? 'http://localhost:5184' });

const STUB_TOKEN = 'e2e-stub-realtime-token';

/** A bare HTTP server that records each WebSocket upgrade's path and headers. */
async function handshakeRecorder(): Promise<{ server: Server; port: number; upgrades: Array<{ url: string; headers: IncomingHttpHeaders }> }> {
  const upgrades: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url ?? '', headers: req.headers });
    socket.destroy(); // recording the handshake is the point; the client just retries
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: (server.address() as AddressInfo).port, upgrades };
}

function stubToken(page: import('@playwright/test').Page, extra: Record<string, string>) {
  return page.route('**/api/session/realtime-token', (route) => route.fulfill({
    json: { token: STUB_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', ...extra },
    headers: { 'Cache-Control': 'no-store' },
  }));
}

test('the socket handshake targets the gatewayUrl from the realtime-token response', async ({ page }) => {
  const rec = await handshakeRecorder();
  try {
    const gatewayUrl = `http://127.0.0.1:${rec.port}/e2e-gateway`;
    await stubToken(page, { gatewayUrl });
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await page.goto('/');
    const expected = `ws://127.0.0.1:${rec.port}/e2e-gateway/ws`;
    await expect.poll(() => sockets.filter((u) => u.startsWith(expected)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    // Nothing went to the page's own origin or a :3001 default.
    expect(sockets.filter((u) => u.endsWith('/ws') && !u.startsWith(expected))).toEqual([]);
    // The handshake reached the stubbed host, carrying the token as the subprotocol.
    await expect.poll(() => rec.upgrades.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(rec.upgrades[0]!.url).toMatch(/^\/e2e-gateway\/ws/);
    expect(rec.upgrades[0]!.headers['sec-websocket-protocol']).toBe(`bearer-token-v1, ${STUB_TOKEN}`);
  } finally {
    await new Promise<void>((done) => rec.server.close(() => done()));
  }
});

test('with no gatewayUrl in the response and no override, no gateway socket opens', async ({ page }) => {
  await stubToken(page, {});
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.goto('/');
  await expect(page.locator('body')).not.toBeEmpty();
  await page.waitForTimeout(2_000);
  // Vite's HMR socket is the page's own origin with no /ws path; ignore it.
  expect(sockets.filter((u) => new URL(u).pathname.endsWith('/ws'))).toEqual([]);
});

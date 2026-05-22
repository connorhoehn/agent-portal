// src/routes/gateway-proxy.ts
//
// Signed proxy routes for the gateway's Wave 6 service-auth-gated endpoints.
// The browser cannot sign requests itself, so this middleware signs every
// outbound request via GatewayProxyClient (from @connorhoehn/realtime-modules)
// and forwards the call to the websocket-gateway.
//
// Mounted at /api/gateway/* in index.ts.
//
// Proxied gateway endpoints:
//   POST /api/channels/:id/messages   → POST <WEBSOCKET_GATEWAY_URL>/api/channels/:id/messages
//   GET  /api/presence/:channel       → GET  <WEBSOCKET_GATEWAY_URL>/api/presence/:channel
//   GET  /api/chat/:channel/history   → GET  <WEBSOCKET_GATEWAY_URL>/api/chat/:channel/history
//   GET  /api/activity/:channel/history → GET <WEBSOCKET_GATEWAY_URL>/api/activity/:channel/history
//
// Auth posture:
//   - When GATEWAY_SERVICE_AUTH_SECRET is set: GatewayProxyClient computes
//     X-Service-Auth: v1.orgiq-middleware.<ts>.<mac> automatically.
//   - When GATEWAY_SERVICE_AUTH_SECRET is unset in non-production: passes through
//     unsigned — the gateway logs a warning and allows it (dev posture).
//   - When GATEWAY_SERVICE_AUTH_SECRET is unset in production: the gateway will
//     reject; the error propagates verbatim to the caller.
//
// Gateway URL: WEBSOCKET_GATEWAY_URL env var (falls back to WS_GATEWAY_URL).
// Service identity: 'orgiq-middleware' (must be in gateway's
//   SERVICE_AUTH_ALLOWED_SERVICES env var).

import { Router } from 'express';
import {
  GatewayProxyClient,
  ProxyClientHttpError,
  ProxyClientNetworkError,
  ProxyClientTimeoutError,
} from '@connorhoehn/realtime-modules/proxy-client';
import { asyncHandler } from '../lib/async-handler.js';

export const gatewayProxyRouter = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_ID = 'orgiq-middleware';
const GATEWAY_TIMEOUT_MS = 10_000;

// ─── Client factory ───────────────────────────────────────────────────────────
//
// Reads env vars at call-time so tests can set them via withEnv(). Returns null
// when WEBSOCKET_GATEWAY_URL / WS_GATEWAY_URL is not set.

function makeClient(overrideFetch?: typeof fetch): GatewayProxyClient | null {
  const rawUrl =
    process.env['WEBSOCKET_GATEWAY_URL'] ?? process.env['WS_GATEWAY_URL'] ?? null;
  if (!rawUrl) return null;

  const secret = process.env['GATEWAY_SERVICE_AUTH_SECRET'] ?? undefined;
  return new GatewayProxyClient({
    gatewayUrl: rawUrl,
    ...(secret ? { serviceAuthSecret: secret, serviceAuthClientId: SERVICE_ID } : {}),
    timeout: GATEWAY_TIMEOUT_MS,
    ...(overrideFetch ? { fetch: overrideFetch } : {}),
  });
}

// Exported for tests that need to inject a mock fetch into the client.
export let _fetchOverride: typeof fetch | undefined = undefined;

// ─── Error → Express response ─────────────────────────────────────────────────
//
// GatewayProxyClient throws ProxyClientHttpError for non-2xx responses.
// Re-forward the status + body verbatim so callers see the same error as the
// underlying gateway returned.

function handleClientError(err: unknown, res: import('express').Response): boolean {
  if (err instanceof ProxyClientHttpError) {
    const httpErr = err as ProxyClientHttpError;
    const body = httpErr.body ?? JSON.stringify({ error: httpErr.message });
    res.status(httpErr.status).set('Content-Type', 'application/json').send(body);
    return true;
  }
  if (err instanceof ProxyClientTimeoutError) {
    const timeoutErr = err as ProxyClientTimeoutError;
    res.status(504).json({ error: 'gateway timeout', details: timeoutErr.message });
    return true;
  }
  if (err instanceof ProxyClientNetworkError) {
    const netErr = err as ProxyClientNetworkError;
    res.status(502).json({ error: 'gateway unreachable', details: netErr.message });
    return true;
  }
  return false;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/gateway/channels/:id/messages
// → POST <WEBSOCKET_GATEWAY_URL>/api/channels/:id/messages
gatewayProxyRouter.post('/channels/:id/messages', asyncHandler(async (req, res) => {
  const channelId = req.params['id'] as string;
  if (!channelId) {
    res.status(400).json({ error: 'channel id is required' });
    return;
  }
  const client = makeClient(_fetchOverride);
  if (!client) { res.json({ ok: true }); return; }

  try {
    const result = await client.publishToChannel(channelId, req.body ?? {});
    res.json(result);
  } catch (err) {
    if (!handleClientError(err, res)) throw err;
  }
}));

// GET /api/gateway/presence/:channel
// → GET <WEBSOCKET_GATEWAY_URL>/api/presence/:channel
gatewayProxyRouter.get('/presence/:channel', asyncHandler(async (req, res) => {
  const channel = req.params['channel'] as string;
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const client = makeClient(_fetchOverride);
  if (!client) { res.json({ users: [] }); return; }

  try {
    const result = await client.getPresence(channel);
    res.json(result);
  } catch (err) {
    if (!handleClientError(err, res)) throw err;
  }
}));

// GET /api/gateway/chat/:channel/history[?limit=N&before=ID]
// → GET <WEBSOCKET_GATEWAY_URL>/api/chat/:channel/history[?limit=N&before=ID]
gatewayProxyRouter.get('/chat/:channel/history', asyncHandler(async (req, res) => {
  const channel = req.params['channel'] as string;
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const client = makeClient(_fetchOverride);
  if (!client) { res.json({ messages: [] }); return; }

  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const before = req.query['before'] ? String(req.query['before']) : undefined;

  try {
    const result = await client.getChatHistory(channel, { limit, before });
    res.json(result);
  } catch (err) {
    if (!handleClientError(err, res)) throw err;
  }
}));

// GET /api/gateway/activity/:channel/history[?limit=N]
// → GET <WEBSOCKET_GATEWAY_URL>/api/activity/:channel/history[?limit=N]
gatewayProxyRouter.get('/activity/:channel/history', asyncHandler(async (req, res) => {
  const channel = req.params['channel'] as string;
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const client = makeClient(_fetchOverride);
  if (!client) { res.json({ events: [] }); return; }

  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;

  try {
    const result = await client.getActivityHistory(channel, { limit });
    res.json(result);
  } catch (err) {
    if (!handleClientError(err, res)) throw err;
  }
}));

// ─── Exports for testing ──────────────────────────────────────────────────────

export const _internal = {
  SERVICE_ID,
  makeClient,
};

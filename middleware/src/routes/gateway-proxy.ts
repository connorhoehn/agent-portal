// src/routes/gateway-proxy.ts
//
// Signed proxy routes for the gateway's Wave 6 service-auth-gated endpoints.
// The browser cannot sign requests itself, so this middleware adds the
// X-Service-Auth HMAC envelope and forwards the call to the gateway.
//
// Mounted at /api/gateway/* in index.ts.
//
// Proxied gateway endpoints:
//   POST /api/channels/:id/messages   → POST <GATEWAY_URL>/api/channels/:id/messages
//   GET  /api/presence/:channel       → GET  <GATEWAY_URL>/api/presence/:channel
//   GET  /api/chat/:channel/history   → GET  <GATEWAY_URL>/api/chat/:channel/history
//   GET  /api/activity/:channel/history → GET <GATEWAY_URL>/api/activity/:channel/history
//
// Auth posture:
//   - When GATEWAY_SERVICE_AUTH_SECRET is set: signs every outbound request with
//     X-Service-Auth: v1.orgiq-middleware.<ts>.<mac>
//   - When GATEWAY_SERVICE_AUTH_SECRET is unset in non-production: passes through
//     unsigned — the gateway logs a warning and allows it (dev posture).
//   - When GATEWAY_SERVICE_AUTH_SECRET is unset in production: the gateway will
//     503; we do not block the call here so the gateway's own error propagates.
//
// Gateway URL: GATEWAY_URL env var (already consumed by agentcore config).
// Service identity: 'orgiq-middleware' (add to gateway's
//   SERVICE_AUTH_ALLOWED_SERVICES env var).

import { Router } from 'express';
import { createHmac } from 'crypto';
import { asyncHandler } from '../lib/async-handler.js';

export const gatewayProxyRouter = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_ID = 'orgiq-middleware';
const SERVICE_AUTH_HEADER = 'X-Service-Auth';
const GATEWAY_TIMEOUT_MS = 10_000;

// ─── HMAC envelope builder ────────────────────────────────────────────────────
//
// Wire format: v1.<serviceId>.<unixTsSec>.<base64url(HMAC-SHA256)>
// Matches @connorhoehn/service-runtime signEnvelope() byte-for-byte.
//
// The MAC input is: "<serviceId>.<unixTsSec>.<canonicalPayload>"
// For GET requests (no body) the payload is the empty string.
// For POST requests the payload is the JSON body string.

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAuthHeader(secret: string, payload: string): string {
  const tsSec = Math.floor(Date.now() / 1000);
  const h = createHmac('sha256', secret);
  h.update(`${SERVICE_ID}.${tsSec}.${payload}`);
  const mac = h.digest();
  return `v1.${SERVICE_ID}.${tsSec}.${base64url(mac)}`;
}

// ─── Gateway fetch helper ─────────────────────────────────────────────────────

interface GatewayFetchOpts {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  secret?: string;
}

async function gatewayFetch(opts: GatewayFetchOpts): Promise<{ status: number; body: string }> {
  const { method, url, body, secret } = opts;
  const payload = body ?? '';

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (method === 'POST' && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (secret) {
    headers[SERVICE_AUTH_HEADER] = buildAuthHeader(secret, payload);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? payload : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  return { status: response.status, body: text };
}

// ─── Route helpers ────────────────────────────────────────────────────────────

function getGatewayUrl(): string {
  const url = process.env.GATEWAY_URL;
  if (!url) throw new Error('GATEWAY_URL is not configured');
  return url.replace(/\/+$/, '');
}

function getSecret(): string | undefined {
  return process.env.GATEWAY_SERVICE_AUTH_SECRET || undefined;
}

function forwardResponse(
  res: import('express').Response,
  status: number,
  body: string,
): void {
  res.status(status).set('Content-Type', 'application/json').send(body);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/gateway/channels/:id/messages
// → POST <GATEWAY_URL>/api/channels/:id/messages
gatewayProxyRouter.post('/channels/:id/messages', asyncHandler(async (req, res) => {
  const channelId = req.params['id'];
  if (!channelId) {
    res.status(400).json({ error: 'channel id is required' });
    return;
  }
  const payload = JSON.stringify(req.body ?? {});
  const { status, body } = await gatewayFetch({
    method: 'POST',
    url: `${getGatewayUrl()}/api/channels/${encodeURIComponent(channelId)}/messages`,
    body: payload,
    secret: getSecret(),
  });
  forwardResponse(res, status, body);
}));

// GET /api/gateway/presence/:channel
// → GET <GATEWAY_URL>/api/presence/:channel
gatewayProxyRouter.get('/presence/:channel', asyncHandler(async (req, res) => {
  const channel = req.params['channel'];
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const { status, body } = await gatewayFetch({
    method: 'GET',
    url: `${getGatewayUrl()}/api/presence/${encodeURIComponent(channel)}`,
    secret: getSecret(),
  });
  forwardResponse(res, status, body);
}));

// GET /api/gateway/chat/:channel/history[?limit=N&before=ID]
// → GET <GATEWAY_URL>/api/chat/:channel/history[?limit=N&before=ID]
gatewayProxyRouter.get('/chat/:channel/history', asyncHandler(async (req, res) => {
  const channel = req.params['channel'];
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const params = new URLSearchParams();
  if (req.query['limit']) params.set('limit', String(req.query['limit']));
  if (req.query['before']) params.set('before', String(req.query['before']));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const { status, body } = await gatewayFetch({
    method: 'GET',
    url: `${getGatewayUrl()}/api/chat/${encodeURIComponent(channel)}/history${qs}`,
    secret: getSecret(),
  });
  forwardResponse(res, status, body);
}));

// GET /api/gateway/activity/:channel/history[?limit=N]
// → GET <GATEWAY_URL>/api/activity/:channel/history[?limit=N]
gatewayProxyRouter.get('/activity/:channel/history', asyncHandler(async (req, res) => {
  const channel = req.params['channel'];
  if (!channel) {
    res.status(400).json({ error: 'channel is required' });
    return;
  }
  const params = new URLSearchParams();
  if (req.query['limit']) params.set('limit', String(req.query['limit']));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const { status, body } = await gatewayFetch({
    method: 'GET',
    url: `${getGatewayUrl()}/api/activity/${encodeURIComponent(channel)}/history${qs}`,
    secret: getSecret(),
  });
  forwardResponse(res, status, body);
}));

// ─── Exports for testing ──────────────────────────────────────────────────────

export const _internal = {
  buildAuthHeader,
  SERVICE_ID,
  SERVICE_AUTH_HEADER,
};

// Public drop endpoint — the only unauthenticated write surface in the app.
//
// Mounted without requireAction, because the whole point is that the person
// using it has no account here. The token in the URL is the entire authority,
// so this router is deliberately small: describe a link, accept a file. It
// exposes no bucket name, no prefix, no knowledge-base id, and no way to list
// what is already there.
//
// Bytes arrive as a raw body rather than multipart. There is no multipart
// parser in this service, and adding one to accept untrusted uploads is a
// larger attack surface than reading a Buffer — the browser can post a File
// directly as the request body, so the format buys nothing here.

import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { describeLinkForRecipient, uploadViaLink } from '../providers/upload-links.js';

export const dropRouter: Router = Router();

/**
 * Per-client throttle for the one endpoint anyone on the internet can reach.
 *
 * The token is 256 bits, so guessing one is not the worry; unbounded requests
 * are. Every valid upload writes to S3 and every lookup hits Aurora, so a
 * leaked link — or just a loop — turns into spend with nothing in the way.
 *
 * Deliberately in-memory and per-process: this is a blunt ceiling to keep a
 * runaway client from costing money, not a distributed rate limiter. If the
 * middleware is ever run multi-replica behind the ALB, the real limit is this
 * times the replica count, which is still bounded.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const _hits = new Map<string, { count: number; resetAt: number }>();

function throttled(key: string): boolean {
  const now = Date.now();
  const slot = _hits.get(key);
  if (!slot || now >= slot.resetAt) {
    _hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic sweep — without it the map grows one entry per distinct
    // client forever, which is the leak a rate limiter is supposed to prevent.
    if (_hits.size > 5000) {
      for (const [k, v] of _hits) if (now >= v.resetAt) _hits.delete(k);
    }
    return false;
  }
  slot.count++;
  return slot.count > MAX_REQUESTS_PER_WINDOW;
}

/** Express resolves the client through the configured trust-proxy boundary. */
function clientKey(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Throttle as middleware, so it can run *before* the body parser.
 *
 * Checking inside the handler meant express.raw had already buffered up to
 * 50 MB into memory before the request was refused — the flood still cost
 * bandwidth and heap, which is most of what the limit is for.
 */
function rateLimit(
  req: express.Request, res: express.Response, next: express.NextFunction,
): void {
  if (throttled(clientKey(req))) {
    res.status(429).json({ error: 'Too many requests — slow down.' });
    return;
  }
  next();
}

/** Refusals the recipient caused, versus ones they cannot act on. */
const STATUS_FOR_REFUSAL: Record<string, number> = {
  'unknown-link': 404,
  revoked: 410,
  expired: 410,
  exhausted: 409,
  'too-large': 413,
  'bad-type': 415,
  empty: 400,
};

// ─── GET /:token — what this link is for ──────────────────────────────────────

dropRouter.get('/:token', rateLimit, asyncHandler(async (req, res) => {
  const view = await describeLinkForRecipient(String(req.params['token'] ?? ''));
  if (!view) {
    // Same answer for a malformed token, an unknown one, and a deleted one.
    res.status(404).json({ error: 'This upload link is not valid.' });
    return;
  }
  res.json(view);
}));

// ─── POST /:token/upload?filename=… — accept one file ─────────────────────────

dropRouter.post(
  '/:token/upload',
  // Before express.raw, on purpose — see rateLimit.
  rateLimit,
  // The cap here is a backstop for the socket; the per-link limit is enforced
  // in the provider, which is the only place that knows what this link allows.
  express.raw({ type: '*/*', limit: '50mb' }),
  asyncHandler(async (req, res) => {
    const token = String(req.params['token'] ?? '');
    const filename = String(req.query['filename'] ?? '').trim();
    if (!filename) {
      res.status(400).json({ error: 'filename query parameter is required' });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentType = req.get('content-type') ?? 'application/octet-stream';

    const result = await uploadViaLink(token, filename, body, contentType);
    if (!result.ok) {
      res.status(STATUS_FOR_REFUSAL[result.refusal] ?? 400)
        .json({ error: result.detail, refusal: result.refusal });
      return;
    }

    // The key is echoed so the uploader sees their file was stored under a
    // name, but nothing about where. Callers upload one file per request so a
    // partial batch is unambiguous about which files landed.
    res.json({ ok: true, filename, bytes: result.bytes });
  }),
);

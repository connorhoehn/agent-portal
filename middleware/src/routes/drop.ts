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

dropRouter.get('/:token', asyncHandler(async (req, res) => {
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

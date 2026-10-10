import cors from 'cors';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { viewerScheme } from './trusted-proxy.js';

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** Reject untrusted browser origins before they can read or mutate a session.
 * Non-browser clients without Origin still use the route's normal auth gates.
 * Production allows the API's own origin and explicitly configured frontends.
 */
/** The allowlist decision on its own, so the realtime upgrade
 *  (lib/distillation-realtime.ts) — which never passes through Express —
 *  applies exactly the rule the HTTP side does. `selfOrigin` is the API's own
 *  `proto://host` as the request saw it. */
export function isAllowedBrowserOrigin(origin: string, selfOrigin: string): boolean {
  const parsed = originOf(origin);
  const sameOrigin = originOf(selfOrigin);
  const configured = [
    config.cognito.portalOrigin,
    process.env['PUBLIC_BASE_URL'] ?? '',
    ...(process.env['CORS_ALLOWED_ORIGINS'] ?? '').split(','),
  ].map(value => originOf(value.trim())).filter(Boolean);
  const localDev = process.env['NODE_ENV'] !== 'production' && parsed !== null &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(parsed).hostname);
  return !(parsed === null || parsed !== origin ||
    !(parsed === sameOrigin || configured.includes(parsed) || localDev));
}

export const browserOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (!origin) { next(); return; }
  // The viewer's scheme, not the last hop's: behind CloudFront the ALB reports
  // `http` for an `https://` page (lib/trusted-proxy.ts `viewerScheme`).
  if (!isAllowedBrowserOrigin(origin, `${viewerScheme(req)}://${req.get('host') ?? ''}`)) {
    res.status(403).json({ error: 'Browser origin is not allowed' });
    return;
  }
  cors({ origin, credentials: true })(req, res, next);
};

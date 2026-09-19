import cors from 'cors';
import type { RequestHandler } from 'express';
import { config } from '../config.js';

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
export const browserOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (!origin) { next(); return; }
  const parsed = originOf(origin);
  const sameOrigin = originOf(`${req.protocol}://${req.get('host') ?? ''}`);
  const configured = [
    config.cognito.portalOrigin,
    process.env['PUBLIC_BASE_URL'] ?? '',
    ...(process.env['CORS_ALLOWED_ORIGINS'] ?? '').split(','),
  ].map(value => originOf(value.trim())).filter(Boolean);
  const localDev = process.env['NODE_ENV'] !== 'production' && parsed !== null &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(parsed).hostname);
  if (parsed === null || parsed !== origin ||
      !(parsed === sameOrigin || configured.includes(parsed) || localDev)) {
    res.status(403).json({ error: 'Browser origin is not allowed' });
    return;
  }
  cors({ origin, credentials: true })(req, res, next);
};

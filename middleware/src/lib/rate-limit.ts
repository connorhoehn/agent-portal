// Minimal in-memory sliding-window rate limiter for session mutation
// endpoints. Per-IP, per-bucket; process-local by design — with horizontal
// scaling each replica enforces its own window, which is still a meaningful
// brake on credentialless brute-forcing of /login and /masquerade. Swap for
// an ALB/WAF rule or Redis when the middleware scales out.

import type { Request, Response, NextFunction } from 'express';

interface Window { count: number; resetAt: number }

const windows = new Map<string, Window>();
const SWEEP_INTERVAL_MS = 60_000;

// Periodically drop expired windows so long-running processes don't accumulate
// one entry per client IP forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

function clientKey(req: Request): string {
  // Behind the ALB, X-Forwarded-For's first hop is the client. Locally it's
  // just the socket address.
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/**
 * Returns middleware allowing `max` requests per `windowMs` per client IP for
 * the given bucket. Over-limit requests get 429 with a Retry-After header.
 */
export function rateLimit(bucket: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${bucket}|${clientKey(req)}`;
    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > max) {
      res.setHeader('Retry-After', Math.ceil((w.resetAt - now) / 1000));
      res.status(429).json({ error: 'Too many requests', bucket });
      return;
    }
    next();
  };
}

/** Test hook: clear all windows. */
export function resetRateLimits(): void {
  windows.clear();
}

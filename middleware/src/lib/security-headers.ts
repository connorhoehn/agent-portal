import type { NextFunction, Request, Response } from 'express';

/**
 * Hardening headers for every middleware response (helmet is not a
 * dependency, so these are the equivalents set by hand). The CSP is the
 * strictest one: the middleware answers JSON, never a document, so nothing may
 * load or frame. The two download routes set their own `sandbox` CSP after
 * this runs, and setHeader there replaces this value.
 *
 * HSTS is sent only when the request itself was TLS: `req.secure` honours
 * `trust proxy` (TRUST_PROXY_HOPS), so a forwarded https counts only behind an
 * enforced proxy and plain-http local servers never pin a browser to https.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

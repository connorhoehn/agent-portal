// Signed-cookie session for masquerade roles. The secret is fetched from
// Secrets Manager at boot. Cookie payload is base64url(JSON) + base64url(HMAC).
//
// This intentionally accepts no real authentication today — every request that
// doesn't already carry a session cookie is implicitly the "demo-user" identity.
// When real auth is added later, the user identity will come from a Cognito JWT
// and the role will be looked up server-side; the cookie shape stays the same.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from '../config.js';

export const ROLES = ['member', 'org-leader', 'hr-admin'] as const;
export type Role = typeof ROLES[number];

export const DEFAULT_ROLE: Role = 'member';
export const COOKIE_NAME = 'orgiq.session';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

export interface Session {
  sub: string;
  role: Role;
  iat: number;
}

let signingKey: string | null = null;

async function loadSigningKey(): Promise<string> {
  if (signingKey) return signingKey;
  const arn = config.auth.sessionSigningSecretArn;
  if (!arn) {
    // Dev fallback: deterministic key so restarts don't invalidate cookies.
    // CDK populates the real secret in production.
    signingKey = process.env['SESSION_SIGNING_KEY_DEV'] ?? 'orgiq-dev-signing-key-change-me';
    return signingKey;
  }
  const sm = new SecretsManagerClient({ region: config.region });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  signingKey = out.SecretString ?? '';
  if (!signingKey) throw new Error(`Empty SecretString at ${arn}`);
  return signingKey;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export async function signSession(session: Session): Promise<string> {
  const key = await loadSigningKey();
  const payload = b64url(JSON.stringify(session));
  const mac = b64url(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${mac}`;
}

export async function verifySession(cookieValue: string): Promise<Session | null> {
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = cookieValue.slice(0, dot);
  const macStr = cookieValue.slice(dot + 1);
  const key = await loadSigningKey();
  const expected = createHmac('sha256', key).update(payload).digest();
  const provided = fromB64url(macStr);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const obj = JSON.parse(fromB64url(payload).toString('utf8')) as Session;
    if (typeof obj.sub !== 'string' || !ROLES.includes(obj.role as Role)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, value: string): void {
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

/**
 * Resolve the caller's session from the cookie and attach to req.session.
 * Falls back to a demo-user / member identity if no cookie is present so the
 * app stays usable without an explicit login step.
 */
export function sessionMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (raw) {
      const verified = await verifySession(raw);
      if (verified) {
        req.session = verified;
        next();
        return;
      }
    }
    req.session = { sub: 'demo-user', role: DEFAULT_ROLE, iat: Math.floor(Date.now() / 1000) };
    next();
  };
}

// Signed-cookie session with per-tenant role grants and masquerade provenance.
// The secret is fetched from Secrets Manager at boot. Cookie payload is
// base64url(JSON) + base64url(HMAC).
//
// Authentication is still deliberately lightweight: login is a user picker
// (POST /api/session/login) against the app_users table, and requests with no
// cookie fall back to the permissive "demo-user" identity. mintSession() is the
// single choke point that turns an identity + grants into a session, so a real
// authenticator (e.g. a Cognito OIDC callback) can slot in later by resolving
// its subject to an app_users row and calling the same function.
//
// The tenancy invariant lives here: session.role is only ever valid for
// session.tenant, and every role/tenant switch is validated against
// session.grants (loaded from user_tenant_roles at login). Roles never
// cross-pollinate between tenants.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from '../config.js';

export const TENANTS = ['orgiq', 'newsroom'] as const;
export type Tenant = typeof TENANTS[number];

// Role vocabulary per tenant. Must match the Cedar seeds in
// middleware/seeds/roles/{tenant}/. 'admin' is cross-tenant: it can hold a
// grant in any tenant and is the only role permitted to masquerade.
export const ROLES_BY_TENANT: Record<Tenant, readonly string[]> = {
  orgiq: ['member', 'org-leader', 'hr-admin'],
  newsroom: ['reporter', 'editor'],
};
export const ADMIN_ROLE = 'admin';

// Legacy export — the orgiq role list. Prefer ROLES_BY_TENANT.
export const ROLES = ROLES_BY_TENANT.orgiq as readonly ['member', 'org-leader', 'hr-admin'];
export type Role = 'member' | 'org-leader' | 'hr-admin' | 'reporter' | 'editor' | 'admin';

export const DEFAULT_ROLE: Role = 'member';
export const DEFAULT_TENANT: Tenant = 'orgiq';
export const COOKIE_NAME = 'orgiq.session';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

/** tenant id → roles the user holds there. Loaded from user_tenant_roles. */
export type Grants = Record<string, string[]>;

/** The real identity behind a masqueraded session, so it can be restored and audited. */
export interface Actor {
  sub: string;
  name?: string;
  role: Role;
  tenant: Tenant;
  grants: Grants;
}

export interface Session {
  sub: string;
  name?: string;
  role: Role;
  tenant: Tenant;
  grants: Grants;
  /** Present only while masquerading: the real (authenticated) identity. */
  act?: Actor;
  iat: number;
}

/** Grants used for the cookie-less demo identity and legacy cookies: every role
 * in every tenant, so the demo stays fully explorable without a login step.
 * Seeded users get real (constrained) grants — that's where isolation shows. */
export function permissiveGrants(): Grants {
  const g: Grants = {};
  for (const t of TENANTS) g[t] = [...ROLES_BY_TENANT[t], ADMIN_ROLE];
  return g;
}

export function rolesForTenant(grants: Grants, tenant: string): string[] {
  return grants[tenant] ?? [];
}

export function hasGrant(grants: Grants, tenant: string, role: string): boolean {
  return rolesForTenant(grants, tenant).includes(role);
}

// Privilege rank, lower = less privileged. Used to choose a login landing role.
const ROLE_RANK: Record<string, number> = {
  member: 0, reporter: 0, 'org-leader': 1, editor: 1, 'hr-admin': 2, admin: 99,
};

/**
 * The role a session lands on when none is explicitly preferred: the
 * least-privileged non-admin role held, chosen deterministically (rank, then
 * name). A multi-role user therefore always starts in the same minimal role and
 * escalates explicitly via the switcher — instead of the old "first grant in DB
 * order", which varied with `granted_at` ties between the Aurora and fallback
 * paths. Falls back to admin only when that's the only role held.
 */
export function landingRole(held: readonly string[]): Role {
  const nonAdmin = held.filter(r => r !== ADMIN_ROLE);
  const pool = nonAdmin.length > 0 ? nonAdmin : held;
  return [...pool].sort(
    (a, b) => (ROLE_RANK[a] ?? 50) - (ROLE_RANK[b] ?? 50) || a.localeCompare(b),
  )[0] as Role;
}

/**
 * Single choke point for creating a session from an identity + grants.
 * Picks a valid (tenant, role) pair from the grants, preferring the requested
 * ones when they're actually held. Returns null if the user holds no grants.
 */
export function mintSession(
  user: { id: string; displayName?: string },
  grants: Grants,
  prefer?: { tenant?: string; role?: string },
  act?: Actor,
): Session | null {
  const tenants = TENANTS.filter(t => rolesForTenant(grants, t).length > 0);
  if (tenants.length === 0) return null;
  const tenant = (prefer?.tenant && tenants.includes(prefer.tenant as Tenant))
    ? prefer.tenant as Tenant
    : tenants.includes(DEFAULT_TENANT) ? DEFAULT_TENANT : tenants[0]!;
  const held = rolesForTenant(grants, tenant);
  const role = (prefer?.role && held.includes(prefer.role))
    ? prefer.role as Role
    : landingRole(held);
  const session: Session = {
    sub: user.id,
    role,
    tenant,
    grants,
    iat: Math.floor(Date.now() / 1000),
  };
  if (user.displayName) session.name = user.displayName;
  if (act) session.act = act;
  return session;
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

/** Sign an arbitrary short-lived JSON payload (e.g. the OIDC state/PKCE cookie)
 * with the same HMAC key as the session cookie. Returns "payload.mac". */
export async function signValue(value: unknown): Promise<string> {
  const key = await loadSigningKey();
  const payload = b64url(JSON.stringify(value));
  const mac = b64url(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${mac}`;
}

/** Verify + parse a value produced by signValue. Returns null on tamper/parse error. */
export async function verifyValue<T>(signed: string): Promise<T | null> {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = signed.slice(0, dot);
  const key = await loadSigningKey();
  const expected = createHmac('sha256', key).update(payload).digest();
  const provided = fromB64url(signed.slice(dot + 1));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    return JSON.parse(fromB64url(payload).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function isKnownRole(role: string): boolean {
  return role === ADMIN_ROLE || TENANTS.some(t => ROLES_BY_TENANT[t].includes(role));
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
    const raw = JSON.parse(fromB64url(payload).toString('utf8')) as Record<string, unknown>;
    if (typeof raw['sub'] !== 'string') return null;
    const role = raw['role'] as Role;
    if (typeof role !== 'string' || !isKnownRole(role)) return null;
    // Backward-compatible defaults: pre-tenancy cookies lack tenant/grants.
    const tenant: Tenant = TENANTS.includes(raw['tenant'] as Tenant)
      ? (raw['tenant'] as Tenant)
      : DEFAULT_TENANT;
    // Legacy (pre-tenancy) cookies carry no grants: treat them like the
    // cookie-less demo identity — permissive in dev, zero grants in prod.
    const grants: Grants = (raw['grants'] && typeof raw['grants'] === 'object')
      ? raw['grants'] as Grants
      : (demoModeEnabled() ? permissiveGrants() : {});
    const session: Session = {
      sub: raw['sub'] as string,
      role,
      tenant,
      grants,
      iat: (raw['iat'] as number) ?? 0,
    };
    if (typeof raw['name'] === 'string') session.name = raw['name'];
    if (raw['act'] && typeof raw['act'] === 'object') session.act = raw['act'] as Actor;
    // Enforce the invariant even against a stale-but-validly-signed cookie:
    // the active role must be held in the active tenant.
    if (!hasGrant(session.grants, session.tenant, session.role)) {
      const repaired = mintSession({ id: session.sub, displayName: session.name }, session.grants,
        { tenant: session.tenant }, session.act);
      return repaired;
    }
    return session;
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

/** True when cookie-less requests should get the fully-permissive demo
 * identity. Always on outside production; in production it must be opted into
 * explicitly (AUTH_DEMO_MODE=true), otherwise anonymous callers hold zero
 * grants and can neither switch tenants/roles nor pass any Cedar check. */
export function demoModeEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' || process.env['AUTH_DEMO_MODE'] === 'true';
}

export function demoSession(): Session {
  return {
    sub: 'demo-user',
    name: 'Demo User',
    role: DEFAULT_ROLE,
    tenant: DEFAULT_TENANT,
    grants: demoModeEnabled() ? permissiveGrants() : {},
    iat: Math.floor(Date.now() / 1000),
  };
}

/** How long a session may use its cookie-cached grants before they are
 * re-resolved from the identity store, so grant revocations reach live
 * sessions without waiting out the 7-day cookie. */
const GRANTS_REFRESH_S = parseInt(process.env['GRANTS_REFRESH_S'] ?? '120', 10);

/** Injected by index.ts at boot to avoid a static import cycle
 * (providers/identity imports types from this module). */
type GrantsResolver = (userId: string) => Promise<{ displayName: string; grants: Grants } | null>;
let grantsResolver: GrantsResolver | null = null;
export function setGrantsResolver(fn: GrantsResolver): void {
  grantsResolver = fn;
}

/**
 * Resolve the caller's session from the cookie and attach to req.session.
 * Falls back to the demo-user identity if no cookie is present (permissive in
 * dev, zero grants in production) so the app stays usable without a login
 * step. Real users' grants are re-resolved from the identity store every
 * GRANTS_REFRESH_S so revocations propagate to live sessions.
 */
export function sessionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (raw) {
      const verified = await verifySession(raw);
      if (verified) {
        const age = Math.floor(Date.now() / 1000) - verified.iat;
        const isRealUser = verified.sub !== 'demo-user' && !verified.act;
        if (isRealUser && grantsResolver && age > GRANTS_REFRESH_S) {
          try {
            const fresh = await grantsResolver(verified.sub);
            if (!fresh) {
              // User no longer exists — drop to the anonymous identity.
              clearSessionCookie(res);
              req.session = demoSession();
              next();
              return;
            }
            const reminted = mintSession(
              { id: verified.sub, displayName: fresh.displayName },
              fresh.grants,
              { tenant: verified.tenant, role: verified.role },
            );
            if (reminted) {
              setSessionCookie(res, await signSession(reminted));
              req.session = reminted;
              next();
              return;
            }
          } catch {
            // Identity store unreachable — keep the cookie's grants rather
            // than logging the user out on a transient failure.
          }
        }
        req.session = verified;
        next();
        return;
      }
    }
    req.session = demoSession();
    next();
  };
}

// Signed-cookie session with per-tenant role grants and masquerade provenance.
// The secret is fetched from Secrets Manager at boot. Cookie payload is
// base64url(JSON) + base64url(HMAC).
//
// Authentication is still deliberately lightweight: login is a user picker
// (POST /api/session/login) against the app_users table, and requests with no
// cookie fall back to the permissive "demo-user" identity — but only while no
// real authenticator is configured (see demoFallbackAllowed). mintSession() is
// the single choke point that turns an identity + grants into a session, so a
// real authenticator (e.g. the Cognito OIDC callback) slots in by resolving
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

export const TENANTS = ['orgiq', 'assessment'] as const;
export type Tenant = typeof TENANTS[number];

// Role vocabulary per tenant. Must match the Cedar seeds in
// middleware/seeds/roles/{tenant}/. 'admin' is cross-tenant: it can hold a
// grant in any tenant and is the only role permitted to masquerade.
export const ROLES_BY_TENANT: Record<Tenant, readonly string[]> = {
  orgiq: ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin'],
  assessment: ['assessor', 'lead-assessor', 'program-lead'],
};
export const ADMIN_ROLE = 'admin';

// Legacy export — the orgiq role list. Prefer ROLES_BY_TENANT.
export const ROLES = ROLES_BY_TENANT.orgiq as readonly ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin'];
export type Role = 'member' | 'sme' | 'program-owner' | 'org-leader' | 'hr-admin' | 'assessor' | 'lead-assessor' | 'program-lead' | 'admin';

export const DEFAULT_ROLE: Role = 'member';
export const DEFAULT_TENANT: Tenant = 'orgiq';
export const COOKIE_NAME = 'orgiq.session';
// Cookie lifetime, env-tunable in hours (SESSION_MAX_AGE_H). Default is 12h,
// down from the original 7 days: a laptop demo cookie should not outlive a
// workday by much, and SSO re-auth is cheap — when the Cognito session is
// still live the hosted UI bounces straight back without prompting.
const COOKIE_MAX_AGE_MS = parseInt(process.env['SESSION_MAX_AGE_H'] ?? '12', 10) * 60 * 60 * 1000;
/** A masquerade token is an impersonation credential — it gets a shorter
 * server-enforced leash than a normal session (see verifySession). */
const MASQUERADE_MAX_AGE_H = parseInt(process.env['MASQUERADE_MAX_AGE_H'] ?? '2', 10);

/** tenant id → roles the user holds there. Loaded from user_tenant_roles. */
export type Grants = Record<string, string[]>;

/** The real identity behind a masqueraded session, so it can be restored and audited. */
export interface Actor {
  sub: string;
  name?: string;
  role: Role;
  tenant: Tenant;
  grants: Grants;
  /** The real identity's session epoch, frozen at masquerade start (an actor
   * can't bump while impersonating), so masquerade/stop restores the actor at
   * their current epoch instead of 0 — which would self-invalidate an operator
   * who had switched roles before impersonating. */
  epoch?: number;
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
  /** Session-invalidation generation for this user. A tenant/role switch or an
   * explicit "sign out other sessions" bumps app_users.session_epoch; the
   * grants-refresh block rejects any cookie whose epoch is below the current
   * one, shrinking the stateless-cookie replay window to ≤ GRANTS_REFRESH_S.
   * Optional for backward-compat with cookies minted before this field. */
  epoch?: number;
}

/** Grants used for the cookie-less demo identity and legacy cookies: every role
 * in every tenant, so the demo stays fully explorable without a login step.
 * Seeded users get real (constrained) grants — that's where isolation shows. */
export function permissiveGrants(): Grants {
  const g: Grants = {};
  for (const t of TENANTS) g[t] = [...ROLES_BY_TENANT[t], ADMIN_ROLE];
  return g;
}

/**
 * What the cookie-less demo identity holds AFTER choosing a role.
 *
 * `demoSession()` starts permissive — every role in every tenant — so the
 * context picker can offer every persona. But the demo persona wearing "SME"
 * kept every one of those grants: the Assessment tile stayed on the picker,
 * the tenant's routes stayed open, and the person demoing an SME saw pages an
 * SME cannot see. Choosing a non-admin role now narrows the demo identity to
 * exactly that role in that tenant — it becomes the persona rather than
 * wearing its label. Choosing `admin` restores the permissive set, and
 * signing out (which drops the cookie) starts over. Real users are untouched:
 * their grants come from the identity store and this never applies.
 */
export const DEMO_SUB = 'demo-user';
export function demoScopedGrants(sub: string, tenant: string, role: string, current: Grants): Grants {
  if (sub !== DEMO_SUB) return current;
  if (role === ADMIN_ROLE) return permissiveGrants();
  return { [tenant]: [role] };
}

/**
 * What a switch is validated AGAINST. The demo cookie is narrowed to one role
 * (above), but the persona is still allowed to become any other one — the
 * picker POSTs `/tenant` then `/role`, and the first call narrowing the cookie
 * must not make the second one 403. Real users are validated against the
 * grants in their cookie, which are the identity store's.
 */
export function switchableGrants(sub: string, current: Grants): Grants {
  return sub === DEMO_SUB ? permissiveGrants() : current;
}

export function rolesForTenant(grants: Grants, tenant: string): string[] {
  return grants[tenant] ?? [];
}

export function hasGrant(grants: Grants, tenant: string, role: string): boolean {
  return rolesForTenant(grants, tenant).includes(role);
}

// Privilege rank, lower = less privileged. Used to choose a login landing role.
const ROLE_RANK: Record<string, number> = {
  member: 0, assessor: 0, sme: 1, 'lead-assessor': 2, 'program-owner': 2, 'org-leader': 3, 'program-lead': 3, 'hr-admin': 4, admin: 99,
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
  user: { id: string; displayName?: string; epoch?: number },
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
  if (user.epoch !== undefined) session.epoch = user.epoch;
  return session;
}

let signingKey: string | null = null;

async function loadSigningKey(): Promise<string> {
  if (signingKey) return signingKey;
  const arn = config.auth.sessionSigningSecretArn;
  if (!arn) {
    // Dev fallback: deterministic key so restarts don't invalidate cookies.
    // CDK populates the real secret in production.
    const devKey = process.env['SESSION_SIGNING_KEY_DEV'] ?? 'orgiq-dev-signing-key-change-me';
    // Refuse to run on a key anyone can read out of this file. The fallback is
    // fine in dev and catastrophic anywhere else: the key is the ONLY thing
    // authenticating the session cookie, so a published constant lets anyone
    // mint a valid `admin` session for any tenant. Losing the secret ARN in
    // production must fail loudly at boot, not silently downgrade to a
    // well-known key while everything appears to work.
    if (process.env['NODE_ENV'] === 'production' && !process.env['SESSION_SIGNING_KEY_DEV']) {
      throw new Error(
        'SESSION_SIGNING_SECRET_ARN is unset in production — refusing to sign sessions ' +
        'with the built-in development key. Set the secret ARN (CDK provides it) ' +
        'or, for a deliberate non-AWS deployment, set SESSION_SIGNING_KEY_DEV.',
      );
    }
    signingKey = devKey;
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
    // Server-side age enforcement. The cookie's browser maxAge is only a
    // hint — a captured cookie VALUE replayed later still verifies unless the
    // signed iat is checked here. Grant-refresh re-mints (fresh iat) for live
    // users, so an honest session never trips this; a stale token does.
    // Masquerade sessions get a shorter leash: an impersonation token is a
    // frozen-privilege credential and must not live a full workday.
    const iat = typeof raw['iat'] === 'number' ? raw['iat'] : 0;
    const isMasq = Boolean(raw['act'] && typeof raw['act'] === 'object');
    const maxAgeS = isMasq
      ? Math.min(COOKIE_MAX_AGE_MS / 1000, MASQUERADE_MAX_AGE_H * 3600)
      : COOKIE_MAX_AGE_MS / 1000;
    if (iat <= 0 || (Date.now() / 1000) - iat > maxAgeS) return null;
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
    if (typeof raw['epoch'] === 'number') session.epoch = raw['epoch'];
    // Enforce the invariant even against a stale-but-validly-signed cookie:
    // the active role must be held in the active tenant.
    if (!hasGrant(session.grants, session.tenant, session.role)) {
      const repaired = mintSession(
        { id: session.sub, displayName: session.name, epoch: session.epoch }, session.grants,
        { tenant: session.tenant }, session.act);
      return repaired;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Whether to mark a session-shaped cookie `Secure`.
 *
 * This was `process.env['NODE_ENV'] === 'production'`, which conflates "this is
 * a production build" with "this connection is encrypted". They came apart on
 * the deployed ECS middleware: the ALB serves plain **http** (deliberately —
 * Cognito rejects non-localhost http callbacks, so the stack leaves
 * COGNITO_CALLBACK_URL unset and the user picker is the intended login there),
 * while NODE_ENV is `production`. So `POST /api/session/login` answered **200**
 * with a complete, correct session body and a `Set-Cookie` no client would
 * store. Login succeeded, nothing errored, and every subsequent request was
 * `Unauthenticated` — the whole app unreachable behind a green health check.
 *
 * `req.secure` is the honest predicate: it reads the real scheme, and behind a
 * proxy it reads `X-Forwarded-Proto` — which is why `index.ts` sets
 * `trust proxy`. The two move together; changing one alone re-breaks this.
 *
 * The upside over a hardcoded flag is that it needs no revisiting: put TLS in
 * front of this service and the cookie becomes `Secure` on its own. Set
 * `SESSION_COOKIE_SECURE=true|false` to override when the proxy cannot be
 * trusted to report the scheme.
 */
function cookieSecure(res: Response): boolean {
  const override = process.env['SESSION_COOKIE_SECURE'];
  if (override === 'true') return true;
  if (override === 'false') return false;
  return res.req?.secure === true;
}

export function setSessionCookie(res: Response, value: string): void {
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(res),
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

/** Shared with routes/auth.ts so the OIDC state cookie cannot drift from the
 *  session cookie's rule — a `Secure` state cookie over http breaks the SSO
 *  round trip in exactly the same silent way. */
export { cookieSecure };

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

/** Mirror of lib/oidc.ts cognitoEnabled(), duplicated here so session.ts does
 * not import oidc.ts — its aws-jwt-verify dependency is ESM-only and would
 * break the CJS jest build for every suite that touches session/authz. */
/** Whether a real IdP is wired — controls the ssoRequired hint on 401s so
 * clients are only pointed at SSO when it actually exists. */
export function ssoAvailable(): boolean {
  return cognitoConfigured();
}

function cognitoConfigured(): boolean {
  const c = config.cognito;
  // Includes the client secret — in lockstep with oidc.ts cognitoEnabled().
  // A secret-less half-config must NOT disable the demo fallback while the
  // SSO exchange cannot succeed either (total lockout).
  return !!(c?.userPoolId && c?.clientId && c?.clientSecret && c?.domain && c?.callbackUrl);
}

/**
 * True when a cookie-less request may fall back to the demo identity. Once a
 * real IdP (Cognito) is configured, anonymous requests must be sent through
 * SSO instead of silently becoming demo-user — otherwise the login screen
 * never appears and the permissive demo identity masks the real one forever.
 */
export function demoFallbackAllowed(): boolean {
  return !cognitoConfigured() && demoModeEnabled();
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
type GrantsResolver = (userId: string) => Promise<{ displayName: string; grants: Grants; epoch: number } | null>;
let grantsResolver: GrantsResolver | null = null;
export function setGrantsResolver(fn: GrantsResolver): void {
  grantsResolver = fn;
}

/**
 * Resolve the caller's session from the cookie and attach to req.session.
 * Falls back to the demo-user identity if no cookie is present — but only
 * while demoFallbackAllowed() (no Cognito configured + demo mode); with a
 * real IdP wired up, cookie-less requests carry no session and downstream
 * guards 401 with ssoRequired so the client routes through SSO. Real users'
 * grants are re-resolved from the identity store every GRANTS_REFRESH_S so
 * revocations propagate to live sessions.
 */
export function sessionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (raw) {
      const verified = await verifySession(raw);
      if (verified) {
        const age = Math.floor(Date.now() / 1000) - verified.iat;
        // Masquerade sessions refresh too: the impersonated grants must track
        // revocation, not freeze for the token's life. The re-mint PRESERVES
        // the original iat so the masquerade age cap counts from when the
        // impersonation began — a refreshed iat would make the cap unreachable.
        // (The actor's own Masquerade right is not re-checked here — authz
        // imports this module, so evaluating Cedar from session middleware
        // would be a cycle; the short masquerade age cap bounds that window.)
        const isRefreshable = verified.sub !== 'demo-user';
        if (isRefreshable && grantsResolver && age > GRANTS_REFRESH_S) {
          try {
            const fresh = await grantsResolver(verified.sub);
            if (!fresh) {
              // User no longer exists — drop to the anonymous identity.
              clearSessionCookie(res);
              if (demoFallbackAllowed()) req.session = demoSession();
              next();
              return;
            }
            // Epoch check: a tenant/role switch or "sign out other sessions"
            // bumped this user's epoch. Any cookie minted before that bump is
            // superseded — treat it exactly like the "user no longer exists"
            // path (drop the cookie, fall back to anonymous). A cookie minted
            // before this field existed carries epoch 0, matching a user that
            // has never bumped.
            const cookieEpoch = verified.epoch ?? 0;
            if (cookieEpoch < fresh.epoch) {
              clearSessionCookie(res);
              if (demoFallbackAllowed()) req.session = demoSession();
              next();
              return;
            }
            const reminted = mintSession(
              { id: verified.sub, displayName: fresh.displayName, epoch: fresh.epoch },
              fresh.grants,
              { tenant: verified.tenant, role: verified.role },
              verified.act,
            );
            if (reminted) {
              if (verified.act) reminted.iat = verified.iat;
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
    if (demoFallbackAllowed()) req.session = demoSession();
    next();
  };
}

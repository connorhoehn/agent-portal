// Verified Permissions enforcement middleware. One IsAuthorized call per
// (tenant, role, action) is cached for 60 seconds — Cedar policies aren't
// expected to change per-request, and AVP charges per evaluation.
//
// The principal sent to Cedar is the *user* (entityId = session.sub) carrying
// role + tenant as attributes; policies condition on the attributes
// (`principal.role == "..." && principal.tenant == "..."`), so decisions are
// cacheable across users holding the same (tenant, role) pair.

import type { Request, Response, NextFunction } from 'express';
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
  type AttributeValue,
  type EntityItem,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from '../config.js';
import { eventFromSession, logAuthz } from './audit.js';
import {
  demoSession, demoFallbackAllowed, ADMIN_ROLE, DEFAULT_ROLE,
  type Tenant, type Role, type Session,
} from './session.js';

const NAMESPACE = 'OrgIQ';
const RESOURCE_ID = 'app';

const client = new VerifiedPermissionsClient({ region: config.region });

const cache = new Map<string, { decision: 'ALLOW' | 'DENY'; expiresAt: number }>();
const TTL_MS = 60_000;

/** The slice of a session that authorization decisions depend on. */
export interface PrincipalRef {
  sub: string;
  role: string;
  tenant: string;
}

/** Optional resource attributes — used by Cedar `when { resource.amount > N }` policies. */
export interface ResourceAttrs {
  amount?: number;
  [k: string]: unknown;
}

function attrsToAvp(attrs: ResourceAttrs): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = { long: Math.trunc(v) } as AttributeValue;
    } else if (typeof v === 'string') {
      out[k] = { string: v } as AttributeValue;
    } else if (typeof v === 'boolean') {
      out[k] = { boolean: v } as AttributeValue;
    }
  }
  return out;
}

async function evaluate(principal: PrincipalRef, action: string, resourceAttrs?: ResourceAttrs): Promise<'ALLOW' | 'DENY'> {
  if (!config.auth.policyStoreId) {
    // No policy store wired up. Open mode is a local-dev convenience only —
    // in production a missing POLICY_STORE_ID is a misconfiguration, and
    // silently disabling every tenant/role boundary is the worst failure mode.
    if (process.env['NODE_ENV'] === 'production') return 'DENY';
    return 'ALLOW';
  }
  // Only cache evaluations that don't depend on per-request resource attributes.
  // Attribute-bearing checks (e.g. ApproveTransaction when amount > N) must be
  // evaluated fresh each time since the cache key would otherwise collide.
  const hasAttrs = !!resourceAttrs && Object.keys(resourceAttrs).length > 0;
  const key = `${principal.tenant}|${principal.role}|${action}`;
  if (!hasAttrs) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;
  }

  const entityList: EntityItem[] = [{
    identifier: { entityType: `${NAMESPACE}::User`, entityId: principal.sub },
    attributes: {
      role: { string: principal.role } as AttributeValue,
      tenant: { string: principal.tenant } as AttributeValue,
    },
    parents: [],
  }];
  if (hasAttrs) {
    entityList.push({
      identifier: { entityType: `${NAMESPACE}::Application`, entityId: RESOURCE_ID },
      attributes: attrsToAvp(resourceAttrs!),
      parents: [],
    });
  }

  const out = await client.send(new IsAuthorizedCommand({
    policyStoreId: config.auth.policyStoreId,
    principal: { entityType: `${NAMESPACE}::User`, entityId: principal.sub },
    action: { actionType: `${NAMESPACE}::Action`, actionId: action },
    resource: { entityType: `${NAMESPACE}::Application`, entityId: RESOURCE_ID },
    entities: { entityList },
  }));
  const decision = out.decision === 'ALLOW' ? 'ALLOW' : 'DENY';
  if (!hasAttrs) {
    cache.set(key, { decision, expiresAt: Date.now() + TTL_MS });
  }
  return decision;
}

/** The caller's session, or the demo fallback while it's still allowed (no
 * real IdP configured + demo mode). Null means the request is anonymous and a
 * real login exists — guards must 401 with ssoRequired so the client routes
 * through Cognito instead of silently demoting to demo-user. */
export function resolveSession(req: Request): Session | null {
  return req.session ?? (demoFallbackAllowed() ? demoSession() : null);
}

function denyUnauthenticated(req: Request, res: Response, action: string): void {
  logAuthz({
    decision: 'DENY', action, sub: 'anonymous', role: '-',
    path: req.path, reason: 'no session',
  });
  res.status(401).json({ error: 'Unauthenticated', ssoRequired: true });
}

/**
 * Returns a middleware that requires Cedar permission for `action`.
 * Action ids match the Cedar schema (Search, ViewSalary, EditGuardrail, ...).
 */
export function requireAction(action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = resolveSession(req);
    if (!session) { denyUnauthenticated(req, res, action); return; }
    try {
      const decision = await evaluate(session, action);
      logAuthz(eventFromSession(session, action, decision, { path: req.path }));
      if (decision === 'ALLOW') {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden', action, role: session.role, tenant: session.tenant });
    } catch (err) {
      logAuthz(eventFromSession(session, action, 'DENY', {
        path: req.path,
        reason: `authz-error: ${(err as Error).message}`,
      }));
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/**
 * Returns a middleware that requires the session's active tenant to be
 * `tenant`. This is the data-boundary guard: routes serving one tenant's
 * tables reject sessions parked in another tenant. The tenant comes from the
 * signed cookie only — never from a header or query param. The cross-tenant
 * `admin` role passes any tenant guard.
 */
export function requireTenant(tenant: Tenant) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = resolveSession(req);
    if (!session) { denyUnauthenticated(req, res, 'TenantScope'); return; }
    if (session.tenant === tenant || session.role === ADMIN_ROLE) {
      next();
      return;
    }
    logAuthz(eventFromSession(session, 'TenantScope', 'DENY', {
      path: req.path,
      reason: `route requires tenant=${tenant}`,
    }));
    res.status(403).json({ error: 'Forbidden', requiredTenant: tenant, tenant: session.tenant });
  };
}

/** Evaluate a Cedar decision outside middleware (approvals, masquerade, ...). */
export async function isAllowed(principal: PrincipalRef, action: string, resourceAttrs?: ResourceAttrs): Promise<boolean> {
  return (await evaluate(principal, action, resourceAttrs)) === 'ALLOW';
}

/**
 * Read-wide, write-narrow gating for a router.
 *
 * A GET is treated as operational visibility and allowed for any of `readRoles`
 * (plus `admin`); every mutating method falls through to `requireAction(action)`.
 * Use where a surface should be *viewable* more broadly than it is *writable* —
 * e.g. the knowledge-base registry, which org-leaders read but only hr-admins
 * change. `admin` always passes, matching requireAction's future bypass.
 */
export function readForRolesElseAction(readRoles: Role[], action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = resolveSession(req);
    const role = (session?.role ?? DEFAULT_ROLE) as Role;
    // No session → skip the read fast-path; requireAction below 401s it.
    if (req.method === 'GET' && session && (role === 'admin' || readRoles.includes(role))) {
      next();
      return;
    }
    void requireAction(action)(req, res, next);
  };
}

/**
 * Drop every cached Cedar decision. Call this from mutating routes
 * (CreatePolicy / UpdatePolicy / DeletePolicy / PutSchema) so the next
 * IsAuthorized check reflects the new state.
 */
export function clearAuthzCache(): void {
  cache.clear();
}

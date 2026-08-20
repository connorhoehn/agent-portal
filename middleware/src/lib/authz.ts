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
import { demoSession, ADMIN_ROLE, type Tenant } from './session.js';

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
    // No policy store wired up — open mode for local dev. Audit log still fires.
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

/**
 * Returns a middleware that requires Cedar permission for `action`.
 * Action ids match the Cedar schema (Search, ViewSalary, EditGuardrail, ...).
 */
export function requireAction(action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.session ?? demoSession();
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
    const session = req.session ?? demoSession();
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
 * Drop every cached Cedar decision. Call this from mutating routes
 * (CreatePolicy / UpdatePolicy / DeletePolicy / PutSchema) so the next
 * IsAuthorized check reflects the new state.
 */
export function clearAuthzCache(): void {
  cache.clear();
}

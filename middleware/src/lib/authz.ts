// Verified Permissions enforcement middleware. One IsAuthorized call per
// (role, action) is cached for 60 seconds — Cedar policies aren't expected to
// change per-request, and AVP charges per evaluation.

import type { Request, Response, NextFunction } from 'express';
import {
  VerifiedPermissionsClient,
  IsAuthorizedCommand,
  type AttributeValue,
  type EntityItem,
} from '@aws-sdk/client-verifiedpermissions';
import { config } from '../config.js';
import { eventFromSession, logAuthz } from './audit.js';
import { DEFAULT_ROLE, DEFAULT_TENANT, type Role } from './session.js';

const NAMESPACE = 'OrgIQ';
const RESOURCE_ID = 'app';

const client = new VerifiedPermissionsClient({ region: config.region });

const cache = new Map<string, { decision: 'ALLOW' | 'DENY'; expiresAt: number }>();
const TTL_MS = 60_000;

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

async function evaluate(role: Role, action: string, resourceAttrs?: ResourceAttrs): Promise<'ALLOW' | 'DENY'> {
  if (!config.auth.policyStoreId) {
    // No policy store wired up — open mode for local dev. Audit log still fires.
    return 'ALLOW';
  }
  // Only cache evaluations that don't depend on per-request resource attributes.
  // Attribute-bearing checks (e.g. ApproveTransaction when amount > N) must be
  // evaluated fresh each time since the cache key would otherwise collide.
  const hasAttrs = !!resourceAttrs && Object.keys(resourceAttrs).length > 0;
  const key = `${role}|${action}`;
  if (!hasAttrs) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;
  }

  const entityList: EntityItem[] = [{
    identifier: { entityType: `${NAMESPACE}::User`, entityId: role },
    attributes: { role: { string: role } as AttributeValue },
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
    principal: { entityType: `${NAMESPACE}::User`, entityId: role },
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
    const session = req.session ?? { sub: 'anon', role: DEFAULT_ROLE, tenant: DEFAULT_TENANT, iat: 0 };
    try {
      const decision = await evaluate(session.role as Role, action);
      logAuthz(eventFromSession(session, action, decision, { path: req.path }));
      if (decision === 'ALLOW') {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden', action, role: session.role });
    } catch (err) {
      logAuthz(eventFromSession(session, action, 'DENY', {
        path: req.path,
        reason: `authz-error: ${(err as Error).message}`,
      }));
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/** Synchronously look up a cached decision for use in non-middleware code. */
export async function isAllowed(role: Role, action: string, resourceAttrs?: ResourceAttrs): Promise<boolean> {
  return (await evaluate(role, action, resourceAttrs)) === 'ALLOW';
}

/**
 * Drop every cached Cedar decision. Call this from mutating routes
 * (CreatePolicy / UpdatePolicy / DeletePolicy / PutSchema) so the next
 * IsAuthorized check reflects the new state.
 */
export function clearAuthzCache(): void {
  cache.clear();
}

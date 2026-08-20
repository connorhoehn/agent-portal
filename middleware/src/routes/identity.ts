// Identity admin routes — read-only listings visible to anyone with
// ViewIdentityAdmin, mutating endpoints gated by EditPolicy / EditSchema.
//
// AVP is the runtime source of truth. The middleware/seeds/ files only seed
// the policy store on first boot; subsequent edits persist in AVP and are
// never clobbered by CDK or the seeder.

import { Router } from 'express';
import {
  VerifiedPermissionsClient,
  ListPoliciesCommand,
  GetPolicyCommand,
  CreatePolicyCommand,
  UpdatePolicyCommand,
  DeletePolicyCommand,
  GetSchemaCommand,
  PutSchemaCommand,
  IsAuthorizedCommand,
} from '@aws-sdk/client-verifiedpermissions';
import { asyncHandler } from '../lib/async-handler.js';
import { clearAuthzCache, requireAction } from '../lib/authz.js';
import { logAuthz } from '../lib/audit.js';
import { config } from '../config.js';
import { roleRegistry } from '../lib/role-registry.js';
import { listTenants, listUsers, getUser, createTenant, createUser, setGrants } from '../providers/identity.js';
import type { Grants } from '../lib/session.js';

export const identityRouter = Router();

const client = new VerifiedPermissionsClient({ region: config.region });

// ── Roles (read-only, ViewIdentityAdmin) ──────────────────────────────────────

identityRouter.use(requireAction('ViewIdentityAdmin'));

// Role definitions are derived from the enforced Cedar seed files — there is
// deliberately no second hand-maintained capability list here.
identityRouter.get('/roles', (req, res) => {
  const tenant = req.query['tenant'] as string | undefined;
  const roles = roleRegistry();
  res.json(tenant ? roles.filter(r => r.tenant === null || r.tenant === tenant) : roles);
});

// ── Tenants + users (grants admin, gated ManageUsers) ─────────────────────────

identityRouter.get('/tenants', asyncHandler(async (_req, res) => {
  res.json(await listTenants());
}));

identityRouter.post('/tenants', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { id, displayName } = req.body as { id?: string; displayName?: string };
  if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id)) {
    res.status(400).json({ error: 'id must be lowercase kebab-case, 2-31 chars' });
    return;
  }
  res.status(201).json(await createTenant(id, displayName || id));
}));

identityRouter.get('/users', asyncHandler(async (_req, res) => {
  res.json(await listUsers());
}));

identityRouter.post('/users', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { id, displayName, email, personId, grants } = req.body as {
    id?: string; displayName?: string; email?: string; personId?: string; grants?: Grants;
  };
  if (!id || !displayName) {
    res.status(400).json({ error: 'id and displayName are required' });
    return;
  }
  await createUser({ id, displayName, ...(email && { email }), ...(personId && { personId }) });
  if (grants) await setGrants(id, grants);
  res.status(201).json(await getUser(id));
}));

identityRouter.put('/users/:id/grants', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { grants } = req.body as { grants?: Grants };
  if (!grants || typeof grants !== 'object') {
    res.status(400).json({ error: 'grants object is required' });
    return;
  }
  const known = new Map(roleRegistry().map(r => [`${r.tenant ?? '*'}/${r.id}`, r]));
  for (const [tenant, roles] of Object.entries(grants)) {
    for (const role of roles) {
      if (!known.has(`${tenant}/${role}`) && !known.has(`*/${role}`)) {
        res.status(400).json({ error: `unknown role '${role}' for tenant '${tenant}'` });
        return;
      }
    }
  }
  await setGrants(req.params['id']!, grants);
  res.json(await getUser(req.params['id']!));
}));

// ── Policy simulator: dry-run AVP IsAuthorized for arbitrary (role, action) ──
//
// Returns the decision and the determining policies — useful for HRAdmin to
// validate a Cedar edit before saving. Read-only side effects.

identityRouter.post('/policies/test', asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const { role, action, tenant, resourceId } = req.body as {
    role?: string; action?: string; tenant?: string; resourceId?: string;
  };
  if (!role || !action) {
    res.status(400).json({ error: 'role and action are required' });
    return;
  }
  const testTenant = tenant || 'orgiq';
  try {
    const out = await client.send(new IsAuthorizedCommand({
      policyStoreId,
      principal: { entityType: 'OrgIQ::User', entityId: role },
      action: { actionType: 'OrgIQ::Action', actionId: action },
      resource: { entityType: 'OrgIQ::Application', entityId: resourceId || 'app' },
      entities: {
        entityList: [{
          identifier: { entityType: 'OrgIQ::User', entityId: role },
          attributes: { role: { string: role }, tenant: { string: testTenant } },
          parents: [],
        }],
      },
    }));
    res.json({
      decision: out.decision,
      determiningPolicies: (out.determiningPolicies ?? []).map(p => ({ policyId: p.policyId })),
      errors: (out.errors ?? []).map(e => ({ errorDescription: e.errorDescription })),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}));

// ── Policies CRUD ─────────────────────────────────────────────────────────────

function ensureStore(res: import('express').Response): string | null {
  const id = config.auth.policyStoreId;
  if (!id) {
    res.status(503).json({ error: 'POLICY_STORE_ID not configured' });
    return null;
  }
  return id;
}

identityRouter.get('/policies', asyncHandler(async (_req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const list = await client.send(new ListPoliciesCommand({ policyStoreId }));
  const items = await Promise.all((list.policies ?? []).map(async (p) => {
    const detail = await client.send(new GetPolicyCommand({ policyStoreId, policyId: p.policyId }));
    const def = detail.definition;
    const stmt = def && 'static' in def ? def.static : undefined;
    return {
      policyId: p.policyId,
      policyType: p.policyType,
      createdDate: p.createdDate,
      lastUpdatedDate: p.lastUpdatedDate,
      description: stmt?.description ?? '',
      statement: stmt?.statement ?? '',
    };
  }));
  res.json({ policies: items });
}));

identityRouter.post('/policies', requireAction('EditPolicy'), asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const { description, statement } = req.body as { description?: string; statement?: string };
  if (!statement) {
    res.status(400).json({ error: 'statement (Cedar source) is required' });
    return;
  }
  try {
    const out = await client.send(new CreatePolicyCommand({
      policyStoreId,
      definition: { static: { description: description || '', statement } },
    }));
    clearAuthzCache();
    logAuthz({ decision: 'ALLOW', action: 'EditPolicy.Create', sub: req.session!.sub, role: req.session!.role, path: req.path });
    res.status(201).json({ policyId: out.policyId });
  } catch (err) {
    res.status(400).json({ error: 'AVP rejected policy', detail: (err as Error).message });
  }
}));

identityRouter.put('/policies/:id', requireAction('EditPolicy'), asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const policyId = req.params['id'] as string;
  const { description, statement } = req.body as { description?: string; statement?: string };
  if (!statement) {
    res.status(400).json({ error: 'statement (Cedar source) is required' });
    return;
  }
  try {
    await client.send(new UpdatePolicyCommand({
      policyStoreId,
      policyId,
      definition: { static: { description: description || '', statement } },
    }));
    clearAuthzCache();
    logAuthz({ decision: 'ALLOW', action: 'EditPolicy.Update', sub: req.session!.sub, role: req.session!.role, path: req.path });
    res.json({ policyId });
  } catch (err) {
    res.status(400).json({ error: 'AVP rejected policy', detail: (err as Error).message });
  }
}));

identityRouter.delete('/policies/:id', requireAction('EditPolicy'), asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const policyId = req.params['id'] as string;
  await client.send(new DeletePolicyCommand({ policyStoreId, policyId }));
  clearAuthzCache();
  logAuthz({ decision: 'ALLOW', action: 'EditPolicy.Delete', sub: req.session!.sub, role: req.session!.role, path: req.path });
  res.json({ policyId, deleted: true });
}));

// ── Schema GET/PUT ────────────────────────────────────────────────────────────

identityRouter.get('/schema', asyncHandler(async (_req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const out = await client.send(new GetSchemaCommand({ policyStoreId }));
  let parsed: unknown = null;
  try { parsed = JSON.parse(out.schema ?? '{}'); } catch { parsed = out.schema; }
  res.json({ schema: parsed, raw: out.schema ?? '' });
}));

identityRouter.put('/schema', requireAction('EditSchema'), asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const { schema } = req.body as { schema?: unknown };
  const cedarJson = typeof schema === 'string' ? schema : JSON.stringify(schema);
  try {
    await client.send(new PutSchemaCommand({ policyStoreId, definition: { cedarJson } }));
    clearAuthzCache();
    logAuthz({ decision: 'ALLOW', action: 'EditSchema.Put', sub: req.session!.sub, role: req.session!.role, path: req.path });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'AVP rejected schema', detail: (err as Error).message });
  }
}));

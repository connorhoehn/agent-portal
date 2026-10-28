// Identity admin routes — read-only listings visible to anyone with
// ViewIdentityAdmin, mutating endpoints gated by EditPolicy / EditSchema.
//
// AVP is the runtime source of truth. The middleware/seeds/ files only seed
// the policy store on first boot; subsequent edits persist in AVP and are
// never clobbered by CDK or the seeder.

import { Router, type Response } from 'express';
import {
  VerifiedPermissionsClient,
  GetPolicyCommand,
  CreatePolicyCommand,
  UpdatePolicyCommand,
  DeletePolicyCommand,
  GetSchemaCommand,
  PutSchemaCommand,
  IsAuthorizedCommand,
} from '@aws-sdk/client-verifiedpermissions';
import { asyncHandler } from '../lib/async-handler.js';
import { clearAuthzCache, requireAction, requireAnyAction } from '../lib/authz.js';
import { logAuthz } from '../lib/audit.js';
import { config } from '../config.js';
import { roleRegistry } from '../lib/role-registry.js';
import { listAllPolicies } from '../lib/avp-policies.js';
import { listTenants, listUsers, getUser, createTenant, createUser, setGrants } from '../providers/identity.js';
// providers/identity.ts (not owned by this route file) has no write for
// person_id on an *existing* user — createUser's upsert only sets it on
// INSERT, never on the ON CONFLICT branch. Rather than add a write to that
// file, PUT /users/:id/person below reaches Aurora through the same generic
// executor other routes already use (see providers/aurora.ts, imported the
// same way by providers/sprints.ts) and keeps the write local to this file.
import { exec } from '../providers/aurora.js';
import { isCapabilityGrant, type Grants } from '../lib/session.js';

export const identityRouter = Router();

const client = new VerifiedPermissionsClient({ region: config.region });

// ── Gates ────────────────────────────────────────────────────────────────────
// Two capabilities own this router. ViewIdentityAdmin (hr-admin) is the
// full identity-admin surface, policies and schema included. ManageUsers
// is ALSO held tenant-scoped by program-lead (assessment) for user/grant
// admin inside its own tenant — a router-wide ViewIdentityAdmin gate locked
// that role out of the very routes built for it (review finding 2). So the
// people/tenant/role routes take either capability; policies + schema stay
// hr-admin's alone.
const identityRead = requireAnyAction(['ViewIdentityAdmin', 'ManageUsers']);
const identityAdminOnly = requireAction('ViewIdentityAdmin');

/** A scoped (non-admin, non-hr) manager only ever sees their own tenant. */
function scopedToOwnTenant(session: { role: string; tenant: string } | undefined): string | null {
  if (!session || session.role === 'admin' || session.role === 'hr-admin') return null;
  return session.tenant;
}

// ── Roles ─────────────────────────────────────────────────────────────────────

// Role definitions are derived from the enforced Cedar seed files — there is
// deliberately no second hand-maintained capability list here.
identityRouter.get('/roles', identityRead, (req, res) => {
  const tenant = req.query['tenant'] as string | undefined;
  const roles = roleRegistry();
  res.json(tenant ? roles.filter(r => r.tenant === null || r.tenant === tenant) : roles);
});

// ── Tenants + users (grants admin, gated ManageUsers) ─────────────────────────

identityRouter.get('/tenants', identityRead, asyncHandler(async (req, res) => {
  const only = scopedToOwnTenant(req.session);
  const tenants = await listTenants();
  res.json(only ? tenants.filter((t: { id: string }) => t.id === only) : tenants);
}));

// Provisioning writes need a real Aurora — the identity provider throws with a
// clear reason when there is none, but `asyncHandler` turns a throw into a bare
// 500 "Internal server error", which tells an operator nothing. The sibling
// `PUT /users/:id/person` route below always returned 503 with the reason;
// these three did not. Same shape, so an unconfigured environment reads the
// same way whichever identity write you reach for.
function auroraMissing(res: Response, what: string): boolean {
  if (config.aurora.clusterArn && config.aurora.secretArn) return false;
  res.status(503).json({ error: `Aurora not configured \u2014 cannot ${what}` });
  return true;
}

identityRouter.post('/tenants', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { id, displayName } = req.body as { id?: string; displayName?: string };
  if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id)) {
    res.status(400).json({ error: 'id must be lowercase kebab-case, 2-31 chars' });
    return;
  }
  if (auroraMissing(res, 'provision tenants')) return;
  res.status(201).json(await createTenant(id, displayName || id));
}));

// A silent clamp, not a 400: the seeded cast is 14 users and this list feeds
// the identity admin page, not a picker with its own paging, so the default
// has to keep shipping everyone today while still bounding an unbounded
// `SELECT ... FROM app_users` against a cluster that grew.
const DEFAULT_USERS_LIMIT = 500;
const MAX_USERS_LIMIT = 2000;

function clampUsersLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_USERS_LIMIT) : DEFAULT_USERS_LIMIT;
}

identityRouter.get('/users', identityRead, asyncHandler(async (req, res) => {
  const only = scopedToOwnTenant(req.session);
  const limit = clampUsersLimit(req.query['limit']);
  const users = (await listUsers()).slice(0, limit);
  // A tenant-scoped manager sees the people provisioned in their tenant,
  // and only that tenant's grants on them — not the org's whole roster.
  res.json(only
    ? users
      .filter((u) => (u.grants[only] ?? []).length > 0)
      .map((u) => ({ ...u, grants: { [only]: u.grants[only] ?? [] } }))
    : users);
}));

// ManageUsers is held scoped to one tenant by program-lead (assessment) — the
// same capability name hr-admin holds scoped to orgiq. AVP only checks that
// the action is permitted, never the payload, so a scoped (non-admin) caller
// could otherwise put another tenant's key in a grants body and grant itself
// cross-tenant roles. Returns the offending tenant, or null if the payload is
// entirely within the caller's own session tenant (always null for admin,
// whose ManageUsers grant is cross-tenant).
function offendingTenant(session: { role: string; tenant: string }, grants: Grants): string | null {
  if (session.role === 'admin') return null;
  return Object.keys(grants).find((tenant) => tenant !== session.tenant) ?? null;
}

identityRouter.post('/users', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { id, displayName, email, personId, grants } = req.body as {
    id?: string; displayName?: string; email?: string; personId?: string; grants?: Grants;
  };
  if (!id || !displayName) {
    res.status(400).json({ error: 'id and displayName are required' });
    return;
  }
  if (grants) {
    const offending = offendingTenant(req.session!, grants);
    if (offending) {
      res.status(403).json({ error: `cannot set grants for tenant '${offending}' — your session is scoped to '${req.session!.tenant}'` });
      return;
    }
  }
  if (auroraMissing(res, 'provision users')) return;
  await createUser({ id, displayName, ...(email && { email }), ...(personId && { personId }) });
  if (grants) await setGrants(id, grants);
  res.status(201).json(await getUser(id));
}));

identityRouter.put('/users/:id/grants', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const { grants, base } = req.body as { grants?: Grants; base?: Grants };
  if (!grants || typeof grants !== 'object') {
    res.status(400).json({ error: 'grants object is required' });
    return;
  }
  // `base` (optional) is the matrix the editor loaded. The write applies only
  // what differs from it, so a role granted since (an access provisioning)
  // survives a save from a stale page instead of being erased by it.
  const isGrantSet = (g: unknown): g is Grants => !!g && typeof g === 'object' && !Array.isArray(g)
    && Object.values(g).every((roles) => Array.isArray(roles) && roles.every((r) => typeof r === 'string'));
  if (base !== undefined && !isGrantSet(base)) {
    res.status(400).json({ error: 'base must be a grants object' });
    return;
  }
  const known = new Map(roleRegistry().map(r => [`${r.tenant ?? '*'}/${r.id}`, r]));
  for (const [tenant, roles] of Object.entries(grants)) {
    for (const role of roles) {
      // A capability grant (lib/session.ts CAPABILITY_GRANTS, e.g. orgiq
      // `budgets-reader`) is not a role but rides the same grant list, so an
      // edit that keeps it must not 400.
      if (!known.has(`${tenant}/${role}`) && !known.has(`*/${role}`) && !isCapabilityGrant(tenant, role)) {
        res.status(400).json({ error: `unknown role '${role}' for tenant '${tenant}'` });
        return;
      }
    }
  }
  const userId = String(req.params['id']);
  const session = req.session!;
  const offending = offendingTenant(session, grants) ?? (base ? offendingTenant(session, base) : null);
  if (offending) {
    res.status(403).json({ error: `cannot set grants for tenant '${offending}' — your session is scoped to '${session.tenant}'` });
    return;
  }
  const current = await getUser(userId);
  if (!current) {
    res.status(404).json({ error: `user '${userId}' not found` });
    return;
  }
  // setGrants makes the user's grants equal `merged` (writing only the rows
  // that differ), so a scoped caller's payload (which only ever names their
  // own tenant) is merged onto the user's existing grants first — otherwise
  // every other tenant's roles would be removed, not merely left unwritten.
  // Their base is scoped the same way.
  const scoped = session.role !== 'admin';
  const merged: Grants = scoped ? { ...current.grants, ...grants } : grants;
  const from = base && scoped ? { ...current.grants, ...base } : base;
  if (auroraMissing(res, 'set grants')) return;
  await setGrants(userId, merged, from ? { base: from } : {});
  res.json(await getUser(userId));
}));

// Link (or clear) the org-graph person behind an *existing* user. The create
// form (POST /users) only ever set person_id at creation — an operator whose
// account was provisioned without one, or who needs to relink it, had no
// route to reach (audit finding m6: the Sprints "unlinked account" empty
// state told them to fix this from here, and there was nothing here to do it
// with).
identityRouter.put('/users/:id/person', requireAction('ManageUsers'), asyncHandler(async (req, res) => {
  const userId = String(req.params['id']);
  const { personId } = req.body as { personId?: string | null };
  if (personId === undefined) {
    res.status(400).json({ error: 'personId is required (string, or null to unlink)' });
    return;
  }
  if (personId !== null && typeof personId !== 'string') {
    res.status(400).json({ error: 'personId must be a string, or null to unlink' });
    return;
  }
  const trimmed = personId === null ? null : personId.trim();
  if (personId !== null && !trimmed) {
    res.status(400).json({ error: 'personId must not be blank — pass null to unlink' });
    return;
  }

  const user = await getUser(userId);
  if (!user) {
    res.status(404).json({ error: `user '${userId}' not found` });
    return;
  }

  if (!config.aurora.clusterArn || !config.aurora.secretArn) {
    res.status(503).json({ error: 'Aurora not configured — cannot link person' });
    return;
  }

  if (trimmed) {
    const rows = await exec('SELECT id FROM people WHERE id = :id', [{ name: 'id', value: { stringValue: trimmed } }]);
    if (rows.length === 0) {
      res.status(404).json({ error: `person '${trimmed}' not found` });
      return;
    }
  }

  await exec(
    `UPDATE app_users SET person_id = ${trimmed ? ':person' : 'NULL'} WHERE id = :id`,
    [
      { name: 'id', value: { stringValue: userId } },
      ...(trimmed ? [{ name: 'person', value: { stringValue: trimmed } }] : []),
    ],
  );
  logAuthz({ decision: 'ALLOW', action: 'ManageUsers.LinkPerson', sub: req.session!.sub, role: req.session!.role, path: req.path });
  res.json(await getUser(userId));
}));

// ── Policy simulator: dry-run AVP IsAuthorized for arbitrary (role, action) ──
//
// Returns the decision and the determining policies — useful for HRAdmin to
// validate a Cedar edit before saving. Read-only side effects.

identityRouter.post('/policies/test', identityAdminOnly, asyncHandler(async (req, res) => {
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

identityRouter.get('/policies', identityAdminOnly, asyncHandler(async (_req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const items = await Promise.all((await listAllPolicies(client, policyStoreId)).map(async (p) => {
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

identityRouter.post('/policies', identityAdminOnly, requireAction('EditPolicy'), asyncHandler(async (req, res) => {
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

identityRouter.put('/policies/:id', identityAdminOnly, requireAction('EditPolicy'), asyncHandler(async (req, res) => {
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

identityRouter.delete('/policies/:id', identityAdminOnly, requireAction('EditPolicy'), asyncHandler(async (req, res) => {
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const policyId = req.params['id'] as string;
  await client.send(new DeletePolicyCommand({ policyStoreId, policyId }));
  clearAuthzCache();
  logAuthz({ decision: 'ALLOW', action: 'EditPolicy.Delete', sub: req.session!.sub, role: req.session!.role, path: req.path });
  res.json({ policyId, deleted: true });
}));

// ── Schema GET/PUT ────────────────────────────────────────────────────────────

// Offline (dev:mock, no policy store) there is no AVP schema to read. The
// actions the enforced seed policies name ARE the schema's action set, so the
// mock answer is derived from the role registry on every read: nothing stored,
// nothing to drift, nothing for /api/__mock/reset to undo.
function derivedMockSchema(): { schema: unknown; raw: string } {
  const names = new Set<string>();
  for (const r of roleRegistry()) for (const c of r.capabilities) if (c !== '*') names.add(c);
  const actions = Object.fromEntries([...names].sort().map((n) => [n, { appliesTo: { principalTypes: ['User'], resourceTypes: ['Resource'] } }]));
  const schema = { OrgIQ: { entityTypes: {}, actions } };
  return { schema, raw: JSON.stringify(schema) };
}

identityRouter.get('/schema', identityAdminOnly, asyncHandler(async (_req, res) => {
  if (!config.auth.policyStoreId && config.mock.aurora) { res.json(derivedMockSchema()); return; }
  const policyStoreId = ensureStore(res); if (!policyStoreId) return;
  const out = await client.send(new GetSchemaCommand({ policyStoreId }));
  let parsed: unknown = null;
  try { parsed = JSON.parse(out.schema ?? '{}'); } catch { parsed = out.schema; }
  res.json({ schema: parsed, raw: out.schema ?? '' });
}));

identityRouter.put('/schema', identityAdminOnly, requireAction('EditSchema'), asyncHandler(async (req, res) => {
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

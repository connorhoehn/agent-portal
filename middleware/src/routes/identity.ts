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
} from '@aws-sdk/client-verifiedpermissions';
import { asyncHandler } from '../lib/async-handler.js';
import { clearAuthzCache, requireAction } from '../lib/authz.js';
import { logAuthz } from '../lib/audit.js';
import { config } from '../config.js';
import { ROLES } from '../lib/session.js';

export const identityRouter = Router();

const client = new VerifiedPermissionsClient({ region: config.region });

// ── Roles (read-only, ViewIdentityAdmin) ──────────────────────────────────────

identityRouter.use(requireAction('ViewIdentityAdmin'));

const ROLE_DESCRIPTIONS: Record<string, { label: string; summary: string; capabilities: string[] }> = {
  member: {
    label: 'Member',
    summary: 'Rank-and-file IC. Search the org, see basic profile pages.',
    capabilities: ['Search', 'ViewOrgChart'],
  },
  'org-leader': {
    label: 'Org Leader',
    summary: 'VPs / Directors. Full org visibility, leaderboards, and system observability.',
    capabilities: ['Search', 'ViewOrgChart', 'ViewLeaderboard', 'ViewObservability'],
  },
  'hr-admin': {
    label: 'HR Admin',
    summary: 'People Ops. Sees salary + performance, edits guardrails/policies, manages ingest.',
    capabilities: [
      'Search', 'ViewOrgChart', 'ViewLeaderboard',
      'ViewSalary', 'ViewPerformance',
      'EditGuardrail', 'EditPolicy', 'EditSchema', 'ViewIdentityAdmin',
      'ViewObservability', 'ManageIngest',
    ],
  },
};

identityRouter.get('/roles', (_req, res) => {
  res.json(ROLES.map(r => ({ id: r, ...ROLE_DESCRIPTIONS[r]! })));
});

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

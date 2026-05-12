// Identity admin routes — visible only to hr-admin. The portal's
// Identity Management page renders the role + policy listings from these
// endpoints. Editing isn't wired in yet; this is a read-only surface that
// answers "who has what permission".

import { Router } from 'express';
import { VerifiedPermissionsClient, ListPoliciesCommand, GetPolicyCommand } from '@aws-sdk/client-verifiedpermissions';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { config } from '../config.js';
import { ROLES } from '../lib/session.js';

export const identityRouter = Router();

const client = new VerifiedPermissionsClient({ region: config.region });

identityRouter.use(requireAction('ViewIdentityAdmin'));

const ROLE_DESCRIPTIONS: Record<string, { label: string; summary: string; capabilities: string[] }> = {
  member: {
    label: 'Member',
    summary: 'Rank-and-file IC. Search the org, see basic profile pages.',
    capabilities: ['Search', 'ViewOrgChart'],
  },
  'org-leader': {
    label: 'Org Leader',
    summary: 'VPs / Directors. Full org visibility and expertise leaderboards.',
    capabilities: ['Search', 'ViewOrgChart', 'ViewLeaderboard'],
  },
  'hr-admin': {
    label: 'HR Admin',
    summary: 'People Ops. Sees salary + performance data, edits guardrails and policies.',
    capabilities: ['Search', 'ViewOrgChart', 'ViewLeaderboard', 'ViewSalary', 'ViewPerformance', 'EditGuardrail', 'EditPolicy', 'ViewIdentityAdmin'],
  },
};

identityRouter.get('/roles', (_req, res) => {
  res.json(ROLES.map(r => ({ id: r, ...ROLE_DESCRIPTIONS[r]! })));
});

identityRouter.get('/policies', asyncHandler(async (_req, res) => {
  if (!config.auth.policyStoreId) {
    res.json({ policies: [], note: 'POLICY_STORE_ID not configured — middleware running in open mode' });
    return;
  }
  const list = await client.send(new ListPoliciesCommand({ policyStoreId: config.auth.policyStoreId }));
  const items = await Promise.all((list.policies ?? []).map(async (p) => {
    const detail = await client.send(new GetPolicyCommand({
      policyStoreId: config.auth.policyStoreId,
      policyId: p.policyId,
    }));
    const def = detail.definition;
    const stmt = def && 'static' in def ? def.static?.statement : undefined;
    return {
      policyId: p.policyId,
      policyType: p.policyType,
      createdDate: p.createdDate,
      statement: stmt,
    };
  }));
  res.json({ policies: items });
}));

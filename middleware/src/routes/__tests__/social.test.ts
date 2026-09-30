// The social tenant's API gate (docs/social-tenant-design.md §4.1, §6): a
// session parked in orgiq, assessment or pipelines is refused at
// requireTenant('social') BEFORE any social handler runs — 403 naming the
// tenant it would have needed. Every social role reads the summary; the
// cross-tenant admin passes from any tenant. The summary's numbers are counted
// from the identity store's grants and the registered surface catalog.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'participant', tenant: 'social', label: 'Participant', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
    { id: 'moderator', tenant: 'social', label: 'Moderator', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'] },
    { id: 'community-admin', tenant: 'social', label: 'Community Admin', summary: '', capabilities: ['ViewSocial', 'ManageSocialConfig'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { socialRouter } from '../social.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';
import { socialSurfaces } from '../../mock/social.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  // The same mount index.ts uses.
  app.use('/api/social', requireTenant('social'), socialRouter);
  app.use(errorHandler);
  return app;
}

const OUTSIDE: Array<{ role: Role; tenant: Tenant; sub: string }> = [
  { role: 'member', tenant: 'orgiq', sub: 'u-theo' },
  { role: 'sme', tenant: 'orgiq', sub: 'u-nora' },
  { role: 'program-owner', tenant: 'orgiq', sub: 'u-mia' },
  { role: 'org-leader', tenant: 'orgiq', sub: 'u-vera' },
  { role: 'hr-admin', tenant: 'orgiq', sub: 'u-hr' },
  { role: 'assessor', tenant: 'assessment', sub: 'u-asha' },
  { role: 'lead-assessor', tenant: 'assessment', sub: 'u-jonas' },
  { role: 'program-lead', tenant: 'assessment', sub: 'u-farah' },
  { role: 'author', tenant: 'pipelines', sub: 'u-ines' },
];

describe('requireTenant(social) — outside roles', () => {
  for (const s of OUTSIDE) {
    it(`${s.tenant}/${s.role} gets 403 on /api/social/summary`, async () => {
      const res = await request(appAs(s)).get('/api/social/summary');
      expect(res.status).toBe(403);
      expect(res.body.requiredTenant).toBe('social');
    });
  }

  it('a participant holding a social grant but standing in orgiq is still refused', async () => {
    // The grant is not the gate — the session's tenant is. u-theo holds
    // social:participant, but a cookie parked in orgiq reads orgiq.
    const res = await request(appAs({ role: 'member', tenant: 'orgiq', sub: 'u-theo', grants: { orgiq: ['member'], social: ['participant'] } }))
      .get('/api/social/summary');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/social/summary', () => {
  afterEach(() => socialSurfaces.reset());

  for (const role of ['participant', 'moderator', 'community-admin'] as Role[]) {
    it(`social/${role} reads the summary`, async () => {
      const res = await request(appAs({ role, tenant: 'social', sub: 'u-sana' })).get('/api/social/summary');
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBe('social');
    });
  }

  it('admin passes the gate from any tenant', async () => {
    const res = await request(appAs({ role: 'admin', tenant: 'orgiq', sub: 'u-operator' })).get('/api/social/summary');
    expect(res.status).toBe(200);
  });

  it('counts members from grants and surfaces from the registered catalog', async () => {
    const res = await request(appAs({ role: 'participant', tenant: 'social', sub: 'u-sana' })).get('/api/social/summary');
    const rows = socialSurfaces.rows();
    expect(res.body.surfaces).toEqual({ total: rows.length, live: rows.filter((r) => r.live).length, pending: rows.filter((r) => !r.live).length });
    // The cast (one per role) plus the curated participants and the operator.
    expect(res.body.members.byRole['community-admin']).toBeGreaterThanOrEqual(1);
    expect(res.body.members.byRole['moderator']).toBeGreaterThanOrEqual(1);
    expect(res.body.members.byRole['participant']).toBeGreaterThanOrEqual(1);
    expect(res.body.members.byRole['admin']).toBeGreaterThanOrEqual(1);
    const sum = Object.values(res.body.members.byRole as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(res.body.members.total).toBeLessThanOrEqual(sum);
  });

  it('the empty scenario reads zero surfaces', async () => {
    const empty = socialSurfaces.rows('empty');
    expect(empty).toEqual([]);
  });
});

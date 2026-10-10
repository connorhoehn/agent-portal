// /api/social/bindings and the grant-gated POST /api/social/dms — the
// cross-tenant half of the social API (docs/social-tenant-design.md E5, §4.4,
// §4.6 — lane E), mounted as index.ts mounts it: socialEmbedRouter BEFORE the
// requireTenant('social') router. On the registered fixtures (MOCK_AURORA):
//   - reads need a grant in social AND in the context's tenant — an orgiq
//     session holding a social grant reads the initiative's binding; one
//     without it (or a social-only session reading an orgiq context) 403s;
//   - PUT/DELETE need ManageChannels in social (by grant, whatever tenant the
//     session stands in) AND a grant in the context's tenant;
//   - a private channel the caller is not in cannot be bound (404) and a
//     binding to one reads as unbound for a non-member;
//   - opening a DM works from an orgiq session holding a social grant, and is
//     refused (403) to one without — the Search people → Message path.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
// This suite's Vera persona is explicitly a moderator in its directory too.
// Captured cookie grants alone are no longer authority for embedded actions.
jest.mock('../../providers/identity.js', () => {
  const actual = jest.requireActual('../../providers/identity.js');
  return { ...actual, getUser: async (id: string, options: unknown) => {
    const user = await actual.getUser(id, options);
    return id === 'u-vera' && user ? { ...user, grants: { ...user.grants, social: ['moderator'] } } : user;
  } };
});
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'Org leader', summary: '', capabilities: ['Search'] },
    { id: 'participant', tenant: 'social', label: 'Participant', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
    { id: 'moderator', tenant: 'social', label: 'Moderator', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { socialEmbedRouter, socialRouter } from '../social.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { socialBindingsFixture } from '../../mock/social-bindings.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture, socialChannelsFixture } from '../../mock/social-channels.js';

function appAs(sub: string, tenant: string, grants: Record<string, string[]>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub, iat: 0, role: grants[tenant]?.[0] ?? 'member', tenant, grants } as unknown as Session;
    next();
  });
  app.use('/api/social', socialEmbedRouter);
  app.use('/api/social', requireTenant('social'), socialRouter);
  app.use(errorHandler);
  return app;
}
// Theo: orgiq member + social participant, a member of #auth-migration.
const theo = () => appAs('u-theo', 'orgiq', { orgiq: ['member'], social: ['participant'] });
// Vera: orgiq org-leader + social moderator (ManageChannels) — standing in orgiq.
const vera = () => appAs('u-vera', 'orgiq', { orgiq: ['org-leader'], social: ['moderator'] });
const hr = () => appAs('u-hr', 'orgiq', { orgiq: ['hr-admin'] });
const sana = () => appAs('u-sana', 'social', { social: ['participant'] });
const lena = () => appAs('u-lena', 'social', { social: ['moderator'] });
const CTX = '/api/social/bindings?context=initiative:p-auth-migration';

afterEach(() => {
  socialBindingsFixture.reset();
  socialChannelsFixture.reset();
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
});

describe('GET /api/social/bindings', () => {
  it('an orgiq session holding a social grant reads the initiative\'s bound channel', async () => {
    const res = await request(theo()).get(CTX);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      context: 'initiative:p-auth-migration', tenant: 'orgiq', joined: true, canManage: false, choices: [],
      binding: { channel: 'social:ch:auth-migration', slug: 'auth-migration', name: 'Auth migration', privacy: 'public', contextKind: 'initiative', contextId: 'p-auth-migration', tenant: 'orgiq' },
    });
  });

  it('an unbound context reads binding: null', async () => {
    const res = await request(theo()).get('/api/social/bindings?context=initiative:p-soc2');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ binding: null, joined: false });
  });

  it('refuses a session with no social grant, and a social-only session reading an orgiq context', async () => {
    const a = await request(hr()).get(CTX);
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({ requiredTenant: 'social' });
    const b = await request(sana()).get(CTX);
    expect(b.status).toBe(403);
    expect(b.body).toMatchObject({ requiredTenant: 'orgiq' });
  });

  it('400s a context that is not <known kind>:<id>', async () => {
    for (const q of ['', '?context=', '?context=project:p-1', '?context=initiative:', '?context=initiative:bad id']) {
      expect((await request(theo()).get(`/api/social/bindings${q}`)).status).toBe(400);
    }
  });

  it('offers a ManageChannels holder the channels they could bind to', async () => {
    const res = await request(vera()).get(CTX);
    expect(res.body.canManage).toBe(true);
    const slugs = res.body.choices.map((c: { slug: string }) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(['general', 'auth-migration', 'design-reviews']));
    expect(slugs).not.toContain('moderators'); // private, and Vera is not in it
  });
});

describe('PUT / DELETE /api/social/bindings', () => {
  it('ManageChannels in social + a grant in orgiq binds and unbinds, standing in orgiq', async () => {
    const put = await request(vera()).put('/api/social/bindings?context=initiative:p-soc2').send({ channel: 'social:ch:general' });
    expect(put.status).toBe(200);
    expect(put.body.binding).toMatchObject({ channel: 'social:ch:general', createdBy: 'u-vera' });
    expect(socialBindingsFixture.rows().some((r) => r.contextId === 'p-soc2' && r.channel === 'social:ch:general')).toBe(true);
    // Re-binding replaces (one channel per context).
    await request(vera()).put('/api/social/bindings?context=initiative:p-soc2').send({ channel: 'social:ch:design-reviews' });
    expect(socialBindingsFixture.rows().filter((r) => r.contextId === 'p-soc2')).toHaveLength(1);
    const del = await request(vera()).delete('/api/social/bindings?context=initiative:p-soc2');
    expect(del.status).toBe(200);
    expect(del.body.binding).toBeNull();
    expect(socialBindingsFixture.rows().some((r) => r.contextId === 'p-soc2')).toBe(false);
  });

  it('refuses a participant (no ManageChannels), and a moderator with no grant in the context\'s tenant', async () => {
    expect((await request(theo()).put(CTX).send({ channel: 'social:ch:general' })).status).toBe(403);
    expect((await request(theo()).delete(CTX)).status).toBe(403);
    const l = await request(lena()).put(CTX).send({ channel: 'social:ch:general' });
    expect(l.status).toBe(403);
    expect(l.body).toMatchObject({ requiredTenant: 'orgiq' });
    expect(socialBindingsFixture.rows().find((r) => r.contextId === 'p-auth-migration')?.channel).toBe('social:ch:auth-migration');
  });

  it('refuses a channel that is not social:ch:<slug>, an unknown one, and a private one you are not in', async () => {
    expect((await request(vera()).put(CTX).send({ channel: 'assessment:doc:1' })).status).toBe(400);
    expect((await request(vera()).put(CTX).send({})).status).toBe(400);
    expect((await request(vera()).put(CTX).send({ channel: 'social:ch:nope' })).status).toBe(404);
    expect((await request(vera()).put(CTX).send({ channel: 'social:ch:moderators' })).status).toBe(404);
  });

  it('a binding to a private channel reads as unbound to a non-member', async () => {
    socialBindingsFixture.rows().push({ tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-soc2', channel: 'social:ch:moderators', createdBy: 'u-mira', createdAt: new Date().toISOString() });
    const res = await request(theo()).get('/api/social/bindings?context=initiative:p-soc2');
    expect(res.body).toMatchObject({ binding: null, joined: false });
  });
});

describe('POST /api/social/dms (grant-gated)', () => {
  it('opens the sorted DM lobby from an orgiq session holding a social grant', async () => {
    const res = await request(theo()).post('/api/social/dms').send({ userId: 'u-vera' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: 'social:dm:u-theo:u-vera', peers: [{ userId: 'u-vera', displayName: 'Vera Green' }] });
  });

  it('refuses a session with no social grant, and a peer outside the social roster', async () => {
    expect((await request(hr()).post('/api/social/dms').send({ userId: 'u-vera' })).status).toBe(403);
    // u-eli holds Social since the 2026-10-07 seed; u-hr (hr-admin, no Social grant) is the peer outside the roster.
    expect((await request(theo()).post('/api/social/dms').send({ userId: 'u-hr' })).status).toBe(404);
  });

  it('channel administration stays tenant gated while embedded DM read remains source scoped', async () => {
    expect((await request(theo()).get('/api/social/channels')).status).toBe(403);
    expect((await request(theo()).post('/api/social/dms/read').send({ channel: 'social:dm:u-theo:u-vera' })).status).toBe(200);
  });
});

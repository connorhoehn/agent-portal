// GET /api/social/resolve — the channel to post to for a spoken name
// (docs/voice-navigator-spec.md §4 send_chat_message, P6).
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'participant', tenant: 'social', label: 'Participant', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
    { id: 'moderator', tenant: 'social', label: 'Moderator', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
    { id: 'viewer', tenant: 'social', label: 'Viewer', summary: '', capabilities: ['ViewSocial'] },
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
import type { Session } from '../../lib/session.js';
import { createChannel } from '../../providers/social-channels.js';
import { resolveByName } from '../../lib/social-resolve.js';
import { socialChat, dmChannelFor } from '../../lib/social-chat.js';
import { resetSocialTeamMirror } from '../../providers/social-platform.js';
import { socialRoomsFixture, socialTeamMembersFixture, socialTeamsFixture } from '../../mock/social-platform.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { sub: 'u-sana', role: 'participant', tenant: 'social', iat: 0, grants: { social: ['participant'] }, ...session } as Session; next(); });
  app.use('/api/social', requireTenant('social'), socialRouter);
  app.use(errorHandler);
  return app;
}
const sana = () => appAs({});
const resolve = (app: express.Express, kind: string, name: string) => request(app).get('/api/social/resolve').query({ kind, name });

const savedEnv = { ...process.env };
const originalFetch = global.fetch;
beforeEach(() => {
  delete process.env['SOCIAL_PLATFORM_INTERNAL_URL']; delete process.env['SOCIAL_PLATFORM_BACKEND'];
  delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL']; delete process.env['PLATFORM_API_URL'];
  process.env['REALTIME_JWT_SECRET'] = 'resolve-test';
  resetSocialTeamMirror();
});
afterEach(() => {
  jest.restoreAllMocks(); global.fetch = originalFetch;
  socialTeamsFixture.reset(); socialTeamMembersFixture.reset(); socialRoomsFixture.reset();
  resetSocialTeamMirror(); process.env = { ...savedEnv };
});

describe('resolveByName', () => {
  const rows = [{ id: 'a', name: 'Design reviews', slug: 'design-reviews' }, { id: 'b', name: 'Design', slug: 'design' }, { id: 'c', name: 'Dev ops' }];
  it('exact beats prefix; case-insensitive', () => { expect(resolveByName(rows, 'DESIGN').match?.id).toBe('b'); });
  it('a prefix or token match with one hit resolves', () => {
    expect(resolveByName(rows, 'dev').match?.id).toBe('c');
    expect(resolveByName(rows, 'reviews').match?.id).toBe('a');
    expect(resolveByName(rows, '#design-reviews').match?.id).toBe('a');
  });
  it('several in the best tier is ambiguous, capped at five', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, name: `Release ${i}` }));
    const out = resolveByName(many, 'release');
    expect(out.match).toBeNull(); expect(out.candidates).toHaveLength(5);
  });
  it('nothing fits', () => { expect(resolveByName(rows, 'zzz')).toEqual({ match: null, candidates: [] }); });
});

describe('GET /api/social/resolve (mock provider)', () => {
  it('team → its default channel', async () => {
    const res = await resolve(sana(), 'team', 'community');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      kind: 'team',
      match: { id: 'mock-team-community', name: 'Community', channelId: 'mock-room-community-general', channel: 'social:team:community:general' },
      candidates: [{ id: 'mock-team-community', name: 'Community' }],
    });
  });
  it('a team the caller is not in is invisible', async () => {
    const res = await resolve(sana(), 'team', 'moderation');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ kind: 'team', match: null, candidates: [] });
  });
  it('another tenant\'s team is invisible', async () => {
    socialTeamsFixture.rows(); // load
    const teams = socialTeamsFixture.rows();
    const other = { ...teams[0]!, orgId: 'orgiq', teamId: 'other-team', slug: 'platform', name: 'Platform' };
    const members = socialTeamMembersFixture.rows();
    jest.spyOn(socialTeamsFixture, 'rows').mockReturnValue([...teams, other]);
    jest.spyOn(socialTeamMembersFixture, 'rows').mockReturnValue([...members, { teamId: 'other-team', userId: 'u-sana', role: 'member', favorite: false, addedAt: other.createdAt, addedBy: 'u-sana' }]);
    const res = await resolve(sana(), 'team', 'platform');
    expect(res.status).toBe(404);
    expect(res.body.match).toBeNull();
  });
  it('channel slug or name → the channel; a private one the caller is not in is invisible', async () => {
    const bySlug = await resolve(sana(), 'channel', 'design-reviews');
    expect(bySlug.body.match).toEqual({ id: 'design-reviews', name: 'Design reviews', channelId: 'design-reviews', channel: 'social:ch:design-reviews' });
    expect((await resolve(sana(), 'channel', '#General')).body.match.channel).toBe('social:ch:general');
    const hidden = await resolve(sana(), 'channel', 'moderators');
    expect(hidden.status).toBe(404); expect(hidden.body.match).toBeNull();
  });
  it('a person → the DM channel for the caller, created on the way', async () => {
    const res = await resolve(sana(), 'person', 'Lena');
    expect(res.status).toBe(200);
    const channel = dmChannelFor(['u-sana', 'u-lena']);
    expect(res.body.match).toEqual({ id: 'u-lena', name: expect.stringMatching(/^Lena/), channelId: channel, channel });
    const mine = await socialChat().conversations.listForUser('u-sana');
    expect(mine.some((r) => r.channel === channel)).toBe(true);
  });
  it('the pair is always the caller and the person; the caller is never a result', async () => {
    const asLena = await resolve(appAs({ sub: 'u-lena', role: 'moderator', grants: { social: ['moderator'] } }), 'person', 'Sana');
    expect(asLena.body.match.channel).toBe(dmChannelFor(['u-lena', 'u-sana']));
    const self = await resolve(sana(), 'person', 'Sana');
    expect(self.body.match === null || self.body.match.id !== 'u-sana').toBe(true);
  });
  it('an ambiguous name returns candidates and no match', async () => {
    await createChannel({ slug: 'release-a', name: 'Release A', description: null, privacy: 'public', createdBy: 'u-mira' });
    await createChannel({ slug: 'release-b', name: 'Release B', description: null, privacy: 'public', createdBy: 'u-mira' });
    const res = await resolve(sana(), 'channel', 'release');
    expect(res.status).toBe(200);
    expect(res.body.match).toBeNull();
    expect(res.body.candidates.length).toBeGreaterThan(1);
    expect(res.body.candidates.length).toBeLessThanOrEqual(5);
  });
  it('a person outside the tenant is never returned', async () => {
    const res = await resolve(sana(), 'person', 'Ines');
    expect(res.status).toBe(404); expect(res.body.match).toBeNull();
  });
  it('validates kind and name, and requires the social tenant', async () => {
    expect((await resolve(sana(), 'planet', 'x')).status).toBe(400);
    expect((await resolve(sana(), 'team', '  ')).status).toBe(400);
    expect((await resolve(appAs({ role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] } }), 'team', 'community')).status).toBe(403);
  });
});

describe('GET /api/social/resolve (platform provider)', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  beforeEach(() => { process.env['SOCIAL_PLATFORM_INTERNAL_URL'] = 'http://platform.test'; process.env['SOCIAL_PLATFORM_BACKEND'] = 'platform'; });
  it('team → its default channel from platform-api; other partitions are dropped', async () => {
    const base = { state: 'active', createdBy: 'u-mira', createdAt: 't', updatedAt: 't', visibility: 'org' };
    global.fetch = jest.fn().mockResolvedValue(json({ teams: [
      { ...base, orgId: 'social', teamId: 't-ops', slug: 'ops', name: 'Ops team', role: 'member', channels: [{ orgId: 'social', roomId: 'r-ops-general', slug: 'ops-general', name: 'General', createdBy: 'u-mira', state: 'active' }] },
      { ...base, orgId: 'orgiq', teamId: 't-x', slug: 'ops-x', name: 'Ops X', role: 'member', channels: [] },
    ] })) as unknown as typeof fetch;
    const res = await resolve(sana(), 'team', 'ops');
    expect(res.status).toBe(200);
    expect(res.body.match).toEqual({ id: 't-ops', name: 'Ops team', channelId: 'r-ops-general', channel: 'social:team:ops:general' });
    expect(res.body.candidates).toHaveLength(1);
  });
});

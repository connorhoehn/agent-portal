// /api/social channels, DMs and the tenant roster (docs/social-tenant-design.md
// §4.3–§4.5, lane S1), on the memory chat backend whose `social:` rows are the
// registered fixtures (MOCK_AURORA). Pins:
//   - the directory lists public channels plus the private ones you are in;
//     a private channel you are not in 404s on read AND join (no existence leak);
//   - create needs ManageChannels (a participant 403s), makes you its owner,
//     refuses a duplicate with 409 and a nameless one with 400;
//   - join/leave flip membership in the store the gateway's guard reads;
//   - DMs: your conversations from the index; opening one names the sorted
//     lobby, refuses yourself and anyone without a social grant;
//   - the roster is exactly the users holding a social grant;
//   - the whole surface stays behind requireTenant('social').

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'participant', tenant: 'social', label: 'Participant', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
    { id: 'moderator', tenant: 'social', label: 'Moderator', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings'] },
    { id: 'community-admin', tenant: 'social', label: 'Community Admin', summary: '', capabilities: ['ViewSocial', 'PostMessage', 'StartCall', 'ManageChannels', 'ManageTeams', 'ManageRecordings', 'ManageSocialConfig'] },
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
import { socialChat } from '../../lib/social-chat.js';
import { type Role, type Session } from '../../lib/session.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture, socialChannelsFixture, socialReadCursorsFixture } from '../../mock/social-channels.js';

function appAs(sub: string, role: Role, tenant = 'social') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub, iat: 0, role, tenant, grants: { [tenant]: [role] } } as unknown as Session;
    next();
  });
  app.use('/api/social', socialEmbedRouter);
  app.use('/api/social', requireTenant('social'), socialRouter);
  app.use(errorHandler);
  return app;
}
const sana = () => appAs('u-sana', 'participant');
const lena = () => appAs('u-lena', 'moderator');
const mira = () => appAs('u-mira', 'community-admin');

afterEach(() => {
  socialChannelsFixture.reset();
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  socialReadCursorsFixture.reset();
});

describe('GET /api/social/channels', () => {
  it('lists public channels and the private ones you are in, joined first', async () => {
    const res = await request(sana()).get('/api/social/channels');
    expect(res.status).toBe(200);
    const slugs = res.body.channels.map((c: { slug: string }) => c.slug);
    expect(slugs).toEqual(['general', 'auth-migration', 'design-reviews']);
    const general = res.body.channels[0];
    expect(general).toMatchObject({ channel: 'social:ch:general', joined: true, role: 'member', privacy: 'public' });
    // Counted from the member rows, never stored.
    expect(general.memberCount).toBe(socialChannelMembersFixture.rows().filter((m) => m.channel === 'social:ch:general' && !m.removedAt).length);
    expect(general.lastMessagePreview).toBeTruthy();

    const mod = await request(lena()).get('/api/social/channels');
    expect(mod.body.channels.map((c: { slug: string }) => c.slug)).toContain('moderators');
  });

  it('an orgiq session is refused at the tenant gate', async () => {
    const res = await request(appAs('u-theo', 'member', 'orgiq')).get('/api/social/channels');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/social/channels', () => {
  it('a participant cannot create a channel', async () => {
    const res = await request(sana()).post('/api/social/channels').send({ name: 'Book club' });
    expect(res.status).toBe(403);
  });

  it('a moderator creates one, owns it, and a participant then sees it', async () => {
    const res = await request(lena()).post('/api/social/channels').send({ name: 'Book Club!', description: 'Monthly picks' });
    expect(res.status).toBe(201);
    expect(res.body.channel).toMatchObject({ slug: 'book-club', channel: 'social:ch:book-club', name: 'Book Club!', privacy: 'public', joined: true, role: 'owner', memberCount: 1, createdBy: 'u-lena' });
    expect(socialChat().membershipStore.isActiveMember('social:ch:book-club', 'u-lena')).toBe(true);
    const list = await request(sana()).get('/api/social/channels');
    expect(list.body.channels.find((c: { slug: string }) => c.slug === 'book-club')).toMatchObject({ joined: false });
  });

  it('refuses a duplicate with 409 and a nameless channel with 400', async () => {
    expect((await request(mira()).post('/api/social/channels').send({ name: 'General' })).status).toBe(409);
    expect((await request(mira()).post('/api/social/channels').send({ name: '   ' })).status).toBe(400);
    expect((await request(mira()).post('/api/social/channels').send({ name: '!!!' })).status).toBe(400);
  });

  it('a private channel is invisible to a non-member: absent from the list, 404 on read and on join', async () => {
    const created = await request(mira()).post('/api/social/channels').send({ name: 'Staff', privacy: 'private' });
    expect(created.status).toBe(201);
    expect(created.body.channel.privacy).toBe('private');
    const list = await request(sana()).get('/api/social/channels');
    expect(list.body.channels.map((c: { slug: string }) => c.slug)).not.toContain('staff');
    expect((await request(sana()).get('/api/social/channels/staff')).status).toBe(404);
    expect((await request(sana()).post('/api/social/channels/staff/join')).status).toBe(404);
    expect((await request(sana()).get('/api/social/channels/moderators')).status).toBe(404);
  });
});

describe('GET /api/social/channels/:slug', () => {
  it('returns the channel, its members (owner first) and recent messages', async () => {
    const res = await request(sana()).get('/api/social/channels/general');
    expect(res.status).toBe(200);
    expect(res.body.channel.slug).toBe('general');
    expect(res.body.members[0]).toMatchObject({ userId: 'u-mira', displayName: 'Mira Okafor', role: 'owner' });
    expect(res.body.recent.length).toBe(socialChannelMessagesFixture.rows().filter((m) => m.channel === 'social:ch:general').length);
    expect(res.body.recent[0]).toMatchObject({ userId: 'u-mira', displayName: 'Mira Okafor' });
  });

  it('404s an unknown or malformed slug', async () => {
    expect((await request(sana()).get('/api/social/channels/no-such-channel')).status).toBe(404);
    expect((await request(sana()).get('/api/social/channels/Not_A_Slug')).status).toBe(404);
  });
});

describe('POST /api/social/channels/:slug/join and /leave', () => {
  it('join opens the channel to the guard; leave closes it again', async () => {
    const joined = await request(sana()).post('/api/social/channels/design-reviews/join');
    expect(joined.status).toBe(200);
    expect(joined.body.channel).toMatchObject({ joined: true, role: 'member' });
    expect(socialChat().membershipStore.isActiveMember('social:ch:design-reviews', 'u-sana')).toBe(true);
    // Joining twice is a no-op, not a second row.
    await request(sana()).post('/api/social/channels/design-reviews/join');
    expect(socialChannelMembersFixture.rows().filter((m) => m.channel === 'social:ch:design-reviews' && m.userId === 'u-sana')).toHaveLength(1);

    const left = await request(sana()).post('/api/social/channels/design-reviews/leave');
    expect(left.status).toBe(200);
    expect(left.body.channel).toMatchObject({ joined: false, role: null });
    expect(socialChat().membershipStore.isActiveMember('social:ch:design-reviews', 'u-sana')).toBe(false);
    // Re-joining restores the row rather than adding one.
    await request(sana()).post('/api/social/channels/design-reviews/join');
    expect(socialChat().membershipStore.isActiveMember('social:ch:design-reviews', 'u-sana')).toBe(true);
  });

  it('join 404s an unknown channel', async () => {
    expect((await request(sana()).post('/api/social/channels/nope/join')).status).toBe(404);
  });
});

describe('DMs', () => {
  it('GET /api/social/dms lists your conversations with the other person named', async () => {
    const res = await request(sana()).get('/api/social/dms');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      expect.objectContaining({ channel: 'social:dm:u-lena:u-sana', peers: [{ userId: 'u-lena', displayName: 'Lena Brandt' }], lastMessagePreview: 'Thanks Lena, will do.', lastMessageUserId: 'u-sana' }),
    ]);
    const miraDms = await request(mira()).get('/api/social/dms');
    expect(miraDms.body.conversations.map((c: { channel: string }) => c.channel)).toEqual(['social:dm:u-lena:u-mira']);
  });

  it('POST /api/social/dms opens the sorted lobby; refuses yourself and anyone outside the tenant', async () => {
    const res = await request(sana()).post('/api/social/dms').send({ userId: 'u-mira' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: 'social:dm:u-mira:u-sana', peers: [{ userId: 'u-mira', displayName: 'Mira Okafor' }] });
    expect((await request(sana()).post('/api/social/dms').send({ userId: 'u-sana' })).status).toBe(400);
    expect((await request(sana()).post('/api/social/dms').send({})).status).toBe(400);
    // u-hr holds orgiq only.
    expect((await request(sana()).post('/api/social/dms').send({ userId: 'u-hr' })).status).toBe(404);
  });
});

describe('DM unread counts and POST /api/social/dms/read', () => {
  it('counts messages from the other person after your cursor and your own last message; reading clears it', async () => {
    // Sana answered Lena last, so she has read the thread; Lena has not read Mira's question.
    const sanaDms = await request(sana()).get('/api/social/dms');
    expect(sanaDms.body.conversations[0].unreadCount).toBe(0);
    const lenaDms = await request(lena()).get('/api/social/dms');
    const withMira = lenaDms.body.conversations.find((c: { channel: string }) => c.channel === 'social:dm:u-lena:u-mira');
    expect(withMira.unreadCount).toBe(1);

    const read = await request(lena()).post('/api/social/dms/read').send({ channel: 'social:dm:u-lena:u-mira' });
    expect(read.status).toBe(200);
    expect(socialReadCursorsFixture.rows()).toEqual([expect.objectContaining({ channel: 'social:dm:u-lena:u-mira', userId: 'u-lena' })]);
    const after = await request(lena()).get('/api/social/dms');
    expect(after.body.conversations.find((c: { channel: string }) => c.channel === 'social:dm:u-lena:u-mira').unreadCount).toBe(0);
  });

  it('refuses a DM that does not name you (404) and anything that is not a DM (400)', async () => {
    expect((await request(sana()).post('/api/social/dms/read').send({ channel: 'social:dm:u-lena:u-mira' })).status).toBe(404);
    expect((await request(sana()).post('/api/social/dms/read').send({ channel: 'social:ch:general' })).status).toBe(400);
    expect((await request(sana()).post('/api/social/dms/read').send({})).status).toBe(400);
  });
});

describe('the seeded messages', () => {
  it('carry ids that sort like their timestamps (chat-messages orders a channel by messageId)', () => {
    const rows = socialChannelMessagesFixture.rows();
    for (const channel of new Set(rows.map((m) => m.channel))) {
      const mine = rows.filter((m) => m.channel === channel);
      const byId = [...mine].sort((a, b) => a.id.localeCompare(b.id)).map((m) => m.id);
      const byTime = [...mine].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((m) => m.id);
      expect(byId).toEqual(byTime);
      // …and before any id the library mints now.
      for (const id of byId) expect(id < Date.now().toString(36)).toBe(true);
    }
  });
});

describe('GET /api/social/people', () => {
  it('is exactly the users holding a social grant', async () => {
    const res = await request(sana()).get('/api/social/people');
    expect(res.status).toBe(200);
    const ids = res.body.people.map((p: { userId: string }) => p.userId);
    expect(ids).toEqual(expect.arrayContaining(['u-mira', 'u-lena', 'u-sana', 'u-operator', 'u-theo']));
    expect(ids).not.toContain('u-hr');
    expect(res.body.people.find((p: { userId: string }) => p.userId === 'u-mira')).toEqual({ userId: 'u-mira', displayName: 'Mira Okafor', roles: ['community-admin'] });
  });
});

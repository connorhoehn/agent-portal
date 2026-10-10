// /api/social rooms, teams, recordings and the call log (docs/social-tenant-design.md
// §4.4–§4.5, lane S2). Two halves:
//
//   1. dev:mock without a platform-api — the registered fixtures
//      (mock/social-platform.ts), under platform-api's own rules: a private
//      room is listed to its creator and members only; team channels stay out
//      of the rooms list; a private team 404s for a non-member; only the
//      team's owner adds people; only whoever started a recording deletes it;
//      recordings and calls are yours and in `social:` lobbies only. Writes
//      are Cedar-gated here (a participant 403s) and undone by fixture reset.
//   2. a platform-api configured — the BFF proxies with the caller's own
//      realtime token (sub = the session's), names partition `social` on every
//      call, passes platform-api's 403/404 through, and drops rows from other
//      partitions / lobbies.

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
import { decodeJwt } from 'jose';
import request from '../../test-support/http.js';
import { socialRouter } from '../social.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session } from '../../lib/session.js';
import {
  socialCallLogFixture, socialRecordingsFixture, socialRecordingTranscriptsFixture, socialRoomMembersFixture, socialRoomsFixture,
  socialTeamMembersFixture, socialTeamsFixture,
} from '../../mock/social-platform.js';
import { socialPlatformBackend, socialRecordingSharesFixture, standaloneRooms } from '../../providers/social-platform.js';

function appAs(sub: string, role: Role, tenant = 'social', name?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub, iat: 0, role, tenant, grants: { [tenant]: [role] }, ...(name ? { name } : {}) } as unknown as Session;
    next();
  });
  app.use('/api/social', requireTenant('social'), socialRouter);
  app.use(errorHandler);
  return app;
}
const sana = () => appAs('u-sana', 'participant');
const lena = () => appAs('u-lena', 'moderator');
const mira = () => appAs('u-mira', 'community-admin', 'social', 'Mira Okafor');

const FIXTURES = [socialRoomsFixture, socialRoomMembersFixture, socialTeamsFixture, socialTeamMembersFixture, socialRecordingsFixture, socialRecordingTranscriptsFixture, socialCallLogFixture, socialRecordingSharesFixture];
afterEach(() => { for (const f of FIXTURES) f.reset(); });

describe('dev:mock backend (no platform-api)', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    delete process.env['SOCIAL_PLATFORM_INTERNAL_URL'];
    delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
    delete process.env['PLATFORM_API_URL'];
  });
  afterAll(() => { process.env = saved; });

  it('reads the fixtures', () => { expect(socialPlatformBackend()).toBe('mock'); });

  describe('GET /api/social/rooms', () => {
    it('lists open rooms and the private ones you are in — never a team channel', async () => {
      const res = await request(sana()).get('/api/social/rooms');
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('mock');
      const slugs = res.body.rooms.map((r: { slug: string }) => r.slug);
      expect(slugs).toEqual(expect.arrayContaining(['town-hall', 'design-crit']));
      expect(slugs).not.toContain('moderators-desk');
      expect(slugs.some((s: string) => s.startsWith('community-'))).toBe(false);
      expect(res.body.rooms[0].lobbyName).toBe(`social:room:${res.body.rooms[0].slug}`);
      // Counted from the rows it returned.
      expect(res.body.counts).toEqual({ total: slugs.length, open: slugs.length, private: 0 });

      const member = await request(mira()).get('/api/social/rooms');
      expect(member.body.rooms.map((r: { slug: string }) => r.slug)).toContain('moderators-desk');
      expect(member.body.counts.private).toBe(1);
    });

    it('the empty scenario is an empty list, not an error', async () => {
      socialRoomsFixture.reset();
      socialRoomsFixture.rows().splice(0);
      const res = await request(sana()).get('/api/social/rooms');
      expect(res.status).toBe(200);
      expect(res.body.rooms).toEqual([]);
    });

    it('an orgiq session is refused at the tenant gate', async () => {
      expect((await request(appAs('u-theo', 'member', 'orgiq')).get('/api/social/rooms')).status).toBe(403);
    });
  });

  describe('POST /api/social/rooms', () => {
    it('ManageChannels creates; a private room stays out of everyone else\'s list', async () => {
      const res = await request(mira()).post('/api/social/rooms').send({ name: 'Quiet corner', visibility: 'private' });
      expect(res.status).toBe(201);
      expect(res.body.room).toMatchObject({ slug: 'quiet-corner', visibility: 'private', createdBy: 'u-mira', orgId: 'social', lobbyName: 'social:room:quiet-corner' });
      expect((await request(mira()).get('/api/social/rooms')).body.rooms.map((r: { slug: string }) => r.slug)).toContain('quiet-corner');
      expect((await request(sana()).get('/api/social/rooms')).body.rooms.map((r: { slug: string }) => r.slug)).not.toContain('quiet-corner');
      // A second with the same name gets the next slug, as upstream.
      expect((await request(lena()).post('/api/social/rooms').send({ name: 'Quiet corner' })).body.room.slug).toBe('quiet-corner-2');
    });

    it('a participant is refused (Cedar), and a nameless room is a 400', async () => {
      expect((await request(sana()).post('/api/social/rooms').send({ name: 'Mine' })).status).toBe(403);
      expect((await request(mira()).post('/api/social/rooms').send({ name: '  ' })).status).toBe(400);
    });
  });

  describe('teams', () => {
    it('GET /api/social/teams lists your teams with their channels', async () => {
      const res = await request(sana()).get('/api/social/teams');
      expect(res.status).toBe(200);
      expect(res.body.teams.map((t: { slug: string }) => t.slug)).toEqual(['community']);
      expect(res.body.teams[0]).toMatchObject({ role: 'member', channels: [expect.objectContaining({ slug: 'community-general' }), expect.objectContaining({ slug: 'community-events' })] });
      expect(res.body.counts).toEqual({ total: 1, channels: 2 });
      expect((await request(lena()).get('/api/social/teams')).body.teams.map((t: { slug: string }) => t.slug)).toEqual(expect.arrayContaining(['community', 'moderation']));
    });

    it('GET /api/social/teams/:teamId names members; a private team 404s for a non-member', async () => {
      const res = await request(sana()).get('/api/social/teams/mock-team-community');
      expect(res.status).toBe(200);
      expect(res.body.members.map((m: { userId: string }) => m.userId)).toEqual(expect.arrayContaining(['u-mira', 'u-lena', 'u-sana']));
      expect(res.body.members.find((m: { userId: string }) => m.userId === 'u-mira')).toMatchObject({ role: 'owner', displayName: expect.any(String) });
      expect((await request(sana()).get('/api/social/teams/mock-team-moderation')).status).toBe(404);
    });

    it('PATCH /api/social/teams/:teamId/me pins only the caller membership and refetch returns that preference', async () => {
      const pinned = await request(sana()).patch('/api/social/teams/mock-team-community/me').send({ favorite: true });
      expect(pinned.status).toBe(200);
      expect(pinned.body.member).toMatchObject({ teamId: 'mock-team-community', userId: 'u-sana', favorite: true });
      expect((await request(sana()).get('/api/social/teams')).body.teams[0].favorite).toBe(true);
      expect((await request(sana()).get('/api/social/teams/mock-team-community')).body.team.favorite).toBe(true);
      const ownerTeams = (await request(mira()).get('/api/social/teams')).body.teams;
      expect(ownerTeams.find((team: { teamId: string }) => team.teamId === 'mock-team-community').favorite).toBe(false);
      const unpinned = await request(sana()).patch('/api/social/teams/mock-team-community/me').send({ favorite: false });
      expect(unpinned.status).toBe(200); expect(unpinned.body.member.favorite).toBe(false);
    });

    it('PATCH team preferences rejects forged bodies and a private team outside the caller membership', async () => {
      expect((await request(sana()).patch('/api/social/teams/mock-team-community/me').send({ favorite: 'true' })).status).toBe(400);
      expect((await request(sana()).patch('/api/social/teams/mock-team-community/me').send({ favorite: true, userId: 'u-mira' })).status).toBe(400);
      expect((await request(sana()).patch('/api/social/teams/mock-team-moderation/me').send({ favorite: true })).status).toBe(404);
      expect((await request(sana()).get('/api/social/teams')).body.teams[0].favorite).toBe(false);
    });

    it('a participant can leave their own team while removing another person still needs ManageTeams', async () => {
      expect((await request(sana()).delete('/api/social/teams/mock-team-community/members/u-mira')).status).toBe(403);
      expect((await request(sana()).delete('/api/social/teams/mock-team-community/members/u-sana')).status).toBe(204);
      expect((await request(sana()).get('/api/social/teams')).body.teams).toEqual([]);
      expect((await request(sana()).patch('/api/social/teams/mock-team-community/me').send({ favorite: true })).status).toBe(403);
    });

    it('POST /api/social/teams creates the team with its General channel (ManageTeams)', async () => {
      const res = await request(lena()).post('/api/social/teams').send({ name: 'Events crew' });
      expect(res.status).toBe(201);
      expect(res.body.team).toMatchObject({ slug: 'events-crew', role: 'owner', channels: [expect.objectContaining({ slug: 'events-crew-general', name: 'General' })] });
      expect((await request(sana()).post('/api/social/teams').send({ name: 'Nope' })).status).toBe(403);
    });

    it('POST /api/social/teams/:teamId/members — the owner adds a workspace member; others are refused', async () => {
      const add = await request(mira()).post('/api/social/teams/mock-team-community/members').send({ userId: 'u-theo' });
      expect(add.status).toBe(201);
      expect(add.body.member).toMatchObject({ userId: 'u-theo', role: 'member' });
      // A moderator who is not the owner: upstream's rule.
      expect((await request(lena()).post('/api/social/teams/mock-team-community/members').send({ userId: 'u-farah' })).status).toBe(403);
      // Someone with no social grant is not in this workspace.
      expect((await request(mira()).post('/api/social/teams/mock-team-community/members').send({ userId: 'u-hr' })).status).toBe(404);
      expect((await request(sana()).post('/api/social/teams/mock-team-community/members').send({ userId: 'u-theo' })).status).toBe(403);
    });

    it('DELETE /api/social/teams/:teamId/members/:userId — the owner removes someone', async () => {
      const res = await request(mira()).delete('/api/social/teams/mock-team-community/members/u-sana');
      expect(res.status).toBe(204);
      expect((await request(sana()).get('/api/social/teams')).body.teams).toEqual([]);
      expect((await request(lena()).delete('/api/social/teams/mock-team-community/members/u-mira')).status).toBe(403);
    });
  });

  describe('recordings', () => {
    it('GET /api/social/recordings lists the ones you were in, social: lobbies only', async () => {
      socialRecordingsFixture.rows().push({ ...socialRecordingsFixture.rows()[0]!, recordingId: 'orgiq-one', lobbyName: 'orgiq:dm:u-sana:u-theo' });
      const res = await request(sana()).get('/api/social/recordings');
      expect(res.status).toBe(200);
      const ids = res.body.recordings.map((r: { recordingId: string }) => r.recordingId);
      expect(ids).toEqual(['mock-rec-dm-lena-sana', 'mock-rec-town-hall-1', 'mock-rec-town-hall-2']);
      expect(res.body.counts).toEqual({ total: 3, ready: 3 });
      expect((await request(lena()).get('/api/social/recordings')).body.recordings.map((r: { recordingId: string }) => r.recordingId))
        .toEqual(['mock-rec-dm-lena-sana', 'mock-rec-town-hall-1']);
    });

    it('GET /api/social/recordings/:recordingId/playback says there is nothing to play under mock; 404 when you were not in it', async () => {
      const res = await request(sana()).get('/api/social/recordings/mock-rec-town-hall-1/playback');
      expect(res.body).toEqual({ recordingId: 'mock-rec-town-hall-1', playlistUrl: null, mediaState: 'unavailable' });
      expect((await request(lena()).get('/api/social/recordings/mock-rec-town-hall-2/playback')).status).toBe(404);
    });

    it('GET /api/social/recordings/:recordingId/transcript serves speech to someone who was on the call, with the conversation it belongs to', async () => {
      const res = await request(sana()).get('/api/social/recordings/mock-rec-town-hall-1/transcript');
      expect(res.status).toBe(200);
      // Reactions are not speech; indexes keep their place in the document so a citation stays stable.
      expect(res.body.segments.map((s: { index: number }) => s.index)).toEqual([0, 1, 2, 4]);
      expect(res.body.segments[1]).toMatchObject({ speaker: 'Lena Brandt', text: expect.stringContaining('Moderation volume') });
      expect(res.body).toMatchObject({ status: 'ready', conversation: null, lobbyName: 'social:room:town-hall' });
      const dm = await request(sana()).get('/api/social/recordings/mock-rec-dm-lena-sana/transcript');
      expect(dm.body.conversation).toBe('social:dm:u-lena:u-sana');
    });

    it('the transcript has the playback proxy\'s authority: a recording you were not on is a 404, another tenant is a 403, and another lobby family does not exist', async () => {
      expect((await request(lena()).get('/api/social/recordings/mock-rec-town-hall-2/transcript')).status).toBe(404);
      expect((await request(mira()).get('/api/social/recordings/mock-rec-dm-lena-sana/transcript')).status).toBe(404);
      expect((await request(appAs('u-theo', 'member', 'orgiq')).get('/api/social/recordings/mock-rec-town-hall-1/transcript')).status).toBe(403);
      socialRecordingsFixture.rows().push({ ...socialRecordingsFixture.rows()[0]!, recordingId: 'orgiq-one', lobbyName: 'orgiq:dm:u-sana:u-theo' });
      expect((await request(sana()).get('/api/social/recordings/orgiq-one/transcript')).status).toBe(404);
      expect((await request(sana()).get('/api/social/recordings/nope/transcript')).status).toBe(404);
    });

    it('a transcript still being made is a 202 with whether to ask again; the fixture reset restores the seed', async () => {
      const t = socialRecordingTranscriptsFixture.rows().find((r) => r.recordingId === 'mock-rec-dm-lena-sana')!;
      t.transcriptStatus = 'pending';
      const res = await request(sana()).get('/api/social/recordings/mock-rec-dm-lena-sana/transcript');
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'pending', terminal: false, retryAfterMs: 5000 });
      socialRecordingTranscriptsFixture.reset();
      expect((await request(sana()).get('/api/social/recordings/mock-rec-dm-lena-sana/transcript')).status).toBe(200);
    });

    it('POST /api/social/recordings/:recordingId/share mints a link (ManageRecordings)', async () => {
      const res = await request(mira()).post('/api/social/recordings/mock-rec-town-hall-1/share');
      expect(res.status).toBe(201);
      expect(res.body.shareUrl).toBe(`/recordings/share/${res.body.shareToken}`);
      expect(socialRecordingSharesFixture.rows()).toHaveLength(1);
      expect((await request(sana()).post('/api/social/recordings/mock-rec-town-hall-1/share')).status).toBe(403);
    });

    it('DELETE /api/social/recordings/:recordingId — only whoever started it', async () => {
      expect((await request(lena()).delete('/api/social/recordings/mock-rec-town-hall-1')).status).toBe(403);
      expect((await request(mira()).delete('/api/social/recordings/mock-rec-town-hall-1')).status).toBe(204);
      expect(socialRecordingsFixture.rows().some((r) => r.recordingId === 'mock-rec-town-hall-1')).toBe(false);
      expect((await request(sana()).delete('/api/social/recordings/mock-rec-town-hall-2')).status).toBe(403);
    });
  });

  describe('GET /api/social/calls', () => {
    it('your call log in social: lobbies, with the missed count counted', async () => {
      const res = await request(sana()).get('/api/social/calls');
      expect(res.status).toBe(200);
      expect(res.body.calls.every((c: { userId: string }) => c.userId === 'u-sana')).toBe(true);
      expect(res.body.counts).toEqual({ total: res.body.calls.length, missed: 1 });
      expect(res.body.calls.map((c: { outcome: string }) => c.outcome)).toContain('missed');
    });
  });
});

describe('platform-api configured — the BFF proxies with the caller\'s token', () => {
  const saved = { ...process.env };
  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
  let reply: (url: string, method: string) => { status: number; body: unknown };

  beforeAll(() => { process.env['SOCIAL_PLATFORM_INTERNAL_URL'] = 'http://platform.test:3001/'; });
  afterAll(() => { process.env = saved; global.fetch = realFetch; });
  beforeEach(() => {
    calls = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, auth: headers['Authorization'] ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const { status, body } = reply(url, method);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }) as typeof fetch;
  });

  const room = (slug: string, extra: Record<string, unknown> = {}) => ({
    orgId: 'social', roomId: `r-${slug}`, slug, name: slug, createdBy: 'u-mira', createdAt: '2026-09-29T00:00:00.000Z',
    visibility: 'org', settings: { audioOnly: false, recordingEnabled: false, softCap: 25 }, state: 'active', lastActiveAt: '2026-09-29T00:00:00.000Z', ...extra,
  });

  it('GET /api/social/rooms signs as the caller, names the partition, and leaves team channels out', async () => {
    reply = () => ({ status: 200, body: { rooms: [room('town-hall'), room('eng-general', { teamId: 't1' }), room('elsewhere', { orgId: 'orgiq' })] } });
    const res = await request(sana()).get('/api/social/rooms');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('platform');
    expect(res.body.rooms.map((r: { slug: string }) => r.slug)).toEqual(['town-hall']);
    expect(calls[0]!.url).toBe('http://platform.test:3001/api/rooms?limit=200&tenant=social');
    const claims = decodeJwt(calls[0]!.auth.replace(/^Bearer /, ''));
    expect(claims).toMatchObject({ sub: 'u-sana', org: 'social', tokenKind: 'orgiq-hs256' });
  });

  it('Social uses its private service when document and browser platform endpoints are also configured', async () => {
    const keys = ['DOCUMENT_PLATFORM_INTERNAL_URL', 'REALTIME_PLATFORM_PUBLIC_URL', 'PLATFORM_API_URL'] as const;
    const previous = keys.map(key => process.env[key]);
    try {
      process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = 'http://workspace-platform.orgiq-documents.local:3001';
      process.env['REALTIME_PLATFORM_PUBLIC_URL'] = 'https://platform.public.test';
      process.env['PLATFORM_API_URL'] = 'http://work-graph.internal:3001';
      reply = () => ({ status: 200, body: { rooms: [room('town-hall')] } });
      const res = await request(sana()).get('/api/social/rooms');
      expect(res.status).toBe(200);
      expect(calls.map(call => call.url)).toEqual(['http://platform.test:3001/api/rooms?limit=200&tenant=social']);
    } finally {
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key];
        else process.env[key] = previous[i];
      });
    }
  });

  it('POST /api/social/rooms carries tenant in the body; a platform 403 on a private room passes through', async () => {
    reply = (_url, method) => (method === 'POST' ? { status: 201, body: { room: room('quiet', { visibility: 'private' }) } } : { status: 403, body: { error: 'Access denied to room: quiet' } });
    const res = await request(mira()).post('/api/social/rooms').send({ name: 'Quiet', visibility: 'private' });
    expect(res.status).toBe(201);
    expect(calls[0]!.body).toEqual({ name: 'Quiet', visibility: 'private', tenant: 'social' });
    expect(res.body.room.lobbyName).toBe('social:room:quiet');
    const denied = await request(sana()).get('/api/social/teams/t-private');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('Access denied to room: quiet');
  });

  it('GET /api/social/recordings/:recordingId/transcript asks platform-api for the recording first (404 for a non-social lobby), then its transcript, as the caller', async () => {
    reply = (url) => {
      if (url.includes('/recordings/rec-dm/transcript')) return { status: 200, body: { segments: [
        { startMs: 0, endMs: 5000, speakerId: 'u-lena', speakerLabel: 'Lena', text: ' Ship it  Friday. ' }, { startMs: 6000, endMs: 7000, speakerId: 'u-sana', speakerLabel: 'Sana', text: 'reacted with 👍', kind: 'reaction' },
      ] } };
      if (url.includes('/recordings/rec-dm')) return { status: 200, body: { recordingId: 'rec-dm', lobbyName: 'social:dm:u-lena:u-sana', startedAt: '2026-10-01T10:00:00.000Z' } };
      if (url.includes('/recordings/rec-pending/transcript')) return { status: 202, body: { status: 'processing', terminal: false, retryAfterMs: 7000, error: null } };
      if (url.includes('/recordings/rec-pending')) return { status: 200, body: { recordingId: 'rec-pending', lobbyName: 'social:dm:u-lena:u-sana', startedAt: '2026-10-01T10:00:00.000Z' } };
      if (url.includes('/recordings/rec-other')) return { status: 200, body: { recordingId: 'rec-other', lobbyName: 'orgiq:dm:u-a:u-b', startedAt: '2026-10-01T10:00:00.000Z' } };
      return { status: 404, body: { error: 'recording not found' } };
    };
    const ok = await request(sana()).get('/api/social/recordings/rec-dm/transcript');
    expect(ok.status).toBe(200);
    expect(ok.body.segments).toEqual([{ index: 0, startMs: 0, endMs: 5000, speakerId: 'u-lena', speaker: 'Lena', text: 'Ship it Friday.' }]);
    expect(ok.body.conversation).toBe('social:dm:u-lena:u-sana');
    expect(calls.map((c) => c.url)).toEqual([
      'http://platform.test:3001/api/recordings/rec-dm?tenant=social', 'http://platform.test:3001/api/recordings/rec-dm/transcript?tenant=social']);
    expect(decodeJwt(calls[1]!.auth.replace(/^Bearer /, ''))).toMatchObject({ sub: 'u-sana', org: 'social' });
    const pending = await request(sana()).get('/api/social/recordings/rec-pending/transcript');
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'processing', terminal: false, retryAfterMs: 7000 });
    expect((await request(sana()).get('/api/social/recordings/rec-other/transcript')).status).toBe(404);
    expect((await request(sana()).get('/api/social/recordings/rec-gone/transcript')).status).toBe(404);
    // Fresh per request: asking again asks platform-api again.
    calls = [];
    await request(sana()).get('/api/social/recordings/rec-dm/transcript');
    expect(calls).toHaveLength(2);
  });

  it('GET /api/social/recordings and /calls keep social: lobbies only; a 5xx upstream is a 502', async () => {
    reply = (url) => (url.includes('/api/recordings')
      ? { status: 200, body: { items: [{ recordingId: 'a', lobbyName: 'social:room:x', startedAt: '2026-09-29T01:00:00.000Z', stage: 'ready', participants: [] }, { recordingId: 'b', lobbyName: 'orgiq:dm:u-a:u-b', startedAt: '2026-09-29T02:00:00.000Z', stage: 'ready', participants: [] }], cursor: null } }
      : url.includes('/api/calls/log') ? { status: 200, body: { calls: [{ callId: 'c1', lobbyName: 'social:dm:u-mira:u-sana', outcome: 'missed', direction: 'incoming', startedAt: '2026-09-29T00:00:00.000Z' }, { callId: 'c2', lobbyName: 'assessment:doc:1', outcome: 'answered', direction: 'joined', startedAt: '2026-09-29T00:00:00.000Z' }] } }
        : { status: 500, body: { error: 'boom' } });
    expect((await request(sana()).get('/api/social/recordings')).body.recordings.map((r: { recordingId: string }) => r.recordingId)).toEqual(['a']);
    const log = await request(sana()).get('/api/social/calls');
    expect(log.body.calls.map((c: { callId: string }) => c.callId)).toEqual(['c1']);
    expect(log.body.counts).toEqual({ total: 1, missed: 1 });
    expect((await request(sana()).get('/api/social/teams')).status).toBe(502);
  });
});

describe('standaloneRooms', () => {
  it('drops team channels and archived rooms, newest activity first', () => {
    const rows = socialRoomsFixture.rows();
    const out = standaloneRooms([...rows, { ...rows[0]!, slug: 'old', state: 'archived' }]);
    expect(out.some((r) => r.teamId || r.state !== 'active')).toBe(false);
    expect(out.map((r) => r.lastActiveAt)).toEqual([...out.map((r) => r.lastActiveAt)].sort().reverse());
  });
});

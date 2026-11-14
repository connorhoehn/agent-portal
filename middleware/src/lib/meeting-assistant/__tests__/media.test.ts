// Arming the media server's tap (docs/meeting-assistant-design.md, package 6a) against a fake media server on a loopback port:
// create (with the admin token), `409 no audio producer in channel` retried with backoff for up to a minute and then said in the
// chat, delete when the token dies, and listing to reuse a tap that already points at this sink and to clear stale ones of ours.
const mockConfig: { region: string; auth: object; cognito: object; mock: { aurora: boolean }; meetingAssistant: { enabled: boolean; transcriptRetentionDays: number; media: { url: string; adminToken: string; sinkBaseUrl: string } } } = {
  region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: false },
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30, media: { url: '', adminToken: '', sinkBaseUrl: '' } },
};
jest.mock('../../../config.js', () => ({ config: mockConfig }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../chat.js', () => ({ nameOf: async (id: string) => id, postNoticeQuietly: jest.fn(async () => undefined) }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AudioIntake } from '../audio-intake.js';
import { CANNOT_HEAR_NOTICE, DirectMediaClient, SINK_PATH, TapArmer, mediaConfig, missingMediaSettings, preflightAudio, setChannelResolver, liveForced } from '../media.js';
import { MemoryAssistantStore } from '../store.js';
import { newAssistantSession } from '../types.js';
import { setAssistantStore } from '../store-select.js';
import type { Session } from '../../session.js';

const CALL = 'call-1', ARN = 'arn:aws:ivs:us-east-1:000000000000:channel/room-1';
const ADMIN = 'admin-secret-value-123';
const SINK_BASE = 'http://host.docker.internal:3953';

interface Seen { method: string; url: string; auth: string | undefined; body: unknown }
let server: http.Server; let seen: Seen[]; let port: number;
let behaviour: { create: Array<{ status: number; body?: unknown }>; list: Array<{ tapId: string; destination: { url: string } }>; deleteStatus: number };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown = null; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = 'bad'; }
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${ADMIN}`) { res.writeHead(401).end(); return; }
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(behaviour.list)); return; }
      if (req.method === 'DELETE') { res.writeHead(behaviour.deleteStatus).end(); return; }
      const next = behaviour.create.shift() ?? { status: 201, body: { tapId: 'tap-1' } };
      res.writeHead(next.status, { 'content-type': 'application/json' }).end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

let now: number; let store: MemoryAssistantStore; let audio: AudioIntake; let armer: TapArmer; let notices: string[]; let sleeps: number[]; let warn: jest.SpyInstance;
const settle = async () => { await armer.idle(); for (let i = 0; i < 4; i += 1) await new Promise<void>((r) => setImmediate(r)); };

beforeEach(async () => {
  now = 1_000_000; seen = []; notices = []; sleeps = [];
  behaviour = { create: [], list: [], deleteStatus: 204 };
  mockConfig.mock.aurora = false;
  mockConfig.meetingAssistant.media = { url: `http://127.0.0.1:${port}`, adminToken: ADMIN, sinkBaseUrl: SINK_BASE };
  store = new MemoryAssistantStore(); setAssistantStore(store);
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:dm:a:b', initiativeId: null, state: 'listening', invitedBy: 'u-ana', invitedAt: now, pausedBy: null, leftAt: null, leftBy: null,
    acked: ['u-ana'], attendees: ['u-ana'], presentAtInvite: ['u-ana'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
  });
  audio = new AudioIntake(() => store, { clock: () => now, tickMs: 0 });
  armer = new TapArmer({ audio: () => audio, clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, notify: async (_c, t) => { notices.push(t); } });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { audio.dispose(); setAssistantStore(null); setChannelResolver(null); warn.mockRestore(); delete process.env['MEETING_ASSISTANT_LIVE']; });

const tapPosts = () => seen.filter((s) => s.method === 'POST');
const sinkOf = (s: Seen) => (s.body as { destination: { url: string } }).destination.url;

describe('creating the tap', () => {
  it('posts a per-participant webhook-pcm tap for the call\'s channel with the admin token, pointing at the sink with a fresh token', async () => {
    await armer.arm(CALL, ARN); await settle();
    const posts = tapPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`/api/channels/${encodeURIComponent(ARN)}/taps`);
    expect(posts[0]!.auth).toBe(`Bearer ${ADMIN}`);
    const url = sinkOf(posts[0]!);
    expect(url.startsWith(`${SINK_BASE}${SINK_PATH}`)).toBe(true);
    const token = url.slice(`${SINK_BASE}${SINK_PATH}`.length);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(posts[0]!.body).toMatchObject({ destination: { type: 'webhook-pcm', chunkMs: 200, perParticipant: true } });
    expect(armer.tapsOf(CALL)).toEqual(['tap-1']);
    expect(audio.admit(token, ARN)).toBe('unknown'); // no session attached yet: the token is armed but nothing listens
    expect(audio.isArmed(CALL)).toBe(true);
  });

  it('a 409 "no audio producer in channel" is retried with a growing pause until the tap takes', async () => {
    behaviour.create = [1, 2, 3].map(() => ({ status: 409, body: { error: 'no audio producer in channel' } }));
    await armer.arm(CALL, ARN); await settle();
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(tapPosts()).toHaveLength(4);
    expect(armer.tapsOf(CALL)).toEqual(['tap-1']);
    expect(notices).toEqual([]);
  });

  it('gives up after a minute with a plain notice in the call chat, and stops asking', async () => {
    behaviour.create = Array.from({ length: 100 }, () => ({ status: 409, body: { error: 'no audio producer in channel' } }));
    await armer.arm(CALL, ARN); await settle();
    expect(notices).toEqual([CANNOT_HEAR_NOTICE]);
    expect(CANNOT_HEAR_NOTICE).toMatch(/^Nova cannot hear this call yet/);
    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(60_000 - 8000);
    expect(total).toBeLessThanOrEqual(60_000 + 8000);
    const after = tapPosts().length;
    await settle();
    expect(tapPosts().length).toBe(after);
    expect(armer.tapsOf(CALL)).toEqual([]);
  });

  it('a refusal that cannot be retried (the admin token is wrong) says so at once, and never prints the token', async () => {
    mockConfig.meetingAssistant.media.adminToken = 'wrong-token';
    await armer.arm(CALL, ARN); await settle();
    expect(notices).toEqual([CANNOT_HEAR_NOTICE]);
    expect(sleeps).toEqual([]);
    const printed = JSON.stringify([...warn.mock.calls, notices]);
    expect(printed).not.toContain(ADMIN);
    expect(printed).not.toContain('wrong-token');
  });

  it('a server error is retried like a missing producer', async () => {
    behaviour.create = [{ status: 502, body: 'bad gateway' }, { status: 201, body: { tapId: 'tap-9' } }];
    await armer.arm(CALL, ARN); await settle();
    expect(sleeps).toEqual([1000]);
    expect(armer.tapsOf(CALL)).toEqual(['tap-9']);
  });
});

describe('deleting and reusing', () => {
  it('deletes the tap the moment the token dies (pause, leave, ceiling and call end all end there)', async () => {
    await armer.arm(CALL, ARN); await settle();
    audio.detach(CALL);
    await settle();
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual([`/api/channels/${encodeURIComponent(ARN)}/taps/tap-1`]);
    expect(armer.tapsOf(CALL)).toEqual([]);
  });

  it('reuses a listed tap that already points at exactly this sink, and creates nothing', async () => {
    // The token is minted inside `arm`, so the fake server answers the list with a tap pointing at whatever the create would say.
    let sinkSeen = '';
    const real = DirectMediaClient.prototype.list;
    const spy = jest.spyOn(DirectMediaClient.prototype, 'list').mockImplementation(async function (this: DirectMediaClient, arn: string) {
      const rows = await real.call(this, arn); void rows;
      return [{ tapId: 'tap-existing', url: sinkSeen }];
    });
    const create = jest.spyOn(DirectMediaClient.prototype, 'create').mockImplementation(async () => ({ kind: 'created', tapId: 'never' }));
    const arm = jest.spyOn(audio, 'arm').mockImplementation(async (c: string, a: string) => { const t = await AudioIntake.prototype.arm.call(audio, c, a); sinkSeen = `${SINK_BASE}${SINK_PATH}${t}`; return t; });
    await armer.arm(CALL, ARN); await settle();
    expect(armer.tapsOf(CALL)).toEqual(['tap-existing']);
    expect(create).not.toHaveBeenCalled();
    spy.mockRestore(); create.mockRestore(); arm.mockRestore();
  });

  it('clears a stale tap of ours (an old token), leaves a stranger\'s tap alone', async () => {
    behaviour.list = [
      { tapId: 'stale', destination: { url: `${SINK_BASE}${SINK_PATH}${'A'.repeat(43)}` } },
      { tapId: 'captions', destination: { url: 'http://captions.local/pcm' } },
    ];
    await armer.arm(CALL, ARN); await settle();
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual([`/api/channels/${encodeURIComponent(ARN)}/taps/stale`]);
    expect(armer.tapsOf(CALL)).toEqual(['tap-1']);
  });

  it('disarming while a create is still being retried stops the retries, and a tap that was made anyway is deleted', async () => {
    behaviour.create = [{ status: 409, body: { error: 'no audio producer in channel' } }];
    const slowSleep = armer as unknown as { sleep: (ms: number) => Promise<void> };
    slowSleep.sleep = async (ms) => { sleeps.push(ms); now += ms; await armer.disarm(CALL); };
    await armer.arm(CALL, ARN); await settle();
    expect(tapPosts()).toHaveLength(1);
    expect(armer.tapsOf(CALL)).toEqual([]);
  });

  it('a new arming (resume) replaces the old token and the old tap', async () => {
    await armer.arm(CALL, ARN); await settle();
    const first = sinkOf(tapPosts()[0]!);
    await armer.arm(CALL, ARN); await settle();
    const second = sinkOf(tapPosts()[1]!);
    expect(second).not.toBe(first);
    expect(seen.filter((s) => s.method === 'DELETE')).toHaveLength(1);
  });
});

describe('before anything starts (preflight)', () => {
  const session = { sub: 'u-ana', name: 'Ana', tenant: 'orgiq', role: 'member', epoch: 0, grants: {}, iat: 0 } as unknown as Session;

  it('refuses the real path with a plain 503 naming the missing settings, never their values', async () => {
    mockConfig.meetingAssistant.media = { url: `http://127.0.0.1:${port}`, adminToken: '', sinkBaseUrl: '' };
    await expect(preflightAudio(session, CALL, 'orgiq:dm:a:b')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN') });
    await expect(preflightAudio(session, CALL, 'orgiq:dm:a:b')).rejects.toMatchObject({ message: expect.stringContaining('MEETING_ASSISTANT_SINK_BASE_URL') });
    expect(missingMediaSettings()).toEqual(['MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN', 'MEETING_ASSISTANT_SINK_BASE_URL']);
    await expect(preflightAudio(session, CALL, 'orgiq:dm:a:b')).rejects.not.toMatchObject({ message: expect.stringContaining(`${port}`) });
  });

  it('refuses when the call\'s channel cannot be found, and uses only what the server\'s own lookup says', async () => {
    const asked: string[] = [];
    setChannelResolver({ channelOf: async (_s, callId, lobby) => { asked.push(`${callId}|${lobby}`); return null; } });
    await expect(preflightAudio(session, CALL, 'orgiq:dm:a:b')).rejects.toMatchObject({ status: 503 });
    setChannelResolver({ channelOf: async (_s, callId, lobby) => { asked.push(`${callId}|${lobby}`); return ARN; } });
    await expect(preflightAudio(session, CALL, 'orgiq:dm:a:b')).resolves.toEqual({ channelArn: ARN, arm: true });
    expect(asked).toEqual([`${CALL}|orgiq:dm:a:b`, `${CALL}|orgiq:dm:a:b`]);
  });

  it('the plain mock world needs none of it; the forced-live mock world arms nothing without media settings and arms with them', async () => {
    mockConfig.mock.aurora = true;
    expect(await preflightAudio(session, CALL, 'orgiq:dm:a:b')).toBeNull();
    process.env['MEETING_ASSISTANT_LIVE'] = '1';
    expect(liveForced()).toBe(true);
    setChannelResolver({ channelOf: async () => ARN });
    expect(await preflightAudio(session, CALL, 'orgiq:dm:a:b')).toEqual({ channelArn: ARN, arm: true });
    mockConfig.meetingAssistant.media = { url: '', adminToken: '', sinkBaseUrl: '' };
    expect(await preflightAudio(session, CALL, 'orgiq:dm:a:b')).toEqual({ channelArn: `mock-channel:${CALL}`, arm: false });
  });

  it('the forced-live flag means nothing in production', () => {
    process.env['MEETING_ASSISTANT_LIVE'] = '1';
    const was = process.env['NODE_ENV']; process.env['NODE_ENV'] = 'production';
    expect(liveForced()).toBe(false);
    process.env['NODE_ENV'] = was;
  });

  it('settings with credentials in the address, or not http(s), are not accepted', () => {
    mockConfig.meetingAssistant.media = { url: 'http://user:pw@media.local', adminToken: ADMIN, sinkBaseUrl: SINK_BASE };
    expect(mediaConfig()).toBeNull();
    mockConfig.meetingAssistant.media = { url: 'ftp://media.local', adminToken: ADMIN, sinkBaseUrl: SINK_BASE };
    expect(mediaConfig()).toBeNull();
    mockConfig.meetingAssistant.media = { url: 'http://media.local/', adminToken: ADMIN, sinkBaseUrl: `${SINK_BASE}/` };
    expect(mediaConfig()).toEqual({ url: 'http://media.local', adminToken: ADMIN, sinkBaseUrl: SINK_BASE });
  });
});

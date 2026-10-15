// Reactions and file uploads on the realtime gateway (parity gaps #2, #9):
// a member may subscribe, react, request an upload and move its bytes; a
// cross-tenant caller is refused at every step (the router's channelGuard,
// reached with the `reactions:` prefix stripped); size and type limits hold.

// Real Cedar seed roles: tenant channel families ask ViewAssessment etc. (lib/tenant-channels.ts).
jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, authenticateGatewayUpgrade, channelGuard, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { createUploadsRouter, gatewayUploadConfig, resetGatewayUploadBackendForTests, uploadTypeAllowed } from '../gateway-attachments.js';
import { rejectUnsupportedUpgrades } from '../unsupported-upgrades.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { getUser } from '../../providers/identity.js';

const SECRET = 'test-realtime-secret';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-uploads-'));
const MAX = 64;
const DOC_CHANNEL = 'assessment:doc:page:100002';
const PRESENCE_CHANNEL = 'assessment:knowledge:confluence-eng';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  process.env['GATEWAY_UPLOAD_DIR'] = UPLOAD_DIR;
  process.env['GATEWAY_UPLOAD_MAX_BYTES'] = String(MAX);
  resetGatewayUploadBackendForTests();
  const app = express();
  app.use('/api/uploads', createUploadsRouter(
    token => authenticateGatewayUpgrade({ headers: { 'sec-websocket-protocol': `bearer-token-v1, ${token}` } } as never),
    { guard: channelGuard, baseChannel },
    gatewayUploadConfig(),
    // Stands in for the signed session cookie: the header names whose session it is.
    async req => tokens.get(req.get('x-test-session') ?? '') ?? null));
  server = http.createServer(app);
  const handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 });
  dispose = handle.dispose;
  rejectUnsupportedUpgrades(server, { allowPaths: [REALTIME_GATEWAY_PATH] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

const tokens = new Map<string, string>();
async function connectAs(sub: string, name: string, tenant: string): Promise<Open> {
  const user = await getUser(sub, { authoritative: true });
  const session = { sub, name, role: user?.grants[tenant]?.[0], tenant, grants: user?.grants ?? {}, epoch: user?.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  tokens.set(sub, token);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some((f) => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
        else if (Date.now() - start > 2_000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const denied = (o: Open) => o.frames.filter((f) => f.type === 'error' && f.code === 'AUTHZ_CHANNEL_DENIED');
const chatFrames = (o: Open) => o.frames.filter((f) => f.type === 'chat');
const messageTexts = (o: Open) => chatFrames(o).map((f) => JSON.stringify(f)).join('\n');

let theo: Open;
let farah: Open;
let jonas: Open;
beforeEach(async () => {
  theo = await connectAs('u-theo', 'Theo Orgiq', 'orgiq');
  farah = await connectAs('u-farah', 'Farah Assessor', 'assessment');
  jonas = await connectAs('u-jonas', 'Jonas Assessor', 'assessment');
});
afterEach(() => { for (const o of [theo, farah, jonas]) o.ws.close(); });

const REACTIONS = `reactions:${DOC_CHANNEL}`;
const reactionFrames = (o: Open, action: string) => o.frames.filter((f) => f.type === 'reaction' && f.action === action);

describe('reactions', () => {
  it('fan out between members of the channel and persist a targeted one for a later subscriber', async () => {
    send(farah, { service: 'reaction', action: 'subscribe', channel: DOC_CHANNEL });
    send(jonas, { service: 'reaction', action: 'subscribe', channel: DOC_CHANNEL });
    await settle();
    send(farah, { service: 'reaction', action: 'send', channel: DOC_CHANNEL, emoji: '👍', targetId: 'm-1' });
    await until(() => reactionFrames(jonas, 'reaction_received').length > 0);
    expect(JSON.stringify(reactionFrames(jonas, 'reaction_received')[0])).toContain('m-1');
    expect(denied(farah)).toHaveLength(0);
    const late = await connectAs('u-farah', 'Farah Assessor', 'assessment');
    send(late, { service: 'reaction', action: 'subscribe', channel: DOC_CHANNEL });
    await until(() => JSON.stringify(late.frames).includes('m-1'));
    late.ws.close();
  });

  it('refuse another tenant: no subscribe, no send, nothing reaches the members', async () => {
    send(jonas, { service: 'reaction', action: 'subscribe', channel: DOC_CHANNEL });
    await settle();
    send(theo, { service: 'reaction', action: 'subscribe', channel: DOC_CHANNEL });
    send(theo, { service: 'reaction', action: 'send', channel: DOC_CHANNEL, emoji: '🔥', targetId: 'm-9' });
    await settle(400);
    expect(JSON.stringify(theo.frames)).toContain('AUTHZ_CHANNEL_DENIED');
    expect(reactionFrames(jonas, 'reaction_received').filter((f) => JSON.stringify(f).includes('m-9'))).toHaveLength(0);
    expect(REACTIONS.startsWith('reactions:')).toBe(true);
  });
});

describe('uploads', () => {
  const request = async (o: Open, channel: string, id: string, size: number) => {
    send(o, { service: 'fileupload', action: 'request-upload', channel, id, filename: 'note.png', size });
  };
  const put = (sub: string, uploadUrl: string, body: Buffer | string, type = 'image/png') =>
    fetch(`http://127.0.0.1:${port}${uploadUrl}`, { method: 'PUT', headers: { Authorization: `Bearer ${tokens.get(sub)}`, 'Content-Type': type }, body: typeof body === 'string' ? body : new Uint8Array(body) });
  const get = (sub: string, url: string) => fetch(`http://127.0.0.1:${port}${url}`, { headers: { Authorization: `Bearer ${tokens.get(sub)}` } });
  const urlFrame = (o: Open, id: string) => o.frames.find((f) => f.type === 'fileupload:url' && f['id'] === id) as (Frame & { uploadUrl: string }) | undefined;

  it('a member requests an upload, sends the bytes and another member downloads them', async () => {
    // Completion is a channel broadcast, so the sender is in the chat like the real hook's host.
    send(farah, { service: 'chat', action: 'join', channel: DOC_CHANNEL });
    await settle();
    await request(farah, DOC_CHANNEL, 'c-1', 5);
    await until(() => !!urlFrame(farah, 'c-1'));
    const url = urlFrame(farah, 'c-1')!.uploadUrl;
    expect((await put('u-farah', url, 'hello')).status).toBe(200);
    send(farah, { service: 'fileupload', action: 'complete', channel: DOC_CHANNEL, id: 'c-1' });
    await until(() => farah.frames.some((f) => f.type === 'fileupload:complete'));
    const down = await get('u-jonas', url);
    expect(down.status).toBe(200);
    expect(down.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await down.text()).toBe('hello');
  });

  it('refuses an outsider at the request, the PUT and the GET', async () => {
    await request(theo, DOC_CHANNEL, 'o-1', 5);
    await settle(400);
    expect(urlFrame(theo, 'o-1')).toBeUndefined();
    await request(farah, DOC_CHANNEL, 'c-2', 5);
    await until(() => !!urlFrame(farah, 'c-2'));
    const url = urlFrame(farah, 'c-2')!.uploadUrl;
    expect((await put('u-theo', url, 'hello')).status).toBe(403);
    expect((await put('u-farah', url, 'hello')).status).toBe(200);
    expect((await get('u-theo', url)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}${url}`)).status).toBe(401);
  });

  it('an expired bearer falls back to the session, which still faces the channel guard', async () => {
    await request(farah, DOC_CHANNEL, 'c-s', 5);
    await until(() => !!urlFrame(farah, 'c-s'));
    const url = urlFrame(farah, 'c-s')!.uploadUrl;
    const stale = (session?: string) => fetch(`http://127.0.0.1:${port}${url}`, { method: 'PUT',
      headers: { Authorization: 'Bearer expired.token.value', 'Content-Type': 'image/png', ...(session ? { 'x-test-session': session } : {}) }, body: 'hello' });
    expect((await stale()).status).toBe(401);
    expect((await stale('u-theo')).status).toBe(403);
    expect((await stale('u-farah')).status).toBe(200);
  });

  it('enforces the byte cap and the type allowlist', async () => {
    await request(farah, DOC_CHANNEL, 'c-3', 5);
    await until(() => !!urlFrame(farah, 'c-3'));
    const url = urlFrame(farah, 'c-3')!.uploadUrl;
    expect((await put('u-farah', url, '<script>1</script>', 'text/html')).status).toBe(415);
    await request(farah, DOC_CHANNEL, 'c-4', 5);
    await until(() => !!urlFrame(farah, 'c-4'));
    expect((await put('u-farah', urlFrame(farah, 'c-4')!.uploadUrl, Buffer.alloc(MAX + 1))).status).toBe(413);
  });

  it('allows documents and images but never markup', () => {
    for (const ok of ['image/png', 'application/pdf', 'text/plain; charset=utf-8', 'video/mp4']) expect(uploadTypeAllowed(ok)).toBe(true);
    for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'application/json', 'application/octet-stream']) expect(uploadTypeAllowed(bad)).toBe(false);
  });
});

describe('a .pptx shared into a Social channel', () => {
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const CHANNEL = 'social:ch:deck-reviews';
  const row = (userId: string, removedAt: string | null = null) => ({ channel: CHANNEL, userId, role: 'member' as const, addedBy: 'u-farah',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt });
  const urlFrame = (o: Open, id: string) => o.frames.find((f) => f.type === 'fileupload:url' && f['id'] === id) as (Frame & { uploadUrl: string }) | undefined;
  const fetchAs = (sub: string, url: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { Authorization: `Bearer ${tokens.get(sub)}`, ...(init.headers ?? {}) } });

  async function upload(): Promise<string> {
    const { socialChat } = await import('../social-chat.js');
    const store = socialChat().membershipStore;
    await store.putMember(row('u-farah'));
    await store.putMember(row('u-jonas'));
    send(farah, { service: 'chat', action: 'join', channel: CHANNEL });
    await settle();
    send(farah, { service: 'fileupload', action: 'request-upload', channel: CHANNEL, id: 'deck-1', filename: 'Review.pptx', size: 5 });
    await until(() => !!urlFrame(farah, 'deck-1'));
    const url = urlFrame(farah, 'deck-1')!.uploadUrl;
    expect((await fetchAs('u-farah', url, { method: 'PUT', headers: { 'Content-Type': PPTX }, body: 'slide' })).status).toBe(200);
    return url;
  }

  it('lets a channel member download it and refuses a non-member', async () => {
    const url = await upload();
    const ok = await fetchAs('u-jonas', url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('slide');
    expect((await fetchAs('u-theo', url)).status).toBe(403);
  });

  it('refuses a member once they are removed from the channel', async () => {
    const url = await upload();
    const { socialChat } = await import('../social-chat.js');
    await socialChat().membershipStore.putMember(row('u-jonas', '2026-10-05T01:00:00.000Z'));
    expect((await fetchAs('u-jonas', url)).status).toBe(403);
    expect((await fetchAs('u-farah', url)).status).toBe(200);
  });
});

describe('the Files list for a conversation', () => {
  const PDF = 'application/pdf';
  const CHANNEL = 'social:ch:files-view';
  const member = (userId: string, extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, userId, role: 'member' as const, addedBy: 'u-farah',
    addedAt: '2026-10-05T00:00:00.000Z', historyFrom: null, removedAt: null, ...extra });
  const urlFrame = (o: Open, id: string) => o.frames.find((f) => f.type === 'fileupload:url' && f['id'] === id) as (Frame & { uploadUrl: string }) | undefined;
  const asUser = (sub: string, url: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { Authorization: `Bearer ${tokens.get(sub)}`, ...(init.headers ?? {}) } });
  const list = (sub: string, channel: string) => asUser(sub, `/api/uploads?channel=${encodeURIComponent(channel)}`);

  async function share(id: string, filename: string): Promise<void> {
    send(farah, { service: 'fileupload', action: 'request-upload', channel: CHANNEL, id, filename, size: 5 });
    await until(() => !!urlFrame(farah, id));
    expect((await asUser('u-farah', urlFrame(farah, id)!.uploadUrl, { method: 'PUT', headers: { 'Content-Type': PDF }, body: 'bytes' })).status).toBe(200);
  }

  it('lists a member the files with sender, size and a working download, and refuses everyone else', async () => {
    const { socialChat } = await import('../social-chat.js');
    const store = socialChat().membershipStore;
    await store.putMember(member('u-farah')); await store.putMember(member('u-jonas'));
    await share('lf-1', 'Brief.pdf');
    const res = await list('u-jonas', CHANNEL);
    expect(res.status).toBe(200);
    const body = await res.json() as { files: Array<{ name: string; size: number; uploader: string; uploaderName: string; url: string; sentAt: string }> };
    const found = body.files.find((f) => f.name === 'Brief.pdf')!;
    expect(found).toMatchObject({ size: 5, uploader: 'u-farah' });
    expect(found.uploaderName).not.toBe('');
    expect(Number.isFinite(Date.parse(found.sentAt))).toBe(true);
    expect(await (await asUser('u-jonas', found.url)).text()).toBe('bytes');
    // Not a member (u-theo holds a social grant but no seat): refused, and never enumerated.
    expect((await list('u-theo', CHANNEL)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/uploads?channel=${CHANNEL}`)).status).toBe(401);
  });

  it('refuses a non-member who holds the tenant, and a member once removed', async () => {
    const { socialChat } = await import('../social-chat.js');
    const store = socialChat().membershipStore;
    await store.putMember(member('u-farah')); await store.putMember(member('u-jonas'));
    await share('lf-2', 'Plan.pdf');
    await store.putMember(member('u-jonas', { removedAt: '2026-10-05T01:00:00.000Z' }));
    expect((await list('u-jonas', CHANNEL)).status).toBe(403);
    expect((await list('u-farah', CHANNEL)).status).toBe(200);
  });

  it('hides files shared before a member\'s history floor, as the download does', async () => {
    const { socialChat } = await import('../social-chat.js');
    const store = socialChat().membershipStore;
    await store.putMember(member('u-farah')); await store.putMember(member('u-jonas', { historyFrom: new Date(Date.now() + 60_000).toISOString() }));
    await share('lf-3', 'Early.pdf');
    const body = await (await list('u-jonas', CHANNEL)).json() as { files: Array<{ name: string; url: string }> };
    expect(body.files.map((f) => f.name)).not.toContain('Early.pdf');
    const farahList = await (await list('u-farah', CHANNEL)).json() as { files: Array<{ name: string; url: string }> };
    const early = farahList.files.find((f) => f.name === 'Early.pdf')!;
    expect((await asUser('u-jonas', early.url)).status).toBe(403);
  });

  it('answers 404 for another tenant\'s channel', async () => {
    expect((await list('u-theo', DOC_CHANNEL)).status).toBe(404);
    expect((await list('u-farah', DOC_CHANNEL)).status).toBe(200);
  });
});

describe('attachments in the orgiq and pipelines discussions', () => {
  const urlFrame = (o: Open, id: string) => o.frames.find((f) => f.type === 'fileupload:url' && f['id'] === id) as (Frame & { uploadUrl: string }) | undefined;
  const fetchAs = (sub: string, url: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { Authorization: `Bearer ${tokens.get(sub)}`, ...(init.headers ?? {}) } });
  const PDF = { 'Content-Type': 'application/pdf' };

  async function requestUpload(o: Open, channel: string, id: string): Promise<string | undefined> {
    send(o, { service: 'fileupload', action: 'request-upload', channel, id, filename: 'plan.pdf', size: 5 });
    await settle(400);
    return urlFrame(o, id)?.uploadUrl;
  }

  it('orgiq:initiative and orgiq:work: DispatchAgentRun holders upload; a plain member can read but not attach', async () => {
    const nora = await connectAs('u-nora', 'Nora Sme', 'orgiq');
    for (const channel of ['orgiq:initiative:p-auth-migration', 'orgiq:work:w-1']) {
      const id = `o-${channel.split(':')[1]}`;
      const url = await requestUpload(nora, channel, id);
      expect(url).toBeDefined();
      expect((await fetchAs('u-nora', url!, { method: 'PUT', headers: PDF, body: 'hello' })).status).toBe(200);
      const read = await fetchAs('u-theo', url!);
      expect(read.status).toBe(200);
      expect(await read.text()).toBe('hello');
      // The reader's own request is refused at the socket, and a forged PUT of the member's own row would be too.
      expect(await requestUpload(theo, channel, `${id}-r`)).toBeUndefined();
    }
    nora.ws.close();
  });

  it('pipelines:run and pipelines:def: any ViewPipelines holder uploads; another tenant is refused at PUT and GET', async () => {
    const ines = await connectAs('u-ines', 'Ines Author', 'pipelines');
    const kofi = await connectAs('u-kofi', 'Kofi Operator', 'pipelines');
    for (const channel of ['pipelines:run:r-1', 'pipelines:def:d-1']) {
      const id = `p-${channel.split(':')[1]}`;
      const url = await requestUpload(ines, channel, id);
      expect(url).toBeDefined();
      expect((await fetchAs('u-ines', url!, { method: 'PUT', headers: PDF, body: 'hello' })).status).toBe(200);
      expect((await fetchAs('u-kofi', url!)).status).toBe(200);
      // Cross-tenant (orgiq session): GET 403.
      expect((await fetchAs('u-theo', url!)).status).toBe(403);
      expect(await requestUpload(theo, channel, `${id}-x`)).toBeUndefined();
    }
    expect(await requestUpload(kofi, 'pipelines:run:r-1', 'k-1')).toBeDefined();
    ines.ws.close(); kofi.ws.close();
  });

  it('a reader whose publish authority is gone is refused on PUT but still reads', async () => {
    const nora = await connectAs('u-nora', 'Nora Sme', 'orgiq');
    const url = (await requestUpload(nora, 'orgiq:initiative:p-rag-search', 'pr-1'))!;
    // theo (member, no DispatchAgentRun) cannot move bytes even for his own request id.
    expect((await fetchAs('u-theo', url, { method: 'PUT', headers: PDF, body: 'hello' })).status).toBe(403);
    expect((await fetchAs('u-nora', url, { method: 'PUT', headers: PDF, body: 'hello' })).status).toBe(200);
    expect((await fetchAs('u-theo', url)).status).toBe(200);
    nora.ws.close();
  });
});

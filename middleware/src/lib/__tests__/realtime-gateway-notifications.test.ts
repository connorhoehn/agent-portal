// The gateway's notification feature (docs/social-tenant-design.md §3.3–§3.5),
// over a real http.Server and raw `ws` clients with real realtime tokens:
//   - the dev:mock seed (mock/notifications.ts) replays to its recipient on
//     connect, and only to users holding a grant in the item's tenant;
//   - lib/social-notify's `notify` reaches a live socket, persists (a new
//     socket replays it), and a server-side markRead stops the replay;
//   - a DM message notifies the other member only while they have no live
//     subscription to the DM channel, and never a member without a grant in
//     the DM's tenant (u-hr in an assessment DM);
//   - a missed call notifies the invite's target, with the invite's page.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
// Match the Social seed capabilities in this CJS harness; production loads
// the real ESM Cedar registry.
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'moderator', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'community-admin', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
] }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { notify } from '../social-notify.js';
import { notificationsFixture } from '../../mock/notifications.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { getUser } from '../../providers/identity.js';
import { identityClonesFixture, removeClone } from '../../mock/identity-clones.js';
import { socialChat } from '../social-chat.js';
import { socialChannelMessagesFixture } from '../../mock/social-channels.js';

const SECRET = 'test-realtime-secret';
type Frame = Record<string, unknown> & { type?: string };
type Open = { ws: WebSocket; frames: Frame[] };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
let warn: jest.SpyInstance;

beforeAll(async () => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
  warn.mockRestore();
});

async function connectAs(sub: string, name: string, tenant: string): Promise<Open> {
  const user = await getUser(sub, { authoritative: true });
  const session = { sub, name, role: user?.grants[tenant]?.[0], tenant, grants: user?.grants ?? {}, epoch: user?.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
  const token = (await signRealtimeToken(realtimeClaims(session), SECRET)).token;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (_q, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
}

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const newItems = (o: Open) => o.frames.filter((f) => f.type === 'notification:new').map((f) => f['payload'] as Frame);
const replayed = (o: Open) => o.frames.filter((f) => f.type === 'notification:bulk-update')
  .flatMap((f) => ((f['payload'] as { notifications: Frame[] }).notifications));

describe('the dev:mock seed', () => {
  it('replays each seeded row to its recipient on connect', async () => {
    const seededFor = notificationsFixture.rows().filter((r) => r.userId === 'u-farah').map((r) => r.id);
    expect(seededFor.length).toBeGreaterThan(0);
    const farah = await connectAs('u-farah', 'Farah Osei', 'assessment');
    try {
      await until(() => replayed(farah).length > 0);
      expect(replayed(farah).map((n) => n['id']).sort()).toEqual([...seededFor].sort());
      expect(replayed(farah).find((n) => n['id'] === 'mock-notif-reply-farah')).toMatchObject({ payload: { tenant: 'assessment', category: 'Assessment' }, action: { href: expect.stringMatching(/^\/assessment\//) } });
    } finally { farah.ws.close(); }
  });

  it('gives u-jonas, who has no seeded row, an empty bell', async () => {
    const jonas = await connectAs('u-jonas', 'Jonas Lindqvist', 'assessment');
    try {
      await settle();
      expect(replayed(jonas)).toEqual([]);
    } finally { jonas.ws.close(); }
  });
});

describe('notify over the socket', () => {
  it('delivers live, persists for replay, and a server-side markRead stops the replay', async () => {
    const first = await connectAs('u-jonas', 'Jonas Lindqvist', 'assessment');
    await settle(100);
    const delivered = await notify(['u-jonas', 'u-hr'], {
      type: 'reply', title: 'Farah Osei replied to your comment', body: 'On “Rubric Overview”: yes',
      payload: { tenant: 'assessment' }, action: { label: 'Open', href: '/assessment/workspace?doc=page%3A100002&tab=comments' },
    });
    expect(delivered).toEqual(['u-jonas']);
    await until(() => newItems(first).length === 1);
    const id = newItems(first)[0]!['id'] as string;
    first.ws.close();

    const second = await connectAs('u-jonas', 'Jonas Lindqvist', 'assessment');
    await until(() => replayed(second).some((n) => n['id'] === id));
    second.ws.send(JSON.stringify({ service: 'notification', action: 'markRead', id }));
    await until(() => second.frames.some((f) => f.type === 'notification:read'));
    second.ws.close();

    const third = await connectAs('u-jonas', 'Jonas Lindqvist', 'assessment');
    try {
      await settle();
      expect(replayed(third).some((n) => n['id'] === id)).toBe(false);
    } finally { third.ws.close(); }
  });
});

describe('the DM producer', () => {
  const DM = 'assessment:dm:u-farah:u-jonas';
  const join = (o: Open, channel: string) => o.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
  const say = (o: Open, channel: string, message: string) => o.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message }));
  const joined = (o: Open, channel: string) => o.frames.some((f) => f.type === 'chat' && f['action'] === 'joined' && f['channel'] === channel);

  it('notifies the other member while they are not on the channel, and not once they are', async () => {
    const farah = await connectAs('u-farah', 'Farah Osei', 'assessment');
    const jonas = await connectAs('u-jonas', 'Jonas Lindqvist', 'assessment');
    try {
      join(farah, DM);
      await until(() => joined(farah, DM));
      say(farah, DM, 'Can you look at the rubric thread?');
      await until(() => newItems(jonas).some((n) => n['type'] === 'message'));
      expect(newItems(jonas).find((n) => n['type'] === 'message')).toMatchObject({
        title: 'Farah Osei sent you a message', body: 'Can you look at the rubric thread?',
        payload: { tenant: 'assessment', category: 'Assessment', channel: DM, actorId: 'u-farah' },
      });
      expect(newItems(farah).filter((n) => n['type'] === 'message')).toEqual([]);

      join(jonas, DM);
      await until(() => joined(jonas, DM));
      const before = newItems(jonas).length;
      say(farah, DM, 'Second message');
      await until(() => jonas.frames.some((f) => f.type === 'chat' && f['action'] === 'message' && (f['message'] as Frame)['message'] === 'Second message'));
      await settle();
      expect(newItems(jonas).length).toBe(before);
    } finally { farah.ws.close(); jonas.ws.close(); }
  });

  it('never notifies a member with no grant in the DM tenant (u-hr in an assessment DM)', async () => {
    const hrDm = 'assessment:dm:u-farah:u-hr';
    const farah = await connectAs('u-farah', 'Farah Osei', 'assessment');
    const hr = await connectAs('u-hr', 'Helen Desai', 'orgiq');
    try {
      join(farah, hrDm);
      await until(() => joined(farah, hrDm));
      say(farah, hrDm, 'hello Priya');
      await settle(400);
      expect(newItems(hr)).toEqual([]);
    } finally { farah.ws.close(); hr.ws.close(); }
  });
});

describe('the missed-call producer', () => {
  it('notifies the invite target when the caller hangs up before an answer, pointing at the invite page', async () => {
    const vera = await connectAs('u-vera', 'Vera Green', 'orgiq');
    const nora = await connectAs('u-nora', 'Nora DaSilva', 'orgiq');
    try {
      const base = { service: 'call', callId: 'call-missed-1', lobbyName: 'orgiq:initiative:p-auth-migration', callerId: 'u-vera', callerName: 'Vera Green' };
      vera.ws.send(JSON.stringify({ ...base, action: 'invite', targetUserIds: ['u-nora'], channel: 'initiative:p-auth-migration' }));
      await until(() => nora.frames.some((f) => f.type === 'call' && f['action'] === 'invite'));
      vera.ws.send(JSON.stringify({ ...base, action: 'cancelled', targetUserIds: ['u-nora'] }));
      await until(() => newItems(nora).some((n) => n['type'] === 'call-missed'), 3_000);
      expect(newItems(nora).find((n) => n['type'] === 'call-missed')).toMatchObject({
        title: 'Missed call from Vera Green',
        payload: { tenant: 'orgiq', category: 'OrgIQ', reason: 'cancelled' },
        action: { href: '/iq/projects/p-auth-migration' },
      });
      expect(newItems(vera).filter((n) => n['type'] === 'call-missed')).toEqual([]);
    } finally { vera.ws.close(); nora.ws.close(); }
  });
});


describe('clone-to-clone DM isolation', () => {
  it('delivers only to the other clone, refuses an outsider, and deletes only disposable history', async () => {
    const ids = ['u-lena-clone-a1111111', 'u-sana-clone-b2222222', 'u-sana-clone-c3333333'];
    for (const [i, id] of ids.entries()) identityClonesFixture.rows().push({ id, from: i === 0 ? 'u-lena' : 'u-sana', label: 'isolation',
      displayName: i === 0 ? 'Lena' : 'Sana', email: null, personId: null, grants: { social: ['participant'] }, epoch: 0,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const channel = `social:dm:${ids.slice(0, 2).sort().join(':')}`;
    const before = structuredClone(socialChannelMessagesFixture.rows());
    const clients = await Promise.all([...ids, 'u-lena', 'u-sana'].map(id => connectAs(id, id === ids[0] ? 'Lena' : 'Sana', 'social')));
    const [sender, recipient, outsider] = clients;
    try {
      await settle();
      const prior = clients.map(c => newItems(c).length);
      sender!.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
      await until(() => sender!.frames.some(f => f.type === 'chat' && f['action'] === 'joined' && f['channel'] === channel));
      sender!.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: 'Clone isolation proof' }));
      await until(() => newItems(recipient!).length === prior[1]! + 1);
      expect(newItems(recipient!).at(-1)).toMatchObject({ title: 'Lena sent you a message', payload: { actorId: ids[0], channel, tenant: 'social' } });
      outsider!.ws.send(JSON.stringify({ service: 'chat', action: 'history', channel, limit: 10 }));
      await until(() => outsider!.frames.some(f => f.type === 'error' && f['channel'] === channel));
      await settle();
      for (const i of [0, 2, 3, 4]) expect(newItems(clients[i]!).length).toBe(prior[i]);
      expect(outsider!.frames.filter(f => f.type === 'chat' && f['channel'] === channel)).toEqual([]);
      expect(await socialChat().chatStore.listMessages(channel, 10)).toHaveLength(1);
      expect(socialChannelMessagesFixture.rows().filter(row => row.channel !== channel)).toEqual(before);
    } finally {
      for (const client of clients) client.ws.close();
      for (const id of ids) removeClone(id);
    }
    expect(await socialChat().chatStore.listMessages(channel, 10)).toEqual([]);
    expect(socialChannelMessagesFixture.rows()).toEqual(before);
  });
});

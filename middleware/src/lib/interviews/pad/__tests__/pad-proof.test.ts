// The I0.7 proof (docs/interviews-tenant-plan.md, "I0.7 answer"): two people
// type into one interview's code pad over the BFF's own gateway and end with
// the same text, and nobody without a seat on that pad gets a byte of it.
//
// Everything on the wire is real: the gateway attached to a server (the same
// attach the middleware runs), its router and authority, the CRDT service, and
// on the client side the library's GatewayProvider, the class `useYjsDoc`
// mounts in the portal, fed the frames the way that hook feeds it.
jest.mock('../../../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { GatewayProvider } from '@connorhoehn/realtime-modules/client';
import { attachRealtimeGateway, REALTIME_GATEWAY_PATH } from '../../../realtime-gateway.js';
import { signRealtimeToken, realtimeClaims } from '../../../realtime-token.js';
import type { Session } from '../../../session.js';
import { getUser } from '../../../../providers/identity.js';
import { MemoryInterviewsStore } from '../../store.js';
import { setInterviewsStore } from '../../store-select.js';
import type { Interview } from '../../types.js';
import { padChannel, padDocumentId, padInterviewId } from '../channel.js';
import { padDocumentAuthz } from '../feature.js';

const SECRET = 'test-realtime-secret';
// The seed: iv-mateo-design is Hugo's technical round, iv-aiko-coding Wen's,
// iv-nadia-leadership Wen's behavioural round. The proof seats Wen on Hugo's
// panel too, so two people share one pad (the candidate's seat is row I2.2).
const HUGO = 'u-hugo'; const WEN = 'u-wen'; const GRETA = 'u-greta'; const AMARA = 'u-amara'; const THEO = 'u-theo';
const SHARED = 'iv-mateo-design'; const WENS = 'iv-aiko-coding'; const BEHAVIOURAL = 'iv-nadia-leadership';

class PanelStore extends MemoryInterviewsStore {
  override async listInterviews(): Promise<Interview[]> {
    return (await super.listInterviews()).map((i) => i.id === SHARED ? { ...i, panelIds: [WEN] } : i);
  }
}

type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string; channel?: string };
type Pad = { ws: WebSocket; frames: Frame[]; channel: string; doc: Y.Doc; provider: GatewayProvider; text: Y.Text };

let server: http.Server; let port: number; let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const prevFlag = process.env['INTERVIEWS_ENABLED'];
const open: Pad[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  delete process.env['INTERVIEWS_ENABLED'];
  setInterviewsStore(new PanelStore());
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const p of open) { p.provider.destroy(); p.ws.terminate(); }
  await dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  setInterviewsStore(null);
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = prevSecret;
  if (prevFlag === undefined) delete process.env['INTERVIEWS_ENABLED']; else process.env['INTERVIEWS_ENABLED'] = prevFlag;
});
beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => {
  jest.restoreAllMocks();
  for (const p of open.splice(0)) { p.provider.destroy(); p.ws.close(); }
});

async function connectAs(sub: string, tenant: string): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const user = await getUser(sub, { authoritative: true });
  if (!user) throw new Error(`no seed user ${sub}`);
  const session = { sub, name: user.displayName, role: user.grants[tenant]?.[0], tenant, grants: user.grants, epoch: user.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    const frames: Frame[] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some(f => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
        else if (Date.now() - start > 2000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

/** Open `interviewId`'s pad as `sub`: the provider, fed exactly as useYjsDoc feeds it. */
async function openPad(sub: string, interviewId: string, tenant = 'interviews', channel = padChannel(interviewId)!): Promise<Pad> {
  const { ws, frames } = await connectAs(sub, tenant);
  const doc = new Y.Doc();
  const provider = new GatewayProvider(doc, channel, msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); });
  ws.on('message', data => {
    const msg = JSON.parse(String(data)) as Frame & { snapshot?: string; update?: string; updateId?: string; updates?: Array<{ update?: string }> };
    if (msg.channel !== channel) return;
    if (msg.type === 'crdt:snapshot' && msg.snapshot) provider.applySnapshot(msg.snapshot);
    else if (msg.type === 'crdt:update' && msg.update) provider.applyRemoteUpdate(msg.update);
    else if (msg.type === 'crdt:persisted' && msg.updateId) provider.applyPersisted(msg.updateId);
    else if (msg.type === 'crdt:persistence-error' && msg.updateId) provider.applyPersistenceError(msg.updateId);
    else if (msg.type === 'crdt:awareness') {
      for (const u of msg.updates ?? (msg.update ? [{ update: msg.update }] : [])) if (u.update) provider.applyAwarenessUpdate(u.update);
    }
  });
  const pad = { ws, frames, channel, doc, provider, text: doc.getText('code') };
  open.push(pad);
  ws.send(JSON.stringify({ service: 'crdt', action: 'subscribe', channel }));
  return pad;
}

async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const settle = (ms = 600) => new Promise(resolve => setTimeout(resolve, ms));
const subscribed = (p: Pad) => p.frames.some(f => f.type === 'crdt' && f.action === 'subscribed' && f.channel === p.channel);
const refusals = (p: Pad) => p.frames.filter(f => f.type === 'error' || f.type === 'crdt:error');
const gotDocumentBytes = (p: Pad) => p.frames.some(f => f.channel === p.channel && (f.type === 'crdt:snapshot' || f.type === 'crdt:update'));

async function refusedOn(p: Pad): Promise<void> {
  await until(() => refusals(p).length > 0, 'a refusal');
  await settle(200);
  expect(subscribed(p)).toBe(false);
  expect(gotDocumentBytes(p)).toBe(false);
}

describe('the pad carried on the BFF gateway', () => {
  it('two seats type into one pad at the same time and converge to the same text', async () => {
    const hugo = await openPad(HUGO, SHARED);
    const wen = await openPad(WEN, SHARED);
    await until(() => subscribed(hugo) && subscribed(wen), 'both subscriptions');

    // Both type before either has seen the other's edit.
    hugo.text.insert(0, 'def solve(xs):\n    return sorted(xs)\n');
    wen.text.insert(0, '# warm-up: sort a list\n');
    await until(() => hugo.text.toString() === wen.text.toString() && hugo.text.length > 40, 'the two texts to converge');
    const first = hugo.text.toString();
    expect(first).toContain('def solve(xs):');
    expect(first).toContain('# warm-up: sort a list');

    // And again, in the middle of each other's lines.
    hugo.text.insert(hugo.text.toString().indexOf('sorted'), 'list(');
    wen.text.insert(wen.text.length, 'print(solve([3, 1, 2]))\n');
    await until(() => hugo.text.toString() === wen.text.toString() && wen.text.toString().includes('list(') && hugo.text.toString().includes('print('), 'the second round to converge');

    // A late joiner (a reload) receives the whole text in its first snapshot.
    const reload = await openPad(HUGO, SHARED);
    await until(() => reload.text.toString() === wen.text.toString(), 'the late joiner to catch up');
    expect(reload.provider.synced).toBe(true);
  });

  it('carries carets: one seat sees the other\'s awareness state', async () => {
    const hugo = await openPad(HUGO, SHARED);
    const wen = await openPad(WEN, SHARED);
    await until(() => subscribed(hugo) && subscribed(wen), 'both subscriptions');
    hugo.provider.awareness.setLocalStateField('user', { name: 'Hugo', color: '#336699' });
    await until(() => [...wen.provider.awareness.getStates().values()].some(s => (s as { user?: { name?: string } }).user?.name === 'Hugo'), 'Hugo\'s caret at Wen');
  });

  it('refuses a person whose interview is another one, and keeps their edits out', async () => {
    const wen = await openPad(WEN, WENS);
    await until(() => subscribed(wen), 'Wen on her own pad');
    wen.text.insert(0, 'class Solution:\n');
    await until(() => wen.provider.persistenceState === 'saved', 'Wen\'s edit to persist');

    const hugo = await openPad(HUGO, WENS);
    await refusedOn(hugo);
    expect(hugo.text.toString()).toBe('');
    // A write without a subscription is judged on its own and refused too.
    hugo.text.insert(0, 'import os\n');
    await until(() => hugo.provider.persistenceState === 'error', 'Hugo\'s write to be refused');
    await settle();
    expect(wen.text.toString()).toBe('class Solution:\n');
  });

  it.each([
    ['the recruiter, who reads the interview but holds no seat in the call', GRETA, 'interviews'],
    ['the hiring manager of the opening', AMARA, 'interviews'],
    ['a user of another tenant', THEO, 'orgiq'],
  ])('refuses %s', async (_who, sub, tenant) => {
    const p = await openPad(sub, SHARED, tenant);
    await refusedOn(p);
  });

  it('has no pad for a behavioural round, even for its lead', async () => {
    await refusedOn(await openPad(WEN, BEHAVIOURAL));
  });

  it('carries no other document, even for a seat', async () => {
    await refusedOn(await openPad(HUGO, SHARED, 'interviews', 'doc:notes'));
    await refusedOn(await openPad(HUGO, SHARED, 'interviews', `presence:${padChannel(SHARED)}`));
  });

  it('lets a seat read, edit and point, and nothing else', async () => {
    const hugo = await openPad(HUGO, SHARED);
    await until(() => subscribed(hugo), 'Hugo on his pad');
    const before = refusals(hugo).length;
    for (const frame of [
      { action: 'createDocument', meta: { title: 'Scratch' } },
      { action: 'deleteDocument', documentId: padDocumentId(SHARED) },
      { action: 'clearDocument', channel: hugo.channel },
      { action: 'saveVersion', channel: hugo.channel, name: 'v1' },
      { action: 'updateDocumentMeta', documentId: padDocumentId(SHARED), meta: { title: 'Renamed' } },
    ]) hugo.ws.send(JSON.stringify({ service: 'crdt', ...frame }));
    await until(() => refusals(hugo).length >= before + 5, 'five refusals');
    expect(hugo.frames.some(f => f.type === 'crdt' && ['documentCreated', 'documentDeleted', 'versionSaved', 'documentMetaUpdated', 'snapshotRestored'].includes(String(f.action)))).toBe(false);
  });

  it('refuses everything while the tenant is switched off', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    try { await refusedOn(await openPad(HUGO, SHARED)); } finally { delete process.env['INTERVIEWS_ENABLED']; }
  });
});

describe('the pad\'s names and its document hook', () => {
  it('names a pad by its interview, within the library\'s 50-character channel cap', () => {
    expect(padChannel('iv-mateo-design')).toBe('doc:ivpad:iv-mateo-design');
    expect(padInterviewId('doc:ivpad:iv-mateo-design')).toBe('iv-mateo-design');
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(padChannel(uuid)!.length).toBeLessThanOrEqual(50);
    expect(padChannel('x'.repeat(41))).toBeNull();
    for (const bad of ['', '-lead', 'a:b', 'a/b', 'a b']) expect(padChannel(bad)).toBeNull();
    for (const other of ['doc:notes', 'doc:ivpad:', 'doc:ivpad:a:b', 'presence:doc:ivpad:x', 'interviews:interview:x']) expect(padInterviewId(other)).toBeNull();
  });

  it('allows only reading, editing and carets, and only on a pad', () => {
    const pad = padChannel('iv-mateo-design')!;
    for (const action of ['read', 'update', 'awareness'] as const) expect(padDocumentAuthz('c', pad, null, action)).toBe(true);
    for (const action of ['save', 'restore', 'metadata', 'create', 'delete', 'seed'] as const) expect(padDocumentAuthz('c', pad, null, action)).toBe(false);
    expect(padDocumentAuthz('c', 'doc:notes', null, 'read')).toBe(false);
    expect(padDocumentAuthz('c', '', null, 'create')).toBe(false);
  });
});

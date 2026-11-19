// Milo writes into a pad over the BFF's own gateway (lib/interviews/pad/milo-writer.ts, milo-seat.ts). Everything on the wire
// is real, as in pad-proof.test.ts: the gateway attached to a server, its router and authority, the CRDT service, and a person's
// pad on the library's GatewayProvider. The writer's socket is admitted by the pad's own rule, for its one grant, and nothing else.
jest.mock('../../../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../../../config.js', () => ({
  config: { region: 'us-east-1', port: 0, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
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
import type { Interview, InterviewState } from '../../types.js';
import { padChannel } from '../channel.js';
import { closeMiloPadGrant, miloPadClaims, mintMiloPadToken, openMiloPadGrant } from '../milo-seat.js';
import { atEnd, MILO_CARET, MILO_TYPE_CHUNKS, ownGatewayUrl, setMiloWriterDeps, typingChunks, writeIntoPad } from '../milo-writer.js';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness';

const SECRET = 'test-realtime-secret';
const HUGO = 'u-hugo';
const ROUND = 'iv-k1p5w8ra';   // Hugo's technical round in the seed
const OTHER = 'iv-c3k8w2ma';   // Wen's technical round
let state: InterviewState = 'live';
class LiveStore extends MemoryInterviewsStore {
  override async listInterviews(): Promise<Interview[]> { return (await super.listInterviews()).map((i) => (i.id === ROUND || i.id === OTHER ? { ...i, state } : i)); }
  override async getInterview(id: string): Promise<Interview | null> { const r = await super.getInterview(id); return r && (r.id === ROUND || r.id === OTHER) ? { ...r, state } : r; }
}

type Frame = Record<string, unknown> & { type?: string; action?: string; channel?: string };
let server: http.Server; let port: number; let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  setInterviewsStore(new LiveStore());
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, authorityCache: true }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  setMiloWriterDeps({ gatewayUrl: () => `ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, secret: () => SECRET, syncMs: 3000, planMs: 3000, writeMs: 3000, typeGapMs: 0 });
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  setMiloWriterDeps(null);
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setInterviewsStore(null);
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});
beforeEach(() => { state = 'live'; jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

const until = async (pred: () => boolean, what: string, ms = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Hugo's pad on the round, fed as the portal's useYjsDoc feeds the library's provider. */
async function hugosPad(): Promise<{ text: Y.Text; doc: Y.Doc; frames: Frame[] }> {
  const user = await getUser(HUGO, { authoritative: true });
  const session = { sub: HUGO, name: user!.displayName, role: user!.grants['interviews']?.[0], tenant: 'interviews', grants: user!.grants, epoch: user!.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
  const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
  sockets.push(ws);
  const frames: Frame[] = [];
  const channel = padChannel(ROUND)!;
  const doc = new Y.Doc();
  const provider = new GatewayProvider(doc, channel, (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Frame & { snapshot?: string; update?: string; updateId?: string };
    frames.push(msg);
    if (msg.channel !== channel) return;
    if (msg.type === 'crdt:snapshot' && msg.snapshot) provider.applySnapshot(msg.snapshot);
    else if (msg.type === 'crdt:update' && msg.update) provider.applyRemoteUpdate(msg.update);
    else if (msg.type === 'crdt:persisted' && msg.updateId) provider.applyPersisted(msg.updateId);
  });
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  await until(() => frames.some((f) => f.type === 'session'), 'the session frame');
  ws.send(JSON.stringify({ service: 'crdt', action: 'subscribe', channel }));
  await until(() => frames.some((f) => f.type === 'crdt' && f.action === 'subscribed' && f.channel === channel), 'the subscribe');
  return { text: doc.getText('code'), doc, frames };
}

/** A raw socket with a Milo token: its frames, once open (or the refusal of the upgrade). */
async function miloSocket(claim: { interviewId: string; grant: string }): Promise<{ ws: WebSocket; frames: Frame[] } | 'refused'> {
  const token = await mintMiloPadToken(claim, SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', () => resolve('refused'));
    ws.on('error', () => resolve('refused'));
  });
}

describe('Milo writing into a pad', () => {
  it('types a block in chunks with its named caret at the end of what is typed, then takes the caret away', async () => {
    setMiloWriterDeps({ gatewayUrl: () => `ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, secret: () => SECRET, syncMs: 3000, planMs: 3000, writeMs: 3000, typeGapMs: 20 });
    const hugo = await hugosPad();
    const versions: string[] = [];
    hugo.text.observe(() => versions.push(hugo.text.toString()));
    const block = Array.from({ length: 8 }, (_, i) => `# case ${i}\n`).join('');
    const out = await writeIntoPad(ROUND, () => atEnd(block));
    expect(out.ok).toBe(true);
    await until(() => hugo.text.toString().endsWith(block), 'the whole block on Hugo\'s pad');
    // It arrived in pieces, each one more of the block.
    const growing = versions.filter((v) => v.includes('# case 0'));
    expect(growing.length).toBeGreaterThanOrEqual(MILO_TYPE_CHUNKS);
    // Milo's caret: named Milo, at the end of what was typed, then gone.
    await until(() => hugo.frames.filter((f) => f.type === 'crdt:awareness').length >= 2, 'Milo\'s caret frames');
    const seen = new Awareness(new Y.Doc());
    const states: Array<Record<string, unknown> | null> = [];
    for (const f of hugo.frames.filter((x) => x.type === 'crdt:awareness')) {
      const items = (f as { updates?: Array<{ update: string }>; update?: string }).updates ?? [{ update: (f as { update: string }).update }];
      for (const it of items) {
        applyAwarenessUpdate(seen, new Uint8Array(Buffer.from(it.update, 'base64')), 'gateway');
        states.push([...seen.getStates().values()].find((st) => (st as { user?: { name?: string } }).user?.name === 'Milo') as Record<string, unknown> ?? null);
      }
    }
    const milo = states.find((st) => st !== null) as { user: { name: string }; cursor: { anchor: unknown } } | undefined;
    expect(milo?.user.name).toBe(MILO_CARET.name);
    const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(milo!.cursor.anchor), hugo.doc);
    expect(at?.index).toBeGreaterThan(0);
    expect(states.at(-1)).toBeNull();
    expect(typingChunks(block)).toHaveLength(MILO_TYPE_CHUNKS);
    expect(typingChunks('one line')).toEqual(['one line']);
  });

  it('a write that fails after some chunks were typed takes them out again, keeps what others typed, and says what was typed (review 1, item 4)', async () => {
    const hugo = await hugosPad();
    hugo.doc.transact(() => hugo.text.insert(hugo.text.length, 'def f():\n    pass\n'));
    await until(() => true, 'nothing');
    await new Promise((r) => setTimeout(r, 300));
    const before = hugo.text.toString();
    // The write's bound ends after the third chunk (writeMs + 4 gaps = 150 ms; three chunks, at 0, 100 and 200 ms).
    setMiloWriterDeps({ gatewayUrl: () => `ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, secret: () => SECRET, syncMs: 3000, planMs: 3000, writeMs: -250, typeGapMs: 100 });
    const block = Array.from({ length: 8 }, (_, i) => `# case ${i}\n`).join('');
    let typedSeen = false;
    hugo.text.observe(() => { if (hugo.text.toString().includes('# case 0')) typedSeen = true; });
    const out = await writeIntoPad(ROUND, () => atEnd(block));
    setMiloWriterDeps({ gatewayUrl: () => `ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, secret: () => SECRET, syncMs: 3000, planMs: 3000, writeMs: 3000, typeGapMs: 0 });
    expect(out).toMatchObject({ ok: false, code: 'timeout', typed: { removed: true } });
    if (out.ok || !out.typed) return;
    expect(out.typed.inserted).toBeGreaterThan(0);
    expect(out.typed.inserted).toBeLessThan(atEnd(block)(before)!.text.length);
    expect(typedSeen).toBe(true);
    await until(() => hugo.text.toString() === before, 'the typed part taken out of Hugo\'s pad');
    expect(out.typed.text).toBe(before);
  });

  it('appends its block at the end of what a person typed, and the person\'s pad shows it', async () => {
    const hugo = await hugosPad();
    hugo.doc.transact(() => hugo.text.insert(hugo.text.length, 'def two_sum(nums, target):\n    pass\n'));
    await new Promise((r) => setTimeout(r, 300));
    let seen = '';
    const out = await writeIntoPad(ROUND, async ({ text, language }) => { seen = text; await new Promise((r) => setTimeout(r, 50)); return atEnd(`# Test cases from Milo (${language})\n`); });
    expect(out.ok).toBe(true);
    expect(seen).toContain('def two_sum(nums, target):');
    if (!out.ok) return;
    // After a blank line, as a question is inserted.
    expect(out.from).toBe(seen.length);
    expect(out.text.slice(seen.length, seen.length + 1)).toBe('\n');
    expect(out.text.endsWith('# Test cases from Milo (python)\n')).toBe(true);
    expect(out.lines).toBe(1);
    await until(() => hugo.text.toString().includes('# Test cases from Milo'), 'the block on Hugo\'s pad');
    expect(hugo.text.toString()).toBe(out.text);
    // A placement elsewhere: an import at the very top, placed against the pad as it is when written.
    const top = await writeIntoPad(ROUND, () => (current) => ({ index: 0, text: current.startsWith('from functools') ? '' : 'from functools import lru_cache\n' }));
    expect(top).toMatchObject({ ok: true, from: 0, lines: 1 });
    await until(() => hugo.text.toString().startsWith('from functools import lru_cache\n'), 'the import on Hugo\'s pad');
  });

  it('writes nothing when the round is not live, and nothing for an empty plan', async () => {
    state = 'ended';
    expect(await writeIntoPad(ROUND, () => atEnd('# x\n'))).toEqual({ ok: false, code: 'refused' });
    state = 'live';
    expect(await writeIntoPad(ROUND, () => null)).toEqual({ ok: false, code: 'nothing' });
  });
});

describe('the Milo pad token', () => {
  it('is refused at the door without an open grant, and after the grant closes', async () => {
    expect(await miloSocket({ interviewId: ROUND, grant: 'a'.repeat(24) })).toBe('refused');
    const grant = openMiloPadGrant(ROUND);
    const s = await miloSocket({ interviewId: ROUND, grant });
    expect(s).not.toBe('refused');
    closeMiloPadGrant(grant);
    if (s === 'refused') return;
    s.ws.send(JSON.stringify({ service: 'crdt', action: 'subscribe', channel: padChannel(ROUND) }));
    await until(() => s.frames.some((f) => f.type === 'error'), 'a refusal');
    expect(s.frames.some((f) => f.type === 'crdt' && f.action === 'subscribed')).toBe(false);
  });

  it('opens only the pad its grant names: another round\'s pad, the call lobby and chat are refused', async () => {
    const grant = openMiloPadGrant(ROUND);
    try {
      const s = await miloSocket({ interviewId: ROUND, grant });
      if (s === 'refused') throw new Error('the upgrade was refused');
      s.ws.send(JSON.stringify({ service: 'crdt', action: 'subscribe', channel: padChannel(OTHER) }));
      s.ws.send(JSON.stringify({ service: 'presence', action: 'subscribe', channel: `presence:interviews:interview:${ROUND}` }));
      s.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: `interviews:interview:${ROUND}` }));
      await until(() => s.frames.filter((f) => f.type === 'error').length >= 2, 'the refusals');
      await new Promise((r) => setTimeout(r, 200));
      expect(s.frames.some((f) => f.type === 'crdt' && f.action === 'subscribed')).toBe(false);
      expect(s.frames.some((f) => f.channel === padChannel(OTHER) && (f.type === 'crdt:snapshot' || f.type === 'crdt:update'))).toBe(false);
    } finally {
      closeMiloPadGrant(grant);
    }
  });

  it('claims nothing beyond the pad: no tenants, a role no tenant knows, its grant as the subject', () => {
    const c = miloPadClaims({ interviewId: ROUND, grant: 'b'.repeat(24) });
    expect(c).toMatchObject({ sub: `milo-pad:${'b'.repeat(24)}`, tenants: [], role: 'interview-milo', org: 'interviews' });
    expect(ownGatewayUrl(3996, '0.0.0.0')).toBe('ws://127.0.0.1:3996/ws');
    expect(ownGatewayUrl(3996, '::1')).toBe('ws://[::1]:3996/ws');
  });
});

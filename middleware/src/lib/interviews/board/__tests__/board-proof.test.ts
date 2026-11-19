// The whiteboard's live sharing, proved end to end on the BFF gateway (WHITEBOARD-PLAN step 1): the same seats as the
// pad (lib/interviews/board/authority.ts mirrors lib/interviews/pad/authority.ts), proved the same way as
// ../../pad/__tests__/pad-proof.test.ts, whose harness this copies: real sockets, real tokens, the provider fed as
// the portal feeds it.
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
import { padChannel } from '../../pad/channel.js';
import { boardChannel, boardInterviewId } from '../channel.js';
import { padDocumentAuthz } from '../../pad/feature.js';
import { MemoryInviteStore, setInviteStore } from '../../invite/store.js';
import { applyAdmission, forgetInterviewGuest } from '../../invite/admission.js';
import { loadGuestSession } from '../../invite/guest.js';
import { mintGuestRealtimeToken } from '../../invite/realtime.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';

const SECRET = 'test-realtime-secret';
// The seed: iv-k1p5w8ra is Hugo's technical round, iv-c3k8w2ma Wen's,
// iv-n5z9f2cq Wen's behavioural round. The proof seats Wen on Hugo's
// panel too, so two people share one pad (the candidate's seat is row I2.2).
const HUGO = 'u-hugo'; const WEN = 'u-wen'; const GRETA = 'u-greta'; const AMARA = 'u-amara'; const THEO = 'u-theo';
const SHARED = 'iv-k1p5w8ra'; const WENS = 'iv-c3k8w2ma'; const BEHAVIOURAL = 'iv-n5z9f2cq';

// The panel of the shared round; a test may take Wen off it to prove the next delivery is refused.
let sharedPanel: string[] = [WEN];
class PanelStore extends MemoryInterviewsStore {
  readonly byIdReads: string[] = [];
  override async listInterviews(): Promise<Interview[]> {
    return (await super.listInterviews()).map((i) => i.id === SHARED ? { ...i, panelIds: [...sharedPanel] } : i);
  }
  override async getInterview(id: string): Promise<Interview | null> {
    this.byIdReads.push(id);
    const row = await super.getInterview(id);
    return row && row.id === SHARED ? { ...row, panelIds: [...sharedPanel] } : row;
  }
}
const store = new PanelStore();

type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string; channel?: string };
type Pad = { ws: WebSocket; frames: Frame[]; channel: string; doc: Y.Doc; provider: GatewayProvider; text: Y.Text };

let server: http.Server; let port: number; let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const prevFlag = process.env['INTERVIEWS_ENABLED'];
const open: Pad[] = [];

beforeAll(async () => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  delete process.env['INTERVIEWS_ENABLED'];
  setInterviewsStore(store);
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  // The verdict cache on, as a deployment may run it: a pad's verdicts must never be served from it.
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, authorityCache: true }).dispose;
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

/** A guest token for `inviteId`'s current session, or the staff token of `sub` in `tenant`. */
const GUEST = 'guest:';
async function connectAs(sub: string, tenant: string): Promise<{ ws: WebSocket; frames: Frame[] }> {
  let token: string;
  if (sub.startsWith(GUEST)) {
    const loaded = await loadGuestSession(sub.slice(GUEST.length), () => true, '');
    if (!loaded) throw new Error(`no live guest ${sub}`);
    ({ token } = await mintGuestRealtimeToken(loaded.principal, SECRET));
  } else {
    const user = await getUser(sub, { authoritative: true });
    if (!user) throw new Error(`no seed user ${sub}`);
    const session = { sub, name: user.displayName, role: user.grants[tenant]?.[0], tenant, grants: user.grants, epoch: user.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
    ({ token } = await signRealtimeToken(realtimeClaims(session), SECRET));
  }
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
async function openPad(sub: string, interviewId: string, tenant = 'interviews', channel = boardChannel(interviewId)!): Promise<Pad> {
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


// A stroke as the library's Excalidraw binding writes it: one entry in the board's element map.
const ROOT = 'excalidraw';
function draw(p: Pad, id: string): void {
  const root = p.doc.getMap<Y.Map<unknown>>(ROOT);
  p.doc.transact(() => {
    let elements = root.get('elements') as Y.Map<Y.Map<unknown>> | undefined;
    if (!elements) { elements = new Y.Map(); root.set('elements', elements as unknown as Y.Map<unknown>); }
    const el = new Y.Map<unknown>();
    for (const [k, v] of Object.entries({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1 })) el.set(k, v);
    elements.set(id, el);
  });
}
const drawn = (p: Pad): string[] => {
  const elements = p.doc.getMap<unknown>(ROOT).get('elements') as Y.Map<unknown> | undefined;
  return elements ? [...elements.keys()].sort() : [];
};

describe('the whiteboard carried on the BFF gateway (WHITEBOARD-PLAN step 1)', () => {
  it('the lead and the panel draw on one board and converge', async () => {
    const hugo = await openPad(HUGO, SHARED);
    const wen = await openPad(WEN, SHARED);
    await until(() => subscribed(hugo) && subscribed(wen), 'both subscriptions');
    // The first stroke makes the element map; the binding (like this helper) never races two of them into being.
    draw(hugo, 'box-hugo');
    await until(() => drawn(wen).includes('box-hugo'), 'the lead\'s stroke to reach the panel');
    draw(wen, 'box-wen');
    await until(() => drawn(hugo).length === 2 && drawn(wen).length === 2, 'the two boards to converge');
    expect(drawn(hugo)).toEqual(['box-hugo', 'box-wen']);
    // A late joiner (a reload) receives the whole board in its first snapshot.
    const reload = await openPad(HUGO, SHARED);
    await until(() => drawn(reload).length === 2, 'the late joiner to catch up');
  });

  it('keeps the board and the pad apart: a stroke on one is not on the other', async () => {
    const board = await openPad(HUGO, SHARED);
    const pad = await openPad(HUGO, SHARED, 'interviews', padChannel(SHARED)!);
    await until(() => subscribed(board) && subscribed(pad), 'both documents');
    draw(board, 'only-on-the-board');
    await settle();
    expect(drawn(pad)).toEqual([]);
  });

  it('refuses a person whose interview is another one', async () => {
    await refusedOn(await openPad(HUGO, WENS));
  });

  it.each([
    ['the recruiter, who reads the interview but holds no seat in the call', GRETA, 'interviews'],
    ['the hiring manager of the opening', AMARA, 'interviews'],
    ['a user of another tenant', THEO, 'orgiq'],
  ])('refuses %s', async (_who, sub, tenant) => {
    await refusedOn(await openPad(sub, SHARED, tenant));
  });

  it('has no board for a behavioural round, even for its lead', async () => {
    await refusedOn(await openPad(WEN, BEHAVIOURAL));
  });

  it('refuses everything while the tenant is switched off', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    try { await refusedOn(await openPad(HUGO, SHARED)); } finally { delete process.env['INTERVIEWS_ENABLED']; }
  });
});

describe('the candidate\'s seat on the board', () => {
  const invites = new MemoryInviteStore();
  beforeAll(() => setInviteStore(invites));
  afterAll(() => { setInviteStore(null); fixtureRegistry.resetAll('default'); });

  async function candidate(interviewId: string, admitted: boolean): Promise<string> {
    const invite = await invites.issueInvite({ interviewId, tokenHash: (interviewId === SHARED ? 'a' : 'b').repeat(64), issuedBy: GRETA,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await invites.recordOpening(invite.id, new Date().toISOString(), 'c'.repeat(64));
    await applyAdmission(invite.id, { kind: 'knock' });
    if (admitted) await applyAdmission(invite.id, { kind: 'decide', admit: true });
    return `${GUEST}${invite.id}`;
  }

  it('the admitted candidate draws beside the lead, and each sees the other\'s named pointer', async () => {
    const guest = await candidate(SHARED, true);
    const hugo = await openPad(HUGO, SHARED);
    const mine = await openPad(guest, SHARED, 'interviews');
    await until(() => subscribed(hugo) && subscribed(mine), 'both subscriptions');
    draw(mine, 'candidate-box');
    await until(() => drawn(hugo).includes('candidate-box'), 'the candidate\'s stroke to reach the lead');
    hugo.provider.awareness.setLocalStateField('diagram', { name: 'Hugo' });
    mine.provider.awareness.setLocalStateField('diagram', { name: 'Candidate' });
    const names = (p: Pad) => [...p.provider.awareness.getStates().values()].map(s => (s as { diagram?: { name?: string } }).diagram?.name);
    await until(() => names(mine).includes('Hugo') && names(hugo).includes('Candidate'), 'the pointers to cross');
  });

  it('refuses a candidate of another interview on this board', async () => {
    await refusedOn(await openPad(await candidate(WENS, true), SHARED, 'interviews'));
  });

  it('refuses a candidate who is still waiting to be let in', async () => {
    await refusedOn(await openPad(await candidate(SHARED, false), SHARED, 'interviews'));
  });
});

describe('the board\'s names', () => {
  it('names a board by its interview, within the library\'s 50-character channel cap, apart from the pad', () => {
    expect(boardChannel('iv-k1p5w8ra')).toBe('doc:ivboard:iv-k1p5w8ra');
    expect(boardInterviewId('doc:ivboard:iv-k1p5w8ra')).toBe('iv-k1p5w8ra');
    expect(boardInterviewId(padChannel('iv-k1p5w8ra')!)).toBeNull();
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(boardChannel(uuid)!.length).toBeLessThanOrEqual(50);
    expect(boardChannel('x'.repeat(39))).toBeNull();
    expect(boardChannel('../pad')).toBeNull();
    expect(padDocumentAuthz('c', boardChannel(uuid)!, null, 'update')).toBe(true);
    expect(padDocumentAuthz('c', boardChannel(uuid)!, null, 'delete')).toBe(false);
  });
});

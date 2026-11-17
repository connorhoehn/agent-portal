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

  it('stops delivering to a panel member the moment they are taken off the panel, with the verdict cache on', async () => {
    const hugo = await openPad(HUGO, SHARED);
    const wen = await openPad(WEN, SHARED);
    await until(() => subscribed(hugo) && subscribed(wen), 'both subscriptions');
    hugo.text.insert(0, 'first line\n');
    await until(() => wen.text.toString().includes('first line'), 'the first line at Wen');
    sharedPanel = [];
    try {
      hugo.text.insert(hugo.text.length, 'after the change\n');
      await until(() => hugo.provider.persistenceState === 'saved', 'Hugo\'s second edit to persist');
      await settle();
      expect(wen.text.toString()).not.toContain('after the change');
      // Her own writes are refused too.
      wen.text.insert(0, 'still here?\n');
      await until(() => wen.provider.persistenceState === 'error', 'Wen\'s write to be refused');
      await settle();
      expect(hugo.text.toString()).not.toContain('still here?');
    } finally { sharedPanel = [WEN]; }
  });

  it('reads the one interview for each decision, never the whole table', async () => {
    const listSpy = jest.spyOn(store, 'listInterviews');
    store.byIdReads.length = 0;
    const hugo = await openPad(HUGO, SHARED);
    await until(() => subscribed(hugo), 'Hugo on his pad');
    hugo.text.insert(0, 'x');
    await until(() => hugo.provider.persistenceState === 'saved', 'the edit to persist');
    expect(store.byIdReads.length).toBeGreaterThan(0);
    expect(store.byIdReads.every((id) => id === SHARED)).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
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

describe('the candidate\'s seat on the pad (row I2.2)', () => {
  const invites = new MemoryInviteStore();
  beforeAll(() => setInviteStore(invites));
  afterAll(() => { setInviteStore(null); fixtureRegistry.resetAll('default'); });

  /** A link to `interviewId`, opened: the guest's subject, waiting or admitted. */
  async function candidate(interviewId: string, admitted: boolean): Promise<string> {
    const invite = await invites.issueInvite({ interviewId, tokenHash: (interviewId === SHARED ? 'a' : 'b').repeat(64), issuedBy: GRETA,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await invites.recordOpening(invite.id, new Date().toISOString(), 'c'.repeat(64));
    await applyAdmission(invite.id, { kind: 'knock' });
    if (admitted) await applyAdmission(invite.id, { kind: 'decide', admit: true });
    return `${GUEST}${invite.id}`;
  }

  it('the admitted candidate types into their own pad beside the lead, and both converge', async () => {
    const guest = await candidate(SHARED, true);
    const hugo = await openPad(HUGO, SHARED);
    const mine = await openPad(guest, SHARED, 'interviews');
    await until(() => subscribed(hugo) && subscribed(mine), 'both subscriptions');
    mine.text.insert(0, 'def answer():\n');
    hugo.text.insert(0, '# question 1\n');
    await until(() => hugo.text.toString() === mine.text.toString() && mine.text.toString().includes('# question 1') && hugo.text.toString().includes('def answer'), 'the two texts to converge');
    // Each sees the other's named caret.
    hugo.provider.awareness.setLocalStateField('user', { name: 'Hugo', color: '#336699' });
    mine.provider.awareness.setLocalStateField('user', { name: 'Candidate', color: '#993366' });
    const names = (p: Pad) => [...p.provider.awareness.getStates().values()].map(s => (s as { user?: { name?: string } }).user?.name);
    await until(() => names(mine).includes('Hugo') && names(hugo).includes('Candidate'), 'the carets to cross');
  });

  it('refuses a candidate of another interview on this pad', async () => {
    const other = await candidate(WENS, true);
    await refusedOn(await openPad(other, SHARED, 'interviews'));
  });

  it('refuses a candidate who is still waiting to be let in', async () => {
    const waiting = await candidate(SHARED, false);
    await refusedOn(await openPad(waiting, SHARED, 'interviews'));
  });
});

describe('the pad\'s names and its document hook', () => {
  it('names a pad by its interview, within the library\'s 50-character channel cap', () => {
    expect(padChannel('iv-k1p5w8ra')).toBe('doc:ivpad:iv-k1p5w8ra');
    expect(padInterviewId('doc:ivpad:iv-k1p5w8ra')).toBe('iv-k1p5w8ra');
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(padChannel(uuid)!.length).toBeLessThanOrEqual(50);
    expect(padChannel('x'.repeat(41))).toBeNull();
    for (const bad of ['', '-lead', 'a:b', 'a/b', 'a b']) expect(padChannel(bad)).toBeNull();
    for (const other of ['doc:notes', 'doc:ivpad:', 'doc:ivpad:a:b', 'presence:doc:ivpad:x', 'interviews:interview:x']) expect(padInterviewId(other)).toBeNull();
  });

  it('allows only reading, editing and carets, and only on a pad', () => {
    const pad = padChannel('iv-k1p5w8ra')!;
    for (const action of ['read', 'update', 'awareness'] as const) expect(padDocumentAuthz('c', pad, null, action)).toBe(true);
    for (const action of ['save', 'restore', 'metadata', 'create', 'delete', 'seed'] as const) expect(padDocumentAuthz('c', pad, null, action)).toBe(false);
    expect(padDocumentAuthz('c', 'doc:notes', null, 'read')).toBe(false);
    expect(padDocumentAuthz('c', '', null, 'create')).toBe(false);
  });
});

// OWED O-236 and O-237 (lane H8): the candidate's seat ending mid-edit, the pad after the end, and the pad across a restart.
describe('the pad when a seat ends, the interview ends, or the gateway restarts', () => {
  const invites = new MemoryInviteStore();
  beforeAll(() => setInviteStore(invites));
  afterAll(() => { setInviteStore(null); fixtureRegistry.resetAll('default'); });
  let k = 0;
  async function admitted(interviewId: string): Promise<{ sub: string; inviteId: string }> {
    k += 1;
    const invite = await invites.issueInvite({ interviewId, tokenHash: String(k % 10).repeat(64), issuedBy: GRETA,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await invites.recordOpening(invite.id, new Date().toISOString(), 'd'.repeat(64));
    await applyAdmission(invite.id, { kind: 'knock' });
    await applyAdmission(invite.id, { kind: 'decide', admit: true });
    return { sub: `${GUEST}${invite.id}`, inviteId: invite.id };
  }
  const setState = async (state: Interview['state']) => {
    const { interviewsFixture } = await import('../../../../mock/interviews.js');
    interviewsFixture.rows().find((i) => i.id === SHARED)!.state = state;
  };
  beforeEach(() => setState('live'));
  afterEach(() => setState('ready'));

  /** The candidate and the lead on the pad, both lines across; returns both pads. */
  async function together(sub: string): Promise<{ hugo: Pad; mine: Pad }> {
    const hugo = await openPad(HUGO, SHARED);
    const mine = await openPad(sub, SHARED, 'interviews');
    await until(() => subscribed(hugo) && subscribed(mine), 'both subscriptions');
    mine.text.insert(0, 'def answer():\n');
    await until(() => hugo.text.toString().includes('def answer'), 'the candidate\'s line at the lead');
    return { hugo, mine };
  }
  /** After the seat ends: nothing more reaches the candidate, and the candidate's writes are refused and reach nobody. */
  async function cutOff(hugo: Pad, mine: Pad): Promise<void> {
    // The gateway keeps a pad's text in memory across these tests: each marker is new, so nothing earlier can match it.
    const lead = `# after the change ${++k}\n`;
    const cand = `still typing ${++k}\n`;
    hugo.text.insert(hugo.text.length, lead);
    await until(() => hugo.provider.persistenceState === 'saved', 'the lead\'s edit to persist');
    await settle();
    expect(mine.text.toString()).not.toContain(lead);
    mine.text.insert(0, cand);
    await until(() => mine.provider.persistenceState === 'error', 'the candidate\'s write to be refused');
    await settle();
    expect(hugo.text.toString()).not.toContain(cand);
  }

  it('a candidate turned away mid-edit stops receiving and sending at once', async () => {
    const { sub, inviteId } = await admitted(SHARED);
    const { hugo, mine } = await together(sub);
    await applyAdmission(inviteId, { kind: 'decide', admit: false });
    await cutOff(hugo, mine);
  });

  it('a candidate whose link is revoked mid-edit stops receiving and sending at once', async () => {
    const { sub, inviteId } = await admitted(SHARED);
    const { hugo, mine } = await together(sub);
    // As the revoke route does it (routes/interviews/invite.ts): the store, then the gateway's verdict cache forgets the guest.
    await invites.revokeInvite(SHARED, new Date().toISOString(), GRETA);
    await forgetInterviewGuest(SHARED, 'interview-invite-revoked', { id: inviteId });
    await cutOff(hugo, mine);
  });

  it('after the interview ends the candidate edits nothing', async () => {
    const { sub } = await admitted(SHARED);
    const { hugo, mine } = await together(sub);
    // As the end route does it (routes/interviews/room.ts): the state, then the gateway's verdict cache forgets the guest.
    await setState('ended');
    await forgetInterviewGuest(SHARED, 'interview-ended');
    await cutOff(hugo, mine);
  });

  // Pinned today: the panel's seat on the pad (authority.ts `padSeatHolds`) reads the lead and the panel, not the state, so
  // after the end the lead and the panel can still open and edit the pad. O-236 says "after the interview ends nobody edits".
  it('pinned: after the interview ends the lead can still open the pad and edit it', async () => {
    await setState('ended');
    const hugo = await openPad(HUGO, SHARED);
    await until(() => subscribed(hugo), 'the lead\'s subscription after the end');
    hugo.text.insert(0, '# after the end\n');
    await until(() => hugo.provider.persistenceState === 'saved', 'the lead\'s edit after the end to persist');
  });
  it.failing('after the interview ends nobody edits the pad, the lead included', async () => {
    await setState('ended');
    await refusedOn(await openPad(HUGO, SHARED));
  });

  // O-237: the pad's text is the gateway's memory (I0.7, feature.ts: "a pad lives as long as the process"). A restart (this
  // gateway disposed and a new one attached, as a new process attaches it) opens every pad empty; the pad log's last snapshot is
  // what remains of the code. (The walk's step I4.2h says what the mock world's reset does to it.)
  it('after the gateway restarts the pad opens empty; the pad log\'s last snapshot is what remains', async () => {
    const { appendPadEvents, latestPadSnapshot } = await import('../log/index.js');
    const { MemoryPadLogStore, setPadLogStore } = await import('../log/store.js');
    setPadLogStore(new MemoryPadLogStore());
    try {
      const marker = `def kept_in_memory_${++k}():\n    return 1\n`;
      const hugo = await openPad(HUGO, SHARED);
      await until(() => subscribed(hugo), 'the lead\'s subscription');
      hugo.text.insert(0, marker);
      await until(() => hugo.provider.persistenceState === 'saved', 'the edit to persist');
      await appendPadEvents(SHARED, { id: HUGO, side: 'panel' }, [{ kind: 'snapshot', clientAt: new Date().toISOString(), text: marker }]);
      for (const p of open.splice(0)) { p.provider.destroy(); p.ws.terminate(); }
      await dispose();
      dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, authorityCache: true }).dispose;
      const again = await openPad(HUGO, SHARED);
      await until(() => subscribed(again), 'the subscription after the restart');
      await settle();
      expect(again.text.toString()).toBe('');
      expect((await latestPadSnapshot(SHARED))!.text).toBe(marker);
    } finally { setPadLogStore(null); }
  });
});

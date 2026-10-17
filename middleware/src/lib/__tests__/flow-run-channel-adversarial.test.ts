// Adversarial checks for a flow run's requester-private channel
// (`<tenant>:flowrun:<runId>`, lib/flow-runs/channel.ts) against the INSTALLED
// realtime-modules LocalRealtimeRouter and pipeline() feature: every subscribe
// and every per-recipient fan-out goes through the gateway's real
// admitChannel + channelGuard, and the run row is the durable
// store's (the registered mock fixture), read fresh on every decision.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { LocalRealtimeRouter, baseChannel } from '@connorhoehn/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';

import { channelGuard, lobbyGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../social-chat.js';
import { pipelineFamilyChannel, resetGatewayRunFeed, tenantActivity, tenantPipeline } from '../gateway-run-feed.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { flowRunChannel, flowRunStore, parseFlowRunChannel, type FlowRunRow } from '../flow-runs/index.js';
import { admitChannel } from '../gateway/authority.js';

const POLICY: Record<string, string[]> = {
  member: [], assessor: ['ViewAssessment'], participant: ['ViewSocial', 'PostMessage'], author: ['ViewPipelines'], reader: [],
};
let users: Map<string, UserInfo>;
let duringPolicy: (() => void) | null;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctxOf = (userId: string, org: string, role: string) =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const settle = () => new Promise(resolve => setImmediate(resolve));

type Msg = Record<string, unknown>;
function setup() {
  const contexts = new Map<string, Msg>();
  const sent: Array<{ to: string; message: Msg }> = [];
  // `smuggle(clientId)` lets that socket's next subscribe skip the decision —
  // a socket that got into the member set some other way — so the per-frame
  // recheck is what has to withhold its frames.
  const smuggled = new Set<string>();
  const router = new LocalRealtimeRouter({
    logger,
    authorize: ({ kind, clientId, channel, ctx }) =>
      smuggled.delete(clientId) ? true : admitChannel({ kind, clientId, channel, ctx: ctx as Msg | null }),
  });
  (router as unknown as { _setHandle(h: unknown): void })._setHandle({
    getClientContext: (id: string) => contexts.get(id) ?? null,
    sendToClient: (to: string, message: Msg) => { sent.push({ to, message }); return true; },
    listClients: () => [...contexts.keys()],
  });
  /** The sockets holding a readable subscription to `channel` (the router's public probe). */
  const members = async (channel: string) => {
    const out: string[] = [];
    for (const id of contexts.keys()) if (await router.isClientSubscribed(id, channel)) out.push(id);
    return out;
  };
  const smuggle = async (clientId: string, channel: string) => { smuggled.add(clientId); await router.subscribeToChannel(clientId, channel); smuggled.delete(clientId); };
  const frames = (to: string) => sent.filter(s => s.to === to && s.message['type'] === 'pipeline:event').map(s => s.message);
  const acks = (to: string) => sent.filter(s => s.to === to && s.message['type'] === 'pipeline' && s.message['action'] === 'subscribed');
  const pipe = tenantPipeline().create({ router: router as never, logger });
  const act = tenantActivity().create({ router: router as never, logger });
  return { router, contexts, sent, members, smuggle, frames, acks, pipe, act };
}

/** A queued run, as the summarize/draft routes create it. */
const mkRun = (over: Partial<FlowRunRow> & { tenant: 'social' | 'assessment'; requestedBy: string }): Promise<FlowRunRow> =>
  flowRunStore.create({
    tenant: over.tenant, kind: over.tenant === 'social' ? 'social.summarize' : 'assessment.evidence-summary',
    requestedBy: over.requestedBy, scope: over.scope ?? (over.tenant === 'social' ? 'social:dm:sam:tom' : 'TEAM-1:dim'),
    input: null, progress: [{ id: 'read', label: 'Read', status: 'pending' }], idPrefix: over.tenant === 'social' ? 'sum' : 'adr',
  });
const wire = (run: FlowRunRow) => `pipeline:run:${run.id}`;

beforeEach(() => {
  resetGatewayRunFeed();
  flowRunsFixture.reset();
  duringPolicy = null;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['bea', user('bea', { assessment: ['assessor'] })],
    ['sam', user('sam', { social: ['participant'], orgiq: ['member'] })],
    ['tom', user('tom', { social: ['participant'] })],
    ['pat', user('pat', { pipelines: ['author'] })],
    ['pam', user('pam', { pipelines: ['author'] })],
    ['ora', user('ora', { orgiq: ['member'], pipelines: ['reader'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => {
    const ok = (POLICY[p.role] ?? []).includes(a);
    duringPolicy?.();
    return ok;
  });
});
afterEach(() => { resetGatewayRunFeed(); jest.clearAllMocks(); });

describe('the channel name', () => {
  it('is a pure function of the id: the flow fixes the tenant, a re-filed or malformed name parses to nothing', () => {
    const id = 'sum-0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(flowRunChannel(id)).toBe(`social:flowrun:${id}`);
    expect(pipelineFamilyChannel(`pipeline:run:${id}`)).toBe(`social:flowrun:${id}`);
    expect(pipelineFamilyChannel('pipeline:run:adr-0f0e0d0c-0b0a-4908-8706-050403020100')).toMatch(/^assessment:flowrun:/);
    expect(parseFlowRunChannel(`assessment:flowrun:${id}`)).toBeNull();
    expect(parseFlowRunChannel(`orgiq:flowrun:${id}`)).toBeNull();
    expect(parseFlowRunChannel('social:flowrun:sum-1')).toBeNull();
    expect(flowRunChannel('xyz-0f0e0d0c-0b0a-4908-8706-050403020100')).toBeNull();
    // A pipelines run id still maps to its own family.
    expect(pipelineFamilyChannel('pipeline:run:r1')).toBe('pipelines:run:r1');
  });

  it('is never a call lobby', () => {
    expect(lobbyGuard({ userId: 'sam', org: 'social', tenants: ['social'] }, flowRunChannel('sum-0f0e0d0c-0b0a-4908-8706-050403020100')!)).toBe(false);
  });
});

describe('subscribe admission', () => {
  it('admits the requester and delivers every store move to them', async () => {
    const { pipe, contexts, members, frames, acks } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual(['ana-s']);
    expect(acks('ana-s')).toHaveLength(1);

    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await flowRunStore.progress(run.id, 'n1', [{ id: 'read', label: 'Read', status: 'running' }], 60_000);
    await flowRunStore.progress(run.id, 'n1', null, 60_000); // heartbeat: no frame
    await flowRunStore.finish(run.id, 'n1', { status: 'completed', result: { secret: 'the draft' } });
    await settle();
    const got = frames('ana-s');
    expect(got.map(f => f['eventType'])).toEqual(['pipeline:run:started', 'pipeline:step:started', 'pipeline:run:completed']);
    expect(got.every(f => f['channel'] === flowRunChannel(run.id))).toBe(true);
    expect(got[1]!['payload']).toMatchObject({ runId: run.id, status: 'running', stepId: 'read' });
    // The frame is a hint: the result stays behind the REST read.
    expect(JSON.stringify(got)).not.toContain('the draft');
  });

  it('refuses a non-requester in the same tenant, with the same role', async () => {
    const { pipe, contexts, members, acks } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    contexts.set('bea-s', ctxOf('bea', 'assessment', 'assessor'));
    await pipe.handleAction('bea-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
    expect(acks('bea-s')).toHaveLength(0);
  });

  it('refuses a fellow member of the run\'s Social conversation who did not request it', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRun({ tenant: 'social', requestedBy: 'sam', scope: 'social:dm:sam:tom' });
    contexts.set('tom-s', ctxOf('tom', 'social', 'participant'));
    contexts.set('sam-s', ctxOf('sam', 'orgiq', 'member')); // embedded Social: standing in orgiq, holding a social grant
    await pipe.handleAction('tom-s', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual(['sam-s']);
  });

  it('refuses the requester standing in another tenant, and another tenant\'s session naming the id', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    contexts.set('ana-o', ctxOf('ana', 'orgiq', 'member'));   // REST requireTenant('assessment') would 403
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await pipe.handleAction('ana-o', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });

  it('refuses an unknown run exactly like someone else\'s', async () => {
    const { pipe, contexts, sent, members } = setup();
    const ghost = 'adr-0f0e0d0c-0b0a-4908-8706-050403020100';
    const other = await mkRun({ tenant: 'assessment', requestedBy: 'bea' });
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    await pipe.handleAction('ana-s', 'subscribe', { channel: `pipeline:run:${ghost}` });
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(other) });
    expect(await members(flowRunChannel(ghost)!)).toEqual([]);
    expect(await members(flowRunChannel(other.id)!)).toEqual([]);
    // Same frame, modulo the channel it names (and timestamps).
    const answers = sent.filter(s => s.to === 'ana-s').map(s => JSON.stringify(s.message)
      .replaceAll(flowRunChannel(ghost)!, '<ch>').replaceAll(flowRunChannel(other.id)!, '<ch>').replace(/"timestamp":"[^"]+"/g, ''));
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(answers[1]);
  });

  it('a grant revoked while the subscribe policy call is in flight admits nothing', async () => {
    const { pipe, contexts, members, acks } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    duringPolicy = () => { users.get('ana')!.grants = { orgiq: ['member'] }; };
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
    expect(acks('ana-s')).toHaveLength(0);
  });

  it('an epoch bumped while the Social policy call is in flight admits nothing', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRun({ tenant: 'social', requestedBy: 'sam' });
    contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    duringPolicy = () => { users.get('sam')!.epoch = 2; };
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });

  it('refuses the requester once they left the run\'s Social channel', async () => {
    const { pipe, contexts, members } = setup();
    const channel = 'social:ch:ops';
    const chat = socialChat(); await chat.ready;
    const at = new Date().toISOString();
    await chat.membershipStore.putMember({ channel, userId: 'tom', role: 'member', addedBy: 'tom', addedAt: at, historyFrom: null, removedAt: null });
    await chat.membershipStore.putMember({ channel, userId: 'sam', role: 'member', addedBy: 'sam', addedAt: at, historyFrom: null, removedAt: at });
    const run = await mkRun({ tenant: 'social', requestedBy: 'sam', scope: channel });
    contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });
});

describe('server publish only', () => {
  it('refuses every client write path and every service-prefixed name, for the requester too', async () => {
    const { router, act, contexts, members } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    const ch = flowRunChannel(run.id)!;
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    const decide = (kind: 'subscribe' | 'publish', channel: string) =>
      admitChannel({ kind, clientId: 'ana-s', channel, ctx: contexts.get('ana-s')! });
    expect(await decide('subscribe', ch)).toBe(true);
    expect(await decide('publish', ch)).toBe(false);
    for (const prefixed of [`presence:${ch}`, `reactions:${ch}`, `cursor:${ch}`]) {
      expect(await decide('subscribe', prefixed)).toBe(false);
      expect(await decide('publish', prefixed)).toBe(false);
    }
    expect(channelGuard({ userId: 'ana', org: 'assessment', tenants: ['assessment'] }, ch, 'publish')).toBe(false);
    // A forged frame through the router's publish path never fans out.
    await router.subscribeToChannel('ana-s', ch);
    const before = await members(ch);
    await (router as unknown as { sendToChannel(c: string, m: unknown, x?: string, o?: unknown): Promise<void> })
      .sendToChannel(ch, { type: 'pipeline:event', eventType: 'pipeline:run:completed', payload: { runId: run.id } }, undefined, { publisherClientId: 'ana-s' });
    await act.handleAction('ana-s', 'publish', { channelId: ch, event: { eventType: 'run.completed' } });
    expect(await members(ch)).toEqual(before);
  });
});

describe('fan-out', () => {
  it('frames reach the requester only; a revocation after subscribing withholds the next frame', async () => {
    const { pipe, router, contexts, frames, smuggle } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    const ch = flowRunChannel(run.id)!;
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    contexts.set('bea-s', ctxOf('bea', 'assessment', 'assessor'));
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(run) });
    // Even a socket that got into the member set some other way is re-asked per frame.
    await smuggle('bea-s', ch);
    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await settle();
    expect(frames('ana-s')).toHaveLength(1);
    expect(frames('bea-s')).toHaveLength(0);

    users.get('ana')!.epoch = 2; // signed out elsewhere
    await flowRunStore.finish(run.id, 'n1', { status: 'failed', error: 'boom' });
    await settle();
    expect(frames('ana-s')).toHaveLength(1);
  });

  it('a lapsed lease that fails the run tells the requester', async () => {
    const { pipe, contexts, frames } = setup();
    const run = await mkRun({ tenant: 'assessment', requestedBy: 'ana' });
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(run) });
    await flowRunStore.claim({ kinds: [run.kind], owner: 'dead', leaseMs: -1, id: run.id });
    await flowRunStore.expireLeases();
    await settle();
    expect(frames('ana-s').map(f => f['eventType'])).toEqual(['pipeline:run:started', 'pipeline:run:failed']);
    expect(frames('ana-s')[1]!['payload']).toMatchObject({ status: 'failed', error: expect.any(String) });
  });
});

// Social /deck (`sdk-`, lib/social-deck.ts): the same requester-private
// `social:flowrun:` authority as /summarize — the deck run's REST read is
// ViewSocial + CURRENT membership of the run's conversation + requester.
describe('Social /deck runs (sdk-)', () => {
  const mkDeckRun = (requestedBy: string, scope = 'social:dm:sam:tom'): Promise<FlowRunRow> => flowRunStore.create({
    tenant: 'social', kind: 'social.deck', requestedBy, scope, input: null,
    progress: [{ id: 'outline', label: 'Outline', status: 'pending' }], idPrefix: 'sdk',
  });

  it('maps only onto social:flowrun, never re-filed under another tenant', () => {
    const id = 'sdk-0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(flowRunChannel(id)).toBe(`social:flowrun:${id}`);
    expect(pipelineFamilyChannel(`pipeline:run:${id}`)).toBe(`social:flowrun:${id}`);
    for (const t of ['assessment', 'orgiq', 'pipelines']) expect(parseFlowRunChannel(`${t}:flowrun:${id}`)).toBeNull();
    expect(flowRunChannel('sdeck-0f0e0d0c-0b0a-4908-8706-050403020100')).toBeNull();
    expect(lobbyGuard({ userId: 'sam', org: 'social', tenants: ['social'] }, flowRunChannel(id)!)).toBe(false);
  });

  it('admits the requester and pushes every move as a hint (no spec in the frame)', async () => {
    const { pipe, contexts, members, frames } = setup();
    const run = await mkDeckRun('sam');
    contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual(['sam-s']);
    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await flowRunStore.progress(run.id, 'n1', [{ id: 'outline', label: 'Outline', status: 'running' }], 60_000);
    await flowRunStore.finish(run.id, 'n1', { status: 'completed', result: { spec: { title: 'secret slides' } } });
    await settle();
    expect(frames('sam-s').map(f => f['eventType'])).toEqual(['pipeline:run:started', 'pipeline:step:started', 'pipeline:run:completed']);
    expect(JSON.stringify(frames('sam-s'))).not.toContain('secret slides');
  });

  it('refuses a fellow member who did not request it, another tenant\'s session, and an unknown run identically', async () => {
    const { pipe, contexts, sent, members } = setup();
    const run = await mkDeckRun('sam');
    const ghost = 'sdk-0f0e0d0c-0b0a-4908-8706-0504030201ff';
    contexts.set('tom-s', ctxOf('tom', 'social', 'participant'));
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await pipe.handleAction('tom-s', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('tom-s', 'subscribe', { channel: `pipeline:run:${ghost}` });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
    expect(await members(flowRunChannel(ghost)!)).toEqual([]);
    const answers = sent.filter(s => s.to === 'tom-s').map(s => JSON.stringify(s.message)
      .replaceAll(flowRunChannel(ghost)!, '<ch>').replaceAll(flowRunChannel(run.id)!, '<ch>').replace(/"timestamp":"[^"]+"/g, ''));
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(answers[1]);
  });

  it('refuses the requester after an epoch bump mid-policy, or once they left the conversation', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkDeckRun('sam');
    contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    duringPolicy = () => { users.get('sam')!.epoch = 2; };
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);

    duringPolicy = null; users.get('sam')!.epoch = 1;
    const channel = 'social:ch:ops';
    const chat = socialChat(); await chat.ready;
    const at = new Date().toISOString();
    await chat.membershipStore.putMember({ channel, userId: 'tom', role: 'member', addedBy: 'tom', addedAt: at, historyFrom: null, removedAt: null });
    await chat.membershipStore.putMember({ channel, userId: 'sam', role: 'member', addedBy: 'sam', addedAt: at, historyFrom: null, removedAt: at });
    const left = await mkDeckRun('sam', channel);
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(left) });
    expect(await members(flowRunChannel(left.id)!)).toEqual([]);
  });

  it('re-asks per frame: a smuggled member gets nothing, a revoked requester stops receiving', async () => {
    const { pipe, router, contexts, frames, smuggle } = setup();
    const run = await mkDeckRun('sam');
    const ch = flowRunChannel(run.id)!;
    contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    contexts.set('tom-s', ctxOf('tom', 'social', 'participant'));
    await pipe.handleAction('sam-s', 'subscribe', { channel: wire(run) });
    await smuggle('tom-s', ch);
    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await settle();
    expect(frames('sam-s')).toHaveLength(1);
    expect(frames('tom-s')).toHaveLength(0);
    users.get('sam')!.grants = { orgiq: ['member'] };
    await flowRunStore.finish(run.id, 'n1', { status: 'completed', result: {} });
    await settle();
    expect(frames('sam-s')).toHaveLength(1);
  });
});

// Run report deck agent revise (`pdr-`, providers/pipeline-decks.ts): the run's
// REST read is requireTenant('pipelines') + ViewPipelines + requester.
describe('pipelines deck revise runs (pdr-)', () => {
  const mkRevise = (requestedBy: string, over: Partial<{ kind: string; scope: string }> = {}): Promise<FlowRunRow> => flowRunStore.create({
    tenant: 'pipelines', kind: over.kind ?? 'pipelines.deck-revise', requestedBy,
    scope: over.scope ?? 'pdeck-0f0e0d0c-0b0a-4908-8706-050403020100', input: { instruction: 'secret instruction' },
    progress: [{ id: 'revise', label: 'Revising', status: 'pending' }], idPrefix: 'pdr',
  });

  it('maps only onto pipelines:flowrun, never re-filed under another tenant, never a call lobby', () => {
    const id = 'pdr-0f0e0d0c-0b0a-4908-8706-050403020100';
    expect(flowRunChannel(id)).toBe(`pipelines:flowrun:${id}`);
    expect(pipelineFamilyChannel(`pipeline:run:${id}`)).toBe(`pipelines:flowrun:${id}`);
    for (const t of ['social', 'assessment', 'orgiq']) expect(parseFlowRunChannel(`${t}:flowrun:${id}`)).toBeNull();
    expect(flowRunChannel('pdrx-0f0e0d0c-0b0a-4908-8706-050403020100')).toBeNull();
    expect(lobbyGuard({ userId: 'pat', org: 'pipelines', tenants: ['pipelines'] }, flowRunChannel(id)!)).toBe(false);
  });

  it('admits the requester and pushes every move as a hint (no instruction or spec in the frame)', async () => {
    const { pipe, contexts, members, frames } = setup();
    const run = await mkRevise('pat');
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual(['pat-s']);
    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await flowRunStore.progress(run.id, 'n1', [{ id: 'revise', label: 'Revising', status: 'running' }], 60_000);
    await flowRunStore.finish(run.id, 'n1', { status: 'completed', result: { summary: 'secret slides' } });
    await settle();
    expect(frames('pat-s').map(f => f['eventType'])).toEqual(['pipeline:run:started', 'pipeline:step:started', 'pipeline:run:completed']);
    expect(JSON.stringify(frames('pat-s'))).not.toMatch(/secret/);
  });

  it('refuses a fellow pipelines user, another tenant\'s session, a session standing elsewhere and an unknown run identically', async () => {
    const { pipe, contexts, sent, members } = setup();
    const run = await mkRevise('pat');
    const ghost = 'pdr-0f0e0d0c-0b0a-4908-8706-0504030201ff';
    contexts.set('pam-s', ctxOf('pam', 'pipelines', 'author'));
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    contexts.set('pat-o', ctxOf('pat', 'orgiq', 'member')); // the requester, but REST requireTenant('pipelines') would 403
    users.get('pat')!.grants = { pipelines: ['author'], orgiq: ['member'] };
    await pipe.handleAction('pam-s', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('ana-s', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('pat-o', 'subscribe', { channel: wire(run) });
    await pipe.handleAction('pam-s', 'subscribe', { channel: `pipeline:run:${ghost}` });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
    expect(await members(flowRunChannel(ghost)!)).toEqual([]);
    const answers = sent.filter(s => s.to === 'pam-s').map(s => JSON.stringify(s.message)
      .replaceAll(flowRunChannel(ghost)!, '<ch>').replaceAll(flowRunChannel(run.id)!, '<ch>').replace(/"timestamp":"[^"]+"/g, ''));
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(answers[1]);
  });

  it('refuses a pipelines row of any other kind (a forged pdr- id on a different flow)', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRevise('pat', { kind: 'pipelines.diagram' });
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });

  it('refuses the requester after a grant revoked or an epoch bumped while the policy call was in flight', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRevise('pat');
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    duringPolicy = () => { users.get('pat')!.grants = { orgiq: ['member'] }; };
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
    duringPolicy = null; users.get('pat')!.grants = { pipelines: ['author'] };
    duringPolicy = () => { users.get('pat')!.epoch = 2; };
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });

  it('refuses a requester whose role lost ViewPipelines (the REST gate)', async () => {
    const { pipe, contexts, members } = setup();
    const run = await mkRevise('ora');
    contexts.set('ora-s', ctxOf('ora', 'pipelines', 'reader'));
    await pipe.handleAction('ora-s', 'subscribe', { channel: wire(run) });
    expect(await members(flowRunChannel(run.id)!)).toEqual([]);
  });

  it('refuses every client write path and service prefix, and re-asks per frame', async () => {
    const { pipe, router, contexts, frames, smuggle } = setup();
    const run = await mkRevise('pat');
    const ch = flowRunChannel(run.id)!;
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    contexts.set('pam-s', ctxOf('pam', 'pipelines', 'author'));
    const decide = (kind: 'subscribe' | 'publish', channel: string) =>
      admitChannel({ kind, clientId: 'pat-s', channel, ctx: contexts.get('pat-s')! });
    expect(await decide('subscribe', ch)).toBe(true);
    expect(await decide('publish', ch)).toBe(false);
    for (const prefixed of [`presence:${ch}`, `reactions:${ch}`, `cursor:${ch}`]) expect(await decide('subscribe', prefixed)).toBe(false);
    await pipe.handleAction('pat-s', 'subscribe', { channel: wire(run) });
    await smuggle('pam-s', ch);
    await flowRunStore.claim({ kinds: [run.kind], owner: 'n1', leaseMs: 60_000, id: run.id });
    await settle();
    expect(frames('pat-s')).toHaveLength(1);
    expect(frames('pam-s')).toHaveLength(0);
    users.get('pat')!.epoch = 2;
    await flowRunStore.finish(run.id, 'n1', { status: 'failed', error: 'boom' });
    await settle();
    expect(frames('pat-s')).toHaveLength(1);
  });
});

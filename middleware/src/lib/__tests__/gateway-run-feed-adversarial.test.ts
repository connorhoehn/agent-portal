// Adversarial checks for lib/gateway-run-feed.ts against the INSTALLED
// realtime-modules LocalRealtimeRouter (not a fake): every subscribe, history
// read and per-recipient fan-out goes through the gateway's real
// authorizeLiveGatewayChannel + channelGuard, so revocation and partition
// rules are the ones production asks.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { LocalRealtimeRouter, baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { authorizeLiveGatewayChannel } from '../live-principal.js';
import { channelGuard } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import { publishChannelActivity, publishPipelineRunMove, resetGatewayRunFeed, tenantActivity, tenantPipeline } from '../gateway-run-feed.js';

const POLICY: Record<string, string[]> = { member: [], author: ['ViewPipelines'], assessor: ['ViewAssessment'] };
let users: Map<string, UserInfo>;
/** Called inside a policy decision, before it resolves: a revocation mid-await. */
let duringPolicy: (() => void) | null;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctxOf = (userId: string, org: string, role: string) =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const logger = { debug() {}, info() {}, warn() {}, error() {} };

type Msg = Record<string, unknown>;
function realRouter() {
  const contexts = new Map<string, Msg>();
  const sent: Array<{ to: string; message: Msg }> = [];
  const router = new LocalRealtimeRouter({
    logger,
    authorize: ({ kind, clientId, channel, ctx }) =>
      authorizeLiveGatewayChannel({ kind, clientId, channel, ctx: ctx as Msg | null }, { guard: channelGuard, baseChannel }),
  });
  (router as unknown as { _setHandle(h: unknown): void })._setHandle({
    getClientContext: (id: string) => contexts.get(id) ?? null,
    sendToClient: (to: string, message: Msg) => { sent.push({ to, message }); return true; },
    listClients: () => [...contexts.keys()],
  });
  const members = (channel: string) => [...((router as unknown as { channelMembers: Map<string, Set<string>> }).channelMembers.get(channel) ?? [])];
  const of = (to: string, type: string) => sent.filter(s => s.to === to && s.message['type'] === type).map(s => s.message);
  return { router, contexts, sent, members, of };
}
const setup = () => {
  const r = realRouter();
  const pipe = tenantPipeline().create({ router: r.router as never, logger });
  const act = tenantActivity().create({ router: r.router as never, logger });
  return { ...r, pipe, act };
};

beforeEach(() => {
  resetGatewayRunFeed();
  duringPolicy = null;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['mia', user('mia', { orgiq: ['member'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'], pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => {
    const ok = (POLICY[p.role] ?? []).includes(a);
    duringPolicy?.();
    return ok;
  });
});
afterEach(() => jest.clearAllMocks());

describe('pipeline feature: fail closed', () => {
  it('ignores every action but subscribe/unsubscribe — no trigger, cancel, approval or emit path exists', async () => {
    const { pipe, contexts, sent, members } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    for (const action of ['trigger', 'cancel', 'resolveApproval', 'resumeFromStep', 'getRun', 'getHistory', 'testEmit', 'simEmit', 'emit', 'publish', '__proto__']) {
      await pipe.handleAction('pat-s', action, { channel: 'pipeline:run:r1', runId: 'r1', eventType: 'pipeline:run:completed' });
    }
    // The library answers an unknown verb with an error frame; nothing else may be sent.
    expect(sent.filter(s => s.message['type'] !== 'error')).toHaveLength(0);
    expect(members('pipelines:run:r1')).toEqual([]);
  });

  it('refuses the firehoses, family names and other partitions as wire channels', async () => {
    const { pipe, contexts, sent, members } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    for (const channel of ['pipeline:all', 'pipeline:approvals', 'pipelines:run:r1', 'orgiq:initiative:p-1', 'pipeline:run:', 'pipeline:run:a b', 'activity:broadcast']) {
      await pipe.handleAction('pat-s', 'subscribe', { channel });
    }
    // Refusals are error frames (PIPELINE_CHANNEL_REFUSED); no ack, no subscription.
    expect(sent.filter(s => s.message['type'] !== 'error')).toHaveLength(0);
    for (const c of ['pipeline:all', 'pipeline:approvals', 'pipelines:run:r1', 'orgiq:initiative:p-1']) expect(members(c)).toEqual([]);
  });

  it('a revocation while the subscribe policy call is in flight admits nothing', async () => {
    const { pipe, contexts, members, of } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    duringPolicy = () => { users.get('pat')!.epoch = 2; }; // sign-out elsewhere bumps the epoch
    await pipe.handleAction('pat-s', 'subscribe', { channel: 'pipeline:run:r1' });
    expect(members('pipelines:run:r1')).toEqual([]);
    expect(of('pat-s', 'pipeline').filter(f => f['action'] === 'subscribed')).toHaveLength(0);
  });

  it('a holder revoked after subscribing receives no further run events (recipient recheck on every fan-out)', async () => {
    const { pipe, contexts, members, of } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await pipe.handleAction('pat-s', 'subscribe', { channel: 'pipeline:run:r1' });
    expect(members('pipelines:run:r1')).toEqual(['pat-s']);
    await publishPipelineRunMove({ id: 'r1', status: 'running' });
    expect(of('pat-s', 'pipeline:event')).toHaveLength(1);
    users.get('pat')!.grants = { orgiq: ['member'] }; // pipelines grant removed
    await publishPipelineRunMove({ id: 'r1', status: 'completed' });
    expect(of('pat-s', 'pipeline:event')).toHaveLength(1);
    expect(of('pat-s', 'activity:event')).toHaveLength(1); // only the pre-revocation row
  });

  it('a pipelines grant held while standing in another tenant does not see runs (REST requireTenant parity)', async () => {
    const { pipe, contexts, members } = setup();
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    await pipe.handleAction('ana-s', 'subscribe', { channel: 'pipeline:run:r1' });
    expect(members('pipelines:run:r1')).toEqual([]);
  });
});

describe('activity feature: server-produced only', () => {
  it('refuses publish; no frame reaches any channel and no history row is written', async () => {
    const { act, contexts, sent, of } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await act.handleAction('pat-s', 'subscribe', { channelId: 'pipelines:run:r1' });
    for (const channelId of [undefined, 'pipelines:run:r1', 'activity:broadcast']) {
      await act.handleAction('pat-s', 'publish', { channelId, event: { eventType: 'pipeline:run:completed', detail: { forged: true } } });
    }
    expect(sent.filter(s => s.message['type'] === 'activity:event')).toHaveLength(0);
    await act.handleAction('pat-s', 'getHistory', { channelId: 'pipelines:run:r1' });
    expect(of('pat-s', 'activity').find(f => f['action'] === 'history')).toMatchObject({ events: [] });
  });

  it('unknown actions answer an error and change nothing', async () => {
    const { act, contexts, sent, members } = setup();
    contexts.set('mia-s', ctxOf('mia', 'orgiq', 'member'));
    await act.handleAction('mia-s', 'emit', { channelId: 'orgiq:initiative:p-1', event: { eventType: 'x' } });
    expect(sent.map(s => s.message['type'])).toEqual(['error']);
    expect(members('orgiq:initiative:p-1')).toEqual([]);
  });

  it('never auto-subscribes, and an explicit broadcast or activity-prefixed subscribe is refused', async () => {
    const { act, contexts, members } = setup();
    contexts.set('mia-s', ctxOf('mia', 'orgiq', 'member'));
    await act.onClientConnect?.('mia-s');
    for (const channelId of ['activity:broadcast', 'activity:orgiq:initiative:p-1', 'orgiq:made-up:1', 'pipeline:all']) {
      await act.handleAction('mia-s', 'subscribe', { channelId });
      expect(members(channelId)).toEqual([]);
    }
  });

  it('history is partitioned by the exact family channel and gated by the current read authority', async () => {
    const { act, contexts, of } = setup();
    contexts.set('mia-s', ctxOf('mia', 'orgiq', 'member'));
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    await publishChannelActivity('orgiq:initiative:p-1', 'work-item.status', { n: 1 });
    await publishChannelActivity('orgiq:initiative:p-10', 'work-item.status', { n: 10 });
    await publishPipelineRunMove({ id: 'p-1', status: 'failed', error: 'secret run detail' });

    // 0.107: a refused read answers an empty history frame; what must never happen is events leaking.
    const history = (to: string) => of(to, 'activity').filter(f => f['action'] === 'history' && (f['events'] as unknown[]).length > 0);
    await act.handleAction('mia-s', 'getHistory', { channelId: 'orgiq:initiative:p-1' });
    expect(history('mia-s')).toHaveLength(1);
    expect(history('mia-s')[0]!['events']).toEqual([expect.objectContaining({ detail: { n: 1 } })]);

    // An orgiq member cannot read the pipelines ring under the same id.
    await act.handleAction('mia-s', 'getHistory', { channelId: 'pipelines:run:p-1' });
    expect(history('mia-s')).toHaveLength(1);
    // A pipelines author standing in pipelines cannot read the orgiq initiative ring.
    await act.handleAction('pat-s', 'getHistory', { channelId: 'orgiq:initiative:p-1' });
    expect(history('pat-s')).toHaveLength(0);
    // Holding orgiq AND pipelines grants while standing in assessment reads neither
    // (REST requireTenant('orgiq') / requireTenant('pipelines') would 403).
    await act.handleAction('ana-s', 'getHistory', { channelId: 'orgiq:initiative:p-1' });
    await act.handleAction('ana-s', 'getHistory', { channelId: 'pipelines:run:p-1' });
    expect(history('ana-s')).toHaveLength(0);
  });

  it('a revocation during the history policy call returns no history', async () => {
    const { act, contexts, of } = setup();
    contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    await publishPipelineRunMove({ id: 'r1', status: 'failed' });
    duringPolicy = () => { users.get('pat')!.grants = { orgiq: ['member'] }; };
    await act.handleAction('pat-s', 'getHistory', { channelId: 'pipelines:run:r1' });
    expect(of('pat-s', 'activity').filter(f => f['action'] === 'history' && (f['events'] as unknown[]).length > 0)).toHaveLength(0);
  });

  it('fails closed on a router that cannot check channels', async () => {
    const sent: Msg[] = [];
    const bare = {
      sendToClient: (_: string, m: Msg) => { sent.push(m); return true; },
      sendToChannel: async () => undefined, subscribeToChannel: async () => true, unsubscribeFromChannel: () => undefined,
    };
    const act = tenantActivity().create({ router: bare as never, logger });
    await publishChannelActivity('orgiq:initiative:p-1', 'work-item.status');
    await act.handleAction('x', 'getHistory', { channelId: 'orgiq:initiative:p-1' });
    expect(sent.filter(m => m['action'] === 'history' && (m['events'] as unknown[]).length > 0)).toHaveLength(0);
  });

  it('producers never write a channel outside the families (no shared ring keys, no firehose)', async () => {
    const { act, contexts, sent } = setup();
    contexts.set('mia-s', ctxOf('mia', 'orgiq', 'member'));
    for (const channel of ['activity:broadcast', 'pipeline:all', 'pipeline:approvals', 'social:ch:general', 'orgiq:made-up:1', 'orgiq:initiative:a b']) {
      await publishChannelActivity(channel, 'x', { leaked: true });
    }
    await act.handleAction('mia-s', 'getHistory', { channelId: 'orgiq:made-up:1' });
    expect(sent.filter(s => s.message['type'] === 'activity:event')).toHaveLength(0);
    expect(sent.filter(s => s.message['action'] === 'history' && (s.message['events'] as unknown[]).length > 0)).toHaveLength(0);
  });

  it('orgiq:initiative rows reach exactly the readers the initiative REST gate admits', async () => {
    const { act, contexts, of } = setup();
    contexts.set('mia-s', ctxOf('mia', 'orgiq', 'member'));      // active orgiq: REST 200
    contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor')); // orgiq grant, active assessment: REST 403
    for (const id of ['mia-s', 'ana-s']) await act.handleAction(id, 'subscribe', { channelId: 'orgiq:initiative:p-1' });
    await publishChannelActivity('orgiq:initiative:p-1', 'work-item.assigned', { workItemId: 'w1', title: 'T' });
    expect(of('mia-s', 'activity:event')).toHaveLength(1);
    expect(of('ana-s', 'activity:event')).toHaveLength(0);
    // Mia loses her orgiq seat: the next row is withheld.
    users.get('mia')!.grants = { social: ['participant'] };
    await publishChannelActivity('orgiq:initiative:p-1', 'work-item.status', { to: 'done' });
    expect(of('mia-s', 'activity:event')).toHaveLength(1);
  });
});

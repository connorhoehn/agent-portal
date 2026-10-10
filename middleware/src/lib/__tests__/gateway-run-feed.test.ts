// Library activity/pipeline features under the tenant channel families:
// admission goes through the real authorizeLiveGatewayChannel and the real
// channelGuard; the router is a fake that records what reaches each client.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { authorizeLiveGatewayChannel } from '../live-principal.js';
import { channelGuard, stripServicePrefix } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import {
  pipelineFamilyChannel, publishChannelActivity, publishPipelineRunMove, resetGatewayRunFeed, tenantActivity, tenantPipeline,
} from '../gateway-run-feed.js';

const POLICY: Record<string, string[]> = { member: [], author: ['ViewPipelines'] };
let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctxOf = (userId: string, org: string, role: string) =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });

type Sent = { to: string; message: Record<string, unknown> };
function fakeRouter() {
  const contexts = new Map<string, ReturnType<typeof ctxOf>>();
  const members = new Map<string, Set<string>>();
  const sent: Sent[] = [];
  const router = {
    sent, contexts,
    sendToClient: (to: string, message: Record<string, unknown>) => { sent.push({ to, message }); return true; },
    sendToChannel: async (channel: string, message: Record<string, unknown>) => {
      for (const to of members.get(channel) ?? []) sent.push({ to, message });
    },
    checkChannel: (kind: 'subscribe' | 'publish', clientId: string, channel: string) =>
      authorizeLiveGatewayChannel({ kind, clientId, channel, ctx: contexts.get(clientId) ?? null }, { guard: channelGuard, baseChannel: stripServicePrefix }),
    subscribeToChannel: async (clientId: string, channel: string) => {
      if (!await router.checkChannel('subscribe', clientId, channel)) return false;
      const set = members.get(channel) ?? new Set<string>(); set.add(clientId); members.set(channel, set); return true;
    },
    unsubscribeFromChannel: (clientId: string, channel: string) => { members.get(channel)?.delete(clientId); },
    members,
  };
  return router;
}
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const frames = (r: ReturnType<typeof fakeRouter>, to: string, type: string) => r.sent.filter(s => s.to === to && s.message['type'] === type).map(s => s.message);

beforeEach(() => {
  resetGatewayRunFeed();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([['mia', user('mia', { orgiq: ['member'] })], ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })]]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => (POLICY[p.role] ?? []).includes(a));
});
afterEach(() => jest.clearAllMocks());

describe('pipeline wire channels', () => {
  it('maps only per-run names onto the pipelines:run family', () => {
    expect(pipelineFamilyChannel('pipeline:run:job:42')).toBe('pipelines:run:job:42');
    for (const bad of ['pipeline:all', 'pipeline:approvals', 'pipeline:run:', 'pipeline:run:a b', 'pipelines:run:x', 7, undefined]) expect(pipelineFamilyChannel(bad)).toBeNull();
  });

  it('admits a pipelines author, refuses a cross-tenant member and the firehoses, and delivers run events', async () => {
    const router = fakeRouter();
    const service = tenantPipeline().create({ router: router as never, logger });
    router.contexts.set('pat-socket', ctxOf('pat', 'pipelines', 'author'));
    router.contexts.set('mia-socket', ctxOf('mia', 'orgiq', 'member'));
    for (const id of ['pat-socket', 'mia-socket']) {
      await service.handleAction(id, 'subscribe', { channel: 'pipeline:run:job:42' });
      await service.handleAction(id, 'subscribe', { channel: 'pipeline:all' });
      await service.handleAction(id, 'subscribe', { channel: 'pipeline:approvals' });
    }
    expect([...(router.members.get('pipelines:run:job:42') ?? [])]).toEqual(['pat-socket']);
    expect(router.members.has('pipeline:all')).toBe(false);
    expect(frames(router, 'pat-socket', 'pipeline').map(f => f['channel'])).toEqual(['pipeline:run:job:42']);

    await publishPipelineRunMove({ id: 'job:42', status: 'completed' });
    const got = frames(router, 'pat-socket', 'pipeline:event');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ eventType: 'pipeline:run:completed', channel: 'pipelines:run:job:42', payload: { runId: 'job:42', status: 'completed' } });
    expect(frames(router, 'mia-socket', 'pipeline:event')).toHaveLength(0);

    await service.handleAction('pat-socket', 'unsubscribe', { channel: 'pipeline:run:job:42' });
    await publishPipelineRunMove({ id: 'job:42', status: 'failed', error: 'boom' });
    expect(frames(router, 'pat-socket', 'pipeline:event')).toHaveLength(1);
  });

  it('a cancelled run reads as a failure to the client hook', async () => {
    const router = fakeRouter();
    const service = tenantPipeline().create({ router: router as never, logger });
    tenantActivity().create({ router: router as never, logger });
    router.contexts.set('s', ctxOf('pat', 'pipelines', 'author'));
    await service.handleAction('s', 'subscribe', { channel: 'pipeline:run:r1' });
    await publishPipelineRunMove({ id: 'r1', status: 'cancelled' });
    expect(frames(router, 's', 'pipeline:event')[0]).toMatchObject({ payload: { status: 'cancelled', error: 'Cancelled' } });
  });
});

describe('activity', () => {
  it('delivers a server row to members of the channel, never to another tenant, and never to an unknown channel', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctxOf('mia', 'orgiq', 'member'));
    router.contexts.set('pat-pipelines', ctxOf('pat', 'pipelines', 'author'));
    await service.handleAction('mia-socket', 'subscribe', { channelId: 'orgiq:initiative:p-soc2', channel: 'orgiq:initiative:p-soc2' });
    await service.handleAction('pat-pipelines', 'subscribe', { channelId: 'orgiq:initiative:p-soc2' });
    await service.handleAction('mia-socket', 'subscribe', { channelId: 'orgiq:made-up:1' });
    expect(router.members.get('orgiq:initiative:p-soc2')).toEqual(new Set(['mia-socket']));
    expect(router.members.has('orgiq:made-up:1')).toBe(false);

    await publishChannelActivity('orgiq:initiative:p-soc2', 'work-item.status', { to: 'done' }, { userId: 'mia' });
    const rows = frames(router, 'mia-socket', 'activity:event');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'orgiq:initiative:p-soc2', payload: { eventType: 'work-item.status', userId: 'mia' } });
    expect(frames(router, 'pat-pipelines', 'activity:event')).toHaveLength(0);

    await publishChannelActivity('orgiq:made-up:1', 'x'); // no family names it: not produced at all
    expect(frames(router, 'mia-socket', 'activity:event')).toHaveLength(1);
  });

  it('refuses client publishes, serves history only to a channel reader, and never the global broadcast', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctxOf('mia', 'orgiq', 'member'));
    router.contexts.set('pat-pipelines', ctxOf('pat', 'pipelines', 'author'));
    await publishChannelActivity('orgiq:initiative:p-soc2', 'work-item.assigned', { n: 1 });

    await service.handleAction('mia-socket', 'publish', { event: { eventType: 'forged' } });
    expect(router.sent.at(-1)?.message).toMatchObject({ type: 'error', service: 'activity' });

    await service.handleAction('mia-socket', 'getHistory', { channelId: 'orgiq:initiative:p-soc2' });
    expect(frames(router, 'mia-socket', 'activity')[0]).toMatchObject({ action: 'history', events: [{ eventType: 'work-item.assigned' }] });

    const before = router.sent.length;
    await service.handleAction('pat-pipelines', 'getHistory', { channelId: 'orgiq:initiative:p-soc2' });
    await service.handleAction('mia-socket', 'getHistory', { channelId: 'activity:broadcast' });
    await service.handleAction('mia-socket', 'getHistory', {});
    // Refusals answer an empty history frame (0.107); no events reach the caller.
    expect(router.sent.slice(before).filter(s => (s.message['events'] as unknown[] | undefined)?.length)).toHaveLength(0);

    await service.onClientConnect?.('mia-socket');
    expect(router.members.has('activity:broadcast')).toBe(false);
  });
});

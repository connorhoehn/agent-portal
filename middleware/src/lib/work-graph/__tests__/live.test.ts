// The work graph's live hint (lib/work-graph/live.ts) on the dedicated
// default-deny family `orgiq:workgraph` (lib/tenant-channels.ts), through the
// real admitChannel + channelGuard and the library activity()
// feature over a recording router.
//
// Pinned: an orgiq reader may hold the plain subscribe; nothing else is offered
// on the name (no publish, presence, reactions, lobby, no id suffix, no other
// tenant); the hint carries only the initiative id and a cause; a bot run's
// move resolves its initiative through the row.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../../providers/identity.js', () => ({ ...jest.requireActual('../../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../../providers/identity.js';
import { isAllowed } from '../../authz.js';

import { channelGuard, lobbyGuard } from '../../realtime-gateway.js';
import { baseChannel } from '@connorhoehn/realtime-modules/server';
import { tenantChannelFamily } from '../../tenant-channels.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../../social-chat.js';
import { resetGatewayRunFeed, tenantActivity } from '../../gateway-run-feed.js';
import {
  PIPELINES_WORK_GRAPH_CHANNEL, notifyPipelinesWorkGraphChanged, pipelinesHintForJobChange, pipelinesHintForFlowRunMove, pipelinesHintForRunChange,
  ASSESSMENT_WORK_GRAPH_CHANNEL, notifyAssessmentWorkGraphChanged, assessmentHintForFlowRunMove, assessmentHintForBrokerEvent,
  WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, hintForRunChange, hintForFlowRunMove, hintForJobChange, notifyWorkGraphChanged, stopWorkGraphLiveHints } from '../live.js';
import { listBots } from '../../../providers/bots.js';
import { flowRunsFixture } from '../../../mock/flow-runs.js';
import { admitChannel } from '../../gateway/authority.js';

let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctx = (userId: string, org: string, role: string) =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const guards = { guard: channelGuard, baseChannel };
const authorize = (c: ReturnType<typeof ctx>, channel: string, kind: 'subscribe' | 'publish' = 'subscribe') =>
  admitChannel({ kind, clientId: 'socket', channel, ctx: c });

type Sent = { to: string; message: Record<string, unknown> };
function fakeRouter() {
  const contexts = new Map<string, ReturnType<typeof ctx>>();
  const members = new Map<string, Set<string>>();
  const sent: Sent[] = [];
  const router = {
    sent, contexts, members,
    sendToClient: (to: string, message: Record<string, unknown>) => { sent.push({ to, message }); return true; },
    sendToChannel: async (channel: string, message: Record<string, unknown>) => { for (const to of members.get(channel) ?? []) sent.push({ to, message }); },
    checkChannel: (kind: 'subscribe' | 'publish', clientId: string, channel: string) =>
      admitChannel({ kind, clientId, channel, ctx: contexts.get(clientId) ?? null }),
    subscribeToChannel: async (clientId: string, channel: string) => {
      if (!await router.checkChannel('subscribe', clientId, channel)) return false;
      const set = members.get(channel) ?? new Set<string>(); set.add(clientId); members.set(channel, set); return true;
    },
    unsubscribeFromChannel: (clientId: string, channel: string) => { members.get(channel)?.delete(clientId); },
  };
  return router;
}
const logger = { debug() {}, info() {}, warn() {}, error() {} };

beforeAll(() => stopWorkGraphLiveHints());
beforeEach(() => {
  resetGatewayRunFeed();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['mia', user('mia', { orgiq: ['member'] })],
    ['sam', user('sam', { orgiq: ['sme'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['ines', user('ines', { pipelines: ['author'] })],
    ['ana', user('ana', { assessment: ['assessor'] })],
    ['blind', user('blind', { assessment: ['blind'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (p.role === 'sme' && action === 'DispatchAgentRun') || (p.role === 'author' && action === 'ViewPipelines') || (p.role === 'assessor' && action === 'ViewAssessment'));
});
afterEach(() => jest.clearAllMocks());

describe('orgiq:workgraph family (default deny)', () => {
  it('admits only the plain subscribe of an orgiq session', async () => {
    expect(tenantChannelFamily(WORK_GRAPH_CHANNEL)?.id).toBe('orgiq:workgraph');
    expect(await authorize(ctx('mia', 'orgiq', 'member'), WORK_GRAPH_CHANNEL)).toBe(true);
    expect(await authorize(ctx('sam', 'orgiq', 'sme'), WORK_GRAPH_CHANNEL)).toBe(true);
  });
  it('refuses every publish, every other service, a lobby and any suffixed name', async () => {
    for (const who of [ctx('mia', 'orgiq', 'member'), ctx('sam', 'orgiq', 'sme')]) {
      expect(await authorize(who, WORK_GRAPH_CHANNEL, 'publish')).toBe(false);
      for (const service of ['presence', 'reactions', 'cursor']) {
        expect(await authorize(who, `${service}:${WORK_GRAPH_CHANNEL}`)).toBe(false);
        expect(await authorize(who, `${service}:${WORK_GRAPH_CHANNEL}`, 'publish')).toBe(false);
      }
      for (const name of ['orgiq:workgraph:p-soc2', 'orgiq:workgraphs', 'orgiq:workgraph:']) expect(await authorize(who, name)).toBe(false);
    }
    expect(lobbyGuard({ userId: 'sam', org: 'orgiq', tenants: ['orgiq'] }, WORK_GRAPH_CHANNEL)).toBe(false);
  });
  it('refuses another tenant’s session, even one holding an orgiq grant', async () => {
    expect(await authorize(ctx('pat', 'pipelines', 'author'), WORK_GRAPH_CHANNEL)).toBe(false);
    users.set('ext', user('ext', { pipelines: ['author'] }));
    expect(await authorize(ctx('ext', 'pipelines', 'author'), WORK_GRAPH_CHANNEL)).toBe(false);
  });
});

describe('the hint', () => {
  it('reaches orgiq subscribers only, carrying the initiative id and cause and nothing else', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctx('mia', 'orgiq', 'member'));
    router.contexts.set('pat-socket', ctx('pat', 'pipelines', 'author'));
    await service.handleAction('mia-socket', 'subscribe', { channelId: WORK_GRAPH_CHANNEL });
    await service.handleAction('pat-socket', 'subscribe', { channelId: WORK_GRAPH_CHANNEL });
    expect([...(router.members.get(WORK_GRAPH_CHANNEL) ?? [])]).toEqual(['mia-socket']);

    await notifyWorkGraphChanged('p-auth-migration', 'work-item');
    const frames = router.sent.filter(s => s.message['type'] === 'activity:event');
    expect(frames.map(f => f.to)).toEqual(['mia-socket']);
    expect(frames[0]!.message).toMatchObject({ channel: WORK_GRAPH_CHANNEL, payload: { eventType: WORK_GRAPH_HINT, detail: { initiativeId: 'p-auth-migration', cause: 'work-item' } } });
    expect(Object.keys((frames[0]!.message['payload'] as { detail: object }).detail).sort()).toEqual(['cause', 'initiativeId']);

    // A client cannot publish onto it.
    await service.handleAction('mia-socket', 'publish', { channelId: WORK_GRAPH_CHANNEL, event: { eventType: 'work-graph.changed' } });
    expect(router.sent.filter(s => s.message['type'] === 'activity:event')).toHaveLength(1);
  });

  it('resolves a bot run move to its initiative through the bot row', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctx('mia', 'orgiq', 'member'));
    await service.handleAction('mia-socket', 'subscribe', { channelId: WORK_GRAPH_CHANNEL });
    const bot = (await listBots()).find(b => b.orgProjectId === 'p-auth-migration')!;
    await hintForRunChange({ runId: 'r-1', botId: bot.id, workItemId: null });
    await hintForRunChange({ runId: 'r-2', botId: null, workItemId: null });
    const details = router.sent.filter(s => s.message['type'] === 'activity:event').map(s => (s.message['payload'] as { detail: unknown }).detail);
    expect(details).toEqual([{ initiativeId: 'p-auth-migration', cause: 'run' }, { cause: 'run' }]);
  });

  it('hints an orgiq flow run move with its initiative, content-free, and nothing for another tenant\u2019s run', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctx('mia', 'orgiq', 'member'));
    await service.handleAction('mia-socket', 'subscribe', { channelId: WORK_GRAPH_CHANNEL });
    const base = { kind: 'orgiq.summarize', requestedBy: 'mia', status: 'running', progress: [], input: { text: 'private' }, result: null, meta: {}, error: null,
      attempts: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z', finishedAt: null };
    flowRunsFixture.rows().push(
      { ...base, id: 'osm-1', tenant: 'orgiq', scope: 'orgiq:initiative:p-auth-migration' } as never,
      { ...base, id: 'osm-2', tenant: 'orgiq', scope: 'orgiq:session:s-1' } as never,
      { ...base, id: 'sum-3', tenant: 'social', scope: 'social:ch:general' } as never,
    );
    for (const runId of ['osm-1', 'osm-2', 'sum-3', 'nope']) await hintForFlowRunMove({ runId, kind: 'progress' });
    const details = router.sent.filter(s => s.message['type'] === 'activity:event').map(s => (s.message['payload'] as { detail: unknown }).detail);
    expect(details).toEqual([{ initiativeId: 'p-auth-migration', cause: 'flow-run' }, { cause: 'flow-run' }]);
    flowRunsFixture.reset();
  });
  it('hints a job status change with its initiative and nothing from the payload (no prompt, no title)', async () => {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('mia-socket', ctx('mia', 'orgiq', 'member'));
    await service.handleAction('mia-socket', 'subscribe', { channelId: WORK_GRAPH_CHANNEL });
    const at = '2026-10-06T12:00:00.000Z';
    await hintForJobChange({ jobId: 'j-1', boxId: null, status: 'claimed', title: 'Secret title', payload: { prompt: 'secret prompt', initiativeId: 'p-auth-migration' }, at });
    await hintForJobChange({ jobId: 'j-2', boxId: null, status: 'running', title: 't', payload: {}, at });
    const details = router.sent.filter(s => s.message['type'] === 'activity:event').map(s => (s.message['payload'] as { detail: unknown }).detail);
    expect(details).toEqual([{ initiativeId: 'p-auth-migration', cause: 'job' }, { cause: 'job' }]);
    expect(JSON.stringify(router.sent)).not.toMatch(/secret/i);
  });
});

describe('pipelines:workgraph family (default deny)', () => {
  const run = 'pipelines:workgraph:run:job:job-1';
  it('admits only the plain subscribe of a ViewPipelines session on the workspace and run names', async () => {
    expect(tenantChannelFamily(PIPELINES_WORK_GRAPH_CHANNEL)?.id).toBe('pipelines:workgraph');
    expect(tenantChannelFamily(run)?.id).toBe('pipelines:workgraph');
    for (const name of [PIPELINES_WORK_GRAPH_CHANNEL, 'pipelines:workgraph:workspace', run]) {
      expect(await authorize(ctx('ines', 'pipelines', 'author'), name)).toBe(true);
      expect(await authorize(ctx('ines', 'pipelines', 'author'), name, 'publish')).toBe(false);
      expect(await authorize(ctx('ines', 'pipelines', 'author'), `presence:${name}`)).toBe(false);
      expect(await authorize(ctx('mia', 'orgiq', 'member'), name)).toBe(false);
      expect(await authorize(ctx('pat', 'orgiq', 'member'), name)).toBe(false);
    }
    for (const name of ['pipelines:workgraph:', 'pipelines:workgraphs', 'pipelines:workgraph:run:', 'pipelines:workgraph:run:a b', 'pipelines:workgraph:initiative:x', 'pipelines:workgraph:workspace:x']) {
      expect(await authorize(ctx('ines', 'pipelines', 'author'), name)).toBe(false);
    }
    expect(lobbyGuard({ userId: 'ines', org: 'pipelines', tenants: ['pipelines'] }, PIPELINES_WORK_GRAPH_CHANNEL)).toBe(false);
    // An orgiq name is not reachable from the pipelines family and vice versa.
    expect(await authorize(ctx('ines', 'pipelines', 'author'), WORK_GRAPH_CHANNEL)).toBe(false);
  });
});

describe('the pipelines hint', () => {
  async function subscribed() {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('ines-socket', ctx('ines', 'pipelines', 'author'));
    router.contexts.set('mia-socket', ctx('mia', 'orgiq', 'member'));
    await service.handleAction('ines-socket', 'subscribe', { channelId: PIPELINES_WORK_GRAPH_CHANNEL });
    await service.handleAction('mia-socket', 'subscribe', { channelId: PIPELINES_WORK_GRAPH_CHANNEL });
    expect([...(router.members.get(PIPELINES_WORK_GRAPH_CHANNEL) ?? [])]).toEqual(['ines-socket']);
    return router;
  }
  const details = (router: ReturnType<typeof fakeRouter>) =>
    router.sent.filter(s => s.message['type'] === 'activity:event').map(s => (s.message['payload'] as { detail: unknown }).detail);

  it('reaches pipelines subscribers only, carrying a run id and a cause and nothing else', async () => {
    const router = await subscribed();
    await notifyPipelinesWorkGraphChanged('job:j-1', 'run');
    await notifyPipelinesWorkGraphChanged(null, 'deck');
    expect(details(router)).toEqual([{ runId: 'job:j-1', cause: 'run' }, { cause: 'deck' }]);
    expect(router.sent.every(s => s.to === 'ines-socket')).toBe(true);
  });

  it('hints a job change with its projected run id (an awaiting_review job as an approval) and no payload', async () => {
    const router = await subscribed();
    const at = '2026-10-06T12:00:00.000Z';
    await pipelinesHintForJobChange({ jobId: 'j-1', boxId: null, status: 'running', title: 'Secret title', payload: { prompt: 'secret prompt' }, at });
    await pipelinesHintForJobChange({ jobId: 'j-1', boxId: null, status: 'awaiting_review', title: 'Secret title', payload: { prompt: 'secret prompt' }, at });
    await pipelinesHintForRunChange();
    expect(details(router)).toEqual([{ runId: 'job:j-1', cause: 'job' }, { runId: 'job:j-1', cause: 'approval' }, { cause: 'run' }]);
    expect(JSON.stringify(router.sent)).not.toMatch(/secret/i);
  });

  it('hints a pipelines flow run move with the run its conversation names, and nothing for another tenant\u2019s run', async () => {
    const router = await subscribed();
    const base = { kind: 'pipelines.summarize', requestedBy: 'ines', status: 'running', progress: [], input: { text: 'private' }, result: null, meta: {}, error: null,
      attempts: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z', finishedAt: null };
    flowRunsFixture.rows().push(
      { ...base, id: 'psm-1', tenant: 'pipelines', scope: 'pipelines:run:job:j-1' } as never,
      { ...base, id: 'psm-2', tenant: 'pipelines', scope: 'pipelines:def:d-1' } as never,
      { ...base, id: 'osm-3', tenant: 'orgiq', scope: 'orgiq:initiative:p-auth-migration' } as never,
    );
    for (const runId of ['psm-1', 'psm-2', 'osm-3', 'nope']) await pipelinesHintForFlowRunMove({ runId, kind: 'progress' });
    expect(details(router)).toEqual([{ runId: 'job:j-1', cause: 'flow-run' }, { cause: 'flow-run' }]);
    flowRunsFixture.reset();
  });
});

describe('assessment:workgraph family (default deny)', () => {
  const team = 'assessment:workgraph:team:TEAM-001';
  it('admits only the plain subscribe of a ViewAssessment session on the workspace and team names', async () => {
    expect(tenantChannelFamily(ASSESSMENT_WORK_GRAPH_CHANNEL)?.id).toBe('assessment:workgraph');
    expect(tenantChannelFamily(team)?.id).toBe('assessment:workgraph');
    for (const name of [ASSESSMENT_WORK_GRAPH_CHANNEL, 'assessment:workgraph:workspace', team]) {
      expect(await authorize(ctx('ana', 'assessment', 'assessor'), name)).toBe(true);
      expect(await authorize(ctx('ana', 'assessment', 'assessor'), name, 'publish')).toBe(false);
      expect(await authorize(ctx('ana', 'assessment', 'assessor'), `presence:${name}`)).toBe(false);
      expect(await authorize(ctx('blind', 'assessment', 'blind'), name)).toBe(false);
      expect(await authorize(ctx('ines', 'pipelines', 'author'), name)).toBe(false);
      expect(await authorize(ctx('mia', 'orgiq', 'member'), name)).toBe(false);
    }
    for (const name of ['assessment:workgraph:', 'assessment:workgraphs', 'assessment:workgraph:team:', 'assessment:workgraph:team:a b', 'assessment:workgraph:team:x-1',
      'assessment:workgraph:initiative:x', 'assessment:workgraph:workspace:x', 'assessment:workgraph:team:TEAM-1/../x']) {
      expect(await authorize(ctx('ana', 'assessment', 'assessor'), name)).toBe(false);
    }
    expect(lobbyGuard({ userId: 'ana', org: 'assessment', tenants: ['assessment'] }, ASSESSMENT_WORK_GRAPH_CHANNEL)).toBe(false);
    expect(await authorize(ctx('ana', 'assessment', 'assessor'), WORK_GRAPH_CHANNEL)).toBe(false);
  });
});

describe('the assessment hint', () => {
  async function subscribed() {
    const router = fakeRouter();
    const service = tenantActivity().create({ router: router as never, logger });
    router.contexts.set('ana-socket', ctx('ana', 'assessment', 'assessor'));
    router.contexts.set('ines-socket', ctx('ines', 'pipelines', 'author'));
    await service.handleAction('ana-socket', 'subscribe', { channelId: ASSESSMENT_WORK_GRAPH_CHANNEL });
    await service.handleAction('ines-socket', 'subscribe', { channelId: ASSESSMENT_WORK_GRAPH_CHANNEL });
    expect([...(router.members.get(ASSESSMENT_WORK_GRAPH_CHANNEL) ?? [])]).toEqual(['ana-socket']);
    return router;
  }
  const details = (router: ReturnType<typeof fakeRouter>) =>
    router.sent.filter(s => s.message['type'] === 'activity:event').map(s => (s.message['payload'] as { detail: unknown }).detail);

  it('reaches assessment readers only, carrying a team id and a cause and nothing else', async () => {
    const router = await subscribed();
    await notifyAssessmentWorkGraphChanged('TEAM-001', 'score');
    await notifyAssessmentWorkGraphChanged(null, 'deck');
    await notifyAssessmentWorkGraphChanged('not a team', 'evidence');
    expect(details(router)).toEqual([{ teamId: 'TEAM-001', cause: 'score' }, { cause: 'deck' }, { cause: 'evidence' }]);
    expect(router.sent.every(s => s.to === 'ana-socket')).toBe(true);
  });

  it('hints a draft move with its team (never the draft text), a conversation flow with its team channel, ledger events with their team, and nothing for another tenant', async () => {
    const router = await subscribed();
    const base = { requestedBy: 'ana', status: 'running', progress: [], input: { text: 'private' }, result: null, meta: {}, error: null,
      attempts: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z', finishedAt: null };
    flowRunsFixture.rows().push(
      { ...base, id: 'adr-1', tenant: 'assessment', kind: 'assessment.evidence-summary', scope: 'TEAM-001/2' } as never,
      { ...base, id: 'asm-2', tenant: 'assessment', kind: 'assessment.summarize', scope: 'assessment:team:TEAM-002' } as never,
      { ...base, id: 'asm-3', tenant: 'assessment', kind: 'assessment.summarize', scope: 'assessment:doc:page-1' } as never,
      { ...base, id: 'osm-4', tenant: 'orgiq', kind: 'orgiq.summarize', scope: 'orgiq:initiative:p-auth-migration' } as never,
    );
    for (const runId of ['adr-1', 'asm-2', 'asm-3', 'osm-4', 'nope']) await assessmentHintForFlowRunMove({ runId, kind: 'progress' });
    await assessmentHintForBrokerEvent({ type: 'run.started', team_id: 'TEAM-003' });
    expect(assessmentHintForBrokerEvent({ type: 'knowledge.pulled' })).toBeNull();
    expect(details(router)).toEqual([
      { teamId: 'TEAM-001', cause: 'draft' }, { teamId: 'TEAM-002', cause: 'flow-run' }, { cause: 'flow-run' }, { teamId: 'TEAM-003', cause: 'run' },
    ]);
    expect(JSON.stringify(router.sent)).not.toMatch(/private/);
    flowRunsFixture.reset();
  });
});

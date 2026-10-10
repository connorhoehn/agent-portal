// The work graph's live stream (lib/work-graph/stream.ts): realtime-modules
// 0.108 WorkGraphStreamService over a real LocalRealtimeRouter whose authorize
// is the gateway's live authority (live-principal + channelGuard), the mock
// fixtures behind the REST builder, and the library's own client reducer.
//
// Adversarial contracts:
//   * default deny — a non-reader, another tenant's session (even one holding
//     an orgiq grant), a forged context the directory does not back, a
//     malformed subject, a router that enforces nothing: all refused;
//   * per-viewer frames — a change is never sent; each subscriber's delta is
//     computed from ITS OWN rebuilt snapshot, so a member never receives a run
//     or bot an sme sees, and the reduced graph equals that viewer's REST
//     snapshot (and its view passes the library's v2 validator);
//   * revocation — a grant removed or epoch bumped mid-subscription gets a
//     content-free invalidate before any content is computed, and no frame
//     after; a policy change (Cedar) invalidates; the directory signal does it
//     without waiting for a data change;
//   * catch-up from the snapshot cursor, access-restored placeholders, peers.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../../providers/identity.js', () => ({ ...jest.requireActual('../../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../live-principal.js', () => ({ ...jest.requireActual('../../live-principal.js'), authorizeConversationChat: jest.fn(async () => true) }));
import { LocalRealtimeRouter, WorkGraphStreamService, baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { workDayWindow, validateWorkGraphSnapshotV2, type WorkGraphSnapshotV2 } from '@connorhoehnslalom/realtime-modules/work-graph';
import { applyWorkGraphSnapshotV2, createClientWorkGraphState, reduceWorkGraphStream, type ClientWorkGraphState } from '@connorhoehnslalom/realtime-modules/client';
import { getUser, type UserInfo } from '../../../providers/identity.js';
import { isAllowed } from '../../authz.js';
import { authorizeLiveGatewayChannel } from '../../live-principal.js';
import { channelGuard } from '../../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../../social-chat.js';
import { clock, freezeClock, unfreezeClock } from '../../../mock/core/index.js';
import type { Session } from '../../session.js';
import { createWorkItem, getProjectWorkItems } from '../../../providers/work-items.js';
import { createBotRun, listBots, __resetMockRuns } from '../../../providers/bots.js';
import { enqueueJob, completeJob, cancelJob } from '../../../providers/agent-jobs.js';
import { agentJobs } from '../../../mock/agent-jobs.js';
import { buildAssessmentViewerWorkGraph, buildPipelinesViewerWorkGraph, buildSocialViewerWorkGraph } from '../build.js';
import { observeCall, observeCallEnded, resetObservedCalls } from '../social-events.js';
import { socialChat } from '../../social-chat.js';
import { applyScores, uploadEvidence } from '../../../providers/assessment.js';
import { flowRunStore } from '../../flow-runs/index.js';
import { SUMMARY_KIND } from '../../assessment-drafts.js';
import type { AssessmentWorkGraphSubject, PipelinesWorkGraphSubject, SocialWorkGraphSubject } from '../snapshot.js';
import { stopWorkGraphLiveHints } from '../live.js';
import { buildViewerWorkGraph, rememberServedWorkGraph, resetServedWorkGraphs } from '../build.js';
import { parseWorkGraphQuery } from '../snapshot.js';
import { createOrgiqWorkGraphStream, publishWorkGraphChange, signalWorkGraphAccess, type OrgiqWorkGraphStream } from '../stream.js';
import type { WorkGraphSubject } from '../sources.js';

type Msg = Record<string, unknown>;
const TZ = 'UTC';
const INIT = 'p-auth-migration';
const POLICY: Record<string, string[]> = { member: [], sme: ['ManageBots', 'DispatchAgentRun'], author: ['ViewPipelines'], operator: ['ViewPipelines', 'ApproveStep'],
  assessor: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent'], readonly: ['ViewAssessment'], participant: ['ViewSocial', 'PostMessage', 'StartCall'] };
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(clock.now());
const activity = () => { const w = workDayWindow(day(), TZ); return { schemaVersion: 2 as const, windowStart: w.start, windowEnd: w.end, mode: 'live' as const }; };
let users: Map<string, UserInfo>;
let cedar: Record<string, string[]>;

const grant = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctxOf = (userId: string, org: string, role: string): Msg =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, displayName: userId, tenants: Object.keys(users.get(userId)?.grants ?? { [org]: [role] }) });
const sessionOf = (userId: string, role: string): Session =>
  ({ sub: userId, tenant: 'orgiq', role, epoch: users.get(userId)!.epoch, iat: 1, grants: structuredClone(users.get(userId)!.grants) } as Session);

beforeAll(() => stopWorkGraphLiveHints());
beforeEach(() => {
  // The mock seed re-projects its stamps against the clock; frozen, a rebuild
  // of an unchanged graph is byte-identical (as it is on a real cluster).
  freezeClock(new Date(Math.floor(Date.now() / 1000) * 1000));
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  resetServedWorkGraphs(); __resetMockRuns(); agentJobs.reset();
  cedar = structuredClone(POLICY);
  users = new Map([
    ['theo', grant('theo', { orgiq: ['member'] })],
    ['nora', grant('nora', { orgiq: ['sme'] })],
    ['pat', grant('pat', { orgiq: ['member'], pipelines: ['author'] })],
    ['ines', grant('ines', { pipelines: ['author'] })],
    ['kofi', grant('kofi', { pipelines: ['operator'] })],
    ['ana', grant('ana', { assessment: ['assessor'] })],
    ['rob', grant('rob', { assessment: ['readonly'] })],
    ['sara', grant('sara', { social: ['participant'] })],
    ['sam', grant('sam', { social: ['participant'] })],
    ['hank', grant('hank', {})],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (cedar[p.role] ?? []).includes(action));
});
afterEach(() => { setSocialChatBackend(null); unfreezeClock(); });

function setup(opts: { authorize?: boolean; feature?: 'none' } = {}) {
  const contexts = new Map<string, Msg>();
  const sent: Array<{ to: string; message: Msg }> = [];
  const stream = createOrgiqWorkGraphStream();
  const router = new LocalRealtimeRouter({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...(opts.authorize === false ? {} : {
      authorize: ({ kind, clientId, channel, ctx, scope }) =>
        authorizeLiveGatewayChannel({ kind, clientId, channel, ctx: ctx as Msg | null, ...(scope ? { scope } : {}) }, { guard: channelGuard, baseChannel }),
    }),
    plugins: [stream.plugin],
  });
  router._setHandle({
    getClientContext: (id: string) => contexts.get(id) ?? null,
    sendToClient: (to: string, message: Msg) => { sent.push({ to, message }); return true; },
    listClients: () => [...contexts.keys()],
  } as never);
  const service = new WorkGraphStreamService({ messageRouter: router,
    config: opts.feature === 'none' ? {} : { channelFor: stream.channelFor, source: stream.source } });
  const stop = stream.attach(service, null);
  const of = (to: string) => sent.filter(s => s.to === to).map(s => s.message);
  return {
    router, service, stream, contexts, sent, stop,
    frames: (to: string) => of(to).filter(m => m['type'] === 'work-graph' && m['action'] === 'message').map(m => m['message'] as Msg),
    acks: (to: string) => of(to).filter(m => m['type'] === 'work-graph' || m['type'] === 'error').map(m => String(m['action'] ?? m['code'])),
  };
}
type Env = ReturnType<typeof setup>;

async function restSnapshot(userId: string, role: string, subject: WorkGraphSubject = { kind: 'initiative', id: INIT }): Promise<WorkGraphSnapshotV2> {
  const a = activity();
  const query = parseWorkGraphQuery({ day: day(), timezone: TZ, schemaVersion: '2', windowStart: a.windowStart, windowEnd: a.windowEnd, mode: a.mode });
  const built = await buildViewerWorkGraph(sessionOf(userId, role), subject, query);
  rememberServedWorkGraph(userId, built!.snapshot);
  return built!.snapshot as WorkGraphSnapshotV2;
}
async function subscribe(env: Env, clientId: string, generation: string, personId: string, cursor?: string): Promise<void> {
  await env.service.handleAction(clientId, 'subscribe', {
    subscriptionGeneration: generation, scope: { personId, day: day(), timezone: TZ },
    ...(cursor === undefined ? { awaitAccess: 1 } : { cursor, activity: activity(), viewPatch: 1 }),
  });
}
/** The reader's own state: its REST snapshot, then every delta it was sent (as useWorkGraph applies them). */
function reader(snapshot: WorkGraphSnapshotV2, generation: string): { state: ClientWorkGraphState; apply(frames: Msg[]): void } {
  const scope = { personId: snapshot.scope.personId, day: snapshot.scope.day, timezone: snapshot.scope.timezone };
  const self = {
    state: applyWorkGraphSnapshotV2(createClientWorkGraphState(scope, generation), snapshot, { scope, subscriptionGeneration: generation }),
    apply(frames: Msg[]) {
      for (const frame of frames) {
        expect(frame['kind']).toBe('delta');
        const { view, schemaVersion, ...rest } = frame['batch'] as Msg;
        expect(schemaVersion).toBe(2);
        self.state = reduceWorkGraphStream(self.state, { kind: 'delta', batch: { ...rest, schemaVersion: 1 } } as never);
        expect(self.state.status === 'ready' || self.state.status === 'partial').toBe(true);
        // useWorkGraph's own check of a v2 delta's view against the reduced graph.
        const v = view as Msg;
        const valid = validateWorkGraphSnapshotV2({
          schemaVersion: 2, scope: { ...scope, policyRevision: rest['policyRevision'] },
          revision: rest['watermark'], watermark: rest['watermark'], cursor: rest['cursor'],
          nodes: Object.values(self.state.nodes), edges: Object.values(self.state.edges), sources: Object.values(self.state.sources),
          partial: self.state.status === 'partial', ...v,
        });
        expect(valid.ok ? 'ok' : valid.errors).toBe('ok');
      }
    },
  };
  return self;
}
const ids = (state: { nodes: Record<string, unknown> | Array<{ id: string }> }) =>
  (Array.isArray(state.nodes) ? state.nodes.map(n => n.id) : Object.keys(state.nodes)).sort();
const edgeIds = (state: { edges: Record<string, unknown> | Array<{ id: string }> }) =>
  (Array.isArray(state.edges) ? state.edges.map(e => e.id) : Object.keys(state.edges)).sort();
const frameIds = (frames: Msg[]) => frames.flatMap(f => ((f['batch'] as { operations?: Array<Msg> })?.operations ?? [])
  .map(op => String((op['node'] as Msg | undefined)?.['id'] ?? (op['edge'] as Msg | undefined)?.['id'] ?? op['nodeId'] ?? op['edgeId'] ?? '')));
async function newItem(title: string) {
  return createWorkItem({ projectId: INIT, type: 'story', title, status: 'in_progress' as never });
}
async function newRun() {
  const bot = (await listBots()).find(b => b.orgProjectId === INIT)!;
  return createBotRun({ botId: bot.id, trigger: 'manual' });
}

describe('default deny', () => {
  it('admits an orgiq reader and refuses another tenant’s session, a forged context and malformed subjects', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('hank-s', { ...ctxOf('hank', 'orgiq', 'member'), tenants: ['orgiq'] });
    const snap = await restSnapshot('theo', 'member');
    await subscribe(env, 'theo-s', 'g1', `initiative:${INIT}`, snap.cursor);
    expect(env.acks('theo-s')).toEqual(['subscribed']);
    for (const who of ['pat-s', 'ines-s', 'sara-s', 'hank-s']) {
      await subscribe(env, who, 'g1', `initiative:${INIT}`, snap.cursor);
      await subscribe(env, who, 'g2', 'workspace', snap.cursor);
      expect(env.acks(who).filter(a => a !== 'AUTHZ_CHANNEL_DENIED')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED', 'WORK_GRAPH_SUBSCRIBE_REFUSED']);
    }
    // Another tenant's session is refused by channelFor before the router; the
    // forged orgiq context passes the shape and is refused by the router's
    // authorize against the directory (it holds no orgiq grant).
    expect(env.acks('pat-s')).not.toContain('AUTHZ_CHANNEL_DENIED');
    expect(env.acks('hank-s').filter(a => a === 'AUTHZ_CHANNEL_DENIED')).toHaveLength(2);
    for (const subject of ['initiative:../p-soc2', 'initiative:', 'person:a b', 'workgraph', 'org:p-1', `initiative:${INIT}:extra`]) {
      await subscribe(env, 'theo-s', `bad-${subject.length}`, subject, snap.cursor);
    }
    expect(env.acks('theo-s').filter(a => a === 'WORK_GRAPH_SUBSCRIBE_REFUSED')).toHaveLength(6);
    expect(env.stream.source.computed).toBe(1); // only theo's catch-up
    expect(env.service.getStats().subscriptions).toBe(1);
  });

  it('a feature with no channelFor/source, or a router with no authorize, refuses', async () => {
    for (const env of [setup({ feature: 'none' }), setup({ authorize: false })]) {
      env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
      await subscribe(env, 'theo-s', 'g1', `initiative:${INIT}`, 'owg2.1.orgiq.000000000000000000000000.00');
      expect(env.acks('theo-s')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED']);
      env.stop();
    }
  });

  it('clients never publish, and a chat publish onto the stream channel is refused', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    await env.service.handleAction('nora-s', 'publish', { channel: `orgiq:workgraph:initiative:${INIT}`, change: {} });
    expect(env.acks('nora-s')).toEqual(['WORK_GRAPH_BAD_REQUEST']);
    expect(await authorizeLiveGatewayChannel({ kind: 'publish', clientId: 'nora-s', channel: `orgiq:workgraph:initiative:${INIT}`,
      ctx: ctxOf('nora', 'orgiq', 'sme') }, { guard: channelGuard, baseChannel })).toBe(false);
  });
});

describe('per-viewer frames', () => {
  it('a run reaches the sme only; a work item reaches both; each reduced graph equals that viewer’s REST snapshot', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const theoSnap = await restSnapshot('theo', 'member');
    const noraSnap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, theoSnap.cursor);
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, noraSnap.cursor);
    expect(env.frames('theo-s')).toEqual([]); expect(env.frames('nora-s')).toEqual([]);
    const theo = reader(theoSnap, 'gt'), nora = reader(noraSnap, 'gn');

    const run = await newRun();
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'run' });
    expect(env.frames('theo-s')).toEqual([]);
    nora.apply(env.frames('nora-s'));
    expect(ids(nora.state)).toContain(`run:${run!.id}`);

    const item = await newItem('Stream contract story');
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'work-item' });
    theo.apply(env.frames('theo-s')); nora.apply(env.frames('nora-s').slice(1));
    expect(ids(theo.state)).toContain(`work:${item.id}`);
    // Nothing a member's REST snapshot withholds ever reached the member's socket.
    const all = env.sent.filter(s => s.to === 'theo-s').map(s => JSON.stringify(s.message)).join('\n');
    expect(all).not.toMatch(/"run:|"agent:/);
    expect(frameIds(env.frames('theo-s')).every(id => !id.startsWith('run:') && !id.startsWith('agent:'))).toBe(true);
    // Each reader now holds exactly what its own REST snapshot serves.
    for (const [who, role, view] of [['theo', 'member', theo], ['nora', 'sme', nora]] as const) {
      const fresh = await restSnapshot(who, role);
      expect(ids(view.state)).toEqual(ids(fresh)); expect(edgeIds(view.state)).toEqual(edgeIds(fresh));
      expect(view.state.policyRevision).toBe(fresh.scope.policyRevision);
    }
  });

  it('a change to another initiative computes nothing for this initiative’s readers', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const snap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, snap.cursor);
    const before = env.stream.source.computed;
    await publishWorkGraphChange({ initiativeId: 'p-soc2', cause: 'work-item' });
    expect(env.stream.source.computed).toBe(before);
    expect(env.frames('nora-s')).toEqual([]);
  });

  it('catches up from the snapshot cursor: a change between the snapshot and the subscribe arrives as the first delta', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    const snap = await restSnapshot('theo', 'member');
    const item = await newItem('Landed before the stream opened');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, snap.cursor);
    const theo = reader(snap, 'gt');
    theo.apply(env.frames('theo-s'));
    expect(ids(theo.state)).toContain(`work:${item.id}`);
  });

  it('a cursor this replica did not serve: same graph continues; a different graph asks one refetch, then is adopted (no loop)', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    const snap = await restSnapshot('theo', 'member');
    resetServedWorkGraphs(); // served by "another replica"
    await subscribe(env, 'theo-s', 'g1', `initiative:${INIT}`, snap.cursor);
    expect(env.frames('theo-s')).toEqual([]);
    await newItem('moved while switching replicas');
    resetServedWorkGraphs();
    await subscribe(env, 'theo-s', 'g2', `initiative:${INIT}`, snap.cursor);
    expect(env.frames('theo-s')).toEqual([{ kind: 'reset-required', subscriptionGeneration: 'g2', reason: 'gap' }]);
    await subscribe(env, 'theo-s', 'g3', `initiative:${INIT}`, snap.cursor);
    expect(env.frames('theo-s')).toHaveLength(1);
    expect(env.service.getStats().subscriptions).toBe(2);
  });

  it('another viewer’s served snapshot is never a baseline: a cursor from someone else’s snapshot is not continued', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    const noraSnap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, noraSnap.cursor);
    // Different policy revision: the reader is told to start over, with nothing.
    expect(env.frames('theo-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gt', reason: 'policy-changed' }]);
  });
});

describe('revocation mid-subscription', () => {
  for (const [what, revoke] of [
    ['a removed orgiq grant', () => { users.get('nora')!.grants = {}; }],
    ['a bumped epoch', () => { users.get('nora')!.epoch = 2; }],
  ] as const) {
    it(`${what}: a content-free invalidate before any content is computed, then nothing`, async () => {
      const env = setup();
      env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
      const snap = await restSnapshot('nora', 'sme');
      await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, snap.cursor);
      const computed = env.stream.source.computed;
      revoke();
      await newRun();
      await publishWorkGraphChange({ initiativeId: INIT, cause: 'run' });
      expect(env.frames('nora-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gn', reason: 'policy-changed' }]);
      expect(env.stream.source.computed).toBe(computed);
      await newItem('after revocation');
      await publishWorkGraphChange({ initiativeId: INIT, cause: 'work-item' });
      expect(env.frames('nora-s')).toHaveLength(1);
      expect(env.service.getStats().subscriptions).toBe(0);
    });
  }

  it('the directory signal revokes without waiting for a data change', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const snap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, snap.cursor);
    users.get('nora')!.grants = { pipelines: ['author'] };
    await signalWorkGraphAccess();
    expect(env.frames('nora-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gn', reason: 'policy-changed' }]);
  });

  it('a policy change (the sme loses ManageBots) invalidates: runs already shown must go', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const snap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, snap.cursor);
    cedar['sme'] = ['DispatchAgentRun'];
    await signalWorkGraphAccess();
    expect(env.frames('nora-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gn', reason: 'policy-changed' }]);
  });

  it('an unchanged policy on the access signal sends nothing', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const snap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, snap.cursor);
    await signalWorkGraphAccess();
    expect(env.frames('nora-s')).toEqual([]);
    expect(env.service.getStats().subscriptions).toBe(1);
  });
});

describe('access, disconnect, peers', () => {
  it('a placeholder waits content-free, and access-restored arrives only once the router admits it', async () => {
    const env = setup();
    env.contexts.set('hank-s', ctxOf('hank', 'orgiq', 'member'));
    await subscribe(env, 'hank-s', 'gh', `initiative:${INIT}`);
    expect(env.acks('hank-s')).toEqual(['awaiting']);
    await signalWorkGraphAccess();
    expect(env.frames('hank-s')).toEqual([]);
    users.get('hank')!.grants = { orgiq: ['member'] };
    await signalWorkGraphAccess();
    expect(env.frames('hank-s')).toEqual([{ kind: 'reset-required', subscriptionGeneration: 'gh', reason: 'access-restored' }]);
  });

  it('a disconnect forgets the graphs its subscriptions held', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    const snap = await restSnapshot('theo', 'member');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, snap.cursor);
    expect(env.stream.source.stats()).toEqual({ clients: 1, baselines: 1 });
    env.router.removeClient('theo-s');
    await new Promise(resolve => setImmediate(resolve));
    expect(env.stream.source.stats()).toEqual({ clients: 0, baselines: 0 });
  });

  it('publishes to peers content-free and answers a peer’s change on this replica; junk is ignored', async () => {
    const env = setup(); env.stop();
    const published: Array<[string, string]> = [];
    const handlers = new Map<string, (payload: string) => unknown>();
    const stop = env.stream.attach(env.service, {
      publish: async (topic, payload) => { published.push([topic, payload]); },
      subscribe: (topic, handler) => { handlers.set(topic, handler); return () => handlers.delete(topic); },
    });
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    const snap = await restSnapshot('theo', 'member');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, snap.cursor);
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'work-item', secret: 'never forwarded' } as never);
    expect(published).toEqual([['orgiq:workgraph', JSON.stringify({ cause: 'work-item', initiativeId: INIT })]]);
    const item = await newItem('From a peer');
    await handlers.get('orgiq:workgraph')!('{"cause":"nonsense"}');
    await handlers.get('orgiq:workgraph')!('not json');
    expect(env.frames('theo-s')).toEqual([]);
    await handlers.get('orgiq:workgraph')!(JSON.stringify({ initiativeId: INIT, cause: 'work-item' }));
    expect(frameIds(env.frames('theo-s'))).toContain(`work:${item.id}`);
    stop();
  });
});

const _typecheck: OrgiqWorkGraphStream | null = null; void _typecheck;

describe('queue rows and the person day', () => {
  const liveItem = async () => (await getProjectWorkItems(INIT)).find(i => i.assigneeId && i.status !== 'done' && i.status !== 'cancelled')!;

  it('a queued job reaches the dispatch tier only; a member never receives a job node and the reduced graph equals its REST snapshot', async () => {
    const env = setup();
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    const theoSnap = await restSnapshot('theo', 'member');
    const noraSnap = await restSnapshot('nora', 'sme');
    await subscribe(env, 'theo-s', 'gt', `initiative:${INIT}`, theoSnap.cursor);
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, noraSnap.cursor);
    const theo = reader(theoSnap, 'gt'), nora = reader(noraSnap, 'gn');
    const item = await liveItem();
    const job = (await enqueueJob({ kind: 'devbox:task', title: 'Stream job', payload: { prompt: 'PRIVATE PROMPT', workItemId: item.id } }))!;
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'job' });
    expect(env.frames('theo-s')).toEqual([]);
    nora.apply(env.frames('nora-s'));
    expect(ids(nora.state)).toContain(`job:${job.id}`);
    expect(env.sent.filter(s => s.to === 'theo-s').map(s => JSON.stringify(s.message)).join('\n')).not.toMatch(/"job:|PRIVATE PROMPT/);
    expect(env.sent.filter(s => s.to === 'nora-s').map(s => JSON.stringify(s.message)).join('\n')).not.toMatch(/PRIVATE PROMPT/);
    const fresh = await restSnapshot('nora', 'sme');
    expect(ids(nora.state)).toEqual(ids(fresh)); expect(edgeIds(nora.state)).toEqual(edgeIds(fresh));
    expect(ids(theo.state).some(id => id.startsWith('job:'))).toBe(false);
  });

  it('person:<id> is a default-deny family member: an orgiq reader gets that person’s day as deltas, a non-reader is refused', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    env.contexts.set('pat-s', ctxOf('pat', 'pipelines', 'author'));
    env.contexts.set('hank-s', { ...ctxOf('hank', 'orgiq', 'member'), tenants: ['orgiq'] });
    const item = await liveItem();
    const subject = { kind: 'person' as const, id: item.assigneeId! };
    const snap = await restSnapshot('nora', 'sme', subject);
    expect(snap.scope.personId).toBe(`person:${item.assigneeId}`);
    await subscribe(env, 'nora-s', 'gp', snap.scope.personId, snap.cursor);
    for (const who of ['pat-s', 'hank-s']) await subscribe(env, who, 'gp', snap.scope.personId, snap.cursor);
    expect(env.acks('nora-s')).toEqual(['subscribed']);
    expect(env.acks('pat-s')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED']);
    expect(env.acks('hank-s').filter(a => a !== 'AUTHZ_CHANNEL_DENIED')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED']);
    expect(env.service.getStats().subscriptions).toBe(1);
    const nora = reader(snap, 'gp');
    const job = (await enqueueJob({ kind: 'devbox:task', title: 'Their job', payload: { workItemId: item.id } }))!;
    const elsewhere = (await enqueueJob({ kind: 'devbox:task', title: 'Not theirs', payload: { initiativeId: INIT } }))!;
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'job' });
    nora.apply(env.frames('nora-s'));
    expect(ids(nora.state)).toContain(`job:${job.id}`);
    expect(ids(nora.state)).not.toContain(`job:${elsewhere.id}`);
    const fresh = await restSnapshot('nora', 'sme', subject);
    expect(ids(nora.state)).toEqual(ids(fresh));
  });
});


// ── The pipelines tenant: same stream, `pipelines:workgraph:*` channels ─────

const psessionOf = (userId: string, role: string): Session =>
  ({ sub: userId, tenant: 'pipelines', role, epoch: users.get(userId)!.epoch, iat: 1, grants: structuredClone(users.get(userId)!.grants) } as Session);
async function pipelinesSnapshot(userId: string, role: string, subject: PipelinesWorkGraphSubject = { kind: 'workspace' }): Promise<WorkGraphSnapshotV2> {
  const a = activity();
  const query = parseWorkGraphQuery({ day: day(), timezone: TZ, schemaVersion: '2', windowStart: a.windowStart, windowEnd: a.windowEnd, mode: a.mode });
  const built = await buildPipelinesViewerWorkGraph(psessionOf(userId, role), subject, query);
  rememberServedWorkGraph(userId, built!.snapshot);
  return built!.snapshot as WorkGraphSnapshotV2;
}
const PWS = 'workspace:pipelines';

describe('pipelines work graph: default deny', () => {
  it('admits a pipelines reader; refuses an orgiq session, other tenants, a forged context and malformed subjects', async () => {
    const env = setup();
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('pat-s', ctxOf('pat', 'orgiq', 'member'));            // holds a pipelines grant but is parked in orgiq
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('hank-s', { ...ctxOf('hank', 'pipelines', 'author'), tenants: ['pipelines'] }); // directory backs no grant
    const snap = await pipelinesSnapshot('ines', 'author');
    expect(snap.scope.personId).toBe(PWS);
    await subscribe(env, 'ines-s', 'g1', PWS, snap.cursor);
    expect(env.acks('ines-s')).toEqual(['subscribed']);
    for (const who of ['theo-s', 'pat-s', 'sara-s', 'hank-s']) {
      await subscribe(env, who, 'g1', PWS, snap.cursor);
      await subscribe(env, who, 'g2', 'run:job:x', snap.cursor);
      expect(env.acks(who).filter(a => a !== 'AUTHZ_CHANNEL_DENIED')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED', 'WORK_GRAPH_SUBSCRIBE_REFUSED']);
    }
    expect(env.acks('hank-s').filter(a => a === 'AUTHZ_CHANNEL_DENIED')).toHaveLength(2);
    // The orgiq subjects and the bare `workspace` stay orgiq's: a pipelines reader gets nothing of them.
    for (const subject of ['workspace', `initiative:${INIT}`, 'person:p-004', 'run:', 'run:a b', 'run:../x', 'workspace:orgiq', 'workspace:pipelines:x']) {
      await subscribe(env, 'ines-s', `bad-${subject.length}-${subject}`, subject, snap.cursor);
    }
    // Refused by channelFor/the router, or rejected as malformed by the library: never admitted.
    expect(env.acks('ines-s').filter(a => a === 'WORK_GRAPH_SUBSCRIBE_REFUSED' || a === 'WORK_GRAPH_BAD_REQUEST')).toHaveLength(8);
    expect(env.service.getStats().subscriptions).toBe(1);
  });

  it('an orgiq reader never sees pipelines frames and vice versa: a change names exactly one tenant', async () => {
    const env = setup();
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    const noraSnap = await restSnapshot('nora', 'sme');
    const inesSnap = await pipelinesSnapshot('ines', 'author');
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, noraSnap.cursor);
    await subscribe(env, 'ines-s', 'gi', PWS, inesSnap.cursor);
    const before = env.stream.source.computed;
    await publishWorkGraphChange({ tenant: 'pipelines', cause: 'run' });
    expect(env.stream.source.computed).toBe(before + 1);   // only ines's channel recomputed
    await publishWorkGraphChange({ initiativeId: INIT, cause: 'run' });
    expect(env.stream.source.computed).toBe(before + 2);   // only nora's
    // A run-scoped change concerns only its run page and the workspace.
    const run = await pipelinesSnapshot('ines', 'author', { kind: 'run', id: `job:${(await enqueueJob({ kind: 'work', title: 'x' }))!.id}` });
    await subscribe(env, 'ines-s', 'gr', run.scope.personId, run.cursor);
    const mid = env.stream.source.computed;
    await publishWorkGraphChange({ tenant: 'pipelines', runId: 'job:someone-elses', cause: 'job' });
    expect(env.stream.source.computed).toBe(mid + 1);       // the workspace, not the other run's page
  });
});

describe('pipelines work graph: per-viewer frames', () => {
  it('a run status change reaches both readers; an approval reaches the operator only; each reduced graph equals that viewer’s REST snapshot', async () => {
    const env = setup();
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('kofi-s', ctxOf('kofi', 'pipelines', 'operator'));
    const inesSnap = await pipelinesSnapshot('ines', 'author');
    const kofiSnap = await pipelinesSnapshot('kofi', 'operator');
    await subscribe(env, 'ines-s', 'gi', PWS, inesSnap.cursor);
    await subscribe(env, 'kofi-s', 'gk', PWS, kofiSnap.cursor);
    expect(env.frames('ines-s')).toEqual([]); expect(env.frames('kofi-s')).toEqual([]);
    const ines = reader(inesSnap, 'gi'), kofi = reader(kofiSnap, 'gk');

    // A run appears (queued), then changes status (running): two deltas, same stream.
    const job = (await enqueueJob({ kind: 'work', title: 'Stream a run', payload: { requiresReview: true }, createdBy: 'ines' }))!;
    const runId = `job:${job.id}`;
    await publishWorkGraphChange({ tenant: 'pipelines', runId, cause: 'job' });
    ines.apply(env.frames('ines-s')); kofi.apply(env.frames('kofi-s'));
    expect(ids(ines.state)).toContain(`prun:${runId}`); expect(ids(kofi.state)).toContain(`prun:${runId}`);
    const statusOf = (v: { state: ClientWorkGraphState }) => v.state.nodes[`prun:${runId}`]!.status;
    const first = statusOf(kofi);
    agentJobs.rows().find(j => j.id === job.id)!.status = 'running';
    await publishWorkGraphChange({ tenant: 'pipelines', runId, cause: 'job' });
    ines.apply(env.frames('ines-s').slice(1)); kofi.apply(env.frames('kofi-s').slice(1));
    expect(statusOf(kofi)).toBe('running'); expect(statusOf(ines)).toBe('running');
    expect(first).not.toBe('running');

    // The job finishes into review: an approval arrives — for the operator only.
    await completeJob(job.id, { status: 'awaiting_review' });
    await publishWorkGraphChange({ tenant: 'pipelines', runId, cause: 'approval' });
    ines.apply(env.frames('ines-s').slice(2)); kofi.apply(env.frames('kofi-s').slice(2));
    expect(ids(kofi.state).filter(id => id.startsWith('approval:'))).toContain(`approval:job:${job.id}`);
    // The seed's change-request and consult approvals are the operator's too; the author is told of none.
    expect(ids(ines.state).filter(id => id.startsWith('approval:'))).toEqual([]);
    const toAuthor = env.sent.filter(s => s.to === 'ines-s').map(s => JSON.stringify(s.message)).join('\n');
    expect(toAuthor).not.toMatch(/"approval:|Approval ·/);
    for (const [who, role, view] of [['ines', 'author', ines], ['kofi', 'operator', kofi]] as const) {
      const fresh = await pipelinesSnapshot(who, role);
      expect(ids(view.state)).toEqual(ids(fresh)); expect(edgeIds(view.state)).toEqual(edgeIds(fresh));
      expect(view.state.policyRevision).toBe(fresh.scope.policyRevision);
    }
  });

  it('a run page stream carries that run only, and its steps arrive as deltas', async () => {
    const env = setup();
    env.contexts.set('kofi-s', ctxOf('kofi', 'pipelines', 'operator'));
    const job = (await enqueueJob({ kind: 'work', title: 'A run page', payload: { requiresReview: true } }))!;
    const runId = `job:${job.id}`;
    const snap = await pipelinesSnapshot('kofi', 'operator', { kind: 'run', id: runId });
    expect(snap.scope.personId).toBe(`run:${runId}`);
    await subscribe(env, 'kofi-s', 'gr', snap.scope.personId, snap.cursor);
    expect(env.acks('kofi-s')).toEqual(['subscribed']);
    const kofi = reader(snap, 'gr');
    await completeJob(job.id, { status: 'awaiting_review' });
    await publishWorkGraphChange({ tenant: 'pipelines', runId, cause: 'approval' });
    kofi.apply(env.frames('kofi-s'));
    expect(ids(kofi.state).filter(id => id.startsWith('prun:'))).toEqual([`prun:${runId}`]);
    expect(ids(kofi.state)).toContain(`approval:${runId}`);
    const fresh = await pipelinesSnapshot('kofi', 'operator', { kind: 'run', id: runId });
    expect(ids(kofi.state)).toEqual(ids(fresh));
  });
});

describe('pipelines work graph: revocation', () => {
  it('a removed pipelines grant, a bumped epoch and a lost ApproveStep each end the stream with a content-free invalidate', async () => {
    for (const revoke of [() => { users.get('kofi')!.grants = {}; }, () => { users.get('kofi')!.epoch = 2; }, () => { cedar['operator'] = ['ViewPipelines']; }]) {
      const env = setup();
      cedar = structuredClone(POLICY); users.get('kofi')!.grants = { pipelines: ['operator'] }; users.get('kofi')!.epoch = 1;
      env.contexts.set('kofi-s', ctxOf('kofi', 'pipelines', 'operator'));
      const snap = await pipelinesSnapshot('kofi', 'operator');
      await subscribe(env, 'kofi-s', 'gk', PWS, snap.cursor);
      revoke();
      await signalWorkGraphAccess();
      expect(env.frames('kofi-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gk', reason: 'policy-changed' }]);
      expect(env.service.getStats().subscriptions).toBe(0);
      env.stop();
    }
  });
});


// ── The assessment work graph ───────────────────────────────────────────────

const AWS = 'workspace:assessment';
const TEAM = 'TEAM-001';
const assessmentSessionOf = (userId: string, role: string): Session =>
  ({ sub: userId, tenant: 'assessment', role, epoch: users.get(userId)!.epoch, iat: 1, grants: structuredClone(users.get(userId)!.grants) } as Session);
async function assessmentSnapshot(userId: string, role: string, subject: AssessmentWorkGraphSubject = { kind: 'workspace' }): Promise<WorkGraphSnapshotV2> {
  const a = activity();
  const query = parseWorkGraphQuery({ day: day(), timezone: TZ, schemaVersion: '2', windowStart: a.windowStart, windowEnd: a.windowEnd, mode: a.mode });
  const built = await buildAssessmentViewerWorkGraph(assessmentSessionOf(userId, role), subject, query);
  rememberServedWorkGraph(userId, built!.snapshot);
  return built!.snapshot as WorkGraphSnapshotV2;
}

describe('assessment work graph: default deny', () => {
  it('admits an assessment reader; refuses orgiq/pipelines/social sessions, a forged context and malformed subjects', async () => {
    const env = setup();
    env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('hank-s', { ...ctxOf('hank', 'assessment', 'assessor'), tenants: ['assessment'] }); // the directory backs no grant
    const snap = await assessmentSnapshot('ana', 'assessor');
    expect(snap.scope.personId).toBe(AWS);
    expect(snap.scope.policyRevision).toMatch(/^assessment\./);
    await subscribe(env, 'ana-s', 'g1', AWS, snap.cursor);
    expect(env.acks('ana-s')).toEqual(['subscribed']);
    for (const who of ['theo-s', 'ines-s', 'sara-s', 'hank-s']) {
      await subscribe(env, who, 'g1', AWS, snap.cursor);
      await subscribe(env, who, 'g2', `team:${TEAM}`, snap.cursor);
      expect(env.acks(who).filter(a => a !== 'AUTHZ_CHANNEL_DENIED')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED', 'WORK_GRAPH_SUBSCRIBE_REFUSED']);
    }
    expect(env.acks('hank-s').filter(a => a === 'AUTHZ_CHANNEL_DENIED')).toHaveLength(2);
    for (const subject of ['workspace', 'team:', 'team:../x', 'team:TEAM- 1', 'team:nope', 'workspace:assessment:x', `team:${TEAM}:extra`]) {
      await subscribe(env, 'ana-s', `bad-${subject.length}-${subject}`, subject, snap.cursor);
    }
    // An orgiq reader of a bare `workspace` is orgiq's: this assessor is refused it, never admitted.
    expect(env.acks('ana-s').filter(a => a === 'WORK_GRAPH_SUBSCRIBE_REFUSED' || a === 'WORK_GRAPH_BAD_REQUEST')).toHaveLength(7);
    expect(env.service.getStats().subscriptions).toBe(1);
  });

  it('a change names exactly one tenant: an assessment change never recomputes an orgiq or pipelines reader', async () => {
    const env = setup();
    env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    await subscribe(env, 'ana-s', 'ga', AWS, (await assessmentSnapshot('ana', 'assessor')).cursor);
    await subscribe(env, 'ines-s', 'gi', PWS, (await pipelinesSnapshot('ines', 'author')).cursor);
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, (await restSnapshot('nora', 'sme')).cursor);
    const team = await assessmentSnapshot('ana', 'assessor', { kind: 'team', id: TEAM });
    await subscribe(env, 'ana-s', 'gt', team.scope.personId, team.cursor);
    const before = env.stream.source.computed;
    await publishWorkGraphChange({ tenant: 'assessment', cause: 'score' });
    expect(env.stream.source.computed).toBe(before + 2);          // the workspace and the team page
    await publishWorkGraphChange({ tenant: 'assessment', teamId: 'TEAM-002', cause: 'evidence' });
    expect(env.stream.source.computed).toBe(before + 3);          // the workspace only, not TEAM-001's page
    await publishWorkGraphChange({ tenant: 'pipelines', cause: 'run' });
    expect(env.stream.source.computed).toBe(before + 4);          // only ines
  });
});

describe('assessment work graph: per-viewer frames', () => {
  it('a score change and an evidence draft arrive as deltas; each reduced graph equals that viewer’s REST snapshot', async () => {
    const env = setup();
    env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    env.contexts.set('rob-s', ctxOf('rob', 'assessment', 'readonly'));
    const anaSnap = await assessmentSnapshot('ana', 'assessor');
    const robSnap = await assessmentSnapshot('rob', 'readonly');
    await subscribe(env, 'ana-s', 'ga', AWS, anaSnap.cursor);
    await subscribe(env, 'rob-s', 'gr', AWS, robSnap.cursor);
    expect(env.frames('ana-s')).toEqual([]); expect(env.frames('rob-s')).toEqual([]);
    const ana = reader(anaSnap, 'ga'), rob = reader(robSnap, 'gr');

    // A live score change on one dimension.
    await applyScores(TEAM, {
      relevant_dimension_ids: ['2'],
      scores: [{ dimension_id: '2', suggested_level: 3, confidence: 'moderate', rationale: 'Observed in the walkthrough', evidence_excerpts: ['Pipelines run on every merge'] }],
    }, 'ana');
    await publishWorkGraphChange({ tenant: 'assessment', teamId: TEAM, cause: 'score' });
    ana.apply(env.frames('ana-s')); rob.apply(env.frames('rob-s'));
    expect(ids(ana.state)).toContain(`dim:${TEAM}:2`); expect(ids(rob.state)).toContain(`dim:${TEAM}:2`);
    expect(ids(ana.state)).toContain(`team:${TEAM}`);

    // An evidence draft starts: a `change` node tied to its dimension, for both readers.
    const draft = await flowRunStore.create({ tenant: 'assessment', kind: SUMMARY_KIND, requestedBy: 'ana', scope: `${TEAM}/2`, input: {}, idPrefix: 'adr' });
    await uploadEvidence(TEAM, { dimension_id: '2', source_type: 'document', excerpt: 'Release runbook' });
    await publishWorkGraphChange({ tenant: 'assessment', teamId: TEAM, cause: 'draft' });
    ana.apply(env.frames('ana-s').slice(1)); rob.apply(env.frames('rob-s').slice(1));
    expect(ids(ana.state)).toContain(`draft:${draft.id}`); expect(ids(rob.state)).toContain(`draft:${draft.id}`);
    expect(ana.state.nodes[`draft:${draft.id}`]!.kind).toBe('change');
    for (const [who, role, view] of [['ana', 'assessor', ana], ['rob', 'readonly', rob]] as const) {
      const fresh = await assessmentSnapshot(who, role);
      expect(ids(view.state)).toEqual(ids(fresh)); expect(edgeIds(view.state)).toEqual(edgeIds(fresh));
      expect(view.state.policyRevision).toBe(fresh.scope.policyRevision);
    }
  });

  it('a team page stream carries that team only', async () => {
    const env = setup();
    env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    const snap = await assessmentSnapshot('ana', 'assessor', { kind: 'team', id: TEAM });
    expect(snap.scope.personId).toBe(`team:${TEAM}`);
    await subscribe(env, 'ana-s', 'gt', snap.scope.personId, snap.cursor);
    expect(env.acks('ana-s')).toEqual(['subscribed']);
    const ana = reader(snap, 'gt');
    const mine = await flowRunStore.create({ tenant: 'assessment', kind: SUMMARY_KIND, requestedBy: 'ana', scope: `${TEAM}/4`, input: {}, idPrefix: 'adr' });
    const other = await flowRunStore.create({ tenant: 'assessment', kind: SUMMARY_KIND, requestedBy: 'ana', scope: 'TEAM-002/4', input: {}, idPrefix: 'adr' });
    await publishWorkGraphChange({ tenant: 'assessment', teamId: TEAM, cause: 'draft' });
    ana.apply(env.frames('ana-s'));
    expect(ids(ana.state).filter(id => id.startsWith('team:'))).toEqual([`team:${TEAM}`]);
    expect(ids(ana.state)).toContain(`draft:${mine.id}`);
    expect(ids(ana.state)).not.toContain(`draft:${other.id}`);
  });
});

describe('assessment work graph: revocation', () => {
  it('a removed grant, a bumped epoch and a lost RunAssessmentAgent each end the stream with a content-free invalidate', async () => {
    for (const revoke of [() => { users.get('ana')!.grants = {}; }, () => { users.get('ana')!.epoch = 2; }, () => { cedar['assessor'] = ['ViewAssessment', 'ScoreAssessment']; }]) {
      const env = setup();
      cedar = structuredClone(POLICY); users.get('ana')!.grants = { assessment: ['assessor'] }; users.get('ana')!.epoch = 1;
      env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
      const snap = await assessmentSnapshot('ana', 'assessor');
      await subscribe(env, 'ana-s', 'ga', AWS, snap.cursor);
      revoke();
      await signalWorkGraphAccess();
      expect(env.frames('ana-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'ga', reason: 'policy-changed' }]);
      expect(env.service.getStats().subscriptions).toBe(0);
      env.stop();
    }
  });
});

// ── The social tenant ───────────────────────────────────────────────────────

const SWS = 'workspace:social';
const GENERAL = 'social:ch:general';
const MODS = 'social:ch:moderators';
const socialSessionOf = (userId: string, role: string): Session =>
  ({ sub: userId, tenant: 'social', role, epoch: users.get(userId)!.epoch, iat: 1, grants: structuredClone(users.get(userId)!.grants) } as Session);
async function socialSnapshot(userId: string, role: string, subject: SocialWorkGraphSubject = { kind: 'workspace' }): Promise<WorkGraphSnapshotV2> {
  const a = activity();
  const query = parseWorkGraphQuery({ day: day(), timezone: TZ, schemaVersion: '2', windowStart: a.windowStart, windowEnd: a.windowEnd, mode: a.mode });
  const built = await buildSocialViewerWorkGraph(socialSessionOf(userId, role), subject, query);
  rememberServedWorkGraph(userId, built!.snapshot);
  return built!.snapshot as WorkGraphSnapshotV2;
}
/** sara is in #general and the private #moderators; sam only in #general. */
async function seedSocial(): Promise<void> {
  resetObservedCalls();
  const chat = socialChat();
  const at = clock.nowIso();
  for (const [channel, userId] of [[GENERAL, 'sara'], [GENERAL, 'sam'], [MODS, 'sara']] as const) {
    await chat.membershipStore.putMember({ channel, userId, role: 'member', addedBy: userId, addedAt: at, historyFrom: null, removedAt: null });
  }
}
async function say(channel: string, userId: string, text: string): Promise<void> {
  await socialChat().chatStore.putMessage({ id: `m-${Math.random().toString(36).slice(2)}`, clientId: 'c', userId, channel, message: text, timestamp: clock.nowIso(), metadata: { displayName: userId } } as never);
}

describe('social work graph: default deny', () => {
  it('admits a ViewSocial reader; refuses orgiq/pipelines/assessment sessions, a forged context, a non-member\'s private conversation and malformed subjects', async () => {
    await seedSocial();
    const env = setup();
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    env.contexts.set('theo-s', ctxOf('theo', 'orgiq', 'member'));
    env.contexts.set('ines-s', ctxOf('ines', 'pipelines', 'author'));
    env.contexts.set('ana-s', ctxOf('ana', 'assessment', 'assessor'));
    env.contexts.set('hank-s', { ...ctxOf('hank', 'social', 'participant'), tenants: ['social'] }); // the directory backs no grant
    const snap = await socialSnapshot('sara', 'participant');
    expect(snap.scope.personId).toBe(SWS);
    expect(snap.scope.policyRevision).toMatch(/^social\./);
    await subscribe(env, 'sara-s', 'g1', SWS, snap.cursor);
    await subscribe(env, 'sara-s', 'g2', `conversation:${MODS}`, (await socialSnapshot('sara', 'participant', { kind: 'conversation', id: MODS })).cursor);
    expect(env.acks('sara-s')).toEqual(['subscribed', 'subscribed']);
    for (const who of ['theo-s', 'ines-s', 'ana-s', 'hank-s']) {
      await subscribe(env, who, 'g1', SWS, snap.cursor);
      await subscribe(env, who, 'g2', `conversation:${GENERAL}`, snap.cursor);
      expect(env.acks(who).filter(a => a !== 'AUTHZ_CHANNEL_DENIED')).toEqual(['WORK_GRAPH_SUBSCRIBE_REFUSED', 'WORK_GRAPH_SUBSCRIBE_REFUSED']);
    }
    // sam holds ViewSocial but is not in #moderators: the same refusal, before any content is computed.
    const before = env.stream.source.computed;
    await subscribe(env, 'sam-s', 'g1', `conversation:${MODS}`, snap.cursor);
    expect(env.acks('sam-s').filter(a => a === 'AUTHZ_CHANNEL_DENIED' || a === 'WORK_GRAPH_SUBSCRIBE_REFUSED')).toHaveLength(2);
    expect(env.stream.source.computed).toBe(before);
    for (const subject of ['workspace', 'conversation:', 'conversation:x', 'conversation:orgiq:initiative:p-1', 'conversation:social:ch:a b', `conversation:${GENERAL}:../x`, 'workspace:social:x']) {
      await subscribe(env, 'sara-s', `bad-${subject.length}-${subject}`, subject, snap.cursor);
    }
    expect(env.service.getStats().subscriptions).toBe(2);
  });

  it('a change names exactly one tenant, and a conversation page hears only its own conversation', async () => {
    await seedSocial();
    const env = setup();
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('nora-s', ctxOf('nora', 'orgiq', 'sme'));
    await subscribe(env, 'sara-s', 'gw', SWS, (await socialSnapshot('sara', 'participant')).cursor);
    const page = await socialSnapshot('sara', 'participant', { kind: 'conversation', id: GENERAL });
    await subscribe(env, 'sara-s', 'gp', page.scope.personId, page.cursor);
    await subscribe(env, 'nora-s', 'gn', `initiative:${INIT}`, (await restSnapshot('nora', 'sme')).cursor);
    const before = env.stream.source.computed;
    await publishWorkGraphChange({ tenant: 'social', cause: 'call' });
    expect(env.stream.source.computed).toBe(before + 2);                                       // the workspace and the page
    await publishWorkGraphChange({ tenant: 'social', conversationId: MODS, cause: 'message' });
    expect(env.stream.source.computed).toBe(before + 3);                                       // the workspace only
    await publishWorkGraphChange({ tenant: 'assessment', cause: 'score' });
    expect(env.stream.source.computed).toBe(before + 3);
  });
});

describe('social work graph: per-viewer frames', () => {
  it('a live message and a call status change arrive as deltas; a member of #general never receives #moderators; each reduced graph equals that viewer\'s REST snapshot', async () => {
    await seedSocial();
    const env = setup();
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    env.contexts.set('sam-s', ctxOf('sam', 'social', 'participant'));
    const saraSnap = await socialSnapshot('sara', 'participant');
    const samSnap = await socialSnapshot('sam', 'participant');
    await subscribe(env, 'sara-s', 'gs', SWS, saraSnap.cursor);
    await subscribe(env, 'sam-s', 'gm', SWS, samSnap.cursor);
    expect(env.frames('sara-s')).toEqual([]); expect(env.frames('sam-s')).toEqual([]);
    const sara = reader(saraSnap, 'gs'), sam = reader(samSnap, 'gm');

    // One live message in #general: both members' graphs gain the thread.
    await say(GENERAL, 'sara', 'hello from the stream test');
    await publishWorkGraphChange({ tenant: 'social', conversationId: GENERAL, cause: 'message' });
    sara.apply(env.frames('sara-s')); sam.apply(env.frames('sam-s'));
    expect(ids(sara.state)).toContain(`sthread:${GENERAL}`); expect(ids(sam.state)).toContain(`sthread:${GENERAL}`);
    expect(sara.state.nodes[`sthread:${GENERAL}`]!.kind).toBe('conversation');

    // A message in the private channel reaches sara only; sam's graph does not move and carries nothing of it.
    const samFrames = env.frames('sam-s').length;
    await say(MODS, 'sara', 'mods only text');
    await publishWorkGraphChange({ tenant: 'social', conversationId: MODS, cause: 'message' });
    sara.apply(env.frames('sara-s').slice(1));
    expect(env.frames('sam-s')).toHaveLength(samFrames);
    expect(ids(sara.state)).toContain(`sthread:${MODS}`);
    expect(JSON.stringify(env.sent.filter(s => s.to === 'sam-s'))).not.toMatch(/moderators|mods only/);

    // A call changes status in #general: ringing → running, as deltas to both.
    const edgesBefore = env.frames('sara-s').length;
    observeCall({ callId: 'c-1', lobbyName: GENERAL, callerId: 'sara', targetUserIds: [], participants: 1 });
    await publishWorkGraphChange({ tenant: 'social', conversationId: GENERAL, cause: 'call' });
    sara.apply(env.frames('sara-s').slice(edgesBefore));
    expect(sara.state.nodes['scall:c-1']).toMatchObject({ kind: 'meeting', status: 'running' });
    const afterStart = env.frames('sara-s').length;
    observeCallEnded('c-1');
    await publishWorkGraphChange({ tenant: 'social', conversationId: GENERAL, cause: 'call' });
    sara.apply(env.frames('sara-s').slice(afterStart));
    expect(sara.state.nodes['scall:c-1']).toMatchObject({ status: 'completed' });

    sam.apply(env.frames('sam-s').slice(1));      // the call reaches sam too (the first frame, the thread, is already applied)
    for (const [who, view] of [['sara', sara], ['sam', sam]] as const) {
      const fresh = await socialSnapshot(who, 'participant');
      expect(ids(view.state)).toEqual(ids(fresh)); expect(edgeIds(view.state)).toEqual(edgeIds(fresh));
      expect(view.state.policyRevision).toBe(fresh.scope.policyRevision);
    }
  });

  it('a conversation page stream carries that conversation only', async () => {
    await seedSocial();
    const env = setup();
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    const snap = await socialSnapshot('sara', 'participant', { kind: 'conversation', id: GENERAL });
    expect(snap.scope.personId).toBe(`conversation:${GENERAL}`);
    await subscribe(env, 'sara-s', 'gp', snap.scope.personId, snap.cursor);
    expect(env.acks('sara-s')).toEqual(['subscribed']);
    const sara = reader(snap, 'gp');
    await say(GENERAL, 'sara', 'one'); await say(MODS, 'sara', 'two');
    await publishWorkGraphChange({ tenant: 'social', cause: 'message' });
    sara.apply(env.frames('sara-s'));
    expect(ids(sara.state).filter(id => id.startsWith('sconv:'))).toEqual([`sconv:${GENERAL}`]);
    expect(ids(sara.state)).toContain(`sthread:${GENERAL}`);
    expect(ids(sara.state)).not.toContain(`sthread:${MODS}`);
  });
});

describe('social work graph: revocation', () => {
  it('a removed Social grant, a bumped epoch and a lost ViewSocial each end the stream with a content-free invalidate', async () => {
    for (const revoke of [() => { users.get('sara')!.grants = {}; }, () => { users.get('sara')!.epoch = 2; }, () => { cedar['participant'] = ['PostMessage', 'StartCall']; }]) {
      await seedSocial();
      const env = setup();
      cedar = structuredClone(POLICY); users.get('sara')!.grants = { social: ['participant'] }; users.get('sara')!.epoch = 1;
      env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
      const snap = await socialSnapshot('sara', 'participant');
      await subscribe(env, 'sara-s', 'gs', SWS, snap.cursor);
      revoke();
      await signalWorkGraphAccess();
      expect(env.frames('sara-s')).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'gs', reason: 'policy-changed' }]);
      expect(env.service.getStats().subscriptions).toBe(0);
      env.stop();
    }
  });

  it('leaving a private channel ends its page stream without a frame of its content, and the workspace drops it', async () => {
    await seedSocial();
    const env = setup();
    env.contexts.set('sara-s', ctxOf('sara', 'social', 'participant'));
    const workspace = await socialSnapshot('sara', 'participant');
    const page = await socialSnapshot('sara', 'participant', { kind: 'conversation', id: MODS });
    await subscribe(env, 'sara-s', 'gw', SWS, workspace.cursor);
    await subscribe(env, 'sara-s', 'gp', page.scope.personId, page.cursor);
    const sara = reader(workspace, 'gw');
    await say(MODS, 'sara', 'before leaving');
    await publishWorkGraphChange({ tenant: 'social', conversationId: MODS, cause: 'message' });
    const chat = socialChat();
    const row = (await chat.membershipStore.getMember(MODS, 'sara'))!;
    await chat.membershipStore.putMember({ ...row, removedAt: clock.nowIso() });
    await say(MODS, 'mira', 'after leaving, sara must not see this');
    await publishWorkGraphChange({ tenant: 'social', conversationId: MODS, cause: 'membership' });
    expect(JSON.stringify(env.sent.filter(s => s.to === 'sara-s'))).not.toMatch(/after leaving/);
    const frames = env.frames('sara-s');
    const generationOf = (f: Msg) => String(f['subscriptionGeneration'] ?? (f['batch'] as Msg | undefined)?.['subscriptionGeneration']);
    // The page stream she left ends with a content-free invalidate and nothing after it.
    const pageFrames = frames.filter(f => generationOf(f) === 'gp');
    expect(pageFrames[pageFrames.length - 1]).toEqual({ kind: 'invalidate', subscriptionGeneration: 'gp', reason: 'policy-changed' });
    // The workspace stream sends her own current graph: the channel is gone from it, and it equals her REST snapshot.
    sara.apply(frames.filter(f => generationOf(f) === 'gw' && f['kind'] === 'delta'));
    const fresh = await socialSnapshot('sara', 'participant');
    expect(ids(sara.state)).toEqual(ids(fresh));
    expect(ids(fresh).filter(id => id.includes('moderators'))).toEqual([]);
  });
});

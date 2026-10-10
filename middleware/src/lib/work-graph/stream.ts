// The orgiq, pipelines, assessment AND social work graphs' live stream (one source, parameterised by tenant —
// docs/activity-graph-migration.md §8): realtime-modules 0.108 `workGraph()` on
// the BFF gateway (lib/realtime-gateway.ts), replacing the portal's fake
// transport (portal/src/lib/workGraph.ts). docs/activity-graph-migration.md.
//
//   channelFor  maps a subscription's subject (`workspace`, `initiative:<id>`,
//               `person:<id>` — the snapshot's personId slot) to the router
//               channel `orgiq:workgraph:<subject>`, a member of the existing
//               default-deny `orgiq:workgraph` family (lib/tenant-channels.ts).
//               The router's authorize (live-principal's family check against
//               the reloaded session) then decides the subscribe and every
//               delivery — the REST snapshot's own gate: active orgiq tenant or
//               admin. Anything else maps to null: refused.
//   source      computes, for ONE subscriber, the frames it should get: it
//               rebuilds that viewer's authorized snapshot with the REST
//               builder (build.ts — the viewer's own session, reloaded from
//               the directory) and diffs it against the last graph THAT
//               subscription holds. A change is never sent; nothing is shared
//               between viewers. A policy change or a refused rebuild ends
//               the stream with a content-free `invalidate`.
//   publish     the existing hint causes (work item/document, run, sprint,
//               decision, flow run — lib/work-graph/live.ts) publish here on
//               this replica AND, through the leased router's peer events, on
//               every other replica (subscriptions live where the socket is).
//   access      a committed directory change (grants, epoch) re-asks every
//               open stream (readable → else invalidate) and signals
//               `access-restored` to placeholders the router now admits.

import { AppError } from '../async-handler.js';
import { getLivePrincipal } from '../live-principal.js';
import { ASSESSMENT_WORK_GRAPH_SUBJECT_ID, PIPELINES_WORK_GRAPH_SUBJECT_ID, SOCIAL_CONVERSATION_ID, tenantChannelFamily, WORK_GRAPH_SUBJECT_ID } from '../tenant-channels.js';
import * as identity from '../../providers/identity.js';
import {
  validateWorkGraphDeltaBatch, WORK_GRAPH_LIMITS,
  type ViewerWorkEdge, type ViewerWorkNode, type WorkGraphDeltaOperation, type WorkGraphSnapshot, type WorkGraphSnapshotV2, type WorkSourceStatus,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import type {
  WorkGraphChannelContext, WorkGraphSource, WorkGraphStreamScope, WorkGraphStreamSubscription, WorkGraphStreamTrigger,
} from '@connorhoehnslalom/realtime-modules/server';
import { buildTenantWorkGraph, takeServedWorkGraph, viewerPolicyRevision } from './build.js';
import { cursorPolicyRevision, parseWorkGraphQuery, workGraphCursor, type AnyWorkGraphSubject, type WorkGraphTenant } from './snapshot.js';

export const WORK_GRAPH_STREAM_PREFIX = 'orgiq:workgraph:';
export const WORK_GRAPH_PEER_TOPIC = 'orgiq:workgraph';
export const PIPELINES_WORK_GRAPH_STREAM_PREFIX = 'pipelines:workgraph:';
export const PIPELINES_WORK_GRAPH_PEER_TOPIC = 'pipelines:workgraph';
export const ASSESSMENT_WORK_GRAPH_STREAM_PREFIX = 'assessment:workgraph:';
export const ASSESSMENT_WORK_GRAPH_PEER_TOPIC = 'assessment:workgraph';
export const SOCIAL_WORK_GRAPH_STREAM_PREFIX = 'social:workgraph:';
export const SOCIAL_WORK_GRAPH_PEER_TOPIC = 'social:workgraph';
export const WORK_GRAPH_ACCESS_PEER_TOPIC = 'orgiq:workgraph:access';
const CAUSES = new Set(['work-item', 'work-document', 'run', 'sprint', 'decision', 'flow-run', 'job', 'step', 'approval', 'deck', 'score', 'evidence', 'draft', 'access', 'message', 'call', 'recording', 'membership']);

/** What moved. Never sent to a client; it only narrows which channels recompute.
 * `tenant` names the graph family (orgiq when absent); `runId` narrows a pipelines run page, `teamId` an assessment team page,
 * `conversationId` (a chat channel name, never sent to a client) a social conversation page. */
export interface WorkGraphChange { tenant?: WorkGraphTenant; initiativeId?: string | null; runId?: string | null; teamId?: string | null; conversationId?: string | null; cause: string }

/** The tenant a stream channel belongs to, from its name alone. */
export function tenantOfWorkGraphChannel(channel: string): WorkGraphTenant | null {
  return channel.startsWith(WORK_GRAPH_STREAM_PREFIX) ? 'orgiq' : channel.startsWith(PIPELINES_WORK_GRAPH_STREAM_PREFIX) ? 'pipelines'
    : channel.startsWith(ASSESSMENT_WORK_GRAPH_STREAM_PREFIX) ? 'assessment' : channel.startsWith(SOCIAL_WORK_GRAPH_STREAM_PREFIX) ? 'social' : null;
}

/** The tenant (the channel's family) decides which subjects exist: orgiq `workspace|initiative:<id>|person:<id>`, pipelines `workspace:pipelines|run:<id>`. */
export function parseWorkGraphSubject(personId: string, tenant: WorkGraphTenant = 'orgiq'): AnyWorkGraphSubject | null {
  if (tenant === 'orgiq' && personId === 'workspace') return { kind: 'workspace' };
  if (tenant === 'social') {
    if (personId === 'workspace:social') return { kind: 'workspace' };
    const conversation = /^conversation:(.+)$/.exec(personId);
    return conversation && SOCIAL_CONVERSATION_ID.test(conversation[1]!) ? { kind: 'conversation', id: conversation[1]! } : null;
  }
  if (tenant === 'assessment') {
    if (personId === 'workspace:assessment') return { kind: 'workspace' };
    const team = /^team:(.+)$/.exec(personId);
    return team && ASSESSMENT_WORK_GRAPH_SUBJECT_ID.test(team[1]!) ? { kind: 'team', id: team[1]! } : null;
  }
  if (tenant === 'pipelines') {
    if (personId === 'workspace:pipelines') return { kind: 'workspace' };
    const run = /^run:(.+)$/.exec(personId);
    return run && PIPELINES_WORK_GRAPH_SUBJECT_ID.test(run[1]!) ? { kind: 'run', id: run[1]! } : null;
  }
  const m = /^(initiative|person):(.+)$/.exec(personId);
  if (!m || !WORK_GRAPH_SUBJECT_ID.test(m[2]!)) return null;
  return m[1] === 'person' ? { kind: 'person', id: m[2]! } : { kind: 'initiative', id: m[2]! };
}
export function workGraphStreamChannel(subject: AnyWorkGraphSubject, tenant: WorkGraphTenant = 'orgiq'): string {
  const prefix = tenant === 'pipelines' ? PIPELINES_WORK_GRAPH_STREAM_PREFIX : tenant === 'assessment' ? ASSESSMENT_WORK_GRAPH_STREAM_PREFIX
    : tenant === 'social' ? SOCIAL_WORK_GRAPH_STREAM_PREFIX : WORK_GRAPH_STREAM_PREFIX;
  return `${prefix}${subject.kind === 'workspace' ? 'workspace' : `${subject.kind}:${subject.id}`}`;
}
/** Does a change concern this subject's graph? An initiative graph only its own
 * initiative (or a change naming none); a pipelines run page only its own run (or one naming none);
 * a workspace or a person's day, any change of its own tenant. */
function concerns(channel: string, change: WorkGraphChange): boolean {
  const tenant = tenantOfWorkGraphChannel(channel);
  if (!tenant) return false;
  // An access signal names no tenant: it re-asks every open stream's own policy.
  if (change.cause === 'access') return true;
  if ((change.tenant ?? 'orgiq') !== tenant) return false;
  if (tenant === 'social') {
    const conversation = /^social:workgraph:conversation:(.+)$/.exec(channel)?.[1];
    return !conversation || typeof change.conversationId !== 'string' || change.conversationId === conversation;
  }
  if (tenant === 'assessment') {
    const team = /^assessment:workgraph:team:(.+)$/.exec(channel)?.[1];
    return !team || typeof change.teamId !== 'string' || change.teamId === team;
  }
  if (tenant === 'pipelines') {
    const run = /^pipelines:workgraph:run:(.+)$/.exec(channel)?.[1];
    return !run || typeof change.runId !== 'string' || change.runId === run;
  }
  const initiative = /^orgiq:workgraph:initiative:(.+)$/.exec(channel)?.[1];
  return !initiative || typeof change.initiativeId !== 'string' || change.initiativeId === initiative;
}
function parseChange(value: unknown): WorkGraphChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { initiativeId, runId, teamId, conversationId, tenant, cause } = value as Record<string, unknown>;
  if (typeof cause !== 'string' || !CAUSES.has(cause)) return null;
  if (tenant != null && tenant !== 'orgiq' && tenant !== 'pipelines' && tenant !== 'assessment' && tenant !== 'social') return null;
  if (conversationId != null && (typeof conversationId !== 'string' || !SOCIAL_CONVERSATION_ID.test(conversationId))) return null;
  if (teamId != null && (typeof teamId !== 'string' || !ASSESSMENT_WORK_GRAPH_SUBJECT_ID.test(teamId))) return null;
  if (initiativeId != null && (typeof initiativeId !== 'string' || !WORK_GRAPH_SUBJECT_ID.test(initiativeId))) return null;
  if (runId != null && (typeof runId !== 'string' || !PIPELINES_WORK_GRAPH_SUBJECT_ID.test(runId))) return null;
  return {
    cause, ...(tenant === 'pipelines' || tenant === 'assessment' || tenant === 'social' ? { tenant } : {}),
    ...(typeof initiativeId === 'string' ? { initiativeId } : {}), ...(typeof runId === 'string' ? { runId } : {}), ...(typeof teamId === 'string' ? { teamId } : {}),
    ...(typeof conversationId === 'string' ? { conversationId } : {}),
  };
}

// ── The per-subscription graph the source diffs against ─────────────────────

interface Baseline {
  watermark: number;
  policyRevision: string;
  nodes: Map<string, string>;
  edges: Map<string, string>;
  sources: Map<string, string>;
}
type Snapshot = WorkGraphSnapshot | WorkGraphSnapshotV2;
const sourceKey = ({ checkedAt: _checkedAt, ...rest }: WorkSourceStatus) => JSON.stringify(rest);
function baselineOf(snapshot: Snapshot, watermark = snapshot.watermark): Baseline {
  return {
    watermark, policyRevision: snapshot.scope.policyRevision,
    nodes: new Map(snapshot.nodes.map(n => [n.id, JSON.stringify(n)])),
    edges: new Map(snapshot.edges.map(e => [e.id, JSON.stringify(e)])),
    sources: new Map(snapshot.sources.map(s => [s.source, sourceKey(s)])),
  };
}
/** The operations that turn `base` into `fresh` (the reader's reducer applies node ops before edge ops). */
export function diffWorkGraph(base: Baseline, fresh: Snapshot): WorkGraphDeltaOperation[] {
  const ops: WorkGraphDeltaOperation[] = [];
  const nodes = new Map<string, ViewerWorkNode>(fresh.nodes.map(n => [n.id, n]));
  const edges = new Map<string, ViewerWorkEdge>(fresh.edges.map(e => [e.id, e]));
  for (const id of base.edges.keys()) if (!edges.has(id)) ops.push({ kind: 'remove-edge', edgeId: id });
  for (const id of base.nodes.keys()) if (!nodes.has(id)) ops.push({ kind: 'remove-node', nodeId: id });
  for (const [id, node] of nodes) if (base.nodes.get(id) !== JSON.stringify(node)) ops.push({ kind: 'upsert-node', node });
  for (const [id, edge] of edges) if (base.edges.get(id) !== JSON.stringify(edge)) ops.push({ kind: 'upsert-edge', edge });
  for (const source of fresh.sources) if (base.sources.get(source.source) !== sourceKey(source)) ops.push({ kind: 'source-health', source });
  return ops;
}
function activityView(snapshot: Snapshot): Record<string, unknown> | null {
  if (snapshot.schemaVersion !== 2) return null;
  const { query, temporal, efforts, details, operations, eventBuckets } = snapshot as WorkGraphSnapshotV2;
  return { query, temporal, efforts, details, operations, eventBuckets };
}

const BASELINE_MAX = 4096;
const GAP_WINDOW_MS = 30_000;

export class OrgiqWorkGraphSource implements WorkGraphSource {
  /** clientId → generation → the graph that subscription holds. */
  private readonly baselines = new Map<string, Map<string, Baseline>>();
  private size = 0;
  /** viewer|subject|day|zone → when a catch-up gap was last sent (bounds refetch loops). */
  private readonly gaps = new Map<string, number>();
  /** Test seam: every frames() call, for "no content was computed" assertions. */
  computed = 0;

  async frames(sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger): Promise<readonly unknown[]> {
    const generation = sub.subscriptionGeneration;
    const invalidate = () => { this.drop(sub); return [{ kind: 'invalidate', subscriptionGeneration: generation, reason: 'policy-changed' }]; };
    const reset = (reason: 'gap' | 'scope-changed') => { this.drop(sub); return [{ kind: 'reset-required', subscriptionGeneration: generation, reason }]; };
    const tenant = tenantOfWorkGraphChannel(sub.channel);
    const subject = tenant ? parseWorkGraphSubject(sub.scope.personId, tenant) : null;
    if (!tenant || !subject || sub.channel !== workGraphStreamChannel(subject, tenant)) return reset('scope-changed');
    const change = trigger.reason === 'change' ? parseChange(trigger.change) : null;
    if (trigger.reason === 'change' && (!change || !concerns(sub.channel, change))) return [];

    // An access signal only re-asks the viewer's policy, not the rows.
    const base = this.get(sub);
    if (change?.cause === 'access') {
      if (!base) return [];
      try {
        const { session } = await getLivePrincipal(sub.userContext);
        const revision = await viewerPolicyRevision(tenant, session);
        return revision === base.policyRevision ? [] : invalidate();
      } catch (error) {
        if (refusal(error)) return invalidate();
        throw error;
      }
    }

    this.computed++;
    let built;
    try {
      const { session } = await getLivePrincipal(sub.userContext);
      const query = parseWorkGraphQuery({
        day: sub.scope.day, timezone: sub.scope.timezone,
        ...(sub.activity ? { schemaVersion: '2', windowStart: sub.activity.windowStart, windowEnd: sub.activity.windowEnd, mode: sub.activity.mode } : {}),
      });
      built = await buildTenantWorkGraph(tenant, session, subject, query);
    } catch (error) {
      if (refusal(error)) return invalidate();
      if (error instanceof AppError && error.status >= 400 && error.status < 500) return reset('scope-changed');
      throw error; // the library answers reset-required: source-unavailable
    }
    if (!built) return reset('scope-changed');
    const fresh = built.snapshot;
    const viewerId = built.viewer.session.sub;

    let from = base;
    if (!from) {
      // Catch-up from the reader's snapshot cursor: the snapshot THIS viewer was
      // served on this replica, else (another replica served it) the fresh one
      // when the cursor proves it is the same graph.
      const served = takeServedWorkGraph(viewerId, sub.scope.personId, sub.scope.day, sub.scope.timezone, sub.cursor);
      if (served && served.scope.policyRevision === fresh.scope.policyRevision) from = baselineOf(served);
      else if (fresh.cursor === sub.cursor) { this.set(sub, baselineOf(fresh)); return []; }
      else {
        if (cursorPolicyRevision(sub.cursor) !== fresh.scope.policyRevision && cursorPolicyRevision(sub.cursor) !== null) return invalidate();
        return this.gap(sub, viewerId, fresh) ?? reset('gap');
      }
    }
    if (from.policyRevision !== fresh.scope.policyRevision) return invalidate();
    const operations = diffWorkGraph(from, fresh);
    if (operations.length === 0) { this.set(sub, from); return []; }
    if (operations.length > WORK_GRAPH_LIMITS.deltaOperations) {
      // Too much for one batch: the reader refetches. A catch-up that keeps
      // overflowing (a graph that changes faster than a round trip) is
      // adopted instead of looping; the next change's delta reconciles it.
      return (trigger.reason === 'subscribe' ? this.gap(sub, viewerId, fresh) : null) ?? reset('gap');
    }
    const watermark = Math.max(fresh.watermark, from.watermark + 1);
    const batch = {
      schemaVersion: 1 as const, subscriptionGeneration: generation, previousWatermark: from.watermark, watermark,
      cursor: workGraphCursor(watermark, fresh.scope.policyRevision, fresh.nodes, fresh.edges, fresh.sources),
      policyRevision: fresh.scope.policyRevision, operations,
    };
    if (!validateWorkGraphDeltaBatch(batch).ok) return reset('gap');
    this.set(sub, baselineOf(fresh, watermark));
    const view = sub.activity ? activityView(fresh) : null;
    return [{ kind: 'delta', batch: view ? { ...batch, schemaVersion: 2, view } : batch }];
  }

  /** A catch-up the reader must refetch for: null the first time in a window
   * (send the gap), else adopt the fresh graph silently so refetches cannot loop. */
  private gap(sub: WorkGraphStreamSubscription, viewerId: string, fresh: Snapshot): readonly unknown[] | null {
    const key = JSON.stringify([viewerId, sub.scope.personId, sub.scope.day, sub.scope.timezone]);
    const last = this.gaps.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < GAP_WINDOW_MS) { this.set(sub, baselineOf(fresh)); return []; }
    this.gaps.set(key, now);
    if (this.gaps.size > 1024) this.gaps.delete(this.gaps.keys().next().value!);
    return null;
  }

  /** A socket went away: everything its subscriptions held. */
  forgetClient(clientId: string): void {
    const subs = this.baselines.get(clientId);
    if (!subs) return;
    this.size -= subs.size;
    this.baselines.delete(clientId);
  }
  stats(): { clients: number; baselines: number } { return { clients: this.baselines.size, baselines: this.size }; }

  private get(sub: WorkGraphStreamSubscription): Baseline | undefined {
    return this.baselines.get(sub.clientId)?.get(sub.subscriptionGeneration);
  }
  private set(sub: WorkGraphStreamSubscription, baseline: Baseline): void {
    let subs = this.baselines.get(sub.clientId);
    if (!subs) { subs = new Map(); this.baselines.set(sub.clientId, subs); }
    if (!subs.has(sub.subscriptionGeneration)) this.size++;
    subs.delete(sub.subscriptionGeneration);
    subs.set(sub.subscriptionGeneration, baseline);
    // A reader that recovered opens a new generation; older ones of the same
    // socket are over (the library caps live subscriptions per socket at 8).
    while (subs.size > 8) { subs.delete(subs.keys().next().value!); this.size--; }
    while (this.size > BASELINE_MAX) {
      const [clientId, oldest] = this.baselines.entries().next().value!;
      this.size -= oldest.size; this.baselines.delete(clientId);
    }
  }
  private drop(sub: WorkGraphStreamSubscription): void {
    const subs = this.baselines.get(sub.clientId);
    if (subs?.delete(sub.subscriptionGeneration)) {
      this.size--;
      if (!subs.size) this.baselines.delete(sub.clientId);
    }
  }
}

function refusal(error: unknown): boolean {
  return error instanceof AppError && (error.status === 401 || error.status === 403);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

/** The `workGraph()` service slice this module drives. */
export interface WorkGraphStreamPublisher {
  publish(channel: string, change?: unknown): Promise<{ delivered: number }>;
  signalAccess(channel: string): Promise<{ restored: number }>;
}
interface PeerEvents {
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, handler: (payload: string) => void | Promise<void>): () => void;
}

export interface OrgiqWorkGraphStream {
  channelFor: (scope: WorkGraphStreamScope, ctx: WorkGraphChannelContext) => string | null;
  source: OrgiqWorkGraphSource;
  /** Router plugin: a socket's disconnect forgets what its subscriptions held. */
  plugin: { name: string; onDisconnect: (info: { clientId: string }) => void };
  attach(service: WorkGraphStreamPublisher, peers: PeerEvents | null): () => void;
  /** Local replica only (peers get theirs through the peer event). */
  publishLocal(change: WorkGraphChange): Promise<void>;
  signalAccessLocal(): Promise<void>;
  channels(): string[];
}

const TRACKED_MAX = 4096;

export function createOrgiqWorkGraphStream(): OrgiqWorkGraphStream {
  const source = new OrgiqWorkGraphSource();
  // Channels this replica mapped a subscription to (bounded, most recent last).
  const tracked = new Map<string, true>();
  let service: WorkGraphStreamPublisher | null = null;
  // One publish per channel at a time; a change during it runs once more after.
  const running = new Map<string, { again: WorkGraphChange | null }>();
  const publishChannel = async (channel: string, change: WorkGraphChange): Promise<void> => {
    const state = running.get(channel);
    if (state) { state.again = state.again?.cause === 'access' ? state.again : change; return; }
    const own = { again: null as WorkGraphChange | null };
    running.set(channel, own);
    try {
      let next: WorkGraphChange | null = change;
      while (next && service) {
        own.again = null;
        await service.publish(channel, next).catch((error: unknown) => console.warn(`[work-graph] publish on ${channel} failed`, error));
        next = own.again;
      }
    } finally { running.delete(channel); }
  };

  const stream: OrgiqWorkGraphStream = {
    channelFor(scope, ctx) {
      const auth = ctx.userContext;
      if (!auth || typeof auth['userId'] !== 'string' || !auth['userId']) return null;
      // `run:<id>` and `workspace:pipelines` are pipelines subjects; every other subject is orgiq's.
      const tenant: WorkGraphTenant = scope.personId.startsWith('run:') || scope.personId === 'workspace:pipelines' ? 'pipelines'
        : scope.personId.startsWith('team:') || scope.personId === 'workspace:assessment' ? 'assessment'
          : scope.personId.startsWith('conversation:') || scope.personId === 'workspace:social' ? 'social' : 'orgiq';
      const subject = parseWorkGraphSubject(scope.personId, tenant);
      if (!subject) return null;
      // The REST snapshot's gate, cheaply first (the router's authorize then
      // decides against the reloaded session): the active tenant or admin.
      // A placeholder carries nothing, so it may wait in any tenant.
      if (!ctx.awaitAccess && auth['org'] !== tenant && auth['role'] !== 'admin') return null;
      const channel = workGraphStreamChannel(subject, tenant);
      if (tenantChannelFamily(channel)?.id !== `${tenant}:workgraph`) return null;
      tracked.delete(channel); tracked.set(channel, true);
      if (tracked.size > TRACKED_MAX) tracked.delete(tracked.keys().next().value!);
      return channel;
    },
    source,
    plugin: { name: 'orgiq-work-graph-stream', onDisconnect: ({ clientId }) => source.forgetClient(clientId) },
    async publishLocal(change) {
      if (!service) return;
      await Promise.all([...tracked.keys()].filter(channel => concerns(channel, change)).map(channel => publishChannel(channel, change)));
    },
    async signalAccessLocal() {
      if (!service) return;
      const svc = service;
      await Promise.all([...tracked.keys()].map(async channel => {
        await svc.signalAccess(channel).catch(() => undefined);
        await publishChannel(channel, { cause: 'access' });
      }));
    },
    channels: () => [...tracked.keys()],
    attach(next, peers) {
      service = next;
      const stopPeers = peers ? [
        ...[WORK_GRAPH_PEER_TOPIC, PIPELINES_WORK_GRAPH_PEER_TOPIC, ASSESSMENT_WORK_GRAPH_PEER_TOPIC, SOCIAL_WORK_GRAPH_PEER_TOPIC].map(topic => peers.subscribe(topic, payload => {
          try { const change = parseChange(JSON.parse(payload)); if (change) return stream.publishLocal(change); } catch { /* a hint, never a record */ }
          return undefined;
        })),
        peers.subscribe(WORK_GRAPH_ACCESS_PEER_TOPIC, () => stream.signalAccessLocal()),
      ] : [];
      // A host (or test double) whose directory emits no change signal still
      // gets every revocation at the next publish's readability check.
      const stopDirectory = typeof identity.onDirectoryChange === 'function'
        ? identity.onDirectoryChange(() => { void signalWorkGraphAccess(); }) : () => undefined;
      active = { stream, peers };
      return () => {
        for (const stop of stopPeers) stop();
        stopDirectory();
        if (active?.stream === stream) active = null;
        service = null;
        tracked.clear();
      };
    },
  };
  return stream;
}

let active: { stream: OrgiqWorkGraphStream; peers: PeerEvents | null } | null = null;

/** Something on the work graph moved: every replica recomputes its subscribers' frames. */
export async function publishWorkGraphChange(change: WorkGraphChange): Promise<void> {
  const current = active;
  if (!current) return;
  const clean = parseChange(change);
  if (!clean) return;
  await Promise.all([
    current.stream.publishLocal(clean),
    current.peers?.publish(clean.tenant === 'pipelines' ? PIPELINES_WORK_GRAPH_PEER_TOPIC : clean.tenant === 'assessment' ? ASSESSMENT_WORK_GRAPH_PEER_TOPIC
      : clean.tenant === 'social' ? SOCIAL_WORK_GRAPH_PEER_TOPIC : WORK_GRAPH_PEER_TOPIC, JSON.stringify(clean)).catch(error => console.warn('[work-graph] peer publish failed', error)),
  ]);
}

/** A committed grant/epoch change: every replica re-asks its open streams and placeholders. */
export async function signalWorkGraphAccess(): Promise<void> {
  const current = active;
  if (!current) return;
  await Promise.all([
    current.stream.signalAccessLocal(),
    current.peers?.publish(WORK_GRAPH_ACCESS_PEER_TOPIC, '{}').catch(error => console.warn('[work-graph] peer access signal failed', error)),
  ]);
}

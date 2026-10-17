// The orgiq, pipelines AND assessment activity/work graphs on the client (docs/activity-graph-migration.md):
// the transport realtime-modules' `useWorkGraph` drives, and the pure mapping
// from its `ClientWorkGraphState` onto ui-components' `WorkGraph` props.
//
// Live updates ride the gateway's `workGraph()` stream (realtime-modules 0.108,
// middleware lib/work-graph/stream.ts) through the library's own
// `createWorkGraphGatewayTransport`: the hook fetches its authorized snapshot,
// then opens a stream from that snapshot's cursor; the BFF sends THIS viewer's
// deltas, rebuilt from the viewer's own snapshot, and a content-free
// `invalidate` when access changes.
//
// Fallback only — a stream the gateway refused, or no connected gateway: the
// content-free `work-graph.changed` hint on `orgiq:workgraph` (lib/work-graph/
// live.ts). The transport answers a hint by asking the hook for a fresh
// snapshot (`reset-required` / `gap`, which keeps the last authorized graph on
// screen). No graph data ever rides the hint.

import { workDayWindow } from '@connorhoehn/realtime-modules/work-graph';
import { createWorkGraphGatewayTransport } from '@connorhoehn/realtime-modules/client';
import type {
  ClientWorkGraphState, WorkGraphClientTransport, WorkGraphGatewayConnection, WorkGraphSnapshotRequest, WorkGraphSocketRequest,
} from '@connorhoehn/realtime-modules/client';
import { WORK_NODE_KIND_LABELS } from '@connorhoehnslalom/ui-components/graph';
import type {
  WorkActivityNodeDetail, WorkActivityPresentation, WorkActivityView, WorkActivityWindow, WorkGraphNodeData, WorkGraphEdgeData,
} from '@connorhoehnslalom/ui-components/graph';

export const WORK_GRAPH_CHANNEL = 'orgiq:workgraph';
export const PIPELINES_WORK_GRAPH_CHANNEL = 'pipelines:workgraph';
export const ASSESSMENT_WORK_GRAPH_CHANNEL = 'assessment:workgraph';
export const SOCIAL_WORK_GRAPH_CHANNEL = 'social:workgraph';
export const WORK_GRAPH_HINT = 'work-graph.changed';

/** `person`: one person's working day (assignee / steward / decision participant; own flow runs).
 * `run` / `pipelines`: the pipelines tenant's graphs — one run's page, or every run of the day.
 * `team` / `assessment`: the assessment tenant's — one team's scorecard, or every team with work in the day. */
export type WorkGraphSubject =
  | { kind: 'initiative'; id: string } | { kind: 'workspace' } | { kind: 'person'; id: string }
  | { kind: 'run'; id: string } | { kind: 'pipelines' }
  | { kind: 'team'; id: string } | { kind: 'assessment' }
  | { kind: 'conversation'; id: string; plane?: boolean } | { kind: 'social' }
  /** Another tenant's Communication plane: one person's work as THIS viewer may see it (sharing grants,
   *  filtered on the server — GET /api/social/plane/people/:userId/shared-work). */
  | { kind: 'shared-work'; id: string };

/** The contract's `personId` slot carries the graph's subject (middleware snapshot.ts `subjectKey`). */
export function workGraphSubjectKey(subject: WorkGraphSubject): string {
  switch (subject.kind) {
    case 'workspace': return 'workspace';
    case 'pipelines': return 'workspace:pipelines';
    case 'assessment': return 'workspace:assessment';
    case 'social': return 'workspace:social';
    default: return `${subject.kind}:${subject.id}`;
  }
}
/** The activity channel the content-free fallback hint rides, by the subject's tenant. */
export function workGraphHintChannel(subject: WorkGraphSubject): string {
  if (subject.kind === 'conversation' || subject.kind === 'social' || subject.kind === 'shared-work') return SOCIAL_WORK_GRAPH_CHANNEL;
  if (subject.kind === 'team' || subject.kind === 'assessment') return ASSESSMENT_WORK_GRAPH_CHANNEL;
  return subject.kind === 'run' || subject.kind === 'pipelines' ? PIPELINES_WORK_GRAPH_CHANNEL : WORK_GRAPH_CHANNEL;
}
export function workGraphSnapshotPath(subject: WorkGraphSubject): string {
  if (subject.kind === 'social') return '/api/social/work-graph/workspace/graph';
  // Embedded in another tenant (the Communication plane), the same provider behind the caller's current Social grants.
  if (subject.kind === 'conversation') return `/api/social${subject.plane ? '/plane' : ''}/work-graph/conversations/${encodeURIComponent(subject.id)}/graph`;
  if (subject.kind === 'shared-work') return `/api/social/plane/people/${encodeURIComponent(subject.id)}/shared-work`;
  if (subject.kind === 'assessment') return '/api/assessment/work-graph/workspace/graph';
  if (subject.kind === 'team') return `/api/assessment/work-graph/teams/${encodeURIComponent(subject.id)}/graph`;
  if (subject.kind === 'pipelines') return '/api/pipelines/work-graph/workspace/graph';
  if (subject.kind === 'run') return `/api/pipelines/work-graph/runs/${encodeURIComponent(subject.id)}/graph`;
  if (subject.kind === 'workspace') return '/api/work-graph/workspace/graph';
  if (subject.kind === 'person') return `/api/work-graph/people/${encodeURIComponent(subject.id)}/graph`;
  return `/api/work-graph/initiatives/${encodeURIComponent(subject.id)}/graph`;
}

/** The viewer's zone, or UTC when the browser reports none the contract accepts. */
export function viewerTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone)) return zone;
  } catch { /* fall through */ }
  return 'UTC';
}
/** Today's calendar date in `timezone`, as YYYY-MM-DD. */
export function calendarDay(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function workGraphDayBounds(day: string, timezone: string): { start: number; end: number } {
  const window = workDayWindow(day, timezone);
  return { start: Date.parse(window.start), end: Date.parse(window.end) };
}
/** What to ASK for: always the whole local day (the visible window is client-side), as the reference does. */
export function workGraphQueryWindow(day: string, timezone: string): { start: string; end: string; mode: 'live' } {
  const window = workDayWindow(day, timezone);
  return { start: window.start, end: window.end, mode: 'live' };
}

/** Snapshot query string: day, zone and, for v2, the interval. `viewBase` is not
 * forwarded — orgiq streams no view patches. */
export function workGraphQueryString(request: Pick<WorkGraphSnapshotRequest, 'scope' | 'activity'>): string {
  const params = new URLSearchParams({ day: request.scope.day, timezone: request.scope.timezone });
  if (request.activity) {
    params.set('schemaVersion', '2');
    params.set('windowStart', request.activity.windowStart);
    params.set('windowEnd', request.activity.windowEnd);
    params.set('mode', request.activity.mode);
  }
  return params.toString();
}

/** Is this activity row a refetch hint for `subject`? A hint naming no
 * initiative (a run whose initiative could not be resolved) concerns every graph. */
export function isWorkGraphHint(event: { eventType: string; detail?: Record<string, unknown> }, subject: WorkGraphSubject): boolean {
  if (event.eventType !== WORK_GRAPH_HINT) return false;
  // A pipelines run page hears only its own run (or a hint naming none); the pipelines workspace, any.
  if (subject.kind === 'run') {
    const runId = event.detail?.['runId'];
    return typeof runId !== 'string' || runId === subject.id;
  }
  // A Social conversation graph hears its own conversation (or a hint naming none); the Social workspace, any.
  if (subject.kind === 'conversation') {
    const conversationId = event.detail?.['conversationId'];
    return typeof conversationId !== 'string' || conversationId === subject.id;
  }
  // An assessment team page hears only its own team (or a hint naming none); the assessment workspace, any.
  if (subject.kind === 'team') {
    const teamId = event.detail?.['teamId'];
    return typeof teamId !== 'string' || teamId === subject.id;
  }
  // A workspace or one person's day is not tied to a single initiative, so any hint concerns it.
  if (subject.kind !== 'initiative') return true;
  const initiativeId = event.detail?.['initiativeId'];
  return typeof initiativeId !== 'string' || initiativeId === subject.id;
}

/** How live updates currently reach this transport's readers. */
export type WorkGraphLiveMode = 'stream' | 'hints';

export interface OrgiqWorkGraphTransport extends WorkGraphClientTransport {
  /** A fallback hint arrived: every hint-path reader asks its hook for a fresh snapshot. */
  hint(): void;
  /** The gateway (re)connected: hint-path readers reopen, on the stream unless it was refused. */
  resume(): void;
  /** Which path the latest reader opened on. */
  mode(): WorkGraphLiveMode;
}

export interface WorkGraphTransportOptions {
  fetchImpl?: typeof fetch;
  /** The realtime connection (`useGateway()`); absent means hints only. */
  gateway?: WorkGraphGatewayConnection | null;
  isConnected?: () => boolean;
  onModeChange?: (mode: WorkGraphLiveMode) => void;
  /** The whole reply, for a subject whose snapshot travels inside an envelope (`shared-work`: `{ snapshot, sharing }`). */
  onEnvelope?: (body: unknown) => void;
}

export function createWorkGraphTransport(subject: WorkGraphSubject, options: WorkGraphTransportOptions | typeof fetch = {}): OrgiqWorkGraphTransport {
  const opts: WorkGraphTransportOptions = typeof options === 'function' ? { fetchImpl: options } : options;
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const fetchSnapshot: WorkGraphClientTransport['fetchSnapshot'] = async (request) => {
    const response = await fetchImpl(`${workGraphSnapshotPath(subject)}?${workGraphQueryString(request)}`, {
      credentials: 'same-origin', headers: { accept: 'application/json' }, signal: request.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`work graph ${response.status}`), { status: response.status });
    if (subject.kind !== 'shared-work') return response.json();
    // GET …/shared-work answers `{ snapshot, sharing }`: the hook takes the snapshot, the host the sharing facts.
    // The server scopes the snapshot to this request's subject (`shared-work:<userId>`, middleware
    // lib/work-graph/shared-work.ts `sharedWorkSubjectKey`) — the one key the hook checks; nothing is re-keyed here.
    const body: unknown = await response.json();
    opts.onEnvelope?.(body);
    const snapshot = body && typeof body === 'object' && 'snapshot' in body ? (body as { snapshot: unknown }).snapshot : body;
    return snapshot as Awaited<ReturnType<WorkGraphClientTransport['fetchSnapshot']>>;
  };
  const stream = opts.gateway ? createWorkGraphGatewayTransport({ gateway: opts.gateway, fetchSnapshot, ...(opts.isConnected ? { isConnected: opts.isConnected } : {}) }) : null;
  const hinted = new Set<WorkGraphSocketRequest>();
  // Once the gateway refuses this subject's stream, live updates stay on hints.
  let refused = false;
  let mode: WorkGraphLiveMode = stream ? 'stream' : 'hints';
  const setMode = (next: WorkGraphLiveMode) => { if (next !== mode) { mode = next; opts.onModeChange?.(next); } };
  const streamable = () => !!stream && !refused && (opts.isConnected?.() ?? true);
  const restart = () => {
    for (const request of [...hinted]) {
      request.onMessage({ kind: 'reset-required', subscriptionGeneration: request.subscriptionGeneration, reason: 'gap' });
    }
  };
  return {
    fetchSnapshot,
    openWebSocket(request) {
      if (streamable()) {
        setMode('stream');
        return stream!.openWebSocket({
          ...request,
          onError() {
            // A refusal (WORK_GRAPH_SUBSCRIBE_REFUSED): fall back to hints for this subject.
            refused = true;
            setMode('hints');
            request.onError();
          },
        });
      }
      // A refused snapshot waits for an access signal only the stream sends;
      // on the hint path the reader keeps its "Try again". Nothing is registered.
      if (request.awaitAccess) return { close() {} };
      setMode('hints');
      hinted.add(request);
      return { close() { hinted.delete(request); } };
    },
    hint: restart,
    resume() { if (streamable()) restart(); },
    mode: () => mode,
  };
}

// ── Presentation ────────────────────────────────────────────────────────────

export type WorkGraphViewState = 'loading' | 'ready' | 'empty' | 'partial' | 'error';
export function workGraphViewState(status: string, error: string | null, nodeCount: number): WorkGraphViewState {
  if (error || status === 'error') return 'error';
  if (status === 'ready') return nodeCount === 0 ? 'empty' : 'ready';
  if (status === 'partial') return nodeCount === 0 ? 'empty' : 'partial';
  return 'loading';
}

export const EMPTY_WORK_ACTIVITY_VIEW: WorkActivityView = { focusedEffortId: null, expandedSourceEfforts: [] };

/** The day so far, following now while the day lasts. */
export function defaultWorkGraphWindow(bounds: { start: number; end: number }, now: number): WorkActivityWindow {
  return { start: bounds.start, end: Math.min(Math.max(now, bounds.start), bounds.end), following: now < bounds.end };
}

export interface PresentationInput {
  graph: Pick<ClientWorkGraphState, 'nodes' | 'edges' | 'activity'>;
  day: string;
  timezone: string;
  now: number;
  window?: WorkActivityWindow;
  view?: WorkActivityView;
  mode: 'split' | 'full';
  title?: string;
  subtitle?: string;
  /** The library header's kinds-and-counts legend. */
  kindLegend?: boolean;
  onPopOut?: () => void;
  onWindowChange: (window: WorkActivityWindow) => void;
  onViewChange: (view: WorkActivityView) => void;
}

/** The controlled activity presentation, or null when the snapshot carried no
 * effort (the canvas then draws the plain graph, as the reference does). */
export function workGraphPresentation(input: PresentationInput): WorkActivityPresentation | null {
  const activity = input.graph.activity;
  if (!activity || activity.efforts.length === 0) return null;
  const nodes = input.graph.nodes, edges = input.graph.edges;
  const efforts = activity.efforts.map(effort => ({
    id: effort.id, title: effort.title, ...(effort.subtitle ? { subtitle: effort.subtitle } : {}),
    nodeIds: effort.nodeIds.filter(id => id in nodes),
    edgeIds: effort.edgeIds.filter(id => id in edges),
    contextNodeIds: effort.contextNodeIds.filter(id => id in nodes),
  })).filter(effort => effort.nodeIds.length > 0);
  if (efforts.length === 0) return null;
  const context = new Set(efforts.flatMap(e => e.contextNodeIds));
  const details: Record<string, WorkActivityNodeDetail> = {};
  for (const detail of activity.details) {
    if (!(detail.nodeId in nodes)) continue;
    const lines = [detail.summary, ...(detail.lines ?? [])].filter((l): l is string => !!l).slice(0, 4);
    const fresh = detail.freshness ? Date.parse(detail.freshness.expiresAt) > input.now : false;
    const workItem = detail.workItem && detail.workItem.nodeId in nodes ? detail.workItem : undefined;
    details[detail.nodeId] = {
      ...(context.has(detail.nodeId) ? { emphasis: 'earlier' as const } : {}),
      ...(fresh ? { fresh: true } : {}),
      ...(lines.length ? { lines } : {}),
      ...(detail.badge ? { badge: detail.badge } : {}),
      ...(detail.excerpt ? { excerpt: detail.excerpt } : {}),
      ...(detail.participants?.length ? { participants: detail.participants.map(p => ({ id: p.id, label: p.label })) } : {}),
      ...(detail.footer ? { footer: detail.footer } : {}),
      ...(detail.pause ? { pause: detail.pause } : {}),
      ...(workItem ? { sections: { workItem: { id: workItem.nodeId, title: workItem.label, selection: { kind: 'node' as const, id: workItem.nodeId } } } } : {}),
    };
  }
  // The inspector's subtitle says what the node is and where it stands
  // ("Run · Completed"), so a selected card is never just a title.
  for (const node of Object.values(nodes)) {
    details[node.id] = { ...details[node.id], subtitle: workNodeKindStatus(node) };
  }
  const activeEdgeIds = [...new Set(activity.operations
    .filter(op => op.edgeId in edges && Date.parse(op.expiresAt) > input.now)
    .map(op => op.edgeId))];
  const bounds = workGraphDayBounds(input.day, input.timezone);
  const events = activity.eventBuckets
    .map(bucket => ({ at: Date.parse(bucket.at), count: bucket.count }))
    .filter(bucket => Number.isFinite(bucket.at))
    .sort((a, b) => a.at - b.at);
  return {
    efforts, details, activeEdgeIds,
    mode: input.mode,
    window: input.window ?? defaultWorkGraphWindow(bounds, input.now),
    bounds,
    // Latest state, not a reconstruction of the selected minutes.
    temporalMode: activity.temporal.mode === 'as-of' ? 'as-of' : 'recent',
    ...(events.length ? { events } : {}),
    now: input.now,
    view: input.view ?? EMPTY_WORK_ACTIVITY_VIEW,
    detailsPlacement: 'auto',
    ...(input.title ? { title: input.title } : {}),
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    ...(input.kindLegend ? { kindLegend: true } : {}),
    ...(efforts.length > 1 ? { viewNote: 'Newest work first' } : {}),
    ...(input.onPopOut ? { onPopOut: input.onPopOut } : {}),
    onWindowChange: input.onWindowChange,
    onViewChange: input.onViewChange,
  };
}

const STATUS_LABEL: Record<WorkGraphNodeData['status'], string> = {
  idle: 'Idle', running: 'Running', waiting: 'Waiting', completed: 'Completed', error: 'Failed', stopped: 'Stopped', stale: 'Stale',
};
/** "Run · Completed": the node's kind, in the legend's words, and its status. */
export function workNodeKindStatus(node: Pick<WorkGraphNodeData, 'kind' | 'status'>): string {
  return `${WORK_NODE_KIND_LABELS[node.kind] ?? node.kind} · ${STATUS_LABEL[node.status] ?? node.status}`;
}

/** What a subject's graph is about, for its header: the scope noun, and the
 *  title a workspace-wide graph carries (one subject's graph is titled by its
 *  own node, which the snapshot names). */
const SUBJECT_HEADING: Record<WorkGraphSubject['kind'], { noun: string; title?: string }> = {
  initiative: { noun: 'Initiative' }, workspace: { noun: 'Work graph', title: 'All initiatives' }, person: { noun: 'Person' },
  run: { noun: 'Pipeline run' }, pipelines: { noun: 'Work graph', title: 'All pipeline runs' },
  team: { noun: 'Assessment team' }, assessment: { noun: 'Work graph', title: 'All assessments' },
  conversation: { noun: 'Conversation' }, social: { noun: 'Work graph', title: 'All conversations' },
  'shared-work': { noun: 'Shared work' },
};
const LIVE_LABEL = { stream: 'Live', hints: 'Live · refreshes on change', off: 'Not live · reload for changes' } as const;

export interface WorkGraphHeadingInput {
  subject: WorkGraphSubject;
  subjectKey: string;
  nodes: Record<string, Pick<WorkGraphNodeData, 'title'>>;
  day: string;
  timezone: string;
  /** The host's own name for it, when it has one. */
  title?: string;
  /** People the snapshot names (activity participants): a person's graph is titled by their name. */
  people?: ReadonlyArray<{ id: string; label: string }>;
  live: keyof typeof LIVE_LABEL;
  today?: string;
}

/** "Tue, Oct 7" for a YYYY-MM-DD day (a calendar date, so formatted in UTC). */
export function workGraphDayLabel(day: string): string {
  const at = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(at) : day;
}

/** The header's title and caption: the subject, then "<scope> · <day> · <live state>". */
export function workGraphHeading(input: WorkGraphHeadingInput): { title: string; subtitle: string } {
  const spec = SUBJECT_HEADING[input.subject.kind];
  const person = input.subject.kind === 'person' ? input.people?.find(p => p.id === (input.subject as { id: string }).id)?.label : undefined;
  const own = input.nodes[input.subjectKey]?.title ?? (person ? `${person}’s day` : undefined);
  const title = input.title ?? spec.title ?? own ?? ('id' in input.subject ? input.subject.id : spec.noun);
  const today = input.today ?? calendarDay(input.timezone);
  const day = `${input.day === today ? 'Today, ' : ''}${workGraphDayLabel(input.day)}`;
  return { title, subtitle: [spec.noun, day, LIVE_LABEL[input.live]].join(' · ') };
}

/** Where opening a node goes — the page that already serves that entity. Null
 * for anything the id does not name plainly (a hashed id), so nothing guesses. */
export function workGraphNodeHref(nodeId: string, edges: Record<string, WorkGraphEdgeData>, nodes: Record<string, WorkGraphNodeData>): string | null {
  const [kind, ...rest] = nodeId.split(':');
  const id = rest.join(':');
  if (!id || id.startsWith('h.')) return null;
  // Pipelines nodes (middleware pipelines-projection.ts). A step or a flow run opens the run it belongs to.
  const pipelinesRun = (from: string): string | null => {
    const to = Object.values(edges).find(e => e.fromId === from && e.toId.startsWith('prun:'))?.toId;
    return to ? workGraphNodeHref(to, edges, nodes) : null;
  };
  switch (kind) {
    case 'prun': return `/pipelines/runs/${encodeURIComponent(id)}`;
    case 'step': case 'pflow': return pipelinesRun(nodeId);
    case 'approval': return '/pipelines/approvals';
    case 'deck': return `/pipelines/decks/${encodeURIComponent(id)}`;
    case 'definition': return '/pipelines/definitions';
    default: break;
  }
  // Social nodes (middleware social-projection.ts). A conversation node's id carries its chat channel name
  // (`sconv:social:ch:<slug>`, `social:dm:<a>:<b>`, `social:team:<team>:<channel>`, `social:room:<slug>`); a hashed id opens nothing.
  // A thread, call, recording, deck or flow run opens the conversation it hangs off (its edge), else its own list page.
  const social = (from: string): string | null => {
    const to = Object.values(edges).find(e => e.fromId === from && e.toId.startsWith('sconv:'))?.toId;
    return to ? workGraphNodeHref(to, edges, nodes) : null;
  };
  switch (kind) {
    case 'sconv': {
      const ch = /^social:ch:(.+)$/.exec(id)?.[1];
      if (ch) return `/social/channels/${encodeURIComponent(ch)}`;
      if (id.startsWith('social:dm:')) return `/social/dms/${encodeURIComponent(id)}`;
      if (/^social:team:[^:]+:[^:]+$/.test(id)) return `/social/teams?channel=${encodeURIComponent(id)}`;
      const room = /^social:room:(.+)$/.exec(id)?.[1];
      return room ? `/social/rooms?room=${encodeURIComponent(room)}` : null;
    }
    case 'steam': return '/social/teams';
    case 'sthread': case 'sdeck': case 'sflow': return social(nodeId) ?? (kind === 'sdeck' ? `/social/decks/${encodeURIComponent(id)}` : null);
    case 'scall': return social(nodeId) ?? '/social/calls';
    case 'srec': return social(nodeId) ?? '/social/recordings';
    default: break;
  }
  // Assessment nodes (middleware assessment-projection.ts): a dimension, evidence row or draft opens its team's
  // scorecard (at the dimension, where one is drawn); a deck its deck page; an agent run the ledger.
  const target = (from: string) => Object.values(edges).find(e => e.fromId === from && (e.toId.startsWith('dim:') || e.toId.startsWith('team:')))?.toId ?? null;
  switch (kind) {
    case 'team': return `/assessment/teams/${encodeURIComponent(id)}`;
    case 'dim': {
      const [team, ...dim] = id.split(':');
      return team && dim.length ? `/assessment/teams/${encodeURIComponent(team)}?dimension=${encodeURIComponent(dim.join(':'))}` : null;
    }
    case 'evidence': case 'draft': {
      const to = target(nodeId);
      const [team, ...dim] = to ? to.slice(to.indexOf(':') + 1).split(':') : (kind === 'evidence' ? [id.split(':')[0]] : []);
      if (!team) return null;
      return `/assessment/teams/${encodeURIComponent(team)}?tab=${kind === 'evidence' ? 'evidence' : 'scorecard'}${dim.length ? `&dimension=${encodeURIComponent(dim.join(':'))}` : ''}`;
    }
    case 'adeck': return `/assessment/decks/${encodeURIComponent(id)}`;
    case 'arun': case 'aflow': return '/assessment/runs';
    default: break;
  }
  const out = (relation: string) => Object.values(edges).filter(e => e.fromId === nodeId && e.relation === relation).map(e => e.toId);
  const initiativeOf = (workNode: string): string | null => {
    const target = Object.values(edges).find(e => e.fromId === workNode && e.relation === 'works-on' && e.toId.startsWith('initiative:'));
    return target ? target.toId.slice('initiative:'.length) : null;
  };
  switch (kind) {
    case 'initiative': return `/iq/projects/${encodeURIComponent(id)}`;
    case 'work': {
      const project = initiativeOf(nodeId);
      return project ? `/iq/projects/${encodeURIComponent(project)}?tab=work&item=${encodeURIComponent(id)}` : null;
    }
    // A queue job and a flow run open the work item they operate on, else their initiative.
    case 'run': case 'job': case 'flow': {
      const work = out('operates-on').find(to => to.startsWith('work:') && to in nodes);
      if (work) return workGraphNodeHref(work, edges, nodes);
      const bot = Object.values(edges).find(e => e.toId === nodeId && e.fromId.startsWith('agent:'));
      if (bot) return workGraphNodeHref(bot.fromId, edges, nodes);
      const project = out('works-on').find(to => to.startsWith('initiative:'));
      return project ? workGraphNodeHref(project, edges, nodes) : null;
    }
    // A sprint has no page of its own: the Sprints lens on the initiatives list.
    case 'sprint': return '/iq/projects?lens=sprints';
    // A decision is a record page of its own, raised against an initiative or org-wide.
    case 'decision': return `/iq/decisions/${encodeURIComponent(id)}`;
    case 'agent': return `/iq/bots/${encodeURIComponent(id)}`;
    case 'doc': return `/iq/documents/${encodeURIComponent(id)}`;
    default: return null;
  }
}

export interface RecentWorkEvent {
  id: string;
  title: string;
  /** "Run · succeeded" — the node's kind and its latest status, already worded. */
  what: string;
  /** Who did it, when the snapshot's node detail names a participant. */
  actor: string | null;
  at: string;
  href: string | null;
}

/** The newest events in a snapshot: its nodes by `updatedAt`, newest first. The
 *  subject's own root node is not an event. Read off the same snapshot the
 *  canvas draws, so the Overview list and the Activity tab cannot disagree. */
export function recentWorkEvents(
  graph: Pick<ClientWorkGraphState, 'nodes' | 'edges' | 'activity'>,
  limit: number,
): RecentWorkEvent[] {
  const details = new Map((graph.activity?.details ?? []).map(d => [d.nodeId, d]));
  return Object.values(graph.nodes)
    .filter(node => node.kind !== 'project' && Number.isFinite(Date.parse(node.updatedAt)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map(node => {
      const kind = node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
      return {
        id: node.id,
        title: node.title,
        what: `${kind} · ${String(node.status).replace(/[-_]/g, ' ')}`,
        actor: details.get(node.id)?.participants?.[0]?.label ?? null,
        at: node.updatedAt,
        href: workGraphNodeHref(node.id, graph.edges, graph.nodes),
      };
    });
}

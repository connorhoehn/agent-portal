// The orgiq work graph: a pure projection of rows this BFF already serves over
// REST into the realtime-modules work-graph viewer contract (`/work-graph`),
// so the library's `useWorkGraph` + ui-components' `WorkGraph` can render it.
//
// Design record: docs/activity-graph-migration.md. The short version:
//
//   - Nothing here is a second store. Every node is one source row the caller
//     already read through the same provider the REST route uses (initiative,
//     work item, bot run, bot, linked document); every count and timestamp is
//     that row's own. The projection only chooses which rows fall in the day
//     and names their relationships.
//   - Authorization happened before this function: the caller passes only rows
//     the viewer's REST read gates admit (lib/work-graph/authority.ts). Nothing
//     here infers access, and an omitted row leaves no placeholder or count.
//   - Day membership uses the library's own rule (`intervalOverlapsWorkDay`):
//     an item open across the day overlaps it; one finished before it does not.
//
// The reference (platform-api) projects lifecycle events; orgiq has rows, not
// an event log, so temporal mode is always `recent` (latest state), never an
// `as-of` reconstruction.

import { createHash } from 'node:crypto';
import { intervalOverlapsWorkDay } from './day-overlap.js';
import {
  workDayWindow,
  WORK_GRAPH_LIMITS,
  type ViewerWorkEdge,
  type ViewerWorkNode,
  type WorkDayWindow,
  type WorkRelation,
  type WorkStatus,
  type CollaborationCapability,
  type ViewerWorkActivityDetail,
  type ViewerWorkOperation,
} from '@connorhoehn/realtime-modules/work-graph';
import { detailsForDisclosedNodes } from '@connorhoehn/realtime-modules/work-graph/server';
import type { DecisionActivityRow } from '../../providers/decisions.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A sprint's calendar day as a reader says it ("Oct 5"); anything that is not a plain date is left as it came. */
function calendarDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[2])}` : day;
}

// ── Source rows (the subset of each provider type the projection reads) ─────

export interface InitiativeRow { id: string; name: string; status: string | null; createdAt: string | null; ownerName?: string | null }
export interface WorkItemRow {
  id: string; projectId: string; parentId: string | null; type: string; title: string; status: string; priority: string;
  assigneeId: string | null; assigneeName: string | null; blockedReason: string | null; nextStep: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  /** `work_items.sprint_id`, when the row says. */
  sprintId?: string | null;
}
export interface BotRow { id: string; name: string; model: string; enabled: boolean; pausedReason?: string | null; orgProjectId: string | null }
export interface RunRow {
  id: string; botId: string | null; trigger: string; workItemId: string | null; status: string;
  costUsd: number | null; modelProvider: string | null; startedAt: string; finishedAt: string | null;
  /** The initiative the run is attributed to (bot target or work item's initiative). */
  projectId: string;
  /** `bot_runs.job_id`: the queue row this run executed (the job node is then not drawn twice). */
  jobId?: string | null;
}
export interface DocumentLinkRow { workItemId: string; documentId: string; title: string | null; source: string | null; linkedAt: string }
/** One `sprints` row with the rollups `/api/sprints` serves (providers/sprints.ts). Dates are DATE columns. */
export interface SprintGraphRow {
  id: string; orgProjectId: string; name: string; goal: string | null; stewardPersonId: string | null; stewardName: string | null;
  startsOn: string | null; endsOn: string | null; status: string;
  itemCount: number; doneItemCount: number; pointsTotal: number; pointsDone: number;
  /** Money the sprints route serves: read only behind the budgets read tier (`reads.sprintsWide`). */
  estimatedCostUsd: number; grantedUsd: number; grantCount: number;
  /** Envelope rows (budget_grants), loaded only behind the grants read gate (`reads.grants`). */
  envelopes?: Array<{ granteeName: string | null; allocatedUsd: number }>;
}
export type DecisionGraphRow = DecisionActivityRow;
/** One durable `flow_runs` row the viewer requested themselves (requester-private). Source material and results are never carried. */
export interface FlowRunGraphRow {
  id: string; kind: string; scope: string; status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed';
  steps: Array<{ status: string }>; createdAt: string; updatedAt: string; finishedAt: string | null; leaseExpiresAt: string | null;
}

/** One live `agent_jobs` row (queued, claimed or running) attributed to an initiative. The prompt, payload and result are never carried. */
export interface JobGraphRow {
  id: string; kind: string; title: string; status: 'queued' | 'claimed' | 'running'; botId: string | null;
  /** The initiative the job's payload (or its bot's target) names, and the work item it serves, when it names one. */
  projectId: string; workItemId: string | null;
  createdAt: string; claimedAt: string | null; startedAt: string | null;
}

/** What the viewer may read, decided per request from the REST read gates. */
export interface ViewerReads {
  /** `/api/bots/:id/runs`, `/api/bots/runs`, `/api/bots/:id` read gate. */
  botRuns: boolean;
  /** `/api/bots/marketplace-runs` read gate. */
  marketplaceRuns: boolean;
  /** DispatchAgentRun: the initiative/work discussion's write authority. */
  dispatch: boolean;
  /** `/api/sprints?scope=all` and the money it carries: the budgets read tier. */
  sprintsWide: boolean;
  /** `/api/grants` read gate: envelope rows. */
  grants: boolean;
}

export interface ProjectionInput {
  window: Pick<WorkDayWindow, 'start' | 'end'>;
  /** The instant the rows were read; leases and `updatedAt` fallbacks use it. */
  observedAt: string;
  /** `initiative`: always draw the initiative node; `workspace`: only initiatives with work in the day. */
  scope: 'initiative' | 'workspace';
  initiatives: InitiativeRow[];
  items: WorkItemRow[];
  bots: BotRow[];
  runs: RunRow[];
  documents: DocumentLinkRow[];
  sprints?: SprintGraphRow[];
  decisions?: DecisionGraphRow[];
  flowRuns?: FlowRunGraphRow[];
  /** Live queue rows; drawn only behind the dispatch-tier gate (`reads.marketplaceRuns`). */
  jobs?: JobGraphRow[];
  /** The viewer's zone: sprint and decision dates are calendar days in it. */
  timezone?: string;
  reads: ViewerReads;
}

export interface Projection {
  nodes: ViewerWorkNode[];
  edges: ViewerWorkEdge[];
  details: ViewerWorkActivityDetail[];
  operations: ViewerWorkOperation[];
  /** Source instants inside the day, one per row timestamp, for `bucketWorkEvents`. */
  observations: Array<{ at: string }>;
  /** Authorized nodes held back under the node cap (newest kept). */
  omitted: number;
}

// ── Identifiers ─────────────────────────────────────────────────────────────

export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A source id that cannot be carried verbatim is hashed rather than dropped. */
export function part(sourceId: string): string {
  return ID.test(sourceId) && sourceId.length <= 100 ? sourceId : `h.${createHash('sha256').update(sourceId).digest('hex').slice(0, 24)}`;
}
export const nodeIdFor = {
  initiative: (id: string) => `initiative:${part(id)}`,
  work: (id: string) => `work:${part(id)}`,
  run: (id: string) => `run:${part(id)}`,
  agent: (id: string) => `agent:${part(id)}`,
  document: (id: string) => `doc:${part(id)}`,
  sprint: (id: string) => `sprint:${part(id)}`,
  decision: (id: string) => `decision:${part(id)}`,
  flowRun: (id: string) => `flow:${part(id)}`,
  job: (id: string) => `job:${part(id)}`,
};
export function edgeIdFor(relation: WorkRelation, fromId: string, toId: string): string {
  return `edge.${relation}.${createHash('sha256').update(`${fromId}\u0000${toId}`).digest('hex').slice(0, 20)}`;
}

// ── Values ──────────────────────────────────────────────────────────────────

/** Strict `YYYY-MM-DDTHH:mm:ss.sssZ`. A zone-less Postgres string is UTC (the
 * Data API's naive TIMESTAMPTZ rendering; CLAUDE.md devbox gotcha). */
export function isoInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = /[zZ]|[+-]\d{2}(:?\d{2})?$/.test(value.trim()) ? value.trim() : `${value.trim().replace(' ', 'T')}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function clip(text: string, max: number = WORK_GRAPH_LIMITS.labelLength): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
export const latest = (...values: Array<string | null | undefined>): string | null =>
  values.filter((v): v is string => !!v).sort().at(-1) ?? null;
export const earliest = (...values: Array<string | null | undefined>): string | null =>
  values.filter((v): v is string => !!v).sort()[0] ?? null;
export const words = (value: string): string => {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : value;
};

// `running` in this contract is a PROCESS observed live (the renderer reads a
// running node without a fresh lease as "updates delayed"). An initiative or a
// work item in progress is not a process, so it stays `idle` and its badge
// carries the row's own status word; only a bot run can be `running`.
export function initiativeStatus(status: string | null): WorkStatus {
  switch (status) {
    case 'completed': case 'done': return 'completed';
    case 'on_hold': case 'paused': case 'cancelled': return 'stopped';
    default: return 'idle';
  }
}
export function workItemStatus(status: string): WorkStatus {
  switch (status) {
    case 'in_review': return 'waiting';
    case 'done': return 'completed';
    case 'cancelled': return 'stopped';
    default: return 'idle';
  }
}
export function runStatus(status: string): WorkStatus {
  switch (status) {
    case 'running': return 'running';
    case 'done': return 'completed';
    case 'failed': return 'error';
    case 'skipped': return 'stopped';
    default: return 'idle';
  }
}

/** A work item's interval: created → completed (or the closing update for a
 * cancelled/done row without `completed_at`); open items have no end. */
function itemInterval(item: WorkItemRow): { start: string; end?: string } | null {
  const created = isoInstant(item.createdAt), updated = isoInstant(item.updatedAt);
  const start = created ?? updated;
  if (!start) return null;
  const closed = item.status === 'done' || item.status === 'cancelled';
  const end = closed ? (isoInstant(item.completedAt) ?? updated ?? start) : undefined;
  return end ? { start, end: end < start ? start : end } : { start };
}
function runInterval(run: RunRow): { start: string; end?: string } | null {
  const start = isoInstant(run.startedAt);
  if (!start) return null;
  const finished = isoInstant(run.finishedAt);
  if (run.status === 'running') return { start };
  const end = finished ?? start;
  return { start, end: end < start ? start : end };
}
export const inDay = (interval: { start: string; end?: string } | null, window: Pick<WorkDayWindow, 'start' | 'end'>): boolean =>
  !!interval && intervalOverlapsWorkDay(interval.start, interval.end, window);

/** How long a `running` row counts as observed-live evidence for an animated edge. */
export const RUN_LEASE_MS = 5 * 60_000;

// ── The projection ──────────────────────────────────────────────────────────

export function projectWorkGraph(input: ProjectionInput): Projection {
  const { window, observedAt, reads } = input;
  const nodes = new Map<string, ViewerWorkNode>();
  const edges = new Map<string, ViewerWorkEdge>();
  const details = new Map<string, ViewerWorkActivityDetail>();
  const operations: ViewerWorkOperation[] = [];
  const observations: Array<{ at: string }> = [];
  const observe = (...values: Array<string | null | undefined>) => {
    for (const at of values) if (at && at >= window.start && at < window.end && at <= observedAt) observations.push({ at });
  };

  const initiatives = new Map(input.initiatives.map(i => [i.id, i]));
  const dispatchCaps: CollaborationCapability[] = reads.dispatch ? ['message', 'dispatch-run'] : [];

  // Work items in the day, on an initiative the caller read.
  const items = input.items.filter(item => initiatives.has(item.projectId) && inDay(itemInterval(item), window));
  const itemNodeIds = new Map<string, string>();
  for (const item of items) {
    const interval = itemInterval(item)!;
    const updated = isoInstant(item.updatedAt) ?? interval.start;
    const id = nodeIdFor.work(item.id);
    itemNodeIds.set(item.id, id);
    nodes.set(id, {
      id, kind: 'task', title: clip(item.title || item.id), status: workItemStatus(item.status), disclosure: 'details',
      startedAt: interval.start, updatedAt: latest(updated, interval.start)!, ...(interval.end ? { endedAt: interval.end } : {}),
      capabilities: [...dispatchCaps],
    });
    observe(isoInstant(item.createdAt), updated, isoInstant(item.completedAt));
    const lines = [item.blockedReason ? `Blocked · ${item.blockedReason}` : null, item.nextStep ? `Next · ${item.nextStep}` : null]
      .filter((l): l is string => !!l).map(l => clip(l));
    details.set(id, {
      nodeId: id,
      summary: clip(`${words(item.type)} · ${item.priority} priority`),
      badge: words(item.status),
      ...(lines.length ? { lines } : {}),
      ...(item.assigneeId && item.assigneeName && ID.test(item.assigneeId) ? { participants: [{ id: item.assigneeId, label: clip(item.assigneeName) }] } : {}),
      footer: { label: clip(`Work item · ${initiatives.get(item.projectId)?.name ?? 'initiative'}`) },
    });
  }

  // Runs the viewer may read, in the day.
  const runs = input.runs.filter(run => initiatives.has(run.projectId)
    && (run.botId ? reads.botRuns : reads.marketplaceRuns)
    && inDay(runInterval(run), window));
  const bots = new Map(input.bots.map(b => [b.id, b]));
  for (const run of runs) {
    const interval = runInterval(run)!;
    const id = nodeIdFor.run(run.id);
    const status = runStatus(run.status);
    const updated = latest(interval.end, interval.start)!;
    const bot = run.botId ? bots.get(run.botId) : undefined;
    nodes.set(id, {
      id, kind: 'run', title: clip(bot ? `${bot.name} run` : `${words(run.trigger)} run`), status, disclosure: 'details',
      startedAt: interval.start, updatedAt: updated, ...(interval.end ? { endedAt: interval.end } : {}),
      capabilities: ['view-run'],
    });
    observe(interval.start, interval.end);
    const target = run.workItemId ? itemNodeIds.get(run.workItemId) : undefined;
    const lines = [
      run.costUsd != null ? `Cost · $${run.costUsd.toFixed(4)}` : null,
      run.modelProvider ? `Served by · ${run.modelProvider}` : null,
    ].filter((l): l is string => !!l);
    const targetItem = target ? items.find(i => i.id === run.workItemId) : undefined;
    const live = run.status === 'running' && !interval.end;
    const lease = { observedAt, expiresAt: new Date(Date.parse(observedAt) + RUN_LEASE_MS).toISOString() };
    details.set(id, {
      nodeId: id, summary: clip(`${words(run.trigger)} trigger`), badge: words(run.status),
      ...(live ? { freshness: lease } : {}),
      ...(lines.length ? { lines } : {}),
      ...(target && targetItem ? { workItem: { nodeId: target, label: clip(targetItem.title || targetItem.id) } } : {}),
    });
    // run → work item it operated on, else → the initiative it is attributed to.
    const toId = target ?? nodeIdFor.initiative(run.projectId);
    const relation: WorkRelation = target ? 'operates-on' : 'works-on';
    const edgeId = edgeIdFor(relation, id, toId);
    edges.set(edgeId, { id: edgeId, fromId: id, toId, relation, status, disclosure: 'details', startedAt: interval.start, updatedAt: updated, ...(interval.end ? { endedAt: interval.end } : {}), capabilities: [] });
    if (live) operations.push({ edgeId, processNodeId: id, attemptId: id, ...lease });
    // The bot that fired it (only behind the bots read gate, which botRuns is).
    if (bot && reads.botRuns) {
      const agentId = nodeIdFor.agent(bot.id);
      const prior = nodes.get(agentId);
      nodes.set(agentId, {
        id: agentId, kind: 'agent', title: clip(bot.name), status: bot.enabled ? 'idle' : 'stopped', disclosure: 'details',
        startedAt: earliest(prior?.startedAt, interval.start)!, updatedAt: latest(prior?.updatedAt, updated)!,
        capabilities: ['view-run'],
      });
      if (!prior) {
        details.set(agentId, {
          nodeId: agentId, summary: clip(bot.model || 'Bot'), badge: bot.enabled ? 'Enabled' : 'Parked',
          ...(bot.pausedReason ? { lines: [clip(bot.pausedReason)] } : {}),
        });
      }
      const agentEdge = edgeIdFor('operates-on', agentId, id);
      edges.set(agentEdge, { id: agentEdge, fromId: agentId, toId: id, relation: 'operates-on', status, disclosure: 'details', startedAt: interval.start, updatedAt: updated, ...(interval.end ? { endedAt: interval.end } : {}), capabilities: [] });
    }
  }

  // Documents linked to a work item that is in the graph.
  for (const link of input.documents) {
    const from = itemNodeIds.get(link.workItemId);
    const linkedAt = isoInstant(link.linkedAt);
    if (!from || !linkedAt || linkedAt >= window.end) continue;
    const id = nodeIdFor.document(link.documentId);
    const prior = nodes.get(id);
    nodes.set(id, {
      id, kind: 'document', title: clip(link.title || link.documentId), status: 'idle', disclosure: 'details',
      startedAt: earliest(prior?.startedAt, linkedAt)!, updatedAt: latest(prior?.updatedAt, linkedAt)!,
      capabilities: ['view-document'],
    });
    if (!prior) details.set(id, { nodeId: id, summary: clip(link.source ? `Ingested from ${link.source}` : 'Ingested document'), footer: { label: 'Linked document' } });
    observe(linkedAt);
    const edgeId = edgeIdFor('derived-from', from, id);
    edges.set(edgeId, { id: edgeId, fromId: from, toId: id, relation: 'derived-from', status: 'idle', disclosure: 'details', startedAt: linkedAt, updatedAt: linkedAt, capabilities: [] });
  }

  const timezone = input.timezone ?? 'UTC';
  /** nodeId → the initiative it belongs to, for the initiative node's own `updatedAt`. */
  const belongsTo = new Map<string, string>();
  for (const item of items) belongsTo.set(itemNodeIds.get(item.id)!, item.projectId);
  for (const run of runs) belongsTo.set(nodeIdFor.run(run.id), run.projectId);
  const calendar = (date: string): { start: string; end: string } | null => {
    try { const w = workDayWindow(date, timezone); return { start: w.start, end: w.end }; } catch { return null; }
  };
  const minus1ms = (iso: string): string => new Date(Date.parse(iso) - 1).toISOString();
  const clampNow = (iso: string): string => (iso < observedAt ? iso : observedAt);
  const attached = new Set<string>();

  // Sprints (the sprints route's rows): a DATE range read as calendar days in the viewer's zone.
  const sprintNodeIds = new Map<string, string>();
  for (const sprint of input.sprints ?? []) {
    if (!initiatives.has(sprint.orgProjectId) || !sprint.startsOn || !sprint.endsOn) continue;
    const from = calendar(sprint.startsOn), to = calendar(sprint.endsOn);
    if (!from || !to || to.end < from.start) continue;
    if (!intervalOverlapsWorkDay(from.start, minus1ms(to.end), window)) continue;
    const id = nodeIdFor.sprint(sprint.id);
    sprintNodeIds.set(sprint.id, id);
    const started = clampNow(from.start);
    const ended = sprint.status === 'done' ? clampNow(minus1ms(to.end)) : null;
    // A sprint's own rows change on its calendar, not per event: a sprint in
    // session across the day counts as live at the day's start (else the reader
    // would fold it as "earlier" context); a finished one is stamped when it ended.
    const updated = ended ?? clampNow(latest(started, window.start)!);
    nodes.set(id, {
      id, kind: 'task', title: clip(sprint.name || sprint.id), status: sprint.status === 'done' ? 'completed' : 'idle', disclosure: 'details',
      startedAt: started, updatedAt: updated, ...(ended ? { endedAt: ended } : {}),
      capabilities: [],
    });
    belongsTo.set(id, sprint.orgProjectId); attached.add(sprint.orgProjectId);
    observe(from.start);
    // The contract allows four detail lines: goal, progress, money (budgets tier), envelopes (grants gate).
    const money = input.reads.sprintsWide
      ? `Planned · $${sprint.estimatedCostUsd.toFixed(2)}${sprint.grantCount > 0 ? ` · Granted · $${sprint.grantedUsd.toFixed(2)} across ${sprint.grantCount} envelope${sprint.grantCount === 1 ? '' : 's'}` : ''}`
      : null;
    const envelopeRows = input.reads.grants ? sprint.envelopes ?? [] : [];
    const envelopes = envelopeRows.length
      ? `Envelope · ${envelopeRows.slice(0, 3).map(e => `${e.granteeName ?? 'Unnamed'} $${e.allocatedUsd.toFixed(2)}`).join(', ')}${envelopeRows.length > 3 ? ` +${envelopeRows.length - 3} more` : ''}`
      : null;
    const lines = [
      sprint.goal ? `Goal · ${sprint.goal}` : null,
      `Items · ${sprint.doneItemCount} of ${sprint.itemCount} done${sprint.pointsTotal > 0 ? ` · ${sprint.pointsDone} of ${sprint.pointsTotal} points` : ''}`,
      money, envelopes,
    ].filter((l): l is string => !!l).map(l => clip(l));
    details.set(id, {
      nodeId: id, summary: clip(`Sprint · ${calendarDay(sprint.startsOn)} to ${calendarDay(sprint.endsOn)}`), badge: words(sprint.status),
      lines,
      ...(sprint.stewardPersonId && sprint.stewardName && ID.test(sprint.stewardPersonId) ? { participants: [{ id: sprint.stewardPersonId, label: clip(sprint.stewardName) }] } : {}),
      footer: { label: clip(`Sprint · ${initiatives.get(sprint.orgProjectId)?.name ?? 'initiative'}`) },
    });
    const edgeId = edgeIdFor('works-on', id, nodeIdFor.initiative(sprint.orgProjectId));
    edges.set(edgeId, { id: edgeId, fromId: id, toId: nodeIdFor.initiative(sprint.orgProjectId), relation: 'works-on', status: nodes.get(id)!.status, disclosure: 'details', startedAt: started, updatedAt: updated, ...(ended ? { endedAt: ended } : {}), capabilities: [] });
  }
  // A work item in a drawn sprint works on that sprint.
  for (const item of items) {
    const sprintNode = item.sprintId ? sprintNodeIds.get(item.sprintId) : undefined;
    if (!sprintNode) continue;
    const fromId = itemNodeIds.get(item.id)!;
    const from = nodes.get(fromId)!;
    const edgeId = edgeIdFor('works-on', fromId, sprintNode);
    edges.set(edgeId, { id: edgeId, fromId, toId: sprintNode, relation: 'works-on', status: from.status, disclosure: 'details', ...(from.startedAt ? { startedAt: from.startedAt } : {}), updatedAt: from.updatedAt, ...(from.endedAt ? { endedAt: from.endedAt } : {}), capabilities: [] });
  }

  // Decisions: only on an instant the row itself carries (escalated_at) or the
  // calendar day it was decided (decided_at, a DATE). An open decision with
  // neither has no moment to draw.
  for (const decision of input.decisions ?? []) {
    if (decision.projectId && !initiatives.has(decision.projectId)) continue;
    const escalated = isoInstant(decision.escalatedAt);
    const decidedDay = decision.decidedAt ? calendar(decision.decidedAt.slice(0, 10)) : null;
    const start = escalated ?? decidedDay?.start ?? null;
    if (!start) continue;
    const end = decidedDay ? minus1ms(decidedDay.end) : undefined;
    if (!intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const settled = !!decidedDay && (decision.status === 'resolved' || decision.status === 'rejected');
    const endedAt = settled ? clampNow(end! < start ? start : end!) : null;
    const startedAt = clampNow(start);
    const id = nodeIdFor.decision(decision.id);
    nodes.set(id, {
      id, kind: 'change', title: clip(decision.topic || decision.id),
      status: decision.status === 'resolved' ? 'completed' : decision.status === 'rejected' ? 'stopped' : decision.status === 'escalated' ? 'waiting' : 'idle',
      disclosure: 'details', startedAt, updatedAt: endedAt ?? startedAt, ...(endedAt ? { endedAt } : {}), capabilities: [],
    });
    if (decision.projectId) { belongsTo.set(id, decision.projectId); attached.add(decision.projectId); }
    observe(escalated);
    const workNode = decision.workItemId ? itemNodeIds.get(decision.workItemId) : undefined;
    const workItem = workNode ? items.find(i => i.id === decision.workItemId) : undefined;
    details.set(id, {
      nodeId: id, summary: clip(`Decision · ${words(decision.status)}`), badge: words(decision.status),
      lines: [decision.summary ? clip(decision.summary) : null, decision.requiredRole ? `Needs · ${decision.requiredRole}` : null].filter((l): l is string => !!l),
      ...(decision.participants.length ? { participants: decision.participants.filter(p => ID.test(p.personId)).slice(0, 5).map(p => ({ id: p.personId, label: clip(p.name), ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) })) } : {}),
      ...(workNode && workItem ? { workItem: { nodeId: workNode, label: clip(workItem.title || workItem.id) } } : {}),
      footer: { label: clip(decision.projectId && initiatives.get(decision.projectId)?.name ? `Decision · ${initiatives.get(decision.projectId)!.name}` : 'Decision · organisation-wide') },
    });
    const status = nodes.get(id)!.status;
    const edgeBase = { status, disclosure: 'details' as const, startedAt, updatedAt: endedAt ?? startedAt, ...(endedAt ? { endedAt } : {}), capabilities: [] };
    if (decision.projectId) {
      const toId = nodeIdFor.initiative(decision.projectId);
      const edgeId = edgeIdFor('works-on', id, toId);
      edges.set(edgeId, { id: edgeId, fromId: id, toId, relation: 'works-on', ...edgeBase });
    }
    if (workNode) {
      const edgeId = edgeIdFor('discussed', id, workNode);
      edges.set(edgeId, { id: edgeId, fromId: id, toId: workNode, relation: 'discussed', ...edgeBase });
    }
  }

  // The viewer's own flow runs (requester-private; the loader admits only
  // runs the REST read would serve this person).
  for (const flow of input.flowRuns ?? []) {
    const start = isoInstant(flow.createdAt);
    if (!start) continue;
    const finished = isoInstant(flow.finishedAt);
    const open = flow.status === 'queued' || flow.status === 'running' || flow.status === 'waiting-approval';
    const end = open ? undefined : (finished ?? isoInstant(flow.updatedAt) ?? start);
    if (!intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const id = nodeIdFor.flowRun(flow.id);
    const status: WorkStatus = flow.status === 'running' ? 'running' : flow.status === 'waiting-approval' ? 'waiting' : flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'error' : 'idle';
    const updated = latest(end, isoInstant(flow.updatedAt), start)!;
    const label = flow.kind.endsWith('.diagram') ? 'Conversation diagram' : flow.kind.endsWith('.doc') ? 'Conversation document' : 'Conversation summary';
    nodes.set(id, {
      id, kind: 'run', title: label, status, disclosure: 'details', startedAt: start, updatedAt: updated,
      ...(end ? { endedAt: end < start ? start : end } : {}), capabilities: ['view-run'],
    });
    observe(start, end);
    const lease = flow.status === 'running' && flow.leaseExpiresAt && isoInstant(flow.leaseExpiresAt)! > observedAt
      ? { observedAt, expiresAt: isoInstant(flow.leaseExpiresAt)! } : null;
    const done = flow.steps.filter(step => step.status === 'completed').length;
    details.set(id, {
      nodeId: id, summary: 'Agent flow you requested', badge: words(flow.status),
      ...(lease ? { freshness: lease } : {}),
      ...(flow.steps.length ? { lines: [`Steps · ${done} of ${flow.steps.length} complete`] } : {}),
    });
    const initiativeId = /^orgiq:initiative:(.+)$/.exec(flow.scope)?.[1];
    const workId = /^orgiq:work:(.+)$/.exec(flow.scope)?.[1];
    const workNode = workId ? itemNodeIds.get(workId) : undefined;
    const toId = workNode ?? (initiativeId && initiatives.has(initiativeId) ? nodeIdFor.initiative(initiativeId) : null);
    if (initiativeId && initiatives.has(initiativeId)) { belongsTo.set(id, initiativeId); attached.add(initiativeId); }
    if (toId) {
      const relation: WorkRelation = workNode ? 'operates-on' : 'works-on';
      const edgeId = edgeIdFor(relation, id, toId);
      edges.set(edgeId, { id: edgeId, fromId: id, toId, relation, status, disclosure: 'details', startedAt: start, updatedAt: updated, ...(end ? { endedAt: end < start ? start : end } : {}), capabilities: [] });
      if (lease) operations.push({ edgeId, processNodeId: id, attemptId: id, ...lease });
    }
  }

  // Live queue rows (agent_jobs queued/claimed/running). Gate: the dispatch
  // tier (`reads.marketplaceRuns`) — narrower than the REST floor on purpose,
  // because a job row is a prompt-carrying dispatch record. A job already shown
  // as a bot run (bot_runs.job_id) is not drawn twice.
  const runJobIds = new Set(runs.map(r => r.jobId).filter((id): id is string => !!id));
  for (const job of reads.marketplaceRuns ? input.jobs ?? [] : []) {
    if (runJobIds.has(job.id) || !initiatives.has(job.projectId)) continue;
    const start = isoInstant(job.createdAt);
    if (!start || !intervalOverlapsWorkDay(start, undefined, window)) continue;
    const id = nodeIdFor.job(job.id);
    const status: WorkStatus = job.status === 'queued' ? 'idle' : 'running';
    const active = isoInstant(job.startedAt) ?? isoInstant(job.claimedAt) ?? start;
    const updated = latest(active, start)!;
    nodes.set(id, {
      id, kind: 'run', title: clip(job.title || `${words(job.kind)} job`), status, disclosure: 'details', startedAt: start, updatedAt: updated,
      capabilities: ['view-run'],
    });
    observe(start, isoInstant(job.claimedAt), isoInstant(job.startedAt));
    const live = job.status === 'running';
    const lease = { observedAt, expiresAt: new Date(Date.parse(observedAt) + RUN_LEASE_MS).toISOString() };
    const target = job.workItemId ? itemNodeIds.get(job.workItemId) : undefined;
    const targetItem = target ? items.find(i => i.id === job.workItemId) : undefined;
    details.set(id, {
      nodeId: id, summary: clip(`Queued ${words(job.kind)} job`), badge: words(job.status),
      ...(live ? { freshness: lease } : {}),
      ...(target && targetItem ? { workItem: { nodeId: target, label: clip(targetItem.title || targetItem.id) } } : {}),
    });
    belongsTo.set(id, job.projectId); attached.add(job.projectId);
    const toId = target ?? nodeIdFor.initiative(job.projectId);
    const relation: WorkRelation = target ? 'operates-on' : 'works-on';
    const edgeId = edgeIdFor(relation, id, toId);
    edges.set(edgeId, { id: edgeId, fromId: id, toId, relation, status, disclosure: 'details', startedAt: start, updatedAt: updated, capabilities: [] });
    if (live) operations.push({ edgeId, processNodeId: id, attemptId: id, ...lease });
  }

  // Initiatives: always the subject on an initiative graph; on the workspace
  // only those with something in the day.
  const active = new Set([...items.map(i => i.projectId), ...runs.map(r => r.projectId), ...attached]);
  for (const initiative of input.initiatives) {
    if (input.scope === 'workspace' && !active.has(initiative.id)) continue;
    const id = nodeIdFor.initiative(initiative.id);
    const memberTimes = [...belongsTo].filter(([, project]) => project === initiative.id).map(([nodeId]) => nodes.get(nodeId)?.updatedAt);
    const created = isoInstant(initiative.createdAt);
    nodes.set(id, {
      id, kind: 'project', title: clip(initiative.name || initiative.id), status: initiativeStatus(initiative.status), disclosure: 'details',
      ...(created ? { startedAt: created } : {}), updatedAt: latest(...memberTimes, created) ?? observedAt,
      capabilities: [...(reads.dispatch ? ['message'] as CollaborationCapability[] : [])],
    });
    details.set(id, {
      nodeId: id, summary: 'Initiative', ...(initiative.status ? { badge: words(initiative.status) } : {}),
      ...(initiative.ownerName ? { lines: [clip(`Owner · ${initiative.ownerName}`)] } : {}),
    });
    // Each work item works on its initiative.
    for (const item of items) {
      if (item.projectId !== initiative.id) continue;
      const fromId = itemNodeIds.get(item.id)!;
      const from = nodes.get(fromId)!;
      const edgeId = edgeIdFor('works-on', fromId, id);
      edges.set(edgeId, { id: edgeId, fromId, toId: id, relation: 'works-on', status: from.status, disclosure: 'details', ...(from.startedAt ? { startedAt: from.startedAt } : {}), updatedAt: from.updatedAt, ...(from.endedAt ? { endedAt: from.endedAt } : {}), capabilities: [] });
    }
  }

  // Drop edges whose endpoint was never drawn (a run attributed to an
  // initiative absent from this workspace day cannot exist, but be exact).
  for (const [key, edge] of edges) if (!nodes.has(edge.fromId) || !nodes.has(edge.toId)) edges.delete(key);

  return finishProjection({ nodes, edges, details, operations, observations });
}

/** The parts a projection accumulates before the cap. */
export interface ProjectionParts {
  nodes: Map<string, ViewerWorkNode>;
  edges: Map<string, ViewerWorkEdge>;
  details: Map<string, ViewerWorkActivityDetail>;
  operations: ViewerWorkOperation[];
  observations: Array<{ at: string }>;
}

/** The node cap, shared by every tenant's graph: keep the newest, never the
 * `project`-kind subjects (an initiative, a pipeline definition). */
export function finishProjection({ nodes, edges, details, operations, observations }: ProjectionParts): Projection {
  let kept = [...nodes.values()];
  let omitted = 0;
  if (kept.length > WORK_GRAPH_LIMITS.snapshotNodes) {
    const subjects = kept.filter(n => n.kind === 'project');
    const rest = kept.filter(n => n.kind !== 'project').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const room = Math.max(0, WORK_GRAPH_LIMITS.snapshotNodes - subjects.length);
    omitted = rest.length - room;
    kept = [...subjects.slice(0, WORK_GRAPH_LIMITS.snapshotNodes), ...rest.slice(0, room)];
  }
  const keptIds = new Set(kept.map(n => n.id));
  const keptEdges = [...edges.values()].filter(e => keptIds.has(e.fromId) && keptIds.has(e.toId)).slice(0, WORK_GRAPH_LIMITS.snapshotEdges);
  const keptEdgeIds = new Set(keptEdges.map(e => e.id));
  return {
    nodes: kept,
    edges: keptEdges,
    // Links to a node the cap dropped are removed by detailsForDisclosedNodes.
    details: detailsForDisclosedNodes(kept, [...details.values()]),
    operations: operations.filter(o => keptEdgeIds.has(o.edgeId) && keptIds.has(o.processNodeId)),
    observations,
    omitted,
  };
}

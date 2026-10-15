// The pipelines tenant's work graph: the same pure projection idea as
// projection.ts (orgiq), over rows the pipelines REST routes already serve —
// definitions, runs, steps, pending approvals, run report decks and the
// viewer's own flow runs. docs/activity-graph-migration.md §8.
//
//   - Nothing here is a second store: one node per source row, every status,
//     count and timestamp the row's own. Day membership is the library's rule.
//   - Authorization happened before this function (lib/work-graph/authority.ts):
//     the caller passes `reads`, decided per request from the reloaded session,
//     and this function draws a part only when its gate is true. An approval
//     node exists only for a viewer who may act on it (`ApproveStep`, the gate
//     of POST /api/pipelines/approvals/:id/decide); an author never gets one,
//     and nothing marks where one would have been.
//   - Node and edge helpers, the id scheme and the node cap are projection.ts's
//     own (`finishProjection`), so both tenants stream through one code path.
//
// Kinds: definition `project` (the effort anchor), run `run`, step `task`,
// approval `change`, deck `document`, flow run `run`. Relations: run→definition
// `works-on`, step→run `works-on`, approval→step `operates-on` (→ run when the
// step is not drawn), deck→run `derived-from`, flow run→run/deck `operates-on`.
//
// The reader draws only nodes that belong to an effort, and an effort needs an
// anchor (`project` kind). A run's anchor is its definition (a definition the
// registry no longer lists is drawn from the run's own `definitionId`). Rows
// no run owns — a consult, a change awaiting review, an approval whose run is
// older than the day, an agent flow tied to no run — hang off a labelled queue
// anchor (`queue:<source>`) so they are drawn at all. The queue is a label for
// where the row lives, not data: it carries no count or timestamp of its own.

import { intervalOverlapsWorkDay } from './day-overlap.js';
import {
  type ViewerWorkActivityDetail, type ViewerWorkEdge, type ViewerWorkNode, type ViewerWorkOperation,
  type WorkDayWindow, type WorkRelation, type WorkStatus,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import {
  clip, edgeIdFor, earliest, finishProjection, ID, isoInstant, latest, part, RUN_LEASE_MS, words,
  type FlowRunGraphRow, type Projection,
} from './projection.js';

export interface PipelinesViewerReads {
  /** ViewPipelines: definitions, runs, steps, decks and the viewer's own flow runs. */
  view: boolean;
  /** ApproveStep: the approvals queue the viewer may decide. */
  approvals: boolean;
}

export interface PDefinitionRow { id: string; title: string; kind: string; enabled: boolean; owner: string | null; ownerName?: string | null }
export interface PRunRow {
  id: string; definitionId: string; status: string; triggeredBy: string | null; triggeredByName?: string | null; triggerType: string;
  startedAt: string | null; finishedAt: string | null; costUsd: number | null; contextTenant: string;
}
export interface PStepRow { runId: string; stepId: string; label: string; status: string; startedAt: string | null; finishedAt: string | null; detail: string | null }
export interface PApprovalRow { id: string; source: string; runId: string | null; definitionId: string | null; stepId: string; title: string; question: string; requestedAt: string | null; requiredRoles: string[] }
export interface PDeckRow { id: string; runId: string; title: string; updatedAt: string; revisionLabel: string | null; producedBy: string | null; producedByName?: string | null }

export interface PipelinesProjectionInput {
  window: Pick<WorkDayWindow, 'start' | 'end'>;
  observedAt: string;
  /** `run`: one run's page — the run is always drawn when readable, with everything of its own. `workspace`: every run in the day. */
  scope: 'run' | 'workspace';
  focusRunId?: string;
  definitions: PDefinitionRow[];
  runs: PRunRow[];
  steps: PStepRow[];
  approvals: PApprovalRow[];
  decks: PDeckRow[];
  flowRuns: FlowRunGraphRow[];
  reads: PipelinesViewerReads;
}

export const pNodeIdFor = {
  definition: (id: string) => `definition:${part(id)}`,
  run: (id: string) => `prun:${part(id)}`,
  step: (runId: string, stepId: string) => `step:${part(`${runId}:${stepId}`)}`,
  approval: (id: string) => `approval:${part(id)}`,
  deck: (id: string) => `deck:${part(id)}`,
  flowRun: (id: string) => `pflow:${part(id)}`,
};

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'cancelled']);
export function pipelineRunStatus(status: string): WorkStatus {
  switch (status) {
    case 'running': return 'running';
    case 'awaiting_approval': case 'paused_at_breakpoint': return 'waiting';
    case 'completed': return 'completed';
    case 'failed': case 'rejected': case 'stuck': return 'error';
    case 'cancelled': return 'stopped';
    default: return 'idle';
  }
}
export function pipelineStepStatus(status: string): WorkStatus {
  switch (status) {
    case 'running': return 'running';
    case 'awaiting_approval': return 'waiting';
    case 'completed': return 'completed';
    case 'failed': return 'error';
    case 'skipped': return 'stopped';
    default: return 'idle';
  }
}

function runInterval(run: PRunRow): { start: string; end?: string } | null {
  const start = isoInstant(run.startedAt);
  if (!start) return null;
  if (!TERMINAL.has(run.status)) return { start };
  const end = isoInstant(run.finishedAt) ?? start;
  return { start, end: end < start ? start : end };
}

export function projectPipelinesWorkGraph(input: PipelinesProjectionInput): Projection {
  const { window, observedAt, reads } = input;
  const nodes = new Map<string, ViewerWorkNode>();
  const edges = new Map<string, ViewerWorkEdge>();
  const details = new Map<string, ViewerWorkActivityDetail>();
  const operations: ViewerWorkOperation[] = [];
  const observations: Array<{ at: string }> = [];
  const observe = (...values: Array<string | null | undefined>) => {
    for (const at of values) if (at && at >= window.start && at < window.end && at <= observedAt) observations.push({ at });
  };
  const empty = () => finishProjection({ nodes, edges, details, operations, observations });
  // Default deny: without ViewPipelines nothing in this graph is readable.
  if (!reads.view) return empty();

  const lease = { observedAt, expiresAt: new Date(Date.parse(observedAt) + RUN_LEASE_MS).toISOString() };
  const edge = (relation: WorkRelation, from: ViewerWorkNode, toId: string) => {
    const id = edgeIdFor(relation, from.id, toId);
    edges.set(id, {
      id, fromId: from.id, toId, relation, status: from.status, disclosure: 'details', ...(from.startedAt ? { startedAt: from.startedAt } : {}),
      updatedAt: from.updatedAt, ...(from.endedAt ? { endedAt: from.endedAt } : {}), capabilities: [],
    });
    return id;
  };
  const person = (id: string | null | undefined, name?: string | null) => (id && ID.test(id) && id.length <= 100 ? [{ id, label: clip(name || id) }] : []);

  // Runs in the day (a run page also draws its own run, whatever the day).
  const definitions = new Map(input.definitions.map(d => [d.id, d]));
  const runs = input.runs.filter(run => {
    const interval = runInterval(run);
    if (!interval) return false;
    if (input.scope === 'run') return run.id === input.focusRunId;
    return intervalOverlapsWorkDay(interval.start, interval.end, window);
  });
  const runNodes = new Map<string, ViewerWorkNode>();
  for (const run of runs) {
    const interval = runInterval(run)!;
    const status = pipelineRunStatus(run.status);
    const id = pNodeIdFor.run(run.id);
    const definition = definitions.get(run.definitionId);
    const updated = latest(interval.end, interval.start)!;
    const node: ViewerWorkNode = {
      id, kind: 'run', title: clip(definition ? `${definition.title} run` : `${words(run.triggerType)} run`), status, disclosure: 'details',
      startedAt: interval.start, updatedAt: updated, ...(interval.end ? { endedAt: interval.end } : {}), capabilities: ['view-run'],
    };
    nodes.set(id, node); runNodes.set(run.id, node);
    observe(interval.start, interval.end);
    const live = run.status === 'running';
    const lines = [
      run.costUsd != null ? `Cost · $${run.costUsd.toFixed(4)}` : null,
      `Trigger · ${words(run.triggerType)}`,
      `Acts for · ${words(run.contextTenant)}`,
    ].filter((l): l is string => !!l);
    details.set(id, {
      nodeId: id, summary: clip(definition ? `${words(definition.kind)} · ${definition.title}` : 'Pipeline run'), badge: words(run.status),
      ...(live ? { freshness: lease } : {}), lines,
      ...(person(run.triggeredBy).length ? { participants: person(run.triggeredBy, run.triggeredByName) } : {}),
      footer: { label: clip(`Run · ${definition?.title ?? words(run.triggerType)}`) },
    });
    // run → its definition (drawn below).
    const toId = pNodeIdFor.definition(run.definitionId);
    const edgeId = edge('works-on', node, toId);
    if (live) operations.push({ edgeId, processNodeId: id, attemptId: id, ...lease });
  }

  // Steps: every step of a run on a run page; on the workspace only the steps
  // of runs still in flight (a finished run's steps are its own page).
  const stepNodes = new Map<string, ViewerWorkNode>();
  for (const step of input.steps) {
    const run = runNodes.get(step.runId);
    const source = runs.find(r => r.id === step.runId);
    if (!run || !source) continue;
    if (input.scope === 'workspace' && TERMINAL.has(source.status)) continue;
    const started = isoInstant(step.startedAt) ?? run.startedAt!;
    const finished = isoInstant(step.finishedAt);
    const end = finished && finished >= started ? finished : undefined;
    const id = pNodeIdFor.step(step.runId, step.stepId);
    const status = pipelineStepStatus(step.status);
    const node: ViewerWorkNode = {
      id, kind: 'task', title: clip(step.label || step.stepId), status, disclosure: 'details', startedAt: started,
      updatedAt: latest(end, started)!, ...(end ? { endedAt: end } : {}), capabilities: [],
    };
    nodes.set(id, node); stepNodes.set(`${step.runId}\u0000${step.stepId}`, node);
    observe(started, end);
    details.set(id, {
      nodeId: id, summary: clip(`Step · ${step.stepId}`), badge: words(step.status),
      ...(step.detail ? { lines: [clip(step.detail)] } : {}),
      ...(step.status === 'running' ? { freshness: lease } : {}),
      footer: { label: clip(`Run · ${run.title}`) },
    });
    const edgeId = edge('works-on', node, run.id);
    // The contract's process is a run/agent/terminal node: the running step animates its edge to the run it belongs to.
    if (step.status === 'running') operations.push({ edgeId, processNodeId: run.id, attemptId: id, ...lease });
  }

  // Approvals: only a viewer who may decide them (ApproveStep) is told they exist. A pending
  // approval is an open interval (requested → now), so one asked before the day still shows.
  // It hangs off its step, else its run; an approval whose run is not in this graph (an older
  // run, or a change request / consult no run owns) stands alone, tied to its definition when drawn below.
  /** queue anchor id → { title, member node ids }: rows no run in this graph owns. */
  const queues = new Map<string, { title: string; members: string[] }>();
  const queue = (key: string, title: string, member: ViewerWorkNode) => {
    const id = `queue:${key}`;
    const entry = queues.get(id) ?? { title, members: [] };
    entry.members.push(member.id); queues.set(id, entry);
    edge('operates-on', member, id);
  };
  const APPROVAL_QUEUE: Record<string, string> = {
    agent_jobs: 'Jobs awaiting review', agent_change_requests: 'Changes awaiting review', lab_consults: 'Consults awaiting an answer',
  };
  if (reads.approvals) {
    for (const approval of input.approvals) {
      if (input.scope === 'run' && approval.runId !== input.focusRunId) continue;
      const run = approval.runId ? runNodes.get(approval.runId) : undefined;
      const requested = isoInstant(approval.requestedAt);
      const start = requested ?? run?.startedAt ?? null;
      if (!start || start >= window.end || !intervalOverlapsWorkDay(start, undefined, window)) continue;
      const id = pNodeIdFor.approval(approval.id);
      const node: ViewerWorkNode = {
        id, kind: 'change', title: clip(approval.title || approval.id), status: 'waiting', disclosure: 'details', startedAt: start,
        updatedAt: latest(start, requested) ?? start, capabilities: ['view-run'],
      };
      nodes.set(id, node);
      observe(requested);
      details.set(id, {
        nodeId: id, summary: clip(`Approval · ${approval.question || 'waiting on a decision'}`), badge: 'Pending',
        ...(approval.requiredRoles.length ? { lines: [clip(`Needs · ${approval.requiredRoles.join(', ')}`)] } : {}),
        footer: { label: clip(`Approval · ${approval.title || 'pending'}`) },
      });
      const step = approval.runId ? stepNodes.get(`${approval.runId}\u0000${approval.stepId}`) : undefined;
      if (step) edge('operates-on', node, step.id);
      else if (run) edge('operates-on', node, run.id);
      else queue(approval.source, APPROVAL_QUEUE[approval.source] ?? 'Approvals waiting on a person', node);
    }
  }

  // Run report decks (GET /api/pipelines/decks, ViewPipelines).
  const deckNodes = new Map<string, ViewerWorkNode>();
  for (const deck of input.decks) {
    const run = runNodes.get(deck.runId);
    const updated = isoInstant(deck.updatedAt);
    if (!run || !updated) continue;
    if (input.scope === 'workspace' && (updated < window.start || updated >= window.end)) continue;
    const id = pNodeIdFor.deck(deck.id);
    const node: ViewerWorkNode = {
      id, kind: 'document', title: clip(deck.title || deck.id), status: 'idle', disclosure: 'details', startedAt: updated, updatedAt: updated,
      capabilities: ['view-document'],
    };
    nodes.set(id, node); deckNodes.set(deck.id, node);
    observe(updated);
    details.set(id, {
      nodeId: id, summary: clip(deck.revisionLabel ? `Deck · ${deck.revisionLabel}` : 'Run report deck'), badge: 'Deck',
      ...(person(deck.producedBy).length ? { participants: person(deck.producedBy, deck.producedByName) } : {}),
      footer: { label: clip(`Deck · ${deck.title || 'run report'}`) },
    });
    edge('derived-from', node, run.id);
  }

  // The viewer's own flow runs (summarize / diagram / doc / agent / deck revise),
  // requester-private; the loader admits only runs the REST read would serve.
  for (const flow of input.flowRuns) {
    const start = isoInstant(flow.createdAt);
    if (!start) continue;
    const finished = isoInstant(flow.finishedAt);
    const open = flow.status === 'queued' || flow.status === 'running' || flow.status === 'waiting-approval';
    const end = open ? undefined : (finished ?? isoInstant(flow.updatedAt) ?? start);
    if (!intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const runId = /^pipelines:run:(.+)$/.exec(flow.scope)?.[1];
    const target = (runId ? runNodes.get(runId) : undefined) ?? deckNodes.get(flow.scope);
    // On a run page only the flows that act on that run or its decks.
    if (input.scope === 'run' && !target) continue;
    const id = pNodeIdFor.flowRun(flow.id);
    const status: WorkStatus = flow.status === 'running' ? 'running' : flow.status === 'waiting-approval' ? 'waiting' : flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'error' : 'idle';
    const updated = latest(end, isoInstant(flow.updatedAt), start)!;
    const label = flow.kind.endsWith('deck-revise') ? 'Deck revision' : flow.kind.endsWith('.diagram') ? 'Conversation diagram'
      : flow.kind.endsWith('.doc') ? 'Conversation document' : flow.kind.endsWith('.agent') ? 'Agent plan' : 'Conversation summary';
    const node: ViewerWorkNode = {
      id, kind: 'run', title: label, status, disclosure: 'details', startedAt: start, updatedAt: updated,
      ...(end ? { endedAt: end < start ? start : end } : {}), capabilities: ['view-run'],
    };
    nodes.set(id, node);
    observe(start, end);
    const flowLease = flow.status === 'running' && flow.leaseExpiresAt && isoInstant(flow.leaseExpiresAt)! > observedAt
      ? { observedAt, expiresAt: isoInstant(flow.leaseExpiresAt)! } : null;
    const done = flow.steps.filter(step => step.status === 'completed').length;
    details.set(id, {
      nodeId: id, summary: 'Agent flow you requested', badge: words(flow.status),
      ...(flowLease ? { freshness: flowLease } : {}),
      ...(flow.steps.length ? { lines: [`Steps · ${done} of ${flow.steps.length} complete`] } : {}),
    });
    if (target) {
      const edgeId = edge('operates-on', node, target.id);
      if (flowLease) operations.push({ edgeId, processNodeId: id, attemptId: id, ...flowLease });
    } else {
      queue('flows', 'Agent flows you requested', node);
    }
  }

  // Definitions: the effort anchors — only those a drawn run belongs to. A run whose definition
  // the registry no longer lists still needs its anchor: drawn from the run's own definition id.
  const known = new Map(input.definitions.map(d => [d.id, d]));
  for (const definitionId of new Set(runs.map(r => r.definitionId))) {
    const definition = known.get(definitionId) ?? { id: definitionId, title: words(definitionId.replace(/^[a-z-]+:/, '')), kind: 'unlisted', enabled: true, owner: null };
    const id = pNodeIdFor.definition(definition.id);
    const members = runs.filter(r => r.definitionId === definition.id).map(r => runNodes.get(r.id)!);
    nodes.set(id, {
      id, kind: 'project', title: clip(definition.title || definition.id), status: definition.enabled ? 'idle' : 'stopped', disclosure: 'details',
      ...(earliest(...members.map(m => m.startedAt)) ? { startedAt: earliest(...members.map(m => m.startedAt))! } : {}),
      updatedAt: latest(...members.map(m => m.updatedAt)) ?? observedAt, capabilities: [],
    });
    details.set(id, {
      nodeId: id, summary: clip(`${words(definition.kind)} definition`), badge: definition.enabled ? 'Enabled' : 'Parked',
      ...(definition.owner ? { lines: [clip(`Owner · ${definition.ownerName ?? definition.owner}`)] } : {}),
      footer: { label: clip(`Definition · ${words(definition.kind)}`) },
    });
  }
  // Queue anchors for the rows no run owns.
  for (const [id, { title, members }] of queues) {
    const memberNodes = members.map(m => nodes.get(m)!);
    nodes.set(id, {
      id, kind: 'project', title: clip(title), status: 'idle', disclosure: 'details',
      ...(earliest(...memberNodes.map(m => m.startedAt)) ? { startedAt: earliest(...memberNodes.map(m => m.startedAt))! } : {}),
      updatedAt: latest(...memberNodes.map(m => m.updatedAt)) ?? observedAt, capabilities: [],
    });
    details.set(id, { nodeId: id, summary: 'Not part of any run drawn here', footer: { label: clip(title) } });
  }

  for (const [key, e] of edges) if (!nodes.has(e.fromId) || !nodes.has(e.toId)) edges.delete(key);
  return finishProjection({ nodes, edges, details, operations, observations });
}

// The assessment tenant's work graph: the same pure projection idea as
// projection.ts (orgiq) and pipelines-projection.ts, over rows the
// /api/assessment routes already serve — teams (the assessments), the
// dimensions assessed, evidence, evidence/follow-up drafts, review decks, agent
// runs and the viewer's own flow runs. docs/activity-graph-migration.md §9.
//
//   - Nothing here is a second store: one node per source row, every status,
//     count and timestamp the row's own. Day membership is the library's rule.
//   - Authorization happened before this function (lib/work-graph/authority.ts):
//     the caller passes `reads`, decided per request from the reloaded session,
//     and this function draws a part only when its gate is true. Default deny:
//     without ViewAssessment nothing is drawn.
//   - Node/edge helpers, the id scheme and the node cap are projection.ts's own
//     (`finishProjection`), so all three tenants stream through one code path.
//
// Kinds: team `project` (the effort anchor), dimension `task`, evidence
// `document`, draft `change` (a proposed summary / follow-up set awaiting an
// editor), deck `document`, agent run `run`, flow run `run`. Relations (edges
// point the way the design lists them): team→dimension `works-on`,
// evidence→dimension `operates-on`, draft→dimension `operates-on`, deck→team
// `derived-from`, run→team|deck `operates-on`, flow run→team|deck `operates-on`.
//
// Rows no team owns (an agent run with no team, a flow run about a document)
// hang off a labelled queue anchor (`queue:<source>`) that carries no count or
// timestamp of its own, as in the pipelines graph. People acting are
// participants on a node's detail; the contract has no person node kind.

import { intervalOverlapsWorkDay } from './day-overlap.js';
import {
  type ViewerWorkActivityDetail, type ViewerWorkEdge, type ViewerWorkNode, type ViewerWorkOperation,
  type WorkDayWindow, type WorkRelation, type WorkStatus,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import {
  clip, edgeIdFor, earliest, finishProjection, isoInstant, latest, part, RUN_LEASE_MS, words,
  type FlowRunGraphRow, type Projection,
} from './projection.js';

export interface AssessmentViewerReads {
  /** ViewAssessment: teams, dimensions, evidence, drafts, decks and agent runs (every GET the graph mirrors). */
  view: boolean;
  /** ScoreAssessment: marks a draft/dimension as one this viewer may act on (accept, score). Never widens what is drawn. */
  score: boolean;
  /** RunAssessmentAgent: the viewer's OWN flow runs, and the capability to dispatch on a node. */
  run: boolean;
}

export interface ATeamRow { id: string; name: string; cohort: string; lead: string | null; updatedAt: string | null }
export interface ADimensionRow {
  teamId: string; id: string; title: string; level: number | null; isNa: boolean; confidence: string;
  /** The last score change (the newest history entry), else null. */
  changedAt: string | null; changedBy: string | null; followupsOpen: number;
}
export interface AEvidenceRow {
  teamId: string; id: string; dimensionId: string | null; sourceType: string; excerpt: string; capturedAt: string;
  status: string; supportsLevel: number | null;
}
export interface ADraftRow {
  id: string; kind: string; teamId: string; dimensionId: string; status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed';
  decision: 'accepted' | 'discarded' | null; createdAt: string; updatedAt: string; finishedAt: string | null;
  requestedBy: string; revision: number; leaseExpiresAt: string | null;
}
export interface ADeckRow { id: string; teamId: string; title: string; updatedAt: string; revisionLabel: string | null }
export interface ARunRow {
  id: string; command: string; teamId: string | null; deckId: string | null; status: string;
  startedAt: string; finishedAt: string | null; summary: string;
}

export interface AssessmentProjectionInput {
  window: Pick<WorkDayWindow, 'start' | 'end'>;
  observedAt: string;
  /** `team`: one team's page — the team is always drawn when readable, with everything of its own. `workspace`: every team with work in the day. */
  scope: 'team' | 'workspace';
  focusTeamId?: string;
  teams: ATeamRow[];
  dimensions: ADimensionRow[];
  evidence: AEvidenceRow[];
  drafts: ADraftRow[];
  decks: ADeckRow[];
  runs: ARunRow[];
  flowRuns: FlowRunGraphRow[];
  reads: AssessmentViewerReads;
}

export const aNodeIdFor = {
  team: (id: string) => `team:${part(id)}`,
  dimension: (teamId: string, dimensionId: string) => `dim:${part(`${teamId}:${dimensionId}`)}`,
  evidence: (teamId: string, id: string) => `evidence:${part(`${teamId}:${id}`)}`,
  draft: (id: string) => `draft:${part(id)}`,
  deck: (id: string) => `adeck:${part(id)}`,
  run: (id: string) => `arun:${part(id)}`,
  flowRun: (id: string) => `aflow:${part(id)}`,
};

export function assessmentRunStatus(status: string): WorkStatus {
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'error';
    default: return 'idle';
  }
}

/** A draft awaits an editor's decision once it has finished and nobody has accepted or discarded it. */
export function draftStatus(draft: Pick<ADraftRow, 'status' | 'decision'>): WorkStatus {
  if (draft.status === 'failed') return 'error';
  if (draft.status === 'queued' || draft.status === 'running') return 'running';
  if (draft.status === 'waiting-approval') return 'waiting';
  if (draft.decision === 'accepted') return 'completed';
  if (draft.decision === 'discarded') return 'stopped';
  return 'waiting';
}

const DRAFT_LABEL: Record<string, string> = { 'assessment.evidence-summary': 'Evidence summary draft', 'assessment.followup-drafts': 'Follow-up questions draft' };
const FLOW_LABEL = (kind: string): string => kind.endsWith('.diagram') ? 'Conversation diagram' : kind.endsWith('.doc') ? 'Conversation document'
  : kind.endsWith('.agent') ? 'Agent plan' : 'Conversation summary';
const DECK_COMMANDS = new Set(['draft-review-deck', 'revise-review-deck']);
export const isDeckCommand = (command: string): boolean => DECK_COMMANDS.has(command);

export function projectAssessmentWorkGraph(input: AssessmentProjectionInput): Projection {
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
  const person = (name: string | null | undefined) => (name ? [{ id: part(name), label: clip(name) }] : []);
  const inWindow = (start: string | null, end?: string | null) =>
    !!start && start < window.end && intervalOverlapsWorkDay(start, end && end >= start ? end : undefined, window);
  const teamScope = input.scope === 'team';

  const teamRows = new Map(input.teams.map(t => [t.id, t]));
  const focus = input.focusTeamId;
  const wantsTeam = (teamId: string | null) => !teamScope || teamId === focus;
  const dimRows = new Map(input.dimensions.map(d => [`${d.teamId}\u0000${d.id}`, d]));

  // Team ids with something drawn; a team page's own team is always drawn.
  const drawnTeams = new Set<string>();
  /** node id → the team it belongs to, so a team anchor spans exactly its own rows. */
  const owner = new Map<string, string>();
  const pendingTeamLinks: Array<{ teamId: string; dimensionId: string }> = [];
  // Dimension nodes are created on demand (a child needs its dimension), then finished below.
  const dimNodes = new Map<string, ViewerWorkNode>();
  const dimChildren = new Map<string, ViewerWorkNode[]>();
  const wantDimension = (teamId: string, dimensionId: string | null): ViewerWorkNode | null => {
    if (!dimensionId) return null;
    const key = `${teamId}\u0000${dimensionId}`;
    const row = dimRows.get(key);
    if (!row) return null;
    drawnTeams.add(teamId);
    const existing = dimNodes.get(key);
    if (existing) return existing;
    const at = isoInstant(row.changedAt) ?? isoInstant(teamRows.get(teamId)?.updatedAt) ?? observedAt;
    const status: WorkStatus = row.isNa ? 'stopped' : row.followupsOpen > 0 ? 'waiting' : row.level != null ? 'completed' : 'idle';
    const id = aNodeIdFor.dimension(teamId, dimensionId);
    const node: ViewerWorkNode = {
      id, kind: 'task', title: clip(`${dimensionId}. ${row.title}`), status, disclosure: 'details', startedAt: at, updatedAt: at,
      endedAt: at, capabilities: [],
    };
    nodes.set(id, node); dimNodes.set(key, node); owner.set(id, teamId);
    observe(isoInstant(row.changedAt));
    const lines = [
      row.isNa ? 'Level · not applicable' : row.level != null ? `Level · ${row.level}` : 'Level · not yet assessed',
      row.level != null ? `Confidence · ${words(row.confidence)}` : null,
      row.followupsOpen > 0 ? `Follow-ups open · ${row.followupsOpen}` : null,
    ].filter((l): l is string => !!l);
    details.set(id, {
      nodeId: id, summary: clip(`Dimension ${dimensionId} · ${row.title}`), badge: row.isNa ? 'N/A' : row.level != null ? `Level ${row.level}` : 'Open',
      lines, ...(person(row.changedBy).length ? { participants: person(row.changedBy) } : {}),
      footer: { label: clip(`Team · ${teamId}`) },
    });
    return node;
  };
  const rememberChild = (dim: ViewerWorkNode | null, child: ViewerWorkNode) => {
    if (!dim) return;
    const list = dimChildren.get(dim.id) ?? [];
    list.push(child); dimChildren.set(dim.id, list);
  };

  // Dimensions that were themselves assessed in the day (workspace), or every assessed one (a team page).
  for (const row of input.dimensions) {
    if (!wantsTeam(row.teamId) || !teamRows.has(row.teamId)) continue;
    const assessed = row.level != null || row.isNa;
    if (!assessed) continue;
    const changed = isoInstant(row.changedAt);
    if (teamScope || inWindow(changed, changed)) wantDimension(row.teamId, row.id);
  }

  // Evidence: a team page draws what the team holds; the workspace, what was captured in the day.
  const teamNode = (teamId: string): string => aNodeIdFor.team(teamId);
  for (const ev of input.evidence.slice().sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 200)) {
    if (!wantsTeam(ev.teamId) || !teamRows.has(ev.teamId)) continue;
    const captured = isoInstant(ev.capturedAt);
    if (!captured || captured > observedAt) continue;
    if (!teamScope && !inWindow(captured, captured)) continue;
    const id = aNodeIdFor.evidence(ev.teamId, ev.id);
    const status: WorkStatus = ev.status === 'SCORED' ? 'completed' : ev.status === 'CLASSIFIED' ? 'waiting' : 'idle';
    const node: ViewerWorkNode = {
      id, kind: 'document', title: clip(`${words(ev.sourceType)} evidence`), status, disclosure: 'details', startedAt: captured, updatedAt: captured,
      endedAt: captured, capabilities: ['view-document'],
    };
    nodes.set(id, node); drawnTeams.add(ev.teamId); owner.set(id, ev.teamId);
    observe(captured);
    details.set(id, {
      nodeId: id, summary: clip(ev.excerpt || `Evidence ${ev.id}`), badge: words(ev.status),
      lines: [ev.supportsLevel != null ? `Supports · level ${ev.supportsLevel}` : 'Supports · no level yet'],
      footer: { label: clip(`Evidence · ${ev.id}`) },
    });
    const dim = wantDimension(ev.teamId, ev.dimensionId);
    rememberChild(dim, node);
    edge('operates-on', node, dim ? dim.id : teamNode(ev.teamId));
  }

  // Drafts (evidence summaries and follow-up question sets): shared by every reader, requester shown as a participant.
  for (const draft of input.drafts) {
    if (!wantsTeam(draft.teamId) || !teamRows.has(draft.teamId)) continue;
    const start = isoInstant(draft.createdAt);
    if (!start || start > observedAt) continue;
    const open = draft.status === 'queued' || draft.status === 'running' || draft.status === 'waiting-approval' || (draft.status === 'completed' && !draft.decision);
    const end = open ? undefined : (isoInstant(draft.finishedAt) ?? isoInstant(draft.updatedAt) ?? start);
    if (!teamScope && !intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const id = aNodeIdFor.draft(draft.id);
    const status = draftStatus(draft);
    const updated = latest(end, isoInstant(draft.updatedAt), start)!;
    const node: ViewerWorkNode = {
      id, kind: 'change', title: clip(`${DRAFT_LABEL[draft.kind] ?? 'Draft'} · ${draft.dimensionId}`), status, disclosure: 'details', startedAt: start,
      updatedAt: updated, ...(end ? { endedAt: end < start ? start : end } : {}),
      capabilities: [...(reads.score ? ['edit-document' as const] : []), ...(reads.run ? ['dispatch-run' as const] : [])],
    };
    nodes.set(id, node); drawnTeams.add(draft.teamId); owner.set(id, draft.teamId);
    observe(start, end);
    const live = draft.status === 'running' && draft.leaseExpiresAt && isoInstant(draft.leaseExpiresAt)! > observedAt
      ? { observedAt, expiresAt: isoInstant(draft.leaseExpiresAt)! } : null;
    details.set(id, {
      nodeId: id, summary: clip(status === 'waiting' ? 'Drafted · awaiting an editor' : `Draft · ${words(draft.decision ?? draft.status)}`),
      badge: draft.decision ? words(draft.decision) : words(draft.status),
      ...(live ? { freshness: live } : {}),
      lines: [`Revision · ${draft.revision}`],
      ...(person(draft.requestedBy).length ? { participants: person(draft.requestedBy) } : {}),
      footer: { label: clip(`Draft · ${draft.id}`) },
    });
    const dim = wantDimension(draft.teamId, draft.dimensionId);
    rememberChild(dim, node);
    const edgeId = edge('operates-on', node, dim ? dim.id : teamNode(draft.teamId));
    if (live) operations.push({ edgeId, processNodeId: id, attemptId: id, ...live });
  }

  // Review decks.
  const deckNodes = new Map<string, ViewerWorkNode>();
  for (const deck of input.decks) {
    if (!wantsTeam(deck.teamId) || !teamRows.has(deck.teamId)) continue;
    const updated = isoInstant(deck.updatedAt);
    if (!updated || updated > observedAt) continue;
    if (!teamScope && !inWindow(updated, updated)) continue;
    const id = aNodeIdFor.deck(deck.id);
    const node: ViewerWorkNode = {
      id, kind: 'document', title: clip(deck.title || deck.id), status: 'idle', disclosure: 'details', startedAt: updated, updatedAt: updated,
      endedAt: updated, capabilities: ['view-document'],
    };
    nodes.set(id, node); deckNodes.set(deck.id, node); drawnTeams.add(deck.teamId); owner.set(id, deck.teamId);
    observe(updated);
    details.set(id, {
      nodeId: id, summary: clip(deck.revisionLabel ? `Review deck · ${deck.revisionLabel}` : 'Review deck'), badge: 'Deck',
      footer: { label: clip(`Deck · ${deck.id}`) },
    });
    edge('derived-from', node, teamNode(deck.teamId));
  }

  // Queue anchors for rows no team owns.
  const queues = new Map<string, { title: string; members: string[] }>();
  const queue = (key: string, title: string, member: ViewerWorkNode) => {
    const id = `queue:${key}`;
    const entry = queues.get(id) ?? { title, members: [] };
    entry.members.push(member.id); queues.set(id, entry);
    edge('operates-on', member, id);
  };

  // Agent runs (the assessment_runs ledger, GET /api/assessment/runs).
  for (const run of input.runs) {
    if (teamScope && run.teamId !== focus && !(run.deckId && deckNodes.has(run.deckId))) continue;
    if (run.teamId && !teamRows.has(run.teamId)) continue;
    const start = isoInstant(run.startedAt);
    if (!start || start > observedAt) continue;
    const open = run.status === 'running';
    const finished = isoInstant(run.finishedAt);
    const end = open ? undefined : (finished && finished >= start ? finished : start);
    if (!teamScope && !intervalOverlapsWorkDay(start, end, window)) continue;
    const id = aNodeIdFor.run(run.id);
    const node: ViewerWorkNode = {
      id, kind: 'run', title: clip(`${words(run.command)} run`), status: assessmentRunStatus(run.status), disclosure: 'details', startedAt: start,
      updatedAt: latest(end, start)!, ...(end ? { endedAt: end } : {}), capabilities: ['view-run'],
    };
    nodes.set(id, node);
    if (run.teamId) { drawnTeams.add(run.teamId); owner.set(id, run.teamId); }
    observe(start, end);
    details.set(id, {
      nodeId: id, summary: clip(run.summary || `Agent run · ${words(run.command)}`), badge: words(run.status),
      ...(open ? { freshness: lease } : {}), footer: { label: clip(`Run · ${run.id}`) },
    });
    const deck = run.deckId ? deckNodes.get(run.deckId) : undefined;
    let edgeId: string | null = null;
    if (deck) edgeId = edge('operates-on', node, deck.id);
    else if (run.teamId) edgeId = edge('operates-on', node, teamNode(run.teamId));
    else queue('runs', 'Agent runs for no team', node);
    if (open && edgeId) operations.push({ edgeId, processNodeId: id, attemptId: id, ...lease });
  }

  // The viewer's own flow runs (summarize / diagram / doc / agent), requester-private; the loader
  // admits only runs the REST read would serve. Behind RunAssessmentAgent.
  for (const flow of input.flowRuns) {
    if (!reads.run) break;
    const start = isoInstant(flow.createdAt);
    if (!start) continue;
    const finished = isoInstant(flow.finishedAt);
    const open = flow.status === 'queued' || flow.status === 'running' || flow.status === 'waiting-approval';
    const end = open ? undefined : (finished ?? isoInstant(flow.updatedAt) ?? start);
    if (!intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const teamId = /^assessment:team:(TEAM-[A-Za-z0-9-]+)$/.exec(flow.scope)?.[1];
    if (teamId && !teamRows.has(teamId)) continue;
    if (teamScope && teamId !== focus) continue;
    const id = aNodeIdFor.flowRun(flow.id);
    const status: WorkStatus = flow.status === 'running' ? 'running' : flow.status === 'waiting-approval' ? 'waiting' : flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'error' : 'idle';
    const node: ViewerWorkNode = {
      id, kind: 'run', title: FLOW_LABEL(flow.kind), status, disclosure: 'details', startedAt: start,
      updatedAt: latest(end, isoInstant(flow.updatedAt), start)!, ...(end ? { endedAt: end < start ? start : end } : {}), capabilities: ['view-run'],
    };
    nodes.set(id, node);
    if (teamId) { drawnTeams.add(teamId); owner.set(id, teamId); }
    observe(start, end);
    const flowLease = flow.status === 'running' && flow.leaseExpiresAt && isoInstant(flow.leaseExpiresAt)! > observedAt
      ? { observedAt, expiresAt: isoInstant(flow.leaseExpiresAt)! } : null;
    const done = flow.steps.filter(step => step.status === 'completed').length;
    details.set(id, {
      nodeId: id, summary: 'Agent flow you requested', badge: words(flow.status),
      ...(flowLease ? { freshness: flowLease } : {}),
      ...(flow.steps.length ? { lines: [`Steps · ${done} of ${flow.steps.length} complete`] } : {}),
    });
    if (teamId) {
      const edgeId = edge('operates-on', node, teamNode(teamId));
      if (flowLease) operations.push({ edgeId, processNodeId: id, attemptId: id, ...flowLease });
    } else queue('flows', 'Agent flows you requested', node);
  }

  // Dimensions: link each drawn one to its team and finish its interval to cover its children.
  for (const [key, dim] of dimNodes) {
    const teamId = key.split('\u0000')[0]!;
    const children = dimChildren.get(dim.id) ?? [];
    const span = [dim, ...children];
    nodes.set(dim.id, {
      ...dim, startedAt: earliest(...span.map(n => n.startedAt))!, updatedAt: latest(...span.map(n => n.updatedAt))!,
    });
    const { endedAt: _drop, ...settled } = nodes.get(dim.id)!;
    nodes.set(dim.id, settled as ViewerWorkNode);
    // team → dimension (the design's direction): `from` is the team node, built next.
    pendingTeamLinks.push({ teamId, dimensionId: dim.id });
  }

  // Team anchors: a team page always draws its own team; the workspace, teams with something drawn.
  if (teamScope && focus && teamRows.has(focus)) drawnTeams.add(focus);
  for (const teamId of drawnTeams) {
    const team = teamRows.get(teamId);
    if (!team) continue;
    const members = [...nodes.values()].filter(n => n.kind !== 'project' && owner.get(n.id) === teamId);
    const updatedAt = latest(isoInstant(team.updatedAt), ...members.map(m => m.updatedAt)) ?? observedAt;
    const startedAt = earliest(...members.map(m => m.startedAt)) ?? isoInstant(team.updatedAt) ?? updatedAt;
    const id = teamNode(teamId);
    const node: ViewerWorkNode = {
      id, kind: 'project', title: clip(team.name || team.id), status: 'idle', disclosure: 'details',
      startedAt: startedAt < updatedAt ? startedAt : updatedAt, updatedAt, capabilities: [],
    };
    nodes.set(id, node);
    details.set(id, {
      nodeId: id, summary: clip(`${words(team.cohort)} assessment`), badge: team.id,
      ...(team.lead ? { participants: person(team.lead) } : {}),
      footer: { label: clip(`Team · ${team.id}`) },
    });
    for (const link of pendingTeamLinks.filter(l => l.teamId === teamId)) edge('works-on', node, link.dimensionId);
  }
  // Queue anchors.
  for (const [id, { title, members }] of queues) {
    const memberNodes = members.map(m => nodes.get(m)!);
    nodes.set(id, {
      id, kind: 'project', title: clip(title), status: 'idle', disclosure: 'details',
      ...(earliest(...memberNodes.map(m => m.startedAt)) ? { startedAt: earliest(...memberNodes.map(m => m.startedAt))! } : {}),
      updatedAt: latest(...memberNodes.map(m => m.updatedAt)) ?? observedAt, capabilities: [],
    });
    details.set(id, { nodeId: id, summary: 'Not part of any team drawn here', footer: { label: clip(id) } });
  }

  for (const [key, e] of edges) if (!nodes.has(e.fromId) || !nodes.has(e.toId)) edges.delete(key);
  return finishProjection({ nodes, edges, details, operations, observations });
}

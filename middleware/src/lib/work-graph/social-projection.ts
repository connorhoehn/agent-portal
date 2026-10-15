// The social tenant's work graph: the same pure projection idea as projection.ts
// (orgiq), pipelines-projection.ts and assessment-projection.ts, over rows the
// /api/social routes and the chat workspace already serve. docs/activity-graph-migration.md §10.
//
//   - Nothing here is a second store: one node per source row. A message thread
//     carries a COUNT, the first/last time and the people who posted — never a
//     message's text. Titles of private conversations appear only because the
//     caller already established the viewer belongs to them (sources.ts).
//   - Authorization happened before this function (lib/work-graph/authority.ts,
//     sources.ts): the loader hands in only conversations the viewer may read
//     NOW and only rows that belong to them; this function draws a part only
//     when its gate is true. Default deny: without ViewSocial nothing is drawn.
//   - Node/edge helpers, the id scheme and the node cap are projection.ts's own
//     (`finishProjection`), so all four tenants stream through one code path.
//
// Kinds: conversation (a channel, DM, team channel or room) `project` — the effort
// anchor; team `project`; message thread `conversation`; call `meeting`; recording
// `transcript`; deck `document`; flow run `run`. Relations (edges point the way
// the design lists them): thread→conversation `discussed`, call→conversation
// `runs-in`, recording→call `derived-from` (→ conversation when the call is not
// drawn), deck→conversation `derived-from`, run→conversation `operates-on`,
// team→its channel `works-on`. People acting are participants on a node's detail;
// the contract has no person node kind.

import { intervalOverlapsWorkDay } from './day-overlap.js';
import {
  type ViewerWorkActivityDetail, type ViewerWorkEdge, type ViewerWorkNode, type ViewerWorkOperation,
  type WorkDayWindow, type WorkRelation, type WorkStatus,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import {
  clip, edgeIdFor, earliest, finishProjection, isoInstant, latest, part, RUN_LEASE_MS, words,
  type FlowRunGraphRow, type Projection,
} from './projection.js';

export interface SocialViewerReads {
  /** ViewSocial: conversations, threads, calls, recordings, decks and the viewer's flow runs. */
  view: boolean;
  /** PostMessage: marks a conversation/thread the viewer may write in (`message`, `join-conversation`). Never widens what is drawn. */
  post: boolean;
  /** StartCall: marks a live call the viewer may join (`join-meeting`). Never widens what is drawn. */
  call: boolean;
}

export type SConversationKind = 'channel' | 'dm' | 'team-channel' | 'room';
/** A conversation the loader proved the viewer may read now. `id` is its chat channel name. */
export interface SConversationRow {
  id: string; kind: SConversationKind; title: string; private: boolean; teamId: string | null;
  /** Newest activity the directory knows (membership, last message); null when it knows none. */
  updatedAt: string | null;
  /** People who belong, as far as the viewer may be told (a DM's peers, a channel's owner). */
  people: Array<{ id: string; name: string }>;
}
export interface STeamRow { id: string; name: string; updatedAt: string | null; role: 'owner' | 'member' | null }
/** The day's messages in one conversation, already filtered to what the viewer's history floor allows. Text is never carried. */
export interface SThreadRow {
  conversationId: string; count: number; firstAt: string; lastAt: string; people: Array<{ id: string; name: string }>;
}
export interface SCallRow {
  id: string; conversationId: string; direction: 'incoming' | 'outgoing' | 'joined' | 'live';
  outcome: 'ringing' | 'answered' | 'missed' | 'declined' | 'cancelled' | 'live' | 'ended' | 'unconfirmed';
  audioOnly: boolean; startedAt: string; endedAt: string | null; durationMs: number | null; people: Array<{ id: string; name: string }>;
}
export interface SRecordingRow {
  id: string; callId: string; conversationId: string; startedAt: string; endedAt: string | null; durationMs: number;
  stage: 'saving' | 'transcribing' | 'summarizing' | 'ready' | 'failed'; people: Array<{ id: string; name: string }>;
}
export interface SDeckRow { id: string; conversationId: string; title: string; updatedAt: string; ownerName: string | null }

export interface SocialProjectionInput {
  window: Pick<WorkDayWindow, 'start' | 'end'>;
  observedAt: string;
  /** `conversation`: one conversation's page — it is always drawn, with everything of its own. `workspace`: every conversation with something in the day. */
  scope: 'conversation' | 'workspace';
  focusConversationId?: string;
  conversations: SConversationRow[];
  teams: STeamRow[];
  threads: SThreadRow[];
  calls: SCallRow[];
  recordings: SRecordingRow[];
  decks: SDeckRow[];
  flowRuns: FlowRunGraphRow[];
  reads: SocialViewerReads;
}

export const sNodeIdFor = {
  conversation: (id: string) => `sconv:${part(id)}`,
  team: (id: string) => `steam:${part(id)}`,
  thread: (conversationId: string) => `sthread:${part(conversationId)}`,
  call: (id: string) => `scall:${part(id)}`,
  recording: (id: string) => `srec:${part(id)}`,
  deck: (id: string) => `sdeck:${part(id)}`,
  flowRun: (id: string) => `sflow:${part(id)}`,
};

/** A call's status: ringing waits for someone, a live call runs, a finished one completed, one nothing confirms is stale; a call nobody took is stopped. */
export function callStatus(call: Pick<SCallRow, 'outcome' | 'endedAt'>): WorkStatus {
  switch (call.outcome) {
    case 'ringing': return 'waiting';
    case 'live': return 'running';
    case 'answered': return call.endedAt ? 'completed' : 'running';
    case 'ended': return 'completed';
    // A log row that says answered/ringing, with no end, that nothing live corroborates: unknown, not running.
    case 'unconfirmed': return 'stale';
    default: return 'stopped';
  }
}
export function recordingStatus(stage: SRecordingRow['stage']): WorkStatus {
  return stage === 'ready' ? 'completed' : stage === 'failed' ? 'error' : 'running';
}
/** Messages in the last five minutes read as live conversation. */
export const THREAD_LIVE_MS = 5 * 60_000;

const FLOW_LABEL = (kind: string): string => kind.endsWith('.diagram') ? 'Conversation diagram' : kind.endsWith('.doc') ? 'Conversation document'
  : kind.endsWith('.agent') ? 'Agent plan' : kind.endsWith('.deck') ? 'Conversation deck' : 'Conversation summary';
const KIND_LABEL: Record<SConversationKind, string> = { channel: 'Channel', dm: 'Direct message', 'team-channel': 'Team channel', room: 'Room' };

export function projectSocialWorkGraph(input: SocialProjectionInput): Projection {
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
  const people = (list: Array<{ id: string; name: string }>) => list.slice(0, 12).map(p => ({ id: part(p.id), label: clip(p.name || p.id) }));
  const inWindow = (start: string | null, end?: string | null) =>
    !!start && start < window.end && intervalOverlapsWorkDay(start, end && end >= start ? end : undefined, window);
  const pageScope = input.scope === 'conversation';
  const focus = input.focusConversationId;

  const convRows = new Map(input.conversations.map(c => [c.id, c]));
  const wants = (conversationId: string) => convRows.has(conversationId) && (!pageScope || conversationId === focus);
  /** node id → the conversation it belongs to, so an anchor spans exactly its own rows. */
  const owner = new Map<string, string>();
  const drawn = new Set<string>();
  const convNode = (id: string): string => sNodeIdFor.conversation(id);

  // Message threads: the day's messages in one conversation (a count, never the text).
  for (const t of input.threads) {
    if (!wants(t.conversationId) || t.count <= 0) continue;
    const first = isoInstant(t.firstAt), last = isoInstant(t.lastAt);
    if (!first || !last || first > observedAt) continue;
    const id = sNodeIdFor.thread(t.conversationId);
    const live = Date.parse(observedAt) - Date.parse(last) <= THREAD_LIVE_MS;
    const node: ViewerWorkNode = {
      id, kind: 'conversation', title: clip(`${t.count} ${t.count === 1 ? 'message' : 'messages'}`), status: live ? 'running' : 'idle', disclosure: 'details',
      startedAt: first, updatedAt: last, ...(live ? {} : { endedAt: last }),
      capabilities: reads.post ? ['message', 'join-conversation'] : [],
    };
    nodes.set(id, node); drawn.add(t.conversationId); owner.set(id, t.conversationId);
    observe(first, last);
    details.set(id, {
      nodeId: id, summary: clip(`Messages in ${convRows.get(t.conversationId)!.title}`), badge: `${t.count}`,
      lines: [`Messages · ${t.count}`, `People · ${t.people.length}`],
      ...(t.people.length ? { participants: people(t.people) } : {}),
      footer: { label: clip(`Thread · ${convRows.get(t.conversationId)!.title}`) },
    });
    edge('discussed', node, convNode(t.conversationId));
  }

  // Calls (live, ringing and recent). A call not tied to a conversation the viewer reads never reaches here.
  const callNodes = new Map<string, ViewerWorkNode>();
  for (const call of input.calls) {
    if (!wants(call.conversationId)) continue;
    const start = isoInstant(call.startedAt);
    if (!start || start > observedAt) continue;
    const open = call.outcome === 'ringing' || call.outcome === 'live' || (call.outcome === 'answered' && !call.endedAt);
    const finished = isoInstant(call.endedAt);
    const end = open ? undefined : (finished && finished >= start ? finished : start);
    if (!pageScope && !intervalOverlapsWorkDay(start, end, window)) continue;
    const id = sNodeIdFor.call(call.id);
    const status = callStatus(call);
    const node: ViewerWorkNode = {
      id, kind: 'meeting', title: clip(`${call.audioOnly ? 'Audio' : 'Video'} call`), status, disclosure: 'details', startedAt: start,
      updatedAt: latest(end, start)!, ...(end ? { endedAt: end } : {}),
      capabilities: open && reads.call ? ['join-meeting'] : [],
    };
    nodes.set(id, node); callNodes.set(call.id, node); drawn.add(call.conversationId); owner.set(id, call.conversationId);
    observe(start, end);
    details.set(id, {
      nodeId: id, summary: clip(`${words(call.outcome)} call in ${convRows.get(call.conversationId)!.title}`), badge: words(call.outcome),
      ...(open && call.outcome !== 'ringing' ? { freshness: lease } : {}),
      lines: [
        `Direction · ${words(call.direction)}`,
        ...(call.durationMs != null && call.durationMs > 0 ? [`Length · ${Math.max(1, Math.round(call.durationMs / 60_000))} min`] : []),
      ],
      ...(call.people.length ? { participants: people(call.people) } : {}),
      footer: { label: clip(`Call · ${convRows.get(call.conversationId)!.title}`) },
    });
    // A live call carries a freshness lease on its detail; the contract's `operations` are for run/agent/terminal nodes only.
    edge('runs-in', node, convNode(call.conversationId));
  }

  // Recordings.
  for (const rec of input.recordings) {
    if (!wants(rec.conversationId)) continue;
    const start = isoInstant(rec.startedAt);
    if (!start || start > observedAt) continue;
    const finished = isoInstant(rec.endedAt);
    const end = finished && finished >= start ? finished : start;
    if (!pageScope && !inWindow(start, end)) continue;
    const id = sNodeIdFor.recording(rec.id);
    const node: ViewerWorkNode = {
      id, kind: 'transcript', title: clip(`Recording · ${Math.max(1, Math.round(rec.durationMs / 60_000))} min`), status: recordingStatus(rec.stage), disclosure: 'details',
      startedAt: start, updatedAt: latest(end, start)!, endedAt: end, capabilities: rec.stage === 'ready' ? ['view-transcript'] : [],
    };
    nodes.set(id, node); drawn.add(rec.conversationId); owner.set(id, rec.conversationId);
    observe(start, end);
    details.set(id, {
      nodeId: id, summary: clip(`Recording in ${convRows.get(rec.conversationId)!.title}`), badge: words(rec.stage),
      ...(rec.people.length ? { participants: people(rec.people) } : {}),
      footer: { label: clip(`Recording · ${convRows.get(rec.conversationId)!.title}`) },
    });
    const call = callNodes.get(rec.callId);
    edge('derived-from', node, call ? call.id : convNode(rec.conversationId));
  }

  // Decks built from a conversation.
  for (const deck of input.decks) {
    if (!wants(deck.conversationId)) continue;
    const updated = isoInstant(deck.updatedAt);
    if (!updated || updated > observedAt) continue;
    if (!pageScope && !inWindow(updated, updated)) continue;
    const id = sNodeIdFor.deck(deck.id);
    const node: ViewerWorkNode = {
      id, kind: 'document', title: clip(deck.title || deck.id), status: 'idle', disclosure: 'details', startedAt: updated, updatedAt: updated,
      endedAt: updated, capabilities: ['view-document'],
    };
    nodes.set(id, node); drawn.add(deck.conversationId); owner.set(id, deck.conversationId);
    observe(updated);
    details.set(id, {
      nodeId: id, summary: clip(`Deck from ${convRows.get(deck.conversationId)!.title}`), badge: 'Deck',
      ...(deck.ownerName ? { participants: [{ id: part(deck.ownerName), label: clip(deck.ownerName) }] } : {}),
      footer: { label: clip(`Deck · ${convRows.get(deck.conversationId)!.title}`) },
    });
    edge('derived-from', node, convNode(deck.conversationId));
  }

  // The viewer's own flow runs (summarize / diagram / doc / agent / deck), requester-private; the loader admits
  // only runs whose conversation the viewer still reads.
  for (const flow of input.flowRuns) {
    if (!wants(flow.scope)) continue;
    const start = isoInstant(flow.createdAt);
    if (!start) continue;
    const finished = isoInstant(flow.finishedAt);
    const open = flow.status === 'queued' || flow.status === 'running' || flow.status === 'waiting-approval';
    const end = open ? undefined : (finished ?? isoInstant(flow.updatedAt) ?? start);
    if (!pageScope && !intervalOverlapsWorkDay(start, end && end < start ? start : end, window)) continue;
    const id = sNodeIdFor.flowRun(flow.id);
    const status: WorkStatus = flow.status === 'running' ? 'running' : flow.status === 'waiting-approval' ? 'waiting' : flow.status === 'completed' ? 'completed' : flow.status === 'failed' ? 'error' : 'idle';
    const node: ViewerWorkNode = {
      id, kind: 'run', title: FLOW_LABEL(flow.kind), status, disclosure: 'details', startedAt: start,
      updatedAt: latest(end, isoInstant(flow.updatedAt), start)!, ...(end ? { endedAt: end < start ? start : end } : {}), capabilities: ['view-run'],
    };
    nodes.set(id, node); drawn.add(flow.scope); owner.set(id, flow.scope);
    observe(start, end);
    const flowLease = flow.status === 'running' && flow.leaseExpiresAt && isoInstant(flow.leaseExpiresAt)! > observedAt
      ? { observedAt, expiresAt: isoInstant(flow.leaseExpiresAt)! } : null;
    const done = flow.steps.filter(step => step.status === 'completed').length;
    details.set(id, {
      nodeId: id, summary: 'Agent flow you requested', badge: words(flow.status),
      ...(flowLease ? { freshness: flowLease } : {}),
      ...(flow.steps.length ? { lines: [`Steps · ${done} of ${flow.steps.length} complete`] } : {}),
    });
    const edgeId = edge('operates-on', node, convNode(flow.scope));
    if (flowLease) operations.push({ edgeId, processNodeId: id, attemptId: id, ...flowLease });
  }

  // Conversation anchors: a conversation page always draws its own; the workspace, those with something drawn.
  if (pageScope && focus && convRows.has(focus)) drawn.add(focus);
  const teamRows = new Map(input.teams.map(t => [t.id, t]));
  const drawnTeams = new Set<string>();
  for (const convId of drawn) {
    const conv = convRows.get(convId);
    if (!conv) continue;
    const members = [...nodes.values()].filter(n => n.kind !== 'project' && owner.get(n.id) === convId);
    const updatedAt = latest(isoInstant(conv.updatedAt), ...members.map(m => m.updatedAt)) ?? observedAt;
    const startedAt = earliest(...members.map(m => m.startedAt)) ?? isoInstant(conv.updatedAt) ?? updatedAt;
    const id = convNode(convId);
    nodes.set(id, {
      id, kind: 'project', title: clip(conv.title || conv.id), status: 'idle', disclosure: 'details',
      startedAt: startedAt < updatedAt ? startedAt : updatedAt, updatedAt,
      capabilities: reads.post ? ['message', 'join-conversation'] : [],
    });
    details.set(id, {
      nodeId: id, summary: clip(`${conv.private ? 'Private ' : ''}${KIND_LABEL[conv.kind]}`), badge: KIND_LABEL[conv.kind],
      ...(conv.people.length ? { participants: people(conv.people) } : {}),
      // The destination key the portal reads (`Conversation · <channel name>`); a name, never content.
      footer: { label: clip(`Conversation · ${conv.title || conv.id}`) },
    });
    if (conv.teamId && teamRows.has(conv.teamId)) drawnTeams.add(conv.teamId);
  }
  // Teams: an anchor for each team whose channel is drawn, spanning its channels.
  for (const teamId of drawnTeams) {
    const team = teamRows.get(teamId)!;
    const channels = [...drawn].map(c => convRows.get(c)!).filter(c => c.teamId === teamId);
    const chNodes = channels.map(c => nodes.get(convNode(c.id))!).filter(Boolean);
    const updatedAt = latest(isoInstant(team.updatedAt), ...chNodes.map(n => n.updatedAt)) ?? observedAt;
    const startedAt = earliest(...chNodes.map(n => n.startedAt)) ?? updatedAt;
    const id = sNodeIdFor.team(teamId);
    const node: ViewerWorkNode = {
      id, kind: 'project', title: clip(team.name || team.id), status: 'idle', disclosure: 'details',
      startedAt: startedAt < updatedAt ? startedAt : updatedAt, updatedAt, capabilities: [],
    };
    nodes.set(id, node);
    details.set(id, {
      nodeId: id, summary: clip(`Team${team.role ? ` · you are ${team.role === 'owner' ? 'an owner' : 'a member'}` : ''}`), badge: 'Team',
      footer: { label: clip(`Team · ${team.name || 'team'}`) },
    });
    for (const ch of channels) edge('works-on', node, convNode(ch.id));
  }

  for (const [key, e] of edges) if (!nodes.has(e.fromId) || !nodes.has(e.toId)) edges.delete(key);
  return finishProjection({ nodes, edges, details, operations, observations });
}

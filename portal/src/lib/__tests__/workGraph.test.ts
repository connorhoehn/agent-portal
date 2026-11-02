import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyWorkGraphSnapshotV2, createClientWorkGraphState, reduceWorkGraphStream,
} from '@connorhoehn/realtime-modules/client';
import type { WorkGraphSnapshotV2 } from '@connorhoehn/realtime-modules/work-graph';
import {
  recentWorkEvents, createWorkGraphTransport, isWorkGraphHint, workGraphHeading, workGraphNodeHref, workGraphPresentation, workGraphQueryString, workNodeKindStatus,
  workGraphSubjectKey, workGraphSnapshotPath, workGraphViewState, workGraphQueryWindow, calendarDay,
} from '../workGraph.ts';

const DAY = '2026-10-06', TZ = 'America/New_York';
const scope = { personId: 'initiative:p-a', day: DAY, timezone: TZ };
const at = (h: number) => `2026-10-06T${String(h).padStart(2, '0')}:00:00.000Z`;
const node = (id: string, kind: string, status = 'idle', updated = at(13)) =>
  ({ id, kind, title: id, status, disclosure: 'details', updatedAt: updated, capabilities: [] });
const edge = (id: string, fromId: string, toId: string, relation: string) =>
  ({ id, fromId, toId, relation, status: 'idle', disclosure: 'details', updatedAt: at(13), capabilities: [] });

function snapshot(over: Partial<WorkGraphSnapshotV2> = {}): WorkGraphSnapshotV2 {
  return {
    schemaVersion: 2,
    scope: { ...scope, policyRevision: 'orgiq.rev1' },
    revision: 1, watermark: 1, cursor: 'owg1.1.orgiq.rev1',
    nodes: [node('initiative:p-a', 'project', 'running'), node('work:wi-1', 'task', 'running'), node('run:r-1', 'run', 'running'), node('work:wi-old', 'task', 'idle', '2026-09-01T00:00:00.000Z')] as never,
    edges: [edge('e1', 'work:wi-1', 'initiative:p-a', 'works-on'), edge('e2', 'run:r-1', 'work:wi-1', 'operates-on'), edge('e3', 'work:wi-old', 'initiative:p-a', 'works-on')] as never,
    sources: [], partial: false,
    query: { schemaVersion: 2, personId: scope.personId, day: DAY, timezone: TZ, windowStart: '2026-10-06T04:00:00.000Z', windowEnd: at(15), mode: 'live' },
    temporal: { mode: 'recent', observedAt: at(15), coverage: { from: '2026-10-06T04:00:00.000Z', through: at(15), complete: true } },
    efforts: [{ id: 'effort.initiative:p-a', anchorNodeId: 'initiative:p-a', title: 'Alpha', nodeIds: ['initiative:p-a', 'work:wi-1', 'run:r-1', 'work:wi-old'], edgeIds: ['e1', 'e2', 'e3'], contextNodeIds: ['work:wi-old'] }],
    details: [
      { nodeId: 'work:wi-1', summary: 'Story · high priority', badge: 'In progress', participants: [{ id: 'p-004', label: 'Nora DaSilva' }] },
      { nodeId: 'run:r-1', summary: 'Cron trigger', lines: ['Cost · $0.0341'], workItem: { nodeId: 'work:wi-1', label: 'wi-1' } },
    ],
    operations: [{ edgeId: 'e2', processNodeId: 'run:r-1', attemptId: 'run:r-1', observedAt: at(15), expiresAt: '2026-10-06T15:05:00.000Z' }],
    eventBuckets: [{ at: at(9), count: 2 }, { at: at(13), count: 1 }],
    ...over,
  };
}
const loaded = () => applyWorkGraphSnapshotV2(createClientWorkGraphState(scope, 'gen-1'), snapshot(), { scope, subscriptionGeneration: 'gen-1' });

test('subject keys and query strings match the BFF contract', () => {
  assert.equal(workGraphSubjectKey({ kind: 'initiative', id: 'p-a' }), 'initiative:p-a');
  assert.equal(workGraphSubjectKey({ kind: 'workspace' }), 'workspace');
  assert.equal(workGraphSubjectKey({ kind: 'person', id: 'p-004' }), 'person:p-004');
  assert.equal(workGraphSnapshotPath({ kind: 'person', id: 'p-004' }), '/api/work-graph/people/p-004/graph');
  const window = workGraphQueryWindow(DAY, TZ);
  assert.deepEqual(window, { start: '2026-10-06T04:00:00.000Z', end: '2026-10-07T04:00:00.000Z', mode: 'live' });
  const qs = new URLSearchParams(workGraphQueryString({ scope: { ...scope, viewerId: 'u' }, activity: { schemaVersion: 2, windowStart: window.start, windowEnd: window.end, mode: 'live', viewBase: 1 } }));
  assert.deepEqual([...qs.keys()].sort(), ['day', 'mode', 'schemaVersion', 'timezone', 'windowEnd', 'windowStart']);
  assert.equal(calendarDay('UTC', new Date('2026-10-06T23:30:00Z')), '2026-10-06');
  assert.equal(calendarDay('Asia/Tokyo', new Date('2026-10-06T23:30:00Z')), '2026-10-07');
});

test('hints: only work-graph.changed, scoped to the initiative unless it names none', () => {
  const one = { kind: 'initiative' as const, id: 'p-a' };
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { initiativeId: 'p-a' } }, one), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { initiativeId: 'p-b' } }, one), false);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { cause: 'run' } }, one), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-item.status', detail: { initiativeId: 'p-a' } }, one), false);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { initiativeId: 'p-b' } }, { kind: 'workspace' }), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { initiativeId: 'p-b' } }, { kind: 'person', id: 'p-004' }), true);
});

test('the transport fetches the snapshot path, throws the status on refusal, and turns a hint into a keep-visible refetch', async () => {
  const calls: string[] = [];
  const transport = createWorkGraphTransport({ kind: 'initiative', id: 'p-a' }, (async (url: string) => {
    calls.push(url);
    return url.includes('p-a') ? new Response(JSON.stringify({ ok: 1 }), { status: 200 }) : new Response('{}', { status: 403 });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  assert.deepEqual(await transport.fetchSnapshot({ scope: { ...scope, viewerId: 'u' }, signal }), { ok: 1 });
  assert.match(calls[0]!, /^\/api\/work-graph\/initiatives\/p-a\/graph\?day=2026-10-06&timezone=America%2FNew_York$/);
  const refused = createWorkGraphTransport({ kind: 'workspace' }, (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(refused.fetchSnapshot({ scope: { ...scope, viewerId: 'u' }, signal }), (e: { status?: number }) => e.status === 403);

  const got: unknown[] = [];
  const socket = transport.openWebSocket({ scope: { ...scope, viewerId: 'u' }, cursor: 'c', subscriptionGeneration: 'gen-1', onMessage: m => got.push(m), onClose() {}, onError() {} });
  transport.openWebSocket({ scope: { ...scope, viewerId: 'u' }, subscriptionGeneration: 'gen-0', awaitAccess: 1, onMessage: m => got.push(m), onClose() {}, onError() {} });
  transport.hint();
  assert.deepEqual(got, [{ kind: 'reset-required', subscriptionGeneration: 'gen-1', reason: 'gap' }]);
  // The library reducer treats it as a refetch, not an access change.
  const state = reduceWorkGraphStream(loaded(), got[0] as never);
  assert.equal(state.status, 'refetch-required');
  assert.equal(Object.keys(state.nodes).length, 4);
  socket.close(); transport.hint();
  assert.equal(got.length, 1);
});

function fakeGateway() {
  const sent: Array<Record<string, unknown>> = [];
  const handlers = new Set<(message: unknown) => void>();
  let connected = true;
  return {
    sent, setConnected(value: boolean) { connected = value; }, isConnected: () => connected,
    gateway: { send(frame: Record<string, unknown>) { sent.push(frame); }, onMessage(h: (m: unknown) => void) { handlers.add(h); return () => handlers.delete(h); } },
    deliver(message: unknown) { for (const h of [...handlers]) h(message); },
    listeners: () => handlers.size,
  };
}
const socketRequest = (got: unknown[], generation: string, extra: Record<string, unknown> = {}) => ({
  scope: { ...scope, viewerId: 'u' }, cursor: 'c-1', subscriptionGeneration: generation,
  onMessage: (m: unknown) => got.push(m), onClose() { got.push('closed'); }, onError() { got.push('error'); }, ...extra,
});

test('the stream rides the gateway: subscribe frame from the snapshot cursor, frames forwarded verbatim, close unsubscribes', () => {
  const g = fakeGateway(); const modes: string[] = [];
  const transport = createWorkGraphTransport({ kind: 'initiative', id: 'p-a' }, { gateway: g.gateway, isConnected: g.isConnected, onModeChange: m => modes.push(m) });
  const got: unknown[] = [];
  const socket = transport.openWebSocket(socketRequest(got, 'gen-1'));
  assert.equal(transport.mode(), 'stream');
  assert.deepEqual(g.sent, [{ service: 'work-graph', action: 'subscribe', subscriptionGeneration: 'gen-1', scope, cursor: 'c-1' }]);
  const delta = { kind: 'delta', batch: { subscriptionGeneration: 'gen-1' } };
  g.deliver({ type: 'work-graph', action: 'message', subscriptionGeneration: 'gen-1', message: delta });
  g.deliver({ type: 'work-graph', action: 'message', subscriptionGeneration: 'gen-other', message: { kind: 'delta' } });
  assert.deepEqual(got, [delta]);
  // A hint never touches a stream reader.
  transport.hint();
  assert.deepEqual(got, [delta]);
  socket.close();
  assert.deepEqual(g.sent.at(-1), { service: 'work-graph', action: 'unsubscribe', subscriptionGeneration: 'gen-1' });
  assert.equal(g.listeners(), 0);
  assert.deepEqual(modes, []);
});

test('a refused stream falls back to hints for this subject; hints then refetch only hint readers', () => {
  const g = fakeGateway(); const modes: string[] = [];
  const transport = createWorkGraphTransport({ kind: 'initiative', id: 'p-a' }, { gateway: g.gateway, isConnected: g.isConnected, onModeChange: m => modes.push(m) });
  const got: unknown[] = [];
  transport.openWebSocket(socketRequest(got, 'gen-1'));
  g.deliver({ type: 'error', service: 'work-graph', code: 'WORK_GRAPH_SUBSCRIBE_REFUSED', subscriptionGeneration: 'gen-1' });
  assert.deepEqual(got, ['error']);
  assert.deepEqual(modes, ['hints']);
  const again: unknown[] = [];
  transport.openWebSocket(socketRequest(again, 'gen-2'));
  assert.equal(g.sent.filter(f => f['action'] === 'subscribe').length, 1, 'no second subscribe after a refusal');
  transport.hint();
  assert.deepEqual(again, [{ kind: 'reset-required', subscriptionGeneration: 'gen-2', reason: 'gap' }]);
  transport.resume();
  assert.equal(again.length, 1, 'resume does not retry a refused stream');
});

test('no connected gateway: hints; on reconnect the hint readers reopen on the stream', () => {
  const g = fakeGateway(); g.setConnected(false); const modes: string[] = [];
  const transport = createWorkGraphTransport({ kind: 'workspace' }, { gateway: g.gateway, isConnected: g.isConnected, onModeChange: m => modes.push(m) });
  const got: unknown[] = [];
  transport.openWebSocket(socketRequest(got, 'gen-1'));
  assert.equal(transport.mode(), 'hints');
  assert.deepEqual(g.sent, []);
  g.setConnected(true); transport.resume();
  assert.deepEqual(got, [{ kind: 'reset-required', subscriptionGeneration: 'gen-1', reason: 'gap' }]);
  transport.openWebSocket(socketRequest(got, 'gen-2'));
  assert.equal(transport.mode(), 'stream');
  assert.deepEqual(modes, ['hints', 'stream']);
  // An awaitAccess placeholder goes to the stream (the server answers access-restored).
  transport.openWebSocket({ ...socketRequest(got, 'gen-3'), cursor: undefined, awaitAccess: 1 });
  assert.deepEqual(g.sent.at(-1), { service: 'work-graph', action: 'subscribe', subscriptionGeneration: 'gen-3', scope, awaitAccess: 1 });
  // Without any gateway the transport is hints only, as before.
  const bare = createWorkGraphTransport({ kind: 'workspace' }, { gateway: null });
  assert.equal(bare.mode(), 'hints');
});

test('presentation: efforts, details, leases and buckets come from the snapshot only', () => {
  const graph = loaded();
  const now = Date.parse(at(15));
  const p = workGraphPresentation({ graph, day: DAY, timezone: TZ, now, mode: 'split', onWindowChange() {}, onViewChange() {} })!;
  assert.equal(p.efforts.length, 1);
  assert.equal(p.efforts[0]!.title, 'Alpha');
  assert.deepEqual(p.activeEdgeIds, ['e2']);
  assert.deepEqual(p.details!['run:r-1']!.lines, ['Cron trigger', 'Cost · $0.0341']);
  assert.deepEqual(p.details!['work:wi-1']!.participants, [{ id: 'p-004', label: 'Nora DaSilva' }]);
  // No activity detail of its own: only the inspector's kind/status line, from the node itself.
  assert.deepEqual(p.details!['work:wi-old'], { subtitle: 'Task · Idle' });
  assert.equal(p.events!.reduce((s, e) => s + e.count, 0), 3);
  assert.deepEqual(p.bounds, { start: Date.parse('2026-10-06T04:00:00.000Z'), end: Date.parse('2026-10-07T04:00:00.000Z') });
  assert.equal(p.window.following, true);
  // An expired lease animates nothing.
  const later = workGraphPresentation({ graph, day: DAY, timezone: TZ, now: Date.parse('2026-10-06T16:00:00.000Z'), mode: 'split', onWindowChange() {}, onViewChange() {} })!;
  assert.deepEqual(later.activeEdgeIds, []);
  // No effort → the plain graph.
  assert.equal(workGraphPresentation({ graph: { ...graph, activity: { ...graph.activity!, efforts: [] } }, day: DAY, timezone: TZ, now, mode: 'split', onWindowChange() {}, onViewChange() {} }), null);
});

test('view state and open destinations', () => {
  assert.equal(workGraphViewState('loading', null, 0), 'loading');
  assert.equal(workGraphViewState('ready', null, 0), 'empty');
  assert.equal(workGraphViewState('ready', null, 3), 'ready');
  assert.equal(workGraphViewState('partial', null, 3), 'partial');
  assert.equal(workGraphViewState('ready', 'snapshot-unavailable', 3), 'error');
  const graph = loaded();
  assert.equal(workGraphNodeHref('initiative:p-a', graph.edges, graph.nodes), '/iq/projects/p-a');
  assert.equal(workGraphNodeHref('work:wi-1', graph.edges, graph.nodes), '/iq/projects/p-a?tab=work&item=wi-1');
  assert.equal(workGraphNodeHref('run:r-1', graph.edges, graph.nodes), '/iq/projects/p-a?tab=work&item=wi-1');
  assert.equal(workGraphNodeHref('agent:b-1', graph.edges, graph.nodes), '/iq/bots/b-1');
  assert.equal(workGraphNodeHref('doc:adr-1', graph.edges, graph.nodes), '/iq/documents/adr-1');
  assert.equal(workGraphNodeHref('doc:h.abc', graph.edges, graph.nodes), null);
});

test('sprint and decision nodes open the pages that serve them, and an org-wide decision opens its record', () => {
  const edges = {
    e1: edge('e1', 'decision:d-1', 'initiative:p-a', 'works-on'),
    e2: edge('e2', 'sprint:s-1', 'initiative:p-a', 'works-on'),
  } as never;
  const nodes = { 'decision:d-1': node('decision:d-1', 'change'), 'decision:d-org': node('decision:d-org', 'change'), 'sprint:s-1': node('sprint:s-1', 'task'), 'initiative:p-a': node('initiative:p-a', 'project') } as never;
  assert.equal(workGraphNodeHref('decision:d-1', edges, nodes), '/iq/decisions/d-1');
  assert.equal(workGraphNodeHref('decision:d-org', edges, nodes), '/iq/decisions/d-org');
  assert.equal(workGraphNodeHref('sprint:s-1', edges, nodes), '/iq/projects?lens=sprints');
  assert.equal(workGraphNodeHref('flow:osm-1', edges, nodes), null);
});

test('the presentation carries sprint and decision cards with the row\u2019s own lines', () => {
  const sprintScope = { personId: 'person:p-004', day: DAY, timezone: TZ };
  const snap = snapshot({
    scope: { ...sprintScope, policyRevision: 'orgiq.rev2' },
    query: { schemaVersion: 2, personId: sprintScope.personId, day: DAY, timezone: TZ, windowStart: '2026-10-06T04:00:00.000Z', windowEnd: at(15), mode: 'live' },
    nodes: [node('initiative:p-a', 'project'), node('sprint:s-1', 'task'), node('decision:d-1', 'change', 'waiting')] as never,
    edges: [edge('e1', 'sprint:s-1', 'initiative:p-a', 'works-on'), edge('e2', 'decision:d-1', 'initiative:p-a', 'works-on')] as never,
    efforts: [{ id: 'effort.initiative:p-a', anchorNodeId: 'initiative:p-a', title: 'Alpha', nodeIds: ['initiative:p-a', 'sprint:s-1', 'decision:d-1'], edgeIds: ['e1', 'e2'], contextNodeIds: [] }],
    details: [
      { nodeId: 'sprint:s-1', summary: 'Sprint \u00b7 2026-10-01 to 2026-10-14', badge: 'Active', lines: ['Items \u00b7 2 of 6 done \u00b7 8 of 21 points'] },
      { nodeId: 'decision:d-1', summary: 'Decision \u00b7 Escalated', badge: 'Escalated', participants: [{ id: 'p-004', label: 'Nora DaSilva' }] },
    ],
    operations: [],
  });
  const state = applyWorkGraphSnapshotV2(createClientWorkGraphState(sprintScope, 'gen-1'), snap, { scope: sprintScope, subscriptionGeneration: 'gen-1' });
  const presentation = workGraphPresentation({ graph: state, day: DAY, timezone: TZ, now: Date.parse(at(15)), mode: 'full', onWindowChange() {}, onViewChange() {} })!;
  assert.deepEqual(presentation.efforts[0]!.nodeIds, ['initiative:p-a', 'sprint:s-1', 'decision:d-1']);
  assert.deepEqual(presentation.details!['sprint:s-1']!.lines, ['Sprint \u00b7 2026-10-01 to 2026-10-14', 'Items \u00b7 2 of 6 done \u00b7 8 of 21 points'].map(l => l.replace('\u00b7', '·')));
  assert.equal(presentation.details!['decision:d-1']!.badge, 'Escalated');
  assert.deepEqual(presentation.details!['decision:d-1']!.participants, [{ id: 'p-004', label: 'Nora DaSilva' }]);
});

test('queue jobs and flow runs open the work item they operate on, else their initiative', () => {
  const edges = {
    e1: edge('e1', 'job:j-1', 'work:wi-1', 'operates-on'), e2: edge('e2', 'work:wi-1', 'initiative:p-a', 'works-on'),
    e3: edge('e3', 'flow:f-1', 'initiative:p-a', 'works-on'),
  } as never;
  const nodes = { 'job:j-1': node('job:j-1', 'run'), 'flow:f-1': node('flow:f-1', 'run'), 'work:wi-1': node('work:wi-1', 'task'), 'initiative:p-a': node('initiative:p-a', 'project') } as never;
  assert.equal(workGraphNodeHref('job:j-1', edges, nodes), '/iq/projects/p-a?tab=work&item=wi-1');
  assert.equal(workGraphNodeHref('flow:f-1', edges, nodes), '/iq/projects/p-a');
});

// ── The pipelines tenant (middleware lib/work-graph/pipelines-projection.ts) ──

import { PIPELINES_WORK_GRAPH_CHANNEL, WORK_GRAPH_CHANNEL, workGraphHintChannel } from '../workGraph.ts';

test('pipelines subjects: keys, snapshot paths and the hint channel match the BFF contract', () => {
  assert.equal(workGraphSubjectKey({ kind: 'pipelines' }), 'workspace:pipelines');
  assert.equal(workGraphSubjectKey({ kind: 'run', id: 'job:job-1' }), 'run:job:job-1');
  // `workspace` stays orgiq's: one key never names both tenants' graphs.
  assert.notEqual(workGraphSubjectKey({ kind: 'pipelines' }), workGraphSubjectKey({ kind: 'workspace' }));
  assert.equal(workGraphSnapshotPath({ kind: 'pipelines' }), '/api/pipelines/work-graph/workspace/graph');
  assert.equal(workGraphSnapshotPath({ kind: 'run', id: 'job:job-1' }), '/api/pipelines/work-graph/runs/job%3Ajob-1/graph');
  assert.equal(workGraphHintChannel({ kind: 'run', id: 'x' }), PIPELINES_WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'pipelines' }), PIPELINES_WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'initiative', id: 'p-a' }), WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'workspace' }), WORK_GRAPH_CHANNEL);
});

test('pipelines hints: a run page hears its own run or a hint naming none; the workspace hears any', () => {
  const run = { kind: 'run' as const, id: 'job:j-1' };
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { runId: 'job:j-1', cause: 'job' } }, run), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { runId: 'job:j-2', cause: 'job' } }, run), false);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { cause: 'run' } }, run), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { runId: 'job:j-2', cause: 'job' } }, { kind: 'pipelines' }), true);
  assert.equal(isWorkGraphHint({ eventType: 'other', detail: {} }, { kind: 'pipelines' }), false);
});

test('pipelines nodes open the page that serves them; a step and a flow open the run they belong to', () => {
  const nodes = {
    'prun:job:j-1': node('prun:job:j-1', 'run'), 'step:job:j-1:review': node('step:job:j-1:review', 'task'),
    'approval:job:j-1': node('approval:job:j-1', 'change'), 'deck:deck-1': node('deck:deck-1', 'document'),
    'definition:def-a': node('definition:def-a', 'project'), 'pflow:psm-1': node('pflow:psm-1', 'run'),
  } as never;
  const edges = {
    e1: edge('e1', 'step:job:j-1:review', 'prun:job:j-1', 'works-on'),
    e2: edge('e2', 'pflow:psm-1', 'prun:job:j-1', 'operates-on'),
  } as never;
  assert.equal(workGraphNodeHref('prun:job:j-1', edges, nodes), '/pipelines/runs/job%3Aj-1');
  assert.equal(workGraphNodeHref('step:job:j-1:review', edges, nodes), '/pipelines/runs/job%3Aj-1');
  assert.equal(workGraphNodeHref('pflow:psm-1', edges, nodes), '/pipelines/runs/job%3Aj-1');
  assert.equal(workGraphNodeHref('approval:job:j-1', edges, nodes), '/pipelines/approvals');
  assert.equal(workGraphNodeHref('deck:deck-1', edges, nodes), '/pipelines/decks/deck-1');
  assert.equal(workGraphNodeHref('definition:def-a', edges, nodes), '/pipelines/definitions');
  // A hashed id names nothing plainly; an unrelated step with no run edge opens nothing.
  assert.equal(workGraphNodeHref('prun:h.0123456789abcdef01234567', edges, nodes), null);
  assert.equal(workGraphNodeHref('step:job:j-9:x', edges, nodes), null);
});

// ── The assessment tenant (middleware lib/work-graph/assessment-projection.ts) ──

import { ASSESSMENT_WORK_GRAPH_CHANNEL } from '../workGraph.ts';

test('assessment subjects: keys, snapshot paths and the hint channel match the BFF contract', () => {
  assert.equal(workGraphSubjectKey({ kind: 'assessment' }), 'workspace:assessment');
  assert.equal(workGraphSubjectKey({ kind: 'team', id: 'TEAM-001' }), 'team:TEAM-001');
  // One key never names two tenants' graphs.
  for (const other of [{ kind: 'workspace' }, { kind: 'pipelines' }] as const) assert.notEqual(workGraphSubjectKey({ kind: 'assessment' }), workGraphSubjectKey(other));
  assert.equal(workGraphSnapshotPath({ kind: 'assessment' }), '/api/assessment/work-graph/workspace/graph');
  assert.equal(workGraphSnapshotPath({ kind: 'team', id: 'TEAM-001' }), '/api/assessment/work-graph/teams/TEAM-001/graph');
  assert.equal(workGraphHintChannel({ kind: 'team', id: 'TEAM-001' }), ASSESSMENT_WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'assessment' }), ASSESSMENT_WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'run', id: 'x' }), PIPELINES_WORK_GRAPH_CHANNEL);
});

test('assessment hints: a team page hears its own team or a hint naming none; the workspace hears any', () => {
  const team = { kind: 'team' as const, id: 'TEAM-001' };
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { teamId: 'TEAM-001', cause: 'score' } }, team), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { teamId: 'TEAM-002', cause: 'score' } }, team), false);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { cause: 'deck' } }, team), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { teamId: 'TEAM-002', cause: 'draft' } }, { kind: 'assessment' }), true);
  assert.equal(isWorkGraphHint({ eventType: 'other', detail: {} }, { kind: 'assessment' }), false);
});

test('assessment nodes open the page that serves them; evidence and drafts open their team at the dimension', () => {
  const nodes = {} as never;
  const edges = {
    e1: edge('e1', 'evidence:TEAM-001:EV-1', 'dim:TEAM-001:2', 'operates-on'),
    e2: edge('e2', 'draft:adr-1', 'dim:TEAM-001:3', 'operates-on'),
    e3: edge('e3', 'evidence:TEAM-002:EV-9', 'team:TEAM-002', 'operates-on'),
  } as never;
  assert.equal(workGraphNodeHref('team:TEAM-001', edges, nodes), '/assessment/teams/TEAM-001');
  assert.equal(workGraphNodeHref('dim:TEAM-001:2', edges, nodes), '/assessment/teams/TEAM-001?dimension=2');
  assert.equal(workGraphNodeHref('evidence:TEAM-001:EV-1', edges, nodes), '/assessment/teams/TEAM-001?tab=evidence&dimension=2');
  assert.equal(workGraphNodeHref('draft:adr-1', edges, nodes), '/assessment/teams/TEAM-001?tab=scorecard&dimension=3'); // via its dimension edge
  assert.equal(workGraphNodeHref('draft:adr-orphan', edges, nodes), null);
  assert.equal(workGraphNodeHref('evidence:TEAM-002:EV-9', edges, nodes), '/assessment/teams/TEAM-002?tab=evidence');
  assert.equal(workGraphNodeHref('adeck:deck-1', edges, nodes), '/assessment/decks/deck-1');
  assert.equal(workGraphNodeHref('arun:run-1', edges, nodes), '/assessment/runs');
  assert.equal(workGraphNodeHref('aflow:asm-1', edges, nodes), '/assessment/runs');
  assert.equal(workGraphNodeHref('team:h.0123456789abcdef01234567', edges, nodes), null);
});

// ── The Social tenant (middleware lib/work-graph/social-projection.ts) ──

import { SOCIAL_WORK_GRAPH_CHANNEL } from '../workGraph.ts';

test('social subjects: keys, snapshot paths and the hint channel match the BFF contract', () => {
  assert.equal(workGraphSubjectKey({ kind: 'social' }), 'workspace:social');
  assert.equal(workGraphSubjectKey({ kind: 'conversation', id: 'social:ch:general' }), 'conversation:social:ch:general');
  for (const other of [{ kind: 'workspace' }, { kind: 'pipelines' }, { kind: 'assessment' }] as const) assert.notEqual(workGraphSubjectKey({ kind: 'social' }), workGraphSubjectKey(other));
  assert.equal(workGraphSnapshotPath({ kind: 'social' }), '/api/social/work-graph/workspace/graph');
  assert.equal(workGraphSnapshotPath({ kind: 'conversation', id: 'social:ch:general' }), '/api/social/work-graph/conversations/social%3Ach%3Ageneral/graph');
  assert.equal(workGraphHintChannel({ kind: 'conversation', id: 'social:ch:general' }), SOCIAL_WORK_GRAPH_CHANNEL);
  assert.equal(workGraphHintChannel({ kind: 'social' }), SOCIAL_WORK_GRAPH_CHANNEL);
});

test('social hints: a conversation hears its own id or a hint naming none; the workspace hears any', () => {
  const conv = { kind: 'conversation' as const, id: 'social:ch:general' };
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { conversationId: 'social:ch:general', cause: 'message' } }, conv), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { conversationId: 'social:ch:other', cause: 'message' } }, conv), false);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { cause: 'call' } }, conv), true);
  assert.equal(isWorkGraphHint({ eventType: 'work-graph.changed', detail: { conversationId: 'social:ch:other', cause: 'call' } }, { kind: 'social' }), true);
  assert.equal(isWorkGraphHint({ eventType: 'other', detail: {} }, { kind: 'social' }), false);
});

test('social nodes open the conversation they belong to; hashed ids open nothing', () => {
  const nodes = {} as never;
  const edges = {
    e1: edge('e1', 'sthread:t1', 'sconv:social:ch:general', 'discussed'),
    e2: edge('e2', 'scall:c1', 'sconv:social:dm:u-a:u-b', 'attended'),
    e3: edge('e3', 'srec:r1', 'scall:c1', 'derived-from'),
    e4: edge('e4', 'sflow:f1', 'sconv:social:team:eng:ops', 'operates-on'),
  } as never;
  assert.equal(workGraphNodeHref('sconv:social:ch:general', edges, nodes), '/social/channels/general');
  assert.equal(workGraphNodeHref('sconv:social:dm:u-a:u-b', edges, nodes), '/social/dms/social%3Adm%3Au-a%3Au-b');
  assert.equal(workGraphNodeHref('sconv:social:team:eng:ops', edges, nodes), '/social/teams?channel=social%3Ateam%3Aeng%3Aops');
  assert.equal(workGraphNodeHref('sconv:social:room:town-hall', edges, nodes), '/social/rooms?room=town-hall');
  assert.equal(workGraphNodeHref('sthread:t1', edges, nodes), '/social/channels/general');
  assert.equal(workGraphNodeHref('scall:c1', edges, nodes), '/social/dms/social%3Adm%3Au-a%3Au-b');
  assert.equal(workGraphNodeHref('scall:c-orphan', edges, nodes), '/social/calls');
  assert.equal(workGraphNodeHref('srec:r1', edges, nodes), '/social/recordings'); // its call's edge is not a conversation edge
  assert.equal(workGraphNodeHref('sflow:f1', edges, nodes), '/social/teams?channel=social%3Ateam%3Aeng%3Aops');
  assert.equal(workGraphNodeHref('sdeck:sdeck-1', edges, nodes), '/social/decks/sdeck-1');
  assert.equal(workGraphNodeHref('steam:eng', edges, nodes), '/social/teams');
  assert.equal(workGraphNodeHref('sconv:h.0123456789abcdef01234567', edges, nodes), null);
});

test('heading: the subject, the day and the live state name what the graph shows', () => {
  const nodes = { 'initiative:p-1': { title: 'Auth Migration' } };
  const one = workGraphHeading({ subject: { kind: 'initiative', id: 'p-1' }, subjectKey: 'initiative:p-1', nodes, day: '2026-10-07', timezone: 'UTC', live: 'stream', today: '2026-10-07' });
  assert.equal(one.title, 'Auth Migration');
  assert.match(one.subtitle, /^Initiative · Today, .*Oct.*7.* · Live$/);
  const all = workGraphHeading({ subject: { kind: 'assessment' }, subjectKey: 'workspace:assessment', nodes: {}, day: '2026-10-06', timezone: 'UTC', live: 'off', today: '2026-10-07' });
  assert.equal(all.title, 'All assessments');
  assert.match(all.subtitle, /^Work graph · (?!Today).*Oct.*6.* · Not live · reload for changes$/);
  const named = workGraphHeading({ subject: { kind: 'team', id: 'TEAM-1' }, subjectKey: 'team:TEAM-1', nodes: {}, day: '2026-10-07', timezone: 'UTC', live: 'hints', title: 'Northstar', today: '2026-10-07' });
  assert.equal(named.title, 'Northstar');
  assert.match(named.subtitle, /Live · refreshes on change$/);
  const person = workGraphHeading({ subject: { kind: 'person', id: 'p-004' }, subjectKey: 'person:p-004', nodes: {}, people: [{ id: 'p-004', label: 'Nora DaSilva' }], day: '2026-10-07', timezone: 'UTC', live: 'stream', today: '2026-10-07' });
  assert.equal(person.title, 'Nora DaSilva’s day');
  assert.equal(workNodeKindStatus({ kind: 'run', status: 'error' }), 'Run · Failed');
});


test('recent activity preserves participant identity and an optional portrait', () => {
  const graph = loaded();
  const events = recentWorkEvents(graph, 5);
  assert.equal(events.find(event => event.id === 'work:wi-1')?.actorId, 'p-004');
  assert.equal(events.find(event => event.id === 'work:wi-1')?.actor, 'Nora DaSilva');
  assert.equal(events.find(event => event.id === 'run:r-1')?.actorId, null);
  const participant = graph.activity!.details!.find(detail => detail.nodeId === 'work:wi-1')!.participants![0]!;
  participant.avatarUrl = '/portraits/nora.jpg';
  assert.equal(recentWorkEvents(graph, 5).find(event => event.id === 'work:wi-1')?.actorAvatarUrl, '/portraits/nora.jpg');
});

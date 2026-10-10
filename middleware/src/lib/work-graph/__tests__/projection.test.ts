// The orgiq work-graph projection (lib/work-graph/projection.ts) and snapshot
// assembly (snapshot.ts) over synthetic rows.
//
// Pinned: projection honesty — every node is exactly one source row, every
// count and number on the wire is that row's own; the day rule is the
// library's; a withheld part leaves nothing behind; and both snapshot versions
// pass the library's own reader validators (what useWorkGraph runs).
import {
  validateWorkGraphSnapshot, validateWorkGraphSnapshotV2, workDayWindow, intervalOverlapsWorkDay,
} from '@connorhoehnslalom/realtime-modules/work-graph';
import { projectWorkGraph, nodeIdFor, isoInstant, type ProjectionInput, type WorkItemRow, type RunRow } from '../projection.js';
import type { SprintGraphRow, DecisionGraphRow, FlowRunGraphRow } from '../projection.js';
import { assembleWorkGraphSnapshot, parseWorkGraphQuery, policyRevisionFor } from '../snapshot.js';

const DAY = '2026-10-06', TZ = 'America/New_York';
const window = workDayWindow(DAY, TZ); // 04:00Z → 04:00Z next day
const observedAt = '2026-10-06T15:00:00.000Z';

const item = (id: string, over: Partial<WorkItemRow> = {}): WorkItemRow => ({
  id, projectId: 'p-a', parentId: null, type: 'story', title: `Item ${id}`, status: 'in_progress', priority: 'high',
  assigneeId: 'p-004', assigneeName: 'Nora DaSilva', blockedReason: null, nextStep: null,
  createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-10-06T13:00:00.000Z', completedAt: null, ...over,
});
const run = (id: string, over: Partial<RunRow> = {}): RunRow => ({
  id, botId: 'bot-1', trigger: 'cron', workItemId: null, status: 'done', costUsd: 0.0341, modelProvider: 'bedrock',
  startedAt: '2026-10-06T09:00:00.000Z', finishedAt: '2026-10-06T09:04:00.000Z', projectId: 'p-a', ...over,
});

function input(over: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    window, observedAt, scope: 'initiative',
    initiatives: [{ id: 'p-a', name: 'Alpha', status: 'in_progress', createdAt: '2026-06-01T00:00:00.000Z', ownerName: 'Vera Green' }],
    items: [
      item('wi-open'),                                                                           // open across the day → in
      item('wi-done-today', { status: 'done', completedAt: '2026-10-06T14:00:00.000Z' }),      // finished today → in
      item('wi-done-before', { status: 'done', completedAt: '2026-10-01T10:00:00.000Z' }),     // finished before → out
      item('wi-future', { createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z' }), // after → out
      item('wi-cancelled', { status: 'cancelled', updatedAt: '2026-09-02T00:00:00.000Z' }),    // closed before → out
      item('wi-other', { projectId: 'p-unread' }),                                              // initiative not read → out
    ],
    bots: [{ id: 'bot-1', name: 'dep-watch', model: 'amazon.nova-pro-v1:0', enabled: false, pausedReason: 'Repo not provisioned', orgProjectId: 'p-a' }],
    runs: [
      run('r-today'),
      run('r-yesterday', { startedAt: '2026-10-05T09:00:00.000Z', finishedAt: '2026-10-05T09:04:00.000Z' }),
      run('r-live', { status: 'running', finishedAt: null, startedAt: '2026-10-06T14:58:00.000Z', workItemId: 'wi-open', botId: null, trigger: 'marketplace', costUsd: null }),
      run('r-failed', { status: 'failed', startedAt: '2026-10-06T10:00:00.000Z', finishedAt: '2026-10-06T10:01:00.000Z', costUsd: 0.0012 }),
    ],
    documents: [
      { workItemId: 'wi-open', documentId: 'adr-d-aurora', title: 'Why Aurora', source: 'confluence', linkedAt: '2026-09-20T10:00:00.000Z' },
      { workItemId: 'wi-done-before', documentId: 'adr-d-other', title: 'Not drawn', source: null, linkedAt: '2026-09-20T10:00:00.000Z' },
    ],
    reads: { botRuns: true, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false },
    timezone: TZ,
    ...over,
  };
}

const kinds = (p: ReturnType<typeof projectWorkGraph>, kind: string) => p.nodes.filter(n => n.kind === kind).map(n => n.id).sort();

describe('projection honesty', () => {
  it('draws exactly the source rows the library day rule admits, one node each', () => {
    const p = projectWorkGraph(input());
    const src = input();
    const expectedItems = src.items.filter(i => i.projectId === 'p-a' && intervalOverlapsWorkDay(i.createdAt,
      i.status === 'done' || i.status === 'cancelled' ? (i.completedAt ?? i.updatedAt) : undefined, window));
    expect(kinds(p, 'task')).toEqual(expectedItems.map(i => nodeIdFor.work(i.id)).sort());
    expect(kinds(p, 'task')).toEqual(['work:wi-done-today', 'work:wi-open']);
    const expectedRuns = src.runs.filter(r => intervalOverlapsWorkDay(r.startedAt, r.status === 'running' ? undefined : r.finishedAt ?? r.startedAt, window));
    expect(kinds(p, 'run')).toEqual(expectedRuns.map(r => nodeIdFor.run(r.id)).sort());
    // One agent per distinct bot among the drawn runs; one document per distinct doc linked to a drawn item.
    expect(kinds(p, 'agent')).toEqual([nodeIdFor.agent('bot-1')]);
    expect(kinds(p, 'document')).toEqual([nodeIdFor.document('adr-d-aurora')]);
    expect(kinds(p, 'project')).toEqual([nodeIdFor.initiative('p-a')]);
    expect(p.nodes).toHaveLength(expectedItems.length + expectedRuns.length + 1 + 1 + 1);
  });

  it('carries each row’s own numbers and timestamps, never a derived one', () => {
    const p = projectWorkGraph(input());
    const today = p.nodes.find(n => n.id === nodeIdFor.run('r-today'))!;
    expect(today).toMatchObject({ status: 'completed', startedAt: '2026-10-06T09:00:00.000Z', endedAt: '2026-10-06T09:04:00.000Z' });
    const detail = p.details.find(d => d.nodeId === today.id)!;
    expect(detail.lines).toContain('Cost · $0.0341');
    expect(p.details.find(d => d.nodeId === nodeIdFor.run('r-live'))!.lines ?? []).not.toContainEqual(expect.stringMatching(/Cost/));
    const task = p.details.find(d => d.nodeId === nodeIdFor.work('wi-open'))!;
    expect(task.participants).toEqual([{ id: 'p-004', label: 'Nora DaSilva' }]);
    expect(p.nodes.find(n => n.id === nodeIdFor.work('wi-done-today'))).toMatchObject({ status: 'completed', endedAt: '2026-10-06T14:00:00.000Z' });
    expect(p.nodes.find(n => n.id === nodeIdFor.run('r-failed'))!.status).toBe('error');
    // Only a process runs: an in-progress item is idle with its own status word; a live run carries its lease.
    expect(p.nodes.find(n => n.id === nodeIdFor.work('wi-open'))!.status).toBe('idle');
    expect(task.badge).toBe('In progress');
    expect(p.nodes.find(n => n.id === nodeIdFor.run('r-live'))!.status).toBe('running');
    expect(p.details.find(d => d.nodeId === nodeIdFor.run('r-live'))!.freshness).toEqual({ observedAt, expiresAt: '2026-10-06T15:05:00.000Z' });
    // Event observations are the rows' own instants inside the day, each once.
    const instants = p.observations.map(o => o.at);
    expect(instants).toEqual(expect.arrayContaining(['2026-10-06T09:00:00.000Z', '2026-10-06T09:04:00.000Z', '2026-10-06T14:00:00.000Z']));
    expect(instants.every(at => at >= window.start && at < window.end && at <= observedAt)).toBe(true);
  });

  it('names relationships from the rows: item→initiative, run→its item or initiative, bot→run, item→document', () => {
    const p = projectWorkGraph(input());
    const rel = (from: string, to: string) => p.edges.find(e => e.fromId === from && e.toId === to)?.relation;
    expect(rel(nodeIdFor.work('wi-open'), nodeIdFor.initiative('p-a'))).toBe('works-on');
    expect(rel(nodeIdFor.run('r-live'), nodeIdFor.work('wi-open'))).toBe('operates-on');
    expect(rel(nodeIdFor.run('r-today'), nodeIdFor.initiative('p-a'))).toBe('works-on');
    expect(rel(nodeIdFor.agent('bot-1'), nodeIdFor.run('r-today'))).toBe('operates-on');
    expect(rel(nodeIdFor.work('wi-open'), nodeIdFor.document('adr-d-aurora'))).toBe('derived-from');
    // Only the live run's edge animates, on a bounded lease from the read.
    expect(p.operations).toHaveLength(1);
    expect(p.operations[0]).toMatchObject({ processNodeId: nodeIdFor.run('r-live'), observedAt });
  });

  it('withholds runs and bots entirely from a viewer without the bots read gates — no placeholder, no count', () => {
    const p = projectWorkGraph(input({ reads: { botRuns: false, marketplaceRuns: false, dispatch: false, sprintsWide: false, grants: false } }));
    expect(kinds(p, 'run')).toEqual([]);
    expect(kinds(p, 'agent')).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/dep-watch|r-today|0\.0341|marketplace/);
    expect(p.nodes.every(n => !n.capabilities.includes('dispatch-run') && !n.capabilities.includes('message'))).toBe(true);
    // Each gate is its own: marketplace runs without the bot gate.
    const market = projectWorkGraph(input({ reads: { botRuns: false, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false } }));
    expect(kinds(market, 'run')).toEqual([nodeIdFor.run('r-live')]);
    expect(kinds(market, 'agent')).toEqual([]);
  });

  it('draws only active initiatives on the workspace, and the subject always on an initiative graph', () => {
    const quiet = { id: 'p-quiet', name: 'Quiet', status: 'in_progress', createdAt: null };
    const ws = projectWorkGraph(input({ scope: 'workspace', initiatives: [...input().initiatives, quiet] }));
    expect(kinds(ws, 'project')).toEqual([nodeIdFor.initiative('p-a')]);
    const solo = projectWorkGraph(input({ initiatives: [quiet], items: [], runs: [], documents: [] }));
    expect(kinds(solo, 'project')).toEqual([nodeIdFor.initiative('p-quiet')]);
  });

  it('reads a zone-less Postgres timestamp as UTC', () => {
    expect(isoInstant('2026-10-06 09:00:00')).toBe('2026-10-06T09:00:00.000Z');
    expect(isoInstant('2026-10-06T09:00:00+00:00')).toBe('2026-10-06T09:00:00.000Z');
    expect(isoInstant('nonsense')).toBeNull();
  });
});

describe('snapshot assembly', () => {
  const v2Query = parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start, windowEnd: window.end, mode: 'live' });
  const base = (q = v2Query) => ({
    subject: { kind: 'initiative' as const, id: 'p-a' }, query: q, projection: projectWorkGraph(input()),
    sources: [{ source: 'cloud-compute' as const, health: 'available' as const }], authorizationUnavailable: false, complete: true,
    policyRevision: policyRevisionFor('u|orgiq|sme|1', input().reads, []), observedAt,
  });

  it('passes the library reader validators for v1 and v2', () => {
    const v1 = assembleWorkGraphSnapshot(base(parseWorkGraphQuery({ day: DAY, timezone: TZ })));
    expect(validateWorkGraphSnapshot(v1).ok).toBe(true);
    const v2 = assembleWorkGraphSnapshot(base());
    expect(validateWorkGraphSnapshotV2(v2).ok).toBe(true);
    if (v2.schemaVersion !== 2) throw new Error('expected v2');
    expect(v2.scope.personId).toBe('initiative:p-a');
    // The answer's window ends at the observation, not at the day's end.
    expect(v2.query.windowEnd).toBe(observedAt);
    expect(v2.temporal).toMatchObject({ mode: 'recent', coverage: { complete: true } });
    // One effort per initiative, named by the initiative.
    expect(v2.efforts.map(e => e.title)).toEqual(['Alpha']);
    // Bucket counts sum to the observations inside the day: nothing invented.
    const p = projectWorkGraph(input());
    expect(v2.eventBuckets.reduce((sum, b) => sum + b.count, 0)).toBe(p.observations.length);
  });

  it('reports a failed authorization decision as authorization-unavailable and partial', () => {
    const s = assembleWorkGraphSnapshot({ ...base(), sources: [], authorizationUnavailable: true });
    expect(s.partial).toBe(true);
    expect(s.sources).toEqual([expect.objectContaining({ source: 'cloud-compute', health: 'authorization-unavailable' })]);
    if (s.schemaVersion === 2) expect(s.temporal.coverage.complete).toBe(false);
  });

  it('changes the policy revision when any gate outcome changes', () => {
    const a = policyRevisionFor('u|orgiq|sme|1', { botRuns: true, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false }, []);
    expect(policyRevisionFor('u|orgiq|sme|1', { botRuns: false, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false }, [])).not.toBe(a);
    expect(policyRevisionFor('u|orgiq|sme|2', { botRuns: true, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false }, [])).not.toBe(a);
    expect(policyRevisionFor('u|orgiq|sme|1', { botRuns: true, marketplaceRuns: true, dispatch: true, sprintsWide: false, grants: false }, ['botRuns'])).not.toBe(a);
  });

  it('refuses malformed queries like the reference route', () => {
    expect(() => parseWorkGraphQuery({ day: DAY })).toThrow(/timezone/);
    expect(() => parseWorkGraphQuery({ day: '2026-02-30', timezone: TZ })).toThrow(/real calendar day/);
    expect(() => parseWorkGraphQuery({ day: DAY, timezone: 'Mars/Olympus' })).toThrow();
    expect(() => parseWorkGraphQuery({ day: DAY, timezone: TZ, cursor: 'x' })).toThrow(/unknown query key/);
    expect(() => parseWorkGraphQuery({ day: DAY, timezone: TZ, windowStart: window.start })).toThrow(/requires schemaVersion=2/);
    expect(() => parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start })).toThrow(/ISO/);
    expect(() => parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: '2026-10-08T00:00:00.000Z', windowEnd: '2026-10-08T01:00:00.000Z' })).toThrow(/inside the day/);
    expect(() => assembleWorkGraphSnapshot(base(parseWorkGraphQuery({ day: '2026-10-09', timezone: TZ })))).toThrow(/not started/);
  });
});

describe('sprints, decisions and flow runs', () => {
  const sprint = (id: string, over: Partial<SprintGraphRow> = {}): SprintGraphRow => ({
    id, orgProjectId: 'p-a', name: `Sprint ${id}`, goal: 'Ship it', stewardPersonId: 'p-004', stewardName: 'Nora DaSilva',
    startsOn: '2026-10-01', endsOn: '2026-10-14', status: 'active', itemCount: 6, doneItemCount: 2, pointsTotal: 21, pointsDone: 8,
    estimatedCostUsd: 120.5, grantedUsd: 400, grantCount: 2, ...over,
  });
  const decision = (id: string, over: Partial<DecisionGraphRow> = {}): DecisionGraphRow => ({
    id, topic: `Decide ${id}`, summary: 'Because.', status: 'resolved', projectId: 'p-a', workItemId: 'wi-open', requiredRole: null,
    decidedAt: '2026-10-06', escalatedAt: null, participants: [{ personId: 'p-004', name: 'Nora DaSilva', role: 'decider' }], ...over,
  });
  const flow = (id: string, over: Partial<FlowRunGraphRow> = {}): FlowRunGraphRow => ({
    id, kind: 'orgiq.summarize', scope: 'orgiq:initiative:p-a', status: 'completed', steps: [{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }],
    createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:02:00.000Z', finishedAt: '2026-10-06T12:02:00.000Z', leaseExpiresAt: null, ...over,
  });

  it('draws each in-day sprint once, with the row\u2019s own rollups, and omits sprints outside the day', () => {
    const p = projectWorkGraph(input({
      sprints: [sprint('s-now'), sprint('s-past', { startsOn: '2026-09-01', endsOn: '2026-09-14', status: 'done' }), sprint('s-other', { orgProjectId: 'p-unread' })],
      items: [item('wi-open', { sprintId: 's-now' })],
    }));
    expect(kinds(p, 'task')).toEqual(['sprint:s-now', 'work:wi-open']);
    const detail = p.details.find(d => d.nodeId === 'sprint:s-now')!;
    expect(detail.lines).toEqual(['Goal · Ship it', 'Items · 2 of 6 done · 8 of 21 points']);
    expect(detail.badge).toBe('Active');
    expect(detail.participants).toEqual([{ id: 'p-004', label: 'Nora DaSilva' }]);
    const rel = (from: string, to: string) => p.edges.find(e => e.fromId === from && e.toId === to)?.relation;
    expect(rel('sprint:s-now', 'initiative:p-a')).toBe('works-on');
    expect(rel('work:wi-open', 'sprint:s-now')).toBe('works-on');
  });

  it('shows sprint money only at the budgets read tier, and envelopes only behind the grants gate', () => {
    const rows = [sprint('s-now', { envelopes: [{ granteeName: 'Nora DaSilva', allocatedUsd: 250 }] })];
    const narrow = projectWorkGraph(input({ sprints: rows }));
    expect(JSON.stringify(narrow)).not.toMatch(/Planned ·|Granted ·|Envelope ·|120\.50|400\.00/);
    const wide = projectWorkGraph(input({ sprints: rows, reads: { botRuns: false, marketplaceRuns: false, dispatch: false, sprintsWide: true, grants: false } }));
    const lines = wide.details.find(d => d.nodeId === 'sprint:s-now')!.lines!;
    expect(lines).toContain('Planned · $120.50 · Granted · $400.00 across 2 envelopes');
    expect(lines.some(l => l.startsWith('Envelope'))).toBe(false);
    // Envelope rows are the grants gate's, carried by the row only when the loader read them.
    const granted = projectWorkGraph(input({ sprints: rows, reads: { botRuns: false, marketplaceRuns: false, dispatch: false, sprintsWide: true, grants: true } }));
    expect(granted.details.find(d => d.nodeId === 'sprint:s-now')!.lines).toContain('Envelope · Nora DaSilva $250.00');
  });

  it('draws a decision only on an instant it carries, linked to its initiative and the work it shapes', () => {
    const p = projectWorkGraph(input({
      decisions: [
        decision('d-today'),
        decision('d-old', { decidedAt: '2026-03-12' }),
        decision('d-esc', { status: 'escalated', decidedAt: null, escalatedAt: '2026-10-06T13:30:00.000Z', workItemId: null, projectId: null }),
        decision('d-none', { status: 'open', decidedAt: null, escalatedAt: null }),
      ],
    }));
    expect(kinds(p, 'change')).toEqual(['decision:d-esc', 'decision:d-today']);
    const rel = (from: string, to: string) => p.edges.find(e => e.fromId === from && e.toId === to)?.relation;
    expect(rel('decision:d-today', 'initiative:p-a')).toBe('works-on');
    expect(rel('decision:d-today', 'work:wi-open')).toBe('discussed');
    expect(p.nodes.find(n => n.id === 'decision:d-esc')).toMatchObject({ status: 'waiting', startedAt: '2026-10-06T13:30:00.000Z' });
    expect(p.nodes.find(n => n.id === 'decision:d-esc')!.endedAt).toBeUndefined();
    // The escalation instant is the only observation a decision adds (a DATE has no minute).
    expect(p.observations.filter(o => o.at === '2026-10-06T13:30:00.000Z')).toHaveLength(1);
    expect(validateWorkGraphSnapshotV2(assembleWorkGraphSnapshot({
      subject: { kind: 'initiative', id: 'p-a' }, query: parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start, windowEnd: window.end, mode: 'live' }),
      projection: p, sources: [], authorizationUnavailable: false, complete: true, policyRevision: 'orgiq.x', observedAt,
    })).ok).toBe(true);
  });

  it('draws the viewer\u2019s flow runs as run nodes tied to the conversation\u2019s initiative, with their own step counts', () => {
    const p = projectWorkGraph(input({
      flowRuns: [flow('f-1'), flow('f-old', { createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:02:00.000Z', finishedAt: '2026-10-01T12:02:00.000Z' }),
        flow('f-live', { status: 'running', finishedAt: null, scope: 'orgiq:work:wi-open', leaseExpiresAt: '2026-10-06T15:02:00.000Z', kind: 'orgiq.doc' })],
    }));
    expect(kinds(p, 'run').filter(id => id.startsWith('flow:'))).toEqual(['flow:f-1', 'flow:f-live']);
    expect(p.details.find(d => d.nodeId === 'flow:f-1')!.lines).toEqual(['Steps \u00b7 2 of 3 complete'].map(l => l.replace('\u00b7', '·')));
    expect(p.edges.find(e => e.fromId === 'flow:f-live')).toMatchObject({ toId: 'work:wi-open', relation: 'operates-on' });
    expect(p.operations.map(o => o.processNodeId)).toContain('flow:f-live');
    expect(p.nodes.find(n => n.id === 'flow:f-live')!.title).toBe('Conversation document');
    // Source material and results are never carried.
    expect(JSON.stringify(p)).not.toMatch(/input|result/);
  });

  it('draws a paused /agent loop as an open waiting node, never running or failed, with no lease or operation', () => {
    const p = projectWorkGraph(input({ flowRuns: [flow('f-wait', { status: 'waiting-approval', finishedAt: null, leaseExpiresAt: null, kind: 'orgiq.agent' })] }));
    const node = p.nodes.find(n => n.id === 'flow:f-wait')!;
    expect(node.status).toBe('waiting');
    expect(node.endedAt).toBeUndefined();
    expect(p.operations.map(o => o.processNodeId)).not.toContain('flow:f-wait');
  });

  it('draws an initiative that only a sprint or decision touches on the workspace', () => {
    const quiet = { id: 'p-quiet', name: 'Quiet', status: 'in_progress', createdAt: null };
    const p = projectWorkGraph(input({ scope: 'workspace', initiatives: [...input().initiatives, quiet], sprints: [sprint('s-q', { orgProjectId: 'p-quiet' })] }));
    expect(kinds(p, 'project')).toEqual(['initiative:p-a', 'initiative:p-quiet']);
  });
});

describe('live queue rows (agent_jobs)', () => {
  const job = (id: string, over: Partial<import('../projection.js').JobGraphRow> = {}): import('../projection.js').JobGraphRow => ({
    id, kind: 'devbox:task', title: `Job ${id}`, status: 'queued', botId: null, projectId: 'p-a', workItemId: 'wi-open',
    createdAt: '2026-10-06T13:00:00.000Z', claimedAt: null, startedAt: null, ...over,
  });

  it('draws queued/claimed/running jobs as run nodes tied to their work item, with a lease only on a running one', () => {
    const p = projectWorkGraph(input({
      runs: [], jobs: [job('j-q'), job('j-r', { status: 'running', claimedAt: '2026-10-06T13:01:00.000Z', startedAt: '2026-10-06T13:02:00.000Z', workItemId: null })],
    }));
    expect(kinds(p, 'run')).toEqual([nodeIdFor.job('j-q'), nodeIdFor.job('j-r')]);
    const rel = (from: string, to: string) => p.edges.find(e => e.fromId === from && e.toId === to)?.relation;
    expect(rel(nodeIdFor.job('j-q'), nodeIdFor.work('wi-open'))).toBe('operates-on');
    expect(rel(nodeIdFor.job('j-r'), nodeIdFor.initiative('p-a'))).toBe('works-on');
    expect(p.nodes.find(n => n.id === nodeIdFor.job('j-q'))!.status).toBe('idle');
    expect(p.operations.map(o => o.processNodeId)).toEqual([nodeIdFor.job('j-r')]);
    expect(JSON.stringify(p)).not.toMatch(/prompt/);
  });

  it('draws nothing behind the dispatch-tier gate, nothing off-initiative, and no job twice when a bot run carries it', () => {
    const jobs = [job('j-q'), job('j-x', { projectId: 'p-unread' }), job('j-dup', { botId: 'bot-1', workItemId: null, status: 'running' })];
    const denied = projectWorkGraph(input({ runs: [], jobs, reads: { botRuns: true, marketplaceRuns: false, dispatch: false, sprintsWide: false, grants: false } }));
    expect(kinds(denied, 'run')).toEqual([]);
    const open = projectWorkGraph(input({ runs: [run('r-dup', { jobId: 'j-dup' })], jobs }));
    expect(kinds(open, 'run').filter(id => id.startsWith('job:'))).toEqual([nodeIdFor.job('j-q')]);
    expect(validateWorkGraphSnapshotV2(assembleWorkGraphSnapshot({
      subject: { kind: 'initiative', id: 'p-a' }, query: parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start, windowEnd: window.end, mode: 'live' }),
      projection: open, sources: [], authorizationUnavailable: false, complete: true, policyRevision: policyRevisionFor('u|orgiq|sme|1', input().reads, []), observedAt,
    })).ok).toBe(true);
  });
});

// ── The pipelines tenant (lib/work-graph/pipelines-projection.ts) ───────────
import { projectPipelinesWorkGraph, pNodeIdFor, type PipelinesProjectionInput, type PRunRow } from '../pipelines-projection.js';
import { pipelinesPolicyRevisionFor } from '../snapshot.js';

const prun = (id: string, over: Partial<PRunRow> = {}): PRunRow => ({
  id, definitionId: 'def-a', status: 'running', triggeredBy: 'u-ines', triggerType: 'manual', startedAt: '2026-10-06T14:00:00.000Z',
  finishedAt: null, costUsd: 0.5, contextTenant: 'orgiq', ...over,
});
function pinput(over: Partial<PipelinesProjectionInput> = {}): PipelinesProjectionInput {
  return {
    window, observedAt, scope: 'workspace',
    definitions: [{ id: 'def-a', title: 'Dep watch', kind: 'bot', enabled: true, owner: 'Vera' }, { id: 'def-b', title: 'Unused', kind: 'agent', enabled: true, owner: null }],
    runs: [
      prun('run-live'),
      prun('run-done', { status: 'completed', startedAt: '2026-10-06T09:00:00.000Z', finishedAt: '2026-10-06T09:05:00.000Z' }),
      prun('run-before', { status: 'completed', startedAt: '2026-10-01T09:00:00.000Z', finishedAt: '2026-10-01T09:05:00.000Z' }),
    ],
    steps: [
      { runId: 'run-live', stepId: 'execute', label: 'Executed', status: 'running', startedAt: '2026-10-06T14:01:00.000Z', finishedAt: null, detail: null },
      { runId: 'run-live', stepId: 'review', label: 'Human review', status: 'awaiting_approval', startedAt: null, finishedAt: null, detail: null },
      { runId: 'run-done', stepId: 'execute', label: 'Executed', status: 'completed', startedAt: '2026-10-06T09:00:00.000Z', finishedAt: '2026-10-06T09:05:00.000Z', detail: null },
    ],
    approvals: [{ id: 'job:j1', source: 'agent_jobs', runId: 'run-live', definitionId: 'def-a', stepId: 'review', title: 'Review the plan', question: 'Ship it?', requestedAt: '2026-10-06T14:30:00.000Z', requiredRoles: ['operator'] }],
    decks: [{ id: 'deck-1', runId: 'run-done', title: 'Run report', updatedAt: '2026-10-06T10:00:00.000Z', revisionLabel: 'v2', producedBy: 'u-kofi' }],
    flowRuns: [],
    reads: { view: true, approvals: true },
    ...over,
  };
}
const pids = (p: ReturnType<typeof projectPipelinesWorkGraph>, prefix: string) => p.nodes.filter(n => n.id.startsWith(prefix)).map(n => n.id).sort();

describe('pipelines projection honesty', () => {
  it('draws exactly the in-day runs, in-flight steps, pending approvals, decks and used definitions, one node per row', () => {
    const p = projectPipelinesWorkGraph(pinput());
    expect(pids(p, 'prun:')).toEqual([pNodeIdFor.run('run-done'), pNodeIdFor.run('run-live')].sort());
    // A finished run's steps are its own page's: only in-flight runs show steps on the workspace.
    expect(pids(p, 'step:')).toEqual([pNodeIdFor.step('run-live', 'execute'), pNodeIdFor.step('run-live', 'review')].sort());
    expect(pids(p, 'approval:')).toEqual([pNodeIdFor.approval('job:j1')]);
    expect(pids(p, 'deck:')).toEqual([pNodeIdFor.deck('deck-1')]);
    expect(pids(p, 'definition:')).toEqual([pNodeIdFor.definition('def-a')]);
    expect(new Set(p.nodes.map(n => n.id)).size).toBe(p.nodes.length);
    const detail = p.details.find(d => d.nodeId === pNodeIdFor.run('run-live'))!;
    expect(detail.lines).toContain('Cost · $0.5000');
    expect(detail.participants).toEqual([{ id: 'u-ines', label: 'u-ines' }]);
  });

  it('names relationships from the rows: run→definition, step→run, approval→step, deck→run', () => {
    const p = projectPipelinesWorkGraph(pinput());
    const pairs = p.edges.map(e => `${e.fromId}>${e.toId}:${e.relation}`);
    expect(pairs).toContain(`${pNodeIdFor.run('run-live')}>${pNodeIdFor.definition('def-a')}:works-on`);
    expect(pairs).toContain(`${pNodeIdFor.step('run-live', 'execute')}>${pNodeIdFor.run('run-live')}:works-on`);
    expect(pairs).toContain(`${pNodeIdFor.approval('job:j1')}>${pNodeIdFor.step('run-live', 'review')}:operates-on`);
    expect(pairs).toContain(`${pNodeIdFor.deck('deck-1')}>${pNodeIdFor.run('run-done')}:derived-from`);
  });

  it('hangs rows no run owns off a labelled queue anchor, so the reader draws them; nothing is left outside an effort', () => {
    const p = projectPipelinesWorkGraph(pinput({
      approvals: [
        { id: 'consult:c1', source: 'lab_consults', runId: null, definitionId: null, stepId: 'execute', title: 'Smallest first?', question: 'Smallest first?', requestedAt: '2026-10-06T14:10:00.000Z', requiredRoles: ['operator'] },
        { id: 'change:x1', source: 'agent_change_requests', runId: 'run-before', definitionId: null, stepId: 'gate', title: 'Review change', question: 'Merge?', requestedAt: '2026-10-05T14:10:00.000Z', requiredRoles: [] },
      ],
      flowRuns: [{ id: 'psm-1', kind: 'pipelines.summarize', scope: 'pipelines:def:d', status: 'running', steps: [], createdAt: '2026-10-06T13:00:00.000Z', updatedAt: '2026-10-06T13:01:00.000Z', finishedAt: null, leaseExpiresAt: null }],
    }));
    const pairs = p.edges.map(e => `${e.fromId}>${e.toId}`);
    expect(pairs).toContain(`${pNodeIdFor.approval('consult:c1')}>queue:lab_consults`);
    // An approval asked before the day, on a run older than the day, is still pending and still shown.
    expect(pairs).toContain(`${pNodeIdFor.approval('change:x1')}>queue:agent_change_requests`);
    expect(pairs).toContain(`${pNodeIdFor.flowRun('psm-1')}>queue:flows`);
    expect(p.nodes.find(n => n.id === 'queue:lab_consults')).toMatchObject({ kind: 'project', title: 'Consults awaiting an answer' });
    const query = parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start, windowEnd: window.end, mode: 'live' });
    const snap = assembleWorkGraphSnapshot({
      subject: { kind: 'workspace' }, query, projection: p, sources: [], authorizationUnavailable: false, tenant: 'pipelines', complete: true, observedAt,
      policyRevision: pipelinesPolicyRevisionFor('u|pipelines|operator|1', { view: true, approvals: true }, []),
    }) as { nodes: Array<{ id: string }>; efforts: Array<{ nodeIds: string[] }> };
    const inEffort = new Set(snap.efforts.flatMap(e => e.nodeIds));
    expect(snap.nodes.filter(n => !inEffort.has(n.id))).toEqual([]);
  });

  it('draws a run whose definition the registry no longer lists under an anchor made from its own definition id', () => {
    const p = projectPipelinesWorkGraph(pinput({ definitions: [] }));
    expect(pids(p, 'definition:')).toEqual([pNodeIdFor.definition('def-a')]);
    expect(p.edges.some(e => e.toId === pNodeIdFor.definition('def-a'))).toBe(true);
  });

  it('withholds approvals from a viewer without ApproveStep — no node, no count, no trace of the title', () => {
    const p = projectPipelinesWorkGraph(pinput({ reads: { view: true, approvals: false } }));
    expect(pids(p, 'approval:')).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/Review the plan|Ship it|job:j1/);
    // The step the approval is about is still a step (the steps route serves it to every reader).
    expect(pids(p, 'step:')).toContain(pNodeIdFor.step('run-live', 'review'));
  });

  it('draws nothing without ViewPipelines (default deny)', () => {
    const p = projectPipelinesWorkGraph(pinput({ reads: { view: false, approvals: true } }));
    expect(p.nodes).toEqual([]); expect(p.edges).toEqual([]); expect(p.details).toEqual([]);
  });

  it('a run page draws that run and all of its own parts, whatever the day; a stranger run draws nothing', () => {
    const own = projectPipelinesWorkGraph(pinput({ scope: 'run', focusRunId: 'run-done' }));
    expect(pids(own, 'prun:')).toEqual([pNodeIdFor.run('run-done')]);
    expect(pids(own, 'step:')).toEqual([pNodeIdFor.step('run-done', 'execute')]);
    expect(pids(own, 'deck:')).toEqual([pNodeIdFor.deck('deck-1')]);
    expect(pids(own, 'approval:')).toEqual([]);
    const older = projectPipelinesWorkGraph(pinput({ scope: 'run', focusRunId: 'run-before' }));
    expect(pids(older, 'prun:')).toEqual([pNodeIdFor.run('run-before')]);
    expect(projectPipelinesWorkGraph(pinput({ scope: 'run', focusRunId: 'nope' })).nodes).toEqual([]);
  });

  it('animates only a running run and its running step, on contract-valid processes', () => {
    const p = projectPipelinesWorkGraph(pinput());
    expect(p.operations.map(o => o.processNodeId).sort()).toEqual([pNodeIdFor.run('run-live'), pNodeIdFor.run('run-live')]);
  });

  it('passes the library reader validators for v1 and v2', () => {
    const p = projectPipelinesWorkGraph(pinput());
    const query = parseWorkGraphQuery({ day: DAY, timezone: TZ, schemaVersion: '2', windowStart: window.start, windowEnd: window.end, mode: 'live' });
    const snap = assembleWorkGraphSnapshot({
      subject: { kind: 'workspace' }, query, projection: p, sources: [{ source: 'pipeline', health: 'available' }], authorizationUnavailable: false,
      tenant: 'pipelines', complete: true, observedAt,
      policyRevision: pipelinesPolicyRevisionFor('u|pipelines|operator|1', { view: true, approvals: true }, []),
    });
    expect(validateWorkGraphSnapshotV2(snap).ok).toBe(true);
  });

  it('marks the pipeline source authorization-unavailable (not cloud-compute) when a gate could not be decided', () => {
    const snap = assembleWorkGraphSnapshot({
      subject: { kind: 'run', id: 'run-live' }, query: parseWorkGraphQuery({ day: DAY, timezone: TZ }),
      projection: projectPipelinesWorkGraph(pinput({ reads: { view: false, approvals: false } })), sources: [], authorizationUnavailable: true,
      tenant: 'pipelines', complete: true, observedAt, policyRevision: pipelinesPolicyRevisionFor('u|pipelines|x|1', { view: false, approvals: false }, ['view']),
    });
    expect(snap.sources).toContainEqual(expect.objectContaining({ source: 'pipeline', health: 'authorization-unavailable' }));
    expect(snap.sources.some(s => s.source === 'cloud-compute')).toBe(false);
    expect(snap.partial).toBe(true);
  });

  it('changes the policy revision when a gate outcome changes, and never collides with orgiq’s', () => {
    const a = pipelinesPolicyRevisionFor('u|pipelines|author|1', { view: true, approvals: false }, []);
    const b = pipelinesPolicyRevisionFor('u|pipelines|author|1', { view: true, approvals: true }, []);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pipelines\.[0-9a-f]{24}$/);
    expect(policyRevisionFor('u|pipelines|author|1', { botRuns: false, marketplaceRuns: false, dispatch: false, sprintsWide: false, grants: false }, [])).toMatch(/^orgiq\./);
  });
});

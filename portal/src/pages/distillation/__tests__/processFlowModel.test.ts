import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processFlowModel } from '../distillationFormat.ts';
import type { CompactionJob, LevelHealth, LevelState } from '../types.ts';

const levels: LevelState[] = [
  { level: 'L0', items: 149, sizeBytes: 1, oldestAt: "2026-09-06T00:00:00Z", lagSeconds: 300 },
  { level: 'L1', items: 22, sizeBytes: 1, oldestAt: "2026-09-06T00:00:00Z", lagSeconds: 2700 },
  { level: 'L2', items: 8, sizeBytes: 1, oldestAt: "2026-09-06T00:00:00Z", lagSeconds: 151200 },
] as unknown as LevelState[];
const health: LevelHealth[] = [
  { level: 'L0', status: 'healthy', reason: '' },
  { level: 'L1', status: 'behind', reason: 'waiting' },
  { level: 'L2', status: 'stalled', reason: 'waiting longer' },
] as unknown as LevelHealth[];

const base = {
  activeWriters: 12, botRunsToday: 5, sweepFindings: 3, labSignals: 1, reviewed30d: 9, queueDepth: 4,
  levels, health, jobs: [] as CompactionJob[], publishedCount: 3, candidates: 2, bundleSkills: 3,
};

test('four input branches fan into L0, the pipeline runs through the middle, L2 fans out', () => {
  const m = processFlowModel(base);
  const ids = m.nodes.map((n) => n.id);
  assert.deepEqual(ids, ['sessions', 'bots', 'sweeps', 'lab', 'L0', 'L1', 'L2', 'review', 'library', 'promotions', 'session']);
  const inputs = m.nodes.slice(0, 4);
  assert.ok(inputs.every((n) => n.x === 0) && new Set(inputs.map((n) => n.y)).size === 4, 'inputs stacked in one column');
  const [l0, l1, l2] = ['L0', 'L1', 'L2'].map((id) => m.nodes.find((n) => n.id === id)!);
  assert.ok(l0.x < l1.x && l1.x < l2.x && l0.y === l1.y && l1.y === l2.y, 'pipeline in one row');
  assert.ok(m.edges.filter((e) => e.target === 'L0').map((e) => e.source).every((s) => inputs.some((n) => n.id === s)));
  assert.deepEqual(m.edges.filter((e) => e.source === 'L2').map((e) => e.target).sort(), ['library', 'promotions']);
  assert.equal(m.edges.find((e) => e.source === 'review')!.target, 'L1');
  assert.equal(m.edges.find((e) => e.source === 'library')!.target, 'session');
});

test('counts and doors come from the inputs', () => {
  const m = processFlowModel(base);
  const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
  assert.equal(byId.sessions!.count, 12);
  assert.equal(byId.bots!.count, 5);
  assert.equal(byId.sweeps!.count, 3);
  assert.equal(byId.lab!.count, 1);
  assert.equal(byId.L0!.count, 149);
  assert.equal(byId.review!.count, 9);
  assert.equal(byId.promotions!.count, 2);
  assert.equal(byId.session!.navigateTo, '/iq/release');
  assert.equal(byId.sweeps!.navigateTo, '/iq/work/findings');
});

test('input edges carry no label; merge edges carry tier health', () => {
  const m = processFlowModel(base);
  assert.ok(m.edges.filter((e) => e.target === 'L0').every((e) => e.label === ''));
  assert.equal(m.edges.find((e) => e.id === 'L0-L1')!.tone, 'behind');
  assert.equal(m.edges.find((e) => e.id === 'L1-L2')!.tone, 'stalled');
});

test('a running merge animates its edge instead of breathing', () => {
  const jobs = [{ id: 'j1', level: 'L1', status: 'running', startedAt: new Date().toISOString() }] as unknown as CompactionJob[];
  const m = processFlowModel({ ...base, jobs, bundleSkills: null });
  const l0l1 = m.edges.find((e) => e.id === 'L0-L1')!;
  assert.equal(l0l1.running, true);
  assert.equal(l0l1.breathing, false);
  assert.equal(m.nodes.find((n) => n.id === 'session')!.ariaLabel, 'Session config, live bundle unknown');
});

// Defect #10: NODE_WIDTH is 168 (CompactionFlowFrame.tsx) and a merge-edge
// label measures ~123px — the pitch must leave that label real room, not
// just clear the cards. 370 gives a 202px gap (370 - 168).
test('the pipeline column pitch leaves room for a merge-edge label', () => {
  const m = processFlowModel(base);
  const [l0, l1, l2] = ['L0', 'L1', 'L2'].map((id) => m.nodes.find((n) => n.id === id)!);
  assert.equal(l1.x - l0.x, 370);
  assert.equal(l2.x - l1.x, 370);
});

// Defect #12: a caller that couldn't read bot data (a member's /api/bots
// 403, or a malformed response) passes `botRunsToday: null` — the node must
// read as unknown, not a false 0, and must not offer a route it can't open.
test('an unreadable bot count renders as unknown, not a false zero, with no door', () => {
  const m = processFlowModel({ ...base, botRunsToday: null });
  const bots = m.nodes.find((n) => n.id === 'bots')!;
  assert.equal(bots.count, null);
  assert.equal(bots.ariaLabel, 'Bot runs, unknown — no access to bot data');
  assert.equal(bots.navigateTo, undefined);
});

test('a real zero bot count still reads as a fact, with its usual door', () => {
  const m = processFlowModel({ ...base, botRunsToday: 0 });
  const bots = m.nodes.find((n) => n.id === 'bots')!;
  assert.equal(bots.count, 0);
  assert.equal(bots.ariaLabel, 'Bot runs, 0 runs today');
  assert.equal(bots.navigateTo, '/admin/bots');
});

// Slice 1: every edge animates only when its own honest field says there
// is activity — never a flat true/false regardless of input, and never
// borrowing another edge's signal.
test('sessions-L0 gets the moving dot (running) iff activeWriters > 0', () => {
  const busy = processFlowModel({ ...base, activeWriters: 3 });
  const idle = processFlowModel({ ...base, activeWriters: 0 });
  const busyEdge = busy.edges.find((e) => e.id === 'sessions-L0')!;
  const idleEdge = idle.edges.find((e) => e.id === 'sessions-L0')!;
  assert.equal(busyEdge.running, true);
  assert.equal(busyEdge.breathing, false);
  assert.equal(idleEdge.running, false);
  assert.equal(idleEdge.breathing, false);
});

test('bots-L0/sweeps-L0/lab-L0 breathe (never run) iff their own count > 0', () => {
  const on = processFlowModel({ ...base, botRunsToday: 2, sweepFindings: 1, labSignals: 1 });
  const off = processFlowModel({ ...base, botRunsToday: 0, sweepFindings: 0, labSignals: 0 });
  for (const id of ['bots-L0', 'sweeps-L0', 'lab-L0']) {
    const onEdge = on.edges.find((e) => e.id === id)!;
    const offEdge = off.edges.find((e) => e.id === id)!;
    assert.equal(onEdge.breathing, true, `${id} should breathe`);
    assert.equal(onEdge.running, false, `${id} must never get the moving dot`);
    assert.equal(offEdge.breathing, false, `${id} should be static at zero`);
  }
});

test('an unreadable bot count (null) does not breathe — unknown is not activity', () => {
  const m = processFlowModel({ ...base, botRunsToday: null });
  assert.equal(m.edges.find((e) => e.id === 'bots-L0')!.breathing, false);
});

test('review-L1 breathes iff the sampling queue has a real backlog', () => {
  const backed = processFlowModel({ ...base, queueDepth: 5 });
  const clear = processFlowModel({ ...base, queueDepth: 0 });
  assert.equal(backed.edges.find((e) => e.id === 'review-L1')!.breathing, true);
  assert.equal(clear.edges.find((e) => e.id === 'review-L1')!.breathing, false);
});

test('L2-library, L2-promotions and library-session stay static and carry a title explaining why', () => {
  const m = processFlowModel(base);
  for (const id of ['L2-library', 'L2-promotions', 'library-session']) {
    const edge = m.edges.find((e) => e.id === id)!;
    assert.equal(edge.running, false, `${id} must stay static`);
    assert.equal(edge.breathing, false, `${id} must stay static`);
    assert.ok(edge.title && edge.title.length > 0, `${id} must explain why it can't animate`);
  }
});

test('labels landing on the same point are spread, others left alone', async () => {
  const { staggerLabelAnchors, LABEL_STAGGER_Y } = await import('../distillationFormat.ts');
  const out = staggerLabelAnchors([
    { x: 100, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 50 }, { x: 300, y: 50 },
  ]);
  assert.deepEqual(out.map((a) => a.y), [50 - LABEL_STAGGER_Y, 50, 50 + LABEL_STAGGER_Y, 50]);
  assert.ok(out.every((a, i) => a.x === [100, 100, 100, 300][i]), 'x is never moved');
  const single = staggerLabelAnchors([{ x: 1, y: 2 }]);
  assert.deepEqual(single, [{ x: 1, y: 2 }]);
});

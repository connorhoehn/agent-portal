// Rule 2 of docs/social-tenant-design.md §5.2 — every fleet invocation is a
// pipeline Run (docs/pipelines-tenant-goal.md §P1).
//
// A trace bundle that carries the AG-UI `runId` (agents/_shared/
// instrumentation.py) becomes EXACTLY ONE `kind: 'agent'` Run: its recorded
// STEP_STARTED/STEP_FINISHED pairs are the Steps, the TOOL_CALL_* inside each
// are the attempts, and the invocation_traces row is ONE `trace` Artifact. A
// bundle without a run id is COUNTED as unlinked — never dropped, never
// invented into a run of its own. A run relayed by routes/agents.ts exists as
// `running` from RUN_STARTED, before any bundle, and the bundle replaces it
// under the same Run id.
//
// The bundles go through the real sink offline (`processTrace` → the
// `trace-sink-traces` fixture → `traceRows()`), which is the path the harness
// callback and the CloudWatch poller both take — so what is pinned is the
// round trip, not a hand-built source row.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
}));
jest.mock('../../providers/cloudwatch.js', () => ({
  putDriftMetric: jest.fn(), putQualityMetric: jest.fn(), putSchemaMetric: jest.fn(),
}));

import { randomUUID } from 'node:crypto';
import { freezeClock, fixtureRegistry } from '../../mock/core/index.js';
import { processTrace, _resetCachesForTest } from '../trace-sink.js';
import { traceRows } from '../../mock/observability.js';
import {
  projectRuns, runEvents, normalizeAgentSteps, PIPELINE_RUN_STATUSES,
  type InvocationSource, type RunSources,
} from '../pipeline-runs.js';
import { invocationSourceFromRow } from '../../providers/pipeline-runs.js';
import {
  openAgentRun, recordAgentRunEvent, closeAgentRun, liveAgentRuns, _resetLiveAgentRunsForTest,
} from '../agent-runs-live.js';

const AT = '2026-09-29T15:00:00.000Z';
const EMPTY = { agentJobs: [], botRuns: [], agentProjectRuns: [], assessmentRuns: [] };

const invocations = (): InvocationSource[] =>
  traceRows().map((r) => invocationSourceFromRow({ ...r, ts_iso: r.tsIso }));

function onlyWritten(): InvocationSource[] {
  return invocations().filter((i) => !i.invocationId.startsWith('mock-inv-'));
}

const STEPS = [
  {
    stepId: 'search-1', name: 'search', status: 'completed',
    startedAt: '2026-09-29T14:59:58.000Z', finishedAt: '2026-09-29T14:59:59.000Z',
    toolCalls: [{ toolCallId: 'tc-1', name: 'search_organization', status: 'completed',
      startedAt: '2026-09-29T14:59:58.000Z', finishedAt: '2026-09-29T14:59:59.000Z' }],
  },
  {
    stepId: 'scoring-2', name: 'scoring', status: 'completed',
    startedAt: '2026-09-29T14:59:59.100Z', finishedAt: '2026-09-29T14:59:59.900Z',
    toolCalls: [{ toolCallId: 'tc-2', name: 'get_expertise_scores', status: 'completed',
      startedAt: '2026-09-29T14:59:59.100Z', finishedAt: '2026-09-29T14:59:59.900Z' }],
  },
];

async function postBundle(extra: Record<string, unknown>) {
  return processTrace({
    invocationId: randomUUID(),
    agentId: 'orgiq-supervisor',
    agentName: 'Supervisor',
    prompt: 'Who knows Kubernetes best?',
    response: 'Theo Chang — score 89 on Kubernetes.',
    modelId: 'amazon.nova-pro-v1:0',
    durationMs: 2100,
    userId: 'u-theo',
    ...extra,
  });
}

let restore = () => {};
beforeEach(() => {
  restore = freezeClock(AT);
  fixtureRegistry.resetAll('default');
  _resetCachesForTest();
  _resetLiveAgentRunsForTest();
});
afterEach(() => {
  restore();
  fixtureRegistry.resetAll('default');
  _resetCachesForTest();
  _resetLiveAgentRunsForTest();
});

describe('a bundle with a runId is exactly one agent Run', () => {
  it('with its recorded steps, their tool-call attempts, and one trace artifact', async () => {
    const res = await postBundle({ runId: 'run-abc', threadId: 'sess-1', tenant: 'orgiq', steps: STEPS });
    expect(res.inserted).toBe(true);

    const p = projectRuns({ ...EMPTY, invocations: onlyWritten() });
    const runs = p.runs.filter((r) => r.context.aguiRunId === 'run-abc');
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.id).toBe('agent-run:run-abc');
    expect(run.context.kind).toBe('agent');
    expect(run.definitionId).toBe('agent:orgiq-supervisor');
    expect(run.context).toMatchObject({ table: 'invocation_traces', id: res.invocationId, tenant: 'orgiq', threadId: 'sess-1' });
    expect(run.status).toBe('completed');
    expect(run.triggeredBy).toBe('u-theo');

    const steps = p.steps.get(run.id) ?? [];
    expect(steps.map((s) => [s.stepId, s.label, s.status])).toEqual([
      ['search-1', 'search', 'completed'], ['scoring-2', 'scoring', 'completed'],
    ]);
    expect(steps[0]!.attempts).toEqual([expect.objectContaining({ attempt: 1, label: 'search_organization', toolCallId: 'tc-1', status: 'completed' })]);
    expect(steps[1]!.attempts.map((a) => a.label)).toEqual(['get_expertise_scores']);

    const traces = p.artifacts.filter((a) => a.runId === run.id);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ kind: 'trace', uri: res.invocationId, id: `trace:${res.invocationId}` });
    expect(traces[0]!.meta['href']).toBe(`/api/observability/invocations/${res.invocationId}`);

    const events = runEvents(run, steps);
    expect(events[0]?.type).toBe('pipeline:run:started');
    expect(events.at(-1)?.type).toBe('pipeline:run:completed');
    expect(p.unlinked.invocation_traces).toBe(0);
  });

  it('the run title never carries the prompt (the projection is read across users and tenants)', async () => {
    await postBundle({ runId: 'run-private' });
    const p = projectRuns({ ...EMPTY, invocations: onlyWritten() });
    const run = p.runs.find((r) => r.context.aguiRunId === 'run-private')!;
    expect(run.context.title).toMatch(/ run$/);
    const source = invocationSourceFromRow({ invocation_id: 'x', prompt_snippet: 'my salary question' });
    expect(JSON.stringify(source)).not.toContain('salary');
  });

  it('a run with no STEP_* recorded still has one step — the invocation', async () => {
    await postBundle({ runId: 'run-nosteps' });
    const p = projectRuns({ ...EMPTY, invocations: onlyWritten() });
    const run = p.runs.find((r) => r.context.aguiRunId === 'run-nosteps')!;
    expect((p.steps.get(run.id) ?? []).map((s) => s.stepId)).toEqual(['invoke']);
  });

  it('a step the run recorded as failed fails the run, and the source status survives', async () => {
    const failed = [{ ...STEPS[0]!, status: 'failed', toolCalls: [{ ...STEPS[0]!.toolCalls[0]!, status: 'failed' }] }];
    await postBundle({ runId: 'run-fail', steps: failed });
    const p = projectRuns({ ...EMPTY, invocations: onlyWritten() });
    const run = p.runs.find((r) => r.context.aguiRunId === 'run-fail')!;
    expect(run.status).toBe('failed');
    expect(run.context.sourceStatus).toBe('failed');
    expect(p.steps.get(run.id)![0]!.attempts[0]!.status).toBe('failed');
  });

  it('a sub-agent trace with no run id folds into its parent run as a child, not unlinked', async () => {
    const parent = await postBundle({ runId: 'run-parent', steps: STEPS });
    await postBundle({ agentId: 'orgiq-search', agentName: 'Search', parentInvocationId: parent.invocationId });
    const p = projectRuns({ ...EMPTY, invocations: onlyWritten() });
    const run = p.runs.find((r) => r.context.aguiRunId === 'run-parent')!;
    expect(run.context.sources.map((s) => s.role)).toEqual(['primary', 'child']);
    expect(p.artifacts.filter((a) => a.runId === run.id && a.kind === 'trace')).toHaveLength(2);
    expect(p.unlinked.invocation_traces).toBe(0);
  });
});

describe('a bundle without a runId is counted as unlinked, not dropped', () => {
  it('is stored, projects no run, and is counted', async () => {
    const res = await postBundle({});
    expect(res.inserted).toBe(true);
    const rows = onlyWritten();
    expect(rows.map((r) => r.invocationId)).toContain(res.invocationId);
    const p = projectRuns({ ...EMPTY, invocations: rows });
    expect(p.runs.filter((r) => r.context.kind === 'agent')).toHaveLength(0);
    expect(p.unlinked.invocation_traces).toBe(1);
  });
});

describe('the once-each property over the invocation_traces fixture', () => {
  it('every trace row is in exactly one Run or counted unlinked — never both, never neither', async () => {
    await postBundle({ runId: 'run-once', steps: STEPS });
    await postBundle({});
    const rows = invocations();
    const p = projectRuns({ ...EMPTY, invocations: rows });

    const seen = new Map<string, number>();
    for (const run of p.runs) for (const s of run.context.sources) {
      expect(s.table).toBe('invocation_traces');
      seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
    }
    for (const n of seen.values()) expect(n).toBe(1);
    expect(seen.size + p.unlinked.invocation_traces).toBe(rows.length);
    // The curated cast's Ask traffic carries runs; the property is not over nothing.
    expect(p.runs.length).toBeGreaterThan(10);
    expect(p.unlinked.invocation_traces).toBeGreaterThan(0);
    for (const run of p.runs) {
      expect(PIPELINE_RUN_STATUSES).toContain(run.status);
      expect((p.steps.get(run.id) ?? []).length).toBeGreaterThan(0);
      expect(p.artifacts.filter((a) => a.runId === run.id && a.kind === 'trace').length).toBe(run.context.sources.length);
    }
  });

  it('seeded runs carry steps whose attempts are the row\'s own tool calls', () => {
    const seeded = invocations().filter((i) => i.aguiRunId);
    expect(seeded.length).toBeGreaterThan(0);
    for (const s of seeded) {
      expect(s.agentId).toBe('orgiq-supervisor');
      expect(s.userId).toBeTruthy();
      expect(s.steps?.length).toBeGreaterThan(0);
      for (const st of s.steps ?? []) expect(st.toolCalls).toHaveLength(1);
    }
  });
});

describe('a relayed run exists from RUN_STARTED, before its bundle', () => {
  it('is running with its steps while streaming, then the bundle replaces it under the same Run id', async () => {
    openAgentRun({ runId: 'run-live', threadId: 's', agentId: 'orgiq-supervisor', agentName: 'Supervisor',
      userId: 'u-theo', tenant: 'orgiq', prompt: 'who knows auth' });
    recordAgentRunEvent('run-live', { type: 'TOOL_CALL_START', toolCallId: 'tc-9', toolCallName: 'search_organization' });
    recordAgentRunEvent('run-live', { type: 'STEP_STARTED', stepName: 'search' });

    let p = projectRuns({ ...EMPTY, invocations: onlyWritten(), liveAgentRuns: liveAgentRuns() });
    let run = p.runs.find((r) => r.id === 'agent-run:run-live')!;
    expect(run.status).toBe('running');
    expect(run.context.sources).toEqual([]);
    // The relayed run is titled for its agent, never its asker's prompt.
    expect(run.context.title).toBe('Supervisor run');
    expect(p.steps.get(run.id)![0]).toMatchObject({ label: 'search', status: 'running' });
    expect(p.steps.get(run.id)![0]!.attempts[0]).toMatchObject({ label: 'search_organization', status: 'running' });

    recordAgentRunEvent('run-live', { type: 'TOOL_CALL_RESULT', toolCallId: 'tc-9' });
    recordAgentRunEvent('run-live', { type: 'STEP_FINISHED', stepName: 'search' });
    closeAgentRun('run-live', 'completed');
    p = projectRuns({ ...EMPTY, invocations: onlyWritten(), liveAgentRuns: liveAgentRuns() });
    expect(p.runs.find((r) => r.id === 'agent-run:run-live')!.context.sourceStatus).toBe('completed');

    const res = await postBundle({ runId: 'run-live', steps: STEPS });
    p = projectRuns({ ...EMPTY, invocations: onlyWritten(), liveAgentRuns: liveAgentRuns() });
    const same = p.runs.filter((r) => r.id === 'agent-run:run-live');
    expect(same).toHaveLength(1);
    run = same[0]!;
    expect(run.context.id).toBe(res.invocationId);
    expect(p.artifacts.filter((a) => a.runId === run.id)).toHaveLength(1);
  });

  it('a relayed run that errors closes failed, open steps and all', () => {
    openAgentRun({ runId: 'run-err', threadId: null, agentId: 'orgiq-supervisor', agentName: 'Supervisor',
      userId: null, tenant: null, prompt: null });
    recordAgentRunEvent('run-err', { type: 'STEP_STARTED', stepName: 'advisor' });
    closeAgentRun('run-err', 'failed', 'A2A timeout');
    const p = projectRuns({ ...EMPTY, liveAgentRuns: liveAgentRuns() } as RunSources);
    const run = p.runs.find((r) => r.id === 'agent-run:run-err')!;
    expect(run.status).toBe('failed');
    expect(run.context.error).toBe('A2A timeout');
    expect(p.steps.get(run.id)![0]!.status).toBe('failed');
  });
});

describe('normalizeAgentSteps — the bundle is agent output, checked not trusted', () => {
  it('bounds, defaults and rejects', () => {
    expect(normalizeAgentSteps('not json')).toBeNull();
    expect(normalizeAgentSteps({ not: 'an array' })).toBeNull();
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, status: 'weird' }));
    const out = normalizeAgentSteps(many)!;
    expect(out).toHaveLength(50);
    expect(out[0]).toMatchObject({ stepId: 's0-1', status: 'running', toolCalls: [] });
    expect(normalizeAgentSteps(JSON.stringify(STEPS))).toHaveLength(2);
  });
});

describe('the live relay and mock scopes', () => {
  it('lists a run only in the scope it started in (the shared world never sees a scoped run)', async () => {
    const live = await import('../agent-runs-live.js');
    const scopeMod = await import('../../mock/core/scope.js');
    live._resetLiveAgentRunsForTest();
    const scope = scopeMod.createMockScope({ scenario: 'empty' } as never);
    scopeMod.runInMockScope(scope, () => live.openAgentRun({ runId: 'r-scoped', threadId: null, agentId: 'a', agentName: 'A', userId: null, tenant: 'orgiq', prompt: null }));
    live.openAgentRun({ runId: 'r-shared', threadId: null, agentId: 'a', agentName: 'A', userId: null, tenant: 'orgiq', prompt: null });
    expect(live.liveAgentRuns().map((r) => r.runId)).toEqual(['r-shared']);
    expect(scopeMod.runInMockScope(scope, () => live.liveAgentRuns().map((r) => r.runId))).toEqual(['r-scoped']);
    live._resetLiveAgentRunsForTest();
  });
});

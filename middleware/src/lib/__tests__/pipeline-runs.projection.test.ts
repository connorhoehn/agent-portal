// The projection property (docs/pipelines-tenant-goal.md §"The projection"):
// every row of the six run-shaped tables' registered fixtures is named in
// exactly one Run's context.sources[] — or, for an invocation_traces row with
// no AG-UI run id and no linked parent (P1), counted in `unlinked` — every
// Run's status is one of
// pipeline-runtime's nine, every context.sourceStatus is the primary row's own
// status, and every Run carries its context tenant.
//
// The fixtures are imported directly — `agentJobs` (mock/agent-jobs.ts),
// `botRuns` (mock/bots.ts), `agentProjectRuns` (mock/agent-project-runs.ts),
// `runsFixture` (mock/assessment.ts, the assessment_runs rows) and the
// seeded invocation traces — so a
// fixture that grows a row the projection drops, or double-counts, fails here.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));

import {
  PIPELINE_RUN_STATUSES, crosswalkStatus, projectRuns, runEvents, SOURCE_TABLES, traceSourceStatus, agentTenant,
  type RunSources, type SourceTable, type Run,
} from '../pipeline-runs.js';
import { agentJobs } from '../../mock/agent-jobs.js';
import { botRuns } from '../../mock/bots.js';
import { agentProjectRuns } from '../../mock/agent-project-runs.js';
import { runsFixture } from '../../mock/assessment.js';
import { traceRows } from '../../mock/observability.js';
import { invocationSourceFromRow } from '../../providers/pipeline-runs.js';
import type { ScenarioName } from '../../mock/core/index.js';

function fixtureSources(scenario?: ScenarioName): RunSources {
  return {
    agentJobs: agentJobs.rows(scenario),
    botRuns: botRuns.rows(scenario),
    agentProjectRuns: agentProjectRuns.rows(scenario),
    assessmentRuns: runsFixture.rows(scenario),
    // invocation_traces — the seeded day plus written bundles (mock/observability.ts).
    invocations: traceRows(scenario).map((r) => invocationSourceFromRow({ ...r, ts_iso: r.tsIso })),
  };
}

function sourceRows(src: RunSources): Array<{ table: SourceTable; id: string; status: string }> {
  return [
    ...src.agentJobs.map((r) => ({ table: 'agent_jobs' as const, id: r.id, status: r.status })),
    ...src.botRuns.map((r) => ({ table: 'bot_runs' as const, id: r.id, status: r.status })),
    ...src.agentProjectRuns.map((r) => ({ table: 'agent_project_runs' as const, id: r.id, status: r.status })),
    ...src.assessmentRuns.map((r) => ({ table: 'assessment_runs' as const, id: r.id, status: r.status })),
    ...(src.invocations ?? []).map((r) => ({ table: 'invocation_traces' as const, id: r.invocationId, status: traceSourceStatus(r) })),
  ];
}

describe('the run projection over the registered fixtures', () => {
  const src = fixtureSources();
  const { runs, steps, unlinked } = projectRuns(src);
  const rows = sourceRows(src);

  it('every fixture is non-empty (a property over nothing is not a pass)', () => {
    for (const t of SOURCE_TABLES) expect(rows.filter((r) => r.table === t).length).toBeGreaterThan(0);
  });

  it('names every source row in exactly one Run', () => {
    const seen = new Map<string, number>();
    for (const run of runs) for (const s of run.context.sources) {
      const k = `${s.table}:${s.id}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const r of rows) {
      const n = seen.get(`${r.table}:${r.id}`);
      // An unlinked trace is the one row allowed in no Run (it is counted below).
      if (r.table === 'invocation_traces' && n === undefined) continue;
      expect([`${r.table}:${r.id}`, n]).toEqual([`${r.table}:${r.id}`, 1]);
    }
    // …invents none, and every row not in a Run is counted, not dropped.
    expect(seen.size + unlinked.invocation_traces).toBe(rows.length);
  });

  it('gives every Run one of the nine PipelineRunStatus values', () => {
    for (const run of runs) expect(PIPELINE_RUN_STATUSES).toContain(run.status);
  });

  it('keeps each primary row\'s own status as context.sourceStatus, and crosswalks it', () => {
    const byKey = new Map(rows.map((r) => [`${r.table}:${r.id}`, r.status]));
    for (const run of runs) {
      expect(run.context.sourceStatus).toBe(byKey.get(`${run.context.table}:${run.context.id}`));
      expect(run.status).toBe(crosswalkStatus(run.context.sourceStatus));
      for (const s of run.context.sources) expect(s.status).toBe(byKey.get(`${s.table}:${s.id}`));
    }
  });

  it('carries the context tenant the table decides (an agent run: the trace\'s own)', () => {
    const traceById = new Map((src.invocations ?? []).map((i) => [i.invocationId, i]));
    for (const run of runs) {
      const trace = run.context.table === 'invocation_traces' ? traceById.get(run.context.id) : undefined;
      const want = trace ? agentTenant(trace.agentId, trace.tenant)
        : run.context.table === 'assessment_runs' ? 'assessment' : 'orgiq';
      expect(run.context.tenant).toBe(want);
      expect(run.tenant).toBe(want);
    }
  });

  it('folds a bot run with a job_id into that job\'s Run as its trigger', () => {
    const withJob = src.botRuns.filter((b) => b.jobId);
    expect(withJob.length).toBeGreaterThan(0);
    for (const b of withJob) {
      const run = runs.find((r) => r.context.sources.some((s) => s.table === 'bot_runs' && s.id === b.id)) as Run;
      expect(run.context.table).toBe('agent_jobs');
      expect(run.context.id).toBe(b.jobId);
      expect(run.context.sources.find((s) => s.id === b.id)?.role).toBe('trigger');
    }
  });

  it('gives a maintenance bot\'s job run at least three steps and a replayable event history', () => {
    const run = runs.find((r) => r.context.table === 'agent_jobs' && r.context.trigger === 'cron') as Run;
    const s = steps.get(run.id) ?? [];
    expect(s.length).toBeGreaterThanOrEqual(3);
    const events = runEvents(run, s);
    expect(events[0]?.type).toBe('pipeline:run:started');
    expect(events.every((e) => /^pipeline[:.]/.test(e.type))).toBe(true);
  });

  it('holds the property under every declared scenario the six share', () => {
    for (const scenario of ['empty'] as ScenarioName[]) {
      const s2 = fixtureSources(scenario);
      const p2 = projectRuns(s2);
      const count = p2.runs.reduce((n, r) => n + r.context.sources.length, 0);
      expect(count + p2.unlinked.invocation_traces).toBe(sourceRows(s2).length);
    }
  });
});

describe('crosswalkStatus (research §D.3)', () => {
  it.each([
    ['queued', 'pending'], ['claimed', 'running'], ['running', 'running'],
    ['awaiting_review', 'awaiting_approval'], ['done', 'completed'], ['succeeded', 'completed'],
    ['completed', 'completed'], ['skipped', 'cancelled'], ['blocked', 'rejected'],
    ['failed', 'failed'], ['cancelled', 'cancelled'],
  ])('%s → %s', (from, to) => { expect(crosswalkStatus(from)).toBe(to); });

  it('reads a status no table produces as stuck, never as healthy', () => {
    expect(crosswalkStatus('mystery')).toBe('stuck');
  });
});

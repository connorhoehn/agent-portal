// System › Logging (docs/voice-navigator-gaps.md G37): each source's model
// from fixture payloads shaped as its routes answer (rows, day groups, the
// record), the rule that a source the persona cannot read is not offered, the
// paths and the Voice log's redirects, and the real view rendered per source.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGGING_PATH, dayGroupsBy, inRange, legacyVoiceLogTarget, lifecycleEvents, loggingHref, offeredSources, parseLoggingPath, pipelineRunsBase,
  readOutcome, rowKey, sourceInTenant, sourceOptions, type LogSource, type ReadOutcome,
} from '../loggingModel.ts';
import { BOT_RUN, INVOCATION, agentRows, botRunRecord, botRunsApi, invocationRecord, type BotRunRow, type InvocationDetail, type InvocationRow } from '../agentsLogModel.ts';
import { pipelineEventRows, pipelineRecord, pipelineRows } from '../pipelinesLogModel.ts';
import { AGENT_JOB, SWEEP_RUN, agentJobRecord, jobRows, sweepJobRecord, sweepRunRecord, type SweepJob, type SweepRun, type WorkJob } from '../jobsLogModel.ts';
import type { PipelineRun, PipelineStep } from '../../../lib/pipelineRuns.ts';
import { landing, renderLogging } from './renderLogging.ts';

const NOW = new Date(2026, 10, 8, 18, 0);
const today = (h: number, m = 0) => new Date(2026, 10, 8, h, m).toISOString();
const yesterday = (h: number) => new Date(2026, 10, 7, h).toISOString();
const older = (h: number) => new Date(2026, 10, 1, h).toISOString();

// ── Fixtures, shaped as the routes answer ───────────────────────────────────

const BOTS = [{ id: 'bot-1', name: 'Dependency sweeper' }];
const BOT_RUN_ROW: BotRunRow = {
  id: 'br-1', botId: 'bot-1', trigger: 'cron', runId: null, jobId: 'job-dep-maint-1', workItemId: null, status: 'done', costUsd: 0.0421,
  modelProvider: null, startedAt: today(9), finishedAt: today(9, 4), outcome: { reason: 'scheduled maintenance', turns: 3, toolCalls: 2 }, dispatchedBy: null,
};
const INVOCATION_ROW: InvocationRow = {
  invocationId: 'mock-inv-33', agentId: 'researcher', agentName: 'Researcher', promptSnippet: 'Summarize', judgeScore: 0.83, durationMs: 2100, totalCostUsd: 0.0021, modelId: 'nova-pro', ts: yesterday(15),
};
const INVOCATION_DETAIL: InvocationDetail = {
  invocation: {
    ...INVOCATION_ROW, templateId: 'research', responseSnippet: 'Done', schemaValid: true, guardrailAction: null, inputTokens: 1200, outputTokens: 300,
    estCostUsd: 0.0018, judgeCostUsd: 0.0003, promptVersion: 'v4', parentInvocationId: null, userId: 'u1', sessionId: 's1',
  },
  toolCalls: [
    { toolCallId: 'tc-1', toolName: 'kb_search', startedAt: new Date(Date.parse(yesterday(15)) + 200).toISOString(), durationMs: 640, errored: false, errorMessage: null, estCostUsd: null },
    { toolCallId: 'tc-2', toolName: 'graph_read', startedAt: new Date(Date.parse(yesterday(15)) + 900).toISOString(), durationMs: 120, errored: true, errorMessage: 'timeout', estCostUsd: null },
  ],
  parent: null,
  children: [{ invocationId: 'mock-inv-34', agentName: 'Writer', durationMs: 400, ts: new Date(Date.parse(yesterday(15)) + 1500).toISOString() }],
};
const RUN: PipelineRun = {
  id: 'agent_jobs:job-7', definitionId: 'bot:bot-1', tenant: 'orgiq', status: 'completed', triggeredBy: null, triggerType: 'cron',
  startedAt: today(11), finishedAt: today(11, 2), costUsd: null,
  context: { tenant: 'orgiq', kind: 'bot', table: 'agent_jobs', id: 'job-7', sourceStatus: 'done', sources: [{ table: 'agent_jobs', id: 'job-7', status: 'done', role: 'primary' }], title: 'Dependency sweeper' },
};
const STEPS: PipelineStep[] = [
  { runId: RUN.id, stepId: 'claim', label: 'Claim', status: 'completed', startedAt: today(11), finishedAt: today(11, 0), attempts: [{ attempt: 1, status: 'completed' }] },
  { runId: RUN.id, stepId: 'execute', label: 'Execute', status: 'completed', startedAt: today(11, 0), finishedAt: today(11, 2), attempts: [{ attempt: 1, status: 'completed', label: 'read_file' }, { attempt: 2, status: 'completed', label: 'write_file' }] },
];
const JOB: WorkJob = {
  id: 'job-9', kind: 'agent', title: 'Fix the flaky test', status: 'done', priority: 5, boxId: 'box-2', attempts: 1, maxAttempts: 3,
  result: { summary: 'Fixed', toolCallList: [{ name: 'read_file', done: true }, { name: 'run_tests', done: true }] }, error: null, createdBy: 'u1',
  createdAt: today(8), claimedAt: today(8, 1), startedAt: today(8, 2), finishedAt: today(8, 10), botId: null, botName: null,
};
const SWEEP: SweepRun = { id: 'sr-1', tenant: 'orgiq', sweep: 'stale_docs', botId: null, startedAt: older(3), finishedAt: older(3), status: 'failed', error: 'graph unavailable', findings: null, durationMs: 1800 };
const SWEEP_JOB_ROW: SweepJob = { jobId: 'sj-1', kind: 'sweep', sweep: null, title: 'The nightly org sweeps', state: 'done', detail: '3 findings', href: '/iq/work/findings', queuedAt: today(12), startedAt: today(12, 1), finishedAt: today(12, 2) };

// ── Paths and the redirect ──────────────────────────────────────────────────

test('paths: each source and kind round-trips, the bare page names no source', () => {
  assert.equal(loggingHref('voice', null, 'vs_1'), '/iq/logging/voice/vs_1');
  assert.equal(loggingHref('agents', BOT_RUN, 'br-1'), '/iq/logging/agents/bot-runs/br-1');
  assert.equal(loggingHref('pipelines', 'run', 'agent_jobs:job-7'), '/iq/logging/pipelines/agent_jobs%3Ajob-7');
  assert.equal(loggingHref('jobs'), '/iq/logging/jobs');
  assert.deepEqual(parseLoggingPath('/iq/logging/pipelines/agent_jobs%3Ajob-7'), { source: 'pipelines', kind: null, id: 'agent_jobs:job-7' });
  assert.deepEqual(parseLoggingPath('/iq/logging/jobs/sweep-runs/sr-1'), { source: 'jobs', kind: 'sweep-runs', id: 'sr-1' });
  assert.deepEqual(parseLoggingPath('/iq/logging/agents'), { source: 'agents', kind: null, id: null });
  assert.deepEqual(parseLoggingPath(LOGGING_PATH), { source: null, kind: null, id: null });
  assert.deepEqual(parseLoggingPath('/iq/logging/bogus/x'), { source: null, kind: null, id: null });
});

test('the Voice log redirects: /iq/voice-log → /iq/logging, /iq/voice-log/<id> → /iq/logging/voice/<id>, the query kept', async () => {
  assert.equal(legacyVoiceLogTarget(null), '/iq/logging');
  assert.equal(legacyVoiceLogTarget('vs_1', '?range=today'), '/iq/logging/voice/vs_1?range=today');
  // Through the router, as App.tsx mounts the redirect.
  assert.equal(await landing('/iq/voice-log', '/iq/voice-log'), '/iq/logging');
  assert.equal(await landing('/iq/voice-log/vs_00dd?range=week', '/iq/voice-log/:sessionId'), '/iq/logging/voice/vs_00dd?range=week');
});

// ── The gate: a source the persona cannot read is not offered ───────────────

test('a source is offered only in its tenant and when one of its reads answered; refused or skipped reads leave it out', () => {
  const all = (o: ReadOutcome): Record<LogSource, ReadOutcome[]> => ({ voice: [o], agents: [o, o], pipelines: [o], jobs: [o, o] });
  assert.deepEqual(offeredSources('orgiq', all('ok')), ['voice', 'agents', 'pipelines', 'jobs']);
  // A member: no bot runs (readGate 403), no invocations (ViewObservability 403), no sweep runs; the work queue reads.
  assert.deepEqual(offeredSources('orgiq', { voice: ['ok'], agents: ['denied', 'denied'], pipelines: ['denied'], jobs: ['ok', 'denied'] }), ['voice', 'jobs']);
  // The pipelines tenant: its run projection only; the orgiq routes are not even read (skipped).
  assert.deepEqual(offeredSources('pipelines', { voice: ['ok'], agents: ['skipped', 'skipped'], pipelines: ['ok'], jobs: ['skipped', 'skipped'] }), ['voice', 'pipelines']);
  // A tenant without a source never offers it, whatever answered.
  assert.deepEqual(offeredSources('assessment', all('ok')), ['voice']);
  // Still loading: held back. An error that is not a refusal: offered, so the failure shows in the rail.
  assert.deepEqual(offeredSources('orgiq', { voice: ['pending'], agents: ['ok', 'pending'], pipelines: ['error'], jobs: ['denied', 'error'] }), ['agents', 'pipelines', 'jobs']);
  assert.equal(sourceInTenant('agents', 'pipelines'), false);
  // The control lists only what is offered (the open source stays while its reads settle).
  assert.deepEqual(sourceOptions('voice', ['voice', 'jobs']).map((o) => o.label), ['Voice', 'Jobs and sweeps']);
  assert.deepEqual(sourceOptions('agents', ['voice']).map((o) => o.value), ['voice', 'agents']);
  assert.equal(pipelineRunsBase('orgiq'), '/api/runs');
  assert.equal(pipelineRunsBase('pipelines'), '/api/pipelines/runs');
  assert.equal(pipelineRunsBase('social'), null);
  // What useFetch holds → the outcome: 403 (a tenant mount or a role gate) and 404 are refusals.
  assert.equal(readOutcome({ data: null, error: '403 Forbidden', failure: { status: 403, kind: 'forbidden' } }), 'denied');
  assert.equal(readOutcome({ data: null, error: '404 Not Found', failure: { status: 404, kind: 'http' } }), 'denied');
  assert.equal(readOutcome({ data: null, error: '500', failure: { status: 500, kind: 'http' } }), 'error');
  assert.equal(readOutcome({ data: { runs: [] }, error: null, failure: null }), 'ok');
  assert.equal(readOutcome({ data: null, error: null, failure: null }), 'pending');
  assert.equal(readOutcome({ data: null, error: null, failure: null, skipped: true }), 'skipped');
});

// ── Day groups and the range ────────────────────────────────────────────────

test('rows group by day, newest first, and the range filters them', () => {
  const rows = [{ at: today(9) }, { at: today(7) }, { at: yesterday(20) }, { at: older(3) }, { at: 'nope' }];
  const g = dayGroupsBy(rows, (r) => r.at, NOW, 'en-GB');
  assert.deepEqual(g.groups.map((x) => [x.title, x.count]), [['Today', 2], ['Yesterday', 1], ['1 Nov', 1], ['Undated', 1]]);
  assert.equal(inRange(today(1), 'today', NOW), true);
  assert.equal(inRange(yesterday(23), 'today', NOW), false);
  assert.equal(inRange(older(3), 'week', NOW), false);
  assert.equal(inRange(new Date(2026, 10, 2, 0, 1).toISOString(), 'week', NOW), true);
  assert.equal(inRange('nope', 'all', NOW), true);
  assert.deepEqual(lifecycleEvents([{ at: today(2), kind: 'b' }, { at: null, kind: 'skip' }, { at: today(1), kind: 'a', data: { x: 1 } }]).map((e) => [e.seq, e.kind, e.data]),
    [[1, 'a', '{"x":1}'], [2, 'b', '']]);
});

// ── Agents ──────────────────────────────────────────────────────────────────

test('agents: bot runs and invocations share the rail newest first; each record has its cost, tool calls and events', () => {
  assert.equal(botRunsApi(['bot-1', 'bot-2']), '/api/bots/runs?botIds=bot-1%2Cbot-2');
  const rows = agentRows(BOTS, [BOT_RUN_ROW], [INVOCATION_ROW]);
  assert.deepEqual(rows.map(rowKey), [`${BOT_RUN}/br-1`, `${INVOCATION}/mock-inv-33`]);
  assert.equal(rows[0]!.subline, 'Dependency sweeper · bot run, cron · done · $0.0421');
  assert.equal(rows[1]!.subline, 'Researcher · invocation · 2.1 s · $0.0021');

  const job = { id: 'job-dep-maint-1', status: 'done', createdAt: today(9), claimedAt: today(9, 1), startedAt: today(9, 1), finishedAt: today(9, 4), boxId: 'box-1', error: null, result: { toolCallList: [{ name: 'read_file', done: true }, { name: 'open_pr', done: true }] } };
  const run = botRunRecord(BOT_RUN_ROW, 'Dependency sweeper', job);
  assert.equal(run.facts.find((f) => f.label === 'Cost')!.value, '$0.0421');
  assert.equal(run.facts.find((f) => f.label === 'Served by')!.value, 'not recorded', 'a null provider reads as unknown, never bedrock');
  assert.deepEqual(run.calls.map((c) => c.name), ['read_file', 'open_pr']);
  assert.deepEqual(run.events.map((e) => e.kind), ['started', 'job queued', 'job claimed', 'job running', 'job done', 'done']);
  // Without the job (its read refused): the run's own marks, no tool calls.
  const bare = botRunRecord({ ...BOT_RUN_ROW, costUsd: null }, null, null);
  assert.equal(bare.calls.length, 0);
  assert.equal(bare.facts.find((f) => f.label === 'Cost')!.value, 'not recorded', 'unknown cost is unknown, not zero');
  assert.deepEqual(bare.events.map((e) => e.kind), ['started', 'done']);

  const inv = invocationRecord(INVOCATION_DETAIL);
  assert.equal(inv.facts.find((f) => f.label === 'Cost')!.value, '$0.0021 (judge $0.0003)');
  assert.equal(inv.facts.find((f) => f.label === 'Tokens')!.value, '1200 in, 300 out');
  assert.deepEqual(inv.calls.map((c) => [c.name, c.outcome, c.detail]), [['kb_search', 'ok', ''], ['graph_read', 'errored', 'timeout']]);
  assert.deepEqual(inv.events.map((e) => e.kind), ['invoked', 'tool call', 'tool errored', 'child', 'answered']);
});

// ── Pipelines ───────────────────────────────────────────────────────────────

test('pipelines: a run row, its steps as the table, and the event stream as the events', () => {
  const rows = pipelineRows([RUN, { ...RUN, id: 'agent_jobs:job-6', startedAt: yesterday(9) }]);
  assert.deepEqual(rows.map((r) => r.id), ['agent_jobs:job-7', 'agent_jobs:job-6']);
  assert.equal(rows[0]!.subline, 'Dependency sweeper · Bot · completed · orgiq');
  const frames = [
    { type: 'pipeline:run:started', runId: RUN.id, at: today(11), status: 'completed', replay: true },
    { type: 'pipeline:step:completed', runId: RUN.id, stepId: 'execute', at: today(11, 2), status: 'completed', replay: true },
    { type: 'pipeline:step:heartbeat', runId: RUN.id, stepId: 'execute', at: today(11, 3), detail: 'tail', replay: false },
  ];
  assert.deepEqual(pipelineEventRows(frames).map((e) => [e.seq, e.kind, e.data]), [
    [1, 'pipeline:run:started', 'completed'], [2, 'pipeline:step:completed', 'step execute · completed'], [3, 'pipeline:step:heartbeat', 'step execute · tail · live'],
  ]);
  const rec = pipelineRecord(RUN, STEPS, frames);
  assert.equal(rec.callsTitle, 'Steps');
  assert.deepEqual(rec.calls.map((c) => [c.name, c.outcome, c.detail]), [['Claim', 'completed', ''], ['Execute', 'completed', 'read_file, write_file']]);
  assert.equal(rec.facts.find((f) => f.label === 'Cost')!.value, 'not recorded');
  assert.equal(rec.facts.find((f) => f.label === 'Status')!.value, 'completed (source done)');
  assert.equal(rec.events.length, 3);
  // Before the stream opens: the steps' own marks.
  assert.deepEqual(pipelineRecord(RUN, STEPS, null).events.map((e) => e.kind),
    ['pipeline:run:started', 'pipeline:step:started', 'pipeline:step:completed', 'pipeline:step:started', 'pipeline:step:completed', 'pipeline:run:completed']);
});

// ── Jobs and sweeps ─────────────────────────────────────────────────────────

test('jobs and sweeps: agent jobs and sweep runs share the rail; a sweep job opens by its id', () => {
  const rows = jobRows([JOB], [SWEEP]);
  assert.deepEqual(rows.map(rowKey), [`${AGENT_JOB}/job-9`, `${SWEEP_RUN}/sr-1`]);
  assert.equal(rows[0]!.subline, 'Fix the flaky test · agent job · done');
  assert.equal(rows[1]!.subline, 'The stale docs sweep · failed · 1.8 s');
  const job = agentJobRecord(JOB);
  assert.deepEqual(job.calls.map((c) => c.name), ['read_file', 'run_tests']);
  assert.deepEqual(job.events.map((e) => e.kind), ['queued', 'claimed', 'running', 'done']);
  assert.equal(job.facts.find((f) => f.label === 'Took')!.value, '8m 0s');
  const sweep = sweepRunRecord(SWEEP);
  assert.equal(sweep.facts.find((f) => f.label === 'Error')!.value, 'graph unavailable');
  assert.deepEqual(sweep.events.map((e) => [e.kind, e.data]), [['running', '{"sweep":"stale_docs"}'], ['failed', '{"error":"graph unavailable"}']]);
  const sj = sweepJobRecord(SWEEP_JOB_ROW);
  assert.deepEqual(sj.events.map((e) => e.kind), ['queued', 'running', 'done']);
  assert.equal(sj.facts.find((f) => f.label === 'Outcome')!.value, '3 findings');
});

// ── The view, per source ────────────────────────────────────────────────────

test('the view: one frame for every source (trail, one title, the source control first), and each record\'s three parts', async () => {
  const cases: Array<{ source: LogSource; at: string; rows: ReturnType<typeof agentRows>; record: ReturnType<typeof agentJobRecord>; expect: RegExp[] }> = [
    { source: 'agents', at: '/iq/logging/agents/bot-runs/br-1', rows: agentRows(BOTS, [BOT_RUN_ROW], [INVOCATION_ROW]),
      record: botRunRecord(BOT_RUN_ROW, 'Dependency sweeper', null), expect: [/Dependency sweeper · bot run, cron/, /\$0\.0421/, />Bot run</] },
    { source: 'pipelines', at: '/iq/logging/pipelines/agent_jobs%3Ajob-7', rows: pipelineRows([RUN]),
      record: pipelineRecord(RUN, STEPS, null), expect: [/>Steps</, />Execute</, /pipeline:run:completed/] },
    { source: 'jobs', at: '/iq/logging/jobs/sweep-runs/sr-1', rows: jobRows([JOB], [SWEEP]),
      record: sweepRunRecord(SWEEP), expect: [/The stale docs sweep · failed/, /graph unavailable/, />Sweep run</] },
  ];
  for (const c of cases) {
    const html = await renderLogging({ source: c.source, rows: c.rows, selectedKey: rowKey(c.record), record: c.record }, c.at);
    assert.match(html, /data-testid="logging"/, c.source);
    assert.match(html, /data-shell-flush/, `${c.source}: the flush list rail`);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${c.source}: one title`);
    assert.match(html, /<h1[^>]*>[^<]*Logging/, c.source);
    assert.match(html, />System</, `${c.source}: the trail`);
    assert.ok(html.indexOf('aria-label="Source"') < html.indexOf('aria-label="Started"'), `${c.source}: the source control comes first in the filter row`);
    for (const id of ['logging-detail', 'logging-calls', 'logging-events']) assert.match(html, new RegExp(`data-testid="${id}"`), `${c.source}: ${id}`);
    assert.match(html, /Copy as JSON/);
    assert.doesNotMatch(html, /Download export/, `${c.source}: no export where the source has none`);
    assert.doesNotMatch(html, /Keep transcripts/, `${c.source}: the device switches are Voice's`);
    for (const re of c.expect) assert.match(html, re, `${c.source}: ${re}`);
  }
  const empty = await renderLogging({ source: 'jobs', sources: ['voice', 'jobs'], rows: [], selectedKey: null, record: null }, '/iq/logging/jobs');
  assert.match(empty, /data-value="jobs"/, 'the control shows the open source');
  assert.match(empty, /No jobs and sweeps yet/);
});

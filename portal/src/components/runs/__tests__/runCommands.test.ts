import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunCommand, resolveRunCommand, resolveRunTarget, runCommandExamples, type RunCommandScope } from '../runCommands.ts';
import type { PipelineRun } from '../../../lib/pipelineRuns.ts';

function run(id: string, title: string, status = 'running'): PipelineRun {
  return { id, definitionId: 'agent:search', tenant: 'orgiq', status: status as PipelineRun['status'], triggeredBy: null,
    triggerType: 'manual', startedAt: null, finishedAt: null, costUsd: null,
    context: { tenant: 'orgiq', title, kind: 'agent', table: 'agent_jobs', id, sourceStatus: status, sources: [] } };
}
const runs = [run('job:1', 'Auth migration'), run('job:2', 'Auth migration retry'), run('job:3', 'Release notes', 'completed')];
const scope: RunCommandScope = { runs, endpoint: '/api/pipelines/runs', detailBase: '/pipelines/runs', showWorkspace: true, canCancel: true };

for (const [phrase, expected] of [
  ['show failed runs', { status: 'failed' }],
  ['please show running agent runs', { status: 'running', kind: 'agent' }],
  ['show succeeded runs', { status: 'completed' }],
  ['show successful runs.', { status: 'completed' }],
  ['show failed runs in work', { status: 'failed', contextTenant: 'orgiq' }],
  ['workspace assessment', { contextTenant: 'assessment' }],
  ['kind assessment commands', { kind: 'assessment-command' }],
  ['show pending bot runs in assessment', { status: 'pending', kind: 'bot', contextTenant: 'assessment' }],
  ['show awaiting approval runs', { status: 'awaiting_approval' }],
  ['show paused runs', { status: 'paused_at_breakpoint' }],
  ['search titles for "Auth Migration"', { title: 'Auth Migration' }],
  ['find runs named "Release notes"', { title: 'Release notes' }],
] as const) test(`interprets ${phrase}`, () => assert.deepEqual(parseRunCommand(phrase), { kind: 'filter', filters: expected }));

for (const phrase of ['reset filters', 'clear all filters', 'show all runs']) test(`resets: ${phrase}`, () => assert.deepEqual(parseRunCommand(phrase), { kind: 'reset' }));
test('refresh and help are explicit intents', () => {
  assert.deepEqual(parseRunCommand('refresh the table'), { kind: 'refresh' });
  assert.deepEqual(parseRunCommand('help'), { kind: 'help' });
});

for (const phrase of ['show failed runs from last week', 'show not failed runs', 'show failed and running runs',
  'show failed runs; cancel job:1', 'show failed runs in finance', 'show expensive runs', 'find failed runs from yesterday',
  'filter status failed then refresh', 'show running runs except bots', 'show running runs in work and assessment',
  'show running bots and agents', 'delete all runs', 'approve job:1', '', 'x'.repeat(501)]) {
  test(`rejects unsupported language without a partial query: ${phrase.slice(0, 70)}`, () => assert.throws(() => parseRunCommand(phrase)));
}
for (const phrase of ['cancel all runs', 'cancel everything', 'cancel selected runs', 'open all runs']) {
  test(`refuses bulk targeting: ${phrase}`, () => assert.throws(() => parseRunCommand(phrase), /one run/));
}

test('action targets preserve case and punctuation rather than rewriting IDs', () => {
  assert.deepEqual(parseRunCommand('cancel run "job:Case."'), { kind: 'cancel', target: 'job:Case.' });
  assert.deepEqual(parseRunCommand('open Auth migration'), { kind: 'open', target: 'Auth migration' });
});
test('resolves an exact ID or title before partial titles', () => {
  assert.equal(resolveRunTarget('job:1', runs).id, 'job:1');
  assert.equal(resolveRunTarget('Auth migration', runs).id, 'job:1');
  assert.equal(resolveRunTarget('retry', runs).id, 'job:2');
});
test('IDs remain case-sensitive even when titles are matched without case', () => {
  const collision = [run('job:Case', 'First'), run('job:case', 'Second')];
  assert.equal(resolveRunTarget('job:case', collision).context.title, 'Second');
  assert.equal(resolveRunTarget('job:Case', collision).context.title, 'First');
  assert.throws(() => resolveRunTarget('job:CASE', collision), /No matching run/);
});
test('ambiguous and missing targets never select an arbitrary row', () => {
  assert.throws(() => resolveRunTarget('Auth', runs), /matches 2 runs/);
  assert.throws(() => resolveRunTarget('missing', runs), /No matching run/);
  assert.throws(() => resolveRunTarget('Same', [run('a', 'Same'), run('b', 'Same')]), /matches 2 runs/);
});
test('cancellation returns only a proposal for one nonterminal run', () => {
  assert.deepEqual(resolveRunCommand(parseRunCommand('cancel job:1'), scope), { kind: 'cancel', run: runs[0] });
  assert.throws(() => resolveRunCommand(parseRunCommand('cancel job:3'), scope), /already finished/);
  assert.throws(() => resolveRunCommand(parseRunCommand('cancel Auth'), scope), /matches 2 runs/);
});
test('rechecks current authorization and current snapshot before confirmation', () => {
  const command = parseRunCommand('cancel job:1');
  assert.throws(() => resolveRunCommand(command, { ...scope, canCancel: false }), /CancelRun permission/);
  assert.throws(() => resolveRunCommand(command, { ...scope, endpoint: '/api/runs' }), /Pipeline workspace/);
  assert.throws(() => resolveRunCommand(command, { ...scope, runs: [] }), /No matching run/);
  assert.throws(() => resolveRunCommand(command, { ...scope, runs: [run('job:1', 'Auth migration', 'cancelled')] }), /already finished/);
});
test('tenant facades cannot switch workspace or expose unsupported detail navigation', () => {
  const embedded = { ...scope, endpoint: '/api/assessment/pipeline-runs', showWorkspace: false, detailBase: null };
  assert.throws(() => resolveRunCommand(parseRunCommand('workspace work'), embedded), /restricted to its workspace/);
  assert.throws(() => resolveRunCommand(parseRunCommand('open job:1'), embedded), /no run detail page/);
  assert.throws(() => resolveRunCommand(parseRunCommand('cancel job:1'), embedded), /Pipeline workspace/);
  assert.deepEqual(resolveRunCommand(parseRunCommand('show failed runs'), embedded), { kind: 'filter', filters: { status: 'failed' } });
});
test('help advertises only actions supported in that ledger and role', () => {
  assert.ok(runCommandExamples(scope).some(example => example.startsWith('cancel')));
  const examples = runCommandExamples({ ...scope, endpoint: '/api/assessment/pipeline-runs', detailBase: null, showWorkspace: false });
  assert.ok(!examples.some(example => /^(?:cancel|open|workspace)/.test(example)));
});

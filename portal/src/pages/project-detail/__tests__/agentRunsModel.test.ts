// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/agentRunsModel.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DISPATCHED_AGENT, NO_WORK_ITEM, runTableRows } from '../agentRunsModel.ts';
import type { BotRun } from '../../bots/BotsPage';

const NOW = Date.parse('2026-10-07T16:00:00Z');
const BOTS = [{ id: 'b1', name: 'llm-evals-nightly' }];
function run(id: string, daysAgo: number, extra: Partial<BotRun> = {}): BotRun {
  return { id, botId: 'b1', trigger: 'cron', runId: null, jobId: `job-${id}`, workItemId: null, status: 'done',
    costUsd: 1, startedAt: new Date(NOW - daysAgo * 86_400_000).toISOString(), finishedAt: null,
    outcome: { reason: 'scheduled maintenance' }, ...extra } as BotRun;
}

test('a bot run with no work item names its bot and its outcome', () => {
  const { rows } = runTableRows([run('a', 1)], BOTS, 30, new Map(), NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agent, 'llm-evals-nightly');
  assert.equal(rows[0]!.workItemLabel, NO_WORK_ITEM);
  assert.equal(rows[0]!.outcome, 'Scheduled maintenance');
});

test('runs outside the window drop, and the spend is the listed rows', () => {
  const t = runTableRows([run('a', 40), run('b', 1), run('c', 5, { costUsd: null })], BOTS, 30, new Map(), NOW);
  assert.deepEqual(t.rows.map((r) => r.run.id), ['b', 'c']);
  assert.equal(t.spendUsd, 1);
  assert.equal(runTableRows([run('a', 40)], BOTS, 90, new Map(), NOW).spendUsd, 1);
});

test('rows group by work item title, runs with none last, newest first within a group', () => {
  const titles = new Map([['w1', 'Add eval gate'], ['w2', 'Canary dashboard']]);
  const t = runTableRows([
    run('cron', 0),
    run('w2-old', 3, { botId: null, workItemId: 'w2', outcome: { summary: 'opened a PR' } }),
    run('w1', 2, { botId: null, workItemId: 'w1', outcome: {} }),
    run('w2-new', 1, { botId: null, workItemId: 'w2' }),
  ], BOTS, 30, titles, NOW);
  assert.deepEqual(t.rows.map((r) => r.run.id), ['w1', 'w2-new', 'w2-old', 'cron']);
  assert.equal(t.rows[0]!.agent, DISPATCHED_AGENT);
  assert.equal(t.rows[0]!.outcome, null);
  assert.equal(t.rows[2]!.outcome, 'Opened a PR');
});

test('an unreadable work item title falls back to its id', () => {
  const t = runTableRows([run('x', 0, { workItemId: 'wi-9' })], BOTS, 30, new Map(), NOW);
  assert.equal(t.rows[0]!.workItemLabel, 'wi-9');
});

test('Aurora +00 stamps parse', () => {
  const t = runTableRows([run('a', 0, { startedAt: '2026-10-07 10:00:00+00' })], BOTS, 30, new Map(), NOW);
  assert.equal(t.rows.length, 1);
});

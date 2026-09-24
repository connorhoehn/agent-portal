// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemActivity } from '../itemActivity.ts';
import type { BotRun } from '../../bots/BotsPage';
import type { ThreadComment } from '../useWorkItemThread.ts';

const item = {
  id: 'wi-1', createdAt: '2026-09-01T00:00:00Z', completedAt: null,
  estimatedAt: '2026-09-02T00:00:00Z', estimatedByName: 'Eli Garcia', estimateModel: 'm-haiku',
  estimatedCostUsd: 0.3, estimateReviewedAt: null, estimateReviewedByName: null,
};

function comment(p: Partial<ThreadComment> & { id: string }): ThreadComment {
  return { workItemId: 'wi-1', authorId: null, authorName: null, authorTitle: null, body: '', isSystem: false, createdAt: '2026-09-03T00:00:00Z', ...p };
}

test('only recorded facts become events — no completion line on open work', () => {
  const ev = itemActivity(item, [], [], (id) => (id === 'm-haiku' ? 'Haiku' : id));
  assert.deepEqual(ev.map((e) => e.text), ['Created', 'Estimate recorded on Haiku']);
  assert.equal(ev[1]!.actor, 'Eli Garcia');
  assert.equal(ev[1]!.detail, 'up to $0.30');
});

test('audit rows read as status/system, human comments are quoted', () => {
  const ev = itemActivity({ ...item, estimatedAt: null }, [
    comment({ id: 'c1', isSystem: true, body: 'Status changed from open to in progress', authorName: 'Layla Hassan' }),
    comment({ id: 'c2', body: 'Keep the bridge up until parity is verified.', authorName: 'Eli Garcia' }),
  ], []);
  const byId = Object.fromEntries(ev.map((e) => [e.id, e]));
  assert.equal(byId['c1']!.kind, 'status');
  assert.equal(byId['c2']!.text, 'Commented: “Keep the bridge up until parity is verified.”');
});

test('a run adds a start line, and an end line with cost and PR once it finished; other items’ runs are ignored', () => {
  const runs = [
    { id: 'r1', workItemId: 'wi-1', status: 'done', startedAt: '2026-09-04T00:00:00Z', finishedAt: '2026-09-04T00:05:00Z', costUsd: 0.18, outcome: { prUrl: 'https://github.com/o/r/pull/7' } },
    { id: 'r2', workItemId: 'wi-1', status: 'running', startedAt: '2026-09-05T00:00:00Z', finishedAt: null, costUsd: null, outcome: {} },
    { id: 'r3', workItemId: 'wi-other', status: 'done', startedAt: '2026-09-05T00:00:00Z', finishedAt: '2026-09-05T00:01:00Z', costUsd: 1, outcome: {} },
  ] as unknown as BotRun[];
  const ev = itemActivity({ ...item, estimatedAt: null }, [], runs).filter((e) => e.kind === 'run');
  assert.deepEqual(ev.map((e) => e.id), ['r1:start', 'r1:end', 'r2:start']);
  assert.equal(ev[1]!.detail, '$0.18');
  assert.equal(ev[1]!.href, 'https://github.com/o/r/pull/7');
});

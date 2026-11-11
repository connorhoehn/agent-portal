// Run with:  cd portal && node --test 'src/pages/computers/__tests__/computersModel.test.ts'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computerRows, computersRedirect, filterComputers, localRow, labRow } from '../computersModel.ts';
import { computersCommandAdapter } from '../computersCommands.ts';
import { runsListHref } from '../../iq/runsModel.ts';

const node = (over: Record<string, unknown> = {}) => ({
  id: 'n-1', label: 'Laptop', acceptJobs: true, presence: { status: 'connected' as const, lastSeenAt: '2026-11-01T10:00:00Z' }, ...over,
});

test('a paired machine reads Ready, Working, Paused, Away or Offline', () => {
  assert.equal(localRow(node(), []).state, 'Ready');
  assert.equal(localRow(node(), [{ nodeId: 'n-1', status: 'running', title: 'Fix lint' }]).state, 'Working');
  assert.equal(localRow(node(), [{ nodeId: 'n-1', status: 'running', title: 'Fix lint' }]).running, 'Fix lint');
  assert.equal(localRow(node({ acceptJobs: false }), []).state, 'Paused');
  assert.equal(localRow(node({ presence: { status: 'stale', lastSeenAt: null } }), []).state, 'Away');
  assert.equal(localRow(node({ presence: { status: 'offline', lastSeenAt: null } }), []).state, 'Offline');
});

test('a lab machine reads from its status and carries its session for Stop', () => {
  const r = labRow({ id: 'c-1', label: 'alpha-1', sessionId: 's'.repeat(40), status: 'running', currentTask: 'Writing tests' });
  assert.deepEqual([r.kind, r.state, r.running, r.stoppable], ['lab', 'Working', 'Writing tests', true]);
  assert.equal(labRow({ id: 'c-2', label: 'alpha-2', sessionId: 's'.repeat(40), status: 'stopped' }).stoppable, false);
});

test('both kinds share one list; the lab fleet\'s own copy of a paired machine is not counted twice', () => {
  const rows = computerRows(
    [node()], [],
    [{ id: 'local:n-1', label: 'Laptop', sessionId: 'x'.repeat(40), kind: 'local' }, { id: 'c-1', label: 'alpha-1', sessionId: 'y'.repeat(40) }],
  );
  assert.deepEqual(rows.map((r) => [r.kind, r.key]), [['local', 'local:n-1'], ['lab', 'c-1']]);
});

test('the filter matches words in the row and the kind', () => {
  const rows = computerRows([node()], [], [{ id: 'c-1', label: 'alpha-1', sessionId: 'y'.repeat(40) }]);
  assert.equal(filterComputers(rows, { query: '', kind: 'lab' }).length, 1);
  assert.equal(filterComputers(rows, { query: 'your machine', kind: '' }).length, 1);
  assert.equal(filterComputers(rows, { query: 'nothing here', kind: '' }).length, 0);
});

test('old URLs land on the one page with their selection', () => {
  assert.equal(computersRedirect(''), '/iq/computers');
  assert.equal(computersRedirect('?machine=n-1'), '/iq/computers?computer=local%3An-1');
  assert.equal(computersRedirect('?box=c-9'), '/iq/computers?computer=c-9');
  assert.equal(computersRedirect('?machine=n-1&run=job-1'), '/iq/computers?computer=local%3An-1&run=job-1');
  assert.equal(computersRedirect('?view=runs'), runsListHref({ executor: 'local' }));
});

test('commands search, filter by kind, refresh and open by exact name; they never start or stop', async () => {
  const calls: string[] = [];
  const adapter = computersCommandAdapter([{ key: 'local:n-1', name: 'Laptop' }, { key: 'c-1', name: 'alpha-1' }], {
    setQuery: (v) => calls.push(`query:${v}`), setKind: (v) => calls.push(`kind:${v}`),
    refresh: () => calls.push('refresh'), open: (k) => calls.push(`open:${k}`),
  });
  await adapter.execute('show lab machines');
  await adapter.execute('open laptop');
  assert.deepEqual(calls, ['kind:lab', 'open:local:n-1']);
  for (const text of ['stop alpha-1', 'start a lab machine', 'unpair Laptop', 'pair a machine']) await assert.rejects(async () => adapter.execute(text));
  assert.equal(calls.length, 2);
});

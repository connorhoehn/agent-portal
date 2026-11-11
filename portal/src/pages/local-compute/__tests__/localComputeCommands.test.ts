// Run with:  cd portal && node --test 'src/pages/local-compute/__tests__/localComputeCommands.test.ts'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRunsCommandAdapter, machinesCommandAdapter } from '../localComputeCommands.ts';

test('machines: search, presence, refresh and exact select', async () => {
  const calls: string[] = [];
  const rows = [{ id: 'node-a', label: 'Laptop' }, { id: 'node-b', label: 'Desktop' }];
  const adapter = machinesCommandAdapter(rows, {
    setQuery: (v) => calls.push(`query:${v}`), setPresence: (v) => calls.push(`presence:${v}`),
    refresh: () => calls.push('refresh'), selectMachine: (id) => calls.push(`select:${id}`),
  });
  for (const example of adapter.examples) if (!example.startsWith('open ')) await adapter.execute(example);
  await adapter.execute('open desktop');
  await adapter.execute('open node-a');
  assert.deepEqual(calls, ['query:name', 'presence:connected', 'presence:stale', 'presence:offline', 'query:', 'presence:', 'refresh', 'select:node-b', 'select:node-a']);
  for (const text of ['unpair Laptop', 'pause all machines', 'pair a machine', 'send work to Laptop', 'open Lap', 'open NODE-A']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 9);
});

test('runs: status phrases map to job statuses; open shows one log', async () => {
  const calls: string[] = [];
  const adapter = localRunsCommandAdapter([{ id: 'job-1', title: 'Fix lint' }], {
    setQuery: (v) => calls.push(`query:${v}`), setStatus: (v) => calls.push(`status:${v}`),
    refresh: () => calls.push('refresh'), openRun: (id) => calls.push(`open:${id}`),
  });
  await adapter.execute('show awaiting review runs');
  await adapter.execute('search runs for lint');
  await adapter.execute('open fix lint');
  assert.deepEqual(calls, ['status:awaiting_review', 'query:lint', 'open:job-1']);
  for (const text of ['retry job-1', 'cancel all runs', 'queue Fix lint']) await assert.rejects(async () => adapter.execute(text));
  await assert.rejects(async () => adapter.execute('open job-2'), /No matching/);
  assert.equal(calls.length, 3);
});

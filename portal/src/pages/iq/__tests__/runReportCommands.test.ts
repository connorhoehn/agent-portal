import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter } from '../../../components/collections/collectionCommands.ts';
import { RUN_REPORT_GRAMMAR, runReportCommandFilter } from '../runReportCommands.ts';

test('report commands preserve independent filters and reset all URL controls together', async () => {
  let params = new URLSearchParams('initiative=p-auth&executor=local&outcome=done&debrief=filed&workItem=wi-1&runbook=rb-a&q=old&tab=history');
  let refreshes = 0;
  const adapter = collectionCommandAdapter(RUN_REPORT_GRAMMAR, {
    setQuery: value => { if (value) params.set('q', value); else params.delete('q'); },
    setFilter: value => { params = runReportCommandFilter(params, value); },
    refresh: () => { refreshes++; }, scopeNote: 'Run reports only.',
  });
  await adapter.execute('show failed runs');
  assert.equal(params.get('outcome'), 'failed');
  assert.equal(params.get('executor'), 'local');
  assert.equal(params.get('initiative'), 'p-auth');
  assert.equal(params.get('debrief'), 'filed');
  assert.equal(params.get('q'), 'old');
  await adapter.execute('show bot runs');
  assert.equal(params.get('executor'), 'governed,mock');
  assert.equal(params.get('outcome'), 'failed');
  await adapter.execute('search runs for "Tenant Cutover"');
  assert.equal(params.get('q'), 'Tenant Cutover');
  await adapter.execute('refresh'); assert.equal(refreshes, 1);
  await adapter.execute('reset filters');
  assert.equal(params.toString(), 'tab=history');
  for (const phrase of adapter.examples) await adapter.execute(phrase);
});

test('unsupported or mutating phrases cannot partially change run filters', async () => {
  const params = new URLSearchParams('executor=local&initiative=p-auth');
  let writes = 0;
  const adapter = collectionCommandAdapter(RUN_REPORT_GRAMMAR, {
    setQuery: () => { writes++; }, setFilter: () => { writes++; }, refresh: () => { writes++; }, scopeNote: 'Run reports only.',
  });
  for (const phrase of ['cancel all runs', 'retry failed runs', 'start run Auth', 'show failed runs and cancel them']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), /not recognized/);
  }
  assert.equal(writes, 0);
  assert.throws(() => runReportCommandFilter(params, 'unknown'), /Unknown run filter/);
  assert.equal(params.toString(), 'executor=local&initiative=p-auth');
});

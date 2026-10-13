import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrawlSession, CrawlTarget } from '../../../components/ingest/types.ts';
import {
  crawlRunsAdapter, crawlTargetsAdapter, filterRuns, kbSyncAdapter, matchesDataSource, matchesJob,
  matchesSchedule, matchesStorageKey, matchesTarget, schedulesAdapter, storageAdapter, type RunStatusFilter,
} from '../ingestCommands.ts';

const target = (id: string, label: string): CrawlTarget => ({ id, label, startUrl: `https://${id}.example`, mode: 'fetch', cronExpr: null, lastStatus: null } as unknown as CrawlTarget);
const run = (id: string, status: CrawlSession['status'], targetId: string | null, startUrl = `https://${id}.example`): CrawlSession =>
  ({ id, status, targetId, startUrl, mode: 'fetch', startedAt: '2026-10-01T00:00:00Z' } as unknown as CrawlSession);

const DESTRUCTIVE = ['delete everything', 'run all targets', 'cancel run-1', 'sync now', 'remove all schedules', 'open all'];

for (const [name, make] of [['targets', crawlTargetsAdapter], ['storage', storageAdapter], ['kb sync', kbSyncAdapter], ['schedules', schedulesAdapter]] as const) {
  test(`${name}: advertised examples drive search/refresh; mutations and open change nothing`, async () => {
    let query = 'q'; let refreshes = 0;
    const adapter = make({ setQuery: v => { query = v; }, refresh: () => { refreshes++; } });
    for (const phrase of DESTRUCTIVE) await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
    assert.equal(query, 'q'); assert.equal(refreshes, 0);
    assert.ok(!adapter.examples.some(e => e.startsWith('open ')));
    for (const example of adapter.examples) await adapter.execute(example);
    assert.equal(query, ''); assert.equal(refreshes, 1);
    await adapter.execute('search for "Docs"'); assert.equal(query, 'Docs');
  });
}

test('crawl runs: status filter, search, reset and exact open over the current rows only', async () => {
  const targetsById = new Map([['t1', target('t1', 'Docs site')], ['t2', target('t2', 'Blog')]]);
  const all = [run('run-1', 'completed', 't1'), run('run-2', 'failed', 't2'), run('run-3', 'failed', null, 'https://adhoc.example')];
  let status: RunStatusFilter = 'all'; let query = ''; let refreshes = 0; const opened: string[] = [];
  const adapter = crawlRunsAdapter({
    setQuery: v => { query = v; }, refresh: () => { refreshes++; }, setStatus: v => { status = v; },
    rows: () => filterRuns(all, targetsById, status, query), targetsById, openRun: id => { opened.push(id); },
  });
  await adapter.execute('show failed runs');
  assert.equal(status, 'failed');
  assert.deepEqual(filterRuns(all, targetsById, status, query).map(r => r.id), ['run-2', 'run-3']);
  await adapter.execute('open Blog'); assert.deepEqual(opened, ['run-2']);
  await adapter.execute('open https://adhoc.example'); assert.deepEqual(opened, ['run-2', 'run-3']);
  // Hidden by the status filter, so never reachable.
  await assert.rejects(() => Promise.resolve(adapter.execute('open run-1')), /No matching/);
  await assert.rejects(() => Promise.resolve(adapter.execute('open Blo')), /No matching/);
  await assert.rejects(() => Promise.resolve(adapter.execute('cancel run-2')));
  assert.deepEqual(opened, ['run-2', 'run-3']);
  await adapter.execute('search runs for Docs'); assert.equal(query, 'Docs');
  await adapter.execute('reset filters'); assert.equal(query, ''); assert.equal(status, 'all');
  await adapter.execute('open run-1'); assert.deepEqual(opened, ['run-2', 'run-3', 'run-1']);
  await adapter.execute('refresh'); assert.equal(refreshes, 1);
});

test('matchers search the visible fields case-insensitively; empty query keeps everything', () => {
  assert.ok(matchesTarget(target('t1', 'Docs site'), 'docs'));
  assert.ok(!matchesTarget(target('t1', 'Docs site'), 'blog'));
  assert.ok(matchesStorageKey('', '(none)'));
  assert.ok(matchesStorageKey('.md', 'MD'));
  assert.ok(matchesDataSource({ id: 'ds-1', name: 'Corpus', type: 'S3', sourceUri: 's3://b', status: 'AVAILABLE' }, 'corp'));
  assert.ok(matchesJob({ jobId: 'job-9', dataSourceId: 'ds-1', status: 'FAILED' }, 'failed'));
  assert.ok(!matchesSchedule({ label: 'Nightly', cronExpr: '0 0 * * *', dataSourceName: 'Corpus', dataSourceId: 'ds-1', lastStatus: null }, 'hourly'));
  assert.ok(matchesSchedule({ label: 'Nightly', cronExpr: '0 0 * * *', dataSourceName: 'Corpus', dataSourceId: 'ds-1', lastStatus: null }, ''));
});

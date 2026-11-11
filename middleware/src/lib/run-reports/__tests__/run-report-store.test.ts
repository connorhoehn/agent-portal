// The RunReportStore contract: ONE suite, run against RowsRunReportStore always
// and against DynamoRunReportStore when RUNBOOK_DYNAMODB_ENDPOINT is set (the
// runbook store's own switch and table shape). The Dynamo leg gets a fresh
// table per test and drops it afterwards.
import { randomBytes } from 'node:crypto';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createRunbookDynamoClient, dropRunbookTable, ensureRunbookTable, runbookStoreConfig } from '../../runbooks/store-dynamo.js';
import { DynamoRunbookStore } from '../../runbooks/store-dynamo.js';
import { RowsRunReportStore, privateRunReportSources } from '../store-rows.js';
import { DynamoRunReportStore } from '../store-dynamo.js';
import type { RunReportStore } from '../store.js';
import type { RunReport } from '../types.js';

jest.setTimeout(30_000);

const report = (runRef: string, over: Partial<RunReport> = {}): RunReport => ({
  runRef, workItemId: 'wi-obs-e1-s4', initiativeId: 'p-observability', executor: 'mock', model: null,
  startedAt: null, endedAt: '2026-11-10T10:00:00.000Z', outcome: 'done', failureCode: null, summary: 'did it',
  changes: { files: [], changeRequestId: null }, verification: [{ command: 'npm test', passed: true }], obstacles: [],
  runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'simulated' }, kept: [],
  selfReport: 'ok', briefId: null, createdAt: '2026-11-10T10:00:00.000Z', ...over,
});

interface Backend { name: string; open(): Promise<{ store: RunReportStore; close(): Promise<void> }> }
const backends: Backend[] = [{
  name: 'RowsRunReportStore',
  open: async () => ({ store: new RowsRunReportStore(privateRunReportSources()), close: async () => undefined }),
}];
const endpoint = process.env['RUNBOOK_DYNAMODB_ENDPOINT']?.trim();
if (endpoint) {
  backends.push({
    name: 'DynamoRunReportStore',
    open: async () => {
      const cfg = { ...runbookStoreConfig({ ...process.env, RUNBOOK_STORE: 'dynamo' }), table: `rptest-${randomBytes(5).toString('hex')}` };
      const client: DynamoDBClient = createRunbookDynamoClient(cfg);
      await ensureRunbookTable(client, cfg.table);
      return { store: new DynamoRunReportStore(client, cfg.table), close: async () => { await dropRunbookTable(client, cfg.table); client.destroy(); } };
    },
  });
}

describe.each(backends)('$name (RunReportStore contract)', ({ open }) => {
  let store: RunReportStore;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ store, close } = await open()); });
  afterEach(async () => { await close(); });

  it('stores a report once per runRef; a second put changes nothing and says so', async () => {
    const first = await store.putReport(report('job-1'));
    expect(first.created).toBe(true);
    const again = await store.putReport(report('job-1', { summary: 'a different story', outcome: 'failed' }));
    expect(again.created).toBe(false);
    expect(again.report.summary).toBe('did it');
    expect((await store.getReport('job-1'))!.outcome).toBe('done');
  });

  it('reads return copies', async () => {
    await store.putReport(report('job-2'));
    const got = (await store.getReport('job-2'))!;
    got.summary = 'mutated';
    got.verification.push({ command: 'x', passed: false });
    expect((await store.getReport('job-2'))!.summary).toBe('did it');
    expect((await store.getReport('job-2'))!.verification).toHaveLength(1);
  });

  it('lists by work item and by initiative, newest end first', async () => {
    await store.putReport(report('a', { endedAt: '2026-11-10T09:00:00.000Z' }));
    await store.putReport(report('b', { endedAt: '2026-11-10T11:00:00.000Z' }));
    await store.putReport(report('c', { workItemId: 'wi-other', initiativeId: 'p-other' }));
    expect((await store.listReports({ workItemId: 'wi-obs-e1-s4' })).items.map((r) => r.runRef)).toEqual(['b', 'a']);
    expect((await store.listReports({ initiativeId: 'p-other' })).items.map((r) => r.runRef)).toEqual(['c']);
    expect((await store.listReports()).items).toHaveLength(3);
    const page = await store.listReports({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.next).not.toBeNull();
  });

  it('lists by runbook: a report whose brief offered it or whose run used it', async () => {
    await store.putReport(report('a', { runbooksOffered: [{ id: 'rb-one', version: 1 }] }));
    await store.putReport(report('b', { runbooksUsed: [{ id: 'rb-one', version: 1, source: 'observed' }] }));
    await store.putReport(report('c', { runbooksOffered: [{ id: 'rb-two', version: 1 }] }));
    expect((await store.listReports({ runbookId: 'rb-one' })).items.map((r) => r.runRef).sort()).toEqual(['a', 'b']);
    expect((await store.listReports({ runbookId: 'rb-none' })).items).toHaveLength(0);
  });

  it('lists a filtered page across executors: executor, outcome, debrief, initiative, newest first', async () => {
    const debrief = (state: 'filed' | 'skipped') => ({ state, reason: null, reasonText: null, promptVersion: null, decidedAt: '2026-11-10T10:00:00.000Z',
      expiresAt: null, settledAt: null, nonce: null, holdId: null, ceilingUsd: null, answer: null, proposalId: null, proposalKind: null,
      convertedFrom: null, problems: [], lint: [], cost: { billedUsd: null, reportedUsd: null }, simulated: true });
    await store.putReport(report('q1', { executor: 'fleet', endedAt: '2026-11-10T08:00:00.000Z' }));
    await store.putReport(report('l1', { executor: 'local', outcome: 'failed', endedAt: '2026-11-10T09:00:00.000Z' }));
    await store.putReport(report('m1', { executor: 'mock', debrief: debrief('filed'), endedAt: '2026-11-10T10:00:00.000Z' }));
    await store.putReport(report('m2', { executor: 'mock', debrief: debrief('skipped'), initiativeId: 'p-other', endedAt: '2026-11-10T11:00:00.000Z' }));
    const refs = async (q: Parameters<RunReportStore['listReports']>[0]) => (await store.listReports(q)).items.map((r) => r.runRef);
    expect(await refs({ executors: ['fleet', 'mock'] })).toEqual(['m2', 'm1', 'q1']);
    expect(await refs({ executors: ['local'] })).toEqual(['l1']);
    expect(await refs({ outcome: 'failed' })).toEqual(['l1']);
    expect(await refs({ debrief: 'filed' })).toEqual(['m1']);
    expect(await refs({ debrief: 'skipped' })).toEqual(['m2']);
    expect(await refs({ debrief: 'none' })).toEqual(['l1', 'q1']);
    expect(await refs({ initiativeId: 'p-other', executors: ['mock'] })).toEqual(['m2']);
    const page = await store.listReports({ executors: ['fleet', 'mock'], limit: 2 });
    expect(page.items.map((r) => r.runRef)).toEqual(['m2', 'm1']);
    expect((await store.listReports({ executors: ['fleet', 'mock'], limit: 2, cursor: page.next! })).items.map((r) => r.runRef)).toEqual(['q1']);
  });

  it('refuses a report without a runRef', async () => {
    await expect(store.putReport(report(''))).rejects.toThrow(/runRef/);
  });
});

if (endpoint) {
  it('a report and the runbook rows share one table without meeting', async () => {
    const cfg = { ...runbookStoreConfig({ ...process.env, RUNBOOK_STORE: 'dynamo' }), table: `rptest-${randomBytes(5).toString('hex')}` };
    const client = createRunbookDynamoClient(cfg);
    await ensureRunbookTable(client, cfg.table);
    try {
      const reports = new DynamoRunReportStore(client, cfg.table);
      const runbooks = new DynamoRunbookStore(client, cfg.table);
      await reports.putReport(report('job-x'));
      expect((await runbooks.listRunbooks()).items).toEqual([]);
      expect((await runbooks.listBriefs()).items).toEqual([]);
      expect((await reports.listReports()).items.map((r) => r.runRef)).toEqual(['job-x']);
    } finally {
      await dropRunbookTable(client, cfg.table);
      client.destroy();
    }
  });
}
